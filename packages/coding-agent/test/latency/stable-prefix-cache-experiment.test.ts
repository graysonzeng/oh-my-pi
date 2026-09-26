/**
 * Package 4 Experiment B — stable-prefix / cache (separate from read dedupe).
 *
 * Failure modes: production assembly mutates when off; permissions/tools flip;
 * inspect and reorder attributed as one win; paid traffic auto-started.
 */
import { describe, expect, test } from "bun:test";
import {
	buildStablePrefixCacheExperimentRun,
	defaultStablePrefixCacheExperimentConfig,
	fingerprintProviderSegment,
	inspectProviderRequestPrefix,
	planStablePrefixOrder,
	resolveStablePrefixCacheExperiment,
} from "../../src/latency/stable-prefix-cache-experiment";
import {
	cfgStablePrefixCacheExperimentEnabled,
	cfgStablePrefixCacheExperimentFactor,
} from "../../src/session/context-settings";

describe("stable-prefix cache experiment defaults", () => {
	test("settings default off", () => {
		expect(cfgStablePrefixCacheExperimentEnabled.default).toBe(false);
		expect(cfgStablePrefixCacheExperimentFactor.default).toBe("none");
	});

	test("disabled resolve does not apply and leaves safety flags false", () => {
		const { applied, receipt } = resolveStablePrefixCacheExperiment(
			defaultStablePrefixCacheExperimentConfig(),
		);
		expect(applied).toBe(false);
		expect(receipt.permissionsChanged).toBe(false);
		expect(receipt.instructionPriorityChanged).toBe(false);
		expect(receipt.toolsChanged).toBe(false);
	});
});

describe("provider prefix inspection", () => {
	test("detects static rules cut by dynamic content", () => {
		const segments = [
			fingerprintProviderSegment("dynamic_context", "paths=/tmp/x"),
			fingerprintProviderSegment("static_rules", "always follow safety"),
			fingerprintProviderSegment("tools", "tooldefs"),
		];
		const inspection = inspectProviderRequestPrefix(segments);
		expect(inspection.staticCutByDynamic).toBe(true);
		expect(inspection.firstDynamicIndex).toBe(0);
		expect(inspection.firstStaticIndex).toBe(1);
	});

	test("stable-first order is not cut", () => {
		const segments = [
			fingerprintProviderSegment("static_rules", "rules"),
			fingerprintProviderSegment("tools", "tools"),
			fingerprintProviderSegment("dynamic_context", "task"),
		];
		expect(inspectProviderRequestPrefix(segments).staticCutByDynamic).toBe(false);
	});
});

describe("reorder opt-in", () => {
	test("control leaves segment order unchanged", () => {
		const segments = [
			fingerprintProviderSegment("dynamic_context", "dyn"),
			fingerprintProviderSegment("static_rules", "rules"),
			fingerprintProviderSegment("tools", "tools"),
		];
		const planned = planStablePrefixOrder(segments, { enabled: false, factor: "none" });
		expect(planned.map(s => s.kind)).toEqual(["dynamic_context", "static_rules", "tools"]);
	});

	test("inspect_provider_prefix does not reorder", () => {
		const segments = [
			fingerprintProviderSegment("dynamic_context", "dyn"),
			fingerprintProviderSegment("static_rules", "rules"),
		];
		const planned = planStablePrefixOrder(segments, {
			enabled: true,
			factor: "inspect_provider_prefix",
		});
		expect(planned.map(s => s.kind)).toEqual(["dynamic_context", "static_rules"]);
	});

	test("reorder_static_prefix moves static before dynamic without claiming live win", () => {
		const segments = [
			fingerprintProviderSegment("assignment", "do X"),
			fingerprintProviderSegment("dynamic_context", "paths"),
			fingerprintProviderSegment("static_rules", "rules"),
			fingerprintProviderSegment("tools", "tools"),
		];
		const planned = planStablePrefixOrder(segments, {
			enabled: true,
			factor: "reorder_static_prefix",
		});
		expect(planned.map(s => s.kind)).toEqual([
			"static_rules",
			"tools",
			"assignment",
			"dynamic_context",
		]);
		const { receipt } = resolveStablePrefixCacheExperiment({
			enabled: true,
			factor: "reorder_static_prefix",
		});
		expect(receipt.permissionsChanged).toBe(false);
		expect(receipt.toolsChanged).toBe(false);
		const run = buildStablePrefixCacheExperimentRun({
			arm: "treatment",
			config: { enabled: true, factor: "reorder_static_prefix" },
			metrics: {
				cacheRead: 100,
				ttftMs: 40,
				costTotal: 0.01,
				scope: "same_child_session",
				staticCutByDynamic: false,
			},
		});
		expect(run.claimedLiveWin).toBe(false);
		expect(run.metrics.cacheRead).toBe(100);
	});

	test("rejects A/B entanglement when peer Experiment A is enabled", () => {
		const { applied, receipt } = resolveStablePrefixCacheExperiment(
			{ enabled: true, factor: "reorder_static_prefix" },
			{ readDedupeEnabled: true },
		);
		expect(applied).toBe(false);
		expect(receipt.fallbackReason).toBe("multi_factor_rejected");
		const segments = [
			fingerprintProviderSegment("assignment", "do x"),
			fingerprintProviderSegment("static_rules", "rules"),
		];
		const planned = planStablePrefixOrder(
			segments,
			{ enabled: true, factor: "reorder_static_prefix" },
			{ readDedupeEnabled: true },
		);
		// Fail closed → control order unchanged.
		expect(planned.map(s => s.kind)).toEqual(["assignment", "static_rules"]);
	});
});
