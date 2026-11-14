/**
 * Pure preparation for structured compaction: deterministic addressable tool
 * omission plus optional per-assistant summaries.
 *
 * This module owns no lifecycle, persistence, or tool-authorization state —
 * it only clones the captured branch, computes a candidate rewrite on the
 * clone, and hands back a `StructuredCompactionPatch` for the owner to
 * revalidate and commit. It never writes live history.
 */

import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import { type PruneConfig, type PruneResult, pruneToolOutputs } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { Tokenizer } from "@oh-my-pi/pi-agent-core/tokenizer";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import type { SessionMessageRewrite } from "./session-manager";

/** One assistant message's plain text submitted for summarization. */
export interface AssistantSummaryInput {
	id: string;
	text: string;
}

/** One summarization result, keyed by the same entry id. */
export interface AssistantSummaryOutput {
	id: string;
	text: string;
}

/**
 * Callback that summarizes the selected assistant texts on a model.
 * Implemented by SessionMaintenance only (model resolution/auth/transport/
 * fallback/side-session/abort). It batches within the selected model's usable
 * window, caps aggregate output at `min(4096, floor(inputTokens / 4))`, skips
 * individually oversized source entries, and returns outputs only for entries
 * it actually submitted. It never reports partial success after a requested
 * batch fails.
 */
export type SummarizeAssistantEntries = (
	entries: readonly AssistantSummaryInput[],
	signal: AbortSignal,
) => Promise<readonly AssistantSummaryOutput[]>;

export interface StructuredCompactionRequest {
	/** The captured branch. Never mutated: the patch is built on clones. */
	entries: readonly SessionEntry[];
	tokenizer: Tokenizer;
	/**
	 * Structured prune configuration. Addressable omission is forced on, and
	 * the superseded/useless/cache-warm exceptions are disabled, whatever the
	 * caller passes: omission must be recoverable via `omittedOriginal`.
	 */
	pruneConfig: PruneConfig;
	/** Maximum visible request tokens after applying the complete patch. */
	targetTokens: number;
	/** Current visible request tokens (owner's provider-anchored accounting anchor). */
	currentTokens: number;
	signal: AbortSignal;
	summarize: SummarizeAssistantEntries;
}

export interface StructuredCompactionPatch {
	kind: "structured";
	rewrite: SessionMessageRewrite;
	estimatedTokensSaved: number;
}

/** Hard cap per summary text entry, enforced by {@link parseAssistantSummaries}. */
export const MAX_SUMMARY_TOKENS_PER_ENTRY = 512;

/**
 * Prepended to every summary text so the rewritten message reads as a
 * historical note about a past assistant turn, never as a live instruction.
 */
export const ASSISTANT_SUMMARY_PREFIX = "[Summarized historical assistant message] ";

/**
 * Recent visible window kept intact for both tool omission and assistant
 * summarization (mirrors the structured caller's `protectTokens`).
 */
const STRUCTURED_PROTECT_TOKENS = 40_000;

/**
 * Strict parser for the assistant-summary protocol. Accepts exactly
 * `{"summaries": [{"id": string, "text": non-empty string}]}`: the requested
 * ID set must appear exactly once each (no missing, duplicate, or unknown
 * ids), there are no extra fields at either level, every text is non-empty
 * and at most {@link MAX_SUMMARY_TOKENS_PER_ENTRY} tokens, and the aggregate
 * fits `maxOutputTokens`. Any deviation throws; there is no permissive JSON
 * repair. Outputs are returned in `requested` order.
 */
export function parseAssistantSummaries(
	response: string,
	requested: readonly AssistantSummaryInput[],
	tokenizer: Tokenizer,
	maxOutputTokens: number,
): readonly AssistantSummaryOutput[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(response);
	} catch {
		throw new Error("Structured assistant summary protocol violated: response is not valid JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Structured assistant summary protocol violated: top level must be a JSON object");
	}
	const topLevel = parsed as Record<string, unknown>;
	const topKeys = Object.keys(topLevel);
	if (topKeys.length !== 1 || topKeys[0] !== "summaries") {
		throw new Error(
			'Structured assistant summary protocol violated: top level must have exactly the "summaries" field',
		);
	}
	const summaries = topLevel.summaries;
	if (!Array.isArray(summaries)) {
		throw new Error("Structured assistant summary protocol violated: summaries must be an array");
	}

	const requestedIds = new Set(requested.map(input => input.id));
	const textById = new Map<string, string>();
	for (const item of summaries) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("Structured assistant summary protocol violated: every summary must be an object");
		}
		const summary = item as Record<string, unknown>;
		const keys = Object.keys(summary);
		if (keys.length !== 2 || !("id" in summary) || !("text" in summary)) {
			throw new Error(
				'Structured assistant summary protocol violated: every summary must have exactly the fields "id" and "text"',
			);
		}
		const { id, text } = summary;
		if (typeof id !== "string" || typeof text !== "string") {
			throw new Error("Structured assistant summary protocol violated: id and text must be strings");
		}
		if (text.trim().length === 0) {
			throw new Error("Structured assistant summary protocol violated: text must be non-empty");
		}
		if (!requestedIds.has(id)) {
			throw new Error(`Structured assistant summary protocol violated: unexpected id "${id}"`);
		}
		if (textById.has(id)) {
			throw new Error(`Structured assistant summary protocol violated: duplicate id "${id}"`);
		}
		const tokens = tokenizer.countTokens(text);
		if (tokens > MAX_SUMMARY_TOKENS_PER_ENTRY) {
			throw new Error(
				`Structured assistant summary protocol violated: summary for "${id}" exceeds ${MAX_SUMMARY_TOKENS_PER_ENTRY} tokens`,
			);
		}
		textById.set(id, text);
	}
	if (tokenizer.countTokens(response) > maxOutputTokens) {
		throw new Error(
			`Structured assistant summary protocol violated: aggregate output exceeds the ${maxOutputTokens}-token cap`,
		);
	}
	for (const input of requested) {
		if (!textById.has(input.id)) {
			throw new Error(`Structured assistant summary protocol violated: missing id "${input.id}"`);
		}
	}
	return requested.map(input => ({ id: input.id, text: textById.get(input.id)! }));
}

