/**
 * On-demand capture and owner/integrity checks for provider-native opaque state.
 *
 * SSOT remains AssistantMessage content signatures and providerPayload.
 * This module never persists a second payload copy and never textifies opaque bytes.
 * Receipts only carry owner/payload hashes.
 */

import {
	envelopeOpaqueReceiptFields,
	fingerprintValue,
	ownerHash,
	payloadHash,
	sha256Hex,
	stableStringify,
} from "./receipt";
import type {
	ProviderOpaqueEncoding,
	ProviderOpaqueReplay,
	ProviderOpaqueStateEnvelope,
	ProviderOpaqueStateKind,
} from "./types";
export const PROVIDER_OPAQUE_STATE_RECEIPT_KIND = "model-policy-opaque-state-receipt-v1" as const;

/** Duck-typed message surface used for capture (AssistantMessage-compatible). */
export interface ProviderStateSourceBlock {
	type: string;
	thinking?: string;
	thinkingSignature?: string;
	textSignature?: string;
	thoughtSignature?: string;
	data?: string;
	id?: string;
	name?: string;
}

export interface ProviderStateSourceMessage {
	role: string;
	provider?: string;
	model?: string;
	api?: string;
	content?: readonly ProviderStateSourceBlock[];
	providerPayload?: unknown;
	responseId?: string;
}

export interface ProviderOpaqueOwner {
	provider: string;
	model: string;
	api: string;
	conversationId?: string;
}

export interface CaptureProviderOpaqueStateOptions {
	/** Active model owner for eligibility checks. */
	activeOwner: ProviderOpaqueOwner;
	/**
	 * Optional durable artifact URI when envelopes were moved off the live message
	 * view (compaction). Payload itself is never rewritten — only the reference is noted.
	 */
	preservedStateArtifact?: string;
	/** When true, include envelopes owned by foreign models (held, not replayed). */
	includeIneligible?: boolean;
}

export interface ProviderOpaqueCaptureResult {
	/** Envelopes eligible for native replay under activeOwner. */
	replayable: ProviderOpaqueStateEnvelope[];
	/** Foreign/stale envelopes retained without textification. */
	deferred: ProviderOpaqueStateEnvelope[];
	/** All captured envelopes (replayable first, then deferred). */
	envelopes: ProviderOpaqueStateEnvelope[];
	/** Continuation decision for the active owner. */
	continuation: "provider_native" | "new_chain";
	/** Owner keys that must not be replayed. */
	ineligibleOwnerKeys: string[];
	/** Receipt-safe entries (hashes only). */
	receiptEntries: Array<{
		kind: string;
		ownerHash: string;
		payloadHash: string;
		replay: ProviderOpaqueReplay;
		replayable: boolean;
	}>;
	/** Non-fatal diagnostics. */
	notes: string[];
	/** Compaction-compatible reference when envelopes are held off-view. */
	contextCheckpoint?: {
		preservedStateArtifact: string;
		omittedArtifactUris: string[];
	};
}

export function ownerKey(owner: ProviderOpaqueOwner): string {
	return `${owner.provider}|${owner.model}|${owner.api}`;
}

export function isOwnerCompatible(envelope: ProviderOpaqueStateEnvelope, activeOwner: ProviderOpaqueOwner): boolean {
	return (
		envelope.owner.provider === activeOwner.provider &&
		envelope.owner.model === activeOwner.model &&
		envelope.owner.api === activeOwner.api
	);
}

/** Canonical integrity hash over opaque payload bytes/object (never for prompts). */
export function computePayloadByteHash(payload: unknown): string {
	if (typeof payload === "string") {
		return sha256Hex(payload);
	}
	if (payload instanceof Uint8Array) {
		return sha256Hex(Buffer.from(payload).toString("base64"));
	}
	return fingerprintValue(payload);
}

export function verifyEnvelopeIntegrity(envelope: ProviderOpaqueStateEnvelope): {
	ok: boolean;
	expected?: string;
	actual?: string;
} {
	const actual = computePayloadByteHash(envelope.payload);
	const expected = envelope.integrity.byteHash;
	if (!expected) {
		return { ok: false, actual };
	}
	return { ok: expected === actual, expected, actual };
}

function messageOwner(message: ProviderStateSourceMessage, fallback: ProviderOpaqueOwner): ProviderOpaqueOwner {
	return {
		provider: message.provider ?? fallback.provider,
		model: message.model ?? fallback.model,
		api: message.api ?? fallback.api,
		conversationId: fallback.conversationId,
	};
}

