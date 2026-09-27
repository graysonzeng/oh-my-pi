import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { sharpshooterLockPath, sharpshooterMemoryFilePath } from "../../src/sharpshooter/paths";
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
		expect(exported.manifest.complete).toBe(false);
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
		const preview = await previewSharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, exported);
		expect(preview.requiresCrossScopeConfirm).toBe(true);

		const refused = await applySharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, preview, {
			confirmBinding: preview.confirmBinding,
			pkg: exported,
		});
		expect(refused.conflicts.length).toBeGreaterThan(0);
		expect(refused.created).toEqual([]);
		expect(refused.message).toContain("replaceSystemArtifacts");

		const applied = await applySharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, preview, {
			replaceSystemArtifacts: true,
			confirmBinding: preview.confirmBinding,
			pkg: exported,
		});
		expect(applied.created).toContain("sharpshooter:style.md");
		expect(applied.errors).toEqual([]);
		const written = await Bun.file(sharpshooterMemoryFilePath(dest.agentDir, dest.cwd, "style.md")).text();
		expect(written).toContain("keep tabs as spaces in tool output");
	});

	it("keeps inspectable writtenIds when a later item fails mid-batch", async () => {
		const src = await tempPair();
		await Bun.write(sharpshooterMemoryFilePath(src.agentDir, src.cwd, "architecture.md"), "# a\n");
		await Bun.write(sharpshooterMemoryFilePath(src.agentDir, src.cwd, "product.md"), "# p\n");
		const good = await exportSharpshooterMemory({ agentDir: src.agentDir, cwd: src.cwd });
		const dest = await tempPair();
		const preview = await previewSharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, good);
		expect(preview.blockingIssues).toEqual([]);

		const originalWrite = Bun.write.bind(Bun);
		let writes = 0;
		const spy = (...args: Parameters<typeof Bun.write>) => {
			writes += 1;
			if (writes === 2) return Promise.reject(new Error("forced mid-batch failure"));
			return originalWrite(...args);
		};
		(Bun as { write: typeof Bun.write }).write = spy as typeof Bun.write;
		try {
			const applied = await applySharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, preview, {
				replaceSystemArtifacts: true,
				confirmBinding: preview.confirmBinding,
				pkg: good,
			});
			expect(applied.writtenIds!.length).toBeGreaterThan(0);
			expect(applied.errors.length).toBeGreaterThan(0);
			expect(applied.partial).toBe(true);
		} finally {
			(Bun as { write: typeof Bun.write }).write = originalWrite;
		}
	});

	it("refuses apply while the consolidation lock is held (same lock as owner)", async () => {
		const src = await tempPair();
		await Bun.write(sharpshooterMemoryFilePath(src.agentDir, src.cwd, "style.md"), "# style\n");
		const exported = await exportSharpshooterMemory({ agentDir: src.agentDir, cwd: src.cwd });
		const dest = await tempPair();
		const preview = await previewSharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, exported);

		await withFileLock(
			sharpshooterLockPath(dest.agentDir, dest.cwd),
			async () => {
				const applied = await applySharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, preview, {
					replaceSystemArtifacts: true,
					confirmBinding: preview.confirmBinding,
					pkg: exported,
				});
				expect(applied.created).toEqual([]);
				expect(applied.errors.some(e => e.error.includes("consolidate_lock"))).toBe(true);
				expect(await Bun.file(sharpshooterMemoryFilePath(dest.agentDir, dest.cwd, "style.md")).exists()).toBe(
					false,
				);
			},
			{ retries: 1, retryDelayMs: 1 },
		);
	});

	it("refuses mutated preview bodies even when pkg validates", async () => {
		const src = await tempPair();
		await Bun.write(sharpshooterMemoryFilePath(src.agentDir, src.cwd, "style.md"), "# style\nhonest\n");
		const exported = await exportSharpshooterMemory({ agentDir: src.agentDir, cwd: src.cwd });
		const dest = await tempPair();
		const preview = await previewSharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, exported);
		preview.items[0]!.record = { ...preview.items[0]!.record, content: "mutated body" };
		const applied = await applySharpshooterImport({ agentDir: dest.agentDir, cwd: dest.cwd }, preview, {
			replaceSystemArtifacts: true,
			confirmBinding: preview.confirmBinding,
			pkg: exported,
		});
		expect(applied.created).toEqual([]);
		expect(applied.errors.some(e => e.error.includes("preview_package_mismatch"))).toBe(true);
	});

	it("conflicts foreign record.scope when manifest.scope matches target", async () => {
		const target = await tempPair();
		await Bun.write(sharpshooterMemoryFilePath(target.agentDir, target.cwd, "style.md"), "# style\n");
		const exported = await exportSharpshooterMemory({ agentDir: target.agentDir, cwd: target.cwd });
		const forged = structuredClone(exported);
		forged.records = forged.records.map(r => ({ ...r, scope: "/other" }));
		const preview = await previewSharpshooterImport({ agentDir: target.agentDir, cwd: target.cwd }, forged);
		const applied = await applySharpshooterImport({ agentDir: target.agentDir, cwd: target.cwd }, preview, {
			replaceSystemArtifacts: true,
			pkg: forged,
		});
		expect(applied.created).toEqual([]);
	});
});
