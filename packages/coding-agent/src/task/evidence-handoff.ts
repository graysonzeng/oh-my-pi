/**
 * Cross-evidence handoff for task/subagent context reuse (P1-1).
 *
 * Packs goals, acceptance, versioned facts, open questions, failed attempts,
 * change scope, and verification ownership into the existing `context` string
 * (and optional artifact recovery URIs). No parallel memory platform.
 *
 * Reviewers receive raw evidence without author conclusions. Workers prefer
 * continuing an idle/parked non-isolated peer whose handoff is still valid.
 */

import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { fingerprintStable } from "../latency/stable-serialize";
import type { SubagentPerformanceClass } from "./review-performance";

export const EVIDENCE_HANDOFF_KIND = "evidence_handoff" as const;
export const EVIDENCE_HANDOFF_VERSION = 1 as const;
/** Fenced language tag — keeps the packet recoverable inside freeform context. */
export const EVIDENCE_HANDOFF_FENCE = "evidence-handoff";

export type EvidenceAudience = "worker" | "reviewer" | "explore";

export interface EvidenceIdentity {
	/** Stable id for this fact or artifact slice. */
	id: string;
	/** Version / identity of the evidence (sha256, revision, path@rev, …). */
	version: string;
	/** Optional recovery URI (`artifact://`, `local://`, …). */
	recoveryUri?: string;
	/** Explicit invalidation — consumers must re-read rather than trust. */
	stale?: boolean;
	staleReason?: string;
}

export interface ConfirmedFact extends EvidenceIdentity {
	/** Confirmed statement (fact), not an author conclusion. */
	statement: string;
	/** Optional raw evidence excerpt or citation. */
	evidence?: string;
}

export interface FailedAttempt {
	attempt: string;
	reason?: string;
}

export interface ChangeScope {
	paths?: string[];
	symbols?: string[];
	nonGoals?: string[];
}

export type VerificationOwner = "parent" | "worker" | "transferred";

export interface VerificationOwnership {
	owner: VerificationOwner;
	commands?: string[];
	notes?: string;
}

export interface EvidenceHandoffV1 {
	kind: typeof EVIDENCE_HANDOFF_KIND;
	v: typeof EVIDENCE_HANDOFF_VERSION;
	goals: string[];
	acceptance: string[];
	confirmedFacts: ConfirmedFact[];
	openQuestions: string[];
	failedAttempts: FailedAttempt[];
	changeScope: ChangeScope;
	verificationOwnership: VerificationOwnership;
	/**
	 * Author reasoning / self-assessment. Projected out for reviewers so they
	 * share raw evidence without inheriting author conclusions.
	 */
	authorConclusions?: string[];
	/** Canonical fingerprint of the handoff payload (excluding this field). */
	contentFingerprint?: string;
}

export type WorkerReuseAction = "continue" | "spawn_fresh";

export type WorkerReuseReason =
	| "valid_context"
	| "resumable_session"
	| "no_candidate"
	| "not_resumable"
	| "isolated"
	| "stale_evidence"
	| "scope_mismatch"
	| "invalid_handoff";

export interface WorkerReuseCandidate {
	id: string;
	status: string;
	isolated?: boolean;
}

export interface WorkerReuseDecision {
	action: WorkerReuseAction;
	reason: WorkerReuseReason;
	agentId?: string;
}

export interface BuildEvidenceHandoffInput {
	goals?: string[];
	acceptance?: string[];
	confirmedFacts?: ConfirmedFact[];
	openQuestions?: string[];
	failedAttempts?: FailedAttempt[];
	changeScope?: ChangeScope;
	verificationOwnership?: VerificationOwnership;
	authorConclusions?: string[];
}

const FENCE_RE = new RegExp(`\`\`\`${EVIDENCE_HANDOFF_FENCE}\\s*\\n([\\s\\S]*?)\\n\`\`\``, "m");
/**
 * Closed fence, or an opening tag through EOF when the closer was truncated.
 * Do not use the `m` flag: `$` must mean end of input, not end of line.
 */
