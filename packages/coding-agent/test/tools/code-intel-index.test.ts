import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import type { MnemopiSubprocessEmbeddingModel } from "../../src/mnemopi/embed-client";
import { mnemopiEmbedClient } from "../../src/mnemopi/embed-client";
import {
	__resetCodeIntelIndexesForTests,
	CodeIntelIndex,
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

interface FakeChunk {
	path: string;
	start_line: number;
	end_line: number;
	symbol: string;
	kind: string;
	text_hash: string;
	content_hash: string;
}

function fakeChunk(
	pathName: string,
	startLine: number,
	endLine: number,
	symbol: string,
	kind: string,
	id: number,
): FakeChunk {
	return {
		path: pathName,
		start_line: startLine,
		end_line: endLine,
		symbol,
		kind,
		text_hash: "text-hash",
		content_hash: codeIntelContentHash(`${symbol}${id}`),
	};
}

async function writeFakeGenerationWithChunks(
	destDir: string,
	files: Array<{ path: string; content_hash: string }>,
	chunks: FakeChunk[],
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
	await Bun.write(path.join(destDir, "chunks.jsonl"), `${chunks.map(chunk => JSON.stringify(chunk)).join("\n")}\n`);
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
			chunk_count: chunks.length,
			tags_hash: "",
			chunks_hash: "",
			embeddings_rows: 0,
			embeddings_dim: 0,
			graph_hash: "",
		}),
	);
	return { filesScanned: files.length, tagCount: 1, chunkCount: chunks.length, parseErrors: [] };
}

