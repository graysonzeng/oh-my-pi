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
 * Render style template vars and prepend to role context when a non-default style is configured.
 */
export function applyPromptStrategy(input: {
	profile: Pick<ModelProfile, "promptStrategy">;
	role: WorkflowRole;
	rolePrompt: string;
	context?: string;
	assignment?: string;
	outputSchema?: unknown;
}): { context: string; styleMarker: string | null } {
	const strategy = input.profile.promptStrategy;
	const styleBody = resolveSystemPromptStyle(strategy);
	if (!styleBody.trim()) {
		const ctx = [input.rolePrompt.trim(), input.context?.trim()].filter(Boolean).join("\n\n");
		return { context: ctx, styleMarker: null };
	}

	const styleMarker = strategy?.systemPromptTemplate ?? "custom";
	const rendered = renderContextTemplate(styleBody, {
		role: input.role,
		roleDescription: ROLE_DESCRIPTION[input.role] ?? input.role,
		taskPlan: "",
		requirements: input.assignment ?? "",
		constraints: "",
		context: input.context ?? "",
		tools: "",
		outputSchema: input.outputSchema !== undefined ? JSON.stringify(input.outputSchema, null, 2).slice(0, 2000) : "",
	});

	const emphasis =
		strategy?.roleEmphasis === "heavy"
			? "\n[ROLE EMPHASIS: Follow role instructions exactly. Do not deviate.]\n"
			: strategy?.roleEmphasis === "medium"
				? "\n[Follow role instructions carefully.]\n"
				: "";

	const thinking =
		strategy?.thinkingPrompt?.enabled && strategy.thinkingPrompt.style !== "none"
			? strategy.thinkingPrompt.style === "step-by-step"
				? "\nThink step-by-step before acting.\n"
				: "\nUse a brief scratchpad of key decisions before acting.\n"
			: "";

	const parts = [
		rendered.trim(),
		emphasis.trim(),
		thinking.trim(),
		input.rolePrompt.trim(),
		input.context?.trim(),
	].filter(Boolean);
	return { context: parts.join("\n\n"), styleMarker };
}

/** Built-in strategy presets for the eight quality-first models. */
export function defaultPromptStrategyForVendor(vendor: string): PromptStrategy {
	if (vendor === "anthropic") {
		return {
			kind: "concise",
			systemPromptTemplate: "concise-claude",
			fewShotPolicy: { enabled: true, maxExamples: 1, dynamicSelection: true },
			thinkingPrompt: { enabled: true, style: "scratchpad" },
			roleEmphasis: "light",
			instructionFormat: "natural",
		};
	}
	if (vendor === "openai") {
		return {
			kind: "structured",
			systemPromptTemplate: "structured-gpt",
			fewShotPolicy: { enabled: true, maxExamples: 2, dynamicSelection: true },
			roleEmphasis: "medium",
			instructionFormat: "numbered",
		};
	}
	// xai, zhipu/glm, deepseek, default — explicit instructions
	return {
		kind: "verbose",
		systemPromptTemplate: "explicit-grok",
		fewShotPolicy: { enabled: true, maxExamples: 3, dynamicSelection: true },
		thinkingPrompt: { enabled: true, style: "step-by-step" },
		roleEmphasis: "heavy",
		instructionFormat: "numbered",
	};
}
