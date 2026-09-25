/**
 * P1-3: context strategy experiment surface — single-factor harness contracts.
 *
 * Failure modes under test:
 * - production defaults mutate when experiment is off
 * - multi-factor treatment silently applies (must fail closed to control)
 * - 200k tier forced onto windows that cannot host it (must baseline fallback)
 * - keep_recent treatment drops below preserve floor for recent edits
 * - control/treatment arm recording loses factor identity or invents live wins
 * - SessionMaintenance / UI boundaries bypass the overlay (arm contamination)
 */
import { describe, expect, it, spyOn } from "bun:test";
import type { CompactionSettings } from "../../src/session/context-settings";
import * as experimentModule from "../../src/session/context-strategy-experiment";
import {
	CONTEXT_STRATEGY_EXPERIMENT_KIND,
	CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
	CONTEXT_STRATEGY_EXPERIMENT_VERSION,
	CONTEXT_STRATEGY_PRESERVE_KEEP_RECENT_FLOOR,
	applyContextStrategyExperiment,
	assertSingleFactorDeclaration,
	buildContextStrategyExperimentRun,
	judgeContextStrategyExperiment,
	parseContextStrategyExperimentConfig,
	readContextStrategyExperimentConfig,
} from "../../src/session/context-strategy-experiment";
import { getSessionCompactionBoundaries } from "../../src/session/context-usage-runtime";
import { SessionMaintenance, type SessionMaintenanceHost } from "../../src/session/session-maintenance";
import { Settings } from "../../src/config/settings";

function baseSettings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
	return {
		enabled: true,
		experimentalContextManagement: false,
		methodOrder: ["structured", "remote", "snapcompact", "handoff", "shake", "soft"],
		thresholdPercent: -1,
		thresholdTokens: -1,
		reserveTokens: undefined,
		keepRecentTokens: 20_000,
		midTurnEnabled: true,
		asyncEnabled: true,
		handoffSaveToDisk: false,
		autoContinue: true,
		remoteEndpoint: undefined,
		remoteStreamingV2Enabled: true,
		v2RetainedMessageBudget: 64_000,
		idleEnabled: false,
		idleThresholdTokens: 200_000,
		idleTimeoutSeconds: 300,
		supersedeReads: true,
		dropUseless: true,
		...overrides,
	};
}

