import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	buildGoalCompletionSettleSnapshot,
	evaluateGoalHostGate,
	looksLikeFalseCompletion,
} from "../../src/goals/host-gate";
import type { Goal } from "../../src/goals/state";

function assistant(text: string, tools: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...tools],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage;
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
	return { type: "toolCall" as const, id, name, arguments: args };
}

function toolResult(id: string, name: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

const goal: Goal = {
	id: "g1",
	objective: "ship it",
	status: "active",
	tokensUsed: 0,
	timeUsedSeconds: 0,
	createdAt: 0,
	updatedAt: 0,
	hostGate: { goalRevision: 1, pendingVerification: false, consecutiveContinueCount: 0 },
};

describe("evaluateGoalHostGate", () => {
	it("rejects completion claims without a successful verification command", () => {
		const snapshot = buildGoalCompletionSettleSnapshot({
			turnId: "turn-1",
			generation: 1,
			assistant: assistant("all green"),
			messages: [assistant("all green")],
			todos: [],
			goal,
			nominationOutcome: "nominated",
		});
		const decision = evaluateGoalHostGate(snapshot);
		expect(decision.decision).toBe("continue");
		expect(decision.reasons).toContain("missing_verification");
	});

	it("rejects open todos even when bun test succeeded", () => {
		const call = toolCall("c1", "bash", { command: "bun test" });
		const msg = assistant("done", [call]);
		const snapshot = buildGoalCompletionSettleSnapshot({
			turnId: "turn-1",
			generation: 1,
			assistant: msg,
			messages: [msg, toolResult("c1", "bash", "ok")],
			todos: [{ name: "Ship", tasks: [{ content: "write tests", status: "pending" }] }],
			goal,
			nominationOutcome: "nominated",
		});
		const decision = evaluateGoalHostGate(snapshot);
		expect(decision.decision).toBe("continue");
		expect(decision.reasons).toContain("open_todos");
	});

	it("does not treat a failed bun test as verification", () => {
		const call = toolCall("c1", "bash", { command: "bun test" });
		const msg = assistant("shipped", [call]);
		const snapshot = buildGoalCompletionSettleSnapshot({
			turnId: "turn-1",
			generation: 1,
			assistant: msg,
			messages: [msg, toolResult("c1", "bash", "failed", true)],
			todos: [],
			goal,
			nominationOutcome: "nominated",
		});
		expect(evaluateGoalHostGate(snapshot).reasons).toContain("missing_verification");
	});

	it("passes only when verification succeeded, todos are closed, and tools are paired", () => {
		const call = toolCall("c1", "bash", { command: "bun test packages/coding-agent" });
		const msg = assistant("verified", [call]);
		const snapshot = buildGoalCompletionSettleSnapshot({
			turnId: "turn-1",
			generation: 1,
			assistant: msg,
			messages: [msg, toolResult("c1", "bash", "pass")],
			todos: [{ name: "Ship", tasks: [{ content: "write tests", status: "completed" }] }],
			goal,
			nominationOutcome: "nominated",
		});
		expect(evaluateGoalHostGate(snapshot).decision).toBe("pass");
	});
});

describe("looksLikeFalseCompletion", () => {
	it("uses tool args and todo status, not tool names alone", () => {
		const claimed = buildGoalCompletionSettleSnapshot({
			turnId: "turn-1",
			generation: 1,
			assistant: assistant("all green"),
			messages: [assistant("all green")],
			todos: [],
			goal,
			nominationOutcome: "none",
		});
		expect(looksLikeFalseCompletion(claimed)).toBe(true);

		const call = toolCall("c1", "bash", { command: "bun test" });
		const verified = buildGoalCompletionSettleSnapshot({
			turnId: "turn-1",
			generation: 1,
			assistant: assistant("working", [call]),
			messages: [assistant("working", [call]), toolResult("c1", "bash", "ok")],
			todos: [],
			goal,
			nominationOutcome: "none",
		});
		expect(looksLikeFalseCompletion(verified)).toBe(false);
	});

	it("skips D3 after a complete nomination", () => {
		const snapshot = buildGoalCompletionSettleSnapshot({
			turnId: "turn-1",
			generation: 1,
			assistant: assistant("all green"),
			messages: [assistant("all green")],
			todos: [],
			goal,
			nominationOutcome: "nominated",
		});
		expect(looksLikeFalseCompletion(snapshot)).toBe(false);
	});
});
