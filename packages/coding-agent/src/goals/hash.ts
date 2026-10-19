import { createHash } from "node:crypto";
import type { Goal, GoalModeState } from "./state";

export const DSH_GOAL_HASH_SHADOW_CUSTOM_TYPE = "dsh.goal_hash_shadow.v1" as const;

export type GoalHashResetReason =
	| "id"
	| "objective"
	| "status"
	| "enabled"
	| "mode"
	| "next_step"
	| "compaction"
	| "rehydrate"
	| "none";

export interface GoalHashShadowV1 {
	v: 1;
	sessionId: string;
	goalId: string;
	snapshotFingerprint: string;
	finalHash: string;
	injected: boolean;
	resetReason: GoalHashResetReason;
	adjacentPrevHash: string | null;
	adjacentIdentical: boolean | null;
}

export function hashGoalFinalString(finalString: string): string {
	return createHash("sha256").update(finalString).digest("hex");
}

export function shouldResetGoalContextHash(input: {
	prev: GoalModeState | undefined;
	next: GoalModeState | undefined;
	compactionBoundary?: boolean;
	rehydrate?: boolean;
}): { reset: boolean; reason: GoalHashResetReason } {
	if (input.rehydrate) return { reset: true, reason: "rehydrate" };
	if (input.compactionBoundary) return { reset: true, reason: "compaction" };
	if (!input.prev && input.next) return { reset: true, reason: "rehydrate" };
	if (input.prev && !input.next) return { reset: true, reason: "status" };
	if (!input.prev || !input.next) return { reset: false, reason: "none" };
	if (input.prev.goal.id !== input.next.goal.id) return { reset: true, reason: "id" };
	if (input.prev.goal.objective !== input.next.goal.objective) return { reset: true, reason: "objective" };
	if (input.prev.goal.status !== input.next.goal.status) return { reset: true, reason: "status" };
	if (input.prev.enabled !== input.next.enabled) return { reset: true, reason: "enabled" };
	if (input.prev.mode !== input.next.mode) return { reset: true, reason: "mode" };
	if (input.prev.goal.hostGate?.lastNextStep !== input.next.goal.hostGate?.lastNextStep) {
		return { reset: true, reason: "next_step" };
	}
	return { reset: false, reason: "none" };
}

export function adjacentShadow(
	prev: GoalHashShadowV1 | undefined,
	next: Omit<GoalHashShadowV1, "adjacentPrevHash" | "adjacentIdentical">,
): GoalHashShadowV1 {
	const adjacentPrevHash = prev?.finalHash ?? null;
	return {
		...next,
		adjacentPrevHash,
		adjacentIdentical: adjacentPrevHash === null ? null : adjacentPrevHash === next.finalHash,
	};
}

export function usageDoesNotResetHash(prev: Goal, next: Goal): boolean {
	return (
		prev.id === next.id &&
		prev.objective === next.objective &&
		prev.status === next.status &&
		prev.tokensUsed !== next.tokensUsed
	);
}
