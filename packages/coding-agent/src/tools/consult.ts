import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, completeSimple, type ToolExample } from "@oh-my-pi/pi-ai";
import { prompt, truncate } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../commit/utils";
import { formatModelString } from "../config/model-resolver";
import {
	cfgConsultMaxFocusChars,
	cfgConsultMaxTokens,
	cfgConsultMaxUsesPerSession,
	cfgConsultMaxUsesPerTurn,
} from "../config/workflow-settings";
import consultDescription from "../prompts/tools/consult.md" with { type: "text" };
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { concreteThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { type ConsultResolution, isConsultSameModel, resolveConsultSelection } from "./consult-model";
import { type ConsultDetails, getConsultUsage, recordConsultAttempt } from "./consult-state";
import { CONSULT_TOOL_RESULT_CHARS, projectConsultContext } from "./consult-transcript";
import type { ToolSession } from "./index";
import { toolResult } from "./tool-result";

const consultSchema = type({
	"focus?": type("string").describe(
		"Optional one-sentence question or conflict to resolve. Omit to send the curated transcript only.",
	),
	"+": "reject",
});

export type ConsultParams = typeof consultSchema.infer;

export type ConsultToolDetails = ConsultDetails;

function consultError(code: string, details: ConsultDetails, message?: string): AgentToolResult<ConsultToolDetails> {
	const text = message ? `${code}: ${message}` : code;
	return toolResult({ ...details, error: code })
		.text(text)
		.error()
		.done();
}

function isAbortError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "TimeoutError" || error.name === "StreamTimeoutError")
	);
}

function consultTimeoutCode(error: unknown, timedOut: boolean): "timeout" | "aborted" {
	return timedOut || (error instanceof Error && (error.name === "TimeoutError" || error.name === "StreamTimeoutError"))
		? "timeout"
		: "aborted";
}

function truncatedConsultErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return truncate(message, CONSULT_TOOL_RESULT_CHARS);
}

function usageCostUsd(response: AssistantMessage): number | undefined {
	return response.usage.cost.total;
}

export class ConsultTool implements AgentTool<typeof consultSchema, ConsultToolDetails> {
	readonly name = "consult";
	readonly approval = "read" as const;
	readonly label = "Consult";
	readonly loadMode = "discoverable";
	readonly concurrency = "exclusive" as const;
	readonly summary = "Ask a stronger model for mid-turn strategic guidance";
	readonly description: string;
	readonly parameters = consultSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof consultSchema.infer>[] = [
		{
			caption: "Ask before committing to an approach",
			call: { focus: "Should I rewrite this parser or patch the existing tokenizer?" },
		},
		{
			caption: "Send curated transcript only",
			call: {},
		},
	];

	constructor(
		private readonly session: ToolSession,
		private readonly completeConsultRequest: typeof completeSimple = completeSimple,
	) {
		this.description = prompt.render(consultDescription);
	}