const FENCE_BLOCK_SOURCE = `\`\`\`${EVIDENCE_HANDOFF_FENCE}\\b[\\s\\S]*?(?:\`\`\`|$)`;

function nonEmptyStrings(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	return values.map(v => v.trim()).filter(Boolean);
}

function normalizeFact(raw: unknown): ConfirmedFact | null {
	if (!isRecord(raw)) return null;
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	const version = typeof raw.version === "string" ? raw.version.trim() : "";
	const statement = typeof raw.statement === "string" ? raw.statement.trim() : "";
	if (!id || !version || !statement) return null;
	const fact: ConfirmedFact = { id, version, statement };
	if (typeof raw.recoveryUri === "string" && raw.recoveryUri.trim()) fact.recoveryUri = raw.recoveryUri.trim();
	if (typeof raw.evidence === "string" && raw.evidence.trim()) fact.evidence = raw.evidence.trim();
	if (raw.stale === true) {
		fact.stale = true;
		if (typeof raw.staleReason === "string" && raw.staleReason.trim()) fact.staleReason = raw.staleReason.trim();
	}
	return fact;
}

function normalizeFailedAttempt(raw: unknown): FailedAttempt | null {
	if (!isRecord(raw)) return null;
	const attempt = typeof raw.attempt === "string" ? raw.attempt.trim() : "";
	if (!attempt) return null;
	const out: FailedAttempt = { attempt };
	if (typeof raw.reason === "string" && raw.reason.trim()) out.reason = raw.reason.trim();
	return out;
}

function requireNormalizedFacts(rawFacts: readonly unknown[] | undefined): ConfirmedFact[] {
	if (!rawFacts || rawFacts.length === 0) return [];
	const facts: ConfirmedFact[] = [];
	const rejected: string[] = [];
	for (const [index, raw] of rawFacts.entries()) {
		const fact = normalizeFact(raw);
		if (!fact) {
			const id = isRecord(raw) && typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `#${index}`;
			rejected.push(id);
			continue;
		}
		facts.push(fact);
	}
	if (rejected.length > 0) {
		throw new Error(`evidence_handoff_malformed_facts:${rejected.join(",")}`);
	}
	return facts;
}

function requireNormalizedAttempts(rawAttempts: readonly unknown[] | undefined): FailedAttempt[] {
	if (!rawAttempts || rawAttempts.length === 0) return [];
	const attempts: FailedAttempt[] = [];
	const rejected: number[] = [];
	for (const [index, raw] of rawAttempts.entries()) {
		const attempt = normalizeFailedAttempt(raw);
		if (!attempt) {
			rejected.push(index);
			continue;
		}
		attempts.push(attempt);
	}
	if (rejected.length > 0) {
		throw new Error(`evidence_handoff_malformed_attempts:${rejected.join(",")}`);
	}
	return attempts;
}

function normalizeChangeScope(raw: unknown): ChangeScope {
	if (!isRecord(raw)) return {};
	const scope: ChangeScope = {};
	const paths = Array.isArray(raw.paths)
		? nonEmptyStrings(raw.paths.filter((p): p is string => typeof p === "string"))
		: [];
	const symbols = Array.isArray(raw.symbols)
		? nonEmptyStrings(raw.symbols.filter((s): s is string => typeof s === "string"))
		: [];
	const nonGoals = Array.isArray(raw.nonGoals)
		? nonEmptyStrings(raw.nonGoals.filter((s): s is string => typeof s === "string"))
		: [];
	if (paths.length) scope.paths = paths;
	if (symbols.length) scope.symbols = symbols;
	if (nonGoals.length) scope.nonGoals = nonGoals;
	return scope;
}

