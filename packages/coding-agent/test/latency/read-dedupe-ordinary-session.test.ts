import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AfterToolCallContext } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resetActiveRulesForTests, setActiveRules } from "../../src/capability/rule";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { resetActiveSkillsForTests, setActiveSkills } from "../../src/extensibility/skills";
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
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getArtifactContent: (id: string) => sessionManager.getArtifactContent(id),
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

	it("rewrites on no-session in-memory artifact storage and recovers the saved body", async () => {
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
			const firstAfter = await session.agent.afterToolCall!(readCtx("read-1", firstExec, args));
			const firstVisible = textFromResult(firstAfter ?? firstExec);
			const artifactRef = firstVisible.match(/\[raw output: (artifact:\/\/\d+)\]/)?.[1];
			if (!artifactRef) throw new Error("expected a recoverable in-memory artifact reference");
			const recovered = await readTool.execute("artifact-recover", { path: `${artifactRef}:raw:1-21` });
			const recoveredText = textFromResult(recovered);
			const fileLines = makeFileBody().split("\n");
			const firstLine = fileLines[0];
			const twentiethLine = fileLines[19];
			if (!firstLine || !twentiethLine) throw new Error("expected read fixture sentinel lines");
			expect(recoveredText).toContain(firstLine);
			expect(recoveredText).toContain(twentiethLine);
			expect(recoveredText).not.toContain("No session - artifacts unavailable");
			expect(recoveredText).not.toContain("not found in the current session");

			const secondExec = await readTool.execute("read-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("read-2", secondExec, args));
			const secondVisible = textFromResult(secondAfter);
			expect(secondVisible).toMatch(/^\[context ref: artifact:\/\/\d+ sha256:[a-f0-9]{64}\]$/);
		} finally {
			await session.dispose();
		}
	});

	it("does not reference a retained artifact after verification fails", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "stale-"));
		const filePath = path.join(workDir, "module.ts");
		await fs.writeFile(filePath, makeFileBody());
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: filePath };
			const firstExec = await readTool.execute("read-1", args);
			const firstAfter = await session.agent.afterToolCall!(readCtx("read-1", firstExec, args));
			const artifactRef = textFromResult(firstAfter).match(/\[raw output: (artifact:\/\/\d+)\]/)?.[1];
			if (!artifactRef) throw new Error("expected a recoverable artifact reference");
			const artifactPath = await sessionManager.getArtifactPath(artifactRef.slice("artifact://".length));
			if (!artifactPath) throw new Error("expected an artifact path");
			await fs.rm(artifactPath, { force: true });
			const secondExec = await readTool.execute("read-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("read-2", secondExec, args));
			expect(textFromResult(secondAfter)).not.toMatch(/^\[context ref: artifact:\/\//);
		} finally {
			await session.dispose();
		}
	});

	it("does not dedupe reads when the selector changes", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "selector-"));
		const filePath = path.join(workDir, "module.ts");
		await fs.writeFile(filePath, makeFileBody());
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const firstArgs = { path: filePath, offset: 1, limit: 20 };
			const secondArgs = { path: filePath, offset: 21, limit: 20 };
			const firstExec = await readTool.execute("read-1", firstArgs);
			await session.agent.afterToolCall!(readCtx("read-1", firstExec, firstArgs));
			const secondExec = await readTool.execute("read-2", secondArgs);
			const secondAfter = await session.agent.afterToolCall!(readCtx("read-2", secondExec, secondArgs));
			expect(textFromResult(secondAfter)).not.toMatch(/^\[context ref: artifact:\/\//);
		} finally {
			await session.dispose();
		}
	});
	it("stubs a second identical inline path:start-end selector without merging ranges", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "inline-sel-"));
		const filePath = path.join(workDir, "module.ts");
		await fs.writeFile(filePath, makeFileBody());
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const firstArgs = { path: `${filePath}:1-20` };
			const secondArgs = { path: `${filePath}:21-40` };
			const firstExec = await readTool.execute("read-1", firstArgs);
			await session.agent.afterToolCall!(readCtx("read-1", firstExec, firstArgs));
			const otherRangeExec = await readTool.execute("read-2", secondArgs);
			const otherRangeAfter = await session.agent.afterToolCall!(readCtx("read-2", otherRangeExec, secondArgs));
			expect(textFromResult(otherRangeAfter ?? otherRangeExec)).not.toMatch(/^\[context ref: artifact:\/\//);
			const repeatExec = await readTool.execute("read-3", secondArgs);
			const repeatAfter = await session.agent.afterToolCall!(readCtx("read-3", repeatExec, secondArgs));
			expect(textFromResult(repeatAfter)).toMatch(/^\[context ref: artifact:\/\/\d+ sha256:[a-f0-9]{64}\]$/);
		} finally {
			await session.dispose();
		}
	});

	it("clears retained read artifacts when the model changes", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "model-switch-"));
		const filePath = path.join(workDir, "module.ts");
		await fs.writeFile(filePath, makeFileBody());
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: filePath };
			const firstExec = await readTool.execute("read-1", args);
			await session.agent.afterToolCall!(readCtx("read-1", firstExec, args));
			const currentModel = session.model;
			if (!currentModel) throw new Error("expected an active model");
			await session.setModelTemporary({ ...currentModel, id: `${currentModel.id}-switched` });
			const secondExec = await readTool.execute("read-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("read-2", secondExec, args));
			expect(textFromResult(secondAfter)).not.toMatch(/^\[context ref: artifact:\/\//);
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

describe("canonical skill full-text read dedupe", () => {
	afterAll(() => {
		resetActiveSkillsForTests();
	});

	it("stubs a second identical skill:// full-text read", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "skill-"));
		const skillDir = path.join(workDir, "engineering-flow");
		await fs.mkdir(skillDir);
		const body = `# engineering-flow\n${"load once. ".repeat(80)}`;
		await fs.writeFile(
			path.join(skillDir, "SKILL.md"),
			`---\nname: engineering-flow\ndescription: test\n---\n\n${body}\n`,
		);
		setActiveSkills([
			{
				name: "engineering-flow",
				description: "test",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);

		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: "skill://engineering-flow" };
			const firstExec = await readTool.execute("skill-1", args);
			expect(firstExec.details?.canonicalSource).toBe("skill://engineering-flow");
			expect(firstExec.details?.providerViewIdentity).toBe("skill-immutable:engineering-flow");
			const firstAfter = await session.agent.afterToolCall!(readCtx("skill-1", firstExec, args));
			expect(textFromResult(firstAfter ?? firstExec)).toContain("load once.");
			const secondExec = await readTool.execute("skill-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("skill-2", secondExec, args));
			expect(textFromResult(secondAfter)).toMatch(/^\[context ref: artifact:\/\/\d+ sha256:[a-f0-9]{64}\]$/);
		} finally {
			await session.dispose();
			resetActiveSkillsForTests();
		}
	});

	it("does not stub a ranged skill read", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "skill-range-"));
		const skillDir = path.join(workDir, "engineering-flow");
		await fs.mkdir(skillDir);
		await fs.writeFile(
			path.join(skillDir, "SKILL.md"),
			"---\nname: engineering-flow\ndescription: test\n---\n\nline1\nline2\nline3\n",
		);
		setActiveSkills([
			{
				name: "engineering-flow",
				description: "test",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: "skill://engineering-flow:1-2" };
			const firstExec = await readTool.execute("skill-range-1", args);
			expect(firstExec.details?.providerViewIdentity).toBeUndefined();
			await session.agent.afterToolCall!(readCtx("skill-range-1", firstExec, args));
			const secondExec = await readTool.execute("skill-range-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("skill-range-2", secondExec, args));
			expect(textFromResult(secondAfter ?? secondExec)).not.toMatch(/\[context ref: artifact:\/\//);
		} finally {
			await session.dispose();
			resetActiveSkillsForTests();
		}
	});

	it("does not attest query, fragment, or raw skill views", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "skill-ineligible-"));
		const skillDir = path.join(workDir, "engineering-flow");
		await fs.mkdir(skillDir);
		await fs.writeFile(
			path.join(skillDir, "SKILL.md"),
			"---\nname: engineering-flow\ndescription: test\n---\n\nfull skill body\n",
		);
		setActiveSkills([
			{
				name: "engineering-flow",
				description: "test",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			for (const pathArg of [
				"skill://engineering-flow?q=once",
				"skill://engineering-flow#frag",
				"skill://engineering-flow:raw",
			]) {
				const exec = await readTool.execute(`ineligible-${pathArg}`, { path: pathArg });
				expect(exec.details?.providerViewIdentity).toBeUndefined();
				expect(exec.details?.contentOrRevisionIdentity).toBeUndefined();
			}
		} finally {
			await session.dispose();
			resetActiveSkillsForTests();
		}
	});

	it("stubs a second identical rule:// full-text read", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "rule-"));
		const body = `rule once. ${"keep this. ".repeat(80)}`;
		const rulePath = path.join(workDir, "adaptive-delivery.md");
		await fs.writeFile(rulePath, body);
		setActiveRules([
			{
				name: "adaptive-delivery",
				path: rulePath,
				content: body,
				_source: {
					provider: "test",
					providerName: "test",
					path: rulePath,
					level: "project",
				},
			},
		]);
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: "rule://adaptive-delivery" };
			const firstExec = await readTool.execute("rule-1", args);
			expect(firstExec.details?.canonicalSource).toBe("rule://adaptive-delivery");
			expect(firstExec.details?.providerViewIdentity).toBe("rule-immutable:adaptive-delivery");
			const firstAfter = await session.agent.afterToolCall!(readCtx("rule-1", firstExec, args));
			expect(textFromResult(firstAfter ?? firstExec)).toContain("rule once.");
			const secondExec = await readTool.execute("rule-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("rule-2", secondExec, args));
			expect(textFromResult(secondAfter)).toMatch(/^\[context ref: artifact:\/\/\d+ sha256:[a-f0-9]{64}\]$/);
		} finally {
			await session.dispose();
			resetActiveRulesForTests();
		}
	});

	it("stubs a second disk SKILL.md full-text read as the canonical skill view", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "skill-file-"));
		const skillDir = path.join(workDir, "engineering-flow");
		await fs.mkdir(skillDir);
		const body = `# engineering-flow\n${"load once. ".repeat(80)}`;
		const skillFile = path.join(skillDir, "SKILL.md");
		await fs.writeFile(skillFile, `---\nname: engineering-flow\ndescription: test\n---\n\n${body}\n`);
		setActiveSkills([
			{
				name: "engineering-flow",
				description: "test",
				filePath: skillFile,
				baseDir: skillDir,
				source: "test",
			},
		]);
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: skillFile };
			const firstExec = await readTool.execute("skill-file-1", args);
			expect(firstExec.details?.canonicalSource).toBe("skill://engineering-flow");
			expect(firstExec.details?.providerViewIdentity).toBe("skill-immutable:engineering-flow");
			await session.agent.afterToolCall!(readCtx("skill-file-1", firstExec, args));
			const secondExec = await readTool.execute("skill-file-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("skill-file-2", secondExec, args));
			expect(textFromResult(secondAfter)).toMatch(/^\[context ref: artifact:\/\/\d+ sha256:[a-f0-9]{64}\]$/);
		} finally {
			await session.dispose();
			resetActiveSkillsForTests();
		}
	});

	it("stubs mixed skill:// and disk SKILL.md full-text as one view", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "skill-mixed-"));
		const skillDir = path.join(workDir, "engineering-flow");
		await fs.mkdir(skillDir);
		const body = `# engineering-flow\n${"load once. ".repeat(80)}`;
		const skillFile = path.join(skillDir, "SKILL.md");
		await fs.writeFile(skillFile, `---\nname: engineering-flow\ndescription: test\n---\n\n${body}\n`);
		setActiveSkills([
			{
				name: "engineering-flow",
				description: "test",
				filePath: skillFile,
				baseDir: skillDir,
				source: "test",
			},
		]);
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const firstExec = await readTool.execute("skill-uri", { path: "skill://engineering-flow" });
			await session.agent.afterToolCall!(readCtx("skill-uri", firstExec, { path: "skill://engineering-flow" }));
			const secondExec = await readTool.execute("skill-file", { path: skillFile });
			const secondAfter = await session.agent.afterToolCall!(readCtx("skill-file", secondExec, { path: skillFile }));
			expect(secondExec.details?.canonicalSource).toBe("skill://engineering-flow");
			expect(textFromResult(secondAfter)).toMatch(/^\[context ref: artifact:\/\/\d+ sha256:[a-f0-9]{64}\]$/);
		} finally {
			await session.dispose();
			resetActiveSkillsForTests();
		}
	});

	it("stubs mixed rule:// and disk rule-file full-text as one view", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "rule-mixed-"));
		const body = `rule once. ${"keep this. ".repeat(80)}`;
		const rulePath = path.join(workDir, "adaptive-delivery.md");
		await fs.writeFile(rulePath, `---\nname: adaptive-delivery\n---\n\n${body}`);
		setActiveRules([
			{
				name: "adaptive-delivery",
				path: rulePath,
				content: body,
				_source: {
					provider: "test",
					providerName: "test",
					path: rulePath,
					level: "project",
				},
			},
		]);
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const firstExec = await readTool.execute("rule-uri", { path: "rule://adaptive-delivery" });
			await session.agent.afterToolCall!(readCtx("rule-uri", firstExec, { path: "rule://adaptive-delivery" }));
			const secondExec = await readTool.execute("rule-file", { path: rulePath });
			const secondAfter = await session.agent.afterToolCall!(readCtx("rule-file", secondExec, { path: rulePath }));
			expect(secondExec.details?.canonicalSource).toBe("rule://adaptive-delivery");
			expect(textFromResult(secondAfter)).toMatch(/^\[context ref: artifact:\/\/\d+ sha256:[a-f0-9]{64}\]$/);
		} finally {
			await session.dispose();
			resetActiveRulesForTests();
		}
	});
	it("re-injects skill full text after the retained map is cleared", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "skill-reset-"));
		const skillDir = path.join(workDir, "engineering-flow");
		await fs.mkdir(skillDir);
		const body = `# engineering-flow\n${"load once. ".repeat(80)}`;
		await fs.writeFile(
			path.join(skillDir, "SKILL.md"),
			`---\nname: engineering-flow\ndescription: test\n---\n\n${body}\n`,
		);
		setActiveSkills([
			{
				name: "engineering-flow",
				description: "test",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: "skill://engineering-flow" };
			const firstExec = await readTool.execute("skill-reset-1", args);
			await session.agent.afterToolCall!(readCtx("skill-reset-1", firstExec, args));
			const currentModel = session.model;
			if (!currentModel) throw new Error("expected an active model");
			await session.setModelTemporary({ ...currentModel, id: `${currentModel.id}-switched` });
			const secondExec = await readTool.execute("skill-reset-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("skill-reset-2", secondExec, args));
			expect(textFromResult(secondAfter ?? secondExec)).toContain("load once.");
			expect(textFromResult(secondAfter ?? secondExec)).not.toMatch(/^\[context ref: artifact:\/\//);
		} finally {
			await session.dispose();
			resetActiveSkillsForTests();
		}
	});

	it("re-injects when skill body hash changes between reads", async () => {
		const workDir = await fs.mkdtemp(path.join(tempDir.path(), "skill-hash-"));
		const skillDir = path.join(workDir, "engineering-flow");
		await fs.mkdir(skillDir);
		const skillFile = path.join(skillDir, "SKILL.md");
		await fs.writeFile(skillFile, "---\nname: engineering-flow\ndescription: test\n---\n\nfirst body\n");
		setActiveSkills([
			{
				name: "engineering-flow",
				description: "test",
				filePath: skillFile,
				baseDir: skillDir,
				source: "test",
			},
		]);
		const { session, sessionManager } = await createSession({
			sessionManager: SessionManager.create(workDir, workDir),
		});
		try {
			const readTool = new ReadTool(makeToolSession(workDir, sessionManager));
			const args = { path: "skill://engineering-flow" };
			const firstExec = await readTool.execute("skill-hash-1", args);
			await session.agent.afterToolCall!(readCtx("skill-hash-1", firstExec, args));
			await fs.writeFile(skillFile, "---\nname: engineering-flow\ndescription: test\n---\n\nmutated body\n");
			const secondExec = await readTool.execute("skill-hash-2", args);
			const secondAfter = await session.agent.afterToolCall!(readCtx("skill-hash-2", secondExec, args));
			expect(textFromResult(secondAfter ?? secondExec)).toContain("mutated body");
			expect(textFromResult(secondAfter ?? secondExec)).not.toMatch(/\[context ref: artifact:\/\//);
		} finally {
			await session.dispose();
			resetActiveSkillsForTests();
		}
	});
});
