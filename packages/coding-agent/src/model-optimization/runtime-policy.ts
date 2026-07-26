/**
 * Build runtime policy adapters from a resolved ModelOptimizationProfile.
 * Ordinary sessions only: no aliases, permissions, budgets, or schema.
 */

import type { ToolSchedulingConfig } from "@oh-my-pi/pi-agent-core";
import { promptBlockFingerprint, resolveSessionPromptBlock } from "./prompts";
import type {
	ModelOptimizationProfile,
	ResolvedModelOptimization,
	SessionContextStrategy,
	SessionToolStrategy,
} from "./types";

export function buildToolScheduling(toolStrategy: SessionToolStrategy | undefined): ToolSchedulingConfig | undefined {
	if (!toolStrategy) return undefined;
	const max = toolStrategy.maxConcurrentTools;
	const mode = toolStrategy.resourceConflictMode;
	const hasConcurrency = typeof max === "number" && max > 0;
	if (!hasConcurrency && !mode) return undefined;
	return {
		maxConcurrentTools: hasConcurrency ? max : undefined,
		// Ordinary sessions never install stage budgets / remaining tool-call caps.
		remainingToolCalls: null,
		remainingStageTimeMs: null,
		resourceConflictMode: mode ?? "serialize",
		orderedResultWriteback: true,
	};
}

/**
 * Harden context strategy for ordinary sessions:
 * preserve user turns, never delete persisted transcript rows.
 */
export function hardenSessionContextStrategy(
	strategy: SessionContextStrategy | undefined,
): SessionContextStrategy | undefined {
	if (!strategy) return undefined;
	const eviction = strategy.eviction
		? {
				...strategy.eviction,
				preserveUserTurns: true as const,
				evictPersisted: false as const,
			}
		: undefined;
	return {
		...strategy,
		eviction,
	};
}

/** Build a full resolved policy from a profile (or empty none). */
export function buildResolvedModelOptimization(
	profile: ModelOptimizationProfile | undefined,
): ResolvedModelOptimization {
	if (!profile) return {};
	const promptBlock = resolveSessionPromptBlock(profile.promptStrategy);
	return {
		profile,
		promptBlock,
		promptBlockFingerprint: promptBlockFingerprint(promptBlock),
		toolScheduling: buildToolScheduling(profile.toolStrategy),
		contextStrategy: hardenSessionContextStrategy(profile.contextStrategy),
	};
}
