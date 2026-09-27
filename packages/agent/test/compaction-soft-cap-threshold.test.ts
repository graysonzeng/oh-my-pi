import { describe, expect, it } from "bun:test";
import type { CompactionSettings } from "@oh-my-pi/pi-agent-core/compaction/compaction";
import {
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	resolveUsableContextTokens,
	shouldCompact,
} from "@oh-my-pi/pi-agent-core/compaction/compaction";

/** Production soft-cap ceiling under test (coding-agent default). */
const SOFT_CAP = 200_000;

function settings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
	return {
		enabled: true,
		thresholdPercent: -1,
		thresholdTokens: SOFT_CAP,
		keepRecentTokens: 20_000,
		...overrides,
	};
}

describe("resolveThresholdTokens soft-cap / usable-window clamp", () => {
	it("uses the 200K soft-cap on large windows (min with usable)", () => {
		const s = settings();
		const window = 1_000_000;
		const usable = resolveUsableContextTokens(window, s);
		expect(usable).toBe(850_000); // 1M − 15%
		expect(resolveThresholdTokens(window, s)).toBe(SOFT_CAP);
		expect(shouldCompact(SOFT_CAP, window, s)).toBe(false);
		expect(shouldCompact(SOFT_CAP + 1, window, s)).toBe(true);
	});

	it("on a mid-size window, soft-cap wins when usable is larger", () => {
		const s = settings();
		const window = 256_000;
		const usable = resolveUsableContextTokens(window, s);
		expect(usable).toBe(217_600); // 256k − 15%
		expect(resolveThresholdTokens(window, s)).toBe(SOFT_CAP);
	});

	it("on smaller windows, clamps to usable (= window − reserve), not window−1", () => {
		const s = settings();
		for (const window of [128_000, 200_000] as const) {
			const reserve = resolveBudgetReserveTokens(window, s);
			const usable = window - reserve;
			expect(resolveUsableContextTokens(window, s)).toBe(usable);
			expect(resolveThresholdTokens(window, s)).toBe(usable);
			// Audited bug: previously fixed tokens clamped to window−1 and missed reserve.
			expect(resolveThresholdTokens(window, s)).toBeLessThan(window - 1);
			expect(resolveThresholdTokens(window, s)).toBe(window - reserve);
		}
	});

	it("honors an explicit user override below the soft-cap", () => {
		const s = settings({ thresholdTokens: 40_000 });
		expect(resolveThresholdTokens(1_000_000, s)).toBe(40_000);
		expect(resolveThresholdTokens(128_000, s)).toBe(40_000);
	});

	it("clamps an explicit oversized override to usable, not window−1", () => {
		const s = settings({ thresholdTokens: 500_000 });
		const window = 128_000;
		const usable = resolveUsableContextTokens(window, s);
		expect(resolveThresholdTokens(window, s)).toBe(usable);
		expect(resolveThresholdTokens(window, s)).not.toBe(window - 1);
	});

	it("legacy unset tokens still resolve to usable window", () => {
		const s = settings({ thresholdTokens: -1, thresholdPercent: -1 });
		const window = 1_000_000;
		expect(resolveThresholdTokens(window, s)).toBe(850_000);
	});

	it("temporary soft overrun: context above soft-cap triggers compaction while hard overflow remains separate", () => {
		// Soft-cap path: once past the threshold, shouldCompact is true so the
		// next safe maintenance point can shrink working context. Hard capacity
		// (window/overflow) is a different gate — soft must not raise the usable
		// ceiling past reserve.
		const s = settings();
		const window = 1_000_000;
		const threshold = resolveThresholdTokens(window, s);
		expect(threshold).toBe(SOFT_CAP);
		expect(shouldCompact(SOFT_CAP + 50_000, window, s)).toBe(true);
		const usable = resolveUsableContextTokens(window, s);
		expect(threshold).toBeLessThanOrEqual(usable);
	});
});
