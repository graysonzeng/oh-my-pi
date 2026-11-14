/**
 * Contract tests for explicit MCP `lazy: true`:
 * - startup never opens a transport
 * - cached tools mount as DeferredMCPTool
 * - first execute opens a single shared connection and completes the call
 * - no cache → no fake tools; config retained for status/reconnect
 * - tool-cache hash ignores `lazy` so toggling it does not invalidate
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../src/mcp/manager";
import { DeferredMCPTool } from "../src/mcp/tool-bridge";
import { MCPToolCache } from "../src/mcp/tool-cache";
import type { MCPServerConfig, MCPStdioServerConfig, MCPToolDefinition } from "../src/mcp/types";
import { TOOL_NAME, TOOL_RESULT } from "./fixtures/instructions-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");
const HANG_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "hang-during-init-mcp.ts");
const BUN_EXEC = process.execPath;

const CACHED_TOOLS: MCPToolDefinition[] = [
	{
		name: TOOL_NAME,
		description: "Fixture tool returning a deterministic sentinel.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
];

function lazyStdioConfig(): MCPStdioServerConfig {
	return {
		type: "stdio",
		command: BUN_EXEC,
		args: [FIXTURE_PATH],
		lazy: true,
	};
}

/** Minimal AgentStorage stand-in for MCPToolCache unit tests. */
function makeMemoryStorage(): {
	getCache: (key: string) => string | null;
	setCache: (key: string, value: string, expiresAtSec: number) => void;
} {
	const map = new Map<string, string>();
	return {
		getCache: key => map.get(key) ?? null,
		setCache: (key, value) => {
			map.set(key, value);
		},
	};
}

