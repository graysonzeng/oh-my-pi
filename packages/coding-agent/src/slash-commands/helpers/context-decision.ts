/**
 * D3 context decision projection — recommended action / reason / impact.
 * Advisory only: does not schedule SessionMaintenance or open a new session.
 */
export type ContextRecommendedAction = "continue" | "compact" | "new_session" | "delegate" | "branch_or_rewind";

export interface ContextDecisionHint {
	action: ContextRecommendedAction;
	reason: string;
	impactIfTaken: string;
	impactIfIgnored: string;
}

export interface ContextDecisionInput {
	/** Context window size in tokens; <= 0 means unknown. */
	contextWindow: number;
	/** Estimated used tokens. */
	usedTokens: number;
	/** True when a goal is active (or budget-limited) on this session. */
	goalActive?: boolean;
	/** True when host gate / no-progress paused the goal. */
	goalPausedNoProgress?: boolean;
	/** True when unfinished acceptance / open todos / pending tools remain. */
	hasUnfinishedWork?: boolean;
	/** True when live or parked child agents exist under this session. */
	hasChildAgents?: boolean;
}

/**
 * Pick one recommended action from observable session facts.
 * Prefers the least disruptive existing exit; never invents a second scheduler.
 */
export function recommendContextAction(input: ContextDecisionInput): ContextDecisionHint {
	if (input.goalPausedNoProgress) {
		return {
			action: "branch_or_rewind",
			reason: "goal paused for identical host observation / no-progress",
			impactIfTaken: "review partial work; resume with a new baseline or rewind to a checkpoint",
			impactIfIgnored: "repeated identical nominations may keep the goal paused",
		};
	}
	if (input.contextWindow > 0) {
		const usedRatio = input.usedTokens / input.contextWindow;
		if (usedRatio >= 0.85 && input.hasUnfinishedWork !== false) {
			return {
				action: "compact",
				reason: `context ~${Math.round(usedRatio * 100)}% used with unfinished work`,
				impactIfTaken: "existing SessionMaintenance compaction; keeps unfinished acceptance and recent edits",
				impactIfIgnored: "higher risk of context pressure and weaker retrieval",
			};
		}
		if (usedRatio >= 0.95 && input.hasUnfinishedWork === false) {
			return {
				action: "new_session",
				reason: `context ~${Math.round(usedRatio * 100)}% used and no unfinished acceptance on this goal`,
				impactIfTaken: "fresh session snapshot; carry only declared handoff items",
				impactIfIgnored: "continue with a near-full window and possible pollution",
			};
		}
	}
	if (input.hasChildAgents && input.hasUnfinishedWork) {
		return {
			action: "delegate",
			reason: "child agents present with unfinished parent acceptance",
			impactIfTaken: "keep isolation; parent integrates via child delivery evidence",
			impactIfIgnored: "parent context keeps absorbing child work",
		};
	}
	if (input.goalActive) {
		return {
			action: "continue",
			reason: "active goal with usable context",
			impactIfTaken: "stay on current turn and stable prefix",
			impactIfIgnored: "N/A",
		};
	}
	return {
		action: "continue",
		reason: "no stronger signal from context budget or goal state",
		impactIfTaken: "stay on current session",
		impactIfIgnored: "N/A",
	};
}

export function formatContextDecisionHint(hint: ContextDecisionHint): string {
	return [
		"recommended action (D3)",
		`  action: ${hint.action}`,
		`  reason: ${hint.reason}`,
		`  impact_if_taken: ${hint.impactIfTaken}`,
		`  impact_if_ignored: ${hint.impactIfIgnored}`,
	].join("\n");
}
