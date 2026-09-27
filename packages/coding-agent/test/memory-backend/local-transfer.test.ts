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
import { MEMORY_EXPORT_FORMAT_VERSION } from "../../src/memory-backend/transfer-types";
import { checksumPackageRecords, fingerprintRecordContent } from "../../src/memory-backend/transfer-integrity";
import { MAX_LEARNED_CONTENT_CHARS } from "../../src/memories/learned";

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
		const preview = await previewLocalMemoryImport({ agentDir: emptyAgent, cwd }, exported);
		expect(preview.items.every(i => i.action === "create")).toBe(true);
		expect(preview.requiresCrossScopeConfirm).toBe(false);
		expect(preview.blockingIssues).toEqual([]);

		const first = await applyLocalMemoryImport({ agentDir: emptyAgent, cwd }, preview, { pkg: exported });
		expect(first.created.length).toBeGreaterThan(0);
		expect(first.errors).toEqual([]);

		const secondPreview = await previewLocalMemoryImport({ agentDir: emptyAgent, cwd }, exported);
		expect(secondPreview.items.every(i => i.action === "skip")).toBe(true);
		const second = await applyLocalMemoryImport({ agentDir: emptyAgent, cwd }, secondPreview, { pkg: exported });
		expect(second.skipped.length).toBeGreaterThan(0);
		expect(second.created.length).toBe(0);
	});

	it("conflicts every foreign record.scope even when manifest.scope matches target", async () => {
		const target = await tempPair();
		const root = localMemoryRoot(target.agentDir, target.cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "learned.md"), "- keep scope honest\n");
		const exported = await exportLocalMemory({ agentDir: target.agentDir, cwd: target.cwd });
		expect(exported.records.length).toBeGreaterThan(0);
		// Tamper: keep manifest.scope as target, but make record.scope foreign.
		const forged = {
			...exported,
			records: exported.records.map(r => ({ ...r, scope: "/foreign/project" })),
		};
		// Recompute fingerprints/checksum for structural validity so the defect
		// is specifically the AND scope gate, not checksum refusal.
		forged.records = forged.records.map(r => ({
			...r,
			contentFingerprint: fingerprintRecordContent({
				kind: r.kind,
				content: r.content,
				scope: r.scope,
				sourceId: r.sourceId,
			}),
		}));
		forged.manifest = {
			...forged.manifest,
			contentChecksum: checksumPackageRecords(forged.records),
			recordCount: forged.records.length,
		};

		const preview = await previewLocalMemoryImport({ agentDir: target.agentDir, cwd: target.cwd }, forged);
		expect(preview.items.length).toBeGreaterThan(0);
		expect(preview.items.every(i => i.action === "conflict")).toBe(true);
		expect(preview.items.every(i => i.reason === "record_scope_conflict")).toBe(true);
		// Manifest still claims the target scope — this is smuggling, not cross-project.
		expect(preview.requiresCrossScopeConfirm).toBe(false);

		const applied = await applyLocalMemoryImport({ agentDir: target.agentDir, cwd: target.cwd }, preview, {
			pkg: forged,
			confirmBinding: preview.confirmBinding,
		});
		expect(applied.created).toEqual([]);
		expect(applied.conflicts.length).toBe(forged.records.length);
	});

	it("rejects body tampering that keeps a stale in-package fingerprint/checksum story", async () => {
		const src = await tempPair();
		const root = localMemoryRoot(src.agentDir, src.cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "learned.md"), "- honest lesson\n");
		const exported = await exportLocalMemory({ agentDir: src.agentDir, cwd: src.cwd });
		const tampered = structuredClone(exported);
		tampered.records[0]!.content = "tampered body with secret_aB3dEfGh1JkLmN";
		// Attacker leaves old fingerprint + checksum — must be caught.
		const dest = await tempPair();
		const preview = await previewLocalMemoryImport({ agentDir: dest.agentDir, cwd: dest.cwd }, tampered);
		expect(preview.blockingIssues.some(i => i.includes("fingerprint_mismatch") || i.includes("checksum"))).toBe(true);
		const applied = await applyLocalMemoryImport({ agentDir: dest.agentDir, cwd: dest.cwd }, preview, {
			pkg: tampered,
		});
		expect(applied.created).toEqual([]);
		expect(applied.message).toContain("integrity");
	});

	it("rejects unknown format versions at the apply boundary (not warn-and-apply)", async () => {
		const src = await tempPair();
		const root = localMemoryRoot(src.agentDir, src.cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "learned.md"), "- v-check\n");
		const exported = await exportLocalMemory({ agentDir: src.agentDir, cwd: src.cwd });
		const bad = structuredClone(exported);
		(bad.manifest as { formatVersion: number }).formatVersion = MEMORY_EXPORT_FORMAT_VERSION + 99;
		const dest = await tempPair();
		const preview = await previewLocalMemoryImport({ agentDir: dest.agentDir, cwd: dest.cwd }, bad);
		expect(preview.blockingIssues.some(i => i.includes("unsupported_format_version"))).toBe(true);
		const applied = await applyLocalMemoryImport({ agentDir: dest.agentDir, cwd: dest.cwd }, preview, { pkg: bad });
		expect(applied.created).toEqual([]);
	});

	it("exports by lesson bullet boundaries without silently dropping a trailing lesson", async () => {
		const { agentDir, cwd } = await tempPair();
		const root = localMemoryRoot(agentDir, cwd);
		await fs.mkdir(root, { recursive: true });
		const lessonA = "a".repeat(MAX_LEARNED_CONTENT_CHARS);
		const lessonB = "keep the trailing lesson intact";
		await Bun.write(path.join(root, "learned.md"), `- ${lessonA}\n- ${lessonB}\n`);
		const exported = await exportLocalMemory({ agentDir, cwd });
		expect(exported.records).toHaveLength(2);
		expect(exported.records[1]!.content).toBe(lessonB);
		expect(exported.records.every(r => r.content.includes("ghp_") === false)).toBe(true);

		const destAgent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem-agent-"));
		dirs.push(destAgent);
		// Same cwd/scope — cross-project requires confirm; lesson-boundary test stays same-scope.
		const preview = await previewLocalMemoryImport({ agentDir: destAgent, cwd }, exported);
		const applied = await applyLocalMemoryImport({ agentDir: destAgent, cwd }, preview, {
			pkg: exported,
		});
		expect(applied.partial).toBe(false);
		expect(applied.created).toHaveLength(2);
		const text = await Bun.file(path.join(localMemoryRoot(destAgent, cwd), "learned.md")).text();
		expect(text).toContain(lessonB);
		expect(text).toContain(lessonA.slice(0, 40));
	});

	it("redacts secrets before fingerprinting on export", async () => {
		const { agentDir, cwd } = await tempPair();
		const root = localMemoryRoot(agentDir, cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "learned.md"), "- token ghp_abcdefghijklmnopqrstuvwxyz012345\n");
		const exported = await exportLocalMemory({ agentDir, cwd });
		expect(exported.records[0]!.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
		expect(exported.records[0]!.contentFingerprint).toBe(
			fingerprintRecordContent({
				kind: exported.records[0]!.kind,
				content: exported.records[0]!.content,
				scope: exported.records[0]!.scope,
				sourceId: exported.records[0]!.sourceId,
			}),
		);
	});

	it("requires confirm binding that matches source/target/preview — bare flag is not enough", async () => {
		const src = await tempPair();
		const root = localMemoryRoot(src.agentDir, src.cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "learned.md"), "- project-specific fact\n");
		const exported = await exportLocalMemory({ agentDir: src.agentDir, cwd: src.cwd });
		const other = await tempPair();
		const preview = await previewLocalMemoryImport({ agentDir: other.agentDir, cwd: other.cwd }, exported);
		expect(preview.requiresCrossScopeConfirm).toBe(true);
		expect(preview.confirmBinding).toBeTruthy();

		const refused = await applyLocalMemoryImport({ agentDir: other.agentDir, cwd: other.cwd }, preview, {
			pkg: exported,
		});
		expect(refused.created).toEqual([]);
		expect(refused.errors.some(e => e.error.includes("confirm_binding"))).toBe(true);

		const wrong = await applyLocalMemoryImport({ agentDir: other.agentDir, cwd: other.cwd }, preview, {
			pkg: exported,
			confirmBinding: "not-the-preview-token",
		});
		expect(wrong.created).toEqual([]);

		const ok = await applyLocalMemoryImport({ agentDir: other.agentDir, cwd: other.cwd }, preview, {
			pkg: exported,
			confirmBinding: preview.confirmBinding,
		});
		expect(ok.created.length).toBeGreaterThan(0);
	});

	it("reports scope conflict instead of silent cross-project merge", async () => {
		const src = await tempPair();
		const root = localMemoryRoot(src.agentDir, src.cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "learned.md"), "- project-specific fact\n");
		const exported = await exportLocalMemory({ agentDir: src.agentDir, cwd: src.cwd });
		const other = await tempPair();
		const preview = await previewLocalMemoryImport({ agentDir: other.agentDir, cwd: other.cwd }, exported);
		expect(preview.requiresCrossScopeConfirm).toBe(true);
		expect(preview.items.every(i => i.action === "create")).toBe(true);
		const refused = await applyLocalMemoryImport({ agentDir: other.agentDir, cwd: other.cwd }, preview, {
			pkg: exported,
		});
		expect(refused.created).toEqual([]);
	});

	it("keeps learning candidates out of formal system activation without replaceSystemArtifacts", async () => {
		const src = await tempPair();
		const root = localMemoryRoot(src.agentDir, src.cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "MEMORY.md"), "formal project fact\n");
		const exported = await exportLocalMemory({ agentDir: src.agentDir, cwd: src.cwd });
		expect(exported.records.some(r => r.kind === "project_fact" && r.trust === "system")).toBe(true);
		const dest = await tempPair();
		const preview = await previewLocalMemoryImport({ agentDir: dest.agentDir, cwd: dest.cwd }, exported);
		const systemItem = preview.items.find(i => i.record.kind === "project_fact");
		expect(systemItem?.action).toBe("create");
		const refused = await applyLocalMemoryImport({ agentDir: dest.agentDir, cwd: dest.cwd }, preview, {
			pkg: exported,
		});
		expect(systemItem?.record.sourceId).toBeTruthy();
		expect(refused.conflicts).toContain(systemItem!.record.sourceId!);
		expect(await pathExists(path.join(localMemoryRoot(dest.agentDir, dest.cwd), "MEMORY.md"))).toBe(false);
	});

	it("declares fullTraverse separately from search (search is not a full export)", () => {
		const caps = localMemoryTransferCapabilities();
		expect(caps.fullTraverse).toBe(true);
		expect(caps.entryDelete).toBe(false);
		expect(caps.export).toBe(true);
	});
});

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
