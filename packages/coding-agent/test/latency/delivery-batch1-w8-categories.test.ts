/**
 * Batch 1 W8 offline L0 — representative category state transitions.
 * paired_evidence_ready remains false (no live paid pairs).
 */
import { describe, expect, it } from "bun:test";
import {
	BATCH1_PAIRED_EVIDENCE_READY,
	DELIVERY_TASK_CATEGORIES,
	DELIVERY_TASK_CATEGORY_IDS,
	deliveryTaskCategory,
} from "../../src/latency/delivery-task-categories";
import { buildDeliveryCostBaselineReport } from "../../src/latency/delivery-cost-baseline";
import {
	buildParentFinalVerificationDetails,
	PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
} from "../../src/latency/parent-final-verification";
import { parseSessionJsonl } from "../../src/latency/subagent-report";
import { buildAcceptanceContractRef } from "../../src/latency/task-episode";
import {
	buildChildDeliveryEvidenceFromExecutorFacts,
	reclassifyParentIntegrateAgainstWorkspace,
} from "../../src/task/child-delivery-evidence";
import {
	buildEvidenceHandoff,
	decideWorkerReuse,
	ensureEvidenceHandoffContext,
	markEvidenceStale,
} from "../../src/task/evidence-handoff";
import {
	getEvidenceHandoffObserveSnapshot,
	noteEvidenceHandoffInspect,
	noteEvidenceHandoffReuseDecision,
	resetEvidenceHandoffObserveForTests,
} from "../../src/task/evidence-handoff-observe";

const PARENT = "/tmp/sessions/w8/sess.jsonl";

function line(value: unknown): string {
	return JSON.stringify(value);
}

