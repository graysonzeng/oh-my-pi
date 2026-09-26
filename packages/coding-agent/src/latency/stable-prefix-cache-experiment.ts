/**
 * Experiment B — do stable prefixes actually improve cache hits? (Package 4)
 *
 * Opt-in single-factor surface that inspects what the provider actually receives.
 * Separate from the read-dedupe experiment — do not attribute results together.
 * Default off: production prompt/tool assembly unchanged. Does not auto-run
 * paid traffic; receipts never claim a live win by themselves.
 */

import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { sha256Hex } from "./stable-serialize";

export const STABLE_PREFIX_CACHE_EXPERIMENT_KIND = "stable_prefix_cache_experiment" as const;
export const STABLE_PREFIX_CACHE_EXPERIMENT_VERSION = 1 as const;
export const STABLE_PREFIX_CACHE_EXPERIMENT_RUN_KIND = "stable_prefix_cache_experiment_run" as const;

export const STABLE_PREFIX_CACHE_FACTORS = ["none", "inspect_provider_prefix", "reorder_static_prefix"] as const;
export type StablePrefixCacheFactor = (typeof STABLE_PREFIX_CACHE_FACTORS)[number];

export type StablePrefixCacheFallbackReason = "disabled" | "factor_none" | "multi_factor_rejected" | "unknown_factor";

export type ProviderRequestSegmentKind = "static_rules" | "tools" | "dynamic_context" | "assignment" | "other";

export interface ProviderRequestSegment {
	kind: ProviderRequestSegmentKind;
	/** Stable fingerprint of segment bytes (not raw prompt text in reports). */
	fingerprint: string;
	/** Byte length of the segment as serialized to the provider. */
	byteLength: number;
}

export interface StablePrefixCacheExperimentConfig {
	enabled: boolean;
	factor: StablePrefixCacheFactor;
}

export interface StablePrefixInspection {
	/** True when a dynamic segment appears before a static_rules/tools segment. */
	staticCutByDynamic: boolean;
	/** Index of first dynamic segment; null if none. */
	firstDynamicIndex: number | null;
	/** Index of first static_rules or tools segment; null if none. */
	firstStaticIndex: number | null;
	segmentCount: number;
	prefixFingerprint: string;
}

export interface StablePrefixCacheExperimentReceiptV1 {
	kind: typeof STABLE_PREFIX_CACHE_EXPERIMENT_KIND;
	v: typeof STABLE_PREFIX_CACHE_EXPERIMENT_VERSION;
	enabled: boolean;
	factor: StablePrefixCacheFactor;
	applied: boolean;
	fallbackReason?: StablePrefixCacheFallbackReason;
	/** Always false — permissions / instruction priority / tools must stay unchanged. */
	permissionsChanged: false;
	instructionPriorityChanged: false;
	toolsChanged: false;
	configFingerprint: string;
}

export interface StablePrefixCacheMetrics {
	cacheRead: number | null;
	ttftMs: number | null;
	costTotal: number | null;
	/** same_child_session vs sibling request comparison scope. */
	scope: "same_child_session" | "sibling" | "unknown";
	staticCutByDynamic: boolean | null;
}

export interface StablePrefixCacheExperimentRunV1 {
	kind: typeof STABLE_PREFIX_CACHE_EXPERIMENT_RUN_KIND;
	v: 1;
	arm: "control" | "treatment";
	factor: StablePrefixCacheFactor;
	metrics: StablePrefixCacheMetrics;
	claimedLiveWin: false;
	configFingerprint: string;
	recordedAt: string;
}

function isFactor(value: unknown): value is StablePrefixCacheFactor {
	return typeof value === "string" && (STABLE_PREFIX_CACHE_FACTORS as readonly string[]).includes(value);
}

function fingerprintConfig(config: StablePrefixCacheExperimentConfig): string {
	return sha256Hex(JSON.stringify({ enabled: config.enabled, factor: config.factor }));
}

export function parseStablePrefixCacheExperimentConfig(raw: unknown): StablePrefixCacheExperimentConfig {
	if (!isRecord(raw)) return { enabled: false, factor: "none" };
	const enabled = raw.enabled === true;
	const factor = isFactor(raw.factor) ? raw.factor : "none";
	return { enabled, factor };
}

export function defaultStablePrefixCacheExperimentConfig(): StablePrefixCacheExperimentConfig {
	return { enabled: false, factor: "none" };
}

