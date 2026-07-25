/**
 * Deterministic stage-boundary role-aware handoff from typed workflow artifacts.
 * Does not call a model; does not delete source artifacts.
 * Fingerprint compares canonical payload (not dynamic artifact envelope IDs).
 */

import { sha256Hex } from "./optimization-receipt";
import type {
	ImplementationArtifactV1,
	PlanArtifactV1,
	ReviewArtifactV1,
	ReviewFindingV1,
	VerificationArtifactV1,
	WorkflowRole,
} from "./types";

export const STAGE_HANDOFF_VERSION = 1 as const;
export const STAGE_HANDOFF_KIND = "stage_handoff" as const;

export type StageHandoffEdge = "planner→implementer" | "implementer→reviewer" | "reviewer→repair";

export interface StageHandoffPreservedItem {
	key: string;
	/** Canonical text/JSON fragment retained for the next role. */
	content: string;
	/** Optional recovery URI pointing at a durable artifact. */
	recoveryUri?: string;
	/** When true, item must not be dropped under budget pressure. */
	blocking: boolean;
}

export interface StageHandoffV1 {
	schemaVersion: typeof STAGE_HANDOFF_VERSION;
	kind: typeof STAGE_HANDOFF_KIND;
	edge: StageHandoffEdge;
	fromRole: WorkflowRole;
	toRole: WorkflowRole;
	/** Ordered preserved items (stable sort by key). */
	preserved: StageHandoffPreservedItem[];
	/** Source artifact kinds included (not dynamic ids). */
	sourceKinds: string[];
	/** Omitted non-blocking artifact kind labels (if any). */
	omittedKinds: string[];
	bytesBefore: number;
	bytesAfter: number;
	/** sha256 of canonical serialized payload (excludes timestamps / dynamic ids). */
	contentFingerprint: string;
}

function sortItems(items: StageHandoffPreservedItem[]): StageHandoffPreservedItem[] {
	return [...items].sort((a, b) => a.key.localeCompare(b.key));
}

function canonicalFingerprint(edge: StageHandoffEdge, preserved: StageHandoffPreservedItem[]): string {
	const canonical = {
		edge,
		preserved: preserved.map(p => ({
			key: p.key,
			content: p.content,
			recoveryUri: p.recoveryUri ?? null,
			blocking: p.blocking,
		})),
	};
	return sha256Hex(JSON.stringify(canonical));
}

function item(key: string, content: string, blocking: boolean, recoveryUri?: string): StageHandoffPreservedItem {
	return { key, content, blocking, recoveryUri };
}

/** planner → implementer: goals, constraints, non-goals, decisions, files, acceptance, risks. */
export function buildPlannerToImplementerHandoff(input: {
	plan: PlanArtifactV1;
	planReview?: ReviewArtifactV1 | null;
	planRecoveryUri?: string;
}): StageHandoffV1 {
	const { plan, planReview, planRecoveryUri } = input;
	const preserved: StageHandoffPreservedItem[] = [
		item("goal.summary", plan.summary, true, planRecoveryUri),
		item("constraints.assumptions", JSON.stringify(plan.assumptions), true),
		item("non_goals", JSON.stringify(plan.nonGoals), true),
		item("affected_files", JSON.stringify(plan.affectedFiles), true),
		item("acceptance", JSON.stringify(plan.acceptanceCriteria), true),
		item("verification_commands", JSON.stringify(plan.verificationCommands), true),
		item("risks", JSON.stringify(plan.risks), false),
		item("implementation_steps", JSON.stringify(plan.implementationSteps), true),
		item("rollback", JSON.stringify(plan.rollback), false),
	];
	if (planReview) {
		preserved.push(
			item("plan_review.decision", planReview.decision, true),
			item(
				"plan_review.findings",
				JSON.stringify(planReview.findings.filter(f => f.status === "open" || f.blocking)),
				true,
			),
		);
	}
	return finalize("planner→implementer", "planner", "implementer", preserved, ["plan", "review"], []);
}

