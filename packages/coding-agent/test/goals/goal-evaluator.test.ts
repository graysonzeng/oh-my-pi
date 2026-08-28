import { afterEach, describe, expect, it, vi } from "bun:test";
import * as agentCore from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { packGoalEvaluatorBundle, parseGoalEvaluatorJson, runGoalEvaluator } from "../../src/goals/evaluator";
import type { GoalCompletionSettleSnapshot } from "../../src/goals/host-gate";
import type { Goal } from "../../src/goals/state";
import type { ToolSession } from "../../src/tools";
import * as git from "../../src/utils/git";

const snapshot: GoalCompletionSettleSnapshot = {
	turnId: "turn-1",
	generation: 1,
	assistantText: "working",
	stopReason: "stop",
	tools: [],
	goalId: "g1",
	goalRevision: 1,
	nomination: { outcome: "nominated", nominationId: "n1" },
	todos: [],
	messages: [
		{ role: "user", content: "ship the release", timestamp: 0 },
		{
			role: "assistant",
			content: [{ type: "text", text: "running bun test" }],
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
			timestamp: 1,
		} as AssistantMessage,
	],
};

const goal: Goal = {
	id: "g1",
	objective: "ship it",
	status: "active",
	tokensUsed: 0,
	timeUsedSeconds: 0,
	createdAt: 0,
	updatedAt: 0,
	hostGate: { goalRevision: 1, pendingVerification: true, consecutiveContinueCount: 0 },
};

describe("parseGoalEvaluatorJson", () => {
	it("accepts a continue payload and rejects unknown fields", () => {
		const parsed = parseGoalEvaluatorJson(
			'{"decision":"continue","evidence":"open todo","next_step":"close the todo","blocker_key":""}',
		);
		expect("error" in parsed).toBe(false);
		if ("error" in parsed) return;
		expect(parsed.decision).toBe("continue");
		expect(parsed.failOpen).toBe(false);

		const unknown = parseGoalEvaluatorJson(
			'{"decision":"continue","evidence":"x","next_step":"y","blocker_key":"","extra":true}',
		);
		expect(unknown).toEqual({ error: "unknown field extra" });
	});

	it("requires a snake_case blocker_key only for blocked", () => {
		expect(
			parseGoalEvaluatorJson(
				'{"decision":"blocked","evidence":"waiting on secret","next_step":"ask user","blocker_key":"missing_secret"}',
			),
		).toMatchObject({ decision: "blocked", blockerKey: "missing_secret" });
		expect(
			parseGoalEvaluatorJson(
				'{"decision":"continue","evidence":"x","next_step":"y","blocker_key":"missing_secret"}',
			),
		).toEqual({ error: "blocker_key must be empty unless blocked" });
	});

	it("never treats candidate_complete as a host complete grant", () => {
		const parsed = parseGoalEvaluatorJson(
			'{"decision":"candidate_complete","evidence":"looks done","next_step":"ask user","blocker_key":""}',
		);
		expect("error" in parsed).toBe(false);
		if ("error" in parsed) return;
		expect(parsed.decision).toBe("candidate_complete");
		expect(parsed.failOpen).toBe(false);
	});
});

describe("packGoalEvaluatorBundle", () => {
	it("keeps objective XML-escaped and marks git unavailable text", () => {
		const packed = packGoalEvaluatorBundle({
			goal: { ...goal, objective: "ship <fast> & safely" },
			snapshot,
			gitSummary: "git_unavailable",
		});
		expect(packed.objective).toContain("&lt;fast&gt;");
		expect(packed.git).toBe("git_unavailable");
		expect(packed.objectiveOverBudget).toBe(false);
	});

	it("projects recent user/assistant conversation into the evaluator transcript", () => {
		const packed = packGoalEvaluatorBundle({
			goal,
			snapshot,
			gitSummary: "git_unavailable",
		});
		expect(packed.transcript).toContain("ship the release");
		expect(packed.transcript).toContain("running bun test");
	});
});

describe("runGoalEvaluator timeout", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("treats timeoutMs=0 as disabled instead of falling back to 15s", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		vi.spyOn(git, "status").mockResolvedValue("");
		vi.spyOn(git, "diff").mockResolvedValue("");
		let sawTimeoutSignal = false;
		vi.spyOn(agentCore, "instrumentedCompleteSimple").mockImplementation(async (_model, _context, options) => {
			sawTimeoutSignal = options?.signal !== undefined;
			return {
				role: "assistant",
				content: [
					{
						type: "text",
						text: '{"decision":"candidate_complete","evidence":"ok","next_step":"ask user","blocker_key":""}',
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		});
		const result = await runGoalEvaluator({
			session: {
				cwd: process.cwd(),
				settings: Settings.isolated({ "goal.hostGate.timeoutMs": 0 }),
				getActiveModel: () => model,
			} as unknown as ToolSession,
			goal,
			snapshot,
		});
		expect(sawTimeoutSignal).toBe(false);
		expect(result.decision).toBe("candidate_complete");
		expect(result.failOpen).toBe(false);
	});
});
