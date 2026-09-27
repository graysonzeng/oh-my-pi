import { describe, expect, it } from "bun:test";
import {
	applyNoProgressObservation,
	buildProgressFingerprint,
	mergeNoProgressIntoGate,
	NO_PROGRESS_FIXTURE_THRESHOLD,
} from "../../src/goals/no-progress";
import type { GoalHostGateState } from "../../src/goals/state";

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
});
