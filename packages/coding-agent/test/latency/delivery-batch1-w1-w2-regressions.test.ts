/**
 * Batch 1 W1/W2 production-entrypoint regressions (review-fix lock-in).
 *
 * Failure modes if these regress:
 * - second task rebinds to first user message (episode boundary / attemptId)
 * - multi-episode costs wiped to null instead of episode-attributed
 * - abandoned-branch receipts pollute active-path cost/acceptance
 * - forged path-only proven without terminal integrates
 */
import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { freezeLatencyArmSnapshot } from "../../src/latency/arms";
import { buildDeliveryCostBaselineReport } from "../../src/latency/delivery-cost-baseline";
import {
	buildParentFinalVerificationDetails,
	PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
} from "../../src/latency/parent-final-verification";
import { parseSessionJsonl } from "../../src/latency/subagent-report";
import { buildAcceptanceContractRef, episodeKey } from "../../src/latency/task-episode";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import {
	buildChildDeliveryEvidenceFromExecutorFacts,
	reclassifyParentIntegrateAgainstWorkspace,
} from "../../src/task/child-delivery-evidence";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const PARENT = "/tmp/sessions/w1w2/sess.jsonl";

function line(value: unknown): string {
	return JSON.stringify(value);
}

function usage(total: number): Record<string, unknown> {
	return {
		input: 10,
		output: 5,
		cacheRead: 1,
		cacheWrite: 2,
		cost: { total, cacheWrite: 0.01 },
	};
}

