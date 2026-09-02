import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { mnemopiEmbedClient } from "../../src/mnemopi/embed-client";
import {
	__resetCodeIntelIndexesForTests,
	codeIntelContentHash,
	codeIntelProjectKey,
	getCodeIntelIndex,
} from "../../src/tools/code-intel-index";
import * as codeIntelNatives from "../../src/tools/code-intel-natives";
import { hasCodeIntelNatives } from "../../src/tools/code-intel-natives";

let indexHome: string | undefined;

beforeEach(async () => {
	indexHome = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-home-"));
	vi.spyOn(piUtils, "getCodeIntelDir").mockReturnValue(path.join(indexHome, "code-intel"));
});

afterEach(async () => {
	await __resetCodeIntelIndexesForTests();
	vi.restoreAllMocks();
	if (indexHome) await piUtils.removeWithRetries(indexHome);
	indexHome = undefined;
});

async function writeFakeGeneration(
	destDir: string,
	files: Array<{ path: string; content_hash: string }>,
): Promise<{ filesScanned: number; tagCount: number; chunkCount: number; parseErrors: string[] }> {
	await fs.mkdir(destDir, { recursive: true });
	await Bun.write(
		path.join(destDir, "files.jsonl"),
		`${files
			.map(file =>
				JSON.stringify({
					path: file.path,
					mtime_ms: 0,
					size: 0,
					content_hash: file.content_hash,
					tag_count: 1,
					chunk_ids: [0],
				}),
			)
			.join("\n")}\n`,
	);
	await Bun.write(
		path.join(destDir, "manifest.json"),
		JSON.stringify({
			version: 1,
			root: destDir,
			git_head: null,
			embedding_model: null,
			dim: 0,
			file_count: files.length,
			tag_count: 1,
			chunk_count: 0,
			tags_hash: "",
			chunks_hash: "",
			embeddings_rows: 0,
			embeddings_dim: 0,
			graph_hash: "",
		}),
	);
	return { filesScanned: files.length, tagCount: 1, chunkCount: 0, parseErrors: [] };
}

