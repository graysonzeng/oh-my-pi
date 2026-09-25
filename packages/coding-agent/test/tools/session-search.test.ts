import { describe, expect, it } from "bun:test";
import { emptyLatencyArms, freezeLatencyArmSnapshot } from "../../src/latency/arms";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { collectSessionSearchHits, SessionSearchTool } from "../../src/tools/session-search";

function toolSession(
	manager: SessionManager | undefined,
	enabled: boolean,
	hooks: { recordDshGetBranchError?: () => void } = {},
): ToolSession {
	const snapshot = freezeLatencyArmSnapshot({
		arms: { ...emptyLatencyArms(), dsh_session_search: enabled },
	});
	return {
		cwd: process.cwd(),
		settings: { get: () => false } as unknown as ToolSession["settings"],
		getSessionFile: () => null,
		sessionManager: manager,
		getLatencyArmSnapshot: () => snapshot,
		markLatencyArmFired: () => {},
		recordDshGetBranchError: hooks.recordDshGetBranchError,
	} as unknown as ToolSession;
}

describe("session_search", () => {
	it("finds compacted toolCall arguments and re-gates when the arm is off", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "calling" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "secret-needle-xyz" } },
			],
			timestamp: Date.now(),
			stopReason: "toolUse",
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as never);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "compacted-result" }],
			isError: false,
			timestamp: Date.now(),
		} as never);
		const firstKept = manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		} as never);
		manager.appendCompaction("summary", undefined, firstKept, 10);

		const path = manager.getBranch();
		const { hits, incomplete } = collectSessionSearchHits(path, "secret-needle-xyz", false, 20);
		expect(incomplete).toBe(false);
		expect(hits.some(hit => hit.role === "toolCall" && hit.zone === "compacted")).toBe(true);
		expect(Buffer.byteLength(hits[0]!.args_snippet ?? "", "utf8")).toBeLessThanOrEqual(256);

		const on = new SessionSearchTool(toolSession(manager, true));
		const found = await on.execute("id", { query: "secret-needle-xyz" });
		expect(found.content[0]).toMatchObject({ type: "text" });

		const off = new SessionSearchTool(toolSession(manager, false));
		const gated = await off.execute("id", { query: "secret-needle-xyz" });
		expect(gated.isError).toBe(true);
		expect(gated.content[0]).toMatchObject({ type: "text", text: "session_search disabled by arm snapshot" });
	});

	it("fails loud when firstKeptEntryId is missing", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		} as never);
		manager.appendCompaction("summary", undefined, "missing-id", 1);
		const { incomplete } = collectSessionSearchHits(manager.getBranch(), "hi", true, 20);
		expect(incomplete).toBe(true);
	});

	it("records getBranch failures as dshGetBranchError", async () => {
		let recorded = false;
		const manager = {
			getBranch: () => {
				throw new Error("branch gone");
			},
		} as unknown as SessionManager;
		const tool = new SessionSearchTool(
			toolSession(manager, true, {
				recordDshGetBranchError: () => {
					recorded = true;
				},
			}),
		);
		const result = await tool.execute("id", { query: "x" });
		expect(result.isError).toBe(true);
		expect(recorded).toBe(true);
	});
});