describe("W1 production entrypoints — episode boundary + costs", () => {
	it("tryRecordTrusted opens a new episode after prior accept with distinct attemptId", () => {
		const manager = SessionManager.inMemory();
		const auth = createInMemoryAuthStorage();
		const model = createMockModel({ provider: "anthropic", responses: [{ content: ["ok"] }] });
		const agent = new Agent({
			initialState: { model, systemPrompt: [], tools: [], messages: [] },
			streamFn: model.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(auth),
			latencyArmSnapshot: freezeLatencyArmSnapshot({ frozenAt: "2026-09-26T00:00:00.000Z" }),
		});

		const u1 = manager.appendMessage({ role: "user", content: "task one", timestamp: 1_000 });
		const first = session.tryRecordTrustedParentFinalVerification({
			status: "passed",
			authority: "trusted_verifier",
			acceptanceItems: ["one done"],
			eventId: "attempt-task-1",
			codeState: { fingerprint: "code:1" },
		});
		expect(first.recorded).toBe(true);
		if (!first.recorded) throw new Error("expected first record");
		expect(first.details.attempt?.episode?.rootUserEntryId).toBe(u1);
		expect(first.details.attempt?.attemptId).toBe("attempt-task-1");

		const u2 = manager.appendMessage({ role: "user", content: "task two", timestamp: 2_000 });
		const second = session.tryRecordTrustedParentFinalVerification({
			status: "passed",
			authority: "trusted_verifier",
			acceptanceItems: ["two done"],
			eventId: "attempt-task-2",
			codeState: { fingerprint: "code:2" },
		});
		expect(second.recorded).toBe(true);
		if (!second.recorded) throw new Error("expected second record");
		expect(second.details.attempt?.episode?.rootUserEntryId).toBe(u2);
		expect(second.details.attempt?.attemptId).toBe("attempt-task-2");
		expect(second.details.attempt?.episode?.rootUserEntryId).not.toBe(u1);

		auth.close();
	});

	it("parseSessionJsonl + cost baseline keeps multi-episode costs attributed (not wiped)", () => {
		const epA = { sessionId: "s-cost", rootUserEntryId: "u-a" };
		const epB = { sessionId: "s-cost", rootUserEntryId: "u-b" };
		const jsonl = [
			line({ type: "session", version: 3, id: "s-cost", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp" }),
			line({
				type: "message",
				id: "u-a",
				parentId: null,
				timestamp: "2026-09-26T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "A" }], timestamp: 1_000 },
			}),
			line({
				type: "message",
				id: "a-a",
				parentId: null,
				timestamp: "2026-09-26T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "A" }],
					timestamp: 2_000,
					model: "test/m",
					stopReason: "stop",
					usage: usage(1.0),
				},
			}),
			line({
				type: "custom",
				id: "v-a",
				parentId: null,
				timestamp: "2026-09-26T10:00:02.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: buildParentFinalVerificationDetails("passed", "extension", 3_000, {
					eventId: "ep-a",
					attempt: {
						episode: epA,
						attemptId: "a1",
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
				id: "u-b",
				parentId: null,
				timestamp: "2026-09-26T10:00:03.000Z",
				message: { role: "user", content: [{ type: "text", text: "B" }], timestamp: 4_000 },
			}),
			line({
				type: "message",
				id: "a-b",
				parentId: null,
				timestamp: "2026-09-26T10:00:04.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "B" }],
					timestamp: 5_000,
					model: "test/m",
					stopReason: "stop",
					usage: usage(2.0),
				},
			}),
			line({
				type: "custom",
				id: "v-b",
				parentId: null,
				timestamp: "2026-09-26T10:00:05.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: buildParentFinalVerificationDetails("passed", "extension", 6_000, {
					eventId: "ep-b",
					attempt: {
						episode: epB,
						attemptId: "b1",
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

		const session = parseSessionJsonl(jsonl, PARENT);
		expect(session.usageRequests.map(r => r.episodeKey)).toEqual([episodeKey(epA), episodeKey(epB)]);
		const cost = buildDeliveryCostBaselineReport([session]);
		expect(cost.ordinary.acceptedTaskCount).toBe(2);
		expect(cost.tasks).toHaveLength(2);
		expect(cost.tasks.every(t => t.usage.costTotal !== null)).toBe(true);
		expect(cost.tasks.find(t => t.episodeKey === episodeKey(epA))?.usage.costTotal).toBe(1.0);
		expect(cost.tasks.find(t => t.episodeKey === episodeKey(epB))?.usage.costTotal).toBe(2.0);
		expect(cost.ordinary.totalAttemptCost).toBe(3.0);
		expect(cost.ordinary.costPerAcceptedTask).toBe(1.5);
	});

	it("abandoned-branch receipts are filtered out of active-path parse", () => {
		// Branch: root → user → (abandoned: assistant + forged accept) vs active: user2 + real accept
		const jsonl = [
			line({ type: "session", version: 3, id: "s-branch", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp" }),
			line({
				type: "message",
				id: "root",
				parentId: null,
				timestamp: "2026-09-26T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "start" }], timestamp: 1_000 },
			}),
			line({
				type: "message",
				id: "abandoned-asst",
				parentId: "root",
				timestamp: "2026-09-26T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "abandoned spend" }],
					timestamp: 2_000,
					model: "test/m",
					stopReason: "stop",
					usage: usage(9.9),
				},
			}),
			line({
				type: "custom",
				id: "abandoned-pass",
				parentId: "abandoned-asst",
				timestamp: "2026-09-26T10:00:02.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: buildParentFinalVerificationDetails("passed", "extension", 3_000, {
					eventId: "abandoned-event",
					attempt: {
						episode: { sessionId: "s-branch", rootUserEntryId: "root" },
						attemptId: "abandoned",
						workflowId: null,
						branchLeafId: "abandoned-pass",
						taskToolCallId: null,
						jobId: null,
						agentId: null,
					},
					authority: "trusted_verifier",
					acceptanceContract: buildAcceptanceContractRef(["abandoned"])!,
				}),
			}),
			line({
				type: "message",
				id: "active-user",
				parentId: "root",
				timestamp: "2026-09-26T10:00:03.000Z",
				message: { role: "user", content: [{ type: "text", text: "active task" }], timestamp: 4_000 },
			}),
			line({
				type: "message",
				id: "active-asst",
				parentId: "active-user",
				timestamp: "2026-09-26T10:00:04.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "active spend" }],
					timestamp: 5_000,
					model: "test/m",
					stopReason: "stop",
					usage: usage(1.25),
				},
			}),
			line({
				type: "custom",
				id: "active-pass",
				parentId: "active-asst",
				timestamp: "2026-09-26T10:00:05.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: buildParentFinalVerificationDetails("passed", "extension", 6_000, {
					eventId: "active-event",
					attempt: {
						episode: { sessionId: "s-branch", rootUserEntryId: "active-user" },
						attemptId: "active",
						workflowId: null,
						branchLeafId: "active-pass",
						taskToolCallId: null,
						jobId: null,
						agentId: null,
					},
					authority: "trusted_verifier",
					acceptanceContract: buildAcceptanceContractRef(["active"])!,
				}),
			}),
		].join("\n");

		const session = parseSessionJsonl(jsonl, PARENT);
		expect(session.parentFinalVerifications.map(v => v.eventId)).toEqual(["active-event"]);
		expect(session.usageRequests).toHaveLength(1);
		expect(session.usageRequests[0]?.costTotal).toBe(1.25);
		const cost = buildDeliveryCostBaselineReport([session]);
		expect(cost.ordinary.acceptedTaskCount).toBe(1);
		expect(cost.ordinary.totalAttemptCost).toBe(1.25);
		expect(cost.tasks.every(t => t.usage.costTotal !== 9.9)).toBe(true);
	});
});

describe("W2 production entrypoint — forged evidence", () => {
	it("reclassifyParentIntegrateAgainstWorkspace rejects forged proven without terminal", () => {
		const forged = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "ws-1", changedFiles: ["a.ts"] },
			acceptanceItems: [
				{
					id: "ok",
					claimedProven: true,
					evidenceLocations: ["does-not-exist.ts"],
				},
			],
			writeOwnershipReleased: true,
		});
		expect(forged.acceptanceProven[0]?.proven).toBe(false);
		const decision = reclassifyParentIntegrateAgainstWorkspace({
			delivery: forged,
			currentCodeVersion: "ws-1",
			requiredAcceptance: ["ok"],
			writeOwnershipReleased: true,
		});
		expect(decision.action).not.toBe("integrate");
		expect(decision.classification).toBe("missing_local_evidence");
	});
});
