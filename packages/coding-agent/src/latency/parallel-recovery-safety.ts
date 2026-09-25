/**
 * P1-4 — Parallelism & recovery safety gaps.
 *
 * Fills already-identified contracts for shared-write exclusivity, read-only
 * concurrency, isolated worktree merge risk, task-contract completion,
 * unowned full-repo verify, and explainable cancel/merge/recovery outcomes.
 *
 * Safety guards only — not a latency win claim, not a second workflow state
 * machine, and isolation is never treated as a transaction.
 */

import type { ConcurrencyUnitMode, ConcurrencyUnitV1 } from "./concurrency-declaration";

/** Workspace class for conflict decisions. */
export type ParallelWorkspaceKind = "shared" | "isolated";

export type SharedWriteDecisionAction = "allow" | "block" | "transfer_ownership" | "merge_risk";

export type SharedWriteDecisionCode =
	| "no_overlap"
	| "read_only_ok"
	| "shared_write_overlap"
	| "ownership_transferred"
	| "isolated_merge_risk"
	| "ordered_dependency";

export interface SharedWriteDecision {
	action: SharedWriteDecisionAction;
	code: SharedWriteDecisionCode;
	/** Human-readable, stable explanation (cancel/recovery must stay explainable). */
	detail: string;
	paths: string[];
	leftId: string;
	rightId: string;
	/** Present when ownership moves from one unit to another. */
	ownership?: { from: string; to: string };
}

export interface ResolveSharedWriteOptions {
	/**
	 * When shared same-path writes collide, prefer transferring write ownership
	 * to `preferOwnerId` (or the left unit) instead of blocking.
	 */
	transferOwnership?: boolean;
	/** Unit that should keep the write paths after a transfer. */
	preferOwnerId?: string;
}

export type TaskContractRefusalCode = "empty_assignment";

export interface TaskContractCompletion {
	/** Never true solely because free text lacked an `# Acceptance` heading. */
	refused: boolean;
	refusalCode?: TaskContractRefusalCode;
	assignment: string;
	target: string[];
	change: string[];
	acceptance: string[];
	/** True when acceptance was derived from free text / Target / Change. */
	acceptanceCompleted: boolean;
	hadAcceptanceHeading: boolean;
	detail: string;
}

export type VerificationScopeKind = "repo" | "paths" | "commands" | "local";

export interface VerificationSpawnAssessment {
	allow: boolean;
	code:
		| "allowed_local"
		| "allowed_assigned_repo"
		| "forbidden_unowned_duplicate_repo"
		| "forbidden_unowned_repo"
		| "allowed_scoped";
	detail: string;
}

export type ParallelRecoveryKind =
	| "cancelled_before_start"
	| "cancelled_in_flight"
	| "cancelled_after_partial"
	| "merge_conflict"
	| "merge_applied"
	| "recovered_applied"
	| "needs_reconciliation";

export interface ParallelRecoveryOutcome {
	kind: ParallelRecoveryKind;
	/** Always true for this contract — callers must surface `detail`. */
	explainable: true;
	detail: string;
	/** Cancel never promises a verify re-run. */
	verifyRerunGuaranteed: false;
	/** Isolation is not a transaction; merge/cancel do not roll back sibling work. */
	isolationIsTransaction: false;
	unitIds?: string[];
}

const SHARED_SCOPE_ALIASES = new Set(["", "shared", "workspace", "main", "parent"]);

export function normalizeParallelPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
}

export function pathSetsOverlap(left: readonly string[], right: readonly string[]): boolean {
	const setB = new Set(right.map(normalizeParallelPath).filter(Boolean));
	for (const path of left) {
		const normalized = normalizeParallelPath(path);
		if (!normalized) continue;
		if (setB.has(normalized)) return true;
		for (const other of setB) {
			if (normalized.startsWith(`${other}/`) || other.startsWith(`${normalized}/`)) return true;
		}
	}
	return false;
}

export function overlappingPaths(left: readonly string[], right: readonly string[]): string[] {
	const out: string[] = [];
	const setB = new Set(right.map(normalizeParallelPath).filter(Boolean));
	for (const path of left) {
		const normalized = normalizeParallelPath(path);
		if (!normalized) continue;
		if (setB.has(normalized)) {
			out.push(normalized);
			continue;
		}
		for (const other of setB) {
			if (normalized.startsWith(`${other}/`) || other.startsWith(`${normalized}/`)) {
				out.push(normalized);
				break;
			}
		}
	}
	return [...new Set(out)].sort();
}

