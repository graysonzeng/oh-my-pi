/**
 * Contract: optimized (catalog) presentation must not strip `yield` from the
 * implementer tool registry. Live hang root-cause: SCOPED allowlist omitted
 * yield → transformTools filtered it out → "Tool yield not found".
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { createAgentSession, discoverAuthStorage } from "../../src/sdk";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SCOPED_IMPLEMENTATION_TOOLS, SCOPED_REPAIR_TOOLS } from "../../src/workflow/tool-policy";

describe("implement/repair scoped tools retain yield under catalog filter", () => {
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;
	let authDir: string;
	const tempDirs: string[] = [];

	beforeAll(async () => {
		authDir = path.join(os.tmpdir(), `yield-catalog-auth-${Snowflake.next()}`);
		fs.mkdirSync(authDir, { recursive: true });
		authStorage = await discoverAuthStorage(authDir);
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		for (const d of tempDirs) {
			try {
				fs.rmSync(d, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
		try {
			fs.rmSync(authDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("SCOPED_IMPLEMENTATION_TOOLS and SCOPED_REPAIR_TOOLS include yield", () => {
		expect(SCOPED_IMPLEMENTATION_TOOLS).toContain("yield");
		expect(SCOPED_REPAIR_TOOLS).toContain("yield");
	});

	it("createAgentSession keeps yield active when transformTools filters by scoped allowlist", async () => {
		const tempDir = path.join(os.tmpdir(), `yield-catalog-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		const allow = new Set<string>(SCOPED_IMPLEMENTATION_TOOLS);
		const { session } = await createAgentSession({
			cwd: tempDir,
			authStorage,
			modelRegistry,
			requireYieldTool: true,
			restrictToolNames: true,
			toolNames: [...SCOPED_IMPLEMENTATION_TOOLS],
			hasUI: false,
			rules: [],
			contextFiles: [],
			skills: [],
			outputSchema: {
				type: "object",
				properties: { kind: { type: "string" } },
				required: ["kind"],
			},
			outputSchemaMode: "strict",
			// Mimic optimized catalog allowlist filtering (runtime-invocation transformTools).
			workflowToolOptimization: {
				processResult: (_toolName, output) => output,
				transformTools: tools => tools.filter(t => allow.has(t.name)),
			},
		});
		try {
			const active = session.getActiveToolNames();
			expect(active).toContain("yield");
			expect(active).toContain("edit");
			expect(active).toContain("write");
		} finally {
			await session.dispose();
		}
	});
});
