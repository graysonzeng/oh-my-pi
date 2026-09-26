/**
 * Batch 1 W1 behavior contracts: ordinary acceptance + episode cost attribution.
 *
 * Failure modes if these regress:
 * - stop / tool-green without acceptance looks accepted
 * - fail→repair→pass splits into multiple accepted episodes or drops repair cost
 * - same-session tasks / ordinary+workflow mix denominators
 * - fork/dup receipts double-bill
 * - missing price zero-fills into a fake ratio
 * - write failure still mints green
 */
import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { freezeLatencyArmSnapshot } from "../../src/latency/arms";
import { buildDeliveryCostBaselineReport } from "../../src/latency/delivery-cost-baseline";
import {
	buildParentFinalVerificationDetails,
	canRecordTrustedParentFinal,
	PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
} from "../../src/latency/parent-final-verification";
import { buildRuntimeBuildIdentity, runtimeBuildIdentityRef } from "../../src/latency/runtime-build-identity";
import { parseSessionJsonl } from "../../src/latency/subagent-report";
import { buildAcceptanceContractRef, episodeKey } from "../../src/latency/task-episode";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const PARENT = "/tmp/sessions/w1/sess.jsonl";

function line(value: unknown): string {
	return JSON.stringify(value);
}

function usage(total: number | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		input: 10,
		output: 5,
		cacheRead: 1,
		cacheWrite: 2,
		cost: total === null ? { input: 0.1, output: 0.05, cacheRead: 0, cacheWrite: 0 } : { total, cacheWrite: 0.01 },
		...extra,
	};
}

describe("W1 ordinary acceptance gate", () => {
	it("rejects stop / tool-green shaped authorities without acceptance criteria", () => {
		expect(
			canRecordTrustedParentFinal({
				acceptanceItems: [],
				authority: "trusted_verifier",
				status: "passed",
			}),
		).toEqual({ ok: false, reason: "missing_acceptance_criteria" });
		expect(
			canRecordTrustedParentFinal({
				acceptanceItems: ["tests pass"],
				authority: undefined,
				status: "passed",
			}),
		).toEqual({ ok: false, reason: "missing_acceptance_authority" });
	});

	it("does not record on session without acceptance; records trusted sink with episode linkage", async () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage({
			role: "user",
			content: "fix the bug",
			timestamp: 1_000,
		});
		using tempDir = TempDir.createSync("@omp-w1-accept-");
		const auth = createInMemoryAuthStorage();
		try {
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

			const blocked = session.tryRecordTrustedParentFinalVerification({
				status: "passed",
				authority: "trusted_verifier",
				acceptanceItems: [],
			});
			expect(blocked).toEqual({ recorded: false, reason: "missing_acceptance_criteria" });
			expect(
				manager
					.getBranch()
					.filter(e => e.type === "custom" && e.customType === PARENT_FINAL_VERIFICATION_MESSAGE_TYPE),
			).toHaveLength(0);

			const identity = buildRuntimeBuildIdentity({
				runMode: "source",
				sourceSha: "b6c485a543f91fbf84b922d7f7bd9be4ff127df4",
				dirty: false,
			});
			const ok = session.tryRecordTrustedParentFinalVerification({
				status: "passed",
				authority: "trusted_verifier",
				acceptanceItems: ["regression covered"],
				codeState: { fingerprint: "code:1" },
				eventId: "ep1-attempt1",
				buildIdentity: identity,
				persistBuildIdentity: true,
			});
			expect(ok.recorded).toBe(true);
			if (!ok.recorded) throw new Error("expected record");
			expect(ok.details.attempt?.episode?.rootUserEntryId).toBe(userId);
			expect(ok.details.acceptanceContract?.items).toEqual(["regression covered"]);
			expect(ok.details.authority).toBe("trusted_verifier");
			expect(ok.details.buildIdentityRef).toBe(runtimeBuildIdentityRef(identity));
			expect(ok.details.v).toBe(1);

			const customs = manager
				.getBranch()
				.filter(e => e.type === "custom")
				.map(e => (e.type === "custom" ? e.customType : ""));
			expect(customs).toContain(PARENT_FINAL_VERIFICATION_MESSAGE_TYPE);
			expect(customs).toContain("runtime_build_identity");
			// Metadata must not use custom_message (model context).
			expect(
				manager
					.getBranch()
					.some(e => e.type === "custom_message" && e.customType === PARENT_FINAL_VERIFICATION_MESSAGE_TYPE),
			).toBe(false);

			await session.dispose();
		} finally {
			auth.close();
		}
		void tempDir;
	});

	it("propagates write failure instead of minting green", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "user",
			content: "task",
			timestamp: 1,
		});
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
		const original = manager.appendCustomEntry.bind(manager);
		manager.appendCustomEntry = (() => {
			throw new Error("disk full");
		}) as SessionManager["appendCustomEntry"];
		expect(() =>
			session.tryRecordTrustedParentFinalVerification({
				status: "passed",
				authority: "trusted_verifier",
				acceptanceItems: ["ok"],
			}),
		).toThrow(/disk full/);
		manager.appendCustomEntry = original;
		expect(
			manager
				.getBranch()
				.filter(e => e.type === "custom" && e.customType === PARENT_FINAL_VERIFICATION_MESSAGE_TYPE),
		).toHaveLength(0);
		auth.close();
	});
});

