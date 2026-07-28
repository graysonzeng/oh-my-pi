/**
 * Pure completion evaluator for workflow final verify and ordinary explicit obligations.
 *
 * Runtime decides success/continue/blocked from typed state — never from model self-report.
 * Ordinary path only recognizes Todo / Goal / required-yield / extension session_stop sources.
 */

import type {
	ScopeStatus,
	SessionPolicyStateV1,
	TaskGuardId,
	TaskRolePolicyV1,
	UnresolvedItemStatus,
	VerificationEvidenceStatus,
} from "./types";

export type CompletionDecision = "success" | "continue" | "blocked";

export type OrdinaryObligationSource = "todo" | "goal" | "required_yield" | "session_stop" | "extension";

export interface OrdinaryTaskObligation {
	id: string;
	source: OrdinaryObligationSource;
	status: UnresolvedItemStatus;
	/** Optional verification id that may close this obligation when receipt matches. */
	verificationId?: string;
	/** Optional durable artifact / yield reference. */
	artifactRef?: string;
	label?: string;
}

export interface CompletionEvaluation {
	decision: CompletionDecision;
	/** Whether any explicit completion obligation made the gate active. */
	active: boolean;
	reasons: string[];
	failedGuards: TaskGuardId[];
	openUnresolvedIds: string[];
	missingArtifacts: string[];
	failedVerifications: string[];
}

export interface EvaluateCompletionInput {
	completionRequirements: TaskRolePolicyV1["completionRequirements"];
	session: Pick<
		SessionPolicyStateV1,
		"unresolvedItems" | "requiredArtifactStatus" | "verificationEvidence" | "scopeStatus"
	>;
	/**
	 * When false, only protocol-level unpaired/schema failures can block.
	 * When omitted, active is inferred from explicit obligations / requirements.
	 */
	completionGateActive?: boolean;
	/** True when a tool call has no matching tool result in the current turn ledger. */
	unpairedToolState?: boolean;
	/** Host schema/output validator result; null/undefined means not applicable. */
	schemaValid?: boolean | null;
}

function openUnresolved(items: SessionPolicyStateV1["unresolvedItems"]): SessionPolicyStateV1["unresolvedItems"] {
	return items.filter(item => item.status === "open" || item.status === "blocked");
}

function isGateActive(input: EvaluateCompletionInput): boolean {
	if (input.completionGateActive === false) return false;
	if (input.completionGateActive === true) return true;
	const hasUnresolved = openUnresolved(input.session.unresolvedItems).length > 0;
	const req = input.completionRequirements;
	return hasUnresolved || req.requiredArtifacts.length > 0 || req.verificationRequired || req.scopeRequired;
}

/**
 * Evaluate task completion from typed session/task state.
 * Pure and deterministic.
 */
