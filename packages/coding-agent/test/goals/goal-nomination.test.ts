import { describe, expect, it } from "bun:test";
import { GoalRuntime, type GoalRuntimeHost } from "../../src/goals/runtime";
import type { Goal, GoalModeState, GoalTokenUsage } from "../../src/goals/state";

function createUsage(): GoalTokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function cloneGoal(goal: Goal): Goal {
	return {
		...goal,
		hostGate: goal.hostGate
			? {
					...goal.hostGate,
					lastReasons: goal.hostGate.lastReasons?.slice(),
					lastGaps: goal.hostGate.lastGaps?.slice(),
				}
			: undefined,
	};
}

function createHarness(initial?: GoalModeState) {
	let state = initial ? { ...initial, goal: cloneGoal(initial.goal) } : undefined;
	const host: GoalRuntimeHost = {
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
	};
	return {
		runtime: new GoalRuntime(host),
		getState: () => (state ? { ...state, goal: cloneGoal(state.goal) } : undefined),
	};
}

describe("goal nomination compare-and-set", () => {
	it("shares the same-turn nomination and discards a stale evaluator result", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Ship it" });
		harness.runtime.onTurnStart("turn-1", createUsage());

		const first = await harness.runtime.nominateComplete({
			nominationId: "n1",
			turnId: "turn-1",
			generation: 7,
		});
		const second = await harness.runtime.nominateComplete({
			nominationId: "n2",
			turnId: "turn-1",
			generation: 7,
		});
		expect(first.shared).toBe(false);
		expect(second.shared).toBe(true);
		expect(second.goal.hostGate?.nominationId).toBe("n1");
		expect(first.settle).toBeDefined();
		expect(second.flight).toBeDefined();
		let settled = false;
		const waited = second.flight!.then(() => {
			settled = true;
		});
		expect(settled).toBe(false);
		first.settle!.resolve();
		await waited;
		expect(settled).toBe(true);

		const stale = await harness.runtime.applyNominationResult({
			goalId: second.goal.id,
			goalRevision: (second.goal.hostGate?.goalRevision ?? 0) + 1,
			nominationId: "n1",
			turnId: "turn-1",
			generation: 7,
			decision: "blocked",
			evidence: "late",
			nextStep: "should discard",
			blockerKey: "missing_secret",
		});
		expect(stale).toBe("stale");
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.hostGate?.pendingVerification).toBe(true);

		const applied = await harness.runtime.applyNominationResult({
			goalId: second.goal.id,
			goalRevision: second.goal.hostGate?.goalRevision ?? 0,
			nominationId: "n1",
			turnId: "turn-1",
			generation: 7,
			decision: "continue",
			evidence: "open todos",
			nextStep: "close todos",
			reasons: ["open_todos"],
		});
		expect(applied).toBe("applied");
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.hostGate?.pendingVerification).toBe(false);
		expect(harness.getState()?.goal.hostGate?.lastNextStep).toBe("close todos");
	});

	it("cancels in-flight work on drop and recovers pending verification", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Ship it" });
		harness.runtime.onTurnStart("turn-1", createUsage());
		const nominated = await harness.runtime.nominateComplete({
			nominationId: "n1",
			turnId: "turn-1",
			generation: 7,
		});
		expect(nominated.settle?.controller.signal.aborted).toBe(false);

		await harness.runtime.dropGoal();
		expect(nominated.settle?.controller.signal.aborted).toBe(true);
		nominated.settle?.resolve();
		expect(harness.getState()).toBeUndefined();
	});

	it("clears pending verification on recover without completing", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Ship it" });
		harness.runtime.onTurnStart("turn-1", createUsage());
		await harness.runtime.nominateComplete({ nominationId: "n1", turnId: "turn-1", generation: 7 });
		expect(harness.getState()?.goal.hostGate?.pendingVerification).toBe(true);
		await harness.runtime.recoverPendingVerification();
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.hostGate?.pendingVerification).toBe(false);
		expect(harness.getState()?.goal.hostGate?.lastDecision).toBe("continue");
	});
});
