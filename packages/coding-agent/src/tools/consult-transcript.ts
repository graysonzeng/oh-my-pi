import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Model, TextContent, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { ADVISOR_RENDER_OPTIONS } from "../advisor/delta-split";
import consultSystemPromptTemplate from "../prompts/tools/consult-system.md" with { type: "text" };
import consultUserPromptTemplate from "../prompts/tools/consult-user.md" with { type: "text" };
import { obfuscateToolArguments } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";

export const CONSULT_TOOL_ARG_CHARS = 800;
export const CONSULT_TOOL_RESULT_CHARS = 2000;
const FALLBACK_CONTEXT_WINDOW = 32_768;
const IMAGE_OMITTED: TextContent = { type: "text", text: "[image omitted]" };

export interface ConsultContextSnapshot {
	systemPrompt: string[];
	messages: AgentMessage[];
}

export type ConsultProjectionError = "redaction_unavailable";

export interface ConsultProjection {
	systemPrompt: string;
	userPrompt: string;
	truncatedHistory: boolean;
}

export interface ProjectConsultContextOptions {
	snapshot: ConsultContextSnapshot;
	model: Model;
	primaryModel: string;
	focus?: string;
	maxTokens: number;
	secretsEnabled: boolean;
	obfuscator?: SecretObfuscator;
}

function cloneJson<T>(value: T): T {
	return structuredClone(value);
}

function textualContent(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map(block => (block.type === "text" ? block.text : "[image omitted]")).join("\n");
}

function omitImages(content: string | (TextContent | ImageContent)[]): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") return content;
	let changed = false;
	const next = content.map(block => {
		if (block.type !== "image") return block;
		changed = true;
		return IMAGE_OMITTED;
	});
	return changed ? next : content;
}

function truncateChars(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function isUserMessage(message: AgentMessage): message is AgentMessage & { role: "user" } {
	return message.role === "user";
}

function firstAndLastUser(messages: AgentMessage[]): { first?: AgentMessage; last?: AgentMessage } {
	let first: AgentMessage | undefined;
	let last: AgentMessage | undefined;
	for (const message of messages) {
		if (!isUserMessage(message)) continue;
		first ??= message;
		last = message;
	}
	return { first, last };
}

function stubConsultHistory(messages: AgentMessage[]): AgentMessage[] {
	let consultIndex = 0;
	const stubByCallId = new Map<string, string>();
	return messages.map(message => {
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			let changed = false;
			const content = assistant.content.map(block => {
				if (block.type !== "toolCall" || block.name !== "consult") return block;
				consultIndex += 1;
				const stub = `consult #${consultIndex} → (omitted, see prior turn)`;
				stubByCallId.set(block.id, stub);
				changed = true;
				const next: ToolCall = { ...block, arguments: { _: stub } };
				return next;
			});
			return changed ? { ...assistant, content } : message;
		}
		if (message.role === "toolResult" && message.toolName === "consult") {
			const stub = stubByCallId.get(message.toolCallId) ?? "consult → (omitted, see prior turn)";
			const next: ToolResultMessage = {
				...message,
				content: [{ type: "text", text: stub }],
			};
			return next;
		}
		return message;
	});
}

function capToolPayloads(messages: AgentMessage[]): AgentMessage[] {
	return messages.map(message => {
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			let changed = false;
			const content = assistant.content.map(block => {
				if (block.type !== "toolCall") return block;
				let serialized: string;
				try {
					serialized = JSON.stringify(block.arguments ?? {});
				} catch {
					return block;
				}
				if (serialized.length <= CONSULT_TOOL_ARG_CHARS) return block;
				changed = true;
				const truncated: ToolCall = {
					...block,
					arguments: { _: truncateChars(serialized, CONSULT_TOOL_ARG_CHARS) },
				};
				return truncated;
			});
			return changed ? { ...assistant, content } : message;
		}
		if (message.role === "toolResult") {
			const result = message as ToolResultMessage;
			const omitted = omitImages(result.content);
			const text = textualContent(omitted);
			if (omitted === result.content && text.length <= CONSULT_TOOL_RESULT_CHARS) return message;
			const next: ToolResultMessage = {
				...result,
				content: [{ type: "text", text: truncateChars(text, CONSULT_TOOL_RESULT_CHARS) }],
			};
			return next;
		}
		if (message.role === "user" || message.role === "developer") {
			const omitted = omitImages(message.content);
			if (omitted === message.content) return message;
			return { ...message, content: omitted };
		}
		return message;
	});
}

function renderTranscript(messages: AgentMessage[]): string {
	return formatSessionHistoryMarkdown(messages, {
		...ADVISOR_RENDER_OPTIONS,
		includeThinking: true,
	});
}

