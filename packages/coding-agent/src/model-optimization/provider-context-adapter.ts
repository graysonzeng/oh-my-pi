/**
 * Provider-only context adapter for ordinary sessions.
 * Never mutates the input array/messages or SessionManager JSONL — returns a
 * shallow-copied view only when elision is needed.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { extractRawOutputFooter } from "../workflow/optimization-receipt";
import type { SessionContextStrategy } from "./types";

export const PROVIDER_ELISION_RECEIPT_KIND = "provider_context_elision_receipt" as const;
export const PROVIDER_ELISION_RECEIPT_VERSION = 1 as const;

export interface ProviderElisionReceiptV1 {
	schemaVersion: typeof PROVIDER_ELISION_RECEIPT_VERSION;
	kind: typeof PROVIDER_ELISION_RECEIPT_KIND;
	tool: string;
	toolCallId: string;
	originalBytes: number;
	visibleBytes: number;
	recoveryUri: string;
	createdAt: string;
}

export interface ProviderOnlyContextResult {
	messages: AgentMessage[];
	receipts: ProviderElisionReceiptV1[];
	/** Stable fingerprint of this elision set for durable receipt dedupe. */
	fingerprint?: string;
}

/** Rough token estimate (~4 UTF-8 bytes/token) shared with workflow eviction math. */
export function estimateProviderContextTokens(messages: readonly AgentMessage[]): number {
	let total = 0;
	for (const message of messages) {
		total += estimateMessageTokens(message);
	}
	return total;
}

function utf8TokenEstimate(text: string): number {
	if (!text) return 0;
	return Math.max(1, (Buffer.byteLength(text, "utf-8") + 3) >> 2);
}

/** Cheap size estimate for tool-call arguments without allocating JSON. */
function estimateUnknownTokens(value: unknown, depth = 0): number {
	if (value == null) return 1;
	if (typeof value === "string") return utf8TokenEstimate(value);
	if (typeof value === "number" || typeof value === "boolean") return 1;
	if (depth > 4) return 8;
	if (Array.isArray(value)) {
		let n = 1;
		for (const item of value) n += estimateUnknownTokens(item, depth + 1);
		return n;
	}
	if (typeof value === "object") {
		let n = 1;
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			n += utf8TokenEstimate(key) + estimateUnknownTokens(child, depth + 1);
		}
		return n;
	}
	return 1;
}

function estimateMessageTokens(message: AgentMessage): number {
	if (!message || typeof message !== "object") return 0;
	const role = "role" in message ? message.role : undefined;
	if (role === "assistant") {
		const content = "content" in message ? message.content : undefined;
		if (!Array.isArray(content)) return 0;
		let n = 0;
		for (const block of content) {
			if (!block || typeof block !== "object" || !("type" in block)) continue;
			if (block.type === "text" && "text" in block && typeof block.text === "string") {
				n += utf8TokenEstimate(block.text);
			} else if (block.type === "thinking" && "thinking" in block) {
				n += utf8TokenEstimate(String(block.thinking));
			} else if (block.type === "toolCall") {
				if ("name" in block && typeof block.name === "string") n += utf8TokenEstimate(block.name);
				if ("arguments" in block) n += Math.max(1, estimateUnknownTokens(block.arguments));
			} else if (block.type === "image") {
				n += 256;
			}
		}
		return n;
	}
	if (role === "toolResult" || role === "user" || role === "developer") {
		const content = "content" in message ? message.content : undefined;
		if (typeof content === "string") return utf8TokenEstimate(content);
		if (Array.isArray(content)) {
			let n = 0;
			for (const block of content) {
				if (!block || typeof block !== "object" || !("type" in block)) continue;
				if (block.type === "text" && "text" in block && typeof block.text === "string") {
					n += utf8TokenEstimate(block.text);
				} else if (block.type === "image") {
					// Images are clamped elsewhere; count a small fixed budget for pairing.
					n += 256;
				}
			}
			return n;
		}
	}
	return 0;
}

function toolResultText(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
			const text = block.text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

function hasRealArtifactRecoveryUri(text: string): string | undefined {
	const fromFooter = extractRawOutputFooter(text).artifactId;
	if (fromFooter) return `artifact://${fromFooter}`;
	const match = text.match(/artifact:\/\/(\d+)\b/);
	return match ? `artifact://${match[1]}` : undefined;
}

function collectAssistantToolCallIds(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
		if (!("content" in message) || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (
				block &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "toolCall" &&
				"id" in block &&
				typeof block.id === "string" &&
				block.id.length > 0
			) {
				ids.add(block.id);
			}
		}
	}
	return ids;
}

const ELIDED_PREFIX = "[elided for provider context — recover:";

