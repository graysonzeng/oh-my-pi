import { REQUIRED_CHECKPOINT_SUMMARY_HEADINGS } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, Usage, UserMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Creates a Codex model whose provider policy enables Harmony leak mitigation. */
export function createHarmonyMitigationModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.example/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

/** Creates a timestamped user message for agent-loop tests. */
export function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

/** Creates a timestamped mock assistant message with zero usage. */
export function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * A local (non-native) checkpoint summary that passes
 * `validateCheckpointSummaryStructure`: every required heading, in order,
 * exactly once. Local summarization rejects a bare sentence, so fixtures
 * answer with this instead. `bodies` overrides individual section bodies,
 * letting a caller plant sentinel text it can assert on later.
 */
export function checkpointSummary(
	bodies: Partial<Record<(typeof REQUIRED_CHECKPOINT_SUMMARY_HEADINGS)[number], string>> = {},
): string {
	return REQUIRED_CHECKPOINT_SUMMARY_HEADINGS.map(heading => `${heading}\n${bodies[heading] ?? "None"}`).join("\n\n");
}

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
