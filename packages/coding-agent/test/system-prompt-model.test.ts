import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { getSystemPromptPolicy, type SystemPromptPolicy } from "@oh-my-pi/pi-coding-agent/task/prompt-policy";
import { getAgentDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

function fixtureModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model;
}

describe("getSystemPromptPolicy", () => {
	it("routes aliases and vendor prefixes without depending on catalog rows", () => {
		const cases: Array<[string | undefined, SystemPromptPolicy]> = [
			[undefined, "default"],
			["anthropic/claude-opus-4", "default"],
			["gpt-5.4", "default"],
			["gpt-5.6", "codex"],
			["openai/gpt-5.6", "codex"],
			["gpt-5.6-codex", "codex"],
			["daybreak-blue-latest", "codex"],
			["gpt-6", "astra"],
			["gpt-6-astra", "astra"],
			["openai/gpt-6", "astra"],
			["openai/gpt-6-astra", "astra"],
			["github-copilot/gpt-6-astra", "astra"],
			["kilo/openai/gpt-6-astra", "astra"],
			["gpt-6-mini", "default"],
			["gpt-6-codex", "default"],
			["gpt-6.1", "default"],
			["grok-4.6", "concise"],
			["gateway/grok-4.6", "concise"],
			["deepseek-v4-flash", "concise"],
			["openrouter/deepseek/deepseek-v4-flash", "concise"],
			["grok-4.60", "default"],
			["grok-4.6-fast", "default"],
			["deepseek-v4-pro", "default"],
			["deepseek-v4-flash-preview", "default"],
		];
		for (const [modelId, policy] of cases) {
			expect(getSystemPromptPolicy(modelId), String(modelId)).toBe(policy);
		}
	});
});

async function expectPromptDateFromStartupTimezone(options: {
	tempDir: string;
	tempHomeDir: string;
	timeZone: string;
	now: string;
	expectedDate: string;
	rejectedDate: string;
}): Promise<void> {
	const scenarioPath = path.join(options.tempDir, "prompt-date-timezone.test.ts");
	await Bun.write(
		scenarioPath,
		`import { setSystemTime } from "bun:test";
import { renderDateCwdReminder } from ${JSON.stringify(
			path.resolve(import.meta.dir, "../src/session/date-cwd-reminder.ts"),
		)};
import { formatLocalCalendarDate } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/utils/local-date.ts"))};

setSystemTime(new Date(process.env.OMP_TEST_NOW!));
try {
	// The date/cwd reminder is built per request in the startup local timezone;
	// the system prompt no longer embeds the date (#7404).
	const reminder = renderDateCwdReminder(formatLocalCalendarDate(), "/cwd");
	if (!reminder.includes(\`Today: \${process.env.OMP_EXPECTED_DATE}\`)) {
		throw new Error(\`Reminder did not contain expected local date:\\n\${reminder}\`);
	}
	if (reminder.includes(\`Today: \${process.env.OMP_REJECTED_DATE}\`)) {
		throw new Error(\`Reminder contained rejected UTC date:\\n\${reminder}\`);
	}
} finally {
	setSystemTime();
}
`,
	);
	const child = Bun.spawn([process.execPath, scenarioPath], {
		cwd: options.tempDir,
		env: {
			...process.env,
			HOME: options.tempHomeDir,
			TZ: options.timeZone,
			OMP_TEST_NOW: options.now,
			OMP_EXPECTED_DATE: options.expectedDate,
			OMP_REJECTED_DATE: options.rejectedDate,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}

describe("system prompt model identifier", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("renders the model identifier into the workstation block when provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			model: "anthropic/claude-opus-4",
		});

		expect(systemPrompt.join("\n\n")).toContain("Model: anthropic/claude-opus-4");
	});

	it("renders the first-turn reminder date from the startup local timezone rather than UTC", async () => {
		await expectPromptDateFromStartupTimezone({
			tempDir,
			tempHomeDir,
			timeZone: "America/Los_Angeles",
			now: "2026-07-01T03:15:00Z",
			expectedDate: "2026-06-30",
			rejectedDate: "2026-07-01",
		});
	});

	it("omits the model line when no model is provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		expect(systemPrompt.join("\n\n")).not.toContain("Model:");
	});

	async function renderPrompt(options: {
		model?: string;
		customPrompt?: string;
		personality?: "default" | "friendly" | "pragmatic" | "none";
	}): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			...options,
		});
		return systemPrompt.join("\n\n");
	}

	it("selects concise guidance for Astra, Grok 4.6, and DeepSeek V4 Flash", async () => {
		for (const model of ["openai/gpt-6-astra", "gateway/grok-4.6", "deepseek/deepseek-v4-flash"]) {
			const rendered = await renderPrompt({ model });
			expect(rendered, model).toContain("# Working agreement");
			expect(rendered, model).toContain("# Execution");
			expect(rendered, model).not.toContain("§ Workflow");
		}
	});

	it("keeps the default branch for models outside the concise allowlist", async () => {
		for (const model of [
			"anthropic/claude-opus-4",
			"gpt-6-mini",
			"gpt-6-codex",
			"gpt-5.6",
			"grok-4.6-fast",
			"deepseek-v4-pro",
		]) {
			const rendered = await renderPrompt({ model });
			expect(rendered, model).toContain("§ Workflow");
			expect(rendered, model).not.toContain("# Working agreement");
		}
	});

	it("lets a custom prompt replace concise guidance", async () => {
		for (const model of ["gpt-6-astra", "grok-4.6", "deepseek-v4-flash"]) {
			const rendered = await renderPrompt({ model, customPrompt: "CUSTOM_PROMPT_ONLY" });
			expect(rendered, model).toContain("CUSTOM_PROMPT_ONLY");
			expect(rendered, model).not.toContain("# Working agreement");
			expect(rendered, model).not.toContain("# Execution");
		}
	});

	it("keeps PERSONALITY.md override when the concise default personality would apply", async () => {
		const originalAgentDir = getAgentDir();
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-astra-personality-"));
		setAgentDir(agentDir);
		try {
			await Bun.write(path.join(agentDir, "PERSONALITY.md"), "OVERRIDE_PERSONALITY_MARKER");
			for (const model of ["gpt-6-astra", "grok-4.6", "deepseek-v4-flash"]) {
				const rendered = await renderPrompt({ model });
				expect(rendered, model).toContain("OVERRIDE_PERSONALITY_MARKER");
				expect(rendered, model).toContain("# Working agreement");
			}
		} finally {
			setAgentDir(originalAgentDir);
			removeSyncWithRetries(agentDir);
		}
	});

	it("omits personality when disabled on concise models", async () => {
		for (const model of ["gpt-6-astra", "grok-4.6", "deepseek-v4-flash"]) {
			const rendered = await renderPrompt({ model, personality: "none" });
			expect(rendered, model).not.toContain("# Personality");
			expect(rendered, model).toContain("# Working agreement");
		}
	});
});