function inferKind(
	block: ProviderStateSourceBlock,
	message: ProviderStateSourceMessage,
): ProviderOpaqueStateKind | null {
	if (block.type === "toolCall" && nonEmpty(block.thoughtSignature)) {
		return "gemini_thought_signature";
	}
	if (block.type === "text" && nonEmpty(block.textSignature)) {
		return "gemini_thought_signature";
	}
	if (block.type === "thinking" && nonEmpty(block.thinkingSignature)) {
		if (block.thinkingSignature === "reasoning_content") {
			return "deepseek_reasoning_content";
		}
		const api = (message.api ?? "").toLowerCase();
		const provider = (message.provider ?? "").toLowerCase();
		if (api.includes("responses") || provider.includes("openai") || provider.includes("codex")) {
			return "openai_reasoning_item";
		}
		if (provider.includes("google") || provider.includes("gemini") || api.includes("google")) {
			return "gemini_thought_signature";
		}
		if (provider.includes("deepseek")) {
			return "deepseek_reasoning_content";
		}
		return "anthropic_thinking_block";
	}
	if (block.type === "redactedThinking" && nonEmpty(block.data)) {
		return "anthropic_thinking_block";
	}
	return null;
}

function inferReplay(kind: ProviderOpaqueStateKind, block: ProviderStateSourceBlock): ProviderOpaqueReplay {
	if (block.type === "toolCall" || kind === "gemini_thought_signature") {
		return "required_with_tool_result";
	}
	if (kind === "openai_reasoning_item") {
		return "required_full_turn";
	}
	return "required_full_turn";
}

function nonEmpty(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function envelopeFromPayload(
	owner: ProviderOpaqueOwner,
	kind: ProviderOpaqueStateKind,
	payload: unknown,
	replay: ProviderOpaqueReplay,
	encoding: ProviderOpaqueEncoding = "provider_native_object",
): ProviderOpaqueStateEnvelope {
	return {
		schemaVersion: 1,
		owner: { ...owner },
		kind,
		payload,
		integrity: {
			byteHash: computePayloadByteHash(payload),
			encoding,
		},
		replay,
	};
}

/**
 * Capture provider-native opaque state from existing message signatures/payloads.
 * Does not mutate messages and does not create a second durable payload store.
 */
export function captureProviderOpaqueState(
	messages: readonly ProviderStateSourceMessage[],
	options: CaptureProviderOpaqueStateOptions,
): ProviderOpaqueCaptureResult {
	const notes: string[] = [];
	const captured: ProviderOpaqueStateEnvelope[] = [];
	const seen = new Set<string>();

	const pushUnique = (envelope: ProviderOpaqueStateEnvelope): void => {
		const key = `${ownerKey(envelope.owner)}|${envelope.kind}|${envelope.integrity.byteHash}`;
		if (seen.has(key)) return;
		seen.add(key);
		captured.push(envelope);
	};

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const owner = messageOwner(message, options.activeOwner);

		if (message.providerPayload != null) {
			const payload = message.providerPayload;
			let kind: ProviderOpaqueStateKind = "provider_native_other";
			if (payload && typeof payload === "object" && "type" in payload && payload.type === "openaiResponsesHistory") {
				kind = "openai_reasoning_item";
			}
			pushUnique(envelopeFromPayload(owner, kind, payload, "required_full_turn", "provider_native_object"));
		}

		for (const block of message.content ?? []) {
			const kind = inferKind(block, message);
			if (!kind) continue;

			let payload: unknown;
			if (
				block.type === "toolCall" &&
				typeof block.thoughtSignature === "string" &&
				block.thoughtSignature.trim().length > 0
			) {
				payload = {
					toolCallId: block.id,
					name: block.name,
					thoughtSignature: block.thoughtSignature,
				};
			} else if (
				block.type === "text" &&
				typeof block.textSignature === "string" &&
				block.textSignature.trim().length > 0
			) {
				payload = { textSignature: block.textSignature };
			} else if (
				block.type === "thinking" &&
				typeof block.thinkingSignature === "string" &&
				block.thinkingSignature.trim().length > 0
			) {
				if (block.thinkingSignature === "reasoning_content") {
					// DeepSeek: marker only; native reasoning text stays on the thinking block SSOT.
					payload = { marker: "reasoning_content" };
				} else {
					payload = { thinkingSignature: block.thinkingSignature };
				}
			} else if (
				block.type === "redactedThinking" &&
				typeof block.data === "string" &&
				block.data.trim().length > 0
			) {
				payload = { data: block.data };
			} else {
				continue;
			}

			pushUnique(envelopeFromPayload(owner, kind, payload, inferReplay(kind, block)));
		}
	}

	const replayable: ProviderOpaqueStateEnvelope[] = [];
	const deferred: ProviderOpaqueStateEnvelope[] = [];
	const ineligibleOwnerKeys: string[] = [];

	for (const envelope of captured) {
		const integrity = verifyEnvelopeIntegrity(envelope);
		if (!integrity.ok) {
			notes.push(`opaque_integrity_mismatch:${envelope.kind}:${ownerKey(envelope.owner)}`);
			// Integrity failures are never replayable; keep for diagnostics unless caller excludes ineligible.
			deferred.push(envelope);
			ineligibleOwnerKeys.push(ownerKey(envelope.owner));
			continue;
		}

		if (isOwnerCompatible(envelope, options.activeOwner)) {
			replayable.push(envelope);
		} else {
			deferred.push(envelope);
			const key = ownerKey(envelope.owner);
			if (!ineligibleOwnerKeys.includes(key)) {
				ineligibleOwnerKeys.push(key);
			}
			notes.push(`opaque_state_owner_mismatch:${key}`);
		}
	}

	const envelopes = options.includeIneligible === false ? [...replayable] : [...replayable, ...deferred];

	const continuation: "provider_native" | "new_chain" =
		replayable.length > 0 && deferred.length === 0
			? "provider_native"
			: replayable.length > 0
				? "provider_native"
				: captured.length > 0
					? "new_chain"
					: "provider_native";

	if (captured.length > 0 && replayable.length === 0) {
		notes.push("opaque_state_all_ineligible:new_chain");
	}

	const receiptEntries = envelopes.map(envelope => ({
		...envelopeOpaqueReceiptFields(envelope),
		replayable: isOwnerCompatible(envelope, options.activeOwner) && verifyEnvelopeIntegrity(envelope).ok,
	}));

	// Hard invariant: receipt must never embed raw payloads.
	const receiptJson = stableStringify(receiptEntries);
	for (const envelope of envelopes) {
		if (
			typeof envelope.payload === "string" &&
			envelope.payload.length > 0 &&
			receiptJson.includes(envelope.payload)
		) {
			throw new Error("opaque_payload_leaked_into_receipt");
		}
	}

	const result: ProviderOpaqueCaptureResult = {
		replayable,
		deferred,
		envelopes,
		continuation: replayable.length > 0 ? "provider_native" : continuation,
		ineligibleOwnerKeys,
		receiptEntries,
		notes,
	};

	if (options.preservedStateArtifact) {
		result.contextCheckpoint = {
			preservedStateArtifact: options.preservedStateArtifact,
			// Compaction moves envelopes by reference; payload bytes are not rewritten.
			omittedArtifactUris: [],
		};
		notes.push(`opaque_state_compaction_ref:${options.preservedStateArtifact}`);
	}

	return result;
}