export function assertSingleStablePrefixFactor(
	config: StablePrefixCacheExperimentConfig,
	peer?: { readDedupeEnabled?: boolean; phaseHandoffEnabled?: boolean },
): StablePrefixCacheFallbackReason | null {
	if (!config.enabled) return "disabled";
	if (peer?.readDedupeEnabled === true || peer?.phaseHandoffEnabled === true) return "multi_factor_rejected";
	if (config.factor === "none") return "factor_none";
	if (!isFactor(config.factor)) return "unknown_factor";
	return null;
}

export function resolveStablePrefixCacheExperiment(
	config: StablePrefixCacheExperimentConfig,
	peer?: { readDedupeEnabled?: boolean; phaseHandoffEnabled?: boolean },
): {
	applied: boolean;
	receipt: StablePrefixCacheExperimentReceiptV1;
} {
	const fallback = assertSingleStablePrefixFactor(config, peer);
	if (fallback) {
		return {
			applied: false,
			receipt: {
				kind: STABLE_PREFIX_CACHE_EXPERIMENT_KIND,
				v: STABLE_PREFIX_CACHE_EXPERIMENT_VERSION,
				enabled: config.enabled,
				factor: config.factor,
				applied: false,
				fallbackReason: fallback,
				permissionsChanged: false,
				instructionPriorityChanged: false,
				toolsChanged: false,
				configFingerprint: fingerprintConfig(config),
			},
		};
	}
	return {
		applied: true,
		receipt: {
			kind: STABLE_PREFIX_CACHE_EXPERIMENT_KIND,
			v: STABLE_PREFIX_CACHE_EXPERIMENT_VERSION,
			enabled: true,
			factor: config.factor,
			applied: true,
			permissionsChanged: false,
			instructionPriorityChanged: false,
			toolsChanged: false,
			configFingerprint: fingerprintConfig(config),
		},
	};
}

/** Inspect provider-bound segment order (what the provider receives). */
export function inspectProviderRequestPrefix(segments: readonly ProviderRequestSegment[]): StablePrefixInspection {
	let firstDynamicIndex: number | null = null;
	let firstStaticIndex: number | null = null;
	let staticCutByDynamic = false;
	for (let i = 0; i < segments.length; i++) {
		const kind = segments[i]!.kind;
		if ((kind === "dynamic_context" || kind === "assignment") && firstDynamicIndex === null) {
			firstDynamicIndex = i;
		}
		if (kind === "static_rules" || kind === "tools") {
			if (firstStaticIndex === null) firstStaticIndex = i;
			if (firstDynamicIndex !== null) staticCutByDynamic = true;
		}
	}
	const prefixFingerprint = sha256Hex(
		JSON.stringify(segments.map(s => ({ kind: s.kind, fingerprint: s.fingerprint, byteLength: s.byteLength }))),
	);
	return {
		staticCutByDynamic,
		firstDynamicIndex,
		firstStaticIndex,
		segmentCount: segments.length,
		prefixFingerprint,
	};
}

/**
 * Plan a cache-friendlier order: static rules + tools first, then dynamic.
 * Only applied when factor === reorder_static_prefix and experiment is applied.
 * Does not mutate production assembly when disabled.
 */
export function planStablePrefixOrder(
	segments: readonly ProviderRequestSegment[],
	config: StablePrefixCacheExperimentConfig,
	peer?: { readDedupeEnabled?: boolean; phaseHandoffEnabled?: boolean },
): ProviderRequestSegment[] {
	const { applied, receipt } = resolveStablePrefixCacheExperiment(config, peer);
	if (!applied || receipt.factor !== "reorder_static_prefix") {
		return segments.slice();
	}
	const staticSegs = segments.filter(s => s.kind === "static_rules" || s.kind === "tools");
	const rest = segments.filter(s => s.kind !== "static_rules" && s.kind !== "tools");
	return [...staticSegs, ...rest];
}

export function buildStablePrefixCacheExperimentRun(input: {
	arm: "control" | "treatment";
	config: StablePrefixCacheExperimentConfig;
	metrics: StablePrefixCacheMetrics;
}): StablePrefixCacheExperimentRunV1 {
	return {
		kind: STABLE_PREFIX_CACHE_EXPERIMENT_RUN_KIND,
		v: 1,
		arm: input.arm,
		factor: input.config.factor,
		metrics: input.metrics,
		claimedLiveWin: false,
		configFingerprint: fingerprintConfig(input.config),
		recordedAt: new Date().toISOString(),
	};
}

/** Build a segment fingerprint without retaining raw prompt text. */
export function fingerprintProviderSegment(
	kind: ProviderRequestSegmentKind,
	bytes: string | Uint8Array,
): ProviderRequestSegment {
	const data = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
	return {
		kind,
		fingerprint: sha256Hex(data),
		byteLength: typeof bytes === "string" ? Buffer.byteLength(bytes, "utf8") : bytes.byteLength,
	};
}
