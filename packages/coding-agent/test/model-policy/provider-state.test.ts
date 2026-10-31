import { describe, expect, it } from "bun:test";
import {
	captureProviderOpaqueState,
	computePayloadByteHash,
	opaqueStateReceiptView,
	ownerHashOf,
	ownerKey,
	type ProviderOpaqueOwner,
	type ProviderOpaqueStateEnvelope,
	payloadHashOf,
	selectReplayableOpaqueState,
	stableStringify,
	verifyEnvelopeIntegrity,
} from "../../src/model-policy";

const openaiOwner: ProviderOpaqueOwner = {
	provider: "openai",
	model: "gpt-5",
	api: "responses",
};

const anthropicOwner: ProviderOpaqueOwner = {
	provider: "anthropic",
	model: "claude-4",
	api: "messages",
};

describe("captureProviderOpaqueState", () => {
	it("captures thinkingSignature, thoughtSignature, and providerPayload as SSOT envelopes", () => {
		const secretSig = "enc-reasoning-item-do-not-leak";
		const thoughtSig = "gemini-thought-sig-secret";
		const historyPayload = {
			type: "openaiResponsesHistory",
			provider: "openai",
			items: [{ type: "reasoning", encrypted_content: "opaque-bytes-xyz" }],
		};

		const result = captureProviderOpaqueState(
			[
				{
					role: "assistant",
					provider: "openai",
					model: "gpt-5",
					api: "responses",
					providerPayload: historyPayload,
					content: [
						{ type: "thinking", thinking: "visible", thinkingSignature: secretSig },
						{
							type: "toolCall",
							id: "call_1",
							name: "read",
							thoughtSignature: thoughtSig,
						},
					],
				},
			],
			{ activeOwner: openaiOwner, includeIneligible: true },
		);

		expect(result.replayable.length).toBeGreaterThanOrEqual(2);
		expect(result.continuation).toBe("provider_native");
		expect(result.receiptEntries.every(e => typeof e.payloadHash === "string" && e.payloadHash.length > 0)).toBe(
			true,
		);

		const receiptJson = stableStringify(result.receiptEntries);
		expect(receiptJson).not.toContain(secretSig);
		expect(receiptJson).not.toContain(thoughtSig);
		expect(receiptJson).not.toContain("opaque-bytes-xyz");
		expect(receiptJson).not.toContain("do-not-leak");
	});

	it("defers foreign owner envelopes without textifying and forces new-chain when none match", () => {
		const envelopeCapture = captureProviderOpaqueState(
			[
				{
					role: "assistant",
					provider: "anthropic",
					model: "claude-4",
					api: "messages",
					content: [{ type: "thinking", thinking: "x", thinkingSignature: "anthropic-sig-secret" }],
				},
			],
			{ activeOwner: openaiOwner, includeIneligible: true },
		);

		expect(envelopeCapture.replayable).toHaveLength(0);
		expect(envelopeCapture.deferred.length).toBeGreaterThan(0);
		expect(envelopeCapture.continuation).toBe("new_chain");
		expect(envelopeCapture.notes.some(n => n.startsWith("opaque_state_owner_mismatch:"))).toBe(true);

		const selected = selectReplayableOpaqueState(envelopeCapture.envelopes, openaiOwner);
		expect(selected.replayable).toHaveLength(0);
		expect(selected.continuation).toBe("new_chain");

		// Switching back to original owner restores native replay eligibility.
		const restored = selectReplayableOpaqueState(envelopeCapture.envelopes, anthropicOwner);
		expect(restored.replayable.length).toBe(envelopeCapture.deferred.length);
		expect(restored.continuation).toBe("provider_native");
	});

	it("hashes payload integrity and rejects mismatched integrity for replay", () => {
		const payload = { thinkingSignature: "sig-1" };
		const good: ProviderOpaqueStateEnvelope = {
			schemaVersion: 1,
			owner: openaiOwner,
			kind: "openai_reasoning_item",
			payload,
			integrity: {
				byteHash: computePayloadByteHash(payload),
				encoding: "provider_native_object",
			},
			replay: "required_full_turn",
		};
		expect(verifyEnvelopeIntegrity(good).ok).toBe(true);
		expect(payloadHashOf(good)).toBeTruthy();
		expect(ownerHashOf(good.owner)).toBeTruthy();
		expect(ownerKey(good.owner)).toBe("openai|gpt-5|responses");

		const bad: ProviderOpaqueStateEnvelope = {
			...good,
			integrity: { byteHash: "not-the-real-hash", encoding: "provider_native_object" },
		};
		expect(verifyEnvelopeIntegrity(bad).ok).toBe(false);

		const selected = selectReplayableOpaqueState([bad], openaiOwner);
		expect(selected.replayable).toHaveLength(0);
		expect(selected.notes.some(n => n.startsWith("opaque_integrity_mismatch:"))).toBe(true);
	});

	it("supports compaction-compatible artifact references without rewriting payload", () => {
		const result = captureProviderOpaqueState(
			[
				{
					role: "assistant",
					provider: "openai",
					model: "gpt-5",
					api: "responses",
					content: [{ type: "thinking", thinking: "t", thinkingSignature: "sig-compact" }],
				},
			],
			{
				activeOwner: openaiOwner,
				preservedStateArtifact: "artifact://opaque-state/turn-1",
			},
		);

		expect(result.contextCheckpoint?.preservedStateArtifact).toBe("artifact://opaque-state/turn-1");
		expect(result.notes.some(n => n.includes("opaque_state_compaction_ref:"))).toBe(true);
		// Payload still present on envelope (SSOT reference), never moved into receipt text.
		expect(result.replayable[0]?.payload).toEqual({ thinkingSignature: "sig-compact" });
		const view = opaqueStateReceiptView(result.replayable);
		expect(stableStringify(view)).not.toContain("sig-compact");
	});

	it("model switch across APIs keeps envelopes held but non-replayable", () => {
		const captured = captureProviderOpaqueState(
			[
				{
					role: "assistant",
					provider: "openai",
					model: "gpt-5",
					api: "responses",
					content: [{ type: "thinking", thinking: "t", thinkingSignature: "responses-sig" }],
				},
			],
			{ activeOwner: openaiOwner, includeIneligible: true },
		);

		const chatOwner: ProviderOpaqueOwner = {
			provider: "openai",
			model: "gpt-5",
			api: "openai-completions",
		};
		const switched = selectReplayableOpaqueState(captured.envelopes, chatOwner);
		expect(switched.replayable).toHaveLength(0);
		expect(switched.deferred.length).toBe(captured.envelopes.length);
		expect(switched.continuation).toBe("new_chain");
	});
});
