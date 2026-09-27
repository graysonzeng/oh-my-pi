import { describe, expect, it } from "bun:test";
import {
	actionableHubItems,
	formatHubActionQueue,
	projectHubActionQueue,
} from "@oh-my-pi/pi-tui/overlays/agent-hub-action-queue";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";

function ref(partial: Partial<AgentRecordLike> & Pick<AgentRecordLike, "id">): AgentRecordLike {
	return {
		displayName: partial.displayName ?? partial.id,
		kind: partial.kind ?? "sub",
		status: partial.status ?? "idle",
		session: null,
		sessionFile: partial.sessionFile ?? null,
		createdAt: partial.createdAt ?? 1,
		lastActivity: partial.lastActivity ?? 1,
		...partial,
	};
}

describe("hub action queue (D6)", () => {
	it("projects need_decision / need_auth / need_integrate ahead of running rows", () => {
		const refs = [ref({ id: "Main", kind: "main", status: "running" }), ref({ id: "worker-1", status: "idle" })];
		const queue = projectHubActionQueue(refs, {
			pendingDecisionAgentIds: ["Main"],
			pendingIntegrateAgentIds: ["worker-1"],
		});
		const actionable = actionableHubItems(queue);
		expect(actionable.map(a => a.kind)).toEqual(["need_decision", "need_integrate"]);
		expect(formatHubActionQueue(queue)).toContain("need_decision");
	});

	it("dedupes the same agent+kind to a single stable id", () => {
		const refs = [ref({ id: "a1", status: "parked" })];
		const queue = projectHubActionQueue(refs, {
			pendingAuthAgentIds: ["a1", "a1"],
			blockedAgentIds: ["a1"],
		});
		const auth = queue.filter(i => i.kind === "need_auth");
		expect(auth).toHaveLength(1);
		expect(auth[0]!.id).toBe("a1::need_auth");
	});

	it("late aborted status surfaces as blocked_or_no_progress without inventing running", () => {
		const queue = projectHubActionQueue([ref({ id: "dead", status: "aborted" })]);
		expect(queue.some(i => i.kind === "blocked_or_no_progress" && i.agentId === "dead")).toBe(true);
		expect(queue.some(i => i.kind === "running_or_handled" && i.agentId === "dead")).toBe(false);
	});
});
