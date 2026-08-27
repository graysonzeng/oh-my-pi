import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function requireBundledModel(provider: "google" | "openai", id: string) {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled ${provider}/${id} model to exist`);
	return model;
}

describe("consult tool lifecycle", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const primary = requireBundledModel("openai", "gpt-4o-mini");
	const advisor = requireBundledModel("google", "gemini-2.5-flash");

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-consult-lifecycle-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		authStorage.setRuntimeApiKey("google", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	function startupShortcuts() {
		return {
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			model: primary,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: {
				rootPath: registryDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
	}

	async function openSession(
		settings: Settings,
		options: {
			taskDepth?: number;
			parentTaskPrefix?: string;
			extensions?: ExtensionFactory[];
			toolNames?: string[];
		} = {},
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			...startupShortcuts(),
			settings,
			...options,
		});
		sessions.push(session);
		return session;
	}

	function seedConsultUsage(session: AgentSession): void {
		session.consultUsage.turn = 2;
		session.consultUsage.session = 5;
		session.consultUsage.last = { model: "google/gemini-2.5-flash", costUsd: 0.04, truncated: true };
	}

	it("rejects subagent runtime enable and override without registering consult", async () => {
		const session = await openSession(Settings.isolated({ "consult.enabled": true }), {
			taskDepth: 1,
			parentTaskPrefix: "ConsultSub",
		});

		expect(session.getAllToolNames()).not.toContain("consult");
		expect(session.getEnabledToolNames()).not.toContain("consult");
		expect(session.getActiveToolNames()).not.toContain("consult");

		expect(await session.setConsultToolEnabled(true)).toBe(false);
		expect(await session.setConsultModelOverride(`${advisor.provider}/${advisor.id}`)).toBe(false);

		expect(session.getConsultModelOverride()).toBeUndefined();
		expect(session.getAllToolNames()).not.toContain("consult");
		expect(session.getEnabledToolNames()).not.toContain("consult");
		expect(session.getActiveToolNames()).not.toContain("consult");
		expect(session.settings.get("consult.enabled")).toBe(true);
	});

	it("does not register consult on parentTaskPrefix clones at taskDepth 0", async () => {
		const session = await openSession(Settings.isolated({ "consult.enabled": true }), {
			parentTaskPrefix: "TanClone",
			toolNames: ["consult", "read"],
		});

		expect(session.getAllToolNames()).not.toContain("consult");
		expect(session.getEnabledToolNames()).not.toContain("consult");
		expect(session.getActiveToolNames()).not.toContain("consult");
		expect(await session.setConsultToolEnabled(true)).toBe(false);
		expect(session.getAllToolNames()).not.toContain("consult");
	});

	it("zeros shared consultUsage on successful newSession", async () => {
		const session = await openSession(
			Settings.isolated({
				"consult.enabled": true,
				"consult.model": `${advisor.provider}/${advisor.id}`,
			}),
		);
		const usage = session.consultUsage;
		seedConsultUsage(session);

		expect(await session.newSession()).toBe(true);
		expect(session.consultUsage).toBe(usage);
		expect(usage.turn).toBe(0);
		expect(usage.session).toBe(0);
		expect(usage.last).toBeUndefined();

		const state = await session.consultState();
		expect(state.turn).toBe(0);
		expect(state.session).toBe(0);
		expect(state.last).toBeUndefined();
	});

	it("preserves consultUsage when newSession is cancelled", async () => {
		const cancelNew: ExtensionFactory = pi => {
			pi.on("session_before_switch", event => {
				if (event.reason === "new") return { cancel: true };
			});
		};
		const session = await openSession(Settings.isolated({ "consult.enabled": true }), {
			extensions: [cancelNew],
		});
		const usage = session.consultUsage;
		seedConsultUsage(session);

		expect(await session.newSession()).toBe(false);
		expect(session.consultUsage).toBe(usage);
		expect(usage.turn).toBe(2);
		expect(usage.session).toBe(5);
		expect(usage.last).toEqual({
			model: "google/gemini-2.5-flash",
			costUsd: 0.04,
			truncated: true,
		});
	});

	it("reports consultState credentials only for ok or same_model", async () => {
		const session = await openSession(
			Settings.isolated({
				"consult.enabled": true,
				"consult.model": `${primary.provider}/${primary.id}`,
			}),
		);

		const sameModel = await session.consultState();
		expect(sameModel.error).toBe("same_model");
		expect(sameModel.credentials).toBe(true);
		expect(sameModel.sameModel).toBe(true);

		session.settings.override("consult.model", `${advisor.provider}/${advisor.id}`);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue(undefined);
		const missing = await session.consultState();
		expect(missing.error).toBe("no_credentials");
		expect(missing.credentials).toBe(false);

		vi.restoreAllMocks();
		vi.spyOn(modelRegistry, "getApiKey").mockRejectedValue(new Error("credential lookup failed"));
		const thrown = await session.consultState();
		expect(thrown.error).toBe("provider_error");
		expect(thrown.credentials).toBe(false);
		expect(thrown.sameModel).toBeUndefined();
	});
});
