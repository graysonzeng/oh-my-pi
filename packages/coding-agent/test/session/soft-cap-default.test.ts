import { describe, expect, it } from "bun:test";
import {
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	resolveUsableContextTokens,
} from "@oh-my-pi/pi-agent-core/compaction";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgCompaction,
	cfgCompactionExperiment,
	DEFAULT_COMPACTION_SOFT_CAP_PERCENT,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";

describe("production compaction soft-cap default", () => {
	it("defaults to 60% with thresholdTokens=-1 and experiment off", () => {
		const settings = Settings.isolated({});
		const compaction = cfgCompaction.get(settings);
		expect(DEFAULT_COMPACTION_SOFT_CAP_PERCENT).toBe(60);
		expect(compaction.thresholdPercent).toBe(DEFAULT_COMPACTION_SOFT_CAP_PERCENT);
		expect(compaction.thresholdTokens).toBe(-1);
		expect(cfgCompactionExperiment.get(settings).enabled).toBe(false);
	});

	it("effective production thresholds follow percent-of-window (60%)", () => {
		const compaction = cfgCompaction.get(Settings.isolated({}));
		const cases: Array<{ window: number; expected: number }> = [
			{ window: 128_000, expected: 76_800 },
			{ window: 200_000, expected: 120_000 },
			{ window: 256_000, expected: 153_600 },
			{ window: 1_000_000, expected: 600_000 },
		];
		for (const { window, expected } of cases) {
			expect(resolveThresholdTokens(window, compaction)).toBe(expected);
			// At 60%, percent stays below usable (~85%) under default reserve.
			expect(resolveThresholdTokens(window, compaction)).toBeLessThanOrEqual(
				resolveUsableContextTokens(window, compaction),
			);
		}
	});

	it("user token override still wins when within usable", () => {
		const compaction = cfgCompaction.get(Settings.isolated({ "compaction.thresholdTokens": 50_000 }));
		expect(resolveThresholdTokens(1_000_000, compaction)).toBe(50_000);
	});

	it("unset percent + tokens=-1 restores usable-window trigger", () => {
		const compaction = cfgCompaction.get(
			Settings.isolated({
				"compaction.thresholdPercent": -1,
				"compaction.thresholdTokens": -1,
			}),
		);
		expect(resolveThresholdTokens(1_000_000, compaction)).toBe(850_000);
		expect(resolveThresholdTokens(1_000_000, compaction)).toBe(
			1_000_000 - resolveBudgetReserveTokens(1_000_000, compaction),
		);
	});
});
