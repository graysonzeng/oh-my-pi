import { describe, expect, it } from "bun:test";
import {
	buildAcceptanceCoverageMatrix,
	classifyChildIntegrateCoverage,
	classifyParentFinalCoverage,
	formatAcceptanceCoverageMatrix,
} from "../../src/latency/acceptance-coverage-matrix";
import type { ParentIntegrateDecision } from "../../src/task/child-delivery-evidence";
import type { ParentFinalVerificationObservation } from "../../src/latency/parent-final-verification";

describe("acceptance coverage matrix (D1)", () => {
	it("marks missing receipt as missing with no_parent_final_receipt — stop/exit alone is not accepted", () => {
		const cells = classifyParentFinalCoverage({ rowId: "sess-a", observation: null });
		expect(cells).toHaveLength(1);
		expect(cells[0]!.status).toBe("missing");
		expect(cells[0]!.reasons).toContain("no_parent_final_receipt");
		const matrix = buildAcceptanceCoverageMatrix(cells);
		expect(matrix.summary.missing).toBe(1);
		expect(matrix.summary.reasonCounts.no_parent_final_receipt).toBe(1);
		expect(formatAcceptanceCoverageMatrix(matrix)).toContain("no_parent_final_receipt");
	});

	it("does not treat candidate_complete as accepted", () => {
		const obs: ParentFinalVerificationObservation = {
			status: "passed",
			source: "workflow",
			ts: 1,
			v: 1,
			authority: "trusted_verifier",
			acceptanceContract: { items: ["item-1"] },
			codeState: { fingerprint: "abc" },
			evidenceRefs: ["check:1"],
			attempt: {
				episode: { sessionId: "s", rootUserEntryId: "u" },
				attemptId: "a1",
				workflowId: null,
				branchLeafId: null,
				taskToolCallId: null,
				jobId: null,
				agentId: null,
			},
		};
		const cells = classifyParentFinalCoverage({
			rowId: "sess-b",
			observation: obs,
			candidateComplete: true,
		});
		expect(cells[0]!.status).toBe("pending");
		expect(cells[0]!.reasons).toEqual(["candidate_not_user_confirmed"]);
	});

	it("excludes fixture authority from production coverage and lists the reason", () => {
		const obs: ParentFinalVerificationObservation = {
			status: "passed",
			source: "fixture",
			ts: 1,
			v: 1,
			authority: "fixture",
			acceptanceContract: { items: ["t"] },
			codeState: { fingerprint: "fp" },
			evidenceRefs: ["e"],
			attempt: {
				episode: { sessionId: "s", rootUserEntryId: "u" },
				attemptId: "a",
				workflowId: null,
				branchLeafId: null,
				taskToolCallId: null,
				jobId: null,
				agentId: null,
			},
		};
		const cells = classifyParentFinalCoverage({ rowId: "fix", observation: obs });
		expect(cells[0]!.status).toBe("excluded");
		expect(cells[0]!.reasons).toContain("fixture_authority_excluded");
	});

	it("marks v1 receipt without authority as incomplete, not covered", () => {
		const obs: ParentFinalVerificationObservation = {
			status: "passed",
			source: "session_stop",
			ts: 1,
			v: 1,
			acceptanceContract: { items: ["x"] },
		};
		const cells = classifyParentFinalCoverage({ rowId: "no-auth", observation: obs });
		expect(cells[0]!.status).toBe("incomplete");
		expect(cells[0]!.reasons).toContain("receipt_lacks_authority");
		expect(cells[0]!.reasons).toContain("code_state_missing");
	});

	it("keeps done_valid as pending parent integrate — not accepted", () => {
		const decision: ParentIntegrateDecision = {
			classification: "done_valid",
			action: "integrate",
			reasons: [],
			usedAuthorSelfAssessment: false,
		};
		const cell = classifyChildIntegrateCoverage({ rowId: "child-1", decision });
		expect(cell.status).toBe("pending");
		expect(cell.reasons).toContain("pending_parent_integrate");
	});

	it("flags stale code fingerprint against current workspace", () => {
		const obs: ParentFinalVerificationObservation = {
			status: "passed",
			source: "workflow",
			ts: 1,
			v: 1,
			authority: "workflow",
			acceptanceContract: { items: ["a"] },
			codeState: { fingerprint: "old" },
			evidenceRefs: ["r"],
			attempt: {
				episode: { sessionId: "s", rootUserEntryId: "u" },
				attemptId: "a",
				workflowId: "w",
				branchLeafId: null,
				taskToolCallId: null,
				jobId: null,
				agentId: null,
			},
		};
		const cells = classifyParentFinalCoverage({
			rowId: "stale",
			observation: obs,
			currentCodeFingerprint: "new",
		});
		expect(cells[0]!.reasons).toContain("stale_or_scope_unknown");
		expect(cells[0]!.status).not.toBe("covered");
	});
});