describe("W1 episode cost attribution", () => {
	it("keeps stop-without-receipt and tools-green-unmet as not accepted", () => {
		const jsonl = [
			line({ type: "session", version: 3, id: "s1", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp" }),
			line({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-09-26T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "do" }], timestamp: 1_000 },
			}),
			line({
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-09-26T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					timestamp: 2_000,
					model: "test/m",
					stopReason: "stop",
					usage: usage(0.2),
				},
			}),
		].join("\n");
		const session = parseSessionJsonl(jsonl, PARENT);
		const cost = buildDeliveryCostBaselineReport([session]);
		expect(cost.unknownCohort.acceptedTaskCount).toBe(0);
		expect(cost.ordinary.acceptedTaskCount).toBe(0);
		expect(cost.tasks[0]?.accepted).toBe(false);
	});

	it("fail→repair→pass is one accepted episode retaining all attempt costs", () => {
		const episode = { sessionId: "s-repair", rootUserEntryId: "u1" };
		const jsonl = [
			line({ type: "session", version: 3, id: "s-repair", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp" }),
			line({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-09-26T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "fix" }], timestamp: 1_000 },
			}),
			line({
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-09-26T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "try1" }],
					timestamp: 2_000,
					model: "test/m",
					stopReason: "stop",
					usage: usage(1.0),
				},
			}),
			line({
				type: "custom",
				id: "v-fail",
				parentId: null,
				timestamp: "2026-09-26T10:00:02.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: buildParentFinalVerificationDetails("failed", "extension", 3_000, {
					eventId: "attempt-1",
					attempt: {
						episode,
						attemptId: "attempt-1",
						workflowId: null,
						branchLeafId: null,
						taskToolCallId: null,
						jobId: null,
						agentId: null,
					},
					acceptanceContract: buildAcceptanceContractRef(["fixed"])!,
					authority: "trusted_verifier",
				}),
			}),
			line({
				type: "message",
				id: "a2",
				parentId: null,
				timestamp: "2026-09-26T10:00:03.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "repair" }],
					timestamp: 4_000,
					model: "test/m",
					stopReason: "stop",
					usage: usage(2.0),
				},
			}),
			line({
				type: "custom",
				id: "v-pass",
				parentId: null,
				timestamp: "2026-09-26T10:00:04.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: buildParentFinalVerificationDetails("passed", "extension", 5_000, {
					eventId: "attempt-2",
					attempt: {
						episode,
						attemptId: "attempt-2",
						workflowId: null,
						branchLeafId: null,
						taskToolCallId: null,
						jobId: null,
						agentId: null,
					},
					acceptanceContract: buildAcceptanceContractRef(["fixed"])!,
					authority: "trusted_verifier",
				}),
			}),
		].join("\n");
		const session = parseSessionJsonl(jsonl, PARENT);
		const cost = buildDeliveryCostBaselineReport([session]);
		expect(cost.ordinary.acceptedTaskCount).toBe(1);
		expect(cost.ordinary.taskCount).toBe(1);
		expect(cost.tasks[0]?.episodeKey).toBe(episodeKey(episode));
		expect(cost.tasks[0]?.attemptIds.sort()).toEqual(["attempt-1", "attempt-2"]);
		expect(cost.tasks[0]?.usage.costTotal).toBe(3.0);
		expect(cost.tasks[0]?.usage.cacheWrite).toBe(4);
		expect(cost.ordinary.costPerAcceptedTask).toBe(3.0);
	});

	it("isolates two episodes in the same session and does not mix ordinary/workflow denominators", () => {
		const epA = { sessionId: "s-multi", rootUserEntryId: "u-a" };
		const epB = { sessionId: "s-multi", rootUserEntryId: "u-b" };
		const jsonl = [
			line({ type: "session", version: 3, id: "s-multi", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp" }),
			line({
				type: "message",
				id: "u-a",
				parentId: null,
				timestamp: "2026-09-26T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "task A" }], timestamp: 1_000 },
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
					usage: usage(1.5),
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
				message: { role: "user", content: [{ type: "text", text: "task B" }], timestamp: 4_000 },
			}),
			line({
				type: "custom",
				id: "v-b",
				parentId: null,
				timestamp: "2026-09-26T10:00:04.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: buildParentFinalVerificationDetails("passed", "workflow", 5_000, {
					eventId: "ep-b",
					attempt: {
						episode: epB,
						attemptId: "wf-1",
						workflowId: "wf-1",
						branchLeafId: null,
						taskToolCallId: null,
						jobId: null,
						agentId: null,
					},
					authority: "workflow",
					acceptanceContract: buildAcceptanceContractRef(["B"])!,
				}),
			}),
		].join("\n");
		const session = parseSessionJsonl(jsonl, PARENT);
		const cost = buildDeliveryCostBaselineReport([session]);
		expect(cost.tasks).toHaveLength(2);
		expect(cost.ordinary.acceptedTaskCount).toBe(1);
		expect(cost.workflow.acceptedTaskCount).toBe(1);
		expect(cost.ordinary.taskCount + cost.workflow.taskCount).toBe(2);
		// Without per-request episode tags, do not dump all spend onto epA —
		// every unsplit group is cost-incomplete so ratios stay null.
		expect(cost.ordinary.totalAttemptCost).toBeNull();
		expect(cost.ordinary.costPerAcceptedTask).toBeNull();
		expect(cost.workflow.costPerAcceptedTask).toBeNull();
		expect(cost.tasks.every(t => t.attemptCostComplete === false)).toBe(true);
		expect(cost.tasks.every(t => t.usage.costTotal === null)).toBe(true);
	});

	it("dedupes fork/dup receipts by eventId and keeps partial sum when price missing", () => {
		const episode = { sessionId: "s-dup", rootUserEntryId: "u1" };
		const details = buildParentFinalVerificationDetails("passed", "extension", 5_000, {
			eventId: "same-event",
			attempt: {
				episode,
				attemptId: "a1",
				workflowId: null,
				branchLeafId: null,
				taskToolCallId: null,
				jobId: null,
				agentId: null,
			},
			authority: "trusted_verifier",
			acceptanceContract: buildAcceptanceContractRef(["ok"])!,
		});
		const jsonl = [
			line({ type: "session", version: 3, id: "s-dup", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp" }),
			line({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-09-26T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "x" }], timestamp: 1_000 },
			}),
			line({
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-09-26T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "priced" }],
					timestamp: 2_000,
					model: "test/m",
					stopReason: "stop",
					usage: usage(0.5),
				},
			}),
			line({
				type: "message",
				id: "a2",
				parentId: null,
				timestamp: "2026-09-26T10:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "missing price" }],
					timestamp: 3_000,
					model: "test/m",
					stopReason: "stop",
					usage: usage(null),
				},
			}),
			line({
				type: "message",
				id: "a3",
				parentId: null,
				timestamp: "2026-09-26T10:00:02.500Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "err" }],
					timestamp: 3_500,
					model: "test/m",
					stopReason: "error",
					isError: true,
					usage: usage(0),
				},
			}),
			line({
				type: "custom",
				id: "v1",
				parentId: null,
				timestamp: "2026-09-26T10:00:03.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: details,
			}),
			line({
				type: "custom",
				id: "v1-dup",
				parentId: null,
				timestamp: "2026-09-26T10:00:04.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: details,
			}),
		].join("\n");
		const session = parseSessionJsonl(jsonl, PARENT);
		expect(session.parentFinalVerifications).toHaveLength(1);
		const cost = buildDeliveryCostBaselineReport([session]);
		expect(cost.ordinary.acceptedTaskCount).toBe(1);
		expect(cost.tasks[0]?.usage.costTotal).toBe(0.5);
		expect(cost.tasks[0]?.attemptCostComplete).toBe(false);
		expect(cost.tasks[0]?.priceProvenance).toBe("partial");
		expect(cost.tasks[0]?.zeroCostErrorRequests).toBe(1);
		expect(cost.ordinary.costPerAcceptedTask).toBeNull();
		expect(cost.ordinary.totalAttemptCost).toBe(0.5);
	});

	it("does not count v1 passed receipts without authority as accepted", () => {
		// buildParentFinalVerificationDetails always stamps v:1 — without authority
		// this must not mint accepted (forged / session_stop shaped payloads).
		const details = buildParentFinalVerificationDetails("passed", "session_stop", 5_000);
		expect(details.v).toBe(1);
		expect(details.authority).toBeUndefined();
		const jsonl = [
			line({ type: "session", version: 3, id: "s-ungated", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp" }),
			line({
				type: "custom",
				id: "v1",
				parentId: null,
				timestamp: "2026-09-26T10:00:01.000Z",
				customType: PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
				data: details,
			}),
		].join("\n");
		const cost = buildDeliveryCostBaselineReport([parseSessionJsonl(jsonl, PARENT)]);
		expect(cost.ordinary.acceptedTaskCount).toBe(0);
		expect(cost.tasks[0]?.accepted).toBe(false);
		expect(cost.tasks[0]?.firstDeliveryAccepted).toBe("unknown");
	});
});
