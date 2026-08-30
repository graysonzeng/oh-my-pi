import * as agentCore from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { prompt } from "@oh-my-pi/pi-utils";
import { extractTextContent, parseJsonPayload } from "../commit/utils";
import { expandRoleAlias, getModelMatchPreferences, resolveModelFromString } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import completenessAuditorSystem from "../prompts/workflow/completeness-auditor.md" with { type: "text" };
import completenessAuditorUser from "../prompts/workflow/completeness-auditor-user.hbs.md" with { type: "text" };
import { getDefaultConfig } from "./default-config";
import { WorkflowCancelledError } from "./errors";
import { type PipelineAuditor, type PipelineCompletenessResult, parsePipelineCompletenessResult } from "./overlay";

export interface PipelineAuditorHost {
	settings?: Settings;
	modelRegistry?: {
		getAvailable: () => Model[];
		getApiKey?: (model: Model, sessionId?: string) => Promise<string | undefined>;
	};
	getSessionId?: () => string | null | undefined;
	getTelemetry?: () => Parameters<typeof agentCore.resolveTelemetry>[0];
}

const FAIL_CLOSED: PipelineCompletenessResult = {
	complete: false,
	missing: ["pipeline_auditor_unavailable"],
	next: "Provide a complete executable request.",
};

function failClosed(missing = FAIL_CLOSED.missing, next = FAIL_CLOSED.next): PipelineCompletenessResult {
	return { complete: false, missing, next };
}

function rethrowIfAuditorAborted(error: unknown): void {
	if (error instanceof WorkflowCancelledError) throw error;
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error);
	if (name === "AbortError" || /abort|cancel/i.test(message)) {
		throw new WorkflowCancelledError(message, { cause: error });
	}
}

/** Flash completeness oneshot. Parse/provider/timeout failures fail closed as incomplete. */
export function createSessionPipelineAuditor(session: PipelineAuditorHost): PipelineAuditor {
	return async input => {
		if (input.signal?.aborted) {
			throw new WorkflowCancelledError("completeness auditor aborted");
		}
		const registry = session.modelRegistry;
		const settings = session.settings;
		const available = registry?.getAvailable() ?? [];
		if (!registry || !settings || available.length === 0) return failClosed();
		const pattern = getDefaultConfig().pipelineOverlay.auditorModel;
		const expanded = expandRoleAlias(pattern, settings);
		const model = resolveModelFromString(expanded, available, getModelMatchPreferences(settings));
		if (!model) return failClosed(["auditor_model_unavailable"], `Could not resolve ${pattern}.`);
		const apiKey = await registry.getApiKey?.(model, session.getSessionId?.() ?? undefined);
		if (!apiKey) return failClosed(["auditor_credentials_missing"], "Auditor model has no credentials.");
		const userPrompt = prompt.render(completenessAuditorUser, {
			request: input.request,
			planSummary: input.planSummary ?? "",
			grillAnswers: (input.grillAnswers ?? []).join("\n"),
		});
		try {
			const response = await agentCore.instrumentedCompleteSimple(
				model,
				{
					systemPrompt: [completenessAuditorSystem],
					messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
				},
				{
					apiKey,
					reasoning: clampThinkingLevelForModel(model, Effort.Low),
					maxTokens: 400,
					signal: input.signal,
				},
				{
					telemetry: agentCore.resolveTelemetry(session.getTelemetry?.(), session.getSessionId?.() ?? undefined),
					oneshotKind: "pipeline_auditor",
				},
			);
			if (response.stopReason === "aborted") {
				throw new WorkflowCancelledError("completeness auditor aborted");
			}
			if (response.stopReason === "error") {
				return failClosed();
			}
			const parsed = parsePipelineCompletenessResult(parseJsonPayload(extractTextContent(response)));
			return parsed ?? failClosed(["auditor_parse_failed"], "Completeness auditor returned invalid JSON.");
		} catch (error) {
			rethrowIfAuditorAborted(error);
			return failClosed();
		}
	};
}