export function evaluateCompletion(input: EvaluateCompletionInput): CompletionEvaluation {
	const reasons: string[] = [];
	const failedGuards: TaskGuardId[] = [];
	const open = openUnresolved(input.session.unresolvedItems);
	const openUnresolvedIds = open.map(item => item.id);

	const requiredKinds = input.completionRequirements.requiredArtifacts;
	const presentByKind = new Map(input.session.requiredArtifactStatus.map(a => [a.kind, a]));
	const missingArtifacts = requiredKinds.filter(kind => presentByKind.get(kind)?.present !== true);

	const failedVerifications = input.session.verificationEvidence
		.filter(v => v.status === "failed")
		.map(v => v.commandOrCheck);
	const hasUnknownVerification = input.session.verificationEvidence.some(v => v.status === "unknown");
	const hasPassedVerification = input.session.verificationEvidence.some(v => v.status === "passed");

	const active = isGateActive(input);

	if (input.unpairedToolState) {
		failedGuards.push("unpaired_tool_call_result");
		reasons.push("unpaired_tool_call_result");
	}
	if (input.schemaValid === false) {
		failedGuards.push("schema_output_validator");
		reasons.push("schema_output_invalid");
	}

	if (!active) {
		// Ordinary Q&A / no explicit obligations: protocol failures still block; else success.
		if (failedGuards.length > 0) {
			return {
				decision: "blocked",
				active: false,
				reasons,
				failedGuards,
				openUnresolvedIds,
				missingArtifacts: [],
				failedVerifications: [],
			};
		}
		return {
			decision: "success",
			active: false,
			reasons: [],
			failedGuards: [],
			openUnresolvedIds: [],
			missingArtifacts: [],
			failedVerifications: [],
		};
	}

	if (open.length > 0) {
		failedGuards.push("unresolved_items_must_close");
		const blocked = open.some(item => item.status === "blocked");
		reasons.push(blocked ? "unresolved_items_blocked" : "unresolved_items_open");
	}

	if (requiredKinds.length > 0 && missingArtifacts.length > 0) {
		failedGuards.push("required_artifacts_must_present");
		reasons.push(`required_artifacts_missing:${missingArtifacts.join(",")}`);
	}

	if (input.completionRequirements.verificationRequired) {
		if (failedVerifications.length > 0) {
			failedGuards.push("verification_must_pass");
			reasons.push(`verification_failed:${failedVerifications.join(",")}`);
		} else if (input.session.verificationEvidence.length === 0 || hasUnknownVerification || !hasPassedVerification) {
			failedGuards.push("verification_must_pass");
			reasons.push("verification_incomplete");
		}
	}

	if (input.completionRequirements.scopeRequired) {
		if (input.session.scopeStatus === "violation") {
			failedGuards.push("scope_must_not_violate");
			reasons.push("scope_violation");
		}
	}

	if (failedGuards.length === 0) {
		return {
			decision: "success",
			active: true,
			reasons: [],
			failedGuards: [],
			openUnresolvedIds: [],
			missingArtifacts: [],
			failedVerifications: [],
		};
	}

	// Protocol / verification hard failures and blocked unresolved → blocked.
	// Open work without hard verification/scope failure → continue.
	const hardBlock =
		failedGuards.includes("unpaired_tool_call_result") ||
		failedGuards.includes("schema_output_validator") ||
		failedGuards.includes("verification_must_pass") ||
		failedGuards.includes("scope_must_not_violate") ||
		failedGuards.includes("required_artifacts_must_present") ||
		open.some(item => item.status === "blocked");

	return {
		decision: hardBlock ? "blocked" : "continue",
		active: true,
		reasons,
		failedGuards,
		openUnresolvedIds,
		missingArtifacts,
		failedVerifications,
	};
}

// ---------------------------------------------------------------------------
// Ordinary explicit-source normalization (no NLP)
// ---------------------------------------------------------------------------

export interface OrdinaryTodoPhaseLike {
	name: string;
	tasks: Array<{ content: string; status: string }>;
}

export interface OrdinaryGoalLike {
	id: string;
	status: string;
	objective?: string;
	enabled?: boolean;
}

export interface OrdinaryRequiredYieldLike {
	/** Structured yield still required for this turn/run. */
	required: boolean;
	satisfied: boolean;
	status?: UnresolvedItemStatus;
	artifactRef?: string;
}

export interface OrdinarySessionStopLike {
	continuationCount: number;
	cap: number;
	/** Hook asked to continue but may have been capped. */
	wantsContinuation?: boolean;
}

export interface NormalizeOrdinaryObligationsInput {
	todoPhases?: OrdinaryTodoPhaseLike[];
	goal?: OrdinaryGoalLike | null;
	requiredYield?: OrdinaryRequiredYieldLike | null;
	sessionStop?: OrdinarySessionStopLike | null;
	extensionObligations?: OrdinaryTaskObligation[];
}

export interface NormalizeOrdinaryObligationsResult {
	obligations: OrdinaryTaskObligation[];
	unresolvedItems: SessionPolicyStateV1["unresolvedItems"];
	/** True when any explicit ordinary obligation remains open/blocked. */
	hasExplicitObligations: boolean;
	/** Cap / budget exhausted while work remains. */
	continuationCapped: boolean;
	diagnostics: string[];
}

