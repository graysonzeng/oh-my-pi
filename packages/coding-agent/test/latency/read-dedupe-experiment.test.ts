/**
 * Package 4 Experiment A — read dedupe / full recovery.
 *
 * Failure modes: defaults flip on; recovery round-trips increase; output caps
 * or don’t-re-read prompts get smuggled in; reuse across version mismatch.
 */
import { describe, expect, test } from "bun:test";
import {
	buildReadDedupeExperimentRun,
	countTruncationRecoveryToolCalls,
	decideReadViewReuse,
	defaultReadDedupeExperimentConfig,
	resolveReadDedupeExperiment,
	truncationRecoveryNotIncreased,
} from "../../src/latency/read-dedupe-experiment";
import { buildReadViewKeyV1 } from "../../src/latency/read-view-key";
import {
	cfgReadDedupeExperimentEnabled,
	cfgReadDedupeExperimentFactor,
} from "../../src/session/context-settings";

function eligibleKey(source: string, rev: string) {
	return buildReadViewKeyV1({
		canonicalSource: source,
		normalizedSelector: "full",
		branchOrWorktreeScope: "repo@main",
		providerViewIdentity: "etag:1",
		contentOrRevisionIdentity: rev,
		outputMode: "raw",
	});
}

describe("read dedupe experiment defaults", () => {
	test("settings default off with factor none", () => {
		expect(cfgReadDedupeExperimentEnabled.default).toBe(false);
		expect(cfgReadDedupeExperimentFactor.default).toBe("none");
	});

	test("default config resolves to control without applying", () => {
		const { applied, receipt } = resolveReadDedupeExperiment(defaultReadDedupeExperimentConfig());
		expect(applied).toBe(false);
		expect(receipt.globalOutputCapsLowered).toBe(false);
		expect(receipt.forcedNoRereadPrompt).toBe(false);
		expect(receipt.fallbackReason).toBe("disabled");
	});
});

describe("same version+view reuse", () => {
	test("control never reuses via this experiment", () => {
		const key = eligibleKey("/a.ts", "sha:1");
		const decision = decideReadViewReuse({
			config: { enabled: false, factor: "none" },
			current: key,
			prior: key,
		});
		expect(decision.reuse).toBe(false);
		expect(decision.reason).toBe("control_no_reuse");
	});

	test("treatment reuses only identical eligible keys", () => {
		const config = { enabled: true, factor: "same_version_view_reuse" as const };
		const a = eligibleKey("/a.ts", "sha:1");
		const same = eligibleKey("/a.ts", "sha:1");
		const otherRev = eligibleKey("/a.ts", "sha:2");
		expect(decideReadViewReuse({ config, current: a, prior: same })).toEqual({
			reuse: true,
			reason: "experiment_same_version_view",
		});
		expect(decideReadViewReuse({ config, current: a, prior: otherRev }).reuse).toBe(false);
	});

	test("ineligible keys fail open (no reuse)", () => {
		const config = { enabled: true, factor: "same_version_view_reuse" as const };
		const bad = buildReadViewKeyV1({
			canonicalSource: "",
			normalizedSelector: "full",
			branchOrWorktreeScope: "",
			providerViewIdentity: "",
			contentOrRevisionIdentity: "",
			outputMode: "unknown",
		});
		expect(decideReadViewReuse({ config, current: bad, prior: bad }).reason).toBe("ineligible_key");
	});
});

describe("truncation recovery", () => {
	test("counts recovery tool calls and fixture guard rejects increases", () => {
		const control = countTruncationRecoveryToolCalls([
			{ tool: "read", recoveredTruncation: true },
			{ tool: "read", recoveredTruncation: false },
		]);
		const treatmentOk = countTruncationRecoveryToolCalls([{ tool: "read", recoveredTruncation: true }]);
		const treatmentWorse = countTruncationRecoveryToolCalls([
			{ tool: "read", recoveredTruncation: true },
			{ tool: "read", recoveredTruncation: true },
		]);
		expect(control).toBe(1);
		expect(truncationRecoveryNotIncreased({
			controlRecoveryCalls: control,
			treatmentRecoveryCalls: treatmentOk,
		})).toBe(true);
		expect(truncationRecoveryNotIncreased({
			controlRecoveryCalls: control,
			treatmentRecoveryCalls: treatmentWorse,
		})).toBe(false);
		expect(truncationRecoveryNotIncreased({
			controlRecoveryCalls: null,
			treatmentRecoveryCalls: 0,
		})).toBeNull();
	});

	test("run receipt never claims a live win", () => {
		const run = buildReadDedupeExperimentRun({
			arm: "treatment",
			config: { enabled: true, factor: "same_version_view_reuse" },
			metrics: {
				truncationRecoveryToolCalls: 1,
				duplicateTransfersAvoided: 2,
				firstReturnSufficient: true,
			},
		});
		expect(run.claimedLiveWin).toBe(false);
	});

	test("rejects A/B entanglement when peer Experiment B is enabled", () => {
		const { applied, receipt } = resolveReadDedupeExperiment(
			{ enabled: true, factor: "same_version_view_reuse" },
			{ stablePrefixCacheEnabled: true },
		);
		expect(applied).toBe(false);
		expect(receipt.fallbackReason).toBe("multi_factor_rejected");
		const key = eligibleKey("/a.ts", "sha:1");
		const decision = decideReadViewReuse({
			config: { enabled: true, factor: "same_version_view_reuse" },
			current: key,
			prior: key,
			peerStablePrefixCacheEnabled: true,
		});
		expect(decision.reuse).toBe(false);
		expect(decision.reason).toBe("multi_factor_rejected");
	});
});
