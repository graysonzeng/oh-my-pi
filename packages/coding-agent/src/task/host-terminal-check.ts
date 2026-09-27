/**
 * Host-observed verification receipts.
 *
 * A seal is minted only for one literal verification invocation whose exit
 * status is that command's own exit, bracketed by a stable workspace identity.
 * Command text, eval snippets, and shell wrappers cannot mint one.
 */
import { extractFlatShellCommandSegments, tokenizeShellSegments } from "../tools/shell-tokenize";
import type { VerificationWorkspaceBinding } from "../workflow/types";
import { captureVerificationWorkspace } from "../workflow/verification-validity";
import { formatWorkspaceContentVersion } from "./workspace-code-version";

const SHELL_WRAPPERS: Record<string, true> = {
	echo: true,
	printf: true,
	eval: true,
	sh: true,
	bash: true,
	zsh: true,
	dash: true,
	ash: true,
	ksh: true,
	fish: true,
	env: true,
	sudo: true,
	command: true,
	time: true,
	nice: true,
	nohup: true,
	exec: true,
};

export interface HostTerminalSeal {
	id: string;
	command: string;
	cwd: string;
	codeVersion: string;
	evidenceLocation: string;
	executor: "host_bash";
	changedFiles?: readonly string[];
	/** Process-local id. Injected JSON without this registration is not a seal. */
	trustId: string;
	/** Milliseconds spent capturing before+after identity. Boundary-only; not per tool event. */
	captureMs?: number;
}

export interface HostSealAttempt {
	command: string;
	cwd: string;
	before: VerificationWorkspaceBinding;
	startedMs: number;
}

function commandHead(argv0: string): string {
	const base = argv0.split(/[/\\]/).pop() ?? argv0;
	return base.toLowerCase();
}

function invocationIsVerification(argv: readonly string[]): boolean {
	const head = commandHead(argv[0] ?? "");
	const second = (argv[1] ?? "").toLowerCase();
	const third = (argv[2] ?? "").toLowerCase();
	if (head === "bun") {
		if (second === "test" || second === "check") return true;
		return second === "run" && (third === "test" || third === "check");
	}
	if (head === "npm" || head === "pnpm" || head === "yarn") {
		if (second === "test" || second === "check" || second === "lint" || second === "typecheck") return true;
		return second === "run" && (third === "test" || third === "check" || third === "lint" || third === "typecheck");
	}
	if (head === "cargo" && second === "test") return true;
	if (head === "pytest" || head === "py.test") return true;
	if ((head === "python" || head === "python3") && second === "-m" && (third === "pytest" || third === "unittest")) {
		return true;
	}
	if (head === "go" && second === "test") return true;
	return false;
}

/**
 * Single literal verification argv. Rejects wrappers, quoted mentions, and
 * chains (`;`, `&&`, `||`, `|`) that can hide a failing check behind exit 0.
 * Unparseable shell (substitution, grouping) is not eligible.
 */
export function sealEligibleVerificationCommand(command: string): string | null {
	const trimmed = command.trim();
	if (!trimmed) return null;
	const flat = extractFlatShellCommandSegments(trimmed);
	if (flat.length !== 1 || flat[0]?.pipedStdin) return null;
	const segments = tokenizeShellSegments(trimmed);
	if (segments.length !== 1) return null;
	const argv = segments[0];
	if (!argv || argv.length === 0) return null;
	const head = commandHead(argv[0] ?? "");
	if (!head || SHELL_WRAPPERS[head]) return null;
	if (argv.some(arg => arg === "--help" || arg === "-h")) return null;
	if (!invocationIsVerification(argv)) return null;
	return argv.join(" ");
}

/** Capture identity before a seal-eligible command. Ineligible or unreadable trees return null. */
export async function beginHostTerminalSeal(command: string, cwd: string): Promise<HostSealAttempt | null> {
	const literal = sealEligibleVerificationCommand(command);
	if (!literal) return null;
	const startedMs = Date.now();
	try {
		const before = await captureVerificationWorkspace(cwd);
		if (!before?.contentSha256) return null;
		return { command: literal, cwd: before.cwd, before, startedMs };
	} catch {
		return null;
	}
}

const trustedHostSeals = new Map<string, HostTerminalSeal>();

