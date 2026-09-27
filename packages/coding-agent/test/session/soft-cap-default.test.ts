import { describe, expect, it } from "bun:test";
import { resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";

describe("production compaction soft-cap default", () => {
	it("uses the production percent on a large window and the reserve boundary on a small window", () => {
		const compaction = cfgCompaction.get(Settings.isolated({}));
		expect(resolveThresholdTokens(1_000_000, compaction)).toBe(600_000);
		expect(resolveThresholdTokens(24_000, compaction)).toBe(7_616);
		expect(shouldCompact(7_617, 24_000, compaction)).toBe(true);
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
	});
});
