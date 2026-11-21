/**
 * W5 final provider-serialize observe + usage association.
 *
 * Failure modes if these regress:
 * - observe stays assembly-only (no final-request boundary)
 * - raw prompt/tool body leaks into receipts or prefix diffs
 * - usage association invents zeros or claims live wins
 * - tool schema fingerprint ignores sent tools JSON
 * - consecutive observes collapse a tools/rules/dynamic/identity/order miss into "none"
 */
import { describe, expect, it } from "bun:test";
import {
	associateStablePrefixObserveUsage,
	diffStablePrefixObservations,
	fingerprintToolSchemasForSend,
	observeStablePrefixAtAssembly,
	observeStablePrefixAtFinalRequest,
	segmentsFromFinalProviderPayload,
	usageMetricsFromProviderUsage,
} from "../../src/latency/stable-prefix-assembly-bridge";
import {
	defaultStablePrefixCacheExperimentConfig,
	fingerprintProviderSegment,
} from "../../src/latency/stable-prefix-cache-experiment";
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

const SECRET_STATIC = "STATIC RULES SECRET=never-log-this";
const SECRET_TASK = "TASK SECRET=also-hidden";

function finalObserve(
	payload: unknown,
	providerIdentity: { provider?: string; api?: string; model?: string; effortFingerprint?: string } = {
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	},
) {
	return observeStablePrefixAtFinalRequest({
		payload,
		config: defaultStablePrefixCacheExperimentConfig(),
		scope: "same_child_session",
		providerIdentity,
	});
}

function basePayload(patch?: { system?: string; task?: string; toolName?: string }) {
	return {
		model: "claude-sonnet-4-5",
		system: patch?.system ?? SECRET_STATIC,
		messages: [{ role: "user", content: patch?.task ?? SECRET_TASK }],
		tools: [
			{
				name: patch?.toolName ?? "bash",
				input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
			},
		],
	};
}

