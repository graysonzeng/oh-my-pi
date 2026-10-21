import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { offBackend } from "../../src/memory-backend/off-backend";
import {
	applyLocalMemoryImport,
	exportLocalMemory,
	localMemoryRoot,
	localMemoryTransferCapabilities,
	previewLocalMemoryImport,
} from "../../src/memory-backend/local-transfer";
import {
	applyMemoryPackageFile,
	exportMemoryPackage,
	parseMemoryImportApplyArgs,
	previewMemoryPackageFile,
} from "../../src/memory-backend/transfer-cli";
import type { MemoryBackend } from "../../src/memory-backend/types";

/** Lightweight local-shaped backend — avoids importing localBackend (natives graph). */
function localTransferBackend(): MemoryBackend {
	return {
		id: "local",
		start() {},
		async buildDeveloperInstructions() {
			return undefined;
		},
		async clear() {},
		async enqueue() {},
		transferCapabilities: localMemoryTransferCapabilities,
		exportRecords: exportLocalMemory,
		previewImport: previewLocalMemoryImport,
		applyImport: applyLocalMemoryImport,
	};
}

describe("memory transfer CLI helpers (D4)", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("refuses export/preview/apply on backends without a full traverse seam", async () => {
		const ctx = { agentDir: "/tmp/off-agent", cwd: "/tmp/off-cwd" };
		const exported = await exportMemoryPackage(offBackend, ctx);
		expect(exported.unsupported).toBe(true);
		expect(exported.text).toContain("unsupported");
		expect(exported.text).toContain("off");
		expect(exported.path).toBeUndefined();
		expect(await previewMemoryPackageFile(offBackend, ctx, "/tmp/missing.json")).toContain("unsupported");
		expect(await applyMemoryPackageFile(offBackend, ctx, "/tmp/missing.json")).toContain("unsupported");
	});

	it("exports a local package to disk and preview/apply round-trips without silent cross-scope write", async () => {
		const backend = localTransferBackend();
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-xfer-agent-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-xfer-cwd-"));
		const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-xfer-dest-"));
		dirs.push(agentDir, cwd, destDir);
		const root = localMemoryRoot(agentDir, cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "learned.md"), "- keep transfer CLI on MemoryBackend\n");

		const dest = path.join(destDir, "export.json");
		const exported = await exportMemoryPackage(backend, { agentDir, cwd }, dest);
		expect(exported.path).toBe(path.resolve(dest));
		expect(exported.text).toContain("Wrote");

		const emptyAgent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-xfer-empty-"));
		dirs.push(emptyAgent);
		const preview = await previewMemoryPackageFile(backend, { agentDir: emptyAgent, cwd }, dest);
		expect(preview).toContain("create=");
		expect(preview).toContain("requiresCrossScopeConfirm=false");

		const otherCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-xfer-other-"));
		dirs.push(otherCwd);
		const blocked = await applyMemoryPackageFile(backend, { agentDir: emptyAgent, cwd: otherCwd }, dest);
		expect(blocked).toContain("--confirm-cross-scope=");
		expect(blocked).toContain("Nothing was written");
		expect(blocked).toContain("confirmBinding=");

		const bare = await applyMemoryPackageFile(backend, { agentDir: emptyAgent, cwd: otherCwd }, dest, {
			confirmCrossScope: true,
		});
		expect(bare).toContain("Nothing was written");

		const applied = await applyMemoryPackageFile(backend, { agentDir: emptyAgent, cwd }, dest);
		expect(applied).toContain("created=");
		expect(applied).not.toContain("Nothing was written");
	});

	it("parses import-apply flags including confirm binding tokens", () => {
		const parsed = parseMemoryImportApplyArgs(["--confirm-cross-scope=abc123", "/tmp/pkg.json", "--replace-system"]);
		expect(parsed.filePath).toBe("/tmp/pkg.json");
		expect(parsed.confirmCrossScope).toBe(true);
		expect(parsed.confirmBinding).toBe("abc123");
		expect(parsed.replaceSystemArtifacts).toBe(true);
		expect(parseMemoryImportApplyArgs(["--replace-system"]).filePath).toBeUndefined();
		expect(parseMemoryImportApplyArgs(["--confirm-cross-scope"]).confirmBinding).toBeUndefined();
	});
});