/** implementer → reviewer: plan ref, changed files, patch, commands/tests, unresolved. */
export function buildImplementerToReviewerHandoff(input: {
	implementation: ImplementationArtifactV1;
	plan?: PlanArtifactV1 | null;
	verification?: VerificationArtifactV1 | null;
	implRecoveryUri?: string;
	patchRecoveryUri?: string;
}): StageHandoffV1 {
	const { implementation, plan, verification, implRecoveryUri, patchRecoveryUri } = input;
	const preserved: StageHandoffPreservedItem[] = [
		item("implementation.summary", implementation.summary, true, implRecoveryUri),
		item("changed_files", JSON.stringify(implementation.changedFiles), true),
		item("addressed_step_ids", JSON.stringify(implementation.addressedStepIds), false),
		item("commands_run", JSON.stringify(implementation.commandsRun), true),
		item("unresolved", JSON.stringify(implementation.unresolved), true),
	];
	if (implementation.patchPath || patchRecoveryUri) {
		preserved.push(
			item(
				"patch",
				JSON.stringify({ path: implementation.patchPath ?? null, branch: implementation.branchName ?? null }),
				true,
				patchRecoveryUri ?? (implementation.patchPath ? `file://${implementation.patchPath}` : undefined),
			),
		);
	}
	if (plan) {
		preserved.push(
			item("plan.ref", JSON.stringify({ summary: plan.summary, acceptance: plan.acceptanceCriteria }), true),
		);
	}
	if (verification) {
		const failed = verification.checks.filter(c => c.status === "failed");
		preserved.push(
			item("verification.passed", String(verification.passed), true),
			item("verification.failed_checks", JSON.stringify(failed), true),
		);
	}
	return finalize(
		"implementer→reviewer",
		"implementer",
		"code_reviewer",
		preserved,
		["implementation", "plan", "verification"],
		[],
	);
}

/** reviewer → repair: open blocking findings, files/lines, failed verification, attempted fixes. */
export function buildReviewerToRepairHandoff(input: {
	review: ReviewArtifactV1;
	verification?: VerificationArtifactV1 | null;
	implementation?: ImplementationArtifactV1 | null;
	reviewRecoveryUri?: string;
}): StageHandoffV1 {
	const { review, verification, implementation, reviewRecoveryUri } = input;
	const blockingFindings: ReviewFindingV1[] = review.findings.filter(
		f =>
			f.blocking === true || f.priority === "P0" || (f.status === "open" && review.decision === "changes_requested"),
	);
	// Blocking findings are never droppable.
	const preserved: StageHandoffPreservedItem[] = [
		item("review.decision", review.decision, true, reviewRecoveryUri),
		item("review.blocking_findings", JSON.stringify(blockingFindings), true, reviewRecoveryUri),
		item(
			"review.open_findings",
			JSON.stringify(review.findings.filter(f => f.status === "open" || f.status === "in_progress")),
			true,
		),
	];
	if (verification) {
		const failed = verification.checks.filter(c => c.status === "failed");
		preserved.push(item("verification.failed", JSON.stringify(failed), true));
	}
	if (implementation) {
		preserved.push(
			item("implementation.changed_files", JSON.stringify(implementation.changedFiles), true),
			item("implementation.unresolved", JSON.stringify(implementation.unresolved), true),
			item("implementation.commands_run", JSON.stringify(implementation.commandsRun), false),
		);
	}
	return finalize(
		"reviewer→repair",
		"code_reviewer",
		"repair",
		preserved,
		["review", "verification", "implementation"],
		[],
	);
}

function finalize(
	edge: StageHandoffEdge,
	fromRole: WorkflowRole,
	toRole: WorkflowRole,
	preserved: StageHandoffPreservedItem[],
	sourceKinds: string[],
	omittedKinds: string[],
): StageHandoffV1 {
	const ordered = sortItems(preserved);
	const bytesAfter = ordered.reduce((s, p) => s + Buffer.byteLength(p.content, "utf-8"), 0);
	// bytesBefore ≈ same as after when we only extract (no silent mid-stage compression).
	return {
		schemaVersion: STAGE_HANDOFF_VERSION,
		kind: STAGE_HANDOFF_KIND,
		edge,
		fromRole,
		toRole,
		preserved: ordered,
		sourceKinds: [...sourceKinds].sort(),
		omittedKinds: [...omittedKinds].sort(),
		bytesBefore: bytesAfter,
		bytesAfter,
		contentFingerprint: canonicalFingerprint(edge, ordered),
	};
}

/** Serialize for persistence / prompt injection (stable key order via sorted preserved). */
export function serializeStageHandoff(handoff: StageHandoffV1): string {
	return JSON.stringify(handoff);
}