export interface ProviderOnlyContextAdapterOptions {
	/** Active model context window (tokens). */
	contextWindow: number;
	/** Hardened ordinary-session context strategy. */
	strategy: SessionContextStrategy | undefined;
}

function fingerprintReceipts(receipts: readonly ProviderElisionReceiptV1[]): string {
	const parts = receipts.map(r => `${r.toolCallId}|${r.recoveryUri}|${r.originalBytes}|${r.visibleBytes}`).sort();
	return new Bun.CryptoHasher("sha256").update(parts.join("\n")).digest("hex").slice(0, 24);
}

/**
 * When provider-visible context exceeds `targetUtilization * contextWindow`,
 * elide older non-error tool results that already carry a real `artifact://`
 * recovery URI, keeping at most the newest `maxToolCalls` tool results intact.
 *
 * Contracts:
 * - never mutates the input array or message objects
 * - preserves all user turns
 * - preserves tool call / tool result pairing (messages stay; only text shrinks)
 * - only elides tool results whose toolCallId still has a matching assistant toolCall
 * - never elides error tool results or results without a recovery URI
 */
export function applyProviderOnlyToolHistoryDetailed(
	messages: AgentMessage[],
	options: ProviderOnlyContextAdapterOptions,
): ProviderOnlyContextResult {
	const strategy = options.strategy;
	if (!strategy) return { messages, receipts: [] };

	const contextWindow = options.contextWindow;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return { messages, receipts: [] };

	const utilization = strategy.targetUtilization;
	if (utilization === undefined || utilization <= 0 || utilization >= 1) return { messages, receipts: [] };

	const maxToolCalls = strategy.toolHistory?.maxToolCalls ?? strategy.eviction?.keepRecentN;
	if (maxToolCalls === undefined || maxToolCalls <= 0) return { messages, receipts: [] };

	const targetTokens = Math.floor(contextWindow * utilization);
	const currentTokens = estimateProviderContextTokens(messages);
	if (currentTokens <= targetTokens) return { messages, receipts: [] };

	const pairedToolCallIds = collectAssistantToolCallIds(messages);
	const toolResultIndexes: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message && typeof message === "object" && "role" in message && message.role === "toolResult") {
			toolResultIndexes.push(i);
		}
	}
	if (toolResultIndexes.length <= maxToolCalls) return { messages, receipts: [] };

	const keepFrom = toolResultIndexes.length - maxToolCalls;
	const elidable = toolResultIndexes.slice(0, keepFrom);
	if (elidable.length === 0) return { messages, receipts: [] };

	let changed = false;
	const next = messages.slice();
	const receipts: ProviderElisionReceiptV1[] = [];
	const createdAt = new Date().toISOString();

	for (const index of elidable) {
		const message = next[index];
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "toolResult") continue;
		if ("isError" in message && message.isError === true) continue;
		if (!("content" in message) || !Array.isArray(message.content)) continue;
		if (!("toolCallId" in message) || typeof message.toolCallId !== "string") continue;
		if (!pairedToolCallIds.has(message.toolCallId)) continue;

		const text = toolResultText(message);
		if (!text || text.startsWith(ELIDED_PREFIX)) continue;
		const recoveryUri = hasRealArtifactRecoveryUri(text);
		if (!recoveryUri) continue;

		const images = message.content.filter(
			(block): block is Extract<(typeof message.content)[number], { type: "image" }> =>
				!!block && typeof block === "object" && "type" in block && block.type === "image",
		);
		const elidedText = `${ELIDED_PREFIX} ${recoveryUri}]`;
		next[index] = {
			...message,
			content: [{ type: "text" as const, text: elidedText }, ...images],
		};
		receipts.push({
			schemaVersion: PROVIDER_ELISION_RECEIPT_VERSION,
			kind: PROVIDER_ELISION_RECEIPT_KIND,
			tool: typeof message.toolName === "string" ? message.toolName : "tool",
			toolCallId: message.toolCallId,
			originalBytes: Buffer.byteLength(text, "utf-8"),
			visibleBytes: Buffer.byteLength(elidedText, "utf-8"),
			recoveryUri,
			createdAt,
		});
		changed = true;
	}

	if (!changed) return { messages, receipts: [] };
	return {
		messages: next,
		receipts,
		fingerprint: fingerprintReceipts(receipts),
	};
}

/**
 * Compatibility wrapper that returns only the message array.
 * Prefer {@link applyProviderOnlyToolHistoryDetailed} when receipts are needed.
 */
export function applyProviderOnlyToolHistory(
	messages: AgentMessage[],
	options: ProviderOnlyContextAdapterOptions,
): AgentMessage[] {
	return applyProviderOnlyToolHistoryDetailed(messages, options).messages;
}
