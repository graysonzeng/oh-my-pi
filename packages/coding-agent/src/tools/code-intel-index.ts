/**
 * Generation snapshot owner for code-intel.
 *
 * Queries read a committed CURRENT generation. Warm writes the next
 * generation into `<id>.tmp` and atomically publishes CURRENT. A crashed
 * `.tmp` directory is never CURRENT.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { mmrRerankIndices, vectorIndexTopK } from "@oh-my-pi/pi-natives";
import { getCodeIntelDir, isEnoent, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { canonicalProjectDir } from "../launch/paths";
import type { MnemopiSubprocessEmbeddingModel } from "../mnemopi/embed-client";
import { replaceFileAtomically } from "../utils/atomic-file";
import * as git from "../utils/git";
import {
	collectEmbedMatrix,
	isEnglishOnlyEmbedModel,
	resolveCodeIntelEmbedModel,
	tryInitializeLocalEmbed,
} from "./code-intel-embed";
import type { CodeIntelRankedNode } from "./code-intel-natives";
import * as codeIntelNatives from "./code-intel-natives";

export const MANIFEST_VERSION = 1;

/** Native manifest v1: xxHash64 of UTF-8 bytes, seed `CINTHASH`. */
const CODE_INTEL_CONTENT_HASH_SEED = 0x4349_4e54_4841_5348n;

export function codeIntelContentHash(content: string): string {
	return Bun.hash.xxHash64(content, CODE_INTEL_CONTENT_HASH_SEED).toString(16).padStart(16, "0");
}

export type CodeIntelIndexState = "ready" | "warming" | "disabled" | "unavailable";

export interface CodeIntelManifest {
	version: number;
	root: string;
	gitHead: string | null;
	embeddingModel: string | null;
	dim: number;
	fileCount: number;
	tagCount: number;
	chunkCount: number;
	tagsHash: string;
	chunksHash: string;
	embeddingsRows: number;
	embeddingsDim: number;
	graphHash: string;
}

interface NativeManifest {
	version: number;
	root: string;
	git_head?: string | null;
	gitHead?: string | null;
	embedding_model?: string | null;
	embeddingModel?: string | null;
	dim: number;
	file_count?: number;
	fileCount?: number;
	tag_count?: number;
	tagCount?: number;
	chunk_count?: number;
	chunkCount?: number;
	tags_hash?: string;
	tagsHash?: string;
	chunks_hash?: string;
	chunksHash?: string;
	embeddings_rows?: number;
	embeddingsRows?: number;
	embeddings_dim?: number;
	embeddingsDim?: number;
	graph_hash?: string;
	graphHash?: string;
}

export interface CodeIntelIndexStatus {
	state: CodeIntelIndexState;
	generationId: string | null;
	filesIndexed: number;
	embeddingsReady: boolean;
	embeddingModel: string | null;
	englishOnly: boolean;
	gap?: string;
}

interface StoredFile {
	path: string;
	mtime_ms: number;
	size: number;
	content_hash: string;
	tag_count: number;
	chunk_ids: number[];
}

interface StoredChunk {
	id: number;
	path: string;
	start_line: number;
	end_line: number;
	symbol: string;
	kind: string;
	text_hash: string;
	content_hash: string;
}

const owners = new Map<string, CodeIntelIndex>();
const METADATA_SWEEP_LIMIT = 64;

export async function codeIntelProjectKey(root: string): Promise<string> {
	const canonical = await canonicalProjectDir(root);
	const digest = new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
	return digest.slice(0, 16);
}

export function getCodeIntelIndex(root: string, settings: Settings): CodeIntelIndex {
	const key = path.resolve(root);
	const existing = owners.get(key);
	if (existing) return existing;
	const index = new CodeIntelIndex(key, settings);
	owners.set(key, index);
	return index;
}

export function invalidateCodeIntelPath(filePath: string): void {
	for (const index of owners.values()) index.invalidate(filePath);
}

