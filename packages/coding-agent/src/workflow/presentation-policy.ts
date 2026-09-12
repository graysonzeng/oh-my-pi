/**
 * Gated workflow tool/skill presentation policy.
 * Reuses xd:// discovery semantics; does not invent a second protocol.
 * Restricted sessions never discover or expand tools outside the role allowlist.
 * Default remains direct mode unless catalog mode is explicitly enabled.
 */

import type { WorkflowRole } from "./types";

export type ToolPresentationMode = "direct" | "catalog";

export interface PresentedTool {
	name: string;
	/** Full one-line summary; catalog mode includes xd:// locator in the string. */
	summary: string;
	/** When catalog mode and not essential: stable xd:// tools locator for one-hop schema read. */
	schemaLocator?: string;
	/** True when full JSON schema is attached on the wire. */
	schemaAttached: boolean;
	/** Load mode hint — essential tools stay direct even in catalog mode. */
	essential: boolean;
}

export interface PresentedSkill {
	name: string;
	/** Catalog: name + one-line + xd://skills locator; autoload/direct may omit locator. */
	summary: string;
	/** Full body only when presentation is enabled and (autoload or !skillCatalogOnly). */
	body?: string;
	/** Locator for one-hop load when body omitted. */
	bodyLocator?: string;
}

export interface WorkflowPresentationPolicy {
	/** Default false — feature flag off. */
	enabled: boolean;
	mode: ToolPresentationMode;
	/** Tool names that always get full schema (high-frequency critical). */
	essentialTools: string[];
	/** When true, skill bodies are omitted until autoload/explicit read. */
	skillCatalogOnly: boolean;
	/** Skill names whose full body is injected immediately (even when skillCatalogOnly). */
	autoloadSkills?: string[];
}

/**
 * Conservative essential set: file ops + bash only.
 * Workflow-critical tools can be added per-profile (e.g. structured artifact).
 * Non-essentials (grep/find/ls, image tools, specialized commands) stay catalog-only.
 */
/** yield is essential for structured-subagent completion (must stay top-level + full schema). */
export const CONSERVATIVE_ESSENTIAL_TOOLS: readonly string[] = ["read", "write", "edit", "bash", "yield"];

export const DEFAULT_PRESENTATION_POLICY: WorkflowPresentationPolicy = {
	enabled: false,
	mode: "direct",
	essentialTools: [...CONSERVATIVE_ESSENTIAL_TOOLS],
	skillCatalogOnly: true,
	autoloadSkills: [],
};

/** Canonical tool schema locator (presentation namespace → bridged to xd device). */
export function toolSchemaLocator(name: string): string {
	return `xd://tools/${name}`;
}

/** Canonical skill body locator (presentation namespace → bridged to skill content). */
export function skillBodyLocator(name: string): string {
	return `xd://skills/${name}`;
}

/** Catalog short description for a non-essential tool. */
export function formatToolCatalogSummary(name: string, oneLineDescription: string): string {
	const desc = oneLineDescription.trim() || name;
	return `${name}: ${desc} [Read full schema: ${toolSchemaLocator(name)}]`;
}

/** Catalog short description for a skill (body not inlined). */
export function formatSkillCatalogSummary(name: string, oneLineDescription: string): string {
	const desc = oneLineDescription.trim() || name;
	return `${name}: ${desc} [Load: ${skillBodyLocator(name)}]`;
}

export type PresentationLocator =
	| { kind: "tool"; name: string; locator: string }
	| { kind: "skill"; name: string; locator: string };

/**
 * Parse presentation / classic xd locators into a typed target.
 * Accepts: xd://tools/{name}, xd://skills/{name}, xd://{name} (tool device).
 */
