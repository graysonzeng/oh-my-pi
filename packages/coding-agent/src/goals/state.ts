import { type Goal } from "@oh-my-pi/pi-tui/tools/goal";
export type { Goal, GoalToolDetails } from "@oh-my-pi/pi-tui/tools/goal";
import type { UsageStatistics } from "../session/session-entries";

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

declare module "@oh-my-pi/pi-tui/tools/goal" {
	interface Goal {
		headlessContinuationCount?: number;
		hostGate?: GoalHostGateState;
	}

	interface GoalToolDetails {
		gate?: GoalHostGateDecisionKind;
	}
}
export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: Goal;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";
