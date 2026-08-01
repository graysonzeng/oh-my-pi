import * as ai from "@oh-my-pi/pi-ai";
import { resolveModelOverride } from "../config/model-resolver";
import availabilityProbePrompt from "../prompts/workflow/availability-probe.hbs.md" with { type: "text" };
import {
	assertStrictRuntimeIdentity,
	buildRuntimeIdentityReceipt,
	ProviderIdentityCollector,
} from "./identity-receipt";
import type { StructuredRunnerResult } from "./runtime-adapter";
import type {
	WorkflowAvailabilityPort,
	WorkflowAvailabilityProbeRequest,
	WorkflowAvailabilityProbeResult,
	WorkflowErrorKind,
} from "./types";

/** Default per-target probe deadline. */
export const AVAILABILITY_PROBE_TIMEOUT_MS = 15_000;

export type SessionAvailabilityProbe = (
	request: WorkflowAvailabilityProbeRequest,
	signal: AbortSignal,
) => Promise<WorkflowAvailabilityProbeResult>;

/**
 * Embedded-only availability probe.
 * Sends one direct provider request — never RuntimePort.run() / stage schema artifacts.
 */
export class EmbeddedWorkflowAvailabilityPort implements WorkflowAvailabilityPort {
	readonly #sessionProbe: SessionAvailabilityProbe;

	constructor(sessionProbe: SessionAvailabilityProbe = probeSessionModel) {
		this.#sessionProbe = sessionProbe;
	}

	async probe(request: WorkflowAvailabilityProbeRequest): Promise<WorkflowAvailabilityProbeResult> {
		const timeoutMs = request.timeoutMs ?? AVAILABILITY_PROBE_TIMEOUT_MS;
		const started = performance.now();
		const controller = new AbortController();
		let timedOut = false;
		const onParentAbort = () => controller.abort(request.signal?.reason);
		if (request.signal) {
			if (request.signal.aborted) controller.abort();
			else request.signal.addEventListener("abort", onParentAbort, { once: true });
		}
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error("availability target timeout"));
		}, timeoutMs);

		try {
			return await this.#sessionProbe(request, controller.signal);
		} catch (error) {
			const latencyMs = performance.now() - started;
			const message = error instanceof Error ? error.message : String(error);
			const kind = request.signal?.aborted ? "cancelled" : timedOut ? "timeout" : classifyProbeError(message, false);
			return {
				status: "unavailable",
				latencyMs,
				errorKind: kind,
				errorSummary: message.slice(0, 500),
			};
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onParentAbort);
		}
	}
}

async function probeSessionModel(
	request: WorkflowAvailabilityProbeRequest,
	signal: AbortSignal,
): Promise<WorkflowAvailabilityProbeResult> {
	const started = performance.now();
	const registry = request.session.modelRegistry;
	if (!registry) throw new Error("availability probe requires a session model registry");
	const patterns = Array.isArray(request.profile.modelPattern)
		? request.profile.modelPattern
		: [request.profile.modelPattern];
	const { model } = resolveModelOverride(patterns, registry, request.session.settings);
	if (!model) {
		return {
			status: "unavailable",
			latencyMs: performance.now() - started,
			errorKind: "configuration",
			errorSummary: `model not found: ${request.profile.modelPattern}`,
		};
	}
	const sessionId = request.session.getSessionId?.() ?? undefined;
	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) {
		return {
			status: "unavailable",
			latencyMs: performance.now() - started,
			errorKind: "authentication",
			errorSummary: `no credentials for ${model.provider}/${model.id}`,
		};
	}
	const prompt = availabilityProbePrompt.trim();
	const identityCollector = new ProviderIdentityCollector();
	const requestedEffort =
		request.profile.thinkingLevel === "auto" ? undefined : request.profile.thinkingLevel;
	const response = await ai.completeSimple(
		model,
		{
			systemPrompt: [prompt],
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		},
		{
			apiKey: registry.resolver(model, sessionId),
			maxTokens: request.profile.strictIdentity ? 64 : 16,
			reasoning: request.profile.strictIdentity ? requestedEffort : undefined,
			disableReasoning: request.profile.strictIdentity ? undefined : true,
			signal,
			fetch: request.session.fetch,
			cwd: request.session.cwd,
			serviceTier: ai.resolveModelServiceTier(request.session.getServiceTierByFamily?.(), model),
			onResponse: identityCollector.onResponse,
		},
	);
	const latencyMs = performance.now() - started;
	const identityReceipt = buildRuntimeIdentityReceipt(
		request.profile,
		identityCollector,
		`${model.provider}/${model.id}`,
	);
	const identityFields = {
		localProvider: identityReceipt.localResolution.provider ?? undefined,
		localModel: identityReceipt.localResolution.model ?? undefined,
		attestedProvider: identityReceipt.attested.provider ?? undefined,
		attestedModel: identityReceipt.attested.model ?? undefined,
		attestedCheckpoint: identityReceipt.attested.checkpoint ?? undefined,
		identityProvenance: identityReceipt.attested.provenance,
		exactIdentityMatch: identityReceipt.exactMatch,
		effortSupported: identityReceipt.effortSupported,
	};
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return {
			status: "unavailable",
			...identityFields,
			latencyMs,
			usage: response.usage,
			reportedCostUsd: reportedCost(response.usage),
			errorKind: classifyProbeError(response.errorMessage ?? String(response.stopReason), false),
			errorSummary: response.errorMessage ?? `probe stopped: ${response.stopReason}`,
		};
	}
	if (request.profile.strictIdentity) {
		try {
			assertStrictRuntimeIdentity(identityReceipt);
		} catch (error) {
			const missing = identityReceipt.attested.provenance === "unknown";
			return {
				status: missing ? "indeterminate" : "unavailable",
				...identityFields,
				latencyMs,
				usage: response.usage,
				reportedCostUsd: reportedCost(response.usage),
				errorKind: missing
					? "missing_attestation"
					: identityReceipt.effortSupported !== true
						? "unsupported_effort"
						: "identity_mismatch",
				errorSummary: error instanceof Error ? error.message : String(error),
			};
		}
	}
	return {
		status: "available",
		...identityFields,
		actualProvider: request.profile.strictIdentity
			? (identityReceipt.attested.provider ?? undefined)
			: response.provider,
		actualModel: request.profile.strictIdentity ? (identityReceipt.attested.model ?? undefined) : response.model,
		latencyMs,
		usage: response.usage,
		reportedCostUsd: reportedCost(response.usage),
	};
}

