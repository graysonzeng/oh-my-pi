/**
 * BashAttemptLedgerV1 — design A §4.3.
 * Single canonical ledger for bash failure evidence.
 * Advisory / bounded-injection modes share this ledger; never auto-retry or auto-skip.
 */

import { sha256Hex, stableSerialize } from "./stable-serialize";

export const BASH_ATTEMPT_LEDGER_KIND = "bash_attempt_ledger" as const;
export const BASH_ATTEMPT_LEDGER_VERSION = 1 as const;
export const BASH_FAILURE_FINGERPRINT_VERSION = "bash-failure:v1" as const;

export type BashAttemptTerminal =
	| { kind: "exit"; exitCode: number }
	| { kind: "timeout" }
	| { kind: "cancelled" }
	| { kind: "error"; messageDigest: string };

export interface BashAttemptRecordV1 {
	attemptId: string;
	startedAt: string;
	endedAt: string;
	terminal: BashAttemptTerminal;
	failureFingerprint: string | null;
	stdoutDigest: string;
	stderrDigest: string;
	cwdIdentity: string;
	/** User/tool changed which authoritative inputs (never secret values). */
	changedInputReceipt: string | null;
}

export interface BashAttemptLedgerV1 {
	schemaVersion: typeof BASH_ATTEMPT_LEDGER_VERSION;
	kind: typeof BASH_ATTEMPT_LEDGER_KIND;
	sessionId: string;
	commandFingerprint: string;
	stateFingerprint: string;
	attempts: BashAttemptRecordV1[];
	mode: "advisory" | "bounded_injection";
}

export interface BashLedgerLookupResult {
	ledger: BashAttemptLedgerV1 | null;
	/** Same command+state+failure seen before (and not cancelled-only). */
	repeatedFailure: boolean;
	priorAttempts: number;
	/** Fail-open when ledger unavailable. */
	unknown: boolean;
	advisoryText?: string;
}

/** Normalize shell whitespace outside quoted/escaped spans without proving quote equivalence. */
function normalizeBashCommand(command: string): string {
	let normalized = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	let whitespacePending = false;
	for (const char of command.trim()) {
		if (escaped) {
			normalized += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			if (whitespacePending && normalized.length > 0) normalized += " ";
			whitespacePending = false;
			normalized += char;
			escaped = true;
			continue;
		}
		if (quote !== undefined) {
			normalized += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			if (whitespacePending && normalized.length > 0) normalized += " ";
			whitespacePending = false;
			normalized += char;
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			whitespacePending = true;
			continue;
		}
		if (whitespacePending && normalized.length > 0) normalized += " ";
		whitespacePending = false;
		normalized += char;
	}
	return normalized.trim();
}

/** Normalize command for fingerprinting. Conservative: unproven quote equivalence stays distinct. */
export function buildBashCommandFingerprint(input: { command: string; cwd: string }): string {
	return sha256Hex(stableSerialize({ command: normalizeBashCommand(input.command), cwd: input.cwd }));
}

/**
 * State fingerprint keeps stable receipts for the repository and explicit
 * execution environment. Raw environment values never enter the ledger.
 */
export function buildBashStateFingerprint(input: {
	cwd?: string;
	codeRevision?: string;
	configHash?: string;
	relatedFileHashes?: Record<string, string>;
	envNames?: string[];
	envReceipt?: string;
	executionReceipt?: string;
	worktreeReceipt?: string;
	dependencyReceipt?: string;
}): string {
	const envNames = [...(input.envNames ?? [])].sort();
	const related = Object.fromEntries(
		Object.entries(input.relatedFileHashes ?? {}).sort(([a], [b]) => a.localeCompare(b)),
	);
	return sha256Hex(
		stableSerialize({
			// The command's cwd is part of state as well as command identity: a
			// relative path can resolve to different authoritative inputs per cwd.
			cwd: input.cwd ?? "unknown",
			codeRevision: input.codeRevision ?? "unknown",
			configHash: input.configHash ?? "unknown",
			relatedFileHashes: related,
			envNames,
			envReceipt: input.envReceipt ?? null,
			executionReceipt: input.executionReceipt ?? null,
			worktreeReceipt: input.worktreeReceipt ?? null,
			dependencyReceipt: input.dependencyReceipt ?? null,
		}),
	);
}

