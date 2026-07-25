/**
 * Gated workflow tool/skill presentation policy.
 * Reuses xd:// discovery semantics conceptually; does not invent a second protocol.
 * Restricted sessions never discover tools outside the role allowlist.
 * Default remains direct mode unless catalog mode is explicitly enabled.
 */

import type { WorkflowRole } from "./types";

export type ToolPresentationMode = "direct" | "catalog";

export interface PresentedTool {
	name: string;
	/** Full schema when mode=direct or tool is essential; short summary when catalog-only. */
	summary: string;
	/** When catalog mode and not direct: stable xd:// style locator for one-hop schema read. */
	schemaLocator?: string;
	/** True when full JSON schema is attached on the wire. */
	schemaAttached: boolean;
	/** Load mode hint — essential tools stay direct even in catalog mode. */
	essential: boolean;
}

export interface PresentedSkill {
	name: string;
	summary: string;
	/** Full body only when autoload or explicitly loaded. */
	body?: string;
}

export interface WorkflowPresentationPolicy {
	/** Default false — feature flag off. */
	enabled: boolean;
	mode: ToolPresentationMode;
	/** Tool names that always get full schema (high-frequency critical). */
	essentialTools: string[];
	/** When true, skill bodies are omitted until autoload/explicit read. */
	skillCatalogOnly: boolean;
}

export const DEFAULT_PRESENTATION_POLICY: WorkflowPresentationPolicy = {
	enabled: false,
	mode: "direct",
	essentialTools: ["read", "bash", "edit", "write", "grep", "apply_patch", "yield"],
	skillCatalogOnly: true,
};

/**
 * Resolve presentation policy from a profile field or session settings blob.
 * Missing/invalid values keep the default (direct, feature off).
 */
export function resolveWorkflowPresentation(
	raw: Partial<WorkflowPresentationPolicy> | null | undefined,
): WorkflowPresentationPolicy {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_PRESENTATION_POLICY };
	const mode = raw.mode === "catalog" || raw.mode === "direct" ? raw.mode : DEFAULT_PRESENTATION_POLICY.mode;
	const essentialTools = Array.isArray(raw.essentialTools)
		? raw.essentialTools.filter((t): t is string => typeof t === "string")
		: DEFAULT_PRESENTATION_POLICY.essentialTools;
	return {
		enabled: raw.enabled === true,
		mode,
		essentialTools: essentialTools.length > 0 ? essentialTools : DEFAULT_PRESENTATION_POLICY.essentialTools,
		skillCatalogOnly: raw.skillCatalogOnly !== false,
	};
}

export interface PresentationInput {
	policy: WorkflowPresentationPolicy;
	/** Role allowlist — absolute max discovery set for restricted children. */
	allowedToolNames: readonly string[];
	/** Full tool descriptors available to the session before presentation filter. */
	tools: Array<{ name: string; summary?: string; essential?: boolean }>;
	skills?: Array<{ name: string; summary: string; body?: string; autoload?: boolean }>;
	/** Optional role for stable ordering hints. */
	role?: WorkflowRole;
}

export interface PresentationResult {
	tools: PresentedTool[];
	skills: PresentedSkill[];
	mode: ToolPresentationMode;
	/** Stable ordered names for fingerprinting. */
	toolOrder: string[];
}

/**
 * Apply presentation policy.
 * - Tools outside allowedToolNames are hard-dropped (never appear in catalog).
 * - Catalog mode: non-essential tools get short summary + xd:// locator, no schema attach.
 * - Direct mode (default): full schema attached for all allowed tools.
 */
export function applyPresentationPolicy(input: PresentationInput): PresentationResult {
	const policy = input.policy;
	const allow = new Set(input.allowedToolNames);
	const essential = new Set(policy.essentialTools);

	// Hard filter: restricted allowlist is the ceiling.
	const visible = input.tools.filter(t => allow.has(t.name));
	// Stable sort by name for cache-friendly prefix.
	visible.sort((a, b) => a.name.localeCompare(b.name));

	const mode: ToolPresentationMode = policy.enabled ? policy.mode : "direct";

	const tools: PresentedTool[] = visible.map(t => {
		const isEssential = t.essential === true || essential.has(t.name);
		if (mode === "direct" || isEssential) {
			return {
				name: t.name,
				summary: t.summary ?? t.name,
				schemaAttached: true,
				essential: isEssential,
			};
		}
		// Catalog: short description + xd:// one-hop (reuse virtual device namespace).
		return {
			name: t.name,
			summary: t.summary ?? t.name,
			schemaLocator: `xd://tools/${t.name}`,
			schemaAttached: false,
			essential: false,
		};
	});

	const skills: PresentedSkill[] = (input.skills ?? [])
		.map(s => {
			const loadBody = !policy.enabled || !policy.skillCatalogOnly || s.autoload === true;
			return {
				name: s.name,
				summary: s.summary,
				body: loadBody ? s.body : undefined,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));

	return {
		tools,
		skills,
		mode,
		toolOrder: tools.map(t => t.name),
	};
}

/** Assert restricted child cannot see tools beyond allowlist (contract helper). */
export function assertRestrictedToolDiscovery(
	presented: PresentationResult,
	allowedToolNames: readonly string[],
): { ok: true } | { ok: false; leaked: string[] } {
	const allow = new Set(allowedToolNames);
	const leaked = presented.tools.map(t => t.name).filter(n => !allow.has(n));
	return leaked.length === 0 ? { ok: true } : { ok: false, leaked };
}
