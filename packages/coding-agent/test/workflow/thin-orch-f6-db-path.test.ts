/**
 * Batch 1 thin-orchestration — F6 default DB path under agent data dir.
 *
 * Failure modes: default must not be cwd/workflow.db; workspace identity recorded;
 * legacy cwd DBs are discoverable without silent move.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	defaultWorkflowDbPath,
	discoverLegacyWorkflowDbPaths,
	resolveWorkflowWorkspaceIdentity,
	WorkflowStore,
} from "../../src/workflow/sqlite-store";

describe("F6 default workflow DB path", () => {
	let tempAgentDir: string | undefined;
	let tempCwd: string | undefined;
	const stores: WorkflowStore[] = [];

	afterEach(async () => {
		for (const store of stores.splice(0)) store.close();
		if (tempAgentDir) await fs.rm(tempAgentDir, { recursive: true, force: true });
		if (tempCwd) await fs.rm(tempCwd, { recursive: true, force: true });
		tempAgentDir = undefined;
		tempCwd = undefined;
	});

	it("defaults under agent data directory — never process.cwd()/workflow.db", async () => {
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-agent-"));
		const expected = defaultWorkflowDbPath(tempAgentDir);
		expect(expected).toBe(path.join(tempAgentDir, "workflow.db"));
		expect(path.dirname(expected)).not.toBe(process.cwd());

		const store = new WorkflowStore({ agentDir: tempAgentDir });
		stores.push(store);
		expect(store.dbPath).toBe(expected);
		expect(await Bun.file(expected).exists()).toBe(true);
	});

	it("records explicit workspace identity in store meta", async () => {
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-agent-"));
		tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-cwd-"));
		const identity = resolveWorkflowWorkspaceIdentity(tempCwd);
		const store = new WorkflowStore({
			agentDir: tempAgentDir,
			workspaceIdentity: identity,
		});
		stores.push(store);
		expect(store.readWorkspaceIdentity()).toEqual(identity);
		expect(store.workspaceIdentity.cwd).toBe(path.resolve(tempCwd));
	});

	it("discovers legacy cwd workflow.db without moving it", async () => {
		tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-legacy-"));
		const legacyPath = path.join(tempCwd, "workflow.db");
		await Bun.write(legacyPath, "not-a-real-db-but-file-exists");
		const found = discoverLegacyWorkflowDbPaths(tempCwd);
		expect(found).toEqual([legacyPath]);
		// Still at the legacy location — no silent migrate.
		expect(await Bun.file(legacyPath).exists()).toBe(true);
	});

	it("explicit dbPath still wins over agent default", async () => {
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-agent-"));
		const explicit = path.join(tempAgentDir, "custom", "wf.db");
		const store = new WorkflowStore({ dbPath: explicit, agentDir: tempAgentDir });
		stores.push(store);
		expect(store.dbPath).toBe(explicit);
	});
});
