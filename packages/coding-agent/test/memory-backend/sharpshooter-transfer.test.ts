import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sharpshooterMemoryFilePath } from "../../src/sharpshooter/paths";
import {
	applySharpshooterImport,
	exportSharpshooterMemory,
	previewSharpshooterImport,
	sharpshooterMemoryTransferCapabilities,
} from "../../src/memory-backend/sharpshooter-transfer";

describe("sharpshooter memory transfer (D4 second seam)", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function tempPair(): Promise<{ agentDir: string; cwd: string }> {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ss-agent-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ss-cwd-"));
		dirs.push(agentDir, cwd);
		return { agentDir, cwd };
	}

	it("traverses decision files and omits queue/state/lock from the export", async () => {
		const { agentDir, cwd } = await tempPair();
		const caps = sharpshooterMemoryTransferCapabilities();
		expect(caps.fullTraverse).toBe(true);
		expect(caps.entryDelete).toBe(false);

		await Bun.write(
			sharpshooterMemoryFilePath(agentDir, cwd, "architecture.md"),
			"# architecture\nprefer existing MemoryBackend seams\n",
		);
		await Bun.write(sharpshooterMemoryFilePath(agentDir, cwd, "product.md"), "# product\n");
		const queueDir = path.join(path.dirname(sharpshooterMemoryFilePath(agentDir, cwd, "architecture.md")), "queue");
		await fs.mkdir(queueDir, { recursive: true });
		await Bun.write(path.join(queueDir, "delta.json"), '{"should":"not export"}\n');

		const exported = await exportSharpshooterMemory({ agentDir, cwd });
		expect(exported.manifest.complete).toBe(true);
		expect(exported.manifest.omittedFields).toEqual(
			expect.arrayContaining(["queue/", "state.json", "consolidate.lock"]),
		);
		expect(exported.records.map(r => r.sourceId)).toEqual(
			expect.arrayContaining(["sharpshooter:architecture.md", "sharpshooter:product.md"]),
		);
		expect(exported.records.some(r => r.content.includes("should"))).toBe(false);
	});

	it("refuses apply without replaceSystemArtifacts and writes only allowed files when opted in", async () => {
		const src = await tempPair();
		await Bun.write(
			sharpshooterMemoryFilePath(src.agentDir, src.cwd, "style.md"),
			"# style\nkeep tabs as spaces in tool output\n",
		);
		const exported = await exportSharpshooterMemory({ agentDir: src.agentDir, cwd: src.cwd });
		const dest = await tempPair();
		const preview = previewSharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, exported);
		expect(preview.warnings.some(w => w.includes("scope mismatch"))).toBe(true);

		const refused = await applySharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, preview);
		expect(refused.conflicts.length).toBeGreaterThan(0);
		expect(refused.created).toEqual([]);
		expect(refused.message).toContain("replaceSystemArtifacts");

		const applied = await applySharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, preview, {
			replaceSystemArtifacts: true,
		});
		expect(applied.created).toContain("sharpshooter:style.md");
		const written = await Bun.file(sharpshooterMemoryFilePath(dest.agentDir, dest.cwd, "style.md")).text();
		expect(written).toContain("keep tabs as spaces in tool output");
	});
});
