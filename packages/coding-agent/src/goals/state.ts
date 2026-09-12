import type { UsageStatistics } from "../session/session-entries";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export type GoalHostGateDecisionKind = "continue" | "candidate_complete" | "blocked" | "user_confirmed";

export type GoalHostGateState = {
	goalRevision: number;
	pendingVerification: boolean;
	nominationId?: string;
	turnId?: string;
	generation?: number;
	lastDecision?: GoalHostGateDecisionKind;
	lastEvidence?: string;
	lastNextStep?: string;
	lastBlockerKey?: string;
	lastReasons?: string[];
	consecutiveContinueCount: number;
	lastGaps?: string[];
};

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	headlessContinuationCount?: number;
	createdAt: number;
	updatedAt: number;
	hostGate?: GoalHostGateState;
}

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: Goal;
}

export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "drop";
	goal?: Goal | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
	gate?: "continue" | "candidate_complete" | "blocked" | "user_confirmed";
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";