describe("MCP lazy: true", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lazy-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(workDir);
	});

	it("does not connect at startup and keeps config for status without fabricating tools", async () => {
		const manager = new MCPManager(workDir);
		const config = lazyStdioConfig();
		const source = {
			provider: "builtin",
			providerName: "OMP",
			path: path.join(workDir, "mcp.json"),
			level: "project" as const,
		};

		try {
			const result = await manager.connectServers({ lazySrv: config }, { lazySrv: source });

			expect(result.tools).toEqual([]);
			expect(result.connectedServers).toEqual([]);
			expect(result.errors.size).toBe(0);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getConnectionStatus("lazySrv")).toBe("disconnected");
			expect(manager.getServerConfig("lazySrv")).toEqual(config);
			expect(manager.getSource("lazySrv")).toEqual(source);
			expect(manager.getAllServerNames()).toContain("lazySrv");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("mounts cached tools as DeferredMCPTool without opening a transport", async () => {
		const storage = makeMemoryStorage();
		const toolCache = new MCPToolCache(storage as never);
		const config = lazyStdioConfig();
		await toolCache.set("lazySrv", config, CACHED_TOOLS);

		const manager = new MCPManager(workDir, toolCache);
		try {
			const result = await manager.connectServers({ lazySrv: config }, {});

			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getConnectionStatus("lazySrv")).toBe("disconnected");
			expect(result.tools).toHaveLength(1);
			expect(result.tools[0]).toBeInstanceOf(DeferredMCPTool);
			expect(result.tools[0]!.mcpServerName).toBe("lazySrv");
			expect(result.tools[0]!.mcpToolName).toBe(TOOL_NAME);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("connects once on first deferred execute and completes the tool call", async () => {
		const storage = makeMemoryStorage();
		const toolCache = new MCPToolCache(storage as never);
		const config = lazyStdioConfig();
		await toolCache.set("lazySrv", config, CACHED_TOOLS);

		const manager = new MCPManager(workDir, toolCache);
		try {
			const result = await manager.connectServers({ lazySrv: config }, {});
			const tool = result.tools[0];
			expect(tool).toBeInstanceOf(DeferredMCPTool);
			expect(manager.getConnectedServers()).toEqual([]);

			const execResult = await tool!.execute(
				"call-1",
				{},
				undefined,
				{} as Parameters<DeferredMCPTool["execute"]>[3],
			);

			expect(manager.getConnectedServers()).toContain("lazySrv");
			expect(manager.getConnectionStatus("lazySrv")).toBe("connected");
			expect(execResult.content.some(block => "text" in block && block.text.includes(TOOL_RESULT))).toBe(true);

			// Concurrent ensure shares the live connection
			const again = await manager.ensureConnected("lazySrv");
			expect(again.name).toBe("lazySrv");
			expect(manager.getConnectedServers().filter(n => n === "lazySrv")).toHaveLength(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 20_000);

	it("stops a lazy first-connect retry loop when the server is disconnected", async () => {
		const spawnLog = path.join(workDir, "spawn.log");
		const storage = makeMemoryStorage();
		const toolCache = new MCPToolCache(storage as never);
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [HANG_FIXTURE_PATH],
			env: { OMP_TEST_SPAWN_LOG: spawnLog },
			timeout: 100,
			lazy: true,
		};
		await toolCache.set("lazySrv", config, CACHED_TOOLS);

		const retrySleepStarted = Promise.withResolvers<void>();
		const releaseRetrySleep = Promise.withResolvers<void>();
		vi.spyOn(Bun, "sleep").mockImplementation(async () => {
			retrySleepStarted.resolve();
			await releaseRetrySleep.promise;
		});

		const manager = new MCPManager(workDir, toolCache);
		try {
			await manager.connectServers({ lazySrv: config }, {});
			const connectionAttempt = manager.ensureConnected("lazySrv").catch(() => null);
			await retrySleepStarted.promise;
			expect(fs.existsSync(spawnLog)).toBe(true);

			await manager.disconnectServer("lazySrv");
			releaseRetrySleep.resolve();
			await connectionAttempt;

			const spawns = fs.readFileSync(spawnLog, "utf8").trim().split("\n");
			expect(spawns).toHaveLength(1);
			expect(manager.getAllServerNames()).not.toContain("lazySrv");
		} finally {
			releaseRetrySleep.resolve();
			await manager.disconnectAll();
		}
	}, 5_000);

	it.skipIf(process.platform === "win32")(
		"rejects an old lazy connection that completes after the server is replaced",
		async () => {
			const spawnLog = path.join(workDir, "replace-spawn.log");
			const storage = makeMemoryStorage();
			const toolCache = new MCPToolCache(storage as never);
			const oldConfig: MCPStdioServerConfig = {
				type: "stdio",
				command: BUN_EXEC,
				args: [HANG_FIXTURE_PATH],
				env: {
					OMP_TEST_SPAWN_LOG: spawnLog,
					OMP_TEST_RELEASE_ON_SIGNAL: "1",
				},
				timeout: 5_000,
				lazy: true,
			};
			const newConfig = lazyStdioConfig();
			await toolCache.set("lazySrv", oldConfig, CACHED_TOOLS);

			const spawnObserved = Promise.withResolvers<void>();
			const watcher = fs.watch(workDir, (_event, filename) => {
				if (filename === path.basename(spawnLog)) spawnObserved.resolve();
			});
			const manager = new MCPManager(workDir, toolCache);
			try {
				await manager.connectServers({ lazySrv: oldConfig }, {});
				const oldAttempt = manager.ensureConnected("lazySrv").catch(() => null);
				await spawnObserved.promise;
				const oldPid = Number.parseInt(fs.readFileSync(spawnLog, "utf8").trim(), 10);
				expect(Number.isInteger(oldPid)).toBe(true);

				await manager.disconnectServer("lazySrv");
				await manager.connectServers({ lazySrv: newConfig }, {});
				process.kill(oldPid, "SIGUSR1");
				expect(await oldAttempt).toBeNull();

				expect(manager.getServerConfig("lazySrv")).toBe(newConfig);
				expect(manager.getConnectedServers()).not.toContain("lazySrv");
			} finally {
				watcher.close();
				await manager.disconnectAll();
			}
		},
		10_000,
	);

	it("ignores lazy when hashing tool-cache identity for the same endpoint", async () => {
		const storage = makeMemoryStorage();
		const toolCache = new MCPToolCache(storage as never);
		const base: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};
		const withLazy: MCPServerConfig = { ...base, lazy: true };

		await toolCache.set("srv", base, CACHED_TOOLS);
		const hitEager = await toolCache.get("srv", base);
		const hitLazy = await toolCache.get("srv", withLazy);

		expect(hitEager).toEqual(CACHED_TOOLS);
		expect(hitLazy).toEqual(CACHED_TOOLS);

		// Write under lazy and read under non-lazy — same identity
		await toolCache.set("srv2", withLazy, CACHED_TOOLS);
		expect(await toolCache.get("srv2", base)).toEqual(CACHED_TOOLS);
	});
});