	async execute(
		_toolCallId: string,
		params: ConsultParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ConsultToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ConsultToolDetails>> {
		const maxUsesPerTurn = cfgConsultMaxUsesPerTurn.get(this.session.settings);
		const maxUsesPerSession = cfgConsultMaxUsesPerSession.get(this.session.settings);
		const maxTokensRaw = cfgConsultMaxTokens.get(this.session.settings);
		const maxTokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : 2048;
		const maxFocusChars = cfgConsultMaxFocusChars.get(this.session.settings);
		const timeoutMs = this.session.settings.get("consult.timeoutMs");
		const firstEventTimeoutMs = this.session.settings.get("consult.firstEventTimeoutMs");
		const usage = getConsultUsage(this.session);

		if (usage.turn >= maxUsesPerTurn || usage.session >= maxUsesPerSession) {
			return consultError("max_uses_exceeded", { maxTokens });
		}

		const focus = typeof params.focus === "string" ? params.focus.trim() : "";
		if (focus.length > maxFocusChars) {
			recordConsultAttempt(this.session, { error: "focus_too_long", maxTokens });
			return consultError("focus_too_long", { maxTokens }, `focus exceeds consult.maxFocusChars (${maxFocusChars})`);
		}

		const snapshot = this.session.snapshotConsultContext?.();
		if (!snapshot) {
			recordConsultAttempt(this.session, { error: "transcript_unavailable", maxTokens });
			return consultError("transcript_unavailable", { maxTokens });
		}

		const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
		const timeoutSignal = hasTimeout ? AbortSignal.timeout(timeoutMs) : undefined;
		const effectiveSignal = timeoutSignal
			? signal
				? AbortSignal.any([signal, timeoutSignal])
				: timeoutSignal
			: signal;
		const timedOut = (): boolean => Boolean(timeoutSignal?.aborted) && !signal?.aborted;

		let resolved: ConsultResolution;
		try {
			resolved = await resolveConsultSelection(this.session, effectiveSignal);
		} catch (error) {
			const code = isAbortError(error) ? consultTimeoutCode(error, timedOut()) : "provider_error";
			recordConsultAttempt(this.session, { error: code, maxTokens });
			return consultError(code, { maxTokens }, truncatedConsultErrorMessage(error));
		}
		if (!resolved.ok) {
			const model = resolved.model ? formatModelString(resolved.model) : undefined;
			recordConsultAttempt(this.session, { error: resolved.error, maxTokens, model });
			return consultError(resolved.error, { maxTokens, model });
		}

		const secretsEnabled = this.session.settings.get("secrets.enabled") === true;
		const obfuscator = this.session.getSecretObfuscator?.();
		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		let model = resolved.model;
		let response: AssistantMessage | undefined;
		let providerErrorMessage: string | undefined;
		for (const [index, candidate] of [resolved, ...(resolved.fallbacks ?? [])].entries()) {
			try {
				let apiKey = resolved.apiKey;
				if (index > 0) {
					if (
						isConsultSameModel(this.session, candidate.model) &&
						!this.session.settings.get("consult.allowSameModel")
					) {
						continue;
					}
					const key = await this.session.modelRegistry?.getApiKey(
						candidate.model,
						this.session.getSessionId?.() ?? undefined,
						{ signal: effectiveSignal },
					);
					if (
						!key ||
						(isConsultSameModel(this.session, candidate.model) &&
							!this.session.settings.get("consult.allowSameModel"))
					) {
						continue;
					}
					apiKey = key;
				}
				model = candidate.model;
				const activeModel = this.session.getActiveModel?.();
				const projection = projectConsultContext({
					snapshot,
					model,
					primaryModel: activeModel
						? formatModelString(activeModel)
						: (this.session.getActiveModelString?.() ?? "unknown"),
					focus: focus || undefined,
					maxTokens,
					secretsEnabled,
					obfuscator,
				});
				if ("error" in projection) {
					recordConsultAttempt(this.session, {
						error: projection.error,
						maxTokens,
						model: formatModelString(model),
					});
					return consultError(projection.error, { maxTokens, model: formatModelString(model) });
				}
				const reasoning = toReasoningEffort(
					resolveThinkingLevelForModel(model, concreteThinkingLevel(candidate.thinkingLevel)),
				);
				const result = await instrumentedCompleteSimple(
					model,
					{
						systemPrompt: [projection.systemPrompt],
						messages: [{ role: "user", content: projection.userPrompt, timestamp: Date.now() }],
					},
					{
						apiKey,
						signal: effectiveSignal,
						reasoning,
						maxTokens,
						...(typeof firstEventTimeoutMs === "number" &&
						Number.isFinite(firstEventTimeoutMs) &&
						firstEventTimeoutMs >= 0
							? { streamFirstEventTimeoutMs: firstEventTimeoutMs }
							: {}),
					},
					{ telemetry, oneshotKind: "consult", completeImpl: this.completeConsultRequest },
				);
				if (result.stopReason === "error") {
					const firstEventTimedOut =
						typeof result.errorMessage === "string" &&
						/timed out while waiting for the first event/i.test(result.errorMessage);
					providerErrorMessage = truncate(
						result.errorMessage ?? (firstEventTimedOut ? "consult request timed out" : "consult request failed"),
						CONSULT_TOOL_RESULT_CHARS,
					);
					if (!firstEventTimedOut) continue;
					recordConsultAttempt(this.session, { error: "timeout", maxTokens, model: formatModelString(model) });
					return consultError("timeout", { maxTokens, model: formatModelString(model) }, providerErrorMessage);
				}
				if (result.stopReason === "aborted") {
					const code = timedOut() ? "timeout" : "aborted";
					recordConsultAttempt(this.session, { error: code, maxTokens, model: formatModelString(model) });
					return consultError(code, { maxTokens, model: formatModelString(model) });
				}
				response = result;
				break;
			} catch (error) {
				model = candidate.model;
				const code = isAbortError(error) ? consultTimeoutCode(error, timedOut()) : "provider_error";
				providerErrorMessage = truncatedConsultErrorMessage(error);
				if (code === "provider_error") continue;
				recordConsultAttempt(this.session, { error: code, maxTokens, model: formatModelString(model) });
				return consultError(code, { maxTokens, model: formatModelString(model) }, providerErrorMessage);
			}
		}
		if (!response) {
			recordConsultAttempt(this.session, { error: "provider_error", maxTokens, model: formatModelString(model) });
			return consultError("provider_error", { maxTokens, model: formatModelString(model) }, providerErrorMessage);
		}

		const text = extractTextContent(response);
		if (!text) {
			recordConsultAttempt(this.session, {
				error: "empty_response",
				maxTokens,
				model: formatModelString(model),
				tokensIn: response.usage.input,
				tokensOut: response.usage.output,
				costUsd: usageCostUsd(response),
			});
			return consultError("empty_response", {
				maxTokens,
				model: formatModelString(model),
				tokensIn: response.usage.input,
				tokensOut: response.usage.output,
				costUsd: usageCostUsd(response),
			});
		}

		const capped = await enforceInlineByteCap(text, {
			saveArtifact: async full => {
				try {
					const alloc = await this.session.allocateOutputArtifact?.("consult");
					if (!alloc?.path || !alloc.id) return undefined;
					await Bun.write(alloc.path, full);
					return alloc.id;
				} catch {
					return undefined;
				}
			},
		});
		const truncated = response.stopReason === "length" || capped !== text;
		const details: ConsultDetails = {
			model: formatModelString(model),
			tokensIn: response.usage.input,
			tokensOut: response.usage.output,
			costUsd: usageCostUsd(response),
			truncated,
			maxTokens,
		};
		recordConsultAttempt(this.session, details);
		return toolResult(details).text(capped).done();
	}
}
