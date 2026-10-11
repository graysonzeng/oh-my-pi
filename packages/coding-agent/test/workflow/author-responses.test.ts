import { describe, expect, it } from "bun:test";
import {
	buildAuthorResponsesArtifact,
	hasMaxCyclesAuthorReject,
	validateAuthorResponses,
} from "../../src/workflow/author-responses";
import type { AuthorResponseV1, ReviewFindingV1 } from "../../src/workflow/types";

const p0: ReviewFindingV1 = {
	id: "f-p0",
	priority: "P0",
	category: "correctness",
	status: "open",
	confidence: 0.95,
	summary: "missing auth",
	explanation: "plan omits auth",
	suggestedOwner: "implementer",
};

const p1: ReviewFindingV1 = {
	id: "f-p1",
	priority: "P1",
	category: "architecture",
	status: "open",
	confidence: 0.9,
	summary: "no rollback",
	explanation: "rollback missing",
	suggestedOwner: "implementer",
};

const p2: ReviewFindingV1 = {
	id: "f-p2",
	priority: "P2",
	category: "maintainability",
	status: "open",
	confidence: 0.7,
	summary: "style",
	explanation: "nit",
	suggestedOwner: "implementer",
};

function accepted(findingId: string): AuthorResponseV1 {
	return {
		findingId,
		disposition: "accepted",
		explanation: `will address ${findingId}`,
		evidenceRefs: [],
	};
}

function rejected(findingId: string, evidenceRefs: string[] = ["plan:step-1"]): AuthorResponseV1 {
	return {
		findingId,
		disposition: "rejected",
		explanation: `disagree with ${findingId}`,
		evidenceRefs,
	};
}

describe("validateAuthorResponses", () => {
	it("allows empty responses when there are no prior findings", () => {
		expect(validateAuthorResponses([], [])).toEqual({ ok: true, responses: [] });
	});

	it("requires responses when prior findings exist", () => {
		const result = validateAuthorResponses([], [p0]);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("author_responses_required_on_replan");
	});

	it("requires every open P0/P1 finding to be answered", () => {
		const result = validateAuthorResponses([accepted("f-p0")], [p0, p1, p2]);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("author_response_missing_p0p1:f-p1");
	});

	it("rejects unknown finding ids and empty reject evidence", () => {
		expect(validateAuthorResponses([accepted("f-missing")], [p0]).reason).toBe(
			"author_response_unknown_finding:f-missing",
		);
		expect(validateAuthorResponses([rejected("f-p0", [])], [p0]).reason).toBe("author_reject_requires_evidence:f-p0");
	});

	it("accepts complete P0/P1 coverage including rejected evidence", () => {
		const result = validateAuthorResponses([accepted("f-p0"), rejected("f-p1")], [p0, p1, p2]);
		expect(result.ok).toBe(true);
		expect(result.responses).toHaveLength(2);
	});
});

describe("hasMaxCyclesAuthorReject", () => {
	it("requires rejected P0/P1 with non-empty evidence", () => {
		expect(hasMaxCyclesAuthorReject([accepted("f-p0")], [p0])).toBe(false);
		expect(hasMaxCyclesAuthorReject([rejected("f-p0", [])], [p0])).toBe(false);
		expect(hasMaxCyclesAuthorReject([rejected("f-p2")], [p2])).toBe(false);
		expect(hasMaxCyclesAuthorReject([rejected("f-p0")], [p0])).toBe(true);
	});
});

describe("buildAuthorResponsesArtifact", () => {
	it("persists prior finding priorities with responses", () => {
		const artifact = buildAuthorResponsesArtifact({
			workflowId: "wf",
			attemptId: "att",
			priorReviewArtifactRef: "review-1",
			priorFindings: [p0, p1],
			responses: [rejected("f-p0"), accepted("f-p1")],
			createdAt: "2026-08-04T00:00:00.000Z",
		});
		expect(artifact).toMatchObject({
			kind: "author_responses",
			schemaVersion: 1,
			priorReviewArtifactRef: "review-1",
			priorFindings: [
				{ id: "f-p0", priority: "P0", status: "open" },
				{ id: "f-p1", priority: "P1", status: "open" },
			],
			responses: [rejected("f-p0"), accepted("f-p1")],
		});
	});
});
