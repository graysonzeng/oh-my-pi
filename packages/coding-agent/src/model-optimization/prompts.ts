/**
 * Static model-optimization prompt templates.
 * Bodies live in prompts/model-optimization/*.md and are imported as text.
 */

import conciseClaude from "../prompts/model-optimization/concise-claude.md" with { type: "text" };
import explicitGrok from "../prompts/model-optimization/explicit-grok.md" with { type: "text" };
import explicitGrokNumbered from "../prompts/model-optimization/explicit-grok-numbered.md" with { type: "text" };
import structuredGpt from "../prompts/model-optimization/structured-gpt.md" with { type: "text" };
import type { SessionPromptStrategy } from "./types";

const TEMPLATE_BODIES: Record<string, string> = {
	"concise-claude": conciseClaude,
	"structured-gpt": structuredGpt,
	"explicit-grok": explicitGrok,
	"explicit-grok-numbered": explicitGrokNumbered,
};

export function resolveSessionPromptBlock(
	strategy: SessionPromptStrategy | undefined,
	options?: { grokOverlayUnload?: boolean },
): string | undefined {
	if (!strategy) return undefined;
	let templateId = strategy.systemPromptTemplate;
	if (!templateId) return undefined;
	if (templateId === "explicit-grok" && options?.grokOverlayUnload === false) {
		templateId = "explicit-grok-numbered";
	}
	const body = TEMPLATE_BODIES[templateId];
	return body?.trim() || undefined;
}

export function promptBlockFingerprint(block: string | undefined): string | undefined {
	if (!block) return undefined;
	// ponytail: FNV-1a 32-bit is enough for cache invalidation, upgrade if collisions appear in telemetry
	let hash = 0x811c9dc5;
	for (let i = 0; i < block.length; i++) {
		hash ^= block.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}
