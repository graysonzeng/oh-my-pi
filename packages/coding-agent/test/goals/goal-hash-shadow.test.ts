import { describe, expect, it } from "bun:test";
import {
	adjacentShadow,
	DSH_GOAL_HASH_SHADOW_CUSTOM_TYPE,
	hashGoalFinalString,
	shouldResetGoalContextHash,
} from "../../src/goals/hash";
import type { GoalModeState } from "../../src/goals/state";

function state(overrides: Partial<GoalModeState["goal"]> = {}, mode: GoalModeState["mode"] = "active"): GoalModeState {
	return {
		enabled: true,
		mode,
		goal: {
			id: "g1",
			objective: "ship",
			status: "active",
			tokensUsed: 1,
			timeUsedSeconds: 1,
			createdAt: 0,
			updatedAt: 0,
			...overrides,
		},
	};
}

describe("goal hash shadow", () => {
	it("does not reset on usage-only changes and uses adjacent pairs as the denominator", () => {
		expect(shouldResetGoalContextHash({ prev: state({ tokensUsed: 1 }), next: state({ tokensUsed: 9 }) })).toEqual({
			reset: false,
			reason: "none",
		});
		expect(
			shouldResetGoalContextHash({ prev: state({ status: "active" }), next: state({ status: "paused" }) }).reset,
		).toBe(true);
		const first = adjacentShadow(undefined, {
			v: 1,
			sessionId: "s",
			goalId: "g1",
			snapshotFingerprint: "fp",
			finalHash: hashGoalFinalString("final-a"),
			injected: true,
			resetReason: "rehydrate",
		});
		expect(first.adjacentIdentical).toBeNull();
		const second = adjacentShadow(first, {
			v: 1,
			sessionId: "s",
			goalId: "g1",
			snapshotFingerprint: "fp",
			finalHash: first.finalHash,
			injected: false,
			resetReason: "none",
		});
		expect(second.adjacentPrevHash).toBe(first.finalHash);
		expect(second.adjacentIdentical).toBe(true);
		expect(DSH_GOAL_HASH_SHADOW_CUSTOM_TYPE).toBe("dsh.goal_hash_shadow.v1");
	});
});