/** Seal only when the after-capture matches the before-capture. Unknown identity does not seal. */
export async function finishHostTerminalSeal(
	attempt: HostSealAttempt,
	evidenceLocation: string | undefined,
): Promise<HostTerminalSeal | null> {
	const location = evidenceLocation?.trim() ?? "";
	if (!location) return null;
	try {
		const after = await captureVerificationWorkspace(attempt.cwd);
		if (!after?.contentSha256) return null;
		if (after.contentSha256 !== attempt.before.contentSha256 || after.cwd !== attempt.before.cwd) return null;
		const trustId = crypto.randomUUID();
		const seal: HostTerminalSeal = {
			id: attempt.command,
			command: attempt.command,
			cwd: after.cwd,
			codeVersion: formatWorkspaceContentVersion(after.contentSha256),
			evidenceLocation: location,
			executor: "host_bash",
			trustId,
			changedFiles: after.changedFiles,
			captureMs: Math.max(0, Date.now() - attempt.startedMs),
		};
		trustedHostSeals.set(trustId, seal);
		return seal;
	} catch {
		return null;
	}
}

function sealShape(raw: unknown): HostTerminalSeal | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	if (!("executor" in raw) || raw.executor !== "host_bash") return null;
	if (!("trustId" in raw) || typeof raw.trustId !== "string" || raw.trustId.trim().length === 0) return null;
	if (!("command" in raw) || typeof raw.command !== "string") return null;
	if (!("codeVersion" in raw) || typeof raw.codeVersion !== "string") return null;
	if (!("evidenceLocation" in raw) || typeof raw.evidenceLocation !== "string") return null;
	if (!("cwd" in raw) || typeof raw.cwd !== "string") return null;
	const command = raw.command.trim();
	const codeVersion = raw.codeVersion.trim();
	const evidenceLocation = raw.evidenceLocation.trim();
	const cwd = raw.cwd.trim();
	if (!command || !codeVersion.startsWith("content:") || !evidenceLocation || !cwd) return null;
	if (sealEligibleVerificationCommand(command) !== command) return null;
	const id = "id" in raw && typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : command;
	const captureMs =
		"captureMs" in raw && typeof raw.captureMs === "number" && Number.isFinite(raw.captureMs)
			? raw.captureMs
			: undefined;
	return {
		id,
		command,
		cwd,
		codeVersion,
		evidenceLocation,
		executor: "host_bash",
		trustId: raw.trustId.trim(),
		...(captureMs !== undefined ? { captureMs } : {}),
	};
}

/** Returns the stored seal only. Model JSON and copied details are not enough. */
export function readHostTerminalSeal(details: unknown): HostTerminalSeal | null {
	if (!details || typeof details !== "object" || Array.isArray(details) || !("hostSeal" in details)) return null;
	const parsed = sealShape(details.hostSeal);
	if (!parsed) return null;
	const stored = trustedHostSeals.get(parsed.trustId);
	if (!stored) return null;
	if (
		stored.command !== parsed.command ||
		stored.codeVersion !== parsed.codeVersion ||
		stored.evidenceLocation !== parsed.evidenceLocation ||
		stored.cwd !== parsed.cwd
	) {
		return null;
	}
	return stored;
}

export function collectTrustedHostSeals(
	messages: readonly { role: string; toolName?: string; isError?: boolean; details?: unknown }[],
): HostTerminalSeal[] {
	const seals: HostTerminalSeal[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "bash" || message.isError === true) continue;
		const seal = readHostTerminalSeal(message.details);
		if (seal) seals.push(seal);
	}
	return seals;
}

export function bindHostSealsToAcceptance(input: {
	seals: readonly HostTerminalSeal[];
	acceptanceIds: readonly string[];
	verificationCommands?: readonly string[];
	currentCodeVersion: string;
}): { id: string; evidenceLocation: string }[] {
	const current = input.currentCodeVersion.trim();
	if (!current) return [];
	const fresh = input.seals.filter(seal => seal.codeVersion === current && readHostTerminalSeal({ hostSeal: seal }));
	if (fresh.length === 0) return [];
	const commands = new Set((input.verificationCommands ?? []).map(sealEligibleVerificationCommand));
	const out: { id: string; evidenceLocation: string }[] = [];
	for (const id of input.acceptanceIds) {
		const trimmed = id.trim();
		if (!trimmed) continue;
		const match = fresh.find(
			seal =>
				(seal.id === trimmed || seal.command === trimmed) &&
				((input.verificationCommands?.length ?? 0) === 0 || commands.has(seal.command)),
		);
		if (!match) continue;
		out.push({ id: trimmed, evidenceLocation: match.evidenceLocation });
	}
	return out;
}

export function filesOutsideScope(changedFiles: readonly string[], scopePaths: readonly string[] | undefined): boolean {
	if (!scopePaths || scopePaths.length === 0) return false;
	const scopes = scopePaths.map(scope => scope.replaceAll("\\", "/").replace(/\/+$/, "")).filter(Boolean);
	if (scopes.length === 0) return false;
	return changedFiles.some(file => {
		const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
		return !scopes.some(scope => normalized === scope || normalized.startsWith(`${scope}/`));
	});
}