/** Exported for unit tests — pure interpretation of runner result. */
export function interpretProbeResult(
	result: StructuredRunnerResult,
	latencyMs: number,
): WorkflowAvailabilityProbeResult {
	const body = result.result;
	if (body.aborted) {
		const abortText = `${body.abortReason ?? ""}\n${body.error ?? ""}`;
		const kind = /runtime limit|maxRuntimeMs|timed? ?out/i.test(abortText) ? "timeout" : "cancelled";
		return {
			status: "unavailable",
			latencyMs,
			usage: body.usage,
			reportedCostUsd: reportedCost(body.usage),
			errorKind: kind,
			errorSummary: (body.abortReason ?? body.error ?? "probe aborted").slice(0, 500),
		};
	}
	if (body.error) {
		return {
			status: "unavailable",
			latencyMs,
			usage: body.usage,
			reportedCostUsd: reportedCost(body.usage),
			errorKind: classifyProbeError(body.error, false),
			errorSummary: body.error.slice(0, 500),
		};
	}
	if (body.exitCode !== undefined && body.exitCode !== 0) {
		return {
			status: "unavailable",
			latencyMs,
			usage: body.usage,
			reportedCostUsd: reportedCost(body.usage),
			errorKind: "provider_permanent",
			errorSummary: `probe exit code ${body.exitCode}`,
		};
	}

	const identity = parseResolvedModelIdentity(body.resolvedModel);
	if (!identity) {
		// Successful transport without identity metadata → indeterminate (never fill from config).
		return {
			status: "indeterminate",
			latencyMs,
			usage: body.usage,
			reportedCostUsd: reportedCost(body.usage),
			errorKind: "missing_identity",
			errorSummary: "probe response lacked actual provider/model identity",
		};
	}

	return {
		status: "available",
		actualProvider: identity.provider,
		actualModel: identity.model,
		latencyMs,
		usage: body.usage,
		reportedCostUsd: reportedCost(body.usage),
	};
}

function reportedCost(usage: StructuredRunnerResult["result"]["usage"]): number | null | undefined {
	if (!usage) return undefined;
	const total = usage.cost?.total;
	return typeof total === "number" && Number.isFinite(total) ? total : null;
}

/** Parse `provider/model` or `provider/model:thinking` from runtime metadata only. */
export function parseResolvedModelIdentity(value: string | undefined): { provider: string; model: string } | undefined {
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	const provider = value.slice(0, slash);
	const selector = value.slice(slash + 1);
	const thinkingSuffix = selector.lastIndexOf(":");
	const model = thinkingSuffix > 0 ? selector.slice(0, thinkingSuffix) : selector;
	if (!provider || !model) return undefined;
	return { provider, model };
}

function classifyProbeError(message: string, aborted: boolean): WorkflowErrorKind | string {
	if (aborted) {
		if (/timed? ?out|runtime limit|maxRuntimeMs/i.test(message)) return "timeout";
		return "cancelled";
	}
	const lower = message.toLowerCase();
	if (/auth|api[_-]?key|unauthorized|401|403|credential|login/i.test(lower)) return "authentication";
	if (/quota|billing|insufficient/i.test(lower)) return "quota";
	if (/rate.?limit|429|too many requests/i.test(lower)) return "rate_limit";
	if (/timeout|timed out|deadline/i.test(lower)) return "timeout";
	if (/config|model registry|not found|unknown model|invalid model/i.test(lower)) return "configuration";
	if (/temporary|unavailable|502|503|504|overloaded/i.test(lower)) return "provider_transient";
	return "provider_permanent";
}

/** Static probe prompt text (for contract tests). */
export function availabilityProbePromptText(): string {
	return availabilityProbePrompt.trim();
}