function fakeEmbedHandle(options: {
	dim?: number;
	gate?: Promise<void>;
	failFirst?: boolean;
	onBatch?: (texts: string[]) => void;
}): MnemopiSubprocessEmbeddingModel {
	let failed = false;
	const dim = options.dim ?? 4;
	return {
		embed(texts: string[], _batchSize?: number, _role?: string) {
			return {
				async *[Symbol.asyncIterator]() {
					options.onBatch?.(texts);
					if (options.gate) await options.gate;
					if (options.failFirst && !failed) {
						failed = true;
						throw new Error("embed worker failed");
					}
					yield texts.map((_text, i) => {
						const row = new Array<number>(dim).fill(0.1);
						row[i % dim] = 1;
						return row;
					});
				},
			};
		},
	};
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

describe("code_intel semantic embed streaming", () => {
	it.skipIf(!hasCodeIntelNatives())("publishes a verbatim semantic snapshot and stays queryable", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			await Bun.write(
				path.join(project, "alpha.ts"),
				"export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}\n",
			);
			const chunks: FakeChunk[] = [
				fakeChunk("alpha.ts", 1, 1, "alpha", "func", 0),
				fakeChunk("alpha.ts", 2, 3, "alphaBody", "func", 1),
				fakeChunk("alpha.ts", 4, 5, "beta", "func", 2),
			];
			const batches: string[][] = [];
			const handle = fakeEmbedHandle({ dim: 4, onBatch: texts => batches.push([...texts]) });
			vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(handle);
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options =>
				writeFakeGenerationWithChunks(
					options.destDir,
					[{ path: "alpha.ts", content_hash: codeIntelContentHash("x") }],
					chunks,
				),
			);
			vi.spyOn(codeIntelNatives, "codeIntelRankGeneration").mockReturnValue([
				{ path: "alpha.ts", symbol: "alpha", score: 1, startLine: 1, endLine: 1 },
			]);
			const settings = Settings.isolated({ "codeIntel.enabled": true, "codeIntel.semantic": true });
			const index = getCodeIntelIndex(project, settings);
			await index.ensureReady();
			await index.waitUntilWarm();
			const status = index.status();
			expect(status.state).toBe("ready");
			expect(status.embeddingsReady).toBe(true);
			expect(status.embeddingModel).toBeTruthy();
			const id = status.generationId;
			if (!id) throw new Error("expected a published generation id");
			const projectDir = path.join(piUtils.getCodeIntelDir(), await codeIntelProjectKey(project));
			const generationDir = path.join(projectDir, "generations", id);
			const matrix = await Bun.file(path.join(generationDir, "semantic", "embeddings.f32")).arrayBuffer();
			expect(new Float32Array(matrix).length).toBe(3 * 4);
			const ledger = await Bun.file(path.join(generationDir, "semantic", "embeddings.jsonl")).text();
			const chunkText = await Bun.file(path.join(generationDir, "chunks.jsonl")).text();
			expect(ledger).toBe(chunkText);
			const manifest = (await Bun.file(path.join(generationDir, "semantic", "manifest.json")).json()) as {
				embeddingsRows: number;
				embeddingsDim: number;
				embeddingModel: string | null;
			};
			expect(manifest.embeddingsRows).toBe(3);
			expect(manifest.embeddingsDim).toBe(4);
			expect(manifest.embeddingModel).toBeTruthy();
			const entries = await fs.readdir(path.join(projectDir, "generations"));
			expect(entries.some(entry => entry.includes(".semantic.tmp"))).toBe(false);
			expect(await index.rank({ seedSymbols: ["alpha"] })).toHaveLength(1);
			const hits = await index.semanticHits({ query: "alpha", limit: 3 });
			expect(hits.map(hit => hit.symbol).sort()).toEqual(["alpha", "alphaBody", "beta"]);
			expect(batches).toHaveLength(2);
			expect(batches[0]).toEqual([
				"func alpha\nalpha.ts\nexport function alpha() {",
				"func alphaBody\nalpha.ts\nreturn 1;\n}",
				"func beta\nalpha.ts\nexport function beta() {\n  return 2;",
			]);
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it.skipIf(!hasCodeIntelNatives())(
		"keeps native queryable on embed failure and recovers without native rebuild",
		async () => {
			const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
			try {
				await Bun.write(path.join(project, "alpha.ts"), "export function alpha() {}\n");
				const chunks: FakeChunk[] = [fakeChunk("alpha.ts", 1, 1, "alpha", "func", 0)];
				let builds = 0;
				const handle = fakeEmbedHandle({ dim: 4, failFirst: true });
				vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(handle);
				vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
				vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options => {
					builds += 1;
					return writeFakeGenerationWithChunks(
						options.destDir,
						[{ path: "alpha.ts", content_hash: codeIntelContentHash("x") }],
						chunks,
					);
				});
				vi.spyOn(codeIntelNatives, "codeIntelRankGeneration").mockReturnValue([
					{ path: "alpha.ts", symbol: "alpha", score: 1, startLine: 1, endLine: 1 },
				]);
				const settings = Settings.isolated({ "codeIntel.enabled": true, "codeIntel.semantic": true });
				const index = getCodeIntelIndex(project, settings);
				await index.ensureReady();
				await index.waitUntilWarm();
				expect(builds).toBe(1);
				const afterFailure = index.status();
				expect(afterFailure.generationId).toBeTruthy();
				expect(afterFailure.gap).toBe("embed worker failed");
				expect(afterFailure.embeddingsReady).toBe(false);
				expect(await index.rank({ seedSymbols: ["alpha"] })).toHaveLength(1);
				expect(await index.semanticHits({ query: "alpha" })).toEqual([]);
				// Re-warm recovers semantic without rebuilding native.
				index.warm();
				await index.waitUntilWarm();
				expect(builds).toBe(1);
				const recovered = index.status();
				expect(recovered.state).toBe("ready");
				expect(recovered.embeddingsReady).toBe(true);
				expect(recovered.gap).toBeUndefined();
				expect(await index.semanticHits({ query: "alpha" })).toHaveLength(1);
			} finally {
				await piUtils.removeWithRetries(project);
			}
		},
	);

	it.skipIf(!hasCodeIntelNatives())(
		"warm-only callers reuse the committed snapshot instead of rebuilding",
		async () => {
			const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
			try {
				await Bun.write(path.join(project, "alpha.ts"), "export function alpha() {}\n");
				const chunks: FakeChunk[] = [fakeChunk("alpha.ts", 1, 1, "alpha", "func", 0)];
				let builds = 0;
				const handle = fakeEmbedHandle({ dim: 4 });
				vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(handle);
				vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
				vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options => {
					builds += 1;
					return writeFakeGenerationWithChunks(
						options.destDir,
						[{ path: "alpha.ts", content_hash: codeIntelContentHash("x") }],
						chunks,
					);
				});
				const settings = Settings.isolated({ "codeIntel.enabled": true, "codeIntel.semantic": true });
				const first = getCodeIntelIndex(project, settings);
				await first.ensureReady();
				await first.waitUntilWarm();
				const firstStatus = first.status();
				expect(firstStatus.embeddingsReady).toBe(true);
				expect(firstStatus.generationId).toBeTruthy();
				await __resetCodeIntelIndexesForTests();
				const second = getCodeIntelIndex(project, settings);
				second.warm();
				await second.waitUntilWarm();
				expect(builds).toBe(1);
				const reused = second.status();
				expect(reused.generationId).toBe(firstStatus.generationId);
				expect(reused.embeddingsReady).toBe(true);
				expect(reused.state).toBe("ready");
			} finally {
				await piUtils.removeWithRetries(project);
			}
		},
	);

	it.skipIf(!hasCodeIntelNatives())("rank returns on the native snapshot while embed is still in flight", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			await Bun.write(path.join(project, "alpha.ts"), "export function alpha() {}\n");
			const chunks: FakeChunk[] = [fakeChunk("alpha.ts", 1, 1, "alpha", "func", 0)];
			const gate = Promise.withResolvers<void>();
			const embedStarted = Promise.withResolvers<void>();
			const handle = fakeEmbedHandle({
				dim: 4,
				gate: gate.promise,
				onBatch: () => embedStarted.resolve(),
			});
			vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(handle);
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options =>
				writeFakeGenerationWithChunks(
					options.destDir,
					[{ path: "alpha.ts", content_hash: codeIntelContentHash("x") }],
					chunks,
				),
			);
			vi.spyOn(codeIntelNatives, "codeIntelRankGeneration").mockReturnValue([
				{ path: "alpha.ts", symbol: "alpha", score: 1, startLine: 1, endLine: 1 },
			]);
			const settings = Settings.isolated({ "codeIntel.enabled": true, "codeIntel.semantic": true });
			const index = getCodeIntelIndex(project, settings);
			await index.ensureReady();
			await embedStarted.promise;
			const ranked = await index.rank({ seedSymbols: ["alpha"] });
			expect(ranked).toHaveLength(1);
			gate.resolve();
			await index.waitUntilWarm();
			expect(index.status().embeddingsReady).toBe(true);
			expect(index.status().state).toBe("ready");
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it.skipIf(!hasCodeIntelNatives())(
		"cancelWarm aborts the pending embed, removes staging, and keeps native",
		async () => {
			const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
			try {
				await Bun.write(path.join(project, "alpha.ts"), "export function alpha() {}\n");
				const chunks: FakeChunk[] = [fakeChunk("alpha.ts", 1, 1, "alpha", "func", 0)];
				let builds = 0;
				let batches = 0;
				const gate = Promise.withResolvers<void>();
				const embedStarted = Promise.withResolvers<void>();
				const handle = fakeEmbedHandle({
					dim: 4,
					gate: gate.promise,
					onBatch: () => {
						batches += 1;
						embedStarted.resolve();
					},
				});
				vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(handle);
				vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
				vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options => {
					builds += 1;
					return writeFakeGenerationWithChunks(
						options.destDir,
						[{ path: "alpha.ts", content_hash: codeIntelContentHash("x") }],
						chunks,
					);
				});
				const settings = Settings.isolated({ "codeIntel.enabled": true, "codeIntel.semantic": true });
				const index = getCodeIntelIndex(project, settings);
				await index.ensureReady();
				await embedStarted.promise;
				await index.cancelWarm();
				expect(builds).toBe(1);
				const projectDir = path.join(piUtils.getCodeIntelDir(), await codeIntelProjectKey(project));
				const entries = await fs.readdir(path.join(projectDir, "generations"));
				expect(entries.some(name => name.includes(".semantic.tmp"))).toBe(false);
				expect(index.status().generationId).toBeTruthy();
				expect(batches).toBeLessThanOrEqual(1);
				gate.resolve();
			} finally {
				await piUtils.removeWithRetries(project);
			}
		},
	);

	it("cleans dead-pid staging dirs under the lock and keeps live or unattributable ones", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			await Bun.write(path.join(project, "lib.ts"), "export const a = 1;\n");
			let builds = 0;
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options => {
				builds += 1;
				return writeFakeGeneration(options.destDir, [{ path: "lib.ts", content_hash: codeIntelContentHash("x") }]);
			});
			const settings = Settings.isolated({ "codeIntel.enabled": true, "codeIntel.semantic": false });
			const index = getCodeIntelIndex(project, settings);
			await index.ensureReady();
			await index.waitUntilWarm();
			const projectDir = path.join(piUtils.getCodeIntelDir(), await codeIntelProjectKey(project));
			const generationDir = path.join(projectDir, "generations");
			await fs.mkdir(path.join(generationDir, "dead.tmp.2147483647"), { recursive: true });
			await fs.mkdir(path.join(generationDir, `live.semantic.tmp.${process.pid}`), { recursive: true });
			await fs.mkdir(path.join(generationDir, "crash.tmp"), { recursive: true });
			index.invalidate(path.join(project, "extra.ts"));
			await index.waitUntilWarm();
			expect(builds).toBe(2);
			const entries = await fs.readdir(generationDir);
			expect(entries).not.toContain("dead.tmp.2147483647");
			expect(entries).toContain(`live.semantic.tmp.${process.pid}`);
			expect(entries).toContain("crash.tmp");
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it.skipIf(!hasCodeIntelNatives())("adopts a semantic snapshot another process published", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			await Bun.write(path.join(project, "alpha.ts"), "export function alpha() {}\n");
			let builds = 0;
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options => {
				builds += 1;
				return writeFakeGeneration(options.destDir, [
					{ path: "alpha.ts", content_hash: codeIntelContentHash("x") },
				]);
			});
			vi.spyOn(codeIntelNatives, "codeIntelRankGeneration").mockReturnValue([
				{ path: "alpha.ts", symbol: "alpha", score: 1, startLine: 1, endLine: 1 },
			]);
			const nativeOnly = Settings.isolated({ "codeIntel.enabled": true, "codeIntel.semantic": false });
			const first = getCodeIntelIndex(project, nativeOnly);
			await first.ensureReady();
			await first.waitUntilWarm();
			const id = first.status().generationId;
			if (!id) throw new Error("expected a published generation id");
			const projectDir = path.join(piUtils.getCodeIntelDir(), await codeIntelProjectKey(project));
			const generationDir = path.join(projectDir, "generations", id);
			// Another process atomically published the complete semantic directory.
			await fs.mkdir(path.join(generationDir, "semantic"), { recursive: true });
			await Bun.write(
				path.join(generationDir, "semantic", "embeddings.f32"),
				new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]),
			);
			const ledgerChunks: FakeChunk[] = [
				fakeChunk("alpha.ts", 1, 1, "alpha", "func", 0),
				fakeChunk("alpha.ts", 1, 1, "beta", "func", 1),
			];
			await Bun.write(
				path.join(generationDir, "semantic", "embeddings.jsonl"),
				`${ledgerChunks.map(chunk => JSON.stringify(chunk)).join("\n")}\n`,
			);
			const nativeManifest = await Bun.file(path.join(generationDir, "manifest.json")).json();
			await Bun.write(
				path.join(generationDir, "semantic", "manifest.json"),
				JSON.stringify({
					...nativeManifest,
					embeddingModel: "fast-bge-base-en-v1.5",
					embeddingsRows: 2,
					embeddingsDim: 4,
					dim: 4,
				}),
			);
			let embedCalls = 0;
			const handle = fakeEmbedHandle({ dim: 4, onBatch: () => void embedCalls++ });
			vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(handle);
			await __resetCodeIntelIndexesForTests();
			const semantic = Settings.isolated({ "codeIntel.enabled": true, "codeIntel.semantic": true });
			const second = getCodeIntelIndex(project, semantic);
			second.warm();
			await second.waitUntilWarm();
			const adopted = second.status();
			expect(builds).toBe(1);
			expect(embedCalls).toBe(0);
			expect(adopted.generationId).toBe(id);
			expect(adopted.embeddingsReady).toBe(true);
			expect(adopted.state).toBe("ready");
			const manifest = (await Bun.file(path.join(generationDir, "semantic", "manifest.json")).json()) as {
				embeddingsRows: number;
				embeddingsDim: number;
				embeddingModel: string | null;
			};
			expect(manifest.embeddingsRows).toBe(2);
			expect(manifest.embeddingsDim).toBe(4);
			expect(manifest.embeddingModel).toBeTruthy();
			expect(await second.semanticHits({ query: "alpha", limit: 2 })).toHaveLength(2);
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it("shares a cold build and semantic snapshot between concurrent owners", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-concurrent-"));
		const settings = Settings.isolated({ "codeIntel.semantic": true });
		const first = new CodeIntelIndex(project, settings);
		const second = new CodeIntelIndex(project, settings);
		try {
			await Bun.write(path.join(project, "alpha.ts"), "export const alpha = 1;\n");
			let builds = 0;
			let batches = 0;
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options => {
				builds++;
				return writeFakeGenerationWithChunks(
					options.destDir,
					[],
					[fakeChunk("alpha.ts", 1, 1, "alpha", "const", 0)],
				);
			});
			vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(
				fakeEmbedHandle({
					onBatch: () => {
						batches++;
					},
				}),
			);
			first.warm();
			second.warm();
			await Promise.all([first.waitUntilWarm(), second.waitUntilWarm()]);
			expect(builds).toBe(1);
			expect(batches).toBe(1);
			expect(first.status().embeddingsReady).toBe(true);
			expect(second.status().embeddingsReady).toBe(true);
			expect(first.status().generationId).toBe(second.status().generationId);
		} finally {
			await Promise.all([first.cancelWarm(), second.cancelWarm()]);
			await piUtils.removeWithRetries(project);
		}
	});

	it("does not install an old semantic manifest after adopting a newer native generation", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-generations-"));
		const first = new CodeIntelIndex(project, Settings.isolated({ "codeIntel.semantic": true }));
		const second = new CodeIntelIndex(project, Settings.isolated({ "codeIntel.semantic": false }));
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		try {
			await Bun.write(path.join(project, "alpha.ts"), "export const alpha = 1;\n");
			vi.spyOn(codeIntelNatives, "hasCodeIntelNatives").mockReturnValue(true);
			vi.spyOn(codeIntelNatives, "codeIntelBuildGeneration").mockImplementation(async options =>
				writeFakeGenerationWithChunks(options.destDir, [], [fakeChunk("alpha.ts", 1, 1, "alpha", "const", 0)]),
			);
			vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(
				fakeEmbedHandle({ gate: gate.promise, onBatch: () => entered.resolve() }),
			);
			first.warm();
			await entered.promise;
			const oldId = first.status().generationId;
			second.invalidate(path.join(project, "added.ts"));
			second.warm();
			await second.waitUntilWarm();
			const newId = second.status().generationId;
			expect(newId).not.toBe(oldId);
			await first.ensureReady();
			gate.resolve();
			await first.waitUntilWarm();
			expect(first.status().generationId).toBe(newId);
			expect(first.status().embeddingsReady).toBe(false);
			expect(await first.semanticHits({ query: "alpha" })).toEqual([]);
		} finally {
			gate.resolve();
			await Promise.all([first.cancelWarm(), second.cancelWarm()]);
			await piUtils.removeWithRetries(project);
		}
	});
});