describe("context strategy experiment (P1-3)", () => {
	it("leaves production compaction settings untouched when the experiment is off", () => {
		const base = baseSettings();
		const resolved = applyContextStrategyExperiment({
			base,
			experiment: {
				enabled: false,
				factor: "threshold_tokens",
				thresholdTokens: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
			},
			contextWindow: 400_000,
		});
		expect(resolved.applied).toBe(false);
		expect(resolved.source).toBe("control");
		expect(resolved.settings).toEqual(base);
		expect(resolved.settings.thresholdTokens).toBe(-1);
		expect(resolved.receipt.kind).toBe(CONTEXT_STRATEGY_EXPERIMENT_KIND);
		expect(resolved.receipt.v).toBe(CONTEXT_STRATEGY_EXPERIMENT_VERSION);
	});

	it("applies only the declared threshold_tokens factor as an experiment tier, not a global cap", () => {
		const base = baseSettings({ keepRecentTokens: 20_000, reserveTokens: 16_384 });
		const resolved = applyContextStrategyExperiment({
			base,
			experiment: {
				enabled: true,
				factor: "threshold_tokens",
				thresholdTokens: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
			},
			contextWindow: 400_000,
		});
		expect(resolved.applied).toBe(true);
		expect(resolved.source).toBe("treatment");
		expect(resolved.factor).toBe("threshold_tokens");
		expect(resolved.settings.thresholdTokens).toBe(CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS);
		expect(resolved.settings.keepRecentTokens).toBe(20_000);
		expect(resolved.settings.reserveTokens).toBe(16_384);
		expect(resolved.effectiveThresholdTokens).toBe(CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS);
		expect(resolved.receipt.tierTokens).toBe(CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS);
		expect(resolved.receipt.globalFixedCap).toBe(false);
	});

	it("falls back to control when the 200k experiment tier cannot fit the usable window", () => {
		const base = baseSettings({ thresholdTokens: -1, thresholdPercent: 70 });
		const resolved = applyContextStrategyExperiment({
			base,
			experiment: {
				enabled: true,
				factor: "threshold_tokens",
				thresholdTokens: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
			},
			contextWindow: 128_000,
		});
		expect(resolved.applied).toBe(false);
		expect(resolved.source).toBe("baseline_threshold_fallback");
		expect(resolved.fallbackReason).toBe("tier_exceeds_usable_window");
		expect(resolved.settings).toEqual(base);
		expect(resolved.settings.thresholdTokens).toBe(-1);
	});

	it("rejects multi-factor declarations instead of bundling treatments", () => {
		expect(() =>
			assertSingleFactorDeclaration({
				factor: "threshold_tokens",
				thresholdTokens: 200_000,
				keepRecentTokens: 12_000,
			}),
		).toThrow(/single factor/i);

		const resolved = applyContextStrategyExperiment({
			base: baseSettings(),
			experiment: {
				enabled: true,
				factor: "threshold_tokens",
				thresholdTokens: 200_000,
				keepRecentTokens: 12_000,
			},
			contextWindow: 400_000,
		});
		expect(resolved.applied).toBe(false);
		expect(resolved.source).toBe("control");
		expect(resolved.fallbackReason).toBe("multi_factor_rejected");
	});

	it("applies keep_recent_tokens while enforcing the recent-edits preserve floor", () => {
		const base = baseSettings({ keepRecentTokens: 20_000 });
		const tooLow = applyContextStrategyExperiment({
			base,
			experiment: {
				enabled: true,
				factor: "keep_recent_tokens",
				keepRecentTokens: 100,
			},
			contextWindow: 400_000,
		});
		expect(tooLow.applied).toBe(false);
		expect(tooLow.source).toBe("control");
		expect(tooLow.fallbackReason).toBe("preserve_floor_violation");

		const ok = applyContextStrategyExperiment({
			base,
			experiment: {
				enabled: true,
				factor: "keep_recent_tokens",
				keepRecentTokens: CONTEXT_STRATEGY_PRESERVE_KEEP_RECENT_FLOOR,
			},
			contextWindow: 400_000,
		});
		expect(ok.applied).toBe(true);
		expect(ok.settings.keepRecentTokens).toBe(CONTEXT_STRATEGY_PRESERVE_KEEP_RECENT_FLOOR);
		expect(ok.settings.thresholdTokens).toBe(-1);
		expect(ok.receipt.preserve.recentEdits).toBe(true);
		expect(ok.receipt.preserve.openConstraints).toBe(true);
		expect(ok.receipt.preserve.acceptanceCriteria).toBe(true);
	});

	it("applies reserve_tokens as a single factor without touching threshold or keepRecent", () => {
		const base = baseSettings();
		const resolved = applyContextStrategyExperiment({
			base,
			experiment: {
				enabled: true,
				factor: "reserve_tokens",
				reserveTokens: 24_576,
			},
			contextWindow: 400_000,
		});
		expect(resolved.applied).toBe(true);
		expect(resolved.settings.reserveTokens).toBe(24_576);
		expect(resolved.settings.thresholdTokens).toBe(-1);
		expect(resolved.settings.keepRecentTokens).toBe(20_000);
	});

	it("reads experiment settings as off by default and parses only the declared factor", () => {
		const defaults = readContextStrategyExperimentConfig(Settings.isolated({}));
		expect(defaults).toEqual({
			enabled: false,
			factor: "none",
			thresholdTokens: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
			keepRecentTokens: undefined,
			reserveTokens: undefined,
		});

		const treatment = readContextStrategyExperimentConfig(
			Settings.isolated({
				"compaction.experiment.enabled": true,
				"compaction.experiment.factor": "threshold_tokens",
				"compaction.experiment.thresholdTokens": 200_000,
			}),
		);
		expect(treatment.enabled).toBe(true);
		expect(treatment.factor).toBe("threshold_tokens");
		expect(treatment.thresholdTokens).toBe(200_000);

		expect(parseContextStrategyExperimentConfig({ enabled: true, factor: "keep_recent_tokens" })).toEqual({
			enabled: true,
			factor: "keep_recent_tokens",
			thresholdTokens: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
			keepRecentTokens: undefined,
			reserveTokens: undefined,
		});
		expect(parseContextStrategyExperimentConfig({ enabled: true, factor: "threshold_tokens", keepRecentTokens: 1 })).toBeNull();
	});

	it("records paired runs and judges on task time, constraint retention, and recovery — without inventing wins", () => {
		const control = buildContextStrategyExperimentRun({
			arm: "control",
			factor: "threshold_tokens",
			tierTokens: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
			metrics: {
				totalTaskTimeMs: 120_000,
				constraintRetention: "retained",
				recoveryQuality: "recovered",
			},
		});
		const treatment = buildContextStrategyExperimentRun({
			arm: "treatment",
			factor: "threshold_tokens",
			tierTokens: CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
			metrics: {
				totalTaskTimeMs: 90_000,
				constraintRetention: "retained",
				recoveryQuality: "recovered",
			},
		});
		expect(control.kind).toBe("context_strategy_experiment_run");
		expect(control.claimedLiveWin).toBe(false);
		expect(treatment.metrics.totalTaskTimeMs).toBe(90_000);

		const verdict = judgeContextStrategyExperiment({ control, treatment });
		expect(verdict.status).toBe("comparable");
		expect(verdict.taskTimeImproved).toBe(true);
		expect(verdict.constraintsRetained).toBe(true);
		expect(verdict.recoveryOk).toBe(true);
		expect(verdict.claimedLiveWin).toBe(false);
		expect(verdict.notes.some(note => note.includes("mechanism-only"))).toBe(true);

		const incomplete = judgeContextStrategyExperiment({
			control,
			treatment: buildContextStrategyExperimentRun({
				arm: "treatment",
				factor: "threshold_tokens",
				metrics: { totalTaskTimeMs: null, constraintRetention: "unknown", recoveryQuality: "unknown" },
			}),
		});
		expect(incomplete.status).toBe("incomplete_metrics");
		expect(incomplete.claimedLiveWin).toBe(false);
	});

	it("applies the experiment overlay on session UI boundaries and SessionMaintenance settings resolution", () => {
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.experiment.enabled": true,
			"compaction.experiment.factor": "threshold_tokens",
			"compaction.experiment.thresholdTokens": CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
		});

		const boundaries = getSessionCompactionBoundaries(settings, 400_000);
		expect(boundaries).toEqual({
			thresholdPercent: 50,
			speculationPercent: null,
		});

		const unfit = getSessionCompactionBoundaries(
			Settings.isolated({
				"compaction.enabled": true,
				"compaction.experiment.enabled": true,
				"compaction.experiment.factor": "threshold_tokens",
				"compaction.experiment.thresholdTokens": CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS,
			}),
			128_000,
		);
		// Fail-closed to control reserve path — not forced past the usable window as a 200k cap.
		expect(unfit).not.toBeNull();
		expect(typeof unfit!.thresholdPercent).toBe("number");
		expect(unfit!.thresholdPercent).toBeLessThan(100);
		expect(unfit!.thresholdPercent).not.toBe((CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS / 128_000) * 100);

		const spy = spyOn(experimentModule, "resolveSessionCompactionSettings");
		const host = {
			settings,
			model: () => ({ contextWindow: 400_000 }) as never,
			isDisposed: () => false,
			isGeneratingHandoff: () => false,
			hasExperimentalContextRolloverTools: () => false,
			extensionRunner: undefined,
		} as unknown as SessionMaintenanceHost;
		const maintenance = new SessionMaintenance(host);
		maintenance.maybeStartSpeculativeCompaction(100_000, 400_000);
		expect(spy).toHaveBeenCalled();
		const call = spy.mock.calls.find(args => args[0]?.contextWindow === 400_000);
		expect(call?.[0]?.settings).toBe(settings);
		const resolved = experimentModule.resolveSessionCompactionSettings({
			settings,
			contextWindow: 400_000,
		});
		expect(resolved.applied).toBe(true);
		expect(resolved.settings.thresholdTokens).toBe(CONTEXT_STRATEGY_EXPERIMENT_TIER_TOKENS);
		spy.mockRestore();
	});
});
