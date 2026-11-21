/**
 * W5 bridge: map real workflow prompt-assembly sections onto Experiment B
 * observe / controlled reorder at the assembly boundary (before provider send),
 * safe fingerprint observe at the final provider-serialized request boundary,
 * and a deterministic diff of consecutive observe receipts.
 *
 * Diffs keep segment kinds, fingerprints, and byte lengths only.
 * Does not claim server cache hits from client string equality.
 * claimedLiveWin stays false on mechanism receipts.
 */
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { PromptSection, PromptSectionId } from "../workflow/prompt-assembly";
import { sha256Hex } from "./stable-serialize";
import {
	type ProviderRequestSegment,
	type ProviderRequestSegmentKind,
	type StablePrefixCacheExperimentConfig,
	type StablePrefixCacheExperimentReceiptV1,
	type StablePrefixCacheMetrics,
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
export const STABLE_PREFIX_FINAL_REQUEST_OBSERVE_CUSTOM_TYPE = "stable_prefix_final_request_observe" as const;

export interface StablePrefixProviderIdentity {
	provider?: string;
	api?: string;
	model?: string;
	/** Fingerprint of tools/schemas actually present on the sent (or assembled) surface. */
	toolSchemaFingerprint?: string;
	effortFingerprint?: string;
}

export interface StablePrefixAssemblyObserveV1 {
	kind: typeof STABLE_PREFIX_OBSERVE_CUSTOM_TYPE;
	v: 1;
	applied: boolean;
	factor: StablePrefixCacheExperimentConfig["factor"];
	receipt: StablePrefixCacheExperimentReceiptV1;
	inspection: StablePrefixInspection;
	/** Provider/api/model identity when known — never raw prompt body. */
	providerIdentity: StablePrefixProviderIdentity;
	/** same_child_session vs sibling cold start labeling (client-side only). */
	scope: "same_child_session" | "sibling" | "unknown";
	/** Segment kinds + fingerprints + byte sizes (no raw prompt). */
	segments: readonly ProviderRequestSegment[];
	/** Usage association — null until associateStablePrefixObserveUsage runs. */
	metrics: StablePrefixCacheMetrics;
	claimedLiveWin: false;
	recordedAt: string;
}

/**
 * Safe observe at the final provider-serialized request boundary (onPayload).
 * Fingerprints only — never retains raw prompt/tool JSON in the receipt.
 */
export interface StablePrefixFinalRequestObserveV1 {
	kind: typeof STABLE_PREFIX_FINAL_REQUEST_OBSERVE_CUSTOM_TYPE;
	v: 1;
	boundary: "provider_final_serialize";
	applied: boolean;
	factor: StablePrefixCacheExperimentConfig["factor"];
	receipt: StablePrefixCacheExperimentReceiptV1;
	inspection: StablePrefixInspection;
	providerIdentity: StablePrefixProviderIdentity;
	scope: "same_child_session" | "sibling" | "unknown";
	segments: readonly ProviderRequestSegment[];
	metrics: StablePrefixCacheMetrics;
	/** True when tools array/object was present on the serialized payload. */
	toolSchemaFromPayload: boolean;
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
 * Stable fingerprint of tool schemas as they would be / were sent.
 * Prefer full schema objects when available; fall back to names+mode.
 */
export function fingerprintToolSchemasForSend(input: {
	names: readonly string[];
	mode?: string;
	essential?: readonly string[];
	/** Full tool schemas keyed by name (presentation / transform capture). */
	schemas?: ReadonlyMap<string, unknown> | Record<string, unknown>;
	skillsFingerprint?: string | null;
}): string {
	const schemaEntries: Array<{ name: string; schema: unknown }> = [];
	const schemas = input.schemas;
	if (schemas) {
		const asMap = schemas instanceof Map ? schemas : new Map(Object.entries(schemas));
		for (const name of [...asMap.keys()].sort()) {
			const schema = asMap.get(name);
			if (schema !== undefined) schemaEntries.push({ name, schema });
		}
	}
	return sha256Hex(
		JSON.stringify({
			names: [...input.names].sort(),
			mode: input.mode ?? null,
			essential: input.essential ? [...input.essential].sort() : null,
			schemas: schemaEntries,
			skills: input.skillsFingerprint ?? null,
		}),
	);
}

/**
 * Extract fingerprintable segments + tools fingerprint from a provider-serialized
 * payload (Anthropic / OpenAI-completions / OpenAI-responses shaped). Never returns
 * raw body text — only kinds, fingerprints, and byte lengths.
 */
export function segmentsFromFinalProviderPayload(payload: unknown): {
	segments: ProviderRequestSegment[];
	toolSchemaFingerprint: string | undefined;
	toolSchemaFromPayload: boolean;
} {
	if (!isRecord(payload)) {
		return { segments: [], toolSchemaFingerprint: undefined, toolSchemaFromPayload: false };
	}

	const segments: ProviderRequestSegment[] = [];
	let toolsRaw: unknown;
	if (Array.isArray(payload.tools)) {
		toolsRaw = payload.tools;
	} else if (isRecord(payload.tools)) {
		toolsRaw = payload.tools;
	} else if (Array.isArray(payload.functions)) {
		toolsRaw = payload.functions;
	}

	let toolSchemaFingerprint: string | undefined;
	const toolSchemaFromPayload = toolsRaw !== undefined;
	if (toolSchemaFromPayload) {
		const toolsJson = stableJson(toolsRaw);
		toolSchemaFingerprint = sha256Hex(toolsJson);
		segments.push(fingerprintProviderSegment("tools", toolsJson));
	}

	// System / instructions / static rules surfaces (no raw retention beyond hash).
	const systemParts: string[] = [];
	if (typeof payload.instructions === "string" && payload.instructions) {
		systemParts.push(payload.instructions);
	}
	if (typeof payload.system === "string" && payload.system) {
		systemParts.push(payload.system);
	} else if (Array.isArray(payload.system)) {
		for (const block of payload.system) {
			if (typeof block === "string" && block) systemParts.push(block);
			else if (isRecord(block) && typeof block.text === "string" && block.text) systemParts.push(block.text);
		}
	}
	if (systemParts.length > 0) {
		segments.push(fingerprintProviderSegment("static_rules", systemParts.join("\n\n")));
	}

	// Messages / input — dynamic + assignment mixed; treat as dynamic_context for cut detection.
	const messages = Array.isArray(payload.messages)
		? payload.messages
		: Array.isArray(payload.input)
			? payload.input
			: null;
	if (messages) {
		const serialized = stableJson(messages);
		segments.push(fingerprintProviderSegment("dynamic_context", serialized));
	}

	return { segments, toolSchemaFingerprint, toolSchemaFromPayload };
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, v) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const sorted: Record<string, unknown> = {};
			for (const key of Object.keys(v as Record<string, unknown>).sort()) {
				sorted[key] = (v as Record<string, unknown>)[key];
			}
			return sorted;
		}
		return v;
	});
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
	providerIdentity?: StablePrefixProviderIdentity;
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

	const metrics: StablePrefixCacheMetrics = {
		cacheRead: null,
		ttftMs: null,
		costTotal: null,
		scope: input.scope ?? "unknown",
		staticCutByDynamic: inspection.staticCutByDynamic,
	};
	const run = buildStablePrefixCacheExperimentRun({
		arm: applied ? "treatment" : "control",
		config: input.config,
		metrics,
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
			metrics,
			claimedLiveWin: run.claimedLiveWin,
			recordedAt: run.recordedAt,
		},
	};
}

