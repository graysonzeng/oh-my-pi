import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parametersToJsonSchema } from "@oh-my-pi/pi-coding-agent/tools/workflow-alias-wrap";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function isOpenCatalogStub(parameters: unknown): boolean {
	const schema = parametersToJsonSchema(parameters);
	if (!schema) return false;
	return schema.additionalProperties === true && Object.keys(schema.properties ?? {}).length === 0;
}

/**
 * Regression: createTools registered original tools then transformed only the
 * return array. SDK discards that return and assembles Agent.tools from
 * toolRegistry, so catalog stubs/locators never reached the live session and
 * allowlist-dropped tools could still execute.
 */
describe("createAgentSession catalog transform registry", () => {
	let registryDir: string;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-workflow-transform-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryDir));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	it("serves catalog stubs from the live SDK tool set and does not revive allowlist drops on refresh", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.xdev": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
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
			restrictToolNames: true,
			toolNames: ["read", "edit", "bash"],
			workflowToolOptimization: {
				processResult: (_name, output) => output,
				transformTools: tools =>
					tools
						.filter(t => t.name === "read" || t.name === "edit")
						.map(t => (t.name === "read" ? t : { ...t, schema: undefined }))
						.sort((a, b) => a.name.localeCompare(b.name)),
			},
		});
		sessions.push(session);

		const active = session.getActiveToolNames();
		expect(active).toContain("read");
		expect(active).toContain("edit");
		expect(active).not.toContain("bash");
		expect(session.getAllToolNames()).not.toContain("bash");
		expect(session.getToolByName("bash")).toBeUndefined();
		expect(session.getToolByName("write")).toBeUndefined();

		const edit = session.getToolByName("edit");
		if (!edit) throw new Error("expected edit in the live SDK registry");
		expect(isOpenCatalogStub(edit.parameters)).toBe(true);
		expect(String(edit.description)).toContain("xd://tools/edit");
		expect("schemaLocator" in edit && typeof edit.schemaLocator === "string" ? edit.schemaLocator : undefined).toBe(
			"xd://tools/edit",
		);
		expect(
			validateToolArguments(edit, {
				type: "toolCall",
				id: "edit-sdk-1",
				name: "edit",
				arguments: { path: "a.ts", oldText: "x", newText: "y" },
			}),
		).toEqual({ path: "a.ts", oldText: "x", newText: "y" });

		const read = session.getToolByName("read");
		if (!read) throw new Error("expected read in the live SDK registry");
		expect(isOpenCatalogStub(read.parameters)).toBe(false);
		const readSchema = parametersToJsonSchema(read.parameters);
		expect(readSchema?.properties).toHaveProperty("path");
		expect(() =>
			validateToolArguments(read, {
				type: "toolCall",
				id: "read-sdk-1",
				name: "read",
				arguments: {},
			}),
		).toThrow();

		await session.setActiveToolsByName(["read", "edit", "bash"]);
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getToolByName("bash")).toBeUndefined();
		const editAfterRefresh = session.getToolByName("edit");
		if (!editAfterRefresh) throw new Error("expected edit to survive late refresh");
		expect(isOpenCatalogStub(editAfterRefresh.parameters)).toBe(true);
		expect(String(editAfterRefresh.description)).toContain("xd://tools/edit");
	});
});