/** Test-only: wait for in-flight warms, then drop in-memory generation owners. */
export async function __resetCodeIntelIndexesForTests(): Promise<void> {
	const indexes = [...owners.values()];
	await Promise.allSettled(indexes.map(index => index.waitUntilWarm()));
	owners.clear();
}

function pickNumber(...values: Array<number | undefined>): number {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return 0;
}

function pickString(...values: Array<string | null | undefined>): string {
	for (const value of values) {
		if (typeof value === "string") return value;
	}
	return "";
}

function normalizeManifest(raw: NativeManifest, fallbackRoot: string): CodeIntelManifest {
	return {
		version: raw.version,
		root: raw.root || fallbackRoot,
		gitHead: raw.gitHead ?? raw.git_head ?? null,
		embeddingModel: raw.embeddingModel ?? raw.embedding_model ?? null,
		dim: pickNumber(raw.dim),
		fileCount: pickNumber(raw.fileCount, raw.file_count),
		tagCount: pickNumber(raw.tagCount, raw.tag_count),
		chunkCount: pickNumber(raw.chunkCount, raw.chunk_count),
		tagsHash: pickString(raw.tagsHash, raw.tags_hash),
		chunksHash: pickString(raw.chunksHash, raw.chunks_hash),
		embeddingsRows: pickNumber(raw.embeddingsRows, raw.embeddings_rows),
		embeddingsDim: pickNumber(raw.embeddingsDim, raw.embeddings_dim),
		graphHash: pickString(raw.graphHash, raw.graph_hash),
	};
}

function sliceSourceLines(source: string, startLine: number, endLine: number): string {
	const lines = source.split("\n");
	const from = Math.max(0, startLine - 1);
	const to = Math.min(lines.length, Math.max(from + 1, endLine));
	return lines.slice(from, to).join("\n");
}

async function passageText(root: string, chunk: StoredChunk): Promise<string> {
	const absolute = path.resolve(root, chunk.path);
	try {
		const source = await Bun.file(absolute).text();
		const body = sliceSourceLines(source, chunk.start_line, chunk.end_line).trim();
		if (body) return `${chunk.kind} ${chunk.symbol}\n${chunk.path}\n${body}`;
	} catch {
		// File vanished between generation and embed; fall back to metadata.
	}
	return `${chunk.kind} ${chunk.symbol}\n${chunk.path}`;
}