/**
 * Index of the latest compaction's visible boundary (`firstKeptEntryId`):
 * everything before it was summarized away and is never sent, so neither tool
 * omission nor assistant summarization may touch it. Falls back to the
 * caller's `keepBoundaryId` and returns 0 when there is no boundary.
 */
function resolveBoundaryIndex(entries: readonly SessionEntry[], keepBoundaryId: string | undefined): number {
	const id = keepBoundaryId ?? lastCompactionFirstKeptEntryId(entries);
	if (id === undefined) return 0;
	const index = entries.findIndex(entry => entry.id === id);
	return index < 0 ? 0 : index;
}

function lastCompactionFirstKeptEntryId(entries: readonly SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction") return entry.firstKeptEntryId;
	}
	return undefined;
}

/**
 * Per-entry index: estimated tokens of every *message* strictly after it.
 * Used to keep the recent {@link STRUCTURED_PROTECT_TOKENS} visible window
 * intact when choosing assistant summarization candidates.
 */
function computeMessageSuffixTokens(entries: readonly SessionEntry[], tokenizer: Tokenizer): number[] {
	const suffix = new Array<number>(entries.length);
	let accumulated = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		suffix[i] = accumulated;
		const entry = entries[i];
		if (entry.type === "message") accumulated += tokenizer.countMessage(entry.message);
	}
	return suffix;
}

/**
 * Old assistant messages worth summarizing: after the latest compaction's
 * visible boundary, before the recent protect window, and made only of plain
 * unsigned text plus tool calls. Messages containing thinking, redacted,
 * fallback, provider-native, image, or signed-text blocks are skipped whole —
 * their provider-signed structure is immutable.
 */
function collectEligibleAssistantInputs(
	entries: readonly SessionEntry[],
	tokenizer: Tokenizer,
	boundaryIndex: number,
	protectTokens: number,
): AssistantSummaryInput[] {
	const suffixTokens = computeMessageSuffixTokens(entries, tokenizer);
	const inputs: AssistantSummaryInput[] = [];
	for (let i = boundaryIndex; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant" || message.providerPayload !== undefined) continue;
		if (suffixTokens[i] < protectTokens) continue;
		const texts: string[] = [];
		let plainOnly = true;
		for (const block of message.content) {
			if (block.type === "text") {
				if (block.textSignature !== undefined) {
					plainOnly = false;
					break;
				}
				texts.push(block.text);
			} else if (block.type !== "toolCall") {
				// Tool calls are preserved verbatim, never summarized.
				plainOnly = false;
				break;
			}
		}
		if (!plainOnly || texts.length === 0 || texts.every(text => text.trim().length === 0)) continue;
		inputs.push({ id: entry.id, text: texts.join("\n") });
	}
	return inputs;
}

/**
 * Assemble the patch from the pristine snapshot prefix and the changed
 * messages of the working clone. Only messages actually rewritten by
 * omission or summarization appear in `replacements`.
 */
function buildPatch(
	snapshot: readonly SessionEntry[],
	working: readonly SessionEntry[],
	changedIds: ReadonlySet<string>,
	estimatedTokensSaved: number,
): StructuredCompactionPatch {
	const replacements: { id: string; message: SessionMessageEntry["message"] }[] = [];
	for (const entry of working) {
		if (entry.type === "message" && changedIds.has(entry.id)) {
			replacements.push({ id: entry.id, message: entry.message });
		}
	}
	return {
		kind: "structured",
		rewrite: { prefix: snapshot, replacements },
		estimatedTokensSaved,
	};
}

