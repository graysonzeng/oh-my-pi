/**
 * W5 bridge: map real workflow prompt-assembly sections onto Experiment B
 * observe / controlled reorder at the assembly boundary (before provider send).
 *
 * Does not claim server cache hits from client string equality.
 * claimedLiveWin stays false on mechanism receipts.
 */
import type { PromptSection, PromptSectionId } from "../workflow/prompt-assembly";
import {
	type ProviderRequestSegment,
	type ProviderRequestSegmentKind,
	type StablePrefixCacheExperimentConfig,
	type StablePrefixCacheExperimentReceiptV1,
	type StablePrefixInspection,
	buildStablePrefixCacheExperimentRun,
	fingerprintProviderSegment,
	inspectProviderRequestPrefix,
	planStablePrefixOrder,
	resolveStablePrefixCacheExperiment,
} from "./stable-prefix-cache-experiment";

const SECTION_KIND: Record<PromptSectionId, ProviderRequestSegmentKind> = {
	system_static: "static_rules",
	role_policy: "static_rules",
	tool_presentation: "tools",
	skill_catalog: "static_rules",
	assignment: "assignment",
	repo_map: "dynamic_context",
	handoff: "dynamic_context",
	history: "dynamic_context",
};

export const STABLE_PREFIX_OBSERVE_CUSTOM_TYPE = "stable_prefix_cache_observe" as const;

export interface StablePrefixAssemblyObserveV1 {
	kind: typeof STABLE_PREFIX_OBSERVE_CUSTOM_TYPE;
	v: 1;
	applied: boolean;
	factor: StablePrefixCacheExperimentConfig["factor"];
	receipt: StablePrefixCacheExperimentReceiptV1;
	inspection: StablePrefixInspection;
	/** Provider/api/model identity when known — never raw prompt body. */
	providerIdentity: {
		provider?: string;
		api?: string;
		model?: string;
		toolSchemaFingerprint?: string;
		effortFingerprint?: string;
	};
	/** same_child_session vs sibling cold start labeling (client-side only). */
	scope: "same_child_session" | "sibling" | "unknown";
	/** Segment kinds + fingerprints + byte sizes (no raw prompt). */
	segments: readonly ProviderRequestSegment[];
	claimedLiveWin: false;
	recordedAt: string;
}

/** Map assembled prompt sections to provider-bound segment fingerprints. */
export function segmentsFromPromptSections(sections: readonly PromptSection[]): ProviderRequestSegment[] {
	const out: ProviderRequestSegment[] = [];
	for (const section of sections) {
		if (!section.content) continue;
		const kind = SECTION_KIND[section.id] ?? "other";
		out.push(fingerprintProviderSegment(kind, section.content));
	}
	return out;
}

/**
 * Observe (and optionally reorder section list) at the safe assembly boundary.
 * Reorder only when factor === reorder_static_prefix and experiment applies;
 * never moves roles/tools/permissions semantics — only static_rules/tools ahead
 * of dynamic segments in the fingerprint/order plan used by callers.
 */
export function observeStablePrefixAtAssembly(input: {
	sections: readonly PromptSection[];
	config: StablePrefixCacheExperimentConfig;
	peer?: { readDedupeEnabled?: boolean; phaseHandoffEnabled?: boolean };
	providerIdentity?: StablePrefixAssemblyObserveV1["providerIdentity"];
	scope?: StablePrefixAssemblyObserveV1["scope"];
}): {
	/** Sections in original or planned order (content unchanged). */
	sections: PromptSection[];
	observe: StablePrefixAssemblyObserveV1;
	/** True only when reorder_static_prefix actually reordered. */
	reordered: boolean;
} {
	const resolved = resolveStablePrefixCacheExperiment(input.config, input.peer);
	let { applied, receipt } = resolved;
	const segments = segmentsFromPromptSections(input.sections);
	const planned =
		applied && receipt.factor === "reorder_static_prefix"
			? planStablePrefixOrder(segments, input.config, input.peer)
			: segments.slice();
	const inspection = inspectProviderRequestPrefix(applied ? planned : segments);

	let sections = input.sections.map(s => ({ ...s }));
	let reordered = false;
	if (applied && receipt.factor === "reorder_static_prefix") {
		const staticIds = new Set<PromptSectionId>([
			"system_static",
			"role_policy",
			"tool_presentation",
			"skill_catalog",
		]);
		const staticSecs = sections.filter(s => staticIds.has(s.id) && s.content);
		const rest = sections.filter(s => !staticIds.has(s.id) || !s.content);
		const next = [...staticSecs, ...rest];
		reordered = next.length === sections.length && next.some((s, i) => s.id !== sections[i]!.id);
		sections = next;
		// Honesty: reorder_static_prefix must not claim applied when treatment === control.
		if (!reordered) {
			applied = false;
			receipt = {
				...receipt,
				applied: false,
			};
			delete (receipt as { fallbackReason?: StablePrefixCacheExperimentReceiptV1["fallbackReason"] }).fallbackReason;
		}
	}

	const run = buildStablePrefixCacheExperimentRun({
		arm: applied ? "treatment" : "control",
		config: input.config,
		metrics: {
			cacheRead: null,
			ttftMs: null,
			costTotal: null,
			scope: input.scope ?? "unknown",
			staticCutByDynamic: inspection.staticCutByDynamic,
		},
	});

	return {
		sections,
		reordered,
		observe: {
			kind: STABLE_PREFIX_OBSERVE_CUSTOM_TYPE,
			v: 1,
			applied,
			factor: input.config.factor,
			receipt,
			inspection,
			providerIdentity: input.providerIdentity ?? {},
			scope: input.scope ?? "unknown",
			segments: applied && receipt.factor === "reorder_static_prefix" ? planned : segments,
			claimedLiveWin: run.claimedLiveWin,
			recordedAt: run.recordedAt,
		},
	};
}
