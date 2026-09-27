import { describe, expect, it } from "bun:test";
import type { CompactionSettings } from "@oh-my-pi/pi-agent-core/compaction/compaction";
import {
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	resolveUsableContextTokens,
	shouldCompact,
} from "@oh-my-pi/pi-agent-core/compaction/compaction";

/** Production soft-cap: percent of window with no fixed token default. */
const SOFT_CAP_PERCENT = 60;

function settings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
	return {
		enabled: true,
		thresholdPercent: SOFT_CAP_PERCENT,
		thresholdTokens: -1,
		keepRecentTokens: 20_000,
		...overrides,
	};
}

describe("resolveThresholdTokens soft-cap / usable-window clamp", () => {
	it("uses 60% of window on large contexts when tokens are unset", () => {
		const s = settings();
		const window = 1_000_000;
		const usable = resolveUsableContextTokens(window, s);
		expect(usable).toBe(850_000); // 1M − 15%
		expect(resolveThresholdTokens(window, s)).toBe(600_000);
		expect(shouldCompact(600_000, window, s)).toBe(false);
		expect(shouldCompact(600_000 + 1, window, s)).toBe(true);
	});

	it("scales the percent soft-cap on mid-size windows", () => {
		const s = settings();
		const window = 256_000;
		const usable = resolveUsableContextTokens(window, s);
		expect(usable).toBe(217_600); // 256k − 15%
		expect(resolveThresholdTokens(window, s)).toBe(153_600);
		expect(resolveThresholdTokens(window, s)).toBeLessThanOrEqual(usable);
	});

	it("fixed-token path clamps to usable (= window − reserve), not window−1", () => {
		// Clamp correctness from #40: explicit fixed tokens must not bypass reserve.
		const s = settings({ thresholdTokens: 200_000, thresholdPercent: -1 });
		for (const window of [128_000, 200_000] as const) {
			const reserve = resolveBudgetReserveTokens(window, s);
			const usable = window - reserve;
			expect(resolveUsableContextTokens(window, s)).toBe(usable);
			expect(resolveThresholdTokens(window, s)).toBe(usable);
			expect(resolveThresholdTokens(window, s)).toBeLessThan(window - 1);
			expect(resolveThresholdTokens(window, s)).toBe(window - reserve);
		}
	});

	it("honors an explicit user token override below the percent soft-cap", () => {
		const s = settings({ thresholdTokens: 40_000 });
		expect(resolveThresholdTokens(1_000_000, s)).toBe(40_000);
		expect(resolveThresholdTokens(128_000, s)).toBe(40_000);
	});

	it("clamps an explicit oversized token override to usable, not window−1", () => {
		const s = settings({ thresholdTokens: 500_000 });
		const window = 128_000;
		const usable = resolveUsableContextTokens(window, s);
		expect(resolveThresholdTokens(window, s)).toBe(usable);
		expect(resolveThresholdTokens(window, s)).not.toBe(window - 1);
	});

	it("legacy unset percent + tokens still resolve to usable window", () => {
		const s = settings({ thresholdTokens: -1, thresholdPercent: -1 });
		const window = 1_000_000;
		expect(resolveThresholdTokens(window, s)).toBe(850_000);
	});

	it("temporary soft overrun: context above percent soft-cap triggers compaction while hard overflow remains separate", () => {
		const s = settings();
		const window = 1_000_000;
		const threshold = resolveThresholdTokens(window, s);
		expect(threshold).toBe(600_000);
		expect(shouldCompact(600_000 + 50_000, window, s)).toBe(true);
		const usable = resolveUsableContextTokens(window, s);
		expect(threshold).toBeLessThanOrEqual(usable);
	});
});
