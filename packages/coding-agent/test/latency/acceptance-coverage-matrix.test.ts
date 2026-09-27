import { describe, expect, it } from "bun:test";
import {
	buildAcceptanceCoverageMatrix,
	classifyChildIntegrateCoverage,
	classifyParentFinalCoverage,
	formatAcceptanceCoverageMatrix,
} from "../../src/latency/acceptance-coverage-matrix";
import { buildSubagentBaselineReport, parseSessionJsonl } from "../../src/latency/subagent-report";
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

	it("marks v1 receipt without authority as incomplete via missing_authority, not covered", () => {
		const obs: ParentFinalVerificationObservation = {
			status: "passed",
			source: "session_stop",
			ts: 1,
			v: 1,
			acceptanceContract: { items: ["x"] },
		};
		const cells = classifyParentFinalCoverage({ rowId: "no-auth", observation: obs });
		expect(cells[0]!.status).toBe("incomplete");
		expect(cells[0]!.reasons).toContain("missing_authority");
		expect(cells[0]!.reasons).toContain("code_state_missing");
		expect(cells[0]!.status).not.toBe("covered");
	});

	it("never covers legacy pre-v1 receipts (authority+v absent) — legacy_compat", () => {
		const obs: ParentFinalVerificationObservation = {
			status: "passed",
			source: "session_stop",
			ts: 1,
			acceptanceContract: { items: ["legacy-item"] },
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
		const cells = classifyParentFinalCoverage({ rowId: "legacy", observation: obs });
		expect(cells[0]!.status).toBe("incomplete");
		expect(cells[0]!.reasons).toContain("legacy_compat");
		expect(cells[0]!.status).not.toBe("covered");
	});

	it("does not force code fingerprint on review/manual-only criteria", () => {
		const obs: ParentFinalVerificationObservation = {
			status: "passed",
			source: "workflow",
			ts: 1,
			v: 1,
			authority: "workflow",
			acceptanceContract: {
				items: ["doc-review", "manual-signoff"],
				criteria: [
					{
						criterionId: "doc-review",
						description: "Review docs",
						verification: "review",
						evidenceRefs: ["review:1"],
					},
					{
						criterionId: "manual-signoff",
						description: "Human sign-off",
						verification: "manual",
						evidenceRefs: ["human:1"],
					},
				],
			},
			evidenceRefs: ["review:1", "human:1"],
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
		const cells = classifyParentFinalCoverage({ rowId: "review-only", observation: obs });
		expect(cells).toHaveLength(2);
		for (const cell of cells) {
			expect(cell.reasons).not.toContain("code_state_missing");
			expect(cell.status).toBe("covered");
		}
	});

	it("still requires code fingerprint for command-check criteria", () => {
		const obs: ParentFinalVerificationObservation = {
			status: "passed",
			source: "workflow",
			ts: 1,
			v: 1,
			authority: "trusted_verifier",
			acceptanceContract: {
				items: ["tests"],
				criteria: [
					{
						criterionId: "tests",
						description: "Run tests",
						verification: "command-check",
						evidenceRefs: ["bun test"],
					},
				],
			},
			evidenceRefs: ["bun test"],
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
		const cells = classifyParentFinalCoverage({ rowId: "cmd", observation: obs });
		expect(cells[0]!.reasons).toContain("code_state_missing");
		expect(cells[0]!.status).not.toBe("covered");
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

describe("acceptance coverage matrix wiring (D1 behavioral)", () => {
	function line(value: unknown): string {
		return JSON.stringify(value);
	}

	function pfv(opts: {
		eventId: string;
		sessionId: string;
		rootUserEntryId: string;
		attemptId: string;
		ts: number;
	}): unknown {
		return {
			type: "custom",
			id: `pfv-${opts.eventId}`,
			parentId: null,
			timestamp: "2026-09-09T10:00:00.000Z",
			customType: "parent_final_verification",
			data: {
				v: 1,
				status: "passed",
				source: "workflow",
				authority: "workflow",
				eventId: opts.eventId,
				verifiedAtMs: opts.ts,
				acceptanceContract: { items: ["item"] },
				codeState: { fingerprint: "fp" },
				evidenceRefs: ["e"],
				attempt: {
					episode: { sessionId: opts.sessionId, rootUserEntryId: opts.rootUserEntryId },
					attemptId: opts.attemptId,
					workflowId: null,
					branchLeafId: null,
					taskToolCallId: null,
					jobId: null,
					agentId: null,
				},
			},
		};
	}

	it("builds a coverage cell for every parent-final receipt by episode/attempt — never only the last", () => {
		const path = "/tmp/sessions/cov/parent.jsonl";
		const session = parseSessionJsonl(
			[
				{ type: "session", version: 3, id: "sess-cov", timestamp: "2026-09-09T10:00:00.000Z", cwd: "/tmp" },
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
				},
				pfv({
					eventId: "e1",
					sessionId: "sess-cov",
					rootUserEntryId: "u1",
					attemptId: "att-1",
					ts: 10,
				}),
				pfv({
					eventId: "e2",
					sessionId: "sess-cov",
					rootUserEntryId: "u1",
					attemptId: "att-2",
					ts: 20,
				}),
			]
				.map(line)
				.join("\n"),
			path,
		);
		expect(session.parentFinalVerifications).toHaveLength(2);
		const report = buildSubagentBaselineReport([session]);
		const attemptRows = report.acceptanceCoverage.cells.filter(c => c.itemId === "item");
		expect(attemptRows.length).toBeGreaterThanOrEqual(2);
		expect(attemptRows.some(c => c.rowId.includes("att-1"))).toBe(true);
		expect(attemptRows.some(c => c.rowId.includes("att-2"))).toBe(true);
	});

	it("wires candidateComplete from mode_change goal candidate facts", () => {
		const path = "/tmp/sessions/cov/candidate.jsonl";
		const session = parseSessionJsonl(
			[
				{ type: "session", version: 3, id: "sess-cand", timestamp: "2026-09-09T10:00:00.000Z", cwd: "/tmp" },
				{
					type: "mode_change",
					id: "m1",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					mode: "goal",
					data: {
						goal: {
							id: "g1",
							objective: "Ship",
							status: "active",
							tokensUsed: 0,
							timeUsedSeconds: 0,
							createdAt: 1,
							updatedAt: 1,
							hostGate: {
								goalRevision: 1,
								pendingVerification: false,
								consecutiveContinueCount: 0,
								lastDecision: "candidate_complete",
							},
						},
					},
				},
			]
				.map(line)
				.join("\n"),
			path,
		);
		expect(session.goalCandidateComplete).toBe(true);
		const report = buildSubagentBaselineReport([session]);
		expect(report.acceptanceCoverage.cells.some(c => c.reasons.includes("candidate_not_user_confirmed"))).toBe(
			true,
		);
	});

	it("classifies child integrate coverage from parent_integrate_decision delivery evidence", () => {
		const path = "/tmp/sessions/cov/integrate.jsonl";
		const session = parseSessionJsonl(
			[
				{ type: "session", version: 3, id: "sess-int", timestamp: "2026-09-09T10:00:00.000Z", cwd: "/tmp" },
				{
					type: "custom",
					id: "pi1",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					customType: "parent_integrate_decision",
					data: {
						kind: "parent_integrate_decision",
						v: 1,
						classification: "done_valid",
						action: "integrate",
						reasons: ["delivery_evidence_valid"],
						usedAuthorSelfAssessment: false,
						episode: { sessionId: "sess-int", rootUserEntryId: "u1" },
						taskToolCallId: "call-1",
						jobId: null,
						agentId: "worker-1",
						workspaceVersion: "v1",
						recordedAtMs: 1,
						finalAccepted: false,
					},
				},
			]
				.map(line)
				.join("\n"),
			path,
		);
		expect(session.parentIntegrateDecisions).toHaveLength(1);
		const report = buildSubagentBaselineReport([session]);
		const childCell = report.acceptanceCoverage.cells.find(c => c.reasons.includes("pending_parent_integrate"));
		expect(childCell).toBeDefined();
		expect(childCell!.status).toBe("pending");
	});
});
