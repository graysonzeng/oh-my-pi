import { describe, expect, it } from "bun:test";
import {
	buildChildDeliveryEvidenceFromExecutorFacts,
	PARENT_INTEGRATE_DECISION_CUSTOM_TYPE,
} from "../../src/task/child-delivery-evidence";
import { consumeChildDeliveryForParent, settleChildDeliveryForParent } from "../../src/task/parent-delivery-consume";

function sink() {
	const entries: Array<{ type: string; details: unknown }> = [];
	return {
		entries,
		appendCustomEntry(type: string, details: unknown) {
			entries.push({ type, details });
			return `id-${entries.length}`;
		},
		getSessionId: () => "sess-1",
		getBranch: () => [{ id: "u1", type: "message", message: { role: "user" } }],
		getEntries: () =>
			entries.map((entry, index) => ({
				id: `id-${index + 1}`,
				type: "custom",
				customType: entry.type,
				data: entry.details,
			})),
	};
}

describe("shared parent settle path (R2/B4)", () => {
	it("task-shaped and workpool-shaped settle calls produce the same classification", async () => {
		const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "content:abc", changedFiles: ["a.ts"] },
			acceptanceItems: [{ id: "ok", claimedProven: false }],
			checksNotRun: [{ id: "parent_acceptance", reason: "parent owns final acceptance" }],
			writeOwnershipReleased: false,
		});
		const taskSink = sink();
		const poolSink = sink();
		const task = await settleChildDeliveryForParent({
			sink: taskSink,
			cwd: "/tmp/nonexistent-for-empty-version",
			delivery,
			eventIdPrefix: "task:call:agent",
			jobId: "call",
			agentId: "agent",
			taskToolCallId: "call",
		});
		const pool = await settleChildDeliveryForParent({
			sink: poolSink,
			cwd: "/tmp/nonexistent-for-empty-version",
			delivery,
			eventIdPrefix: "wp:pool:agent:batch",
			jobId: "batch",
			agentId: "agent",
		});
		// Empty cwd version → stale for both entrances (same domain function).
		expect(task?.decision.classification).toBe("stale_context");
		expect(pool?.decision.classification).toBe(task?.decision.classification);
		expect(task?.decision.action).toBe(pool?.decision.action);
		expect(taskSink.entries.some(e => e.type === "child_settled" || (e.details as { phase?: string })?.phase)).toBe(
			true,
		);
	});

	it("consume path never stamps finalAccepted true", () => {
		const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "v1", changedFiles: ["a.ts"] },
			acceptanceItems: [{ id: "ok", claimedProven: true, evidenceLocations: ["a.ts"] }],
			terminalChecksPassed: [{ id: "ok", evidenceLocation: "log://ok" }],
			writeOwnershipReleased: true,
		});
		const s = sink();
		const result = consumeChildDeliveryForParent({
			delivery,
			currentCodeVersion: "v1",
			requiredAcceptance: ["ok"],
			writeOwnershipReleased: true,
			episodeSessionId: "s",
			rootUserEntryId: "u",
			sink: s,
		});
		expect(result.entry.kind).toBe(PARENT_INTEGRATE_DECISION_CUSTOM_TYPE);
		expect(result.entry.finalAccepted).toBe(false);
	});
	it("does not append a second decision for replay, but records a changed workspace decision", () => {
		const s = sink();
		const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "content:one", changedFiles: ["a.ts"] },
			acceptanceItems: [{ id: "check", claimedProven: false }],
			checksNotRun: [{ id: "check", reason: "parent_owns_verify" }],
		});
		const input = {
			delivery,
			currentCodeVersion: "content:one",
			requiredAcceptance: ["check"],
			episodeSessionId: "parent",
			rootUserEntryId: "u",
			agentId: "child",
			sink: s,
			eventIdPrefix: "task:replay",
		};
		const first = consumeChildDeliveryForParent(input);
		const replay = consumeChildDeliveryForParent(input);
		expect(first.decision.action).toBe("parent_coordinate");
		expect(replay.entryId).toBe(first.entryId);
		expect(s.entries.filter(entry => entry.type === PARENT_INTEGRATE_DECISION_CUSTOM_TYPE)).toHaveLength(1);
		const changed = consumeChildDeliveryForParent({ ...input, currentCodeVersion: "content:two" });
		expect(changed.decision.action).toBe("reread_then_decide");
		expect(changed.entryId).not.toBe(first.entryId);
		expect(s.entries.filter(entry => entry.type === PARENT_INTEGRATE_DECISION_CUSTOM_TYPE)).toHaveLength(2);
	});
});