describe("AgentSession model-change prompt refresh", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function pickTwoModels(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(m => m.provider !== first.provider || m.id !== first.id);
		if (!first || !second) throw new Error("Expected at least two distinct models in the registry");
		return [first, second];
	}

	function pickTwoModelsWithSameTaskPolicy(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(
			model =>
				(model.provider !== first.provider || model.id !== first.id) &&
				getSystemPromptPolicy(model.id) === getSystemPromptPolicy(first.id),
		);
		if (!first || !second) throw new Error("Expected two distinct models with the same task prompt policy");
		return [first, second];
	}

	function pickModelsAcrossTaskPolicies(): [Model, Model] {
		const all = modelRegistry.getAll();
		const defaultPolicy = all.find(model => getSystemPromptPolicy(model.id) === "default");
		const codexPolicy = all.find(model => getSystemPromptPolicy(model.id) === "codex");
		if (!defaultPolicy || !codexPolicy) throw new Error("Expected default-policy and GPT-5.6 models");
		return [defaultPolicy, codexPolicy];
	}

	function newSession(
		model: Model,
		settings: Settings,
		rebuild: () => Promise<{ systemPrompt: string[] }>,
	): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => rebuild(),
		});
		return created;
	}

	it("rebuilds the prompt with the new model when includeModelInPrompt is enabled", async () => {
		const [modelA, modelB] = pickTwoModels();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(modelA, Settings.isolated({ "compaction.enabled": false }), async () => {
			rebuildCount++;
			const active = session?.model;
			return { systemPrompt: [`model:${active ? `${active.provider}/${active.id}` : ""}`] };
		});

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual([`model:${modelB.provider}/${modelB.id}`]);

		// Re-selecting the same model leaves the rendered model unchanged → no rebuild.
		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
	});

	it("does not rebuild a hidden-model prompt when the task policy stays the same", async () => {
		const [modelA, modelB] = pickTwoModelsWithSameTaskPolicy();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["unchanged"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});

	it("rebuilds a hidden-model prompt when the task policy changes", async () => {
		const [modelA, modelB] = pickModelsAcrossTaskPolicies();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["policy changed"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["policy changed"]);
	});

	it("rebuilds hidden-model prompts across policies but reuses equivalent concise guidance", async () => {
		const defaultModel = fixtureModel("policy-default", "gpt-6-mini");
		const astraModel = fixtureModel("policy-astra", "gpt-6-astra");
		const codexModel = fixtureModel("policy-codex", "gpt-5.6");
		const grokModel = fixtureModel("policy-concise", "grok-4.6");
		const flashModel = fixtureModel("policy-concise", "deepseek-v4-flash");
		authStorage.setRuntimeApiKey(defaultModel.provider, "key-a");
		authStorage.setRuntimeApiKey(astraModel.provider, "key-b");
		authStorage.setRuntimeApiKey(codexModel.provider, "key-c");
		authStorage.setRuntimeApiKey(grokModel.provider, "key-d");

		let rebuildCount = 0;
		session = newSession(
			defaultModel,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: [`policy:${rebuildCount}`] };
			},
		);

		await session.setModel(astraModel);
		expect(rebuildCount).toBe(1);
		await session.setModel(codexModel);
		expect(rebuildCount).toBe(2);
		await session.setModel(defaultModel);
		expect(rebuildCount).toBe(3);
		await session.setModel(grokModel);
		expect(rebuildCount).toBe(4);
		await session.setModel(flashModel);
		expect(rebuildCount).toBe(4);
		await session.setModel(defaultModel);
		expect(rebuildCount).toBe(5);
		await session.setModel(flashModel);
		expect(rebuildCount).toBe(6);
	});

	it("does not rebuild a hidden-model prompt for Astra aliases and vendor prefixes", async () => {
		const astra = fixtureModel("vendor-a", "gpt-6-astra");
		const alias = fixtureModel("vendor-a", "gpt-6");
		const prefixed = fixtureModel("kilo", "openai/gpt-6-astra");
		authStorage.setRuntimeApiKey("vendor-a", "key-a");
		authStorage.setRuntimeApiKey("kilo", "key-b");

		let rebuildCount = 0;
		session = newSession(
			astra,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["astra"] };
			},
		);

		await session.setModel(alias);
		expect(rebuildCount).toBe(0);
		await session.setModel(prefixed);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});
});
