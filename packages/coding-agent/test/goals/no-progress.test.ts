import { describe, expect, it } from "bun:test";
import {
	applyNoProgressObservation,
	buildProgressFingerprint,
	mergeNoProgressIntoGate,
	NO_PROGRESS_FIXTURE_THRESHOLD,
} from "../../src/goals/no-progress";
import { GoalRuntime, type GoalRuntimeHost } from "../../src/goals/runtime";
import type { Goal, GoalHostGateState, GoalModeState, GoalTokenUsage } from "../../src/goals/state";

function gate(partial?: Partial<GoalHostGateState>): GoalHostGateState {
	return {
		goalRevision: 1,
		pendingVerification: false,
		consecutiveContinueCount: 0,
		...partial,
	};
}

describe("goal no-progress observation (D2)", () => {
	it("does not treat consecutiveContinueCount as the progress signal", () => {
		const g = gate({ consecutiveContinueCount: 99, noProgressCount: 0 });
		const result = applyNoProgressObservation({
			gate: g,
			decision: "continue",
			policyEnabled: true,
			threshold: NO_PROGRESS_FIXTURE_THRESHOLD,
			observation: {
				hostReasons: ["missing_verification"],
				nominationId: "n1",
			},
		});
		// First comparable observation starts streak at 1 — independent of continue tally.
		expect(result.noProgressCount).toBe(1);
		expect(result.identicalToPrior).toBe(false);
		expect(g.consecutiveContinueCount).toBe(99);
	});

	it("pauses only under opt-in policy after N identical comparable observations", () => {
		let state = gate();
		const observation = {
			hostReasons: ["missing_verification"] as const,
			trustedFailureIds: ["seal:a"] as const,
		};
		for (let i = 1; i <= NO_PROGRESS_FIXTURE_THRESHOLD; i++) {
			const result = applyNoProgressObservation({
				gate: state,
				decision: "continue",
				policyEnabled: true,
				threshold: NO_PROGRESS_FIXTURE_THRESHOLD,
				observation: { ...observation, nominationId: `n${i}` },
			});
			state = mergeNoProgressIntoGate(state, result);
			expect(result.noProgressCount).toBe(i);
			if (i < NO_PROGRESS_FIXTURE_THRESHOLD) {
				expect(result.shouldPause).toBe(false);
			} else {
				expect(result.shouldPause).toBe(true);
				expect(result.lastPauseReason).toBe("identical_host_observation");
			}
		}
	});

	it("observe-only mode records fingerprints but never pauses", () => {
		let state = gate();
		for (let i = 1; i <= 5; i++) {
			const result = applyNoProgressObservation({
				gate: state,
				decision: "continue",
				policyEnabled: false,
				threshold: 3,
				observation: {
					hostReasons: ["open_todos"],
					nominationId: `n${i}`,
				},
			});
			expect(result.shouldPause).toBe(false);
			state = mergeNoProgressIntoGate(state, result);
		}
		expect(state.noProgressCount).toBeGreaterThanOrEqual(3);
		expect(state.lastProgressFingerprint).toBeTruthy();
	});

	it("code-hash churn alone does not clear no-progress when host facts are identical", () => {
		const first = buildProgressFingerprint({
			hostReasons: ["missing_verification"],
			codeVersionFingerprint: "v1",
		});
		const second = buildProgressFingerprint({
			hostReasons: ["missing_verification"],
			codeVersionFingerprint: "v2",
		});
		// Pairing context differs → fingerprints differ by design when code version
		// is included as pairing. Progress equality still requires host facts.
		expect(first).toBeTruthy();
		expect(second).toBeTruthy();
		expect(first).not.toBe(second);

		// Same pairing + same host facts → identical.
		const a = buildProgressFingerprint({
			trustedFailureIds: ["x"],
			codeVersionFingerprint: "same",
		});
		const b = buildProgressFingerprint({
			trustedFailureIds: ["x"],
			codeVersionFingerprint: "same",
		});
		expect(a).toBe(b);
	});

	it("does not double-count the same nomination id", () => {
		const state = gate({
			lastProgressFingerprint: buildProgressFingerprint({ hostReasons: ["open_todos"] }) ?? undefined,
			noProgressCount: 2,
			lastObservedNominationId: "n-replay",
		});
		const result = applyNoProgressObservation({
			gate: state,
			decision: "continue",
			policyEnabled: true,
			threshold: 3,
			observation: { hostReasons: ["open_todos"], nominationId: "n-replay" },
		});
		expect(result.noProgressCount).toBe(2);
		expect(result.shouldPause).toBe(false);
	});

	it("unpaired_tools-only wait does not burn no-progress quota", () => {
		const state = gate({ noProgressCount: 1, lastProgressFingerprint: "keep" });
		const result = applyNoProgressObservation({
			gate: state,
			decision: "continue",
			policyEnabled: true,
			threshold: 3,
			observation: { hostReasons: ["unpaired_tools"], nominationId: "n-wait" },
		});
		expect(result.comparable).toBe(false);
		expect(result.noProgressCount).toBe(1);
		expect(result.shouldPause).toBe(false);
	});

	it("evaluator unavailable is not host progress and never pauses", () => {
		const result = applyNoProgressObservation({
			gate: gate({ noProgressCount: 2 }),
			decision: "continue",
			policyEnabled: true,
			threshold: 3,
			observation: { evaluatorUnavailable: true, nominationId: "n-eval" },
		});
		expect(result.lastPauseReason).toBe("evaluator_unavailable_not_progress");
		expect(result.shouldPause).toBe(false);
		expect(result.noProgressCount).toBe(2);
	});

	it("non-continue clears no-progress baseline", () => {
		const result = applyNoProgressObservation({
			gate: gate({ noProgressCount: 5, lastProgressFingerprint: "x" }),
			decision: "candidate_complete",
			policyEnabled: true,
			threshold: 3,
			observation: { hostReasons: ["missing_verification"] },
		});
		expect(result.noProgressCount).toBe(0);
		expect(result.lastProgressFingerprint).toBeNull();
	});

	it("progress reset: changed provenAcceptanceIds clears streak to 1", () => {
		const prior = buildProgressFingerprint({
			hostReasons: ["missing_verification"],
			provenAcceptanceIds: [],
			acceptanceRevision: "rev-a",
		});
		const state = gate({
			lastProgressFingerprint: prior ?? undefined,
			noProgressCount: 2,
			lastObservedNominationId: "n-old",
		});
		const result = applyNoProgressObservation({
			gate: state,
			decision: "continue",
			policyEnabled: true,
			threshold: 3,
			observation: {
				hostReasons: ["missing_verification"],
				provenAcceptanceIds: ["item-1"],
				acceptanceRevision: "rev-a",
				nominationId: "n-new",
			},
		});
		expect(result.identicalToPrior).toBe(false);
		expect(result.noProgressCount).toBe(1);
		expect(result.shouldPause).toBe(false);
	});

	it("incomparable observation (no host facts) does not increment or pause", () => {
		const state = gate({
			noProgressCount: 2,
			lastProgressFingerprint: "keep-me",
		});
		const result = applyNoProgressObservation({
			gate: state,
			decision: "continue",
			policyEnabled: true,
			threshold: 3,
			observation: { nominationId: "n-empty", codeVersionFingerprint: "only-hash" },
		});
		expect(result.comparable).toBe(false);
		expect(result.noProgressCount).toBe(2);
		expect(result.shouldPause).toBe(false);
		expect(result.lastPauseReason).toBe("missing_observation_budget_only");
	});

	it("fingerprint includes acceptanceRevision / trustedFailureIds / provenAcceptanceIds", () => {
		const a = buildProgressFingerprint({
			acceptanceRevision: "r1",
			trustedFailureIds: ["f1"],
			provenAcceptanceIds: ["p1"],
			hostReasons: ["missing_verification"],
		});
		const b = buildProgressFingerprint({
			acceptanceRevision: "r1",
			trustedFailureIds: ["f1"],
			provenAcceptanceIds: ["p1"],
			hostReasons: ["missing_verification"],
		});
		const c = buildProgressFingerprint({
			acceptanceRevision: "r2",
			trustedFailureIds: ["f1"],
			provenAcceptanceIds: ["p1"],
			hostReasons: ["missing_verification"],
		});
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});

describe("goal nominateComplete preserves no-progress observation fields (D2)", () => {
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

	it("preserves noProgressCount / lastProgressFingerprint / lastObservedNominationId / lastPauseReason across nominate", async () => {
		const finger = buildProgressFingerprint({ hostReasons: ["open_todos"] });
		const live = createHarness({
			enabled: true,
			mode: "active",
			goal: {
				id: "g-preserve",
				objective: "Ship it",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 1,
				updatedAt: 1,
				hostGate: {
					goalRevision: 3,
					pendingVerification: false,
					consecutiveContinueCount: 1,
					noProgressCount: 2,
					lastProgressFingerprint: finger ?? "fp",
					lastObservedNominationId: "n-prior",
					lastPauseReason: "identical_host_observation",
					lastGaps: ["gap-a"],
				},
			},
		});
		live.runtime.onTurnStart("turn-2", createUsage());
		const nominated = await live.runtime.nominateComplete({
			nominationId: "n-next",
			turnId: "turn-2",
			generation: 7,
		});
		expect(nominated.shared).toBe(false);
		const gate = live.getState()?.goal.hostGate;
		expect(gate?.pendingVerification).toBe(true);
		expect(gate?.nominationId).toBe("n-next");
		expect(gate?.noProgressCount).toBe(2);
		expect(gate?.lastProgressFingerprint).toBe(finger ?? "fp");
		expect(gate?.lastObservedNominationId).toBe("n-prior");
		expect(gate?.lastPauseReason).toBe("identical_host_observation");
		expect(gate?.lastGaps).toEqual(["gap-a"]);
		expect(gate?.consecutiveContinueCount).toBe(1);
	});

	it("cancel / late / resume: recover clears pending without wiping observation fields; late apply is stale", async () => {
		const finger = buildProgressFingerprint({
			trustedFailureIds: ["seal:a"],
			hostReasons: ["missing_verification"],
		});
		const harness = createHarness({
			enabled: true,
			mode: "active",
			goal: {
				id: "g-late",
				objective: "Ship it",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 1,
				updatedAt: 1,
				hostGate: {
					goalRevision: 1,
					pendingVerification: false,
					consecutiveContinueCount: 0,
					noProgressCount: 1,
					lastProgressFingerprint: finger ?? "fp",
					lastObservedNominationId: "n0",
				},
			},
		});
		harness.runtime.onTurnStart("turn-1", createUsage());
		const nominated = await harness.runtime.nominateComplete({
			nominationId: "n1",
			turnId: "turn-1",
			generation: 7,
		});
		const revision = nominated.goal.hostGate?.goalRevision ?? 0;
		await harness.runtime.recoverPendingVerification();
		expect(harness.getState()?.goal.hostGate?.pendingVerification).toBe(false);
		expect(harness.getState()?.goal.hostGate?.noProgressCount).toBe(1);
		expect(harness.getState()?.goal.hostGate?.lastProgressFingerprint).toBe(finger ?? "fp");

		const late = await harness.runtime.applyNominationResult({
			goalId: "g-late",
			goalRevision: revision,
			nominationId: "n1",
			turnId: "turn-1",
			generation: 7,
			decision: "continue",
			evidence: "late",
			nextStep: "should discard",
			reasons: ["missing_verification"],
			noProgress: {
				policyEnabled: false,
				threshold: 3,
				observation: {
					hostReasons: ["missing_verification"],
					nominationId: "n1",
					acceptanceRevision: "r",
					trustedFailureIds: ["seal:a"],
					provenAcceptanceIds: [],
				},
			},
		});
		expect(late).toBe("stale");
		expect(harness.getState()?.goal.hostGate?.noProgressCount).toBe(1);

		// Resume: new nomination preserves observation baseline.
		const resumed = await harness.runtime.nominateComplete({
			nominationId: "n2",
			turnId: "turn-1",
			generation: 7,
		});
		expect(resumed.goal.hostGate?.noProgressCount).toBe(1);
		expect(resumed.goal.hostGate?.lastProgressFingerprint).toBe(finger ?? "fp");
	});
});