export function workspaceKind(isolationScope: string | undefined): ParallelWorkspaceKind {
	const scope = isolationScope?.trim().toLowerCase() ?? "";
	if (SHARED_SCOPE_ALIASES.has(scope)) return "shared";
	return "isolated";
}

/**
 * Shared-workspace identity for write exclusivity.
 * Distinct isolated scopes are different workspaces (merge risk, not overwrite).
 */
export function sharedWorkspaceKey(isolationScope: string | undefined): string | null {
	const kind = workspaceKind(isolationScope);
	if (kind === "shared") return "shared";
	return isolationScope!.trim();
}

export function sameSharedWorkspace(
	leftIsolation: string | undefined,
	rightIsolation: string | undefined,
): boolean {
	const left = sharedWorkspaceKey(leftIsolation);
	const right = sharedWorkspaceKey(rightIsolation);
	if (left === null || right === null) return false;
	return left === right;
}

function isWrite(mode: ConcurrencyUnitMode): boolean {
	return mode === "write";
}

/**
 * Decide shared-write / read / isolated-path policy for one pair of units.
 * Does not rebuild DAG lifecycle — pure conflict classification.
 */
export function resolveSharedWriteConflict(
	left: Pick<ConcurrencyUnitV1, "id" | "paths" | "mode" | "dependsOn" | "isolationScope">,
	right: Pick<ConcurrencyUnitV1, "id" | "paths" | "mode" | "dependsOn" | "isolationScope">,
	options: ResolveSharedWriteOptions = {},
): SharedWriteDecision {
	const paths = overlappingPaths(left.paths ?? [], right.paths ?? []);
	const ordered = (left.dependsOn ?? []).includes(right.id) || (right.dependsOn ?? []).includes(left.id);

	if (ordered) {
		return {
			action: "allow",
			code: "ordered_dependency",
			detail: `units ${left.id} and ${right.id} are ordered by dependency; not a concurrent shared-write`,
			paths,
			leftId: left.id,
			rightId: right.id,
		};
	}

	if (paths.length === 0) {
		return {
			action: "allow",
			code: "no_overlap",
			detail: `units ${left.id} and ${right.id} have disjoint paths`,
			paths,
			leftId: left.id,
			rightId: right.id,
		};
	}

	const leftWrite = isWrite(left.mode);
	const rightWrite = isWrite(right.mode);

	// Read-only agents reading the same path must not block each other.
	if (!leftWrite && !rightWrite) {
		return {
			action: "allow",
			code: "read_only_ok",
			detail: `read-only units ${left.id} and ${right.id} may share paths ${paths.join(", ")}`,
			paths,
			leftId: left.id,
			rightId: right.id,
		};
	}

	const shared = sameSharedWorkspace(left.isolationScope, right.isolationScope);
	if (!shared) {
		// Isolated worktrees: same path is a merge/conflict risk, not shared overwrite.
		return {
			action: "merge_risk",
			code: "isolated_merge_risk",
			detail: `isolated worktrees ${left.isolationScope ?? "(none)"} vs ${right.isolationScope ?? "(none)"} overlap paths ${paths.join(", ")}; risk is merge/conflict, not shared-write overwrite`,
			paths,
			leftId: left.id,
			rightId: right.id,
		};
	}

	if (!leftWrite || !rightWrite) {
		// Shared workspace: a writer collides with a same-path reader — block (or transfer).
		// Transfer only applies when both are writers; reader+writer stays blocked.
		return {
			action: "block",
			code: "shared_write_overlap",
			detail: `shared-workspace write/read overlap on ${paths.join(", ")} between ${left.id} and ${right.id}`,
			paths,
			leftId: left.id,
			rightId: right.id,
		};
	}

	if (options.transferOwnership) {
		const owner =
			options.preferOwnerId === right.id ? right.id : options.preferOwnerId === left.id ? left.id : left.id;
		const from = owner === left.id ? right.id : left.id;
		return {
			action: "transfer_ownership",
			code: "ownership_transferred",
			detail: `shared-workspace write ownership for ${paths.join(", ")} transferred from ${from} to ${owner}`,
			paths,
			leftId: left.id,
			rightId: right.id,
			ownership: { from, to: owner },
		};
	}

	return {
		action: "block",
		code: "shared_write_overlap",
		detail: `shared-workspace concurrent writes on ${paths.join(", ")} between ${left.id} and ${right.id}`,
		paths,
		leftId: left.id,
		rightId: right.id,
	};
}

