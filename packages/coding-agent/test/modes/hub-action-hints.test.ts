import { describe, expect, it } from "bun:test";
import {
	actionableHubItems,
	formatAgentActionNeeds,
	projectHubActionQueue,
} from "@oh-my-pi/pi-tui/overlays/agent-hub-action-queue";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { collectHubActionHints } from "../../src/modes/hub-action-hints";

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

describe("collectHubActionHints (D6)", () => {
	it("surfaces integrate-eligible parked children with outputPath", () => {
		const worker = ref({
			id: "worker-1",
			status: "parked",
			history: { outputPath: "/tmp/out.md" },
		});
		const hints = collectHubActionHints({ agents: [ref({ id: "Main", kind: "main", status: "running" }), worker] });
		expect(hints.pendingIntegrateAgentIds).toContain("worker-1");
		const queue = projectHubActionQueue([ref({ id: "Main", kind: "main", status: "running" }), worker], hints);
		expect(formatAgentActionNeeds(queue, "worker-1").some(line => line.includes("need_integrate"))).toBe(true);
	});

	it("does not invent decision/auth for aborted agents after cancel (cancel-then-late)", () => {
		const dead = ref({ id: "dead", status: "aborted", history: { outputPath: "/tmp/x.md" } });
		const hints = collectHubActionHints({
			agents: [dead],
			askDialogOpenForAgentIds: ["dead"],
			pendingApprovalAgentIds: ["dead"],
		});
		expect(hints.pendingDecisionAgentIds ?? []).not.toContain("dead");
		expect(hints.pendingAuthAgentIds ?? []).not.toContain("dead");
		expect(hints.pendingIntegrateAgentIds ?? []).not.toContain("dead");
		const queue = projectHubActionQueue([dead], hints);
		expect(queue.some(i => i.kind === "blocked_or_no_progress" && i.agentId === "dead")).toBe(true);
		expect(queue.some(i => i.kind === "running_or_handled" && i.agentId === "dead")).toBe(false);
		expect(queue.some(i => i.kind === "need_decision" && i.agentId === "dead")).toBe(false);
	});

	it("dedupes host overlay ids and refresh/nav re-project to the same stable action id", () => {
		const main = ref({ id: "Main", kind: "main", status: "running" });
		const first = collectHubActionHints({
			agents: [main],
			askDialogOpenForAgentIds: ["Main", "Main"],
		});
		const second = collectHubActionHints({
			agents: [main],
			askDialogOpenForAgentIds: ["Main"],
		});
		const q1 = actionableHubItems(projectHubActionQueue([main], first));
		const q2 = actionableHubItems(projectHubActionQueue([main], second));
		expect(q1.filter(i => i.kind === "need_decision")).toHaveLength(1);
		expect(q1[0]!.id).toBe(q2[0]!.id);
		expect(q1[0]!.id).toBe("Main::need_decision");
	});

	it("skips advisor rows for Needs me buckets", () => {
		const advisor = ref({ id: "adv", kind: "advisor", status: "idle", history: { outputPath: "/tmp/a.md" } });
		const hints = collectHubActionHints({ agents: [advisor] });
		expect(hints.pendingIntegrateAgentIds ?? []).not.toContain("adv");
	});
});