describe("W8 offline task categories (L0)", () => {
	it("registers all eight categories and marks paired evidence insufficient", () => {
		expect(DELIVERY_TASK_CATEGORY_IDS).toHaveLength(8);
		expect(DELIVERY_TASK_CATEGORIES.every(c => c.l0FixtureReady)).toBe(true);
		expect(BATCH1_PAIRED_EVIDENCE_READY).toBe(false);
		expect(deliveryTaskCategory("small_scope_query").id).toBe("small_scope_query");
	});

	it("small_scope_query: stop alone is not accepted", () => {
		const jsonl = [
			line({ type: "session", version: 3, id: "q", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp" }),
			line({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-09-26T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "what is X?" }], timestamp: 1 },
			}),
			line({
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-09-26T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "X is ..." }],
					timestamp: 2,
					model: "t/m",
					stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}),
		].join("\n");
		const cost = buildDeliveryCostBaselineReport([parseSessionJsonl(jsonl, PARENT)]);
		expect(cost.tasks[0]?.accepted).toBe(false);
	});

	it("diagnosed_local_fix: handoff generate→consume→reuse and stale spawn_fresh", () => {
		resetEvidenceHandoffObserveForTests();
		ensureEvidenceHandoffContext(undefined, {
			target: ["- a.ts"],
			acceptance: ["- fixed"],
		});
		noteEvidenceHandoffInspect("valid");
		const continueDecision = decideWorkerReuse({
			candidate: { id: "W", status: "idle" },
			handoff: buildEvidenceHandoff({
				goals: ["g"],
				acceptance: ["a"],
				changeScope: { paths: ["a.ts"] },
			}),
			correctionScope: { paths: ["a.ts"] },
		});
		noteEvidenceHandoffReuseDecision(continueDecision, { agentId: "W" });
		expect(getEvidenceHandoffObserveSnapshot().reuseContinue).toBe(1);

		const stale = markEvidenceStale(
			buildEvidenceHandoff({
				goals: ["g"],
				acceptance: ["a"],
				confirmedFacts: [{ id: "f1", version: "v1", statement: "tree" }],
			}),
			"f1",
			"moved",
		);
		const fresh = decideWorkerReuse({ candidate: { id: "W", status: "parked" }, handoff: stale });
		expect(fresh.action).toBe("spawn_fresh");
		resetEvidenceHandoffObserveForTests();
	});

	it("shared_interface: unreleased ownership blocks integrate", () => {
		const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "v1", changedFiles: ["iface.ts"] },
			acceptanceItems: [{ id: "contract", claimedProven: true, evidenceLocations: ["iface.ts"] }],
			sharedInterfaces: ["iface.ts"],
			writeOwnershipReleased: false,
		});
		const decision = reclassifyParentIntegrateAgainstWorkspace({
			delivery,
			currentCodeVersion: "v1",
			requiredAcceptance: ["contract"],
			writeOwnershipReleased: false,
		});
		expect(decision.action).toBe("parent_coordinate");
	});

	it("independent_review_known_defect: unmet acceptance is not accepted despite tool green", () => {
		const episode = { sessionId: "rev", rootUserEntryId: "u1" };
		const jsonl = [
			line({ type: "session", version: 3, id: "rev", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp" }),
			line({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-09-26T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "review" }], timestamp: 1 },
			}),
			line({
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-09-26T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "tests green" }],
					timestamp: 2,
					model: "t/m",
					stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } },
				},
			}),
			line({
				type: "custom",
				id: "v1",
				parentId: null,
				timestamp: "2026-09-26T10:00:02.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: buildParentFinalVerificationDetails("failed", "extension", 3, {
					eventId: "rev-fail",
					attempt: {
						episode,
						attemptId: "1",
						workflowId: null,
						branchLeafId: null,
						taskToolCallId: null,
						jobId: null,
						agentId: null,
					},
					acceptanceContract: buildAcceptanceContractRef(["known defect caught"])!,
					authority: "trusted_verifier",
				}),
			}),
		].join("\n");
		const cost = buildDeliveryCostBaselineReport([parseSessionJsonl(jsonl, PARENT)]);
		expect(cost.ordinary.acceptedTaskCount).toBe(0);
		expect(cost.tasks[0]?.accepted).toBe(false);
	});

	it("multi_episode_receipt_metrics: isolates episodes and keeps ratio null on missing price", () => {
		const epA = { sessionId: "m", rootUserEntryId: "ua" };
		const epB = { sessionId: "m", rootUserEntryId: "ub" };
		const jsonl = [
			line({ type: "session", version: 3, id: "m", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp" }),
			line({
				type: "custom",
				id: "va",
				parentId: null,
				timestamp: "2026-09-26T10:00:01.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: buildParentFinalVerificationDetails("passed", "extension", 2, {
					eventId: "a",
					attempt: {
						episode: epA,
						attemptId: "1",
						workflowId: null,
						branchLeafId: null,
						taskToolCallId: null,
						jobId: null,
						agentId: null,
					},
					authority: "trusted_verifier",
					acceptanceContract: buildAcceptanceContractRef(["A"])!,
				}),
			}),
			line({
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-09-26T10:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "priced" }],
					timestamp: 3,
					model: "t/m",
					stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
				},
			}),
			line({
				type: "message",
				id: "a2",
				parentId: null,
				timestamp: "2026-09-26T10:00:03.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "unpriced" }],
					timestamp: 4,
					model: "t/m",
					stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				},
			}),
			line({
				type: "custom",
				id: "vb",
				parentId: null,
				timestamp: "2026-09-26T10:00:04.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: buildParentFinalVerificationDetails("passed", "extension", 5, {
					eventId: "b",
					attempt: {
						episode: epB,
						attemptId: "2",
						workflowId: null,
						branchLeafId: null,
						taskToolCallId: null,
						jobId: null,
						agentId: null,
					},
					authority: "trusted_verifier",
					acceptanceContract: buildAcceptanceContractRef(["B"])!,
				}),
			}),
		].join("\n");
		const cost = buildDeliveryCostBaselineReport([parseSessionJsonl(jsonl, PARENT)]);
		expect(cost.ordinary.taskCount).toBe(2);
		expect(cost.ordinary.acceptedTaskCount).toBe(2);
		expect(cost.ordinary.costPerAcceptedTask).toBeNull();
		expect(cost.ordinary.totalAttemptCost).toBe(1);
	});
});
