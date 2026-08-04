/**
 * Engine-owned author-response validation and max_cycles_author_reject gate.
 *
 * Author responses are produced during replan (planner), not fabricated from the
 * prior review. Second changes_requested only escalates to arbitration when a
 * rejected P0/P1 finding carries non-empty evidence refs.
 */

import type { AuthorResponseV1, ReviewFindingV1 } from "./types";

export const AUTHOR_RESPONSES_KIND = "author_responses" as const;
export const AUTHOR_RESPONSES_VERSION = 1 as const;

export interface AuthorResponsesPriorFindingV1 {
	id: string;
	priority: ReviewFindingV1["priority"];
	status: ReviewFindingV1["status"];
}

export interface AuthorResponsesArtifactV1 {
	schemaVersion: typeof AUTHOR_RESPONSES_VERSION;
	kind: typeof AUTHOR_RESPONSES_KIND;
	workflowId: string;
	attemptId: string;
	createdAt: string;
	priorReviewArtifactRef: string | null;
	priorFindings: AuthorResponsesPriorFindingV1[];
	responses: AuthorResponseV1[];
}

export interface AuthorResponsesValidationResult {
	ok: boolean;
	reason?: string;
	responses: AuthorResponseV1[];
}

function normalizeEvidenceRefs(refs: string[] | undefined): string[] {
	if (!Array.isArray(refs)) return [];
	return refs.map(ref => (typeof ref === "string" ? ref.trim() : "")).filter(Boolean);
}

function normalizeResponse(raw: AuthorResponseV1): AuthorResponseV1 | null {
	if (!raw || typeof raw !== "object") return null;
	const findingId = typeof raw.findingId === "string" ? raw.findingId.trim() : "";
	const disposition = raw.disposition;
	const explanation = typeof raw.explanation === "string" ? raw.explanation.trim() : "";
	if (!findingId || !explanation) return null;
	if (disposition !== "accepted" && disposition !== "rejected" && disposition !== "clarified") {
		return null;
	}
	return {
		findingId,
		disposition,
		explanation,
		evidenceRefs: normalizeEvidenceRefs(raw.evidenceRefs),
	};
}

/**
 * Validate planner-emitted author responses against the prior plan-review findings.
 * Replan with open findings must respond to every open P0/P1 finding; rejected
 * dispositions require non-empty evidence refs for arbitration eligibility.
 */
export function validateAuthorResponses(
	rawResponses: readonly AuthorResponseV1[] | undefined,
	priorFindings: readonly ReviewFindingV1[],
): AuthorResponsesValidationResult {
	const responses = (rawResponses ?? [])
		.map(normalizeResponse)
		.filter((response): response is AuthorResponseV1 => response !== null);

	const findingById = new Map(priorFindings.map(finding => [finding.id, finding]));
	const openP0P1 = priorFindings.filter(
		finding =>
			(finding.priority === "P0" || finding.priority === "P1") &&
			(finding.status === "open" || finding.status === "in_progress"),
	);

	if (priorFindings.length === 0) {
		return { ok: true, responses };
	}

	if (responses.length === 0) {
		return { ok: false, reason: "author_responses_required_on_replan", responses: [] };
	}

	const seen = new Set<string>();
	for (const response of responses) {
		if (seen.has(response.findingId)) {
			return { ok: false, reason: `author_response_duplicate_finding:${response.findingId}`, responses };
		}
		seen.add(response.findingId);
		if (!findingById.has(response.findingId)) {
			return { ok: false, reason: `author_response_unknown_finding:${response.findingId}`, responses };
		}
		if (response.disposition === "rejected" && response.evidenceRefs.length === 0) {
			return { ok: false, reason: `author_reject_requires_evidence:${response.findingId}`, responses };
		}
	}

	for (const finding of openP0P1) {
		if (!seen.has(finding.id)) {
			return { ok: false, reason: `author_response_missing_p0p1:${finding.id}`, responses };
		}
	}

	return { ok: true, responses };
}

/**
 * True when author responses reject at least one prior P0/P1 finding with evidence.
 * Used only after the second changes_requested reaches maxPlanCycles.
 */
export function hasMaxCyclesAuthorReject(
	responses: readonly AuthorResponseV1[],
	priorFindings: readonly Pick<ReviewFindingV1, "id" | "priority">[],
): boolean {
	const p0p1Ids = new Set(
		priorFindings.filter(finding => finding.priority === "P0" || finding.priority === "P1").map(finding => finding.id),
	);
	return responses.some(
		response =>
			response.disposition === "rejected" &&
			p0p1Ids.has(response.findingId) &&
			response.evidenceRefs.some(ref => ref.trim().length > 0) &&
			response.explanation.trim().length > 0,
	);
}

export function buildAuthorResponsesArtifact(input: {
	workflowId: string;
	attemptId: string;
	priorReviewArtifactRef: string | null;
	priorFindings: readonly ReviewFindingV1[];
	responses: readonly AuthorResponseV1[];
	createdAt?: string;
}): AuthorResponsesArtifactV1 {
	return {
		schemaVersion: AUTHOR_RESPONSES_VERSION,
		kind: AUTHOR_RESPONSES_KIND,
		workflowId: input.workflowId,
		attemptId: input.attemptId,
		createdAt: input.createdAt ?? new Date().toISOString(),
		priorReviewArtifactRef: input.priorReviewArtifactRef,
		priorFindings: input.priorFindings.map(finding => ({
			id: finding.id,
			priority: finding.priority,
			status: finding.status,
		})),
		responses: input.responses.map(response => ({
			findingId: response.findingId,
			disposition: response.disposition,
			explanation: response.explanation,
			evidenceRefs: [...response.evidenceRefs],
		})),
	};
}

export function isAuthorResponsesArtifact(value: unknown): value is AuthorResponsesArtifactV1 {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<AuthorResponsesArtifactV1>;
	return (
		candidate.kind === AUTHOR_RESPONSES_KIND &&
		candidate.schemaVersion === AUTHOR_RESPONSES_VERSION &&
		Array.isArray(candidate.responses) &&
		Array.isArray(candidate.priorFindings)
	);
}
