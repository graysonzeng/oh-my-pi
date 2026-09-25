/**
 * Deterministic fingerprints and opaque-state hashing for model policy receipts.
 * Opaque payloads are never written into receipts — only owner/payload hashes.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelFactsV1, ProviderOpaqueStateEnvelope, SessionPolicyStateV1, TaskRolePolicyV1 } from "./types";

function stableClone(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => stableClone(item));
	}
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = stableClone(value[key]);
		}
		return sorted;
	}
	return value;
}

/** Canonical JSON with sorted object keys for deterministic hashing. */
export function stableStringify(value: unknown): string {
	return JSON.stringify(stableClone(value));
}

export function sha256Hex(content: string): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export function fingerprintValue(value: unknown): string {
	return sha256Hex(stableStringify(value));
}

/**
 * Fingerprint model facts. Identity + capability axes only.
 * Provenance is recorded separately in the receipt and does not change capability decisions.
 */
export function fingerprintModelFacts(facts: ModelFactsV1): string {
	return fingerprintValue({
		schemaVersion: facts.schemaVersion,
		identity: facts.identity,
		reasoning: facts.reasoning,
		tools: facts.tools,
		structuredOutput: facts.structuredOutput,
		context: facts.context,
		cache: facts.cache,
	});
}

export function fingerprintTaskPolicy(policy: TaskRolePolicyV1): string {
	return fingerprintValue(policy);
}

/**
 * Session fingerprint excludes opaque payloads (only owner/kind/integrity hashes).
 * Payload bytes must never enter receipts or prompt templates.
 */
export function fingerprintSessionState(state: SessionPolicyStateV1): string {
	return fingerprintValue({
		schemaVersion: state.schemaVersion,
		activeModelFactsFingerprint: state.activeModelFactsFingerprint,
		turnOrStageId: state.turnOrStageId,
		unresolvedItems: state.unresolvedItems,
		requiredArtifactStatus: state.requiredArtifactStatus,
		verificationEvidence: state.verificationEvidence,
		scopeStatus: state.scopeStatus,
		toolLedger: state.toolLedger,
		providerState: state.providerState.map(envelopeOpaqueReceiptFields),
		contextCheckpoint: state.contextCheckpoint,
	});
}

export function ownerHash(owner: ProviderOpaqueStateEnvelope["owner"]): string {
	return fingerprintValue(owner);
}

export function payloadHash(envelope: ProviderOpaqueStateEnvelope): string {
	// Prefer declared integrity hash when present; still hash encoding for stability.
	if (envelope.integrity.byteHash) {
		return fingerprintValue({
			byteHash: envelope.integrity.byteHash,
			encoding: envelope.integrity.encoding,
		});
	}
	return fingerprintValue({
		encoding: envelope.integrity.encoding,
		payload: envelope.payload,
	});
}

export function envelopeOpaqueReceiptFields(envelope: ProviderOpaqueStateEnvelope): {
	kind: string;
	ownerHash: string;
	payloadHash: string;
	replay: ProviderOpaqueStateEnvelope["replay"];
} {
	return {
		kind: envelope.kind,
		ownerHash: ownerHash(envelope.owner),
		payloadHash: payloadHash(envelope),
		replay: envelope.replay,
	};
}

export function opaqueStateReceiptEntries(
	envelopes: ProviderOpaqueStateEnvelope[],
	replayedOwnerKeys: ReadonlySet<string>,
): Array<{ kind: string; ownerHash: string; payloadHash: string; replayed: boolean }> {
	return envelopes.map(envelope => {
		const owner = ownerHash(envelope.owner);
		const ownerKey = `${envelope.owner.provider}|${envelope.owner.model}|${envelope.owner.api}`;
		return {
			kind: envelope.kind,
			ownerHash: owner,
			payloadHash: payloadHash(envelope),
			replayed: replayedOwnerKeys.has(ownerKey),
		};
	});
}
