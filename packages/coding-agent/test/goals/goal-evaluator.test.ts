import { describe, expect, it } from "bun:test";
import { packGoalEvaluatorBundle, parseGoalEvaluatorJson } from "../../src/goals/evaluator";
import type { GoalCompletionSettleSnapshot } from "../../src/goals/host-gate";
import type { Goal } from "../../src/goals/state";

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
});