describe("code_intel generation snapshot", () => {
	it.skipIf(!hasCodeIntelNatives())(
		"publishes CURRENT from a tmp generation and ignores crashed tmp dirs",
		async () => {
			const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
			try {
				await Bun.write(path.join(project, "lib.rs"), "pub fn alpha() {}\n");
				const settings = Settings.isolated({
					"codeIntel.enabled": true,
					"codeIntel.semantic": false,
				});
				const index = getCodeIntelIndex(project, settings);
				await index.ensureReady();
				await index.waitUntilWarm();
				const ready = await index.ensureReady();
				expect(ready.generationId).toBeTruthy();
				expect(ready.generationId?.endsWith(".tmp")).toBe(false);
				expect(ready.filesIndexed).toBeGreaterThan(0);
				const generationId = ready.generationId;
				if (!generationId) throw new Error("expected a published generation id");

				const key = await codeIntelProjectKey(project);
				const projectDir = path.join(piUtils.getCodeIntelDir(), key);
				const current = (await Bun.file(path.join(projectDir, "CURRENT")).text()).trim();
				expect(current).toBe(generationId);
				expect(await Bun.file(path.join(projectDir, "generations", generationId, "manifest.json")).exists()).toBe(
					true,
				);

				await fs.mkdir(path.join(projectDir, "generations", "crash.tmp"), { recursive: true });
				await Bun.write(path.join(projectDir, "generations", "crash.tmp", "manifest.json"), "{}\n");
				await __resetCodeIntelIndexesForTests();
				const reloaded = getCodeIntelIndex(project, settings);
				await reloaded.ensureReady();
				await reloaded.waitUntilWarm();
				const afterCrash = await reloaded.ensureReady();
				expect(afterCrash.generationId).toBe(current);
				expect(afterCrash.generationId?.endsWith(".tmp")).toBe(false);
			} finally {
				await piUtils.removeWithRetries(project);
			}
		},
	);

	it.skipIf(!hasCodeIntelNatives())(
		"rebuilds after invalidate instead of pinning the first in-flight warm forever",
		async () => {
			const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
			try {
				await Bun.write(path.join(project, "lib.rs"), "pub fn alpha() {}\n");
				const settings = Settings.isolated({
					"codeIntel.enabled": true,
					"codeIntel.semantic": false,
				});
				const index = getCodeIntelIndex(project, settings);
				await index.ensureReady();
				await index.waitUntilWarm();
				const first = await index.ensureReady();
				expect(first.generationId).toBeTruthy();
				await Bun.write(path.join(project, "extra.rs"), "pub fn beta() {}\n");
				index.invalidate(path.join(project, "extra.rs"));
				await index.waitUntilWarm();
				const second = await index.ensureReady();
				expect(second.generationId).toBeTruthy();
				expect(second.generationId).not.toBe(first.generationId);
			} finally {
				await piUtils.removeWithRetries(project);
			}
		},
	);

	it("does not initialize the embed worker from a query-time semanticHits call", async () => {
		const initialize = vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(null);
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			await Bun.write(path.join(project, "lib.rs"), "pub fn alpha() {}\n");
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": true,
			});
			const index = getCodeIntelIndex(project, settings);
			index.status();
			const hits = await index.semanticHits({ query: "alpha" });
			expect(hits).toEqual([]);
			expect(initialize).not.toHaveBeenCalled();
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it.skipIf(!hasCodeIntelNatives())("initializes the embed worker on background warm, not on status()", async () => {
		const initialize = vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(null);
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			await Bun.write(path.join(project, "lib.rs"), "pub fn alpha() {}\n");
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": true,
			});
			const index = getCodeIntelIndex(project, settings);
			index.status();
			expect(initialize).not.toHaveBeenCalled();
			await index.ensureReady();
			await index.waitUntilWarm();
			expect(initialize).toHaveBeenCalled();
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it("matches native manifest v1 xxHash64 for a fixed vector", () => {
		expect(codeIntelContentHash("hello")).toBe("519150690cce822f");
		expect(codeIntelContentHash("")).toBe("94cd4ad021725519");
		expect(codeIntelContentHash("pub fn alpha() {}\n")).toBe("b3e9d0445de8b15e");
	});

	it("chains exactly one rebuild when invalidate arrives during an awaited warm", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			const firstStarted = Promise.withResolvers<void>();
			const firstGate = Promise.withResolvers<void>();
			let builds = 0;
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options => {
				builds += 1;
				const generation = builds;
				if (generation === 1) {
					firstStarted.resolve();
					await firstGate.promise;
				}
				return writeFakeGeneration(options.destDir, [
					{
						path: generation === 1 ? "lib.rs" : "extra.rs",
						content_hash: codeIntelContentHash(generation === 1 ? "one" : "two"),
					},
				]);
			});
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": false,
			});
			const index = getCodeIntelIndex(project, settings);
			void index.ensureReady();
			await firstStarted.promise;
			index.invalidate(path.join(project, "extra.rs"));
			index.invalidate(path.join(project, "extra.rs"));
			firstGate.resolve();
			await index.waitUntilWarm();
			const ready = await index.ensureReady();
			expect(builds).toBe(2);
			expect(ready.state).toBe("ready");
			expect(ready.generationId).toBeTruthy();
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it("marks a semantic-disabled committed graph ready without embeddings", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options =>
				writeFakeGeneration(options.destDir, [
					{ path: "lib.rs", content_hash: codeIntelContentHash("pub fn alpha() {}\n") },
				]),
			);
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": false,
			});
			const index = getCodeIntelIndex(project, settings);
			await index.ensureReady();
			await index.waitUntilWarm();
			const ready = await index.ensureReady();
			expect(ready.state).toBe("ready");
			expect(ready.embeddingsReady).toBe(false);
			expect(ready.generationId).toBeTruthy();
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it("marks semantic-enabled generations without embeddings unavailable after warm", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(null);
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options =>
				writeFakeGeneration(options.destDir, [
					{ path: "lib.rs", content_hash: codeIntelContentHash("pub fn alpha() {}\n") },
				]),
			);
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": true,
			});
			const index = getCodeIntelIndex(project, settings);
			await index.ensureReady();
			await index.waitUntilWarm();
			const status = index.status();
			expect(status.state).toBe("unavailable");
			expect(status.embeddingsReady).toBe(false);
			expect(status.gap).toBe("semantic unavailable");
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it("attaches stored files.jsonl hashes onto ranked nodes", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			const source = "pub fn alpha() {}\n";
			const storedHash = codeIntelContentHash(source);
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options =>
				writeFakeGeneration(options.destDir, [{ path: "lib.rs", content_hash: storedHash }]),
			);
			vi.spyOn(codeIntelNatives, "codeIntelRankGeneration").mockReturnValue([
				{ path: "lib.rs", symbol: "alpha", score: 1, startLine: 1, endLine: 1 },
			]);
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": false,
			});
			const index = getCodeIntelIndex(project, settings);
			await index.ensureReady();
			await index.waitUntilWarm();
			const ranked = await index.rank({ seedSymbols: ["alpha"] });
			expect(ranked).toEqual([
				{
					path: "lib.rs",
					symbol: "alpha",
					score: 1,
					startLine: 1,
					endLine: 1,
					contentHash: storedHash,
				},
			]);
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it("detects an out-of-band metadata change and publishes a fresh generation", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			let builds = 0;
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options => {
				builds += 1;
				const source = await Bun.file(path.join(project, "lib.rs")).text();
				const result = await writeFakeGeneration(options.destDir, [
					{ path: "lib.rs", content_hash: codeIntelContentHash(source) },
				]);
				const filesPath = path.join(options.destDir, "files.jsonl");
				const metadata = await fs.stat(path.join(project, "lib.rs"));
				await Bun.write(
					filesPath,
					`${JSON.stringify({
						path: "lib.rs",
						mtime_ms: metadata.mtimeMs,
						size: metadata.size,
						content_hash: codeIntelContentHash(source),
						tag_count: 1,
						chunk_ids: [0],
					})}\n`,
				);
				return result;
			});
			await Bun.write(path.join(project, "lib.rs"), "pub fn alpha() {}\n");
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": false,
			});
			const index = getCodeIntelIndex(project, settings);
			await index.ensureReady();
			await index.waitUntilWarm();
			const first = index.status().generationId;

			await Bun.write(path.join(project, "lib.rs"), "pub fn alpha() {}\npub fn beta() {}\n");
			const stale = await index.ensureReady();
			expect(stale.gap).toBe("workspace changed; rebuilding code-intel index");
			await index.waitUntilWarm();
			const fresh = await index.ensureReady();
			expect(builds).toBe(2);
			expect(fresh.generationId).not.toBe(first);
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});
	it("retries a failed invalidation rebuild on the next warm without spinning", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			let builds = 0;
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options => {
				builds += 1;
				if (builds === 2) throw new Error("rebuild failed");
				return writeFakeGeneration(options.destDir, [
					{ path: builds === 1 ? "lib.rs" : "extra.rs", content_hash: codeIntelContentHash(String(builds)) },
				]);
			});
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": false,
			});
			const index = getCodeIntelIndex(project, settings);
			await index.ensureReady();
			await index.waitUntilWarm();
			const first = index.status().generationId;
			index.invalidate(path.join(project, "extra.rs"));
			await index.waitUntilWarm();
			expect(builds).toBe(2);
			expect(index.status().gap).toBe("rebuild failed");

			await index.ensureReady();
			await index.waitUntilWarm();
			const recovered = await index.ensureReady();
			expect(builds).toBe(3);
			expect(recovered.generationId).not.toBe(first);
			expect(recovered.state).toBe("ready");
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});
});
