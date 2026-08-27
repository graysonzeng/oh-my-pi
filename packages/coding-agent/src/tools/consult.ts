import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, completeSimple, type ToolExample } from "@oh-my-pi/pi-ai";
import { prompt, truncate } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../commit/utils";
import { formatModelString } from "../config/model-resolver";
import consultDescription from "../prompts/tools/consult.md" with { type: "text" };
import { enforceInlineByteCap } from "../session/streaming-output";
import { concreteThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "../thinking";
import { type ConsultResolution, resolveConsultSelection } from "./consult-model";
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
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
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
		const maxUsesPerTurn = this.session.settings.get("consult.maxUsesPerTurn");
		const maxUsesPerSession = this.session.settings.get("consult.maxUsesPerSession");
		const maxTokensRaw = this.session.settings.get("consult.maxTokens");
		const maxTokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : 2048;
		const maxFocusChars = this.session.settings.get("consult.maxFocusChars");
		const timeoutMs = this.session.settings.get("consult.timeoutMs");
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
			const code = isAbortError(error) ? (timedOut() ? "timeout" : "aborted") : "provider_error";
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
		const activeModel = this.session.getActiveModel?.();
		const projection = projectConsultContext({
			snapshot,
			model: resolved.model,
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
				model: formatModelString(resolved.model),
			});
			return consultError(projection.error, { maxTokens, model: formatModelString(resolved.model) });
		}

		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		const reasoning = toReasoningEffort(
			resolveThinkingLevelForModel(resolved.model, concreteThinkingLevel(resolved.thinkingLevel)),
		);

		let response: AssistantMessage;
		try {
			response = await instrumentedCompleteSimple(
				resolved.model,
				{
					systemPrompt: [projection.systemPrompt],
					messages: [
						{
							role: "user",
							content: projection.userPrompt,
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: resolved.apiKey,
					signal: effectiveSignal,
					reasoning,
					maxTokens,
				},
				{ telemetry, oneshotKind: "consult", completeImpl: this.completeConsultRequest },
			);
		} catch (error) {
			const code = isAbortError(error) ? (timedOut() ? "timeout" : "aborted") : "provider_error";
			const model = formatModelString(resolved.model);
			recordConsultAttempt(this.session, { error: code, maxTokens, model });
			return consultError(code, { maxTokens, model }, truncatedConsultErrorMessage(error));
		}

		if (response.stopReason === "error") {
			recordConsultAttempt(this.session, {
				error: "provider_error",
				maxTokens,
				model: formatModelString(resolved.model),
			});
			return consultError(
				"provider_error",
				{ maxTokens, model: formatModelString(resolved.model) },
				truncate(response.errorMessage ?? "consult request failed", CONSULT_TOOL_RESULT_CHARS),
			);
		}
		if (response.stopReason === "aborted") {
			const code = timedOut() ? "timeout" : "aborted";
			recordConsultAttempt(this.session, { error: code, maxTokens, model: formatModelString(resolved.model) });
			return consultError(code, { maxTokens, model: formatModelString(resolved.model) });
		}

		const text = extractTextContent(response);
		if (!text) {
			recordConsultAttempt(this.session, {
				error: "empty_response",
				maxTokens,
				model: formatModelString(resolved.model),
				tokensIn: response.usage.input,
				tokensOut: response.usage.output,
				costUsd: usageCostUsd(response),
			});
			return consultError("empty_response", {
				maxTokens,
				model: formatModelString(resolved.model),
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
			model: formatModelString(resolved.model),
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