/**
 * Safe observe at the final provider-serialized request boundary (onPayload).
 * Fingerprints payload segments + full sent tool schema when present.
 * Does not mutate the payload. claimedLiveWin stays false.
 */
export function observeStablePrefixAtFinalRequest(input: {
	payload: unknown;
	config: StablePrefixCacheExperimentConfig;
	peer?: { readDedupeEnabled?: boolean; phaseHandoffEnabled?: boolean };
	providerIdentity?: StablePrefixProviderIdentity;
	scope?: StablePrefixFinalRequestObserveV1["scope"];
	/** Assembly-boundary observe to inherit identity/effort when payload omits tools. */
	assemblyObserve?: StablePrefixAssemblyObserveV1;
}): StablePrefixFinalRequestObserveV1 {
	const resolved = resolveStablePrefixCacheExperiment(input.config, input.peer);
	const { applied, receipt } = resolved;
	const extracted = segmentsFromFinalProviderPayload(input.payload);
	const segments =
		extracted.segments.length > 0 ? extracted.segments : (input.assemblyObserve?.segments.slice() ?? []);
	const inspection = inspectProviderRequestPrefix(segments);
	const toolSchemaFingerprint =
		extracted.toolSchemaFingerprint ?? input.assemblyObserve?.providerIdentity.toolSchemaFingerprint;
	const metrics: StablePrefixCacheMetrics = {
		cacheRead: null,
		ttftMs: null,
		costTotal: null,
		scope: input.scope ?? input.assemblyObserve?.scope ?? "unknown",
		staticCutByDynamic: inspection.staticCutByDynamic,
	};
	const run = buildStablePrefixCacheExperimentRun({
		arm: applied ? "treatment" : "control",
		config: input.config,
		metrics,
	});
	const identity: StablePrefixProviderIdentity = {
		...input.assemblyObserve?.providerIdentity,
		...input.providerIdentity,
		...(toolSchemaFingerprint ? { toolSchemaFingerprint } : {}),
	};
	return {
		kind: STABLE_PREFIX_FINAL_REQUEST_OBSERVE_CUSTOM_TYPE,
		v: 1,
		boundary: "provider_final_serialize",
		applied,
		factor: input.config.factor,
		receipt,
		inspection,
		providerIdentity: identity,
		scope: metrics.scope,
		segments,
		metrics,
		toolSchemaFromPayload: extracted.toolSchemaFromPayload,
		claimedLiveWin: run.claimedLiveWin,
		recordedAt: run.recordedAt,
	};
}