function renderUserPrompt(input: {
	focus?: string;
	primaryModel: string;
	pinnedConstraints: string;
	transcript: string;
}): string {
	return prompt.render(consultUserPromptTemplate, input);
}

function collectSecretValues(obfuscator: SecretObfuscator, texts: string[]): Set<string> {
	const values = new Set<string>();
	for (const text of texts) {
		for (const value of obfuscator.collectRegexSecretValuesForObfuscation(text)) {
			values.add(value);
		}
	}
	return values;
}

function redactClosed(obfuscator: SecretObfuscator, texts: string[]): string[] | null {
	const shared = collectSecretValues(obfuscator, texts);
	const individually = texts.map(text => obfuscator.obfuscate(text, shared));
	if (obfuscator.obfuscate(texts.join("\n"), shared) !== individually.join("\n")) return null;
	return individually;
}

function inputBudget(model: Model, maxTokens: number): number {
	const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : FALLBACK_CONTEXT_WINDOW;
	return Math.max(1024, window - maxTokens);
}

export function projectConsultContext(
	options: ProjectConsultContextOptions,
): ConsultProjection | { error: ConsultProjectionError } {
	if (options.secretsEnabled && !options.obfuscator) {
		return { error: "redaction_unavailable" };
	}

	const cloned = cloneJson(options.snapshot.messages);
	const stubbed = capToolPayloads(stubConsultHistory(cloned));
	const { first, last } = firstAndLastUser(stubbed);
	const pinned = new Set<AgentMessage>();
	if (first) pinned.add(first);
	if (last) pinned.add(last);

	const tokenizer = new Tokenizer(options.model);
	const pinnedConstraints = options.snapshot.systemPrompt.filter(Boolean).join("\n\n");
	const framing = renderUserPrompt({
		focus: options.focus,
		primaryModel: options.primaryModel,
		pinnedConstraints,
		transcript: "",
	});
	const consultSystem = prompt.render(consultSystemPromptTemplate);
	const reserved = tokenizer.countTokens([consultSystem, framing]);
	const budget = inputBudget(options.model, options.maxTokens);
	const remaining = Math.max(0, budget - reserved);

	const droppable = stubbed.filter(message => !pinned.has(message));
	let keptDroppable = droppable;
	let truncatedHistory = false;

	const ordered = (extra: AgentMessage[]): AgentMessage[] => {
		const keep = new Set<AgentMessage>([...pinned, ...extra]);
		return stubbed.filter(message => keep.has(message));
	};

	const fits = (extra: AgentMessage[]): boolean => {
		const transcript = renderTranscript(ordered(extra));
		return tokenizer.checkTokenBudget(transcript, remaining).fits;
	};

	if (!fits(keptDroppable)) {
		truncatedHistory = true;
		while (keptDroppable.length > 0 && !fits(keptDroppable)) {
			keptDroppable = keptDroppable.slice(1);
		}
	}

	let prepared = ordered(keptDroppable);

	const obfuscator = options.secretsEnabled ? options.obfuscator : undefined;
	if (obfuscator) {
		const shared = new Set<string>();
		for (const message of prepared) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					for (const value of collectSecretValues(obfuscator, [JSON.stringify(block.arguments ?? {})])) {
						shared.add(value);
					}
				}
			}
		}
		for (const text of [pinnedConstraints, renderTranscript(prepared), options.focus ?? ""]) {
			for (const value of obfuscator.collectRegexSecretValuesForObfuscation(text)) shared.add(value);
		}
		prepared = prepared.map(message => {
			if (message.role !== "assistant") return message;
			let changed = false;
			const content = message.content.map(block => {
				if (block.type !== "toolCall") return block;
				const arguments_ = obfuscateToolArguments(obfuscator, block.arguments ?? {}, shared);
				if (arguments_ === block.arguments) return block;
				changed = true;
				return { ...block, arguments: arguments_ };
			});
			return changed ? { ...message, content } : message;
		});
	}

	const transcript = renderTranscript(prepared);
	const texts = [consultSystem, pinnedConstraints, transcript, options.focus ?? ""];
	let redacted = texts;
	if (obfuscator) {
		const next = redactClosed(obfuscator, texts);
		if (!next) return { error: "redaction_unavailable" };
		redacted = next;
	}

	return {
		systemPrompt: redacted[0] ?? consultSystem,
		userPrompt: renderUserPrompt({
			focus: options.focus ? redacted[3] : undefined,
			primaryModel: options.primaryModel,
			pinnedConstraints: redacted[1] ?? pinnedConstraints,
			transcript: redacted[2] ?? transcript,
		}),
		truncatedHistory,
	};
}