/**
 * Prepare a structured compaction patch, or return `undefined` when there is
 * no usable candidate (no savings, insufficient total gain, or no eligible
 * content). Never mutates the caller's `entries`. Deterministic addressable
 * omission runs first; summaries are only requested when its savings do not
 * already reach `targetTokens`.
 *
 * Throws on abort (via `signal`) or on a requested-summary failure — a
 * rejected patch, a malformed protocol response, or zero/insufficient gain
 * never fabricates a rewrite; the caller owns the fallback policy.
 */
export async function prepareStructuredCompaction(
	request: StructuredCompactionRequest,
): Promise<StructuredCompactionPatch | undefined> {
	const { entries, tokenizer, pruneConfig, currentTokens, targetTokens, signal, summarize } = request;
	signal.throwIfAborted();

	// The structured contract fixes the prune shape: recoverable omission, no
	// superseded/useless notices, no cache-warm guard. Protect window, minimum
	// savings, protected tools (including the recovery tool) and the compaction
	// boundary come from the caller's config.
	const structuredConfig: PruneConfig = {
		...pruneConfig,
		addressable: true,
		pruneUseless: false,
		supersedeKey: undefined,
		cacheWarmSuffixTokens: undefined,
		keepBoundaryId: pruneConfig.keepBoundaryId ?? lastCompactionFirstKeptEntryId(entries),
	};

	const snapshot = structuredClone(entries);
	// The transforms replace content arrays rather than mutate blocks. Share the
	// immutable snapshot blocks, copying only entries and message containers.
	const working: SessionEntry[] = snapshot.map(entry =>
		entry.type === "message" ? { ...entry, message: { ...entry.message } } : entry,
	);

	signal.throwIfAborted();
	const pruned: PruneResult = pruneToolOutputs(working, tokenizer, structuredConfig);
	const changedIds = new Set<string>();
	let deterministicSavings = 0;
	if (pruned.prunedCount > 0) {
		for (let index = 0; index < working.length; index++) {
			const before = snapshot[index];
			const after = working[index];
			if (
				before.type !== "message" ||
				after.type !== "message" ||
				before.message.role !== "toolResult" ||
				after.message.role !== "toolResult" ||
				before.message.content === after.message.content
			)
				continue;
			changedIds.add(after.id);
			deterministicSavings += tokenizer.countMessage(before.message) - tokenizer.countMessage(after.message);
		}
	}
	signal.throwIfAborted();
	if (deterministicSavings > 0 && currentTokens - deterministicSavings <= targetTokens) {
		return buildPatch(snapshot, working, changedIds, deterministicSavings);
	}
	if (currentTokens <= targetTokens) return undefined;

	// Deterministic omission alone cannot reach the target: summarize eligible
	// old assistant messages to make up the difference.
	const boundaryIndex = resolveBoundaryIndex(snapshot, structuredConfig.keepBoundaryId);
	const inputs = collectEligibleAssistantInputs(snapshot, tokenizer, boundaryIndex, STRUCTURED_PROTECT_TOKENS);
	if (inputs.length === 0) return undefined;

	const outputs = await summarize(inputs, signal);
	signal.throwIfAborted();

	const eligibleIds = new Set(inputs.map(input => input.id));
	const appliedIds = new Set<string>();
	let summaryGain = 0;
	for (const output of outputs) {
		if (!eligibleIds.has(output.id)) {
			throw new Error(`Structured assistant summary protocol violated: summary id "${output.id}" was not requested`);
		}
		if (appliedIds.has(output.id)) {
			throw new Error(`Structured assistant summary protocol violated: duplicate summary id "${output.id}"`);
		}
		if (
			typeof output.text !== "string" ||
			output.text.trim().length === 0 ||
			tokenizer.countTokens(output.text) > MAX_SUMMARY_TOKENS_PER_ENTRY
		) {
			throw new Error(`Structured assistant summary protocol violated: invalid text for "${output.id}"`);
		}
		const index = snapshot.findIndex(entry => entry.id === output.id);
		if (index < 0) {
			throw new Error(
				`Structured assistant summary protocol violated: id "${output.id}" has no entry in the branch`,
			);
		}
		const entry = working[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			throw new Error(`Structured assistant summary protocol violated: "${output.id}" is not an assistant entry`);
		}
		const message: AssistantMessage = entry.message;
		const originalTokens = tokenizer.countMessage(message);
		const summaryBlock: TextContent = { type: "text", text: `${ASSISTANT_SUMMARY_PREFIX}${output.text}` };
		let inserted = false;
		message.content = message.content.flatMap<AssistantMessage["content"][number]>(block => {
			if (block.type !== "text") return [block];
			if (inserted) return [];
			inserted = true;
			return [summaryBlock];
		});
		invalidateMessageCache(message);
		appliedIds.add(output.id);
		changedIds.add(output.id);
		summaryGain += originalTokens - tokenizer.countMessage(message);
	}

	const totalGain = deterministicSavings + summaryGain;
	if (totalGain <= 0) return undefined;
	if (currentTokens - totalGain > targetTokens) return undefined;

	return buildPatch(snapshot, working, changedIds, totalGain);
}
