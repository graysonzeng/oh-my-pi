import { type Goal } from "@oh-my-pi/pi-tui/tools/goal";
export type { Goal, GoalToolDetails } from "@oh-my-pi/pi-tui/tools/goal";
import type { UsageStatistics } from "../session/session-entries";

export type GoalHostGateDecisionKind = "continue" | "candidate_complete" | "blocked" | "user_confirmed";

export type NoProgressPauseReason =
	| "identical_host_observation"
	| "missing_observation_budget_only"
	| "evaluator_unavailable_not_progress";

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
	/**
	 * Count of consecutive host-gate / advice `continue` decisions.
	 * NOT a no-progress counter — see {@link noProgressCount}.
	 */
	consecutiveContinueCount: number;
	lastGaps?: string[];
	/**
	 * Fingerprint of the last comparable host progress observation (D2).
	 * Absent when never observed or observation was unknown.
	 */
	lastProgressFingerprint?: string;
	/**
	 * Consecutive identical comparable host observations.
	 * Independent of {@link consecutiveContinueCount}.
	 */
	noProgressCount?: number;
	/** Nomination id that last updated no-progress observation (replay dedupe). */
	lastObservedNominationId?: string;
	/** Why the host last paused / would pause under opt-in no-progress policy. */
	lastPauseReason?: NoProgressPauseReason;
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
