import { describe, expect, it } from "bun:test";
import {
	type ContextSegment,
	estimateTokens,
	evictContext,
	markPersistedSegments,
} from "../../src/workflow/context-evictor";
import { applyContextStrategyEviction } from "../../src/workflow/tool-optimization";

function seg(
	partial: Pick<ContextSegment, "id" | "type" | "turnIndex" | "tokens"> & Partial<ContextSegment>,
): ContextSegment {
	return {
		persisted: false,
		content: partial.content ?? partial.id,
		...partial,
	};
}

describe("evictContext", () => {
	const strategy = {
		targetUtilization: 0.5,
		eviction: {
			enabled: true,
			preserveUserTurns: true,
			evictPersisted: true,
			keepRecentN: 2,
		},
	};

	it("returns segments unchanged when under target", () => {
		const segments = [seg({ id: "u0", type: "user", turnIndex: 0, tokens: 10 })];
		const out = evictContext({ segments, strategy, currentTokens: 10, maxTokens: 1000 });
		expect(out).toEqual(segments);
	});

	it("preserves user turns and recent turns while dropping persisted tools", () => {
		const segments = [
			seg({ id: "u0", type: "user", turnIndex: 0, tokens: 20, content: "do the thing" }),
			seg({ id: "t0", type: "tool", turnIndex: 1, tokens: 200, persisted: true, content: "write src/a.ts" }),
			seg({ id: "a0", type: "assistant", turnIndex: 1, tokens: 50, content: "wrote file" }),
			seg({ id: "t1", type: "tool", turnIndex: 2, tokens: 200, persisted: true, content: "bash exit code: 0" }),
			seg({ id: "u1", type: "user", turnIndex: 3, tokens: 20, content: "continue" }),
			seg({ id: "t2", type: "tool", turnIndex: 4, tokens: 80, persisted: false, content: "read plan" }),
			seg({ id: "a1", type: "assistant", turnIndex: 4, tokens: 40, content: "ok" }),
		];
		// max turn = 4, keepRecentN=2 → recentCutoff = 3
		const out = evictContext({
			segments,
			strategy,
			currentTokens: 610,
			maxTokens: 400, // target = 200
		});
		const ids = out.map(s => s.id);
		expect(ids).toContain("u0");
		expect(ids).toContain("u1");
		// persisted old tools dropped
		expect(ids).not.toContain("t0");
		expect(ids).not.toContain("t1");
		// recent turns kept
		expect(ids).toContain("t2");
		expect(ids).toContain("a1");
	});

	it("no-ops when eviction disabled", () => {
		const segments = [seg({ id: "t", type: "tool", turnIndex: 0, tokens: 999, persisted: true })];
		const out = evictContext({
			segments,
			strategy: { targetUtilization: 0.1, eviction: { ...strategy.eviction, enabled: false } },
			currentTokens: 999,
			maxTokens: 100,
		});
		expect(out).toEqual(segments);
	});
});

describe("applyContextStrategyEviction (production helper)", () => {
	it("evicts oversized multi-section context under pressure", () => {
		const strategy = {
			targetUtilization: 0.3,
			eviction: {
				enabled: true,
				preserveUserTurns: true,
				evictPersisted: true,
				keepRecentN: 1,
			},
		};
		const context = [
			"Lead-in assignment framing that should be kept as user-like segment.",
			`## Implementation\n${"write src/a.ts\n".repeat(200)}`,
			`## Verification\n${"tests passed\n".repeat(50)}`,
			"## Recent notes\nkeep me",
		].join("\n");
		const out = applyContextStrategyEviction(context, strategy, 2_000);
		expect(out).toBeDefined();
		expect(out!.length).toBeLessThan(context.length);
		// Lead-in preserved
		expect(out).toMatch(/Lead-in assignment/);
	});

	it("no-ops when eviction disabled", () => {
		const context = "hello world ".repeat(100);
		const out = applyContextStrategyEviction(
			context,
			{
				targetUtilization: 0.1,
				eviction: { enabled: false, preserveUserTurns: true, evictPersisted: true, keepRecentN: 1 },
			},
			100,
		);
		expect(out).toBe(context);
	});
});

describe("markPersistedSegments", () => {
	it("marks write/edit and successful bash as persisted", () => {
		const marked = markPersistedSegments([
			seg({ id: "1", type: "tool", turnIndex: 0, tokens: 1, content: "tool write path=a.ts" }),
			seg({ id: "2", type: "tool", turnIndex: 1, tokens: 1, content: "bash exit code: 0 done" }),
			seg({ id: "3", type: "tool", turnIndex: 2, tokens: 1, content: "read src/x.ts" }),
			seg({ id: "4", type: "user", turnIndex: 3, tokens: 1, content: "hello" }),
		]);
		expect(marked[0]?.persisted).toBe(true);
		expect(marked[1]?.persisted).toBe(true);
		expect(marked[2]?.persisted).toBe(false);
		expect(marked[3]?.persisted).toBe(false);
	});
});

describe("estimateTokens", () => {
	it("estimates from character length", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("a".repeat(40))).toBe(10);
	});
});
