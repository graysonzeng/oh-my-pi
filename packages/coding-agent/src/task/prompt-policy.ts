import { bareModelId, parseOpenAIModel, semverEqual } from "@oh-my-pi/pi-catalog/identity";

export type SystemPromptPolicy = "default" | "codex" | "astra" | "concise";

/**
 * Model-specific system-prompt policy. GPT-5.6 keeps Codex task guidance;
 * GPT-6.0 base (including `gpt-6-astra`), Grok 4.6, and DeepSeek Flash
 * (`deepseek-flash`, legacy `deepseek-v4-flash`) share concise guidance.
 * Other models keep their existing template.
 */
export function getSystemPromptPolicy(modelId: string | undefined): SystemPromptPolicy {
	if (!modelId) return "default";
	const bareId = bareModelId(modelId);
	if (bareId === "grok-4.6" || bareId === "deepseek-v4-flash" || bareId === "deepseek-flash") return "concise";
	const parsed = parseOpenAIModel(bareId);
	if (!parsed) return "default";
	if (semverEqual(parsed.version, "5.6")) return "codex";
	if (semverEqual(parsed.version, "6.0") && parsed.variant === "base") return "astra";
	return "default";
}