export function normalizeOrdinaryObligations(
	input: NormalizeOrdinaryObligationsInput,
): NormalizeOrdinaryObligationsResult {
	const obligations: OrdinaryTaskObligation[] = [];
	const diagnostics: string[] = [];
	let continuationCapped = false;

	const phases = input.todoPhases ?? [];
	let todoIndex = 0;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status !== "pending" && task.status !== "in_progress") continue;
			todoIndex += 1;
			obligations.push({
				id: `todo:${phase.name}:${todoIndex}`,
				source: "todo",
				status: "open",
				label: task.content,
			});
		}
	}

	const goal = input.goal;
	if (goal && (goal.enabled === true || goal.status === "active" || goal.status === "budget-limited")) {
		if (goal.status === "active" || goal.status === "budget-limited") {
			const status: UnresolvedItemStatus = goal.status === "budget-limited" ? "blocked" : "open";
			obligations.push({
				id: `goal:${goal.id}`,
				source: "goal",
				status,
				label: goal.objective,
			});
			if (status === "blocked") {
				diagnostics.push("goal_budget_limited");
			}
		}
	}

	const yieldState = input.requiredYield;
	if (yieldState?.required && !yieldState.satisfied) {
		obligations.push({
			id: "required_yield",
			source: "required_yield",
			status: yieldState.status ?? "open",
			artifactRef: yieldState.artifactRef,
		});
	}

	const stop = input.sessionStop;
	if (stop?.wantsContinuation) {
		if (stop.continuationCount >= stop.cap) {
			continuationCapped = true;
			obligations.push({
				id: "session_stop",
				source: "session_stop",
				status: "blocked",
				label: `session_stop cap ${stop.cap}`,
			});
			diagnostics.push(`session_stop_continuation_cap:${stop.cap}`);
		} else {
			obligations.push({
				id: "session_stop",
				source: "session_stop",
				status: "open",
			});
		}
	}

	for (const ext of input.extensionObligations ?? []) {
		obligations.push({ ...ext, source: "extension" });
	}

	const unresolvedItems = obligations.map(o => ({
		id: o.id,
		kind: o.source,
		status: o.status,
	}));

	return {
		obligations,
		unresolvedItems,
		hasExplicitObligations: obligations.length > 0,
		continuationCapped,
		diagnostics,
	};
}

export interface EvaluateOrdinaryContinuationInput {
	todoPhases?: OrdinaryTodoPhaseLike[];
	goal?: OrdinaryGoalLike | null;
	requiredYield?: OrdinaryRequiredYieldLike | null;
	sessionStop?: OrdinarySessionStopLike | null;
	extensionObligations?: OrdinaryTaskObligation[];
	/** todo.remindersMax reached while incomplete todos remain. */
	todoReminderCapped?: boolean;
	unpairedToolState?: boolean;
	schemaValid?: boolean | null;
}

/**
 * Ordinary settle helper: only activates on explicit Todo/Goal/yield/session_stop sources.
 * Plain Q&A (no obligations) returns inactive success — no second loop, no NLP.
 */
export function evaluateOrdinaryContinuation(input: EvaluateOrdinaryContinuationInput): CompletionEvaluation & {
	obligations: OrdinaryTaskObligation[];
	diagnostics: string[];
	continuationCapped: boolean;
} {
	const normalized = normalizeOrdinaryObligations(input);
	const diagnostics = [...normalized.diagnostics];
	let continuationCapped = normalized.continuationCapped;

	if (input.todoReminderCapped && normalized.obligations.some(o => o.source === "todo")) {
		continuationCapped = true;
		diagnostics.push("todo_reminders_max_reached");
		// Mark todo obligations blocked so we do not loop as fake success.
		for (const item of normalized.unresolvedItems) {
			if (item.kind === "todo") item.status = "blocked";
		}
		for (const o of normalized.obligations) {
			if (o.source === "todo") o.status = "blocked";
		}
	}

	const evaluation = evaluateCompletion({
		completionRequirements: {
			requiredArtifacts: [],
			verificationRequired: false,
			scopeRequired: false,
		},
		session: {
			unresolvedItems: normalized.unresolvedItems,
			requiredArtifactStatus: [],
			verificationEvidence: [],
			scopeStatus: "adhered",
		},
		completionGateActive: normalized.hasExplicitObligations,
		unpairedToolState: input.unpairedToolState,
		schemaValid: input.schemaValid,
	});

	if (continuationCapped && evaluation.decision === "continue") {
		return {
			...evaluation,
			decision: "blocked",
			reasons: [...evaluation.reasons, "continuation_capped"],
			obligations: normalized.obligations,
			diagnostics,
			continuationCapped,
		};
	}

	return {
		...evaluation,
		obligations: normalized.obligations,
		diagnostics,
		continuationCapped,
	};
}

