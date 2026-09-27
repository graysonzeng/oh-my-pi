import { describe, expect, it } from "bun:test";
import { recommendContextAction, formatContextDecisionHint } from "../../src/slash-commands/helpers/context-decision";

describe("context decision projection (D3)", () => {
	it("recommends compact when context is near full with unfinished work", () => {
		const hint = recommendContextAction({
			contextWindow: 100_000,
			usedTokens: 90_000,
			hasUnfinishedWork: true,
		});
		expect(hint.action).toBe("compact");
		expect(formatContextDecisionHint(hint)).toContain("impact_if_taken");
		expect(formatContextDecisionHint(hint)).toContain("impact_if_ignored");
	});

	it("recommends branch_or_rewind when goal paused for no-progress", () => {
		const hint = recommendContextAction({
			contextWindow: 100_000,
			usedTokens: 10_000,
			goalPausedNoProgress: true,
		});
		expect(hint.action).toBe("branch_or_rewind");
		expect(hint.reason).toContain("no-progress");
	});

	it("defaults to continue when no stronger signal exists", () => {
		expect(
			recommendContextAction({
				contextWindow: 100_000,
				usedTokens: 10_000,
				goalActive: true,
			}).action,
		).toBe("continue");
	});
});