export function parsePresentationLocator(input: string): PresentationLocator | null {
	const trimmed = input.trim();
	if (!trimmed.toLowerCase().startsWith("xd://")) return null;
	const rest = trimmed.slice("xd://".length);
	if (!rest || /[?#]/.test(rest)) return null;

	const toolsMatch = /^tools\/([^/]+)$/.exec(rest);
	if (toolsMatch?.[1]) {
		return { kind: "tool", name: toolsMatch[1], locator: toolSchemaLocator(toolsMatch[1]) };
	}
	const skillsMatch = /^skills\/([^/]+)$/.exec(rest);
	if (skillsMatch?.[1]) {
		return { kind: "skill", name: skillsMatch[1], locator: skillBodyLocator(skillsMatch[1]) };
	}
	// Classic xd://{device} — no nested path.
	if (rest.includes("/")) return null;
	return { kind: "tool", name: rest, locator: toolSchemaLocator(rest) };
}

export interface ExpandToolSchemaContext {
	/** Role allowlist — expand refuses tools outside this set. */
	allowedToolNames: readonly string[];
	/** Full JSON schemas keyed by tool name (pre-catalog originals). */
	schemas: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;
}

export type ExpandToolSchemaResult =
	| { ok: true; name: string; schema: unknown; schemaJson: string }
	| { ok: false; error: string; refused: boolean };

/**
 * One-hop expand for xd://tools/{name} (or classic xd://{name}).
 * Catalog mode never elevates privileges: non-allowlisted names are refused.
 */
export function expandToolSchema(locator: string, ctx: ExpandToolSchemaContext): ExpandToolSchemaResult {
	const parsed = parsePresentationLocator(locator);
	if (parsed?.kind !== "tool") {
		return { ok: false, error: `Not a tool schema locator: ${locator}`, refused: false };
	}
	const allow = new Set(ctx.allowedToolNames);
	if (!allow.has(parsed.name)) {
		return {
			ok: false,
			error: `Tool "${parsed.name}" is outside the role allowlist; catalog expand refused.`,
			refused: true,
		};
	}
	const schema = schemaFromMap(ctx.schemas, parsed.name);
	if (schema === undefined) {
		return {
			ok: false,
			error: `No full schema registered for allowlisted tool "${parsed.name}".`,
			refused: false,
		};
	}
	const schemaJson = typeof schema === "string" ? schema : JSON.stringify(schema, null, 2);
	return { ok: true, name: parsed.name, schema, schemaJson };
}

export interface ExpandSkillContext {
	/** Full skill bodies keyed by name. */
	bodies: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}

export type ExpandSkillResult = { ok: true; name: string; body: string } | { ok: false; error: string };

/** One-hop expand for xd://skills/{name}. */
export function expandSkillBody(locator: string, ctx: ExpandSkillContext): ExpandSkillResult {
	const parsed = parsePresentationLocator(locator);
	if (parsed?.kind !== "skill") {
		return { ok: false, error: `Not a skill body locator: ${locator}` };
	}
	const body = stringFromMap(ctx.bodies, parsed.name);
	if (body === undefined) {
		return { ok: false, error: `Unknown skill: ${parsed.name}` };
	}
	return { ok: true, name: parsed.name, body };
}

function schemaFromMap(map: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>, name: string): unknown {
	if (map instanceof Map) return map.get(name);
	const rec = map as Readonly<Record<string, unknown>>;
	return Object.hasOwn(rec, name) ? rec[name] : undefined;
}

function stringFromMap(
	map: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	if (map instanceof Map) return map.get(name);
	const rec = map as Readonly<Record<string, string>>;
	return Object.hasOwn(rec, name) ? rec[name] : undefined;
}

export interface ResolvePresentationOptions {
	/**
	 * Settings gate `workflow.presentationOptimization.enabled`.
	 * When true, optimization can enable without a hand-edited profile
	 * (uses catalog defaults unless the profile explicitly disables).
	 * When false/omitted, only an explicit profile `enabled: true` turns it on.
	 */
	settingsEnabled?: boolean;
}

/**
 * Resolve presentation policy from a profile field and optional settings gate.
 * Missing/invalid values keep the default (direct, feature off).
 */
export function resolveWorkflowPresentation(
	raw: Partial<WorkflowPresentationPolicy> | null | undefined,
	options?: ResolvePresentationOptions,
): WorkflowPresentationPolicy {
	const settingsOn = options?.settingsEnabled === true;
	const hasRaw = raw !== null && raw !== undefined && typeof raw === "object";
	const mode =
		hasRaw && (raw.mode === "catalog" || raw.mode === "direct")
			? raw.mode
			: settingsOn
				? "catalog"
				: DEFAULT_PRESENTATION_POLICY.mode;
	const essentialTools =
		hasRaw && Array.isArray(raw.essentialTools)
			? raw.essentialTools.filter((t): t is string => typeof t === "string")
			: DEFAULT_PRESENTATION_POLICY.essentialTools;
	const skillCatalogOnly =
		hasRaw && raw.skillCatalogOnly === false
			? false
			: hasRaw && raw.skillCatalogOnly === true
				? true
				: DEFAULT_PRESENTATION_POLICY.skillCatalogOnly;
	const autoloadSkills =
		hasRaw && Array.isArray(raw.autoloadSkills)
			? raw.autoloadSkills.filter((t): t is string => typeof t === "string" && t.length > 0)
			: DEFAULT_PRESENTATION_POLICY.autoloadSkills;

	// Enable when: explicit profile enabled, OR settings gate open without explicit disable.
	let enabled = false;
	if (hasRaw && raw.enabled === true) {
		enabled = true;
	} else if (hasRaw && raw.enabled === false) {
		enabled = false;
	} else if (settingsOn) {
		enabled = true;
	}

	return {
		enabled,
		mode: enabled ? mode : "direct",
		essentialTools: essentialTools.length > 0 ? essentialTools : [...CONSERVATIVE_ESSENTIAL_TOOLS],
		skillCatalogOnly,
		autoloadSkills,
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
	/** Stable ordered skill names. */
	skillOrder: string[];
	/** Deterministic serialization of tool presentation lines (order-stable). */
	toolPresentationText: string;
	/** Deterministic serialization of skill catalog lines. */
	skillPresentationText: string;
}

/**
 * Apply presentation policy.
 * - Tools outside allowedToolNames are hard-dropped (never appear in catalog).
 * - Catalog mode: non-essential tools get short summary + xd:// locator, no schema attach.
 * - Direct mode (default): full schema attached for all allowed tools.
 * - Order is always name-sorted (localeCompare), independent of mode.
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
		const oneLine = t.summary ?? t.name;
		if (mode === "direct" || isEssential) {
			return {
				name: t.name,
				summary: oneLine,
				schemaAttached: true,
				essential: isEssential,
			};
		}
		// Catalog: short description + xd:// one-hop (reuse virtual device namespace).
		const locator = toolSchemaLocator(t.name);
		return {
			name: t.name,
			summary: formatToolCatalogSummary(t.name, oneLine),
			schemaLocator: locator,
			schemaAttached: false,
			essential: false,
		};
	});

	const autoloadSet = new Set(policy.autoloadSkills ?? []);
	const skills: PresentedSkill[] = (input.skills ?? [])
		.map(s => {
			// Feature-off: never inject skill bodies (or xd:// skill locators) into the catalog.
			// Bodies are only for enabled presentation: all skills when !skillCatalogOnly, else autoload.
			if (!policy.enabled) {
				return {
					name: s.name,
					summary: s.summary,
					body: undefined,
				};
			}
			const isAutoload = s.autoload === true || autoloadSet.has(s.name);
			const loadBody = !policy.skillCatalogOnly || isAutoload;
			if (loadBody) {
				return {
					name: s.name,
					summary: s.summary,
					body: s.body,
				};
			}
			return {
				name: s.name,
				summary: formatSkillCatalogSummary(s.name, s.summary),
				body: undefined,
				bodyLocator: skillBodyLocator(s.name),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));

	const toolPresentationText = tools.map(t => t.summary).join("\n");
	// Feature-off: leave skill_catalog empty (do not pay body/catalog bytes for a disabled flag).
	// Feature-on: autoload / full-body skills include body in the stable skill catalog section.
	const skillPresentationText = !policy.enabled
		? ""
		: skills.map(s => (s.body ? `${s.summary}\n\n${s.body}` : s.summary)).join("\n\n");

	return {
		tools,
		skills,
		mode,
		toolOrder: tools.map(t => t.name),
		skillOrder: skills.map(s => s.name),
		toolPresentationText,
		skillPresentationText,
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

/** Stable fingerprint of presented tool order + summary strings (byte-identical check). */
export function presentationFingerprint(presented: PresentationResult): string {
	return [
		`mode=${presented.mode}`,
		`tools=${presented.toolOrder.join(",")}`,
		`skills=${presented.skillOrder.join(",")}`,
		presented.toolPresentationText,
		presented.skillPresentationText,
	].join("\n---\n");
}
