import { describe, expect, it } from "bun:test";
import {
	EXPLORE_MAX_RUNTIME_MS,
	REVIEW_GATE_MAX_RUNTIME_MS,
	readPathFromToolArgs,
	resolveClassMaxRuntimeMs,
	resolveClassSoftRuntimeMs,
	resolveSubagentPerformanceClass,
	shouldPreserveExplicitReadRange,
} from "@oh-my-pi/pi-coding-agent/task";

describe("subagent performance class", () => {
	it("classifies the frozen name/frontmatter/spawn matrix", () => {
		expect(
			resolveSubagentPerformanceClass({
				agentName: "reviewer",
				agentShadowReview: "code",
				spawnShadowReview: "off",
			}),
		).toBe("review");
		expect(
			resolveSubagentPerformanceClass({
				agentName: "subagent-sol",
				spawnShadowReview: "off",
			}),
		).toBe("review");
		expect(
			resolveSubagentPerformanceClass({
				agentName: "custom-reviewer",
				agentShadowReview: "code",
				spawnShadowReview: "off",
			}),
		).toBe("review");
		expect(
			resolveSubagentPerformanceClass({
				agentName: "custom-reviewer",
				agentShadowReview: "code",
			}),
		).toBe("review");
		expect(resolveSubagentPerformanceClass({ agentName: "custom-reviewer", spawnShadowReview: "code" })).toBe(
			"review",
		);
		expect(resolveSubagentPerformanceClass({ agentName: "task" })).toBe("worker");
		expect(resolveSubagentPerformanceClass({ agentName: "subagent-grok", spawnShadowReview: "off" })).toBe("worker");
		expect(resolveSubagentPerformanceClass({ agentName: "subagent-grok", spawnShadowReview: "code" })).toBe("review");
		expect(
			resolveSubagentPerformanceClass({
				agentName: "scout",
				agentShadowReview: "code",
				spawnShadowReview: "code",
			}),
		).toBe("explore");
		expect(
			resolveSubagentPerformanceClass({
				agentName: "sonic",
				agentShadowReview: "code",
				spawnShadowReview: "off",
			}),
		).toBe("explore");
		expect(resolveSubagentPerformanceClass({ agentName: "scout" })).toBe("explore");
	});

	it("exposes class wall-clock ceilings", () => {
		expect(resolveClassMaxRuntimeMs("review")).toBe(REVIEW_GATE_MAX_RUNTIME_MS);
		expect(resolveClassMaxRuntimeMs("explore")).toBe(EXPLORE_MAX_RUNTIME_MS);
		expect(resolveClassMaxRuntimeMs("worker")).toBe(Number.POSITIVE_INFINITY);
	});

	it("schedules review and explore wrap-up before the hard wall-clock abort", () => {
		expect(resolveClassSoftRuntimeMs("review", 1_800_000)).toBe(1_350_000);
		expect(resolveClassSoftRuntimeMs("explore", 600_000)).toBe(450_000);
		expect(resolveClassSoftRuntimeMs("worker", 1_800_000)).toBe(0);
		expect(resolveClassSoftRuntimeMs("review", 0)).toBe(0);
		expect(resolveClassSoftRuntimeMs("review", 1)).toBe(0);
	});

	it("treats both path and file_path as explicit raw/range selectors", () => {
		expect(shouldPreserveExplicitReadRange("src/x.ts:raw")).toBe(true);
		expect(shouldPreserveExplicitReadRange("src/x.ts:10-20")).toBe(true);
		expect(shouldPreserveExplicitReadRange("src/x.ts")).toBe(false);
		expect(shouldPreserveExplicitReadRange(readPathFromToolArgs({ file_path: "src/x.ts:raw" }))).toBe(true);
		expect(shouldPreserveExplicitReadRange(readPathFromToolArgs({ path: "src/x.ts" }))).toBe(false);
	});
});