// ---------------------------------------------------------------------------
// Workflow final-verify bridge
// ---------------------------------------------------------------------------

export interface WorkflowFinalCompletionInput {
	implementation?: { unresolved?: string[]; summary?: string } | null;
	openBlockingFindings?: Array<{ id: string; summary?: string }>;
	verification: {
		passed: boolean;
		checks: Array<{ id: string; status: string; command?: string; summary?: string }>;
	};
	/** Existing ScopeMetrics status; violation cannot complete. */
	scopeStatus?: ScopeStatus;
	/** Required artifact kinds for the stage (defaults to implementation + verification). */
	requiredArtifacts?: string[];
}

/**
 * Map workflow typed artifacts into evaluateCompletion.
 * implementation missing/unresolved, open blocking findings, verification fail,
 * and scope violation all prevent completed.
 */
export function evaluateWorkflowFinalCompletion(input: WorkflowFinalCompletionInput): CompletionEvaluation & {
	passed: boolean;
} {
	const unresolvedItems: SessionPolicyStateV1["unresolvedItems"] = [];

	const impl = input.implementation;
	if (!impl) {
		unresolvedItems.push({ id: "implementation", kind: "implementation", status: "blocked" });
	} else {
		for (const [index, item] of (impl.unresolved ?? []).entries()) {
			unresolvedItems.push({
				id: `implementation:unresolved:${index}`,
				kind: "implementation_unresolved",
				status: "open",
			});
			// Keep label out of id; reason carries summary via checks.
			void item;
		}
	}

	for (const finding of input.openBlockingFindings ?? []) {
		unresolvedItems.push({
			id: `finding:${finding.id}`,
			kind: "blocking_finding",
			status: "open",
		});
	}

	const requiredArtifacts = input.requiredArtifacts ?? ["implementation", "verification"];
	const requiredArtifactStatus = requiredArtifacts.map(kind => {
		if (kind === "implementation") {
			return { kind, present: Boolean(impl) };
		}
		if (kind === "verification") {
			return { kind, present: true };
		}
		return { kind, present: false };
	});

	const verificationEvidence = input.verification.checks.map(check => {
		let status: VerificationEvidenceStatus = "unknown";
		if (check.status === "passed") status = "passed";
		else if (check.status === "failed") status = "failed";
		else if (check.status === "skipped") status = "unknown";
		return {
			commandOrCheck: check.command ?? check.id,
			status,
		};
	});

	// Aggregate fail when verifier says not passed even if checks empty.
	if (!input.verification.passed && !verificationEvidence.some(v => v.status === "failed")) {
		verificationEvidence.push({ commandOrCheck: "final_verify", status: "failed" });
	}
	if (input.verification.passed && verificationEvidence.length === 0) {
		verificationEvidence.push({ commandOrCheck: "final_verify", status: "passed" });
	}

	const evaluation = evaluateCompletion({
		completionRequirements: {
			requiredArtifacts,
			verificationRequired: true,
			scopeRequired: true,
		},
		session: {
			unresolvedItems,
			requiredArtifactStatus,
			verificationEvidence,
			scopeStatus: input.scopeStatus ?? "indeterminate",
		},
		completionGateActive: true,
	});

	return {
		...evaluation,
		passed: evaluation.decision === "success",
	};
}

export function formatCompletionDiagnostic(evaluation: CompletionEvaluation, prefix = "completion"): string {
	if (evaluation.decision === "success") {
		return `${prefix}:success`;
	}
	const parts = [prefix, evaluation.decision, ...evaluation.reasons];
	return parts.join(":");
}
