import conciseClaude from "../prompts/workflow/concise-claude.md" with { type: "text" };
import explicitGrok from "../prompts/workflow/explicit-grok.md" with { type: "text" };
import structuredGpt from "../prompts/workflow/structured-gpt.md" with { type: "text" };
import { renderContextTemplate } from "./context-builder";
import type { ModelProfile, PromptStrategy, WorkflowRole } from "./types";

export const SYSTEM_PROMPT_STYLES: Readonly<Record<string, string>> = {
	"concise-claude": conciseClaude,
	"structured-gpt": structuredGpt,
	"explicit-grok": explicitGrok,
	default: "",
};

const ROLE_DESCRIPTION: Record<WorkflowRole, string> = {
	planner: "produce a strict plan artifact",
	plan_reviewer: "review the plan for correctness and feasibility",
	implementer: "implement the approved plan",
	code_reviewer: "review the implementation against the plan",
	repair: "repair open findings from review",
};

/**
 * Resolve the style template body for a profile's promptStrategy.
 * Returns empty string for default/missing.
 */
export function resolveSystemPromptStyle(strategy: PromptStrategy | undefined): string {
	if (!strategy?.systemPromptTemplate || strategy.systemPromptTemplate === "default") {
		return "";
	}
	return SYSTEM_PROMPT_STYLES[strategy.systemPromptTemplate] ?? "";
}

/**
 * Stable-only style + role-policy fragments for cache-friendly prompt assembly.
 *
 * Intentionally omits assignment/requirements and stage context from the style render so
 * the stable prefix does not change when the task text changes. Dynamic task material
 * belongs in assignment / handoff / history sections.
 */
export function buildStablePromptSections(input: {
	profile: Pick<ModelProfile, "promptStrategy">;
	role: WorkflowRole;
	rolePrompt: string;
	/** Optional profile/role-stable schema text; omit task-specific free text. */
	outputSchema?: unknown;
}): {
	/** Rendered system style template (no assignment / stage context). */
	systemStatic: string;
	/** Role prompt + emphasis / thinking / instruction-format policy hints. */
	rolePolicy: string;
	styleMarker: string | null;
} {
	const strategy = input.profile.promptStrategy;
	const styleBody = resolveSystemPromptStyle(strategy);
	const styleMarker =
		styleBody.trim() && strategy?.systemPromptTemplate && strategy.systemPromptTemplate !== "default"
			? strategy.systemPromptTemplate
			: null;

	// Stable vars only: empty taskPlan/requirements/context so {{#if}} blocks stay out of the prefix.
	const systemStatic = styleBody.trim()
		? renderContextTemplate(styleBody, {
				role: input.role,
				roleDescription: ROLE_DESCRIPTION[input.role] ?? input.role,
				taskPlan: "",
				requirements: "",
				constraints: "",
				context: "",
				tools: "",
				outputSchema:
					input.outputSchema !== undefined ? JSON.stringify(input.outputSchema, null, 2).slice(0, 2000) : "",
			}).trim()
		: "";

	const emphasis =
		strategy?.roleEmphasis === "heavy"
			? "[ROLE EMPHASIS: Follow role instructions exactly. Do not deviate.]"
			: strategy?.roleEmphasis === "medium"
				? "[Follow role instructions carefully.]"
				: "";

	const thinking =
		strategy?.thinkingPrompt?.enabled && strategy.thinkingPrompt.style !== "none"
			? strategy.thinkingPrompt.style === "step-by-step"
				? "Think step-by-step before acting."
				: "Use a brief scratchpad of key decisions before acting."
			: "";

	const formatHint =
		strategy?.instructionFormat === "numbered"
			? "[INSTRUCTION FORMAT: Prefer numbered steps.]"
			: strategy?.instructionFormat === "xml-tagged"
				? "[INSTRUCTION FORMAT: Structure key sections with XML-like tags such as <plan>, <steps>, <output>.]"
				: "";

	const rolePolicy = [emphasis, thinking, formatHint, input.rolePrompt.trim()].filter(Boolean).join("\n\n");

	return { systemStatic, rolePolicy, styleMarker };
}

/**
 * Render style template vars and prepend to role context when a non-default style is configured.
 * Legacy combined blob (style + role + dynamic context). Prefer {@link buildStablePromptSections}
 * + assemblePrompt for the production prepare path so dynamic task text stays out of the stable prefix.
 */
export function applyPromptStrategy(input: {
	profile: Pick<ModelProfile, "promptStrategy">;
	role: WorkflowRole;
	rolePrompt: string;
	context?: string;
	assignment?: string;
	outputSchema?: unknown;
}): { context: string; styleMarker: string | null } {
	const stable = buildStablePromptSections({
		profile: input.profile,
		role: input.role,
		rolePrompt: input.rolePrompt,
		outputSchema: input.outputSchema,
	});

	// Dynamic material after stable parts (legacy single-blob consumers).
	// Assignment is appended when present so legacy callers still see task text.
	const dynamicParts = [
		input.assignment?.trim() ? `## Assignment\n${input.assignment.trim()}` : "",
		input.context?.trim() ?? "",
	].filter(Boolean);

	const parts = [stable.systemStatic, stable.rolePolicy, ...dynamicParts].filter(Boolean);
	return { context: parts.join("\n\n"), styleMarker: stable.styleMarker };
}

/** Built-in strategy presets for the eight quality-first models. */
export function defaultPromptStrategyForVendor(vendor: string): PromptStrategy {
	if (vendor === "anthropic") {
		return {
			kind: "concise",
			systemPromptTemplate: "concise-claude",
			fewShotPolicy: { enabled: false, maxExamples: 1, dynamicSelection: false },
			thinkingPrompt: { enabled: true, style: "scratchpad" },
			roleEmphasis: "light",
			instructionFormat: "natural",
		};
	}
	if (vendor === "openai") {
		return {
			kind: "structured",
			systemPromptTemplate: "structured-gpt",
			fewShotPolicy: { enabled: false, maxExamples: 2, dynamicSelection: false },
			roleEmphasis: "medium",
			instructionFormat: "numbered",
		};
	}
	// xai, zhipu/glm, deepseek, default — explicit instructions
	return {
		kind: "verbose",
		systemPromptTemplate: "explicit-grok",
		fewShotPolicy: { enabled: false, maxExamples: 3, dynamicSelection: false },
		thinkingPrompt: { enabled: true, style: "step-by-step" },
		roleEmphasis: "heavy",
		instructionFormat: "numbered",
	};
}
