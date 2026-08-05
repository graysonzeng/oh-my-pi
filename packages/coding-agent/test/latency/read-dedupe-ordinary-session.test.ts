import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
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
import type { ToolSession } from "../../src/tools";
import { ReadTool } from "../../src/tools/read";

const tempDir = TempDir.createSync("@pi-read-dedupe-ordinary-");
const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
authStorage.setRuntimeApiKey("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

const profile: ModelOptimizationProfile = {
	id: "test-read-dedupe",
	modelPattern: "claude-*",
	toolStrategy: {
		outputTruncation: {
			enabled: true,
			rules: [{ toolName: "read", strategy: "head", maxBytes: 1200, maxLines: 40 }],
		},
		resultSummarization: { enabled: false },
	},
};

function makeFileBody(): string {
	return Array.from({ length: 400 }, (_, i) => `export const line${i} = ${i}; // ${"x".repeat(40)}`).join("\n");
}

function textFromResult(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	return (
		result?.content
			?.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("\n") ?? ""
	);
}

function readCtx(
	callId: string,
	result: { content: AfterToolCallContext["result"]["content"]; details?: unknown },
	args: Record<string, unknown>,
): AfterToolCallContext {
	return {
		assistantMessage: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "read", arguments: args }],
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
		toolCall: { type: "toolCall", id: callId, name: "read", arguments: args },
		args,
		result: {
			content: result.content as AfterToolCallContext["result"]["content"],
			details: result.details,
		},
		isError: false,
		context: { systemPrompt: ["Test"], messages: [], tools: [] },
	};
}

async function createSession(opts?: { sessionManager?: SessionManager; settings?: Record<string, unknown> }) {
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("missing model");
	const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
	const sessionManager = opts?.sessionManager ?? SessionManager.create(tempDir.path(), tempDir.path());
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"modelOptimization.enabled": true,
			"latency.arms.readDedupe": true,
			...(opts?.settings ?? {}),
		}),
		modelRegistry,
		reconcileModelOptimization: async () => buildResolvedModelOptimization(profile),
	});
	await session.ensureModelOptimization();
	return { session, sessionManager };
}

function makeToolSession(cwd: string, sessionManager: SessionManager): ToolSession {
	return {
		cwd,
		settings: Settings.isolated({}),
		modelRegistry,
		getSessionId: () => "read-dedupe-test",
		getSessionName: () => undefined,
		getSessionDir: () => cwd,
		getSessionManager: () => sessionManager,
		createUI: () => null,
		signal: undefined,
	} as unknown as ToolSession;
}

describe("ordinary session read dedupe", () => {
	it("rewrites the second full read of the same file to a context ref", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "case-"));
		const filePath = path.join(workDir, "module.ts");
		await fs.writeFile(filePath, makeFileBody());

		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: filePath };

			const firstExec = await readTool.execute("read-1", args);
			expect(firstExec.details?.canonicalSource).toBeTruthy();
			expect(firstExec.details?.providerViewIdentity).toBeTruthy();
			expect(firstExec.details?.contentOrRevisionIdentity).toBeTruthy();
			expect(firstExec.details?.branchOrWorktreeScope).toBeTruthy();

			const firstAfter = await session.agent.afterToolCall!(readCtx("read-1", firstExec, args));
			const firstVisible = textFromResult(firstAfter ?? firstExec);
			expect(firstVisible).not.toMatch(/\[context ref: artifact:\/\//);
			expect(firstVisible.length).toBeGreaterThan(0);
			expect(firstVisible.length).toBeLessThan(makeFileBody().length);

			const secondExec = await readTool.execute("read-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("read-2", secondExec, args));
			const secondVisible = textFromResult(secondAfter);
			expect(secondVisible).toMatch(/^\[context ref: artifact:\/\/\d+ sha256:[a-f0-9]{64}\]$/);
		} finally {
			await session.dispose();
		}
	});

	it("rewrites on no-session in-memory artifact storage", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "nosess-"));
		const filePath = path.join(workDir, "module.ts");
		await fs.writeFile(filePath, makeFileBody());

		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.inMemory(workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: filePath };

			const firstExec = await readTool.execute("read-1", args);
			await session.agent.afterToolCall!(readCtx("read-1", firstExec, args));

			const secondExec = await readTool.execute("read-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("read-2", secondExec, args));
			const secondVisible = textFromResult(secondAfter);
			expect(secondVisible).toMatch(/^\[context ref: artifact:\/\/\d+ sha256:[a-f0-9]{64}\]$/);
		} finally {
			await session.dispose();
		}
	});

	it("does not rewrite when readDedupe arm is off", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "off-"));
		const filePath = path.join(workDir, "module.ts");
		await fs.writeFile(filePath, makeFileBody());

		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
			settings: { "latency.arms.readDedupe": false },
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: filePath };
			const firstExec = await readTool.execute("read-1", args);
			await session.agent.afterToolCall!(readCtx("read-1", firstExec, args));
			const secondExec = await readTool.execute("read-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("read-2", secondExec, args));
			const secondVisible = textFromResult(secondAfter ?? secondExec);
			expect(secondVisible).not.toMatch(/\[context ref: artifact:\/\//);
		} finally {
			await session.dispose();
		}
	});
});
