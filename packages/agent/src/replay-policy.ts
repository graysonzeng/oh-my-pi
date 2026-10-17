import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";

type ReplayOwner = Pick<Model, "provider" | "id" | "api">;

/** Detects API-level provider refusals that are terminal errors, not dialogue to replay. */
export function isProviderRefusalMessage(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const stopType = message.stopDetails?.type;
	return stopType === "refusal" || stopType === "sensitive";
}

/**
 * Build a provider-only view of a foreign assistant turn.
 *
 * Provider-native reasoning state stays on the persisted message SSOT. A model/API
 * switch receives only portable visible content and generic tool calls; switching
 * back to the exact owner reuses the untouched original message.
 */
function withoutForeignOpaqueState(message: AssistantMessage): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "thinking" || block.type === "redactedThinking" || block.type === "fallback") continue;
		if (block.type === "text" && block.textSignature !== undefined) {
			const { textSignature: _, ...portable } = block;
			content.push(portable);
			continue;
		}
		if (block.type === "toolCall") {
			const { thoughtSignature: _, rawBlock: _rawBlock, customWireName: _customWireName, ...portable } = block;
			content.push(portable);
			continue;
		}
		content.push(block);
	}
	const { providerPayload: _, responseId: _responseId, ...portable } = message;
	return { ...portable, content };
}

/**
 * Remove terminal refusals and enforce exact provider/model/API ownership for
 * opaque replay state. Omitting `owner` preserves the legacy refusal-only filter.
 */
export function filterProviderReplayMessages(messages: readonly Message[], owner?: ReplayOwner): Message[] {
	const replayable: Message[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") {
			replayable.push(message);
			continue;
		}
		if (isProviderRefusalMessage(message)) continue;
		if (!owner || (message.provider === owner.provider && message.model === owner.id && message.api === owner.api)) {
			replayable.push(message);
			continue;
		}
		replayable.push(withoutForeignOpaqueState(message));
	}
	return replayable;
}