/**
 * Select envelopes that may be attached to the next provider request for activeOwner.
 * Cross-owner state is never returned for replay (new-chain path).
 */
export function selectReplayableOpaqueState(
	envelopes: readonly ProviderOpaqueStateEnvelope[],
	activeOwner: ProviderOpaqueOwner,
): {
	replayable: ProviderOpaqueStateEnvelope[];
	deferred: ProviderOpaqueStateEnvelope[];
	continuation: "provider_native" | "new_chain";
	ownerHashes: string[];
	notes: string[];
} {
	const replayable: ProviderOpaqueStateEnvelope[] = [];
	const deferred: ProviderOpaqueStateEnvelope[] = [];
	const notes: string[] = [];

	for (const envelope of envelopes) {
		const integrity = verifyEnvelopeIntegrity(envelope);
		if (!integrity.ok) {
			deferred.push(envelope);
			notes.push(`opaque_integrity_mismatch:${envelope.kind}`);
			continue;
		}
		if (isOwnerCompatible(envelope, activeOwner)) {
			replayable.push(envelope);
		} else {
			deferred.push(envelope);
			notes.push(`opaque_state_owner_mismatch:${ownerKey(envelope.owner)}`);
		}
	}

	return {
		replayable,
		deferred,
		continuation: replayable.length > 0 ? "provider_native" : envelopes.length > 0 ? "new_chain" : "provider_native",
		ownerHashes: replayable.map(envelope => ownerHash(envelope.owner)),
		notes,
	};
}

/** Hash-only view for receipts / fingerprints. */
export function opaqueStateReceiptView(envelopes: readonly ProviderOpaqueStateEnvelope[]): Array<{
	kind: string;
	ownerHash: string;
	payloadHash: string;
	replay: ProviderOpaqueReplay;
}> {
	return envelopes.map(envelopeOpaqueReceiptFields);
}

export function payloadHashOf(envelope: ProviderOpaqueStateEnvelope): string {
	return payloadHash(envelope);
}

export function ownerHashOf(owner: ProviderOpaqueOwner): string {
	return ownerHash(owner);
}
