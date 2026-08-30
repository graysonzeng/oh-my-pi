import { PIPELINE_ANTI_ANCHORING_RATIONALE } from "./overlay";
import { satisfyMandatoryCoverage } from "./requirements-snapshot";
import {
	assertPassHasNoOpenBlockers,
	GateParseError,
	type GateResultArtifact,
	type GateResultModel,
	PlanReviewArtifactV2Schema,
	ReviewArtifactSchema,
} from "./schemas";
import type {
	PlanReviewArtifactV2,
	PlanReviewControlStateV1,
	PlanReviewFindingV2,
	RequirementsSnapshotV1,
	ReviewArtifactV1,
	ReviewFindingV1,
	WorkflowStatus,
} from "./types";

export interface DeriveGateReviewInput {
	gate: GateResultModel;
	workflowId: string;
	attemptId: string;
	stage: WorkflowStatus;
	createdAt?: string;
	confidence?: number;
	control?: PlanReviewControlStateV1;
	requirementsSnapshot?: RequirementsSnapshotV1;
	requirementsSnapshotRef?: string;
	reviewer?: { provider?: string; model?: string; modelProfileId?: string };
}

function decisionFromVerdict(verdict: GateResultModel["verdict"]): "approved" | "changes_requested" | "blocked" {
	if (verdict === "PASS" || verdict === "PASS_WITH_NOTES") return "approved";
	if (verdict === "NEEDS_REVISION") return "changes_requested";
	return "blocked";
}

function fillPlanFinding(finding: ReviewFindingV1): PlanReviewFindingV2 {
	const withBasis = finding as PlanReviewFindingV2;
	if (withBasis.basis) return withBasis;
	const sourceRefs = finding.file != null ? [`${finding.file}:${finding.line ?? 1}`] : ["pipeline:gate"];
	return {
		...finding,
		basis: "repo_evidence",
		requirementId: null,
		sourceRefs,
		missingAuthority: null,
	};
}

/** Engine-owned V2 plan review. Model JSON must not supply V2 extras. */
export function derivePlanReviewArtifactV2(input: DeriveGateReviewInput): PlanReviewArtifactV2 {
	assertPassHasNoOpenBlockers(input.gate.verdict, input.gate.findings);
	const decision = decisionFromVerdict(input.gate.verdict);
	if (decision === "approved") {
		assertPassHasNoOpenBlockers("PASS", input.gate.findings);
	}
	if (!input.requirementsSnapshot) {
		throw new GateParseError("missing_requirements_snapshot", "Cannot derive V2 plan review without a snapshot");
	}
	const findings = input.gate.findings.map(fillPlanFinding);
	if (findings.some(f => f.basis !== "repo_evidence" && f.basis !== "safety_invariant" && !f.sourceRefs?.length)) {
		throw new GateParseError("finding_basis_unfilled", "Cannot drop findings to force approved");
	}
	const reviewKind = input.control?.reviewRound === 2 ? "rereview" : "initial";
	const artifact: PlanReviewArtifactV2 = {
		schemaVersion: 2,
		workflowId: input.workflowId,
		attemptId: input.attemptId,
		stage: "plan_review",
		createdAt: input.createdAt ?? new Date().toISOString(),
		modelProfileId: input.reviewer?.modelProfileId ?? null,
		provider: input.reviewer?.provider ?? null,
		model: input.reviewer?.model ?? null,
		promptVersion: "pipeline-gate-v1",
		kind: "review",
		subject: "plan",
		reviewKind,
		decision,
		findings,
		explanation: input.gate.explanation,
		confidence: input.confidence ?? 0.5,
		requirementsSnapshotRef: input.requirementsSnapshotRef ?? "artifact://requirements",
		requirementsSnapshotSha256: input.requirementsSnapshot.sha256,
		coverage: decision === "approved" ? satisfyMandatoryCoverage(input.requirementsSnapshot) : [],
		uncoveredDimensions: [],
		antiAnchoringRationale: PIPELINE_ANTI_ANCHORING_RATIONALE,
		reviewRound: input.control?.reviewRound === 2 ? 2 : 1,
		authorResponses: [],
		triggerReason: null,
		routeSelectionReceiptRef: input.control?.routeSelectionReceiptRef ?? null,
		cleanContextReceiptRef: null,
		specEvidenceReceiptRef: null,
		authorityReceiptRef: null,
	};
	return PlanReviewArtifactV2Schema.parse(artifact);
}

/** Pipeline-only implementation review. Does not change legacy ReviewArtifactSchema. */
export function deriveReviewArtifact(input: DeriveGateReviewInput): ReviewArtifactV1 {
	assertPassHasNoOpenBlockers(input.gate.verdict, input.gate.findings);
	const decision = decisionFromVerdict(input.gate.verdict);
	const artifact: ReviewArtifactV1 = {
		schemaVersion: 1,
		workflowId: input.workflowId,
		attemptId: input.attemptId,
		stage: input.stage,
		createdAt: input.createdAt ?? new Date().toISOString(),
		modelProfileId: input.reviewer?.modelProfileId,
		provider: input.reviewer?.provider,
		model: input.reviewer?.model,
		kind: "review",
		subject: "implementation",
		decision,
		findings: input.gate.findings,
		explanation: input.gate.explanation,
		confidence: input.confidence ?? 0.5,
	};
	return ReviewArtifactSchema.parse(artifact);
}

export function stampGateResultArtifact(input: {
	gate: GateResultModel;
	workflowId: string;
	attemptId: string;
	createdAt?: string;
	reviewerIdentity?: { modelFamily?: string; provider?: string; model?: string };
}): GateResultArtifact {
	const verdict = input.gate.verdict === "PASS_WITH_NODE" ? "PASS_WITH_NOTES" : input.gate.verdict;
	return {
		schemaVersion: 1,
		kind: "gate-result",
		verdict,
		subject: input.gate.subject,
		findings: input.gate.findings,
		notes: input.gate.notes,
		explanation: input.gate.explanation,
		workflowId: input.workflowId,
		attemptId: input.attemptId,
		createdAt: input.createdAt ?? new Date().toISOString(),
		reviewerIdentity: input.reviewerIdentity,
	};
}
