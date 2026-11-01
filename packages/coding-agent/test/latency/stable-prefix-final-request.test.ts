/**
 * W5 final provider-serialize observe + usage association.
 *
 * Failure modes if these regress:
 * - observe stays assembly-only (no final-request boundary)
 * - raw prompt/tool body leaks into receipts
 * - usage association invents zeros or claims live wins
 * - tool schema fingerprint ignores sent tools JSON
 */
import { describe, expect, it } from "bun:test";
import {
	associateStablePrefixObserveUsage,
	fingerprintToolSchemasForSend,
	observeStablePrefixAtAssembly,
	observeStablePrefixAtFinalRequest,
	segmentsFromFinalProviderPayload,
	usageMetricsFromProviderUsage,
} from "../../src/latency/stable-prefix-assembly-bridge";
import { defaultStablePrefixCacheExperimentConfig } from "../../src/latency/stable-prefix-cache-experiment";
import { cfgStablePrefixCacheExperimentEnabled } from "../../src/session/context-settings";

describe("W5 final-request observe", () => {
	it("fingerprints serialized tools/system/messages without retaining secrets", () => {
		const payload = {
			model: "claude-sonnet-4-5",
			system: "STATIC RULES SECRET=never-log-this",
			messages: [{ role: "user", content: "TASK SECRET=also-hidden" }],
			tools: [
				{
					name: "bash",
					input_schema: {
						type: "object",
						properties: { command: { type: "string" } },
						required: ["command"],
					},
				},
			],
		};
		const extracted = segmentsFromFinalProviderPayload(payload);
		expect(extracted.toolSchemaFromPayload).toBe(true);
		expect(extracted.toolSchemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(extracted.segments.some(s => s.kind === "tools")).toBe(true);
		expect(extracted.segments.some(s => s.kind === "static_rules")).toBe(true);
		expect(extracted.segments.some(s => s.kind === "dynamic_context")).toBe(true);

		const observe = observeStablePrefixAtFinalRequest({
			payload,
			config: { enabled: true, factor: "inspect_provider_prefix" },
			scope: "same_child_session",
			providerIdentity: { provider: "anthropic", model: "claude-sonnet-4-5" },
		});
		expect(observe.boundary).toBe("provider_final_serialize");
		expect(observe.toolSchemaFromPayload).toBe(true);
		expect(observe.providerIdentity.toolSchemaFingerprint).toBe(extracted.toolSchemaFingerprint);
		expect(observe.claimedLiveWin).toBe(false);
		expect(observe.metrics.cacheRead).toBeNull();
		expect(JSON.stringify(observe)).not.toContain("never-log-this");
		expect(JSON.stringify(observe)).not.toContain("also-hidden");
	});

	it("associates real usage when present and leaves unknowns null", () => {
		const observe = observeStablePrefixAtFinalRequest({
			payload: { messages: [], tools: [] },
			config: defaultStablePrefixCacheExperimentConfig(),
			scope: "same_child_session",
		});
		expect(observe.applied).toBe(false);
		const associated = associateStablePrefixObserveUsage(
			observe,
			usageMetricsFromProviderUsage(
				{
					cacheRead: 120,
					cost: { total: 0.012 },
				},
				85,
			),
		);
		expect(associated.metrics.cacheRead).toBe(120);
		expect(associated.metrics.costTotal).toBe(0.012);
		expect(associated.metrics.ttftMs).toBe(85);
		expect(associated.claimedLiveWin).toBe(false);

		const partial = associateStablePrefixObserveUsage(observe, usageMetricsFromProviderUsage({}));
		expect(partial.metrics.cacheRead).toBeNull();
		expect(partial.metrics.ttftMs).toBeNull();
		expect(partial.metrics.costTotal).toBeNull();
	});

	it("fingerprintToolSchemasForSend prefers full schemas over names-only", () => {
		const namesOnly = fingerprintToolSchemasForSend({
			names: ["bash", "read"],
			mode: "direct",
		});
		const withSchemas = fingerprintToolSchemasForSend({
			names: ["bash", "read"],
			mode: "direct",
			schemas: {
				bash: { type: "object", properties: { command: { type: "string" } } },
				read: { type: "object", properties: { path: { type: "string" } } },
			},
		});
		expect(namesOnly).not.toBe(withSchemas);
		expect(withSchemas).toMatch(/^[a-f0-9]{64}$/);
	});

	it("experiment default stays off; assembly observe still does not claim live win", () => {
		expect(cfgStablePrefixCacheExperimentEnabled.default).toBe(false);
		const bridge = observeStablePrefixAtAssembly({
			sections: [
				{ id: "system_static", content: "rules", stable: true },
				{ id: "assignment", content: "task", stable: false },
			],
			config: defaultStablePrefixCacheExperimentConfig(),
		});
		expect(bridge.observe.applied).toBe(false);
		expect(bridge.observe.claimedLiveWin).toBe(false);
		expect(bridge.observe.metrics.cacheRead).toBeNull();
	});
});