function normalizeVerificationOwnership(raw: unknown): VerificationOwnership {
	if (!isRecord(raw)) return { owner: "parent" };
	const owner = raw.owner === "parent" || raw.owner === "worker" || raw.owner === "transferred" ? raw.owner : "parent";
	const ownership: VerificationOwnership = { owner };
	if (Array.isArray(raw.commands)) {
		const commands = nonEmptyStrings(raw.commands.filter((c): c is string => typeof c === "string"));
		if (commands.length) ownership.commands = commands;
	}
	if (typeof raw.notes === "string" && raw.notes.trim()) ownership.notes = raw.notes.trim();
	return ownership;
}

function fingerprintPayload(handoff: Omit<EvidenceHandoffV1, "contentFingerprint">): string {
	return fingerprintStable({
		kind: handoff.kind,
		v: handoff.v,
		goals: handoff.goals,
		acceptance: handoff.acceptance,
		confirmedFacts: handoff.confirmedFacts,
		openQuestions: handoff.openQuestions,
		failedAttempts: handoff.failedAttempts,
		changeScope: handoff.changeScope,
		verificationOwnership: handoff.verificationOwnership,
		authorConclusions: handoff.authorConclusions ?? [],
	});
}

function scopeHasTargets(scope: ChangeScope | undefined): boolean {
	return (scope?.paths?.length ?? 0) > 0 || (scope?.symbols?.length ?? 0) > 0;
}

/** Build a versioned evidence handoff with a stable content fingerprint. */
export function buildEvidenceHandoff(input: BuildEvidenceHandoffInput = {}): EvidenceHandoffV1 {
	const base: Omit<EvidenceHandoffV1, "contentFingerprint"> = {
		kind: EVIDENCE_HANDOFF_KIND,
		v: EVIDENCE_HANDOFF_VERSION,
		goals: nonEmptyStrings(input.goals),
		acceptance: nonEmptyStrings(input.acceptance),
		confirmedFacts: requireNormalizedFacts(input.confirmedFacts),
		openQuestions: nonEmptyStrings(input.openQuestions),
		failedAttempts: requireNormalizedAttempts(input.failedAttempts),
		changeScope: normalizeChangeScope(input.changeScope ?? {}),
		verificationOwnership: normalizeVerificationOwnership(input.verificationOwnership ?? { owner: "parent" }),
		...(input.authorConclusions && nonEmptyStrings(input.authorConclusions).length
			? { authorConclusions: nonEmptyStrings(input.authorConclusions) }
			: {}),
	};
	return { ...base, contentFingerprint: fingerprintPayload(base) };
}

/** Parse a handoff object; returns null when shape/version is wrong or entries malformed. */
export function parseEvidenceHandoff(value: unknown): EvidenceHandoffV1 | null {
	if (!isRecord(value)) return null;
	if (value.kind !== EVIDENCE_HANDOFF_KIND || value.v !== EVIDENCE_HANDOFF_VERSION) return null;
	try {
		const goals = Array.isArray(value.goals)
			? nonEmptyStrings(value.goals.filter((g): g is string => typeof g === "string"))
			: [];
		const acceptance = Array.isArray(value.acceptance)
			? nonEmptyStrings(value.acceptance.filter((g): g is string => typeof g === "string"))
			: [];
		const confirmedFacts = requireNormalizedFacts(Array.isArray(value.confirmedFacts) ? value.confirmedFacts : []);
		const openQuestions = Array.isArray(value.openQuestions)
			? nonEmptyStrings(value.openQuestions.filter((g): g is string => typeof g === "string"))
			: [];
		const failedAttempts = requireNormalizedAttempts(Array.isArray(value.failedAttempts) ? value.failedAttempts : []);
		const authorConclusions = Array.isArray(value.authorConclusions)
			? nonEmptyStrings(value.authorConclusions.filter((g): g is string => typeof g === "string"))
			: [];
		return buildEvidenceHandoff({
			goals,
			acceptance,
			confirmedFacts,
			openQuestions,
			failedAttempts,
			changeScope: normalizeChangeScope(value.changeScope),
			verificationOwnership: normalizeVerificationOwnership(value.verificationOwnership),
			authorConclusions: authorConclusions.length ? authorConclusions : undefined,
		});
	} catch {
		return null;
	}
}

