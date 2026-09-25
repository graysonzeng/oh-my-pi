import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	applyProviderOnlyToolHistory,
	applyProviderOnlyToolHistoryDetailed,
	estimateProviderContextTokens,
	PROVIDER_ELISION_RECEIPT_KIND,
} from "../../src/model-optimization/provider-context-adapter";
import type { SessionContextStrategy } from "../../src/model-optimization/types";

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantWithToolCalls(...ids: string[]): AgentMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({
			type: "toolCall" as const,
			id,
			name: "read",
			arguments: { path: `${id}.ts` },
		})),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as AgentMessage;
}

function toolResult(id: string, text: string, opts?: { isError?: boolean; toolName?: string }): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: opts?.toolName ?? "read",
		content: [{ type: "text", text }],
		isError: opts?.isError ?? false,
		timestamp: Date.now(),
	} as AgentMessage;
}

const strategy: SessionContextStrategy = {
	targetUtilization: 0.5,
	eviction: {
		enabled: true,
		preserveUserTurns: true,
		evictPersisted: false,
		keepRecentN: 2,
	},
	toolHistory: { maxToolCalls: 2, summarizeOld: true },
};

describe("applyProviderOnlyToolHistory", () => {
	it("returns the same array reference when under target utilization", () => {
		const messages = [user("hello"), assistantWithToolCalls("c1"), toolResult("c1", "short")];
		const out = applyProviderOnlyToolHistory(messages, {
			contextWindow: 100_000,
			strategy,
		});
		expect(out).toBe(messages);
	});

	it("does not mutate input messages when eliding", () => {
		const huge = "x".repeat(8_000);
		const messages = [
			user("goal"),
			assistantWithToolCalls("old1", "old2", "old3", "keep1", "keep2"),
			toolResult("old1", `${huge}\n[raw output: artifact://11]`),
			toolResult("old2", `${huge}\n[raw output: artifact://12]`),
			toolResult("old3", `${huge}\n[raw output: artifact://13]`),
			toolResult("keep1", `${huge}\n[raw output: artifact://21]`),
			toolResult("keep2", `${huge}\n[raw output: artifact://22]`),
		];
		const snapshot = JSON.stringify(messages);
		const out = applyProviderOnlyToolHistory(messages, {
			contextWindow: 1_000,
			strategy,
		});
		expect(JSON.stringify(messages)).toBe(snapshot);
		expect(out).not.toBe(messages);
		const elided = out.filter(
			m =>
				m.role === "toolResult" &&
				Array.isArray(m.content) &&
				m.content.some(b => b.type === "text" && b.text.includes("elided for provider context")),
		);
		expect(elided.length).toBeGreaterThan(0);
		// newest maxToolCalls kept
		const last = out[out.length - 1];
		expect(last.role).toBe("toolResult");
		if (last.role === "toolResult") {
			const text = last.content.find(b => b.type === "text");
			expect(text && text.type === "text" ? text.text : "").toContain("artifact://22");
			expect(text && text.type === "text" ? text.text : "").not.toContain("elided for provider context");
		}
	});

	it("never elides error tool results or results without recovery URI", () => {
		const huge = "y".repeat(8_000);
		const messages = [
			user("goal"),
			assistantWithToolCalls("err", "norecover", "old", "keep1", "keep2"),
			toolResult("err", huge, { isError: true }),
			toolResult("norecover", huge),
			toolResult("old", `${huge}\n[raw output: artifact://9]`),
			toolResult("keep1", `${huge}\n[raw output: artifact://1]`),
			toolResult("keep2", `${huge}\n[raw output: artifact://2]`),
		];
		const out = applyProviderOnlyToolHistory(messages, {
			contextWindow: 1_000,
			strategy,
		});
		const byId = new Map(
			out
				.filter((m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult")
				.map(m => [m.toolCallId, m]),
		);
		const errText = byId.get("err")?.content.find(b => b.type === "text");
		expect(errText && errText.type === "text" ? errText.text : "").toBe(huge);
		const noRecover = byId.get("norecover")?.content.find(b => b.type === "text");
		expect(noRecover && noRecover.type === "text" ? noRecover.text : "").toBe(huge);
		const old = byId.get("old")?.content.find(b => b.type === "text");
		expect(old && old.type === "text" ? old.text : "").toContain("elided for provider context");
		expect(old && old.type === "text" ? old.text : "").toContain("artifact://9");
	});

	it("only elides tool results with a matching assistant toolCall id", () => {
		const huge = "z".repeat(8_000);
		const messages = [
			user("goal"),
			assistantWithToolCalls("paired", "keep1", "keep2"),
			toolResult("orphan", `${huge}\n[raw output: artifact://7]`),
			toolResult("paired", `${huge}\n[raw output: artifact://8]`),
			toolResult("keep1", `${huge}\n[raw output: artifact://1]`),
			toolResult("keep2", `${huge}\n[raw output: artifact://2]`),
		];
		const out = applyProviderOnlyToolHistory(messages, {
			contextWindow: 1_000,
			strategy,
		});
		const byId = new Map(
			out
				.filter((m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult")
				.map(m => [m.toolCallId, m]),
		);
		const orphan = byId.get("orphan")?.content.find(b => b.type === "text");
		expect(orphan && orphan.type === "text" ? orphan.text : "").toContain(huge);
		expect(orphan && orphan.type === "text" ? orphan.text : "").not.toContain("elided for provider context");
		const paired = byId.get("paired")?.content.find(b => b.type === "text");
		expect(paired && paired.type === "text" ? paired.text : "").toContain("elided for provider context");
	});

	it("preserves all user turns", () => {
		const huge = "z".repeat(8_000);
		const messages = [
			user("first"),
			assistantWithToolCalls("a", "b", "c", "d"),
			toolResult("a", `${huge}\n[raw output: artifact://1]`),
			user("second"),
			toolResult("b", `${huge}\n[raw output: artifact://2]`),
			toolResult("c", `${huge}\n[raw output: artifact://3]`),
			toolResult("d", `${huge}\n[raw output: artifact://4]`),
		];
		const out = applyProviderOnlyToolHistory(messages, {
			contextWindow: 1_000,
			strategy,
		});
		const users = out.filter(m => m.role === "user");
		expect(users).toHaveLength(2);
		expect(estimateProviderContextTokens(out)).toBeLessThan(estimateProviderContextTokens(messages));
	});

	it("is a no-op without strategy or invalid window", () => {
		const messages = [user("x"), assistantWithToolCalls("1"), toolResult("1", "a".repeat(10_000))];
		expect(applyProviderOnlyToolHistory(messages, { contextWindow: 100, strategy: undefined })).toBe(messages);
		expect(applyProviderOnlyToolHistory(messages, { contextWindow: 0, strategy })).toBe(messages);
	});

	it("returns versioned receipts and fingerprint from the detailed adapter", () => {
		const huge = "w".repeat(8_000);
		const messages = [
			user("goal"),
			assistantWithToolCalls("old1", "old2", "keep1", "keep2"),
			toolResult("old1", `${huge}\n[raw output: artifact://11]`, { toolName: "bash" }),
			toolResult("old2", `${huge}\n[raw output: artifact://12]`, { toolName: "read" }),
			toolResult("keep1", `${huge}\n[raw output: artifact://21]`),
			toolResult("keep2", `${huge}\n[raw output: artifact://22]`),
		];
		const detailed = applyProviderOnlyToolHistoryDetailed(messages, {
			contextWindow: 1_000,
			strategy,
		});
		expect(detailed.messages).not.toBe(messages);
		expect(detailed.fingerprint).toBeString();
		expect(detailed.receipts.length).toBeGreaterThan(0);
		for (const receipt of detailed.receipts) {
			expect(receipt.kind).toBe(PROVIDER_ELISION_RECEIPT_KIND);
			expect(receipt.schemaVersion).toBe(1);
			expect(receipt.recoveryUri.startsWith("artifact://")).toBe(true);
			expect(receipt.originalBytes).toBeGreaterThan(receipt.visibleBytes);
			expect(receipt.toolCallId.length).toBeGreaterThan(0);
			expect(receipt.tool.length).toBeGreaterThan(0);
		}
	});

	it("counts assistant text/thinking/toolCall content in token estimates", () => {
		const assistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello world" },
				{ type: "thinking", thinking: "private reasoning text" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AgentMessage;
		const tokens = estimateProviderContextTokens([assistant]);
		expect(tokens).toBeGreaterThan(0);
		// text + thinking alone should already contribute multiple tokens
		expect(tokens).toBeGreaterThanOrEqual(5);
	});
});