/** True when the pair must not auto-parallel as a shared-write overwrite. */
export function isBlockingSharedWrite(
	left: Pick<ConcurrencyUnitV1, "id" | "paths" | "mode" | "dependsOn" | "isolationScope">,
	right: Pick<ConcurrencyUnitV1, "id" | "paths" | "mode" | "dependsOn" | "isolationScope">,
): boolean {
	return resolveSharedWriteConflict(left, right).action === "block";
}

const HEADER_RE = /^#{1,3}\s+(Target|Change|Acceptance)\s*$/i;

function splitAssignmentSections(assignment: string): {
	preamble: string[];
	target: string[];
	change: string[];
	acceptance: string[];
	hadAcceptanceHeading: boolean;
} {
	const lines = assignment.replace(/\r\n/g, "\n").split("\n");
	const preamble: string[] = [];
	const target: string[] = [];
	const change: string[] = [];
	const acceptance: string[] = [];
	let section: "preamble" | "target" | "change" | "acceptance" = "preamble";
	let hadAcceptanceHeading = false;

	for (const line of lines) {
		const match = line.match(HEADER_RE);
		if (match) {
			const name = match[1]!.toLowerCase();
			if (name === "target") section = "target";
			else if (name === "change") section = "change";
			else {
				section = "acceptance";
				hadAcceptanceHeading = true;
			}
			continue;
		}
		if (section === "preamble") preamble.push(line);
		else if (section === "target") target.push(line);
		else if (section === "change") change.push(line);
		else acceptance.push(line);
	}

	return { preamble, target, change, acceptance, hadAcceptanceHeading };
}

function nonEmptyLines(lines: readonly string[]): string[] {
	return lines.map(line => line.trim()).filter(Boolean);
}

function synthesizeAcceptance(parts: {
	preamble: string[];
	target: string[];
	change: string[];
}): string[] {
	const fromTarget = nonEmptyLines(parts.target);
	const fromChange = nonEmptyLines(parts.change);
	const fromPreamble = nonEmptyLines(parts.preamble).filter(
		line => !/^#{1,6}\s/.test(line) && line.length >= 8,
	);

	const candidates = [
		...fromTarget.map(line => `Target satisfied: ${line.replace(/^[-*]\s+/, "")}`),
		...fromChange.map(line => `Change observable: ${line.replace(/^[-*]\s+/, "")}`),
		...fromPreamble.slice(0, 3).map(line => `Outcome: ${line}`),
	];

	const unique = [...new Set(candidates.map(c => c.trim()).filter(Boolean))];
	if (unique.length > 0) return unique.slice(0, 6);
	return ["Assigned work produces an observable result that can be checked against the task description."];
}

/**
 * Complete a task contract from free text. Missing `# Acceptance` never refuses
 * spawn — acceptance is completed from Target/Change/preamble instead.
 */
