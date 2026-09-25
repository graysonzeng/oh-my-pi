import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeGoalComplete } from "../../src/goals/complete";
import * as evaluator from "../../src/goals/evaluator";
import { GoalRuntime } from "../../src/goals/runtime";
import type { Goal, GoalModeState, GoalTokenUsage } from "../../src/goals/state";
import type { ToolSession } from "../../src/tools";

function createUsage(): GoalTokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function cloneGoal(goal: Goal): Goal {
	return {
		...goal,
		hostGate: goal.hostGate ? { ...goal.hostGate, lastReasons: goal.hostGate.lastReasons?.slice() } : undefined,
	};
}

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

function toolResult(id: string, name: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

describe("executeGoalComplete same-turn evaluator", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs one evaluator for two complete nominations in the same turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		let state: GoalModeState | undefined;
		const runtime = new GoalRuntime({
			getState: () => (state ? { ...state, goal: cloneGoal(state.goal) } : undefined),
			setState: next => {
				state = next ? { ...next, goal: cloneGoal(next.goal) } : undefined;
			},
			getCurrentUsage: () => createUsage(),
			emit: async () => {},
			persist: () => {},
			sendHiddenMessage: async () => {},
			now: () => 1,
			getPromptGeneration: () => 7,
		});
		await runtime.createGoal({ objective: "Ship it" });
		runtime.onTurnStart("turn-1", createUsage());

		const verify = { type: "toolCall" as const, id: "v1", name: "bash", arguments: { command: "bun test" } };
		const complete = { type: "toolCall" as const, id: "g1", name: "goal", arguments: { op: "complete" } };
		const settleAssistant = assistant("verified", [verify, complete]);
		const messages: AgentMessage[] = [settleAssistant, toolResult("v1", "bash", "pass")];
		const session = {
			settings: Settings.isolated({ "goal.hostGate.enabled": true }),
			getGoalModeState: () => (state ? { ...state, goal: cloneGoal(state.goal) } : undefined),
			getTodoPhases: () => [{ name: "Ship", tasks: [{ content: "write tests", status: "completed" }] }],
			snapshotConsultContext: () => ({ systemPrompt: [], messages }),
			getActiveModel: () => model,
			cwd: process.cwd(),
		} as unknown as ToolSession;

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const evaluatorSpy = vi.spyOn(evaluator, "runGoalEvaluator").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return {
				decision: "candidate_complete",
				evidence: "host checks passed",
				nextStep: "ask the user to confirm",
				blockerKey: "",
				failOpen: false,
				truncated: false,
				objectiveOverBudget: false,
			};
		});

		const first = executeGoalComplete(session, runtime, undefined, "g1");
		await started.promise;
		const second = executeGoalComplete(session, runtime, undefined, "g2");
		await Promise.resolve();
		expect(evaluatorSpy).toHaveBeenCalledTimes(1);
		release.resolve();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.details.gate).toBe("candidate_complete");
		expect(secondResult.details.gate).toBe("candidate_complete");
		expect(evaluatorSpy).toHaveBeenCalledTimes(1);
		expect(state?.goal.status).toBe("active");
		expect(state?.goal.hostGate?.lastDecision).toBe("candidate_complete");
	});
});