/**
 * Associate real provider usage / cache / TTFT onto an observe receipt when known.
 * Leaves unknown fields null — never invents zeros. Does not claim a live win.
 */
export function associateStablePrefixObserveUsage<
	T extends { metrics: StablePrefixCacheMetrics; claimedLiveWin: false; scope: StablePrefixCacheMetrics["scope"] },
>(
	observe: T,
	usage: {
		cacheRead?: number | null;
		ttftMs?: number | null;
		costTotal?: number | null;
	},
): T {
	const cacheRead =
		typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead)
			? usage.cacheRead
			: observe.metrics.cacheRead;
	const ttftMs =
		typeof usage.ttftMs === "number" && Number.isFinite(usage.ttftMs) && usage.ttftMs >= 0
			? usage.ttftMs
			: observe.metrics.ttftMs;
	const costTotal =
		typeof usage.costTotal === "number" && Number.isFinite(usage.costTotal)
			? usage.costTotal
			: observe.metrics.costTotal;
	return {
		...observe,
		metrics: {
			...observe.metrics,
			cacheRead,
			ttftMs,
			costTotal,
			scope: observe.scope,
		},
		claimedLiveWin: false,
	};
}

/** Extract association fields from a provider Usage-like object (and optional ttft). */
export function usageMetricsFromProviderUsage(
	usage: unknown,
	ttftMs?: number | null,
): { cacheRead: number | null; ttftMs: number | null; costTotal: number | null } {
	if (!isRecord(usage)) {
		return {
			cacheRead: null,
			ttftMs: typeof ttftMs === "number" && Number.isFinite(ttftMs) && ttftMs >= 0 ? ttftMs : null,
			costTotal: null,
		};
	}
	const cacheRead = typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead) ? usage.cacheRead : null;
	const cost =
		isRecord(usage.cost) && typeof usage.cost.total === "number" && Number.isFinite(usage.cost.total)
			? usage.cost.total
			: null;
	return {
		cacheRead,
		ttftMs: typeof ttftMs === "number" && Number.isFinite(ttftMs) && ttftMs >= 0 ? ttftMs : null,
		costTotal: cost,
	};
}

