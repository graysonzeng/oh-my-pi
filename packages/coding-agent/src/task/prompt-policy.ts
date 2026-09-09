import { bareModelId, parseOpenAIModel, semverEqual } from "@oh-my-pi/pi-catalog/identity";

export type SystemPromptPolicy = "default" | "codex" | "astra";

/**
 * Model-specific system-prompt policy. GPT-5.6 keeps Codex task guidance;
 * GPT-6.0 base (including `gpt-6-astra`) selects the Astra template.
 * Mini/codex/other versions stay on the default template.
 */
export function getSystemPromptPolicy(modelId: string | undefined): SystemPromptPolicy {
	if (!modelId) return "default";
	const parsed = parseOpenAIModel(bareModelId(modelId));
	if (!parsed) return "default";
	if (semverEqual(parsed.version, "5.6")) return "codex";
	if (semverEqual(parsed.version, "6.0") && parsed.variant === "base") return "astra";
	return "default";
}
