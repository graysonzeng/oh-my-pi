import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort, type Model, type ProviderResponseMetadata } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../src/config/model-registry";
import { EmbeddedWorkflowAvailabilityPort } from "../../src/workflow/availability-adapter";
import {
	assertStrictRuntimeIdentity,
	buildRuntimeIdentityReceipt,
	ProviderIdentityCollector,
} from "../../src/workflow/identity-receipt";
import type { ModelProfile, WorkflowAvailabilityProbeResult } from "../../src/workflow/types";
import { fakeSession } from "./helpers";

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
	return {
		id: "strict-sol",
		vendor: "openai",
		modelPattern: "openai/gpt-5.6-sol",
		roles: ["planner"],
		thinkingLevel: Effort.High,
		strictIdentity: true,
		promptTemplate: "planner",
		promptVersion: "1.0",
		toolPolicyId: "readonly",
		maxRequests: 1,
		maxRuntimeMs: 1_000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 1_000,
		},
		...overrides,
	};
}

function model(overrides: Partial<Model> = {}): Model {
	return {
		provider: "openai",
		id: "gpt-5.6-sol",
		api: "openai-responses",
		name: "GPT 5.6 Sol",
		baseUrl: "https://provider.invalid",
		reasoning: true,
		thinking: { mode: "effort", efforts: ["high"] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_000,
		maxTokens: 1_000,
		...overrides,
	} as Model;
}

function metadata(headers: Record<string, string>): ProviderResponseMetadata {
	return { status: 200, headers, requestId: "response-1" };
}

function providerEchoMetadata(modelId = "gpt-5.6-sol"): ProviderResponseMetadata {
	return metadata({
		"x-provider-id": "openai",
		"x-provider-model": modelId,
		"x-omp-model-checkpoint": "openai-checkpoint-1",
	});
}

function providerBodyMetadata(modelId = "gpt-5.6-sol"): ProviderResponseMetadata {
	return { ...metadata({}), metadata: { model: modelId } };
}

function gatewayAttestationMetadata(modelId = "gpt-5.6-sol"): ProviderResponseMetadata {
	return metadata({
		"x-omp-resolved-model": `openai/${modelId}`,
		"x-omp-model-checkpoint": "gateway-checkpoint-1",
	});
}

function registryFor(target: Model): ModelRegistry {
	return {
		getAvailable: () => [target],
		getApiKey: async () => "unit-test-key",
		resolver: () => "unit-test-key",
	} as unknown as ModelRegistry;
}

function installCompletion(
	responses: readonly ProviderResponseMetadata[],
	completionIdentity: { provider?: string; model?: string } = {},
): void {
	vi.spyOn(ai, "completeSimple").mockImplementation(async (calledModel, _context, options) => {
		for (const response of responses) {
			await options?.onResponse?.(response, calledModel);
		}
		return {
			role: "assistant",
			content: [{ type: "text", text: "probe completed" }],
			api: calledModel.api,
			provider: completionIdentity.provider ?? "openai",
			model: completionIdentity.model ?? "response-only-model",
			stopReason: "stop",
			timestamp: Date.now(),
		} as never;
	});
}

async function probe(
	requestProfile: ModelProfile,
	target: Model,
	responses: readonly ProviderResponseMetadata[],
	completionIdentity?: { provider?: string; model?: string },
): Promise<WorkflowAvailabilityProbeResult> {
	installCompletion(responses, completionIdentity);
	return new EmbeddedWorkflowAvailabilityPort().probe({
		profile: requestProfile,
		role: "planner",
		session: fakeSession({ modelRegistry: registryFor(target) }),
		timeoutMs: 100,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("strict availability identity receipt", () => {
	it("retains configured, local-resolution, and provider-echo coordinates", () => {
		const target = model();
		const collector = new ProviderIdentityCollector();
		collector.onResponse(providerEchoMetadata(), target);

		const receipt = buildRuntimeIdentityReceipt(profile(), collector, "openai/gpt-5.6-sol");

		expect(receipt.configured).toMatchObject({
			profileId: "strict-sol",
			provider: "openai",
			model: "gpt-5.6-sol",
			checkpoint: null,
			provenance: "configured",
			modelPattern: "openai/gpt-5.6-sol",
			requestedEffort: "high",
			modelFamily: "openai",
		});
		expect(receipt.localResolution).toEqual({
			provider: "openai",
			model: "gpt-5.6-sol",
			checkpoint: null,
			provenance: "local_resolution",
		});
		expect(receipt.attested).toEqual({
			provider: "openai",
			model: "gpt-5.6-sol",
			checkpoint: "openai-checkpoint-1",
			provenance: "provider_echo",
		});
		expect(receipt.exactMatch).toBe(true);
		expect(receipt.effortSupported).toBe(true);
	});

	it("accepts a provider body model without promoting local resolution", async () => {
		const result = await probe(profile(), model(), [providerBodyMetadata()]);

		expect(result).toMatchObject({
			status: "available",
			localProvider: "openai",
			localModel: "gpt-5.6-sol",
			attestedProvider: "openai",
			attestedModel: "gpt-5.6-sol",
			identityProvenance: "provider_echo",
			exactIdentityMatch: true,
			effortSupported: true,
		});
		expect(result.attestedCheckpoint).toBeUndefined();
	});

	it("rejects a locally resolved identity placed in the attested slot", () => {
		const target = model();
		const collector = new ProviderIdentityCollector();
		collector.onResponse(providerEchoMetadata(), target);
		const receipt = buildRuntimeIdentityReceipt(profile(), collector, "openai/gpt-5.6-sol");
		receipt.attested.provenance = "local_resolution";

		expect(() => assertStrictRuntimeIdentity(receipt)).toThrow(/provider_attestation_missing/);
	});

	it("accepts a gateway attestation and exposes its checkpoint and coordinates", async () => {
		const target = model();
		const result = await probe(profile(), target, [gatewayAttestationMetadata()]);

		expect(result).toMatchObject({
			status: "available",
			localProvider: "openai",
			localModel: "gpt-5.6-sol",
			attestedProvider: "openai",
			attestedModel: "gpt-5.6-sol",
			attestedCheckpoint: "gateway-checkpoint-1",
			identityProvenance: "gateway_attestation",
			exactIdentityMatch: true,
			effortSupported: true,
			actualProvider: "openai",
			actualModel: "gpt-5.6-sol",
		});
	});

	it("fails closed for a local-only response with no provider callback", async () => {
		const result = await probe(profile(), model(), []);

		expect(result).toMatchObject({
			status: "indeterminate",
			localProvider: "openai",
			localModel: "gpt-5.6-sol",
			identityProvenance: "unknown",
			exactIdentityMatch: null,
			effortSupported: null,
			errorKind: "missing_attestation",
		});
		expect(result.attestedProvider).toBeUndefined();
		expect(result.attestedModel).toBeUndefined();
		expect(result.actualProvider).toBeUndefined();
		expect(result.actualModel).toBeUndefined();
	});

	it("fails closed when onResponse arrives without an identity attestation", async () => {
		const result = await probe(profile(), model(), [metadata({})]);

		expect(result).toMatchObject({
			status: "indeterminate",
			localProvider: "openai",
			localModel: "gpt-5.6-sol",
			identityProvenance: "unknown",
			exactIdentityMatch: null,
			effortSupported: true,
			errorKind: "missing_attestation",
		});
	});

	it("collapses conflicting provider and gateway attestations to unknown", async () => {
		const result = await probe(profile(), model(), [
			providerEchoMetadata(),
			gatewayAttestationMetadata("gpt-5.6-terra"),
		]);

		expect(result).toMatchObject({
			status: "indeterminate",
			localProvider: "openai",
			localModel: "gpt-5.6-sol",
			identityProvenance: "unknown",
			exactIdentityMatch: null,
			effortSupported: true,
			errorKind: "missing_attestation",
		});
		expect(result.attestedProvider).toBeUndefined();
		expect(result.attestedModel).toBeUndefined();
		expect(result.attestedCheckpoint).toBeUndefined();
	});

	it("fails closed when one response conflicts between header and body model coordinates", async () => {
		const response = providerEchoMetadata();
		response.metadata = { model: "gpt-5.6-terra" };

		const result = await probe(profile(), model(), [response]);

		expect(result).toMatchObject({
			status: "indeterminate",
			identityProvenance: "unknown",
			exactIdentityMatch: null,
			errorKind: "missing_attestation",
		});
		expect(result.attestedProvider).toBeUndefined();
		expect(result.attestedModel).toBeUndefined();
		expect(result.actualProvider).toBeUndefined();
		expect(result.actualModel).toBeUndefined();
	});

	it("fails closed when one response conflicts between checkpoint coordinates", async () => {
		const response = providerEchoMetadata();
		response.metadata = { model: "gpt-5.6-sol", checkpoint: "different-checkpoint" };

		const result = await probe(profile(), model(), [response]);

		expect(result).toMatchObject({
			status: "indeterminate",
			identityProvenance: "unknown",
			exactIdentityMatch: null,
			errorKind: "missing_attestation",
		});
		expect(result.attestedCheckpoint).toBeUndefined();
	});

	it("fails closed on an exact provider/model mismatch", async () => {
		const result = await probe(profile(), model(), [providerEchoMetadata("gpt-5.6-terra")]);

		expect(result).toMatchObject({
			status: "unavailable",
			localProvider: "openai",
			localModel: "gpt-5.6-sol",
			attestedProvider: "openai",
			attestedModel: "gpt-5.6-terra",
			identityProvenance: "provider_echo",
			exactIdentityMatch: false,
			effortSupported: true,
			errorKind: "identity_mismatch",
		});
		expect(result.actualProvider).toBeUndefined();
		expect(result.actualModel).toBeUndefined();
	});

	it("fails closed when the provider does not support the requested effort", async () => {
		const result = await probe(profile(), model({ thinking: { mode: "effort", efforts: [Effort.Low] } }), [
			providerEchoMetadata(),
		]);

		expect(result).toMatchObject({
			status: "unavailable",
			localProvider: "openai",
			localModel: "gpt-5.6-sol",
			attestedProvider: "openai",
			attestedModel: "gpt-5.6-sol",
			identityProvenance: "provider_echo",
			exactIdentityMatch: true,
			effortSupported: false,
			errorKind: "unsupported_effort",
		});
	});
});

describe("legacy non-strict availability", () => {
	it("keeps legacy availability when identity attestation is absent", async () => {
		const result = await probe(
			profile({ id: "legacy", strictIdentity: false, thinkingLevel: undefined }),
			model(),
			[metadata({})],
			{ provider: "openai", model: "response-only-model" },
		);

		expect(result).toMatchObject({
			status: "available",
			localProvider: "openai",
			localModel: "gpt-5.6-sol",
			identityProvenance: "unknown",
			exactIdentityMatch: null,
			effortSupported: null,
			actualProvider: "openai",
			actualModel: "response-only-model",
		});
		expect(result.attestedProvider).toBeUndefined();
		expect(result.attestedModel).toBeUndefined();
		expect(result.errorKind).toBeUndefined();
	});
});