export function completeTaskContract(assignment: string): TaskContractCompletion {
	const trimmed = assignment.trim();
	if (!trimmed) {
		return {
			refused: true,
			refusalCode: "empty_assignment",
			assignment: "",
			target: [],
			change: [],
			acceptance: [],
			acceptanceCompleted: false,
			hadAcceptanceHeading: false,
			detail: "refuse spawn: assignment body is empty (not because Acceptance heading is missing)",
		};
	}

	const sections = splitAssignmentSections(trimmed);
	const target = nonEmptyLines(sections.target);
	const change = nonEmptyLines(sections.change);
	const existingAcceptance = nonEmptyLines(sections.acceptance);

	if (sections.hadAcceptanceHeading && existingAcceptance.length > 0) {
		return {
			refused: false,
			assignment: trimmed,
			target,
			change,
			acceptance: existingAcceptance,
			acceptanceCompleted: false,
			hadAcceptanceHeading: true,
			detail: "task contract already includes Acceptance goals",
		};
	}

	const acceptance = synthesizeAcceptance({
		preamble: sections.preamble,
		target: sections.target,
		change: sections.change,
	});

	const completedAssignment = [
		trimmed,
		"",
		"# Acceptance",
		...acceptance.map(line => (line.startsWith("-") ? line : `- ${line}`)),
	].join("\n");

	return {
		refused: false,
		assignment: completedAssignment,
		target,
		change,
		acceptance,
		acceptanceCompleted: true,
		hadAcceptanceHeading: sections.hadAcceptanceHeading,
		detail: sections.hadAcceptanceHeading
			? "Acceptance heading present but empty; completed from Target/Change/free text"
			: "Acceptance heading missing; completed task contract from free text without refusing spawn",
	};
}

/**
 * Forbid unowned duplicate full-repo verify; keep explicitly assigned local/scoped verify.
 */
export function assessVerificationSpawn(input: {
	scope: VerificationScopeKind;
	owner?: string | null;
	explicitlyAssigned: boolean;
	duplicateOfActive?: boolean;
}): VerificationSpawnAssessment {
	const owner = input.owner?.trim() || null;
	const owned = Boolean(owner);
	const duplicate = input.duplicateOfActive === true;

	if (input.scope === "local" || input.scope === "paths" || input.scope === "commands") {
		if (input.explicitlyAssigned || owned) {
			return {
				allow: true,
				code: input.scope === "local" ? "allowed_local" : "allowed_scoped",
				detail: `explicitly assigned ${input.scope} verification is allowed`,
			};
		}
		return {
			allow: true,
			code: input.scope === "local" ? "allowed_local" : "allowed_scoped",
			detail: `scoped ${input.scope} verification without full-repo ownership is allowed`,
		};
	}

	// scope === "repo"
	if (input.explicitlyAssigned && owned) {
		return {
			allow: true,
			code: "allowed_assigned_repo",
			detail: `explicitly assigned full-repo verification owned by ${owner}`,
		};
	}

	if (duplicate && !owned) {
		return {
			allow: false,
			code: "forbidden_unowned_duplicate_repo",
			detail: "unowned duplicate full-repo verification is forbidden",
		};
	}

	if (!owned || !input.explicitlyAssigned) {
		return {
			allow: false,
			code: "forbidden_unowned_repo",
			detail: "full-repo verification requires an explicit owner assignment",
		};
	}

	return {
		allow: true,
		code: "allowed_assigned_repo",
		detail: `explicitly assigned full-repo verification owned by ${owner}`,
	};
}

/** Explainable cancel outcome — never claims verify re-run or transactional isolation. */
export function explainCancelOutcome(input: {
	phase: "before_start" | "in_flight" | "after_partial";
	unitIds?: readonly string[];
	reason?: string;
}): ParallelRecoveryOutcome {
	const reason = input.reason?.trim() || "caller cancelled";
	const kind =
		input.phase === "before_start"
			? "cancelled_before_start"
			: input.phase === "in_flight"
				? "cancelled_in_flight"
				: "cancelled_after_partial";
	const units = input.unitIds?.length ? ` units=[${input.unitIds.join(",")}]` : "";
	return {
		kind,
		explainable: true,
		detail: `cancel (${input.phase}): ${reason}${units}; isolation is not a transaction; verify re-run is not guaranteed`,
		verifyRerunGuaranteed: false,
		isolationIsTransaction: false,
		unitIds: input.unitIds ? [...input.unitIds] : undefined,
	};
}

/** Explainable merge / recovery outcome without treating isolation as a transaction. */
export function explainMergeRecoveryOutcome(input: {
	kind: "merge_conflict" | "merge_applied" | "recovered_applied" | "needs_reconciliation";
	detail: string;
	unitIds?: readonly string[];
}): ParallelRecoveryOutcome {
	return {
		kind: input.kind,
		explainable: true,
		detail: `${input.detail}; isolation is not a transaction`,
		verifyRerunGuaranteed: false,
		isolationIsTransaction: false,
		unitIds: input.unitIds ? [...input.unitIds] : undefined,
	};
}
