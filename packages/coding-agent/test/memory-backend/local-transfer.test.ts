import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyLocalMemoryImport,
	exportLocalMemory,
	localMemoryRoot,
	localMemoryTransferCapabilities,
	previewLocalMemoryImport,
} from "../../src/memory-backend/local-transfer";

describe("local memory transfer (D4)", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function tempPair(): Promise<{ agentDir: string; cwd: string }> {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem-agent-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem-cwd-"));
		dirs.push(agentDir, cwd);
		return { agentDir, cwd };
	}

	it("exports learned lessons and round-trips via preview + apply without duplicating on replay", async () => {
		const { agentDir, cwd } = await tempPair();
		const caps = localMemoryTransferCapabilities();
		expect(caps.export).toBe(true);
		expect(caps.entryDelete).toBe(false);
		expect(caps.fullTraverse).toBe(true);

		const root = localMemoryRoot(agentDir, cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "learned.md"), "- prefer bun tests over tsc\n");

		const exported = await exportLocalMemory({ agentDir, cwd });
		expect(exported.manifest.complete).toBe(true);
		expect(exported.manifest.omittedCapabilities).toContain("structuredSearch");
		expect(exported.records.some(r => r.kind === "learning_candidate")).toBe(true);

		const emptyAgent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem-agent-"));
		dirs.push(emptyAgent);
		// Same cwd/scope — cross-project requires confirm and stays conflict.
		const preview = previewLocalMemoryImport({ agentDir: emptyAgent, cwd }, exported);
		expect(preview.items.every(i => i.action === "create")).toBe(true);
		expect(preview.warnings.every(w => !w.includes("scope mismatch"))).toBe(true);

		const first = await applyLocalMemoryImport({ agentDir: emptyAgent, cwd }, preview);
		expect(first.created.length).toBeGreaterThan(0);

		const second = await applyLocalMemoryImport({ agentDir: emptyAgent, cwd }, preview);
		expect(second.skipped.length).toBeGreaterThan(0);
		expect(second.created.length).toBe(0);
	});

	it("reports scope conflict instead of silent cross-project merge", async () => {
		const src = await tempPair();
		const root = localMemoryRoot(src.agentDir, src.cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "learned.md"), "- project-specific fact\n");
		const exported = await exportLocalMemory({ agentDir: src.agentDir, cwd: src.cwd });
		const other = await tempPair();
		const preview = previewLocalMemoryImport({ agentDir: other.agentDir, cwd: other.cwd }, exported);
		expect(preview.warnings.some(w => w.includes("scope mismatch"))).toBe(true);
	});

	it("declares fullTraverse separately from search (search is not a full export)", () => {
		const caps = localMemoryTransferCapabilities();
		expect(caps.fullTraverse).toBe(true);
		expect(caps.entryDelete).toBe(false);
		expect(caps.export).toBe(true);
	});
});