/** Strip timestamps / ephemeral ids before digesting failure excerpts. */
export function normalizeBashFailureExcerpt(text: string): string {
	return (
		text
			// Bash tool footers embed variable wall-clock text; strip so identical
			// failures (e.g. two `false` runs) share one failure fingerprint.
			.replace(/^\s*Wall time:\s*\d+(?:\.\d+)?\s*(?:seconds?|ms|milliseconds?)\s*$/gim, "")
			.replace(/\bWall time:\s*\d+(?:\.\d+)?\s*(?:seconds?|ms|milliseconds?)\b/gi, "")
			.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<ts>")
			.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
			.replace(/\b\d{10,}\b/g, "<num>")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 2000)
	);
}

export function buildBashFailureFingerprint(input: {
	terminal: BashAttemptTerminal;
	stderrExcerpt?: string;
	stdoutExcerpt?: string;
}): string | null {
	// Successful exits and cancellations are evidence, not failures. Keep
	// cancellation records in the ledger, but never let them trigger advice.
	if (input.terminal.kind === "cancelled") return null;
	if (input.terminal.kind === "exit" && input.terminal.exitCode === 0) return null;
	const excerpt = normalizeBashFailureExcerpt(
		[input.stderrExcerpt ?? "", input.stdoutExcerpt ?? ""].filter(Boolean).join("\n"),
	);
	return sha256Hex(
		stableSerialize({
			version: BASH_FAILURE_FINGERPRINT_VERSION,
			terminal: input.terminal,
			excerpt,
		}),
	);
}

export function digestBashStream(text: string): string {
	return sha256Hex(text);
}

export function createBashAttemptLedger(input: {
	sessionId: string;
	commandFingerprint: string;
	stateFingerprint: string;
	mode: "advisory" | "bounded_injection";
}): BashAttemptLedgerV1 {
	return {
		schemaVersion: BASH_ATTEMPT_LEDGER_VERSION,
		kind: BASH_ATTEMPT_LEDGER_KIND,
		sessionId: input.sessionId,
		commandFingerprint: input.commandFingerprint,
		stateFingerprint: input.stateFingerprint,
		attempts: [],
		mode: input.mode,
	};
}

export function appendBashAttempt(ledger: BashAttemptLedgerV1, attempt: BashAttemptRecordV1): BashAttemptLedgerV1 {
	return {
		...ledger,
		attempts: [...ledger.attempts, attempt],
	};
}

export function lookupRepeatedBashFailure(
	ledgers: readonly BashAttemptLedgerV1[],
	input: {
		commandFingerprint: string;
		stateFingerprint: string;
		failureFingerprint: string | null;
	},
): BashLedgerLookupResult {
	if (!input.failureFingerprint) {
		return { ledger: null, repeatedFailure: false, priorAttempts: 0, unknown: false };
	}
	const matches = ledgers.filter(
		l => l.commandFingerprint === input.commandFingerprint && l.stateFingerprint === input.stateFingerprint,
	);
	if (matches.length === 0) {
		return { ledger: null, repeatedFailure: false, priorAttempts: 0, unknown: false };
	}
	const ledger = matches[matches.length - 1]!;
	const priorFailures = ledger.attempts.filter(
		a => a.failureFingerprint === input.failureFingerprint && a.terminal.kind !== "cancelled",
	);
	const repeatedFailure = priorFailures.length > 0;
	const advisoryText = repeatedFailure ? formatBashAdvisory(ledger, input.failureFingerprint) : undefined;
	return {
		ledger,
		repeatedFailure,
		priorAttempts: priorFailures.length,
		unknown: false,
		advisoryText,
	};
}

