import type { Api, Model, ProviderResponseMetadata, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { parseModelString } from "../config/model-resolver";
import { WorkflowIdentityError } from "./errors";
import { configuredIdentityForProfile } from "./model-profile-registry";
import type {
	ConfiguredModelIdentityV1,
	ModelIdentityCoordinatesV1,
	ModelIdentityProvenance,
	ModelProfile,
	WorkflowRuntimeIdentityReceiptV1,
} from "./types";

const GATEWAY_MODEL_HEADERS = [
	"x-omp-resolved-model",
	"x-litellm-model-id",
	"x-litellm-model",
	"x-resolved-model",
	"x-model-id",
] as const;
const PROVIDER_MODEL_HEADERS = ["x-provider-model", "openai-model", "anthropic-model"] as const;
const PROVIDER_HEADERS = [
	"x-omp-resolved-provider",
	"x-litellm-provider",
	"x-resolved-provider",
	"x-provider-id",
] as const;
const CHECKPOINT_HEADERS = ["x-omp-model-checkpoint", "x-model-checkpoint", "x-litellm-model-version"] as const;

interface CapturedAttestation {
	provider: string;
	model: string;
	checkpoint: string | null;
	provenance: Extract<ModelIdentityProvenance, "provider_echo" | "gateway_attestation">;
}

function firstHeader(headers: Readonly<Record<string, string>>, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = headers[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function metadataString(
	metadata: Readonly<Record<string, unknown>> | undefined,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = metadata?.[name];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function normalizedAttestedIdentity(
	response: ProviderResponseMetadata,
	localModel: Model<Api> | undefined,
): CapturedAttestation | undefined {
	const headerValues = (names: readonly string[]): string[] =>
		names.map(name => response.headers[name]?.trim()).filter((value): value is string => Boolean(value));
	const metadataValues = (names: readonly string[]): string[] =>
		names
			.map(name => response.metadata?.[name])
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.map(value => value.trim());
	const gatewayModels = headerValues(GATEWAY_MODEL_HEADERS);
	const providerModels = headerValues(PROVIDER_MODEL_HEADERS);
	const metadataModels = metadataValues(["resolvedModel", "model", "modelId"]);
	const modelValues = [...gatewayModels, ...providerModels, ...metadataModels];
	if (modelValues.length === 0) return undefined;
	const attestedModels = new Set(modelValues.map(value => parseModelString(value)?.id ?? value));
	if (attestedModels.size !== 1) return undefined;

	const checkpointValues = [
		...headerValues(CHECKPOINT_HEADERS),
		...metadataValues(["checkpoint", "modelCheckpoint", "modelVersion"]),
	];
	const checkpoints = new Set(checkpointValues);
	if (checkpoints.size > 1) return undefined;

	const gatewayModel = gatewayModels[0];
	const providerModel = providerModels[0];
	const metadataModel = metadataModels[0];
	const modelValue = gatewayModel ?? providerModel ?? metadataModel!;
	const parsed = parseModelString(modelValue);
	const attestedModel = attestedModels.values().next().value;
	const attestedProvider = gatewayModel
		? (parsed?.provider ?? localModel?.provider)
		: (firstHeader(response.headers, PROVIDER_HEADERS) ??
			metadataString(response.metadata, ["resolvedProvider", "provider", "providerId"]) ??
			parsed?.provider ??
			localModel?.provider);
	if (!attestedProvider || !attestedModel) return undefined;
	return {
		provider: attestedProvider,
		model: attestedModel,
		checkpoint: checkpointValues[0] ?? null,
		provenance: gatewayModel ? "gateway_attestation" : "provider_echo",
	};
}

function sameAttestation(left: CapturedAttestation, right: CapturedAttestation): boolean {
	return (
		left.provider === right.provider &&
		left.model === right.model &&
		left.checkpoint === right.checkpoint &&
		left.provenance === right.provenance
	);
}

export class ProviderIdentityCollector {
	#responses = 0;
	#missingAttestations = 0;
	#conflictingAttestations = false;
	#attestation: CapturedAttestation | undefined;
	#localProvider: string | null = null;
	#localModel: string | null = null;
	#efforts: readonly string[] | null = null;

	readonly onResponse: NonNullable<SimpleStreamOptions["onResponse"]> = (response, model) => {
		this.#responses += 1;
		if (model) {
			this.#localProvider = model.provider;
			this.#localModel = model.id;
			this.#efforts = getSupportedEfforts(model);
		}
		const attestation = normalizedAttestedIdentity(response, model);
		if (!attestation) {
			this.#missingAttestations += 1;
			return;
		}
		if (this.#attestation && !sameAttestation(this.#attestation, attestation)) {
			this.#conflictingAttestations = true;
			return;
		}
		this.#attestation = attestation;
	};

	localResolution(fallback?: string): ModelIdentityCoordinatesV1 {
		const parsed = fallback ? parseModelString(fallback) : undefined;
		return {
			provider: this.#localProvider ?? parsed?.provider ?? null,
			model: this.#localModel ?? parsed?.id ?? null,
			checkpoint: null,
			provenance: "local_resolution",
		};
	}

	attestedIdentity(): ModelIdentityCoordinatesV1 {
		if (
			this.#responses === 0 ||
			this.#missingAttestations > 0 ||
			this.#conflictingAttestations ||
			!this.#attestation
		) {
			return { provider: null, model: null, checkpoint: null, provenance: "unknown" };
		}
		return { ...this.#attestation };
	}

	effortSupported(effort: ModelProfile["thinkingLevel"]): boolean | null {
		if (!effort || effort === "auto" || !this.#efforts) return null;
		return this.#efforts.includes(effort);
	}
}

export function buildRuntimeIdentityReceipt(
	profile: ModelProfile,
	collector: ProviderIdentityCollector,
	localResolvedModel?: string,
): WorkflowRuntimeIdentityReceiptV1 {
	let configured: ConfiguredModelIdentityV1;
	try {
		configured = configuredIdentityForProfile(profile);
	} catch {
		configured = {
			profileId: profile.id,
			provider: null,
			model: null,
			checkpoint: null,
			provenance: "configured" as const,
			modelPattern: Array.isArray(profile.modelPattern) ? profile.modelPattern.join(",") : profile.modelPattern,
			requestedEffort: profile.thinkingLevel ?? null,
			modelFamily: null,
		};
	}
	const localResolution = collector.localResolution(localResolvedModel);
	const attested = collector.attestedIdentity();
	const exactMatch =
		configured.provider && configured.model && attested.provider && attested.model
			? configured.provider === attested.provider && configured.model === attested.model
			: null;
	const modelFamily = attested.model ? modelFamilyToken(attested.model) || null : null;
	return {
		schemaVersion: 1,
		configured,
		localResolution,
		attested,
		exactMatch,
		effortSupported: collector.effortSupported(profile.thinkingLevel),
		modelFamily,
	};
}

export function assertStrictRuntimeIdentity(receipt: WorkflowRuntimeIdentityReceiptV1): void {
	if (
		(receipt.attested.provenance !== "provider_echo" && receipt.attested.provenance !== "gateway_attestation") ||
		!receipt.attested.provider ||
		!receipt.attested.model
	) {
		throw new WorkflowIdentityError("provider_attestation_missing", { receipt });
	}
	if (receipt.exactMatch !== true) {
		throw new WorkflowIdentityError("provider_identity_mismatch", { receipt });
	}
	if (receipt.effortSupported !== true) {
		throw new WorkflowIdentityError("requested_effort_unsupported", { receipt });
	}
	if (!receipt.modelFamily || receipt.modelFamily !== receipt.configured.modelFamily) {
		throw new WorkflowIdentityError("attested_lineage_mismatch", { receipt });
	}
}
