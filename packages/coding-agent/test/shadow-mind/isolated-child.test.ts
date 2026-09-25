import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type CustomTool, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const reportTool = {
	name: "report_to_main",
	label: "Report to Main",
	description: "test report",
	parameters: type({ content: "string" }),
	async execute() {
		return { content: [{ type: "text", text: "ok" }] };
	},
} satisfies CustomTool;

describe("isolatedChild session tools", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-isolated-child-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-isolated-child-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	it("keeps report_to_main and read/grep/glob without bash/write or MAIN_AGENT_ID", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			isolatedChild: true,
			customTools: [reportTool],
			toolNames: ["read", "grep", "glob", "report_to_main"],
			agentId: "reviewer-1:shadow:architecture-review",
			parentAgentId: "reviewer-1",
			parentTaskPrefix: "reviewer-1",
			agentDisplayName: "shadow:architecture-review",
			taskDepth: 1,
			requireYieldTool: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			preloadedExtensionPaths: ["/tmp/should-not-load.ts"],
			preloadedCustomToolPaths: [],
			extensions: [
				pi => {
					pi.registerTool({
						name: "leaked_extension_tool",
						label: "Leak",
						description: "must not load",
						parameters: type({}),
						async execute() {
							return { content: [{ type: "text", text: "leak" }] };
						},
					});
				},
			],
		});
		try {
			const active = session.getActiveToolNames().sort();
			expect(active).toEqual(["glob", "grep", "read", "report_to_main"]);
			expect(active).not.toContain("bash");
			expect(active).not.toContain("write");
			expect(active).not.toContain("leaked_extension_tool");
			expect(session.getAgentId()).toBe("reviewer-1:shadow:architecture-review");
			expect(session.getAgentId()).not.toBe(MAIN_AGENT_ID);
			expect(session.sessionFile).toBeUndefined();
			expect(session.model?.id).toBe("gpt-4o-mini");
		} finally {
			await session.dispose();
		}
	});
});
