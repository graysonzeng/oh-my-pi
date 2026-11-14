/**
 * Resolve a ModelOptimizationProfile for the active concrete model.
 * Matching reuses config/model-resolver SSOT (no copied glob/fuzzy logic).
 */

import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type ModelMatchPreferences, modelMatchesSelector } from "../config/model-resolver";
import { DEFAULT_MODEL_OPTIMIZATION_PROFILES } from "./default-profiles";
import type { ModelOptimizationProfile } from "./types";

export interface ResolveModelOptimizationProfileInput {
	model: Model;
	/** Merged profile map (defaults + user overrides by id). */
	profiles: Iterable<ModelOptimizationProfile>;
	availableModels: Model[];
	preferences?: ModelMatchPreferences;
}

export interface ResolveModelOptimizationProfileResult {
	profile?: ModelOptimizationProfile;
	/** True when multiple distinct profiles tied at max priority. */
	ambiguous?: boolean;
	/** Candidate ids when ambiguous (diagnostic only). */
	candidateIds?: string[];
}

function profilePatterns(profile: ModelOptimizationProfile): string[] {
	const raw = profile.modelPattern;
	return Array.isArray(raw) ? raw : [raw];
}

function profileMatches(
	profile: ModelOptimizationProfile,
	model: Model,
	availableModels: Model[],
	preferences?: ModelMatchPreferences,
): boolean {
	for (const pattern of profilePatterns(profile)) {
		if (modelMatchesSelector(model, pattern, availableModels, preferences)) {
			return true;
		}
	}
	return false;
}

/**
 * Pick the highest-priority matching profile.
 * Same max priority across different profile ids → fail closed (no profile).
 * Does not use object insertion order as a tie-break.
 */
export function resolveModelOptimizationProfile(
	input: ResolveModelOptimizationProfileInput,
): ResolveModelOptimizationProfileResult {
	const candidates: ModelOptimizationProfile[] = [];
	for (const profile of input.profiles) {
		if (profileMatches(profile, input.model, input.availableModels, input.preferences)) {
			candidates.push(profile);
		}
	}

	if (candidates.length === 0) {
		return {};
	}

	let maxPriority = Number.NEGATIVE_INFINITY;
	for (const c of candidates) {
		const p = c.priority ?? 0;
		if (p > maxPriority) maxPriority = p;
	}

	const top = candidates.filter(c => (c.priority ?? 0) === maxPriority);
	const uniqueIds = [...new Set(top.map(c => c.id))];
	if (uniqueIds.length > 1) {
		const ambiguous: ResolveModelOptimizationProfileResult = {
			ambiguous: true,
			candidateIds: uniqueIds.sort(),
		};
		logger.warn("Model optimization profile ambiguous; applying none", {
			provider: input.model.provider,
			model: input.model.id,
			candidates: uniqueIds,
		});
		return ambiguous;
	}

	return { profile: top[0] };
}

/**
 * Merge built-in defaults with user overrides (same id replaces).
 * Does not accept workflow role profiles.
 */
export function mergeModelOptimizationProfiles(
	userProfiles: Record<string, Partial<ModelOptimizationProfile> | ModelOptimizationProfile> | undefined,
): ModelOptimizationProfile[] {
	const merged = new Map<string, ModelOptimizationProfile>();
	for (const profile of Object.values(DEFAULT_MODEL_OPTIMIZATION_PROFILES)) {
		merged.set(profile.id, profile);
	}
	if (userProfiles) {
		for (const [id, partial] of Object.entries(userProfiles)) {
			const base = merged.get(id);
			const next: ModelOptimizationProfile = {
				id,
				modelPattern: partial.modelPattern ?? base?.modelPattern ?? id,
				priority: partial.priority ?? base?.priority,
				promptStrategy: partial.promptStrategy ?? base?.promptStrategy,
				toolStrategy: partial.toolStrategy ?? base?.toolStrategy,
				contextStrategy: partial.contextStrategy ?? base?.contextStrategy,
				contextBudgetCandidate: partial.contextBudgetCandidate ?? base?.contextBudgetCandidate,
			};
			merged.set(id, next);
		}
	}
	return [...merged.values()];
}