async function readJsonl<T>(filePath: string, signal?: AbortSignal): Promise<T[]> {
	try {
		const text = await untilAborted(signal, Bun.file(filePath).text());
		return Bun.JSONL.parse(text) as T[];
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function atomicWriteText(targetPath: string, content: string): Promise<void> {
	const tempPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await Bun.write(tempPath, content);
	await replaceFileAtomically(tempPath, targetPath);
}

export class CodeIntelIndex {
	readonly #root: string;
	readonly #settings: Settings;
	readonly #indexHome: string;
	#projectKey: string | null = null;
	#current: string | null = null;
	#manifest: CodeIntelManifest | null = null;
	#state: CodeIntelIndexState = "unavailable";
	#gap: string | undefined;
	#warm: Promise<void> | null = null;
	#invalidationEpoch = 0;
	#builtEpoch = 0;
	#fileHashes: Map<string, string> | null = null;
	#fileHashGenerationId: string | null = null;
	#storedFiles: StoredFile[] | null = null;
	#metadataSweepCursor = 0;
	#embedHandle: MnemopiSubprocessEmbeddingModel | null = null;
	#embedModel: string | null = null;

	constructor(root: string, settings: Settings) {
		this.#root = root;
		this.#settings = settings;
		this.#indexHome = getCodeIntelDir();
	}

	invalidate(_filePath: string): void {
		this.#invalidationEpoch += 1;
		if (this.#current || this.#state === "warming" || this.#state === "ready") {
			this.#state = this.#current ? this.#state : "warming";
			this.warm();
		}
	}

	status(): CodeIntelIndexStatus {
		return {
			state: this.#state,
			generationId: this.#current,
			filesIndexed: this.#manifest?.fileCount ?? 0,
			embeddingsReady: (this.#manifest?.embeddingsRows ?? 0) > 0 && this.#embedHandle !== null,
			embeddingModel: this.#manifest?.embeddingModel ?? null,
			englishOnly: this.#manifest?.embeddingModel ? isEnglishOnlyEmbedModel(this.#manifest.embeddingModel) : false,
			gap: this.#gap,
		};
	}

	async ensureReady(signal?: AbortSignal): Promise<CodeIntelIndexStatus> {
		if (!codeIntelNatives.hasCodeIntelNatives()) {
			this.#state = "unavailable";
			this.#gap = codeIntelNatives.NATIVE_CODE_INTEL_MISSING;
			return this.status();
		}
		await this.#loadCurrent(signal);
		await this.#sweepExternalChanges(signal);
		this.warm();
		this.#applyReadyState();
		return this.status();
	}

	warm(): void {
		if (!codeIntelNatives.hasCodeIntelNatives()) return;
		if (this.#warm) return;
		const needsBuild = !this.#current || this.#invalidationEpoch > this.#builtEpoch;
		const needsAttach =
			this.#settings.get("codeIntel.semantic") !== false &&
			!!this.#current &&
			!!this.#manifest?.embeddingModel &&
			(this.#manifest.embeddingsRows ?? 0) > 0 &&
			this.#embedHandle === null;
		if (!needsBuild && !needsAttach) {
			this.#applyReadyState();
			return;
		}
		if (!this.#current) this.#state = "warming";
		this.#scheduleWarm();
	}

	/** Test-only: await the in-flight warm, including an epoch-chained rebuild. */
	async waitUntilWarm(): Promise<void> {
		while (this.#warm) await this.#warm;
	}

	async rank(options: {
		seedPaths?: string[];
		seedSymbols?: string[];
		topFiles?: number;
		topSymbols?: number;
		signal?: AbortSignal;
	}): Promise<CodeIntelRankedNode[]> {
		const generation = await this.#committedGeneration(options.signal);
		if (!generation) return [];
		options.signal?.throwIfAborted();
		try {
			const nodes = codeIntelNatives.codeIntelRankGeneration({
				generationDir: generation.dir,
				seedPaths: options.seedPaths,
				seedSymbols: options.seedSymbols,
				topFiles: options.topFiles,
				topSymbols: options.topSymbols,
			});
			options.signal?.throwIfAborted();
			const hashes = await this.#loadFileHashes(generation.dir, generation.id, options.signal);
			return nodes.map(node => {
				const contentHash = hashes.get(node.path);
				return contentHash ? { ...node, contentHash } : { ...node };
			});
		} catch (error) {
			logger.debug("code-intel rank failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}

	async semanticHits(options: {
		query: string;
		limit?: number;
		signal?: AbortSignal;
	}): Promise<Array<{ path: string; startLine: number; endLine: number; symbol: string; score: number }>> {
		if (options.signal?.aborted) return [];
		const generation = await this.#committedGeneration(options.signal);
		const manifest = generation?.manifest;
		const handle = this.#embedHandle;
		if (
			!generation ||
			!manifest ||
			!handle ||
			manifest.embeddingsRows === 0 ||
			!manifest.embeddingModel ||
			this.#embedModel !== manifest.embeddingModel
		) {
			return [];
		}
		let queryRows: number[][];
		let ledger: StoredChunk[];
		let matrix: ArrayBuffer;
		try {
			[queryRows, ledger, matrix] = await Promise.all([
				collectEmbedMatrix(handle, [options.query], "query", 1, options.signal),
				readJsonl<StoredChunk>(path.join(generation.dir, "embeddings.jsonl"), options.signal),
				untilAborted(options.signal, Bun.file(path.join(generation.dir, "embeddings.f32")).arrayBuffer()),
			]);
		} catch (error) {
			if (options.signal?.aborted) return [];
			throw error;
		}
		const query = queryRows[0];
		if (!query || ledger.length === 0) return [];
		const dim = manifest.embeddingsDim;
		if (dim <= 0 || query.length !== dim) return [];
		if (ledger.length !== manifest.embeddingsRows) return [];
		const floats = new Float32Array(matrix);
		if (floats.length !== ledger.length * dim) return [];
		if (typeof vectorIndexTopK !== "function" || typeof mmrRerankIndices !== "function") return [];
		const top = vectorIndexTopK(floats, dim, Float64Array.from(query), Math.min(24, ledger.length));
		const candidates: Array<{ chunk: StoredChunk; score: number; text: string }> = [];
		for (let i = 0; i < top.indices.length; i++) {
			const row = top.indices[i]!;
			const chunk = ledger[row];
			if (!chunk) continue;
			candidates.push({ chunk, score: top.scores[i] ?? 0, text: `${chunk.path} ${chunk.symbol}` });
		}
		const selected = mmrRerankIndices(
			candidates.map(candidate => candidate.text),
			Float64Array.from(candidates.map(candidate => candidate.score)),
			0.7,
			Math.min(options.limit ?? 8, candidates.length),
		);
		return [...selected].map(index => {
			const hit = candidates[index]!;
			return {
				path: hit.chunk.path,
				startLine: hit.chunk.start_line,
				endLine: hit.chunk.end_line,
				symbol: hit.chunk.symbol,
				score: hit.score,
			};
		});
	}

	#applyReadyState(): void {
		if (this.#warm) {
			if (!this.#current) {
				this.#state = "warming";
				return;
			}
			if (this.#settings.get("codeIntel.semantic") === false) return;
			if ((this.#manifest?.embeddingsRows ?? 0) === 0 || !this.#embedHandle) {
				this.#state = "warming";
			}
			return;
		}
		if (!this.#current || !this.#manifest) {
			this.#state = "unavailable";
			return;
		}
		if (this.#settings.get("codeIntel.semantic") === false) {
			this.#state = "ready";
			return;
		}
		if ((this.#manifest.embeddingsRows ?? 0) > 0 && this.#embedHandle) {
			this.#state = "ready";
			return;
		}
		this.#state = "unavailable";
		if ((this.#manifest.embeddingsRows ?? 0) === 0 && !this.#gap) {
			this.#gap = "semantic unavailable";
		}
	}

	async #loadFileHashes(
		generationDir: string,
		generationId: string,
		signal?: AbortSignal,
	): Promise<Map<string, string>> {
		if (this.#fileHashes && this.#storedFiles && this.#fileHashGenerationId === generationId) return this.#fileHashes;
		const files = await readJsonl<StoredFile>(path.join(generationDir, "files.jsonl"), signal);
		const hashes = new Map<string, string>();
		for (const file of files) hashes.set(file.path, file.content_hash);
		this.#fileHashes = hashes;
		this.#storedFiles = files;
		this.#fileHashGenerationId = generationId;
		this.#metadataSweepCursor %= Math.max(1, files.length);
		return hashes;
	}

	async #sweepExternalChanges(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const files = this.#storedFiles;
		if (
			!this.#current ||
			this.#fileHashGenerationId !== this.#current ||
			!files ||
			files.length === 0 ||
			this.#warm ||
			this.#invalidationEpoch > this.#builtEpoch
		)
			return;
		const count = Math.min(METADATA_SWEEP_LIMIT, files.length);
		const start = this.#metadataSweepCursor;
		const selected = Array.from({ length: count }, (_, offset) => files[(start + offset) % files.length]!);
		const changed = (
			await Promise.all(
				selected.map(async file => {
					signal?.throwIfAborted();
					try {
						const metadata = await untilAborted(signal, fs.stat(path.resolve(this.#root, file.path)));
						return (
							metadata.size !== file.size ||
							(file.mtime_ms > 0 && Math.abs(metadata.mtimeMs - file.mtime_ms) > 1)
						);
					} catch (error) {
						if (signal?.aborted) throw error;
						return isEnoent(error);
					}
				}),
			)
		).some(Boolean);
		this.#metadataSweepCursor = (start + count) % files.length;
		if (changed) {
			this.#invalidationEpoch += 1;
			this.#gap = "workspace changed; rebuilding code-intel index";
		}
	}

	#scheduleWarm(): void {
		if (this.#warm) return;
		let failed = false;
		const running = this.#warmWork()
			.catch(error => {
				failed = true;
				logger.debug("code-intel warm failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				this.#gap = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				if (this.#warm === running) this.#warm = null;
				if (
					!failed &&
					this.#invalidationEpoch > this.#builtEpoch &&
					codeIntelNatives.hasCodeIntelNatives() &&
					!this.#warm
				) {
					this.#scheduleWarm();
				} else {
					this.#applyReadyState();
				}
			});
		this.#warm = running;
	}

	async #warmWork(): Promise<void> {
		const startedEpoch = this.#invalidationEpoch;
		if (!this.#current || this.#invalidationEpoch > this.#builtEpoch) {
			await this.#buildNext(startedEpoch);
			return;
		}
		await this.#attachEmbedHandle();
	}

	async #attachEmbedHandle(): Promise<void> {
		const model = this.#manifest?.embeddingModel;
		if (!model || (this.#manifest?.embeddingsRows ?? 0) === 0) return;
		if (this.#embedHandle && this.#embedModel === model) return;
		const handle = await tryInitializeLocalEmbed(model);
		if (!handle) {
			this.#gap = "semantic unavailable";
			return;
		}
		this.#embedHandle = handle;
		this.#embedModel = model;
	}

	async #projectDir(): Promise<string> {
		if (this.#projectKey) return path.join(this.#indexHome, this.#projectKey);
		this.#projectKey = await codeIntelProjectKey(this.#root);
		return path.join(this.#indexHome, this.#projectKey);
	}

	async #loadCurrent(signal?: AbortSignal): Promise<void> {
		const projectDir = await this.#projectDir();
		try {
			const id = (await untilAborted(signal, Bun.file(path.join(projectDir, "CURRENT")).text())).trim();
			if (!id || id.endsWith(".tmp")) return;
			const generationDir = path.join(projectDir, "generations", id);
			const raw = (await untilAborted(
				signal,
				Bun.file(path.join(generationDir, "manifest.json")).json(),
			)) as NativeManifest;
			const manifest = normalizeManifest(raw, this.#root);
			if (manifest.version !== MANIFEST_VERSION) {
				this.#gap = `unknown generation version ${manifest.version}`;
				return;
			}
			if (manifest.embeddingsRows > 0) {
				const ledger = await readJsonl<StoredChunk>(path.join(generationDir, "embeddings.jsonl"), signal);
				const matrix = await untilAborted(
					signal,
					Bun.file(path.join(generationDir, "embeddings.f32")).arrayBuffer(),
				);
				const floats = new Float32Array(matrix);
				if (
					ledger.length !== manifest.embeddingsRows ||
					manifest.embeddingsDim <= 0 ||
					floats.length !== ledger.length * manifest.embeddingsDim
				) {
					manifest.embeddingsRows = 0;
					manifest.embeddingsDim = 0;
					manifest.embeddingModel = null;
					this.#gap = "semantic generation ledger mismatch";
				}
			}
			this.#current = id;
			this.#manifest = manifest;
			await this.#loadFileHashes(generationDir, id, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			if (!isEnoent(error)) {
				logger.debug("code-intel current load failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	async #committedGeneration(
		signal?: AbortSignal,
	): Promise<{ id: string; dir: string; manifest: CodeIntelManifest } | null> {
		if (!this.#current || !this.#manifest) await this.#loadCurrent(signal);
		const id = this.#current;
		const manifest = this.#manifest;
		if (!id || !manifest) return null;
		return { id, dir: path.join(await this.#projectDir(), "generations", id), manifest };
	}

	async #buildNext(startedEpoch: number): Promise<void> {
		const projectDir = await this.#projectDir();
		const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
		const tmpDir = path.join(projectDir, "generations", `${id}.tmp`);
		await fs.mkdir(tmpDir, { recursive: true });
		const maxFiles = this.#settings.get("codeIntel.maxIndexFiles") ?? 20_000;
		const built = await codeIntelNatives.codeIntelBuildGeneration({
			root: this.#root,
			destDir: tmpDir,
			maxFiles,
		});
		const gitHead = await git.head.sha(this.#root).catch(() => null);
		const manifestPath = path.join(tmpDir, "manifest.json");
		const raw = (await Bun.file(manifestPath).json()) as NativeManifest;
		const manifest = normalizeManifest(raw, this.#root);
		manifest.gitHead = gitHead;
		if (this.#settings.get("codeIntel.semantic") !== false) {
			await this.#maybeEmbed(tmpDir, manifest);
		}
		if (manifest.version !== MANIFEST_VERSION) {
			throw new Error(`unknown generation version ${manifest.version}`);
		}
		if (manifest.embeddingsRows > 0) {
			const ledger = await readJsonl<StoredChunk>(path.join(tmpDir, "embeddings.jsonl"));
			const matrix = await Bun.file(path.join(tmpDir, "embeddings.f32")).arrayBuffer();
			const floats = new Float32Array(matrix);
			if (
				ledger.length !== manifest.embeddingsRows ||
				manifest.embeddingsDim <= 0 ||
				floats.length !== ledger.length * manifest.embeddingsDim
			) {
				throw new Error("code-intel embeddings ledger failed publish validation");
			}
		}
		await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		const finalDir = path.join(projectDir, "generations", id);
		await fs.rename(tmpDir, finalDir);
		await atomicWriteText(path.join(projectDir, "CURRENT"), `${id}\n`);
		this.#current = id;
		this.#manifest = manifest;
		this.#builtEpoch = startedEpoch;
		this.#fileHashes = null;
		this.#fileHashGenerationId = null;
		this.#storedFiles = null;
		this.#metadataSweepCursor = 0;
		if (this.#settings.get("codeIntel.semantic") === false || manifest.embeddingsRows > 0) {
			this.#gap = undefined;
		}
		await this.#loadFileHashes(finalDir, id);
		logger.debug("code-intel generation published", {
			id,
			files: built.filesScanned,
			tags: built.tagCount,
			chunks: built.chunkCount,
		});
	}

	async #maybeEmbed(generationDir: string, manifest: CodeIntelManifest): Promise<void> {
		const resolution = resolveCodeIntelEmbedModel(this.#settings);
		if (!resolution.ok) {
			this.#gap = resolution.reason;
			return;
		}
		const handle = await tryInitializeLocalEmbed(resolution.model);
		if (!handle) {
			this.#gap = "semantic unavailable";
			return;
		}
		const chunks = await readJsonl<StoredChunk>(path.join(generationDir, "chunks.jsonl"));
		const maxEmbedFiles = this.#settings.get("codeIntel.maxEmbedFiles") ?? 4000;
		const files = await readJsonl<StoredFile>(path.join(generationDir, "files.jsonl"));
		const allowed = new Set(files.slice(0, maxEmbedFiles).map(file => file.path));
		const selected = chunks.filter(chunk => allowed.has(chunk.path));
		if (selected.length === 0) return;
		const texts = await Promise.all(selected.map(chunk => passageText(this.#root, chunk)));
		const rows = await collectEmbedMatrix(handle, texts, "passage");
		if (rows.length !== selected.length) return;
		const dim = rows[0]?.length ?? 0;
		if (dim <= 0) return;
		const matrix = new Float32Array(selected.length * dim);
		for (let i = 0; i < selected.length; i++) {
			matrix.set(Float32Array.from(rows[i]!), i * dim);
		}
		await Bun.write(path.join(generationDir, "embeddings.f32"), matrix);
		const ledgerPath = path.join(generationDir, "embeddings.jsonl");
		await Bun.write(`${ledgerPath}.tmp`, `${selected.map(chunk => JSON.stringify(chunk)).join("\n")}\n`);
		await replaceFileAtomically(`${ledgerPath}.tmp`, ledgerPath);
		manifest.embeddingModel = resolution.model;
		manifest.dim = dim;
		manifest.embeddingsRows = selected.length;
		manifest.embeddingsDim = dim;
		this.#embedHandle = handle;
		this.#embedModel = resolution.model;
	}
}
