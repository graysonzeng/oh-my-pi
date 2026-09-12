import { REQUIRED_CHECKPOINT_SUMMARY_HEADINGS } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Usage, UserMessage } from "@oh-my-pi/pi-ai";

export function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

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