export type StablePrefixMissReason =
	| "none"
	| "tool_schema_changed"
	| "static_rules_changed"
	| "dynamic_context_changed"
	| "assignment_changed"
	| "other_segment_changed"
	| "provider_identity_changed"
	| "segment_order_changed";

export type StablePrefixKindDiffStatus = "unchanged" | "changed" | "added" | "removed";

export interface StablePrefixKindDiffV1 {
	kind: ProviderRequestSegmentKind;
	status: StablePrefixKindDiffStatus;
	previousFingerprint: string | null;
	currentFingerprint: string | null;
	previousByteLength: number;
	currentByteLength: number;
	byteDelta: number;
}

/** Segment list plus provider identity. Both observe receipts satisfy this. */
export interface StablePrefixDiffableObserve {
	segments: readonly ProviderRequestSegment[];
	providerIdentity: StablePrefixProviderIdentity;
}

export interface StablePrefixObservationDiffV1 {
	v: 1;
	kinds: readonly StablePrefixKindDiffV1[];
	changedKinds: readonly ProviderRequestSegmentKind[];
	firstChangedKind: ProviderRequestSegmentKind | null;
	missReason: StablePrefixMissReason;
	unchanged: boolean;
	/** True when the leading static_rules/tools run is identical, ignoring the dynamic tail. */
	prefixPreserved: boolean;
	identityChanged: boolean;
	claimedLiveWin: false;
}

const MISS_REASON_BY_KIND: Record<ProviderRequestSegmentKind, StablePrefixMissReason> = {
	tools: "tool_schema_changed",
	static_rules: "static_rules_changed",
	dynamic_context: "dynamic_context_changed",
	assignment: "assignment_changed",
	other: "other_segment_changed",
};

const IDENTITY_FIELDS = ["provider", "api", "model", "toolSchemaFingerprint", "effortFingerprint"] as const;

function providerIdentityChanged(
	previous: StablePrefixProviderIdentity,
	current: StablePrefixProviderIdentity,
): boolean {
	for (const field of IDENTITY_FIELDS) {
		if ((previous[field] ?? null) !== (current[field] ?? null)) return true;
	}
	return false;
}

function groupSegments(
	segments: readonly ProviderRequestSegment[],
): Map<ProviderRequestSegmentKind, ProviderRequestSegment[]> {
	const grouped = new Map<ProviderRequestSegmentKind, ProviderRequestSegment[]>();
	for (const segment of segments) {
		const list = grouped.get(segment.kind);
		if (list) list.push(segment);
		else grouped.set(segment.kind, [segment]);
	}
	return grouped;
}

function kindAppearanceOrder(
	previous: readonly ProviderRequestSegment[],
	current: readonly ProviderRequestSegment[],
): ProviderRequestSegmentKind[] {
	const order: ProviderRequestSegmentKind[] = [];
	const seen = new Set<ProviderRequestSegmentKind>();
	for (const segment of [...previous, ...current]) {
		if (seen.has(segment.kind)) continue;
		seen.add(segment.kind);
		order.push(segment.kind);
	}
	return order;
}

/** One segment keeps its fingerprint. Several of one kind hash in list order. */
function aggregateFingerprint(segments: readonly ProviderRequestSegment[]): string | null {
	if (segments.length === 0) return null;
	if (segments.length === 1) return segments[0]!.fingerprint;
	return sha256Hex(JSON.stringify(segments.map(segment => [segment.fingerprint, segment.byteLength])));
}

