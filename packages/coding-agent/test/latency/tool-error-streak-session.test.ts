import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AfterToolCallContext } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, READ_OMITTED_CONTENT_TOOL_NAME } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { TOOL_ERROR_STREAK_THRESHOLD } from "../../src/latency/tool-error-streak";

const cleanup: Array<() => Promise<void>> = [];
let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

async function setup(): Promise<void> {
	sharedDir = TempDir.createSync("@pi-error-streak-session-shared-");
	authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
}

async function teardown(): Promise<void> {
	authStorage.close();
	sharedDir.removeSync();
}

async function createHarness(): Promise<{ agent: Agent; session: AgentSession }> {
	const tempDir = TempDir.createSync("@pi-error-streak-session-");
	const cwd = tempDir.path();
	const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const agent = new Agent({
		initialState: {
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
	});
	cleanup.push(async () => {
		await session.dispose();
		tempDir.removeSync();
	});
	return { agent, session };
}

function toolCtx(options: {
	id: string;
	name?: string;
	text: string;
	isError: boolean;
	details?: unknown;
}): AfterToolCallContext {
	const name = options.name ?? "edit";
	const args = { path: "src/x.ts" };
	return {
		assistantMessage: {
			role: "assistant",
			content: [{ type: "toolCall", id: options.id, name, arguments: args }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
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
		toolCall: { type: "toolCall", id: options.id, name, arguments: args },
		args,
		result: {
			content: [{ type: "text", text: options.text }],
			details: options.details,
		},
		isError: options.isError,
		context: { systemPrompt: ["Test"], messages: [], tools: [] },
	};
}

function extraText(
	result: { content?: Array<{ type: string; text?: string }> } | undefined,
	original: string,
): string[] {
	return (result?.content ?? [])
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.filter(text => text !== original);
}

describe("tool-error-streak AgentSession boundary", () => {
	beforeAll(setup);
	afterAll(teardown);
	afterEach(async () => {
		while (cleanup.length > 0) {
			const run = cleanup.pop();
			if (run) await run();
		}
	});

	it("appends one-shot advice and resets an unadvised streak across new and switch", async () => {
		const { agent, session } = await createHarness();
		const after = agent.afterToolCall;
		if (!after) throw new Error("expected afterToolCall");
		const original = "ENOENT foo";

		for (let i = 1; i < TOOL_ERROR_STREAK_THRESHOLD; i++) {
			const result = await after(toolCtx({ id: `err-${i}`, text: original, isError: true }));
			expect(extraText(result, original)).toEqual([]);
		}
		const atThreshold = await after(
			toolCtx({ id: `err-${TOOL_ERROR_STREAK_THRESHOLD}`, text: original, isError: true }),
		);
		expect(extraText(atThreshold, original).length).toBe(1);
		const afterOneShot = await after(toolCtx({ id: "err-after-shot", text: original, isError: true }));
		expect(extraText(afterOneShot, original)).toEqual([]);

		await session.sessionManager.ensureOnDisk();
		const previousFile = session.sessionFile;
		if (!previousFile) throw new Error("expected persisted previous session");
		await after(toolCtx({ id: "success-before-new", text: "ok", isError: false }));
		for (let i = 1; i < TOOL_ERROR_STREAK_THRESHOLD; i++) {
			await after(toolCtx({ id: `prime-new-${i}`, text: original, isError: true }));
		}
		expect(await session.newSession()).toBe(true);
		const afterNew = await after(toolCtx({ id: "err-after-new", text: original, isError: true }));
		expect(extraText(afterNew, original)).toEqual([]);
		// The first error above plus one more prime the replacement session to two.
		await after(toolCtx({ id: "second-after-new", text: original, isError: true }));
		expect(await session.switchSession(previousFile)).toBe(true);
		const afterSwitch = await after(toolCtx({ id: "first-after-switch", text: original, isError: true }));
		expect(extraText(afterSwitch, original)).toEqual([]);
	});

	it("does not count never-executed synthetic scheduler skips as real failures", async () => {
		const { agent } = await createHarness();
		const after = agent.afterToolCall;
		if (!after) throw new Error("expected afterToolCall");
		const original = "Skipped due to system cancel";
		const skipDetails = { __synthetic: true, source: "prestart_system_cancel", executed: false };
		for (let i = 1; i < TOOL_ERROR_STREAK_THRESHOLD; i++) {
			await after(toolCtx({ id: `before-skip-${i}`, name: "read", text: original, isError: true }));
		}

		for (let i = 1; i <= TOOL_ERROR_STREAK_THRESHOLD; i++) {
			const result = await after(
				toolCtx({ id: `skip-${i}`, name: "read", text: original, isError: true, details: skipDetails }),
			);
			expect(extraText(result, original)).toEqual([]);
		}

		for (let i = 1; i < TOOL_ERROR_STREAK_THRESHOLD; i++) {
			const result = await after(toolCtx({ id: `real-${i}`, name: "read", text: original, isError: true }));
			expect(extraText(result, original)).toEqual([]);
		}
		const realThreshold = await after(
			toolCtx({
				id: `real-${TOOL_ERROR_STREAK_THRESHOLD}`,
				name: "read",
				text: original,
				isError: true,
			}),
		);
		expect(extraText(realThreshold, original).length).toBe(1);
	});

	it("clears the streak on omitted-content success without rewriting the page", async () => {
		const { agent } = await createHarness();
		const after = agent.afterToolCall;
		if (!after) throw new Error("expected afterToolCall");
		const original = "ENOENT foo";

		for (let i = 1; i < TOOL_ERROR_STREAK_THRESHOLD; i++) {
			await after(toolCtx({ id: `pre-${i}`, text: original, isError: true }));
		}

		const protectedPage = "PROTECTED_PAGE_BYTES";
		const omitted = await after(
			toolCtx({
				id: "omitted-ok",
				name: READ_OMITTED_CONTENT_TOOL_NAME,
				text: protectedPage,
				isError: false,
				details: { cursor: 1 },
			}),
		);
		expect(omitted).toBeUndefined();

		const nextError = await after(toolCtx({ id: "post-omitted", text: original, isError: true }));
		expect(extraText(nextError, original)).toEqual([]);
	});
});
