import { describe, expect, it } from "bun:test";
import { resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgAdvisorAllowSameModel,
	cfgConsultAllowSameModel,
	cfgConsultMaxUsesPerSession,
	cfgConsultMaxUsesPerTurn,
} from "@oh-my-pi/pi-coding-agent/config/workflow-settings";
import {
	cfgCompaction,
	cfgCompactionThresholdPercent,
	cfgCompactionThresholdTokens,
	DEFAULT_COMPACTION_SOFT_CAP_PERCENT,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { rolePriorityDefaults } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

describe("production compaction soft-cap default", () => {
	it("keeps the 60% soft-cap contract (thresholdPercent=60, thresholdTokens=-1)", () => {
		const settings = Settings.isolated({});
		expect(DEFAULT_COMPACTION_SOFT_CAP_PERCENT).toBe(60);
		expect(cfgCompactionThresholdPercent.get(settings)).toBe(60);
		expect(cfgCompactionThresholdTokens.get(settings)).toBe(-1);
	});

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

describe("quality/cost plan advisor caps and smol defaults", () => {
	it("keeps advisor/consult same-model off and consult use caps", () => {
		const settings = Settings.isolated({});
		expect(cfgAdvisorAllowSameModel.get(settings)).toBe(false);
		expect(cfgConsultAllowSameModel.get(settings)).toBe(false);
		expect(cfgConsultMaxUsesPerTurn.get(settings)).toBe(2);
		expect(cfgConsultMaxUsesPerSession.get(settings)).toBe(12);
	});

	it("prefers deepseek-v4.1-flash at the head of the built-in smol chain", () => {
		const smol = rolePriorityDefaults("smol");
		expect(smol[0]).toBe("gateway/deepseek-v4.1-flash:high");
		expect(smol).toContain("gateway/deepseek-v4-flash:max");
	});
});
