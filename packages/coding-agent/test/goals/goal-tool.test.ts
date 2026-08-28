import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { Goal, GoalModeState, GoalTokenUsage } from "@oh-my-pi/pi-coding-agent/goals/state";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createUsage(overrides: Partial<GoalTokenUsage> = {}): GoalTokenUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...overrides,
	};
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship it",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function cloneState(state: GoalModeState | undefined): GoalModeState | undefined {
	return state ? { ...state, goal: { ...state.goal } } : undefined;
}

function createToolSession(overrides: Partial<ToolSession>): ToolSession {
	return {
		settings: Settings.isolated({ "goal.hostGate.enabled": true }),
		...overrides,
	} as ToolSession;
}

function createRuntimeHarness(initialState?: GoalModeState) {
	let state = cloneState(initialState);
	const runtime = new GoalRuntime({
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next);
		},
		getCurrentUsage: () => createUsage(),
		emit: async () => {},
		persist: (_mode, _state) => {},
		sendHiddenMessage: async _message => {},
		now: () => 0,
	});
	return {
		runtime,
		getState: () => cloneState(state),
	};
}

describe("GoalTool", () => {
	it("routes create/get/complete operations and returns completion budget details", async () => {
		const createGoalState: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Create route", tokenBudget: 10 }),
		};
		const getGoalState: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Get route", tokensUsed: 4, tokenBudget: 10 }),
		};
		const completedGoal = createGoal({
			objective: "Complete route",
			status: "complete",
			tokensUsed: 7,
			timeUsedSeconds: 3,
			tokenBudget: 10,
		});
		const runtime = {
			createGoal: vi.fn(async () => createGoalState),
			completeGoalFromTool: vi.fn(async () => completedGoal),
			nominateComplete: vi.fn(async () => ({
				accepted: true,
				shared: false,
				goal: getGoalState.goal,
			})),
			currentTurnId: vi.fn(() => "turn-1"),
			currentGeneration: vi.fn(() => 1),
			applyNominationResult: vi.fn(async () => "applied"),
			trackInFlightNomination: vi.fn(),
			recoverPendingVerification: vi.fn(async () => false),
			pauseGoal: vi.fn(async () => getGoalState),
		};
		const getGoalModeState = vi.fn(() => getGoalState);
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => runtime as unknown as GoalRuntime,
				getGoalModeState,
				snapshotConsultContext: () => ({ systemPrompt: [], messages: [] }),
				getTodoPhases: () => [],
			}),
		);

		const created = await tool.execute("call-create", {
			op: "create",
			objective: "  Create route  ",
			token_budget: 10,
		});
		expect(runtime.createGoal).toHaveBeenCalledWith({ objective: "Create route", tokenBudget: 10 });
		expect(created.details).toMatchObject({
			op: "create",
			goal: createGoalState.goal,
			remainingTokens: 10,
			completionBudgetReport: null,
		});

		const fetched = await tool.execute("call-get", { op: "get", objective: undefined, token_budget: undefined });
		expect(getGoalModeState).toHaveBeenCalledTimes(1);
		expect(fetched.details).toMatchObject({
			op: "get",
			goal: getGoalState.goal,
			remainingTokens: 6,
			completionBudgetReport: null,
		});
		expect(runtime.completeGoalFromTool).not.toHaveBeenCalled();

		const nominated = await tool.execute("call-complete", {
			op: "complete",
			objective: undefined,
			token_budget: undefined,
		});
		expect(runtime.completeGoalFromTool).not.toHaveBeenCalled();
		expect(runtime.nominateComplete).toHaveBeenCalledTimes(1);
		expect(nominated.details).toMatchObject({
			op: "complete",
			goal: getGoalState.goal,
			gate: "continue",
		});
		expect(nominated.details?.goal?.status).toBe("active");
		expect(String(nominated.content[0] && "text" in nominated.content[0] ? nominated.content[0].text : "")).toContain(
			"Host gate: continue",
		);
	});

	it("rejects create when a goal already exists", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Existing" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-create", { op: "create", objective: "New goal", token_budget: 10 }),
		).rejects.toThrow("cannot create a new goal because this session already has a goal");
	});

	it("rejects complete when no goal is active", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-complete", { op: "complete", objective: undefined, token_budget: undefined }),
		).rejects.toThrow("cannot complete goal because no goal is active");
	});

	it("rejects op=create when the objective is missing or only whitespace", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-empty", { op: "create", objective: "   \t\n", token_budget: undefined }),
		).rejects.toThrow("objective is required when op=create");
		expect(harness.getState()).toBeUndefined();
	});

	it("rejects op=create when the token_budget is zero or negative", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(tool.execute("call-zero", { op: "create", objective: "Ship it", token_budget: 0 })).rejects.toThrow(
			"token_budget must be a positive integer when provided",
		);
		await expect(tool.execute("call-neg", { op: "create", objective: "Ship it", token_budget: -5 })).rejects.toThrow(
			"token_budget must be a positive integer when provided",
		);
		expect(harness.getState()).toBeUndefined();
	});

	it("keeps the goal active when op=complete fails the host gate", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Ship the release", tokenBudget: 100 });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
				snapshotConsultContext: () => ({ systemPrompt: [], messages: [] }),
				getTodoPhases: () => [],
			}),
		);

		const result = await tool.execute("call-complete", {
			op: "complete",
			objective: undefined,
			token_budget: undefined,
		});

		expect(result.details).toMatchObject({ op: "complete", gate: "continue" });
		const after = harness.getState();
		expect(after?.enabled).toBe(true);
		expect(after?.mode).toBe("active");
		expect(after?.goal.status).toBe("active");
		expect(after?.goal.hostGate?.pendingVerification).toBe(false);
		expect(after?.goal.hostGate?.lastDecision).toBe("continue");
	});

	it("nominates a paused goal without completing it", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ objective: "Paused work", status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
				snapshotConsultContext: () => ({ systemPrompt: [], messages: [] }),
				getTodoPhases: () => [],
			}),
		);

		const result = await tool.execute("call-complete", {
			op: "complete",
			objective: undefined,
			token_budget: undefined,
		});
		expect(result.details?.gate).toBe("continue");
		expect(result.details?.goal?.status).toBe("paused");
		expect(harness.getState()?.goal.status).toBe("paused");
	});

	it("allows create after previous goal is complete", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: createGoal({ status: "complete" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-create", {
			op: "create",
			objective: "Next goal",
			token_budget: undefined,
		});
		expect(result.details?.goal?.objective).toBe("Next goal");
		expect(result.details?.goal?.status).toBe("active");
	});

	it("op=get returns a paused goal even when enabled=false", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-get", { op: "get", objective: undefined, token_budget: undefined });
		expect(result.details?.goal?.status).toBe("paused");
		expect(result.details?.goal?.objective).toBe("Ship it");
	});

	it("op=resume re-activates a paused goal", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-resume", { op: "resume", objective: undefined, token_budget: undefined });
		expect(result.details?.op).toBe("resume");
		expect(result.details?.goal?.status).toBe("active");
		expect(harness.getState()?.enabled).toBe(true);
	});

	it("op=drop clears goal state", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Drop me" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-drop", { op: "drop", objective: undefined, token_budget: undefined });
		expect(result.details?.op).toBe("drop");
		expect(result.details?.goal?.status).toBe("dropped");
		expect(harness.getState()).toBeUndefined();
	});
});