describe("stable prefix observation diff", () => {
	it("reports none and leaks no payload secrets when consecutive final requests match", () => {
		const diff = diffStablePrefixObservations(finalObserve(basePayload()), finalObserve(basePayload()));
		expect(diff.unchanged).toBe(true);
		expect(diff.missReason).toBe("none");
		expect(diff.prefixPreserved).toBe(true);
		expect(diff.identityChanged).toBe(false);
		expect(diff.claimedLiveWin).toBe(false);
		expect(diff.changedKinds).toEqual([]);
		expect(diff.firstChangedKind).toBeNull();
		expect(diff.kinds.map(row => row.kind)).toEqual(["tools", "static_rules", "dynamic_context"]);
		for (const row of diff.kinds) {
			expect(row.status).toBe("unchanged");
			expect(row.byteDelta).toBe(0);
			expect(row.previousFingerprint).toBe(row.currentFingerprint);
			expect(row.previousFingerprint).toMatch(/^[a-f0-9]{64}$/);
		}
		expect(JSON.stringify(diff)).not.toContain("never-log-this");
		expect(JSON.stringify(diff)).not.toContain("also-hidden");

		const empty = diffStablePrefixObservations(
			{ segments: [], providerIdentity: {} },
			{ segments: [], providerIdentity: {} },
		);
		expect(empty.unchanged).toBe(true);
		expect(empty.missReason).toBe("none");
		expect(empty.prefixPreserved).toBe(true);
		expect(empty.kinds).toEqual([]);
	});

	it("attributes a tools change ahead of a provider identity change", () => {
		const previous = finalObserve(basePayload());
		const current = finalObserve(basePayload({ toolName: "read_file" }), {
			provider: "anthropic",
			model: "claude-opus-4-5",
		});
		const diff = diffStablePrefixObservations(previous, current);
		expect(diff.missReason).toBe("tool_schema_changed");
		expect(diff.firstChangedKind).toBe("tools");
		expect(diff.changedKinds).toEqual(["tools"]);
		expect(diff.prefixPreserved).toBe(false);
		expect(diff.unchanged).toBe(false);
		expect(diff.identityChanged).toBe(true);
		expect(diff.claimedLiveWin).toBe(false);
		const tools = diff.kinds.find(row => row.kind === "tools");
		expect(tools?.status).toBe("changed");
		expect(tools?.previousFingerprint).not.toBe(tools?.currentFingerprint);
		expect(tools?.byteDelta).not.toBe(0);
		expect(diff.kinds.find(row => row.kind === "static_rules")?.status).toBe("unchanged");
		expect(diff.kinds.find(row => row.kind === "dynamic_context")?.status).toBe("unchanged");
		expect(JSON.stringify(diff)).not.toContain("never-log-this");
		expect(JSON.stringify(diff)).not.toContain("also-hidden");
	});

	it("treats a static rules edit as a broken static prefix", () => {
		const diff = diffStablePrefixObservations(
			finalObserve(basePayload()),
			finalObserve(basePayload({ system: `${SECRET_STATIC}\nextra rule` })),
		);
		expect(diff.missReason).toBe("static_rules_changed");
		expect(diff.firstChangedKind).toBe("static_rules");
		expect(diff.changedKinds).toEqual(["static_rules"]);
		expect(diff.prefixPreserved).toBe(false);
		const rules = diff.kinds.find(row => row.kind === "static_rules");
		expect(rules?.status).toBe("changed");
		expect(rules?.byteDelta).toBeGreaterThan(0);
		expect(JSON.stringify(diff)).not.toContain("never-log-this");
		expect(JSON.stringify(diff)).not.toContain("extra rule");
	});

	it("keeps the static prefix when only dynamic context bytes change", () => {
		const previous = finalObserve(basePayload());
		const current = finalObserve(basePayload({ task: `${SECRET_TASK}\nnext` }));
		const diff = diffStablePrefixObservations(previous, current);
		expect(diff.missReason).toBe("dynamic_context_changed");
		expect(diff.firstChangedKind).toBe("dynamic_context");
		expect(diff.prefixPreserved).toBe(true);
		expect(diff.unchanged).toBe(false);
		const dynamic = diff.kinds.find(row => row.kind === "dynamic_context");
		expect(dynamic?.status).toBe("changed");
		expect(dynamic?.currentFingerprint).toBe(
			current.segments.find(segment => segment.kind === "dynamic_context")?.fingerprint,
		);
		expect(dynamic?.byteDelta).toBeGreaterThan(0);
		expect(JSON.stringify(diff)).not.toContain("also-hidden");
	});

	it("attributes provider identity when every segment matches", () => {
		const payload = basePayload();
		const diff = diffStablePrefixObservations(
			finalObserve(payload, { provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-4-5" }),
			finalObserve(payload, {
				provider: "anthropic",
				api: "anthropic-messages",
				model: "claude-sonnet-4-5",
				effortFingerprint: "effort-high",
			}),
		);
		expect(diff.missReason).toBe("provider_identity_changed");
		expect(diff.identityChanged).toBe(true);
		expect(diff.unchanged).toBe(false);
		expect(diff.prefixPreserved).toBe(true);
		expect(diff.changedKinds).toEqual([]);
		expect(diff.firstChangedKind).toBeNull();
		expect(JSON.stringify(diff)).not.toContain("effort-high");
		expect(JSON.stringify(diff)).not.toContain("claude-sonnet-4-5");
	});

	it("attributes reorder separately from a preserved static prefix", () => {
		const tools = fingerprintProviderSegment("tools", "tool-schema");
		const rules = fingerprintProviderSegment("static_rules", "rules-body");
		const dynamic = fingerprintProviderSegment("dynamic_context", "task-body");
		const assignment = fingerprintProviderSegment("assignment", "assign-body");
		const swapped = diffStablePrefixObservations(
			{ segments: [tools, rules, dynamic], providerIdentity: { provider: "anthropic" } },
			{ segments: [rules, tools, dynamic], providerIdentity: { provider: "anthropic" } },
		);
		expect(swapped.missReason).toBe("segment_order_changed");
		expect(swapped.changedKinds).toEqual([]);
		expect(swapped.firstChangedKind).toBeNull();
		expect(swapped.prefixPreserved).toBe(false);
		expect(swapped.unchanged).toBe(false);

		const tailSwap = diffStablePrefixObservations(
			{ segments: [rules, tools, dynamic, assignment], providerIdentity: {} },
			{ segments: [rules, tools, assignment, dynamic], providerIdentity: {} },
		);
		expect(tailSwap.missReason).toBe("segment_order_changed");
		expect(tailSwap.prefixPreserved).toBe(true);
		expect(tailSwap.kinds.every(row => row.status === "unchanged")).toBe(true);
	});

	it("reports removed and added kinds with signed byte deltas", () => {
		const rules = fingerprintProviderSegment("static_rules", "rules-body");
		const tools = fingerprintProviderSegment("tools", "tool-schema");
		const assignment = fingerprintProviderSegment("assignment", "assign-secret=hidden");
		const other = fingerprintProviderSegment("other", "other-secret=hidden");
		const diff = diffStablePrefixObservations(
			{ segments: [rules, tools, assignment], providerIdentity: {} },
			{ segments: [rules, tools, other], providerIdentity: {} },
		);
		expect(diff.missReason).toBe("assignment_changed");
		expect(diff.firstChangedKind).toBe("assignment");
		expect(diff.changedKinds).toEqual(["assignment", "other"]);
		expect(diff.prefixPreserved).toBe(true);
		const removed = diff.kinds.find(row => row.kind === "assignment");
		expect(removed?.status).toBe("removed");
		expect(removed?.currentFingerprint).toBeNull();
		expect(removed?.byteDelta).toBe(-assignment.byteLength);
		const added = diff.kinds.find(row => row.kind === "other");
		expect(added?.status).toBe("added");
		expect(added?.previousFingerprint).toBeNull();
		expect(added?.byteDelta).toBe(other.byteLength);
		expect(JSON.stringify(diff)).not.toContain("assign-secret");
		expect(JSON.stringify(diff)).not.toContain("other-secret");
	});

	it("aggregates repeated static rules and ignores a static segment after the dynamic cut", () => {
		const rulesA = fingerprintProviderSegment("static_rules", "rule-a");
		const rulesB = fingerprintProviderSegment("static_rules", "rule-b");
		const rulesC = fingerprintProviderSegment("static_rules", "rule-c-secret=hidden");
		const dynamic = fingerprintProviderSegment("dynamic_context", "task");
		const diff = diffStablePrefixObservations(
			{ segments: [rulesA, dynamic, rulesB], providerIdentity: {} },
			{ segments: [rulesA, dynamic, rulesC], providerIdentity: {} },
		);
		expect(diff.prefixPreserved).toBe(true);
		expect(diff.missReason).toBe("static_rules_changed");
		expect(diff.changedKinds).toEqual(["static_rules"]);
		const rules = diff.kinds.find(row => row.kind === "static_rules");
		expect(rules?.status).toBe("changed");
		expect(rules?.previousFingerprint).not.toBe(rulesA.fingerprint);
		expect(rules?.currentFingerprint).not.toBe(rulesA.fingerprint);
		expect(rules?.byteDelta).toBe(rulesC.byteLength - rulesB.byteLength);
		expect(JSON.stringify(diff)).not.toContain("rule-c-secret");

		const sameFingerprint = diffStablePrefixObservations(
			{ segments: [{ kind: "dynamic_context", fingerprint: "abc", byteLength: 10 }], providerIdentity: {} },
			{ segments: [{ kind: "dynamic_context", fingerprint: "abc", byteLength: 12 }], providerIdentity: {} },
		);
		expect(sameFingerprint.missReason).toBe("dynamic_context_changed");
		expect(sameFingerprint.kinds[0]?.status).toBe("changed");
		expect(sameFingerprint.kinds[0]?.byteDelta).toBe(2);
		expect(sameFingerprint.prefixPreserved).toBe(true);
	});
});
