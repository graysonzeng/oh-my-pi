/**
 * Build runtime policy adapters from a resolved ModelOptimizationProfile.
 * Ordinary sessions only: no aliases, permissions, budgets, or schema.
 */

import type { ToolSchedulingConfig } from "@oh-my-pi/pi-agent-core";
import {
	type AdaptedCompiledPolicy,
	attachCompiledPolicyShadow,
	compiledDescriptorToOrdinaryDecision,
} from "../model-policy/adapters";
import { promptBlockFingerprint, resolveSessionPromptBlock } from "./prompts";
import {
	type ContextBudgetCandidateV1,
	type ContextBudgetTuningDecisionV1,
	type DescriptorPlacementDecision,
	type ModelOptimizationProfile,
	ORDINARY_DECISION_RECEIPT_KIND,
	ORDINARY_DECISION_RECEIPT_VERSION,
	type OrdinaryAppliedFields,
	type OrdinaryDecisionReceiptV1,
	type ResolvedModelOptimization,
	type SessionContextStrategy,
	type SessionToolStrategy,
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

function contextBudgetDecision(
	strategy: SessionContextStrategy | undefined,
	candidate: ContextBudgetCandidateV1 | undefined,
	applied: boolean,
): ContextBudgetTuningDecisionV1 {
	return {
		applied,
		version: candidate?.version,
		targetUtilization: strategy?.targetUtilization,
		keepRecentN: strategy?.eviction?.keepRecentN,
		maxToolCalls: strategy?.toolHistory?.maxToolCalls,
	};
}

function isValidContextBudgetCandidate(
	candidate: ContextBudgetCandidateV1 | undefined,
): candidate is ContextBudgetCandidateV1 {
	return (
		candidate?.version === 1 &&
		Number.isFinite(candidate.targetUtilization) &&
		candidate.targetUtilization > 0 &&
		candidate.targetUtilization < 1 &&
		Number.isInteger(candidate.keepRecentN) &&
		candidate.keepRecentN > 0 &&
		Number.isInteger(candidate.maxToolCalls) &&
		candidate.maxToolCalls > 0
	);
}

/** Apply a known profile candidate only when its frozen arm gate is enabled. */
export function applyContextBudgetCandidate(
	resolved: ResolvedModelOptimization,
	armEnabled: boolean,
): ResolvedModelOptimization {
	const candidate = resolved.profile?.contextBudgetCandidate;
	if (!resolved.profile && !resolved.contextStrategy && !candidate) return resolved;
	if (!armEnabled || !isValidContextBudgetCandidate(candidate)) {
		return {
			...resolved,
			contextBudgetTuning: contextBudgetDecision(resolved.contextStrategy, candidate, false),
		};
	}
	const contextStrategy = hardenSessionContextStrategy({
		targetUtilization: candidate.targetUtilization,
		eviction: {
			enabled: true,
			preserveUserTurns: true,
			evictPersisted: false,
			keepRecentN: candidate.keepRecentN,
		},
		toolHistory: { maxToolCalls: candidate.maxToolCalls, summarizeOld: true },
	});
	return {
		...resolved,
		contextStrategy,
		contextBudgetTuning: contextBudgetDecision(contextStrategy, candidate, true),
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

/**
 * Attach capability-compiled shadow/active policy to an ordinary resolved profile.
 * Profile prompt/tool/context remain authoritative while compilerActive is false.
 * When compilerActive, known-safe ceilings (concurrency) may tighten existing seams.
 */
export function withOrdinaryCompiledPolicy(
	resolved: ResolvedModelOptimization,
	adapted: AdaptedCompiledPolicy | undefined,
): ResolvedModelOptimization {
	const attached = attachCompiledPolicyShadow(resolved, adapted);
	if (!attached.compilerActive || !attached.compiledPolicy) {
		return attached;
	}

	if (attached.activeLever === "tool_concurrency_ceiling") {
		const ceiling = attached.compiledPolicy.tools.maxConcurrentTools;
		let toolScheduling = attached.toolScheduling;
		if (toolScheduling) {
			const current = toolScheduling.maxConcurrentTools;
			toolScheduling = {
				...toolScheduling,
				maxConcurrentTools: typeof current === "number" ? Math.min(current, ceiling) : ceiling,
			};
		} else if (ceiling === 1) {
			toolScheduling = {
				maxConcurrentTools: 1,
				remainingToolCalls: null,
				remainingStageTimeMs: null,
				resourceConflictMode: "serialize",
				orderedResultWriteback: true,
			};
		}
		return { ...attached, toolScheduling };
	}

	return attached;
}

/** Map compiled placement into ordinary decision when compiler is active. */
export function ordinaryDescriptorFromCompiled(
	resolved: ResolvedModelOptimization,
	liveDecision: DescriptorPlacementDecision,
): DescriptorPlacementDecision {
	if (!resolved.compilerActive || resolved.activeLever !== "descriptor_placement" || !resolved.compiledPolicy) {
		return liveDecision;
	}
	return compiledDescriptorToOrdinaryDecision(resolved.compiledPolicy.tools.descriptorPlacement);
}

export function describeOrdinaryAppliedFields(
	resolved: ResolvedModelOptimization,
	descriptorPlacement: DescriptorPlacementDecision,
): OrdinaryAppliedFields {
	const tool = resolved.profile?.toolStrategy as SessionToolStrategy | undefined;
	return {
		promptBlock: Boolean(resolved.promptBlock?.trim()),
		toolScheduling: resolved.toolScheduling !== undefined,
		outputTruncation: tool?.outputTruncation?.enabled === true,
		resultSummarization: tool?.resultSummarization?.enabled === true,
		contextStrategy: resolved.contextStrategy !== undefined,
		contextBudgetTuning: resolved.contextBudgetTuning?.applied === true,
		descriptorPlacement,
	};
}

export function buildOrdinaryDecisionReceipt(input: {
	provider?: string;
	model?: string;
	resolved: ResolvedModelOptimization;
	descriptorPlacement: DescriptorPlacementDecision;
	toolCallId?: string;
	tool?: string;
	toolTransform?: string;
	originalBytes?: number;
	visibleBytes?: number;
	recoveryUri?: string;
}): OrdinaryDecisionReceiptV1 {
	const strategy = input.resolved.contextStrategy;
	const contextBudgetTuning =
		input.resolved.contextBudgetTuning ??
		(input.resolved.profile || strategy
			? contextBudgetDecision(strategy, input.resolved.profile?.contextBudgetCandidate, false)
			: { applied: false });
	return {
		schemaVersion: ORDINARY_DECISION_RECEIPT_VERSION,
		kind: ORDINARY_DECISION_RECEIPT_KIND,
		createdAt: new Date().toISOString(),
		provider: input.provider,
		model: input.model,
		profileId: input.resolved.profile?.id,
		applied: describeOrdinaryAppliedFields(input.resolved, input.descriptorPlacement),
		toolCallId: input.toolCallId,
		tool: input.tool,
		toolTransform: input.toolTransform,
		originalBytes: input.originalBytes,
		visibleBytes: input.visibleBytes,
		recoveryUri: input.recoveryUri,
		contextDecision: strategy
			? {
					targetUtilization: strategy.targetUtilization,
					toolHistoryMaxToolCalls: strategy.toolHistory?.maxToolCalls ?? strategy.eviction?.keepRecentN,
					providerViewOnly: true,
				}
			: undefined,
		contextBudgetTuning,
	};
}
