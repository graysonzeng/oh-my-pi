import { describe, expect, it } from "bun:test";
import {
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	resolveUsableContextTokens,
} from "@oh-my-pi/pi-agent-core/compaction";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompaction, DEFAULT_COMPACTION_SOFT_CAP_TOKENS } from "@oh-my-pi/pi-coding-agent/session/context-settings";

describe("production compaction soft-cap default", () => {
	it("defaults thresholdTokens to 200K soft-cap without enabling the experiment", () => {
		const settings = Settings.isolated({});
		const compaction = cfgCompaction.get(settings);
		expect(DEFAULT_COMPACTION_SOFT_CAP_TOKENS).toBe(200_000);
		expect(compaction.thresholdTokens).toBe(DEFAULT_COMPACTION_SOFT_CAP_TOKENS);
		expect(compaction.thresholdPercent).toBe(-1);
	});

	it("effective production thresholds follow min(200K, usable)", () => {
		const compaction = cfgCompaction.get(Settings.isolated({}));
		const cases: Array<{ window: number; expected: number }> = [
			{ window: 128_000, expected: 128_000 - resolveBudgetReserveTokens(128_000, compaction) },
			{ window: 200_000, expected: 200_000 - resolveBudgetReserveTokens(200_000, compaction) },
			{ window: 256_000, expected: 200_000 },
			{ window: 1_000_000, expected: 200_000 },
		];
		for (const { window, expected } of cases) {
			expect(resolveThresholdTokens(window, compaction)).toBe(expected);
			expect(resolveThresholdTokens(window, compaction)).toBeLessThanOrEqual(
				resolveUsableContextTokens(window, compaction),
			);
		}
	});

	it("user override still wins when within usable", () => {
		const compaction = cfgCompaction.get(Settings.isolated({ "compaction.thresholdTokens": 50_000 }));
		expect(resolveThresholdTokens(1_000_000, compaction)).toBe(50_000);
	});

	it("legacy opt-out via thresholdTokens=-1 restores usable-window trigger", () => {
		const compaction = cfgCompaction.get(Settings.isolated({ "compaction.thresholdTokens": -1 }));
		expect(resolveThresholdTokens(1_000_000, compaction)).toBe(850_000);
	});
});
