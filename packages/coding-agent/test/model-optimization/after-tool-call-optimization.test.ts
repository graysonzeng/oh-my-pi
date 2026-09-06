import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AfterToolCallContext } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { buildResolvedModelOptimization } from "../../src/model-optimization";
import type { ModelOptimizationProfile } from "../../src/model-optimization/types";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { TOOL_OPTIMIZATION_RECEIPT_KIND } from "../../src/workflow/optimization-receipt";

const tempDir = TempDir.createSync("@pi-after-tool-opt-");
const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
authStorage.setRuntimeApiKey("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

const profile: ModelOptimizationProfile = {
	id: "test-truncation",
	modelPattern: "claude-*",
	toolStrategy: {
		outputTruncation: {
			enabled: true,
			rules: [
				{
					toolName: "bash",
					strategy: "smart",
					maxBytes: 800,
					maxLines: 20,
				},
				{
					toolName: "read",
					strategy: "smart",
					maxBytes: 8000,
					maxLines: 160,
				},
			],
		},
		resultSummarization: { enabled: false },
	},
};

function makeHugeText(): string {
	return Array.from({ length: 200 }, (_, i) => `line ${i} payload body ${"x".repeat(40)}`).join("\n");
}

async function createSession(opts?: {
	saveArtifact?: (content: string, toolType: string) => Promise<string | undefined>;
	appendCustomEntry?: SessionManager["appendCustomEntry"];
	outputTruncationEnabled?: boolean;
	agentKind?: "main" | "sub";
}) {
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("missing model");
	const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	if (opts?.saveArtifact) {
		sessionManager.saveArtifact = opts.saveArtifact;
	}
	if (opts?.appendCustomEntry) {
		sessionManager.appendCustomEntry = opts.appendCustomEntry;
	}
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"modelOptimization.enabled": true,
			"modelOptimization.outputTruncation.enabled": opts?.outputTruncationEnabled ?? true,
		}),
		modelRegistry,
		agentKind: opts?.agentKind,
		reconcileModelOptimization: async () => buildResolvedModelOptimization(profile),
	});
	await session.ensureModelOptimization();
	return { session, sessionManager };
}

function toolCtx(
	text: string,
	toolCallId = "call-1",
	isError = false,
	toolName: "bash" | "read" = "bash",
): AfterToolCallContext {
	const args = toolName === "bash" ? { command: "ls" } : { path: "src/x.ts" };
	return {
		assistantMessage: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
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
		},
		toolCall: { type: "toolCall", id: toolCallId, name: toolName, arguments: args },
		args,
		result: {
			content: [{ type: "text", text }],
			details: {},
		},
		isError,
		context: { systemPrompt: ["Test"], messages: [], tools: [] },
	};
}

describe("ordinary session afterToolCall optimization", () => {
	it("shortens large text tool results, persists receipt, and keeps a recoverable artifact", async () => {
		const saved = new Map<string, string>();
		const { session, sessionManager } = await createSession({
			saveArtifact: async (content, _toolType) => {
				const id = String(saved.size);
				saved.set(id, content);
				return id;
			},
		});
		try {
			const original = makeHugeText();
			const after = session.agent.afterToolCall;
			expect(after).toBeFunction();
			const result = await after!(toolCtx(original, "call-big"));
			expect(result).toBeDefined();
			const textBlock = result?.content?.find(b => b.type === "text");
			expect(textBlock?.type).toBe("text");
			if (textBlock?.type !== "text") throw new Error("expected text");
			expect(textBlock.text.length).toBeLessThan(original.length);
			expect(textBlock.text).toMatch(/\[raw output: artifact:\/\/\d+\]/);
			const match = textBlock.text.match(/artifact:\/\/(\d+)/);
			expect(match?.[1]).toBeDefined();
			const artifactId = match![1]!;
			expect(saved.get(artifactId)).toBe(original);

			const receipts = sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === TOOL_OPTIMIZATION_RECEIPT_KIND);
			expect(receipts.length).toBe(1);
			const data = receipts[0] && receipts[0].type === "custom" ? receipts[0].data : undefined;
			expect(data && typeof data === "object" && "toolCallId" in data ? data.toolCallId : undefined).toBe(
				"call-big",
			);
			expect(data && typeof data === "object" && "recoveryUri" in data ? String(data.recoveryUri) : "").toContain(
				`artifact://${artifactId}`,
			);
		} finally {
			await session.dispose();
		}
	});

	it("keeps original text when artifact save fails (fail-closed)", async () => {
		const { session } = await createSession({
			saveArtifact: async () => undefined,
		});
		try {
			const original = makeHugeText();
			const result = await session.agent.afterToolCall!(toolCtx(original, "call-fail-save"));
			// No optimization when irreversible shrink would occur.
			expect(result).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("keeps original text when receipt append fails after truncation decision", async () => {
		const saved = new Map<string, string>();
		const { session, sessionManager } = await createSession({
			saveArtifact: async content => {
				const id = String(saved.size);
				saved.set(id, content);
				return id;
			},
		});
		const originalAppend = sessionManager.appendCustomEntry.bind(sessionManager);
		sessionManager.appendCustomEntry = ((customType: string, data?: unknown) => {
			if (customType === TOOL_OPTIMIZATION_RECEIPT_KIND) {
				throw new Error("receipt write failed");
			}
			return originalAppend(customType, data);
		}) as SessionManager["appendCustomEntry"];
		try {
			const original = makeHugeText();
			const result = await session.agent.afterToolCall!(toolCtx(original, "call-fail-receipt"));
			// Fail-closed: caller sees no optimization result.
			expect(result).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("does not optimize error tool results", async () => {
		const { session } = await createSession({
			saveArtifact: async () => "1",
		});
		try {
			const original = makeHugeText();
			const result = await session.agent.afterToolCall!(toolCtx(original, "call-err", true));
			expect(result).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("keeps original text when session output truncation is disabled even if the family profile clamps", async () => {
		const { session } = await createSession({
			saveArtifact: async () => "1",
			outputTruncationEnabled: false,
		});
		try {
			const original = makeHugeText();
			const result = await session.agent.afterToolCall!(toolCtx(original, "call-no-trunc"));
			expect(result).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("clamps subagent reads tighter than the parent family read cap", async () => {
		const original = Array.from({ length: 140 }, (_, i) => `read-line-${i} ${"x".repeat(40)}`).join("\n");
		const saved = new Map<string, string>();
		const { session: parent } = await createSession({
			saveArtifact: async () => "parent",
		});
		const { session: sub } = await createSession({
			agentKind: "sub",
			saveArtifact: async content => {
				const id = String(saved.size);
				saved.set(id, content);
				return id;
			},
		});
		try {
			const parentResult = await parent.agent.afterToolCall!(toolCtx(original, "call-parent-read", false, "read"));
			const subResult = await sub.agent.afterToolCall!(toolCtx(original, "call-sub-read", false, "read"));
			expect(parentResult).toBeUndefined();
			const subText = subResult?.content?.find(b => b.type === "text");
			expect(subText?.type).toBe("text");
			if (subText?.type !== "text") throw new Error("expected subagent text");
			expect(subText.text.length).toBeLessThan(original.length);
			expect(subText.text).toMatch(/\[raw output: artifact:\/\//);
		} finally {
			await parent.dispose();
			await sub.dispose();
		}
	});
});