function aggregateBytes(segments: readonly ProviderRequestSegment[]): number {
	let total = 0;
	for (const segment of segments) total += segment.byteLength;
	return total;
}

function leadingStaticPrefix(segments: readonly ProviderRequestSegment[]): readonly ProviderRequestSegment[] {
	const prefix: ProviderRequestSegment[] = [];
	for (const segment of segments) {
		if (segment.kind !== "static_rules" && segment.kind !== "tools") break;
		prefix.push(segment);
	}
	return prefix;
}

function sameSegmentSequence(
	previous: readonly ProviderRequestSegment[],
	current: readonly ProviderRequestSegment[],
): boolean {
	if (previous.length !== current.length) return false;
	for (let index = 0; index < previous.length; index++) {
		const left = previous[index]!;
		const right = current[index]!;
		if (left.kind !== right.kind || left.fingerprint !== right.fingerprint || left.byteLength !== right.byteLength) {
			return false;
		}
	}
	return true;
}

/**
 * Diff consecutive segment-bearing observe receipts.
 * Kind status walks previous order, then kinds that exist only on current.
 * Static prefix breaks (changed tools/static_rules, then static prefix reorder,
 * then provider identity) take priority over downstream dynamic shifts so
 * routine per-turn context changes do not mask upstream cache invalidation.
 * Output never copies prompt or tool bodies.
 */
export function diffStablePrefixObservations(
	previous: StablePrefixDiffableObserve,
	current: StablePrefixDiffableObserve,
): StablePrefixObservationDiffV1 {
	const previousGroups = groupSegments(previous.segments);
	const currentGroups = groupSegments(current.segments);
	const kinds: StablePrefixKindDiffV1[] = [];
	for (const kind of kindAppearanceOrder(previous.segments, current.segments)) {
		const before = previousGroups.get(kind) ?? [];
		const after = currentGroups.get(kind) ?? [];
		const previousFingerprint = aggregateFingerprint(before);
		const currentFingerprint = aggregateFingerprint(after);
		const previousByteLength = aggregateBytes(before);
		const currentByteLength = aggregateBytes(after);
		let status: StablePrefixKindDiffStatus;
		if (before.length === 0) status = "added";
		else if (after.length === 0) status = "removed";
		else if (previousFingerprint === currentFingerprint && previousByteLength === currentByteLength)
			status = "unchanged";
		else status = "changed";
		kinds.push({
			kind,
			status,
			previousFingerprint,
			currentFingerprint,
			previousByteLength,
			currentByteLength,
			byteDelta: currentByteLength - previousByteLength,
		});
	}

	const changedKinds = kinds.filter(row => row.status !== "unchanged").map(row => row.kind);
	const firstChanged = kinds.find(row => row.status !== "unchanged");
	const firstChangedStatic = kinds.find(
		row => row.status !== "unchanged" && (row.kind === "tools" || row.kind === "static_rules"),
	);
	const prefixPreserved = sameSegmentSequence(
		leadingStaticPrefix(previous.segments),
		leadingStaticPrefix(current.segments),
	);
	const identityDiffers = providerIdentityChanged(previous.providerIdentity, current.providerIdentity);
	let missReason: StablePrefixMissReason = "none";
	if (firstChangedStatic) missReason = MISS_REASON_BY_KIND[firstChangedStatic.kind];
	else if (!prefixPreserved) missReason = "segment_order_changed";
	else if (identityDiffers) missReason = "provider_identity_changed";
	else if (firstChanged) missReason = MISS_REASON_BY_KIND[firstChanged.kind];
	else if (!sameSegmentSequence(previous.segments, current.segments)) missReason = "segment_order_changed";

	return {
		v: 1,
		kinds,
		changedKinds,
		firstChangedKind: firstChanged?.kind ?? null,
		missReason,
		unchanged: missReason === "none",
		prefixPreserved,
		identityChanged: identityDiffers,
		claimedLiveWin: false,
	};
}