/** Extract a handoff JSON fence from a context string (if present and valid). */
export function extractEvidenceHandoffFromContext(context: string): {
	handoff: EvidenceHandoffV1;
	preamble: string;
	postamble: string;
} | null {
	const match = FENCE_RE.exec(context);
	if (!match || match.index === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]!.trim());
	} catch {
		return null;
	}
	const handoff = parseEvidenceHandoff(parsed);
	if (!handoff) return null;
	return {
		handoff,
		preamble: context.slice(0, match.index).trimEnd(),
		postamble: context.slice(match.index + match[0].length).trimStart(),
	};
}

/** True when context contains an evidence-handoff fence, including one truncated at EOF. */
export function contextHasEvidenceHandoffFence(context: string): boolean {
	return new RegExp(FENCE_BLOCK_SOURCE).test(context);
}

/** Remove every evidence-handoff fence, including an unterminated opener through EOF. */
export function stripEvidenceHandoffFences(context: string): string {
	return context
		.replace(new RegExp(FENCE_BLOCK_SOURCE, "g"), "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Distinguish a missing handoff from a fence that did not parse.
 * Callers must not treat an unparseable fence as "no handoff".
 */
export function inspectEvidenceHandoffContext(context: string | undefined): {
	handoff: EvidenceHandoffV1 | null;
	invalid: boolean;
} {
	const trimmed = context?.trim();
	if (!trimmed) return { handoff: null, invalid: false };
	const extracted = extractEvidenceHandoffFromContext(trimmed);
	if (extracted) return { handoff: extracted.handoff, invalid: false };
	return { handoff: null, invalid: contextHasEvidenceHandoffFence(trimmed) };
}

/** Serialize a handoff as a recoverable fenced JSON block. Rejects wrong kind/version. */
export function serializeEvidenceHandoff(handoff: EvidenceHandoffV1): string {
	const normalized = parseEvidenceHandoff(handoff);
	if (!normalized) throw new Error("evidence_handoff_serialize_invalid");
	return `\`\`\`${EVIDENCE_HANDOFF_FENCE}\n${JSON.stringify(normalized, null, "\t")}\n\`\`\``;
}

/** Render context text: optional preamble + handoff fence (+ optional postamble). */
export function renderEvidenceHandoffContext(
	handoff: EvidenceHandoffV1,
	options: { preamble?: string; postamble?: string } = {},
): string {
	const parts: string[] = [];
	const preamble = options.preamble?.trim();
	if (preamble) parts.push(preamble);
	parts.push("## Evidence handoff", serializeEvidenceHandoff(handoff));
	const postamble = options.postamble?.trim();
	if (postamble) parts.push(postamble);
	return parts.join("\n\n");
}

/** Map performance class onto handoff audience. */
export function audienceForPerformanceClass(performanceClass: SubagentPerformanceClass): EvidenceAudience {
	if (performanceClass === "review") return "reviewer";
	if (performanceClass === "explore") return "explore";
	return "worker";
}

/**
 * Project a handoff for a role.
 * Reviewers keep goals/acceptance/facts/scope/verification/open questions/failed
 * attempts, but never author conclusions.
 */
export function projectEvidenceHandoff(handoff: EvidenceHandoffV1, audience: EvidenceAudience): EvidenceHandoffV1 {
	const base = parseEvidenceHandoff(handoff);
	if (!base) throw new Error("evidence_handoff_project_invalid");
	if (audience === "reviewer") {
		return buildEvidenceHandoff({
			goals: base.goals,
			acceptance: base.acceptance,
			confirmedFacts: base.confirmedFacts,
			openQuestions: base.openQuestions,
			failedAttempts: base.failedAttempts,
			changeScope: base.changeScope,
			verificationOwnership: base.verificationOwnership,
			// intentionally omit authorConclusions
		});
	}
	return base;
}

/** Mark one fact stale (version/invalidation). Missing id is a no-op. */
export function markEvidenceStale(handoff: EvidenceHandoffV1, factId: string, reason: string): EvidenceHandoffV1 {
	const base = parseEvidenceHandoff(handoff);
	if (!base) throw new Error("evidence_handoff_mark_stale_invalid");
	const confirmedFacts = base.confirmedFacts.map(fact =>
		fact.id === factId ? { ...fact, stale: true as const, staleReason: reason.trim() || "stale" } : fact,
	);
	return buildEvidenceHandoff({
		goals: base.goals,
		acceptance: base.acceptance,
		confirmedFacts,
		openQuestions: base.openQuestions,
		failedAttempts: base.failedAttempts,
		changeScope: base.changeScope,
		verificationOwnership: base.verificationOwnership,
		authorConclusions: base.authorConclusions,
	});
}

/**
 * Invalidate a fact when the observed version/identity disagrees with the
 * handoff. Matching versions leave the fact unchanged.
 */
export function invalidateFactIfVersionMismatch(
	handoff: EvidenceHandoffV1,
	factId: string,
	observedVersion: string,
	reason = "version_mismatch",
): EvidenceHandoffV1 {
	const fact = handoff.confirmedFacts.find(item => item.id === factId);
	if (!fact) return handoff;
	if (fact.version === observedVersion.trim()) return handoff;
	return markEvidenceStale(handoff, factId, reason);
}

/** Facts currently marked stale / invalidated. */
export function listStaleEvidence(handoff: EvidenceHandoffV1): ConfirmedFact[] {
	return handoff.confirmedFacts.filter(fact => fact.stale === true);
}

function pathOverlaps(left: string, right: string): boolean {
	const a = left.replaceAll("\\", "/");
	const b = right.replaceAll("\\", "/");
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Related when both scopes lack targets, or when at least one path/symbol overlaps.
 * Nonempty correction against empty existing scope is a mismatch (unknown prior scope).
 */
function scopesRelated(existing: ChangeScope, correction: ChangeScope | undefined): boolean {
	if (!correction) return true;
	const correctionHas = scopeHasTargets(correction);
	const existingHas = scopeHasTargets(existing);
	if (!correctionHas) return true;
	if (!existingHas) return false;
	const correctionPaths = correction.paths ?? [];
	const correctionSymbols = correction.symbols ?? [];
	const existingPaths = existing.paths ?? [];
	const existingSymbols = existing.symbols ?? [];
	for (const path of correctionPaths) {
		if (existingPaths.some(existingPath => pathOverlaps(path, existingPath))) return true;
	}
	for (const symbol of correctionSymbols) {
		if (existingSymbols.includes(symbol)) return true;
	}
	return false;
}

/**
 * Prefer continuing an idle/parked non-isolated worker that still has valid
 * context. Stale evidence, invalid handoff, or unrelated scope → spawn fresh.
 * Idle without a structured handoff may continue via session transcript
 * (`resumable_session`) — never claimed as `valid_context`.
 */
export function decideWorkerReuse(input: {
	candidate?: WorkerReuseCandidate | null;
	handoff?: EvidenceHandoffV1 | null;
	/** Context had an evidence-handoff fence that did not parse. Not the same as a missing handoff. */
	invalidHandoff?: boolean;
	correctionScope?: ChangeScope;
}): WorkerReuseDecision {
	const candidate = input.candidate;
	if (!candidate?.id) return { action: "spawn_fresh", reason: "no_candidate" };
	if (candidate.isolated === true) return { action: "spawn_fresh", reason: "isolated", agentId: candidate.id };
	if (candidate.status !== "idle" && candidate.status !== "parked") {
		return { action: "spawn_fresh", reason: "not_resumable", agentId: candidate.id };
	}
	if (input.invalidHandoff === true) {
		return { action: "spawn_fresh", reason: "invalid_handoff", agentId: candidate.id };
	}
	if (input.handoff == null) {
		return { action: "continue", reason: "resumable_session", agentId: candidate.id };
	}
	const handoff = parseEvidenceHandoff(input.handoff);
	if (!handoff) {
		return { action: "spawn_fresh", reason: "invalid_handoff", agentId: candidate.id };
	}
	if (listStaleEvidence(handoff).length > 0) {
		return { action: "spawn_fresh", reason: "stale_evidence", agentId: candidate.id };
	}
	if (!scopesRelated(handoff.changeScope, input.correctionScope)) {
		return { action: "spawn_fresh", reason: "scope_mismatch", agentId: candidate.id };
	}
	return { action: "continue", reason: "valid_context", agentId: candidate.id };
}

/**
 * Seed used to synthesize a handoff fence from a completed task contract when
 * the caller did not already embed one. Paths/symbols are intentionally omitted
 * until a dedicated scope extractor exists — empty changeScope is valid.
 */
export interface EvidenceHandoffContractSeed {
	target?: readonly string[];
	change?: readonly string[];
	acceptance?: readonly string[];
}

/**
 * Ensure context carries a structured evidence-handoff fence when the spawn
 * contract already has goals/acceptance. Existing valid fences are left alone
 * (including broken fences that reviewers later strip).
 */
export function ensureEvidenceHandoffContext(
	context: string | undefined,
	contract: EvidenceHandoffContractSeed,
): string | undefined {
	const trimmed = context?.trim() || undefined;
	if (trimmed && (extractEvidenceHandoffFromContext(trimmed) || contextHasEvidenceHandoffFence(trimmed))) {
		return trimmed;
	}
	const goals = nonEmptyStrings([...(contract.target ?? []), ...(contract.change ?? [])]);
	const acceptance = nonEmptyStrings(contract.acceptance);
	if (goals.length === 0 && acceptance.length === 0) return trimmed;
	return renderEvidenceHandoffContext(
		buildEvidenceHandoff({
			goals: goals.length ? goals : acceptance,
			acceptance: acceptance.length ? acceptance : goals,
			verificationOwnership: { owner: "parent" },
		}),
		{ preamble: trimmed },
	);
}

/**
 * Prepare context for a child spawn: when an evidence handoff fence is present,
 * re-project it for the child's performance class; otherwise pass through.
 * Reviewers never receive an unparseable fence that could leak author conclusions.
 */
export function prepareSubagentContext(
	context: string | undefined,
	performanceClass: SubagentPerformanceClass,
): string | undefined {
	const trimmed = context?.trim();
	if (!trimmed) return undefined;
	const audience = audienceForPerformanceClass(performanceClass);
	const extracted = extractEvidenceHandoffFromContext(trimmed);
	if (!extracted) {
		if (audience === "reviewer" && contextHasEvidenceHandoffFence(trimmed)) {
			const stripped = stripEvidenceHandoffFences(trimmed);
			return stripped || undefined;
		}
		return trimmed;
	}
	const projected = projectEvidenceHandoff(extracted.handoff, audience);
	// A second fence in the preamble/postamble is not re-projected. Reviewers must
	// not keep it: it can still carry author conclusions or an unparseable body.
	const preamble = audience === "reviewer" ? stripEvidenceHandoffFences(extracted.preamble) : extracted.preamble;
	const postamble = audience === "reviewer" ? stripEvidenceHandoffFences(extracted.postamble) : extracted.postamble;
	return renderEvidenceHandoffContext(projected, {
		...(preamble ? { preamble } : {}),
		...(postamble ? { postamble } : {}),
	});
}