function formatBashAdvisory(ledger: BashAttemptLedgerV1, failureFingerprint: string): string {
	const prior = ledger.attempts.filter(a => a.failureFingerprint === failureFingerprint);
	const lines = [
		"[bash-attempt-ledger] repeated identical failure (advisory; execution not blocked)",
		`commandFingerprint=${ledger.commandFingerprint.slice(0, 12)}…`,
		`stateFingerprint=${ledger.stateFingerprint.slice(0, 12)}…`,
		`failureFingerprint=${failureFingerprint.slice(0, 12)}…`,
		`priorAttempts=${prior.length}`,
		...prior
			.slice(-3)
			.map(
				(a, i) =>
					`  #${i + 1} ${a.terminal.kind}${a.terminal.kind === "exit" ? `=${a.terminal.exitCode}` : ""} at ${a.endedAt}`,
			),
	];
	return lines.join("\n");
}

/** In-memory session ledger store (one owner; fail open if unavailable). */
export class BashAttemptLedgerStore {
	#byKey = new Map<string, BashAttemptLedgerV1>();

	#key(commandFingerprint: string, stateFingerprint: string): string {
		return `${commandFingerprint}:${stateFingerprint}`;
	}

	get(commandFingerprint: string, stateFingerprint: string): BashAttemptLedgerV1 | undefined {
		return this.#byKey.get(this.#key(commandFingerprint, stateFingerprint));
	}

	upsert(ledger: BashAttemptLedgerV1): void {
		this.#byKey.set(this.#key(ledger.commandFingerprint, ledger.stateFingerprint), ledger);
	}

	list(): BashAttemptLedgerV1[] {
		return [...this.#byKey.values()];
	}

	clear(): void {
		this.#byKey.clear();
	}
}

const sessionLedgerStores = new WeakMap<object, BashAttemptLedgerStore>();
const sessionLedgerStoresById = new Map<string, BashAttemptLedgerStore>();

function sessionIdForLedger(session: object): string | undefined {
	if (!("getSessionId" in session) || typeof session.getSessionId !== "function") return undefined;
	try {
		const sessionId = session.getSessionId();
		return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
	} catch {
		return undefined;
	}
}

/** Return the one session-scoped ledger owner, failing open for invalid sessions. */
export function getBashAttemptLedgerStore(session: object | null | undefined): BashAttemptLedgerStore | undefined {
	if (!session || (typeof session !== "object" && typeof session !== "function")) return undefined;
	const sessionId = sessionIdForLedger(session);
	if (sessionId) {
		let store = sessionLedgerStoresById.get(sessionId);
		if (!store) {
			store = new BashAttemptLedgerStore();
			sessionLedgerStoresById.set(sessionId, store);
		}
		sessionLedgerStores.set(session, store);
		return store;
	}
	let store = sessionLedgerStores.get(session);
	if (!store) {
		store = new BashAttemptLedgerStore();
		sessionLedgerStores.set(session, store);
	}
	return store;
}

/** Clear the session-scoped ledger so a new session/rewind cannot reuse prior failures. */
export function clearBashAttemptLedgerStore(session: object | string | null | undefined): void {
	if (typeof session === "string") {
		const store = sessionLedgerStoresById.get(session);
		store?.clear();
		sessionLedgerStoresById.delete(session);
		return;
	}
	if (!session || (typeof session !== "object" && typeof session !== "function")) return;
	const sessionId = sessionIdForLedger(session);
	if (sessionId) {
		const store = sessionLedgerStoresById.get(sessionId);
		store?.clear();
		sessionLedgerStoresById.delete(sessionId);
	}
	const store = sessionLedgerStores.get(session);
	store?.clear();
	sessionLedgerStores.delete(session);
}
