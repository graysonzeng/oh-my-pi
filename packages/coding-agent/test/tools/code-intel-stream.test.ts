import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MnemopiSubprocessEmbeddingModel } from "../../src/mnemopi/embed-client";
import {
	CodeIntelEmbedBudgetError,
	EMBED_DEFAULT_LIMITS,
	streamEmbedPassages,
} from "../../src/tools/code-intel-stream";

let workDir: string | undefined;

afterEach(async () => {
	if (workDir) await fs.rm(workDir, { recursive: true, force: true });
	workDir = undefined;
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	workDir = dir;
	return dir;
}

interface FakeChunk {
	path: string;
	start_line: number;
	end_line: number;
	symbol: string;
	kind: string;
}

function chunkLine(chunk: FakeChunk, depth: number): string {
	return JSON.stringify({ id: depth, ...chunk, text_hash: "t", content_hash: "c" });
}

function fakeHandle(options: {
	dim?: number;
	rowsFor?: (texts: string[]) => number[][];
	onBatch?: (texts: string[]) => void;
	gate?: Promise<void>;
}): MnemopiSubprocessEmbeddingModel {
	const dim = options.dim ?? 4;
	return {
		embed(texts: string[], _batchSize?: number, _role?: string) {
			return {
				async *[Symbol.asyncIterator]() {
					options.onBatch?.(texts);
					if (options.gate) await options.gate;
					const rows = options.rowsFor
						? options.rowsFor(texts)
						: texts.map((_text, i) => {
								const row = new Array<number>(dim).fill(0.1);
								row[i % dim] = 1;
								return row;
							});
					yield rows;
				},
			};
		},
	};
}

describe("code_intel stream embed passages", () => {
	it("reads each source file exactly once and writes a verbatim ledger", async () => {
		const dir = await tempDir("code-intel-stream-");
		await Bun.write(
			path.join(dir, "big.ts"),
			`${Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join("\n")}\n`,
		);
		const chunks = Array.from({ length: 50 }, (_, i) =>
			chunkLine({ path: "big.ts", start_line: 1, end_line: 40, symbol: `sym${i}`, kind: "func" }, i),
		).join("\n");
		await Bun.write(path.join(dir, "chunks.jsonl"), `${chunks}\n`);

		let reads = 0;
		const outcome = await streamEmbedPassages({
			root: dir,
			chunksPath: path.join(dir, "chunks.jsonl"),
			handle: fakeHandle({ dim: 4 }),
			limits: EMBED_DEFAULT_LIMITS,
			matrixPath: path.join(dir, "matrix.f32"),
			ledgerPath: path.join(dir, "ledger.jsonl"),
			readSource: async () => {
				reads += 1;
				return Bun.file(path.join(dir, "big.ts")).text();
			},
		});

		expect(reads).toBe(1);
		expect(outcome.rows).toBe(50);
		expect(outcome.chunks).toBe(50);
		expect(outcome.dim).toBe(4);
		const matrix = await Bun.file(path.join(dir, "matrix.f32")).arrayBuffer();
		expect(new Float32Array(matrix).length).toBe(50 * 4);
		const ledger = await Bun.file(path.join(dir, "ledger.jsonl")).text();
		expect(ledger).toBe(`${chunks}\n`);
	});

	it("respects the maxEmbedFiles cap without touching later files", async () => {
		const dir = await tempDir("code-intel-stream-");
		await Bun.write(path.join(dir, "a.ts"), "export const a = 1;\n");
		await Bun.write(path.join(dir, "b.ts"), "export const b = 1;\n");
		const lines = [
			chunkLine({ path: "a.ts", start_line: 1, end_line: 1, symbol: "a", kind: "func" }, 0),
			chunkLine({ path: "a.ts", start_line: 1, end_line: 1, symbol: "a2", kind: "func" }, 1),
			chunkLine({ path: "a.ts", start_line: 1, end_line: 1, symbol: "a3", kind: "func" }, 2),
			chunkLine({ path: "b.ts", start_line: 1, end_line: 1, symbol: "b", kind: "func" }, 3),
			chunkLine({ path: "b.ts", start_line: 1, end_line: 1, symbol: "b2", kind: "func" }, 4),
		].join("\n");
		await Bun.write(path.join(dir, "chunks.jsonl"), `${lines}\n`);

		const outcome = await streamEmbedPassages({
			root: dir,
			chunksPath: path.join(dir, "chunks.jsonl"),
			handle: fakeHandle({ dim: 4 }),
			limits: { ...EMBED_DEFAULT_LIMITS, maxEmbedFiles: 1 },
			matrixPath: path.join(dir, "matrix.f32"),
			ledgerPath: path.join(dir, "ledger.jsonl"),
		});
		expect(outcome.files).toBe(1);
		expect(outcome.chunks).toBe(3);
		expect(outcome.rows).toBe(3);
	});

	it("throws a budget error when the chunk cap is exceeded", async () => {
		const dir = await tempDir("code-intel-stream-");
		await Bun.write(path.join(dir, "a.ts"), "export const a = 1;\n");
		const lines = [0, 1, 2]
			.map(i => chunkLine({ path: "a.ts", start_line: 1, end_line: 1, symbol: `s${i}`, kind: "func" }, i))
			.join("\n");
		await Bun.write(path.join(dir, "chunks.jsonl"), `${lines}\n`);

		await expect(
			streamEmbedPassages({
				root: dir,
				chunksPath: path.join(dir, "chunks.jsonl"),
				handle: fakeHandle({ dim: 4 }),
				limits: { ...EMBED_DEFAULT_LIMITS, maxChunks: 2 },
				matrixPath: path.join(dir, "matrix.f32"),
				ledgerPath: path.join(dir, "ledger.jsonl"),
			}),
		).rejects.toBeInstanceOf(CodeIntelEmbedBudgetError);
	});

	it("throws a budget error when per-file bytes are exceeded", async () => {
		const dir = await tempDir("code-intel-stream-");
		await Bun.write(path.join(dir, "huge.ts"), "export const a = 1;\n");
		const lines = [chunkLine({ path: "huge.ts", start_line: 1, end_line: 1, symbol: "s", kind: "func" }, 0)].join(
			"\n",
		);
		await Bun.write(path.join(dir, "chunks.jsonl"), `${lines}\n`);

		await expect(
			streamEmbedPassages({
				root: dir,
				chunksPath: path.join(dir, "chunks.jsonl"),
				handle: fakeHandle({ dim: 4 }),
				limits: { ...EMBED_DEFAULT_LIMITS, maxFileBytes: 4 },
				matrixPath: path.join(dir, "matrix.f32"),
				ledgerPath: path.join(dir, "ledger.jsonl"),
			}),
		).rejects.toBeInstanceOf(CodeIntelEmbedBudgetError);
	});

	it("throws when the model returns a mismatched row count", async () => {
		const dir = await tempDir("code-intel-stream-");
		await Bun.write(path.join(dir, "a.ts"), "export const a = 1;\n");
		const lines = [0, 1, 2]
			.map(i => chunkLine({ path: "a.ts", start_line: 1, end_line: 1, symbol: `s${i}`, kind: "func" }, i))
			.join("\n");
		await Bun.write(path.join(dir, "chunks.jsonl"), `${lines}\n`);

		await expect(
			streamEmbedPassages({
				root: dir,
				chunksPath: path.join(dir, "chunks.jsonl"),
				handle: fakeHandle({ rowsFor: () => [[0, 0, 0, 0]] }),
				limits: EMBED_DEFAULT_LIMITS,
				matrixPath: path.join(dir, "matrix.f32"),
				ledgerPath: path.join(dir, "ledger.jsonl"),
			}),
		).rejects.toThrow(/rows mismatch/);
	});

	it("throws when a row's dimension changes mid-stream", async () => {
		const dir = await tempDir("code-intel-stream-");
		await Bun.write(path.join(dir, "a.ts"), "export const a = 1;\n");
		const lines = [0, 1]
			.map(i => chunkLine({ path: "a.ts", start_line: 1, end_line: 1, symbol: `s${i}`, kind: "func" }, i))
			.join("\n");
		await Bun.write(path.join(dir, "chunks.jsonl"), `${lines}\n`);

		let call = 0;
		await expect(
			streamEmbedPassages({
				root: dir,
				chunksPath: path.join(dir, "chunks.jsonl"),
				handle: fakeHandle({
					rowsFor: () => {
						call += 1;
						return call === 1 ? [[1, 0, 0, 0]] : [[1, 0, 0]];
					},
				}),
				limits: { ...EMBED_DEFAULT_LIMITS, passageBatchSize: 1 },
				matrixPath: path.join(dir, "matrix.f32"),
				ledgerPath: path.join(dir, "ledger.jsonl"),
			}),
		).rejects.toThrow(/dimension mismatch/);
	});

	it("stops consuming on cancellation and leaves no rows behind", async () => {
		const dir = await tempDir("code-intel-stream-");
		await Bun.write(path.join(dir, "a.ts"), "export const a = 1;\n");
		const lines = [0, 1, 2]
			.map(i => chunkLine({ path: "a.ts", start_line: 1, end_line: 1, symbol: `s${i}`, kind: "func" }, i))
			.join("\n");
		await Bun.write(path.join(dir, "chunks.jsonl"), `${lines}\n`);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let batches = 0;
		const abort = new AbortController();

		const run = streamEmbedPassages({
			root: dir,
			chunksPath: path.join(dir, "chunks.jsonl"),
			handle: fakeHandle({
				gate: gate.promise,
				onBatch: () => {
					batches++;
					entered.resolve();
				},
			}),
			limits: EMBED_DEFAULT_LIMITS,
			matrixPath: path.join(dir, "matrix.f32"),
			ledgerPath: path.join(dir, "ledger.jsonl"),
			signal: abort.signal,
		});
		// The embed is blocked on the gate; aborting must release it without rows.
		await entered.promise;
		abort.abort();
		await expect(run).rejects.toThrow();
		expect(batches).toBe(1);
		expect((await fs.stat(path.join(dir, "matrix.f32"))).size).toBe(0);
		expect((await fs.stat(path.join(dir, "ledger.jsonl"))).size).toBe(0);
		gate.resolve();
	});

	it("enforces passage budgets in UTF-8 bytes before publishing a batch", async () => {
		const dir = await tempDir("code-intel-stream-");
		await Bun.write(path.join(dir, "a.ts"), "界".repeat(20));
		await Bun.write(
			path.join(dir, "chunks.jsonl"),
			`${chunkLine({ path: "a.ts", start_line: 1, end_line: 1, symbol: "x", kind: "const" }, 0)}\n`,
		);
		await expect(
			streamEmbedPassages({
				root: dir,
				chunksPath: path.join(dir, "chunks.jsonl"),
				handle: fakeHandle({}),
				limits: { ...EMBED_DEFAULT_LIMITS, maxTotalBytes: 50 },
				matrixPath: path.join(dir, "matrix.f32"),
				ledgerPath: path.join(dir, "ledger.jsonl"),
			}),
		).rejects.toThrow(CodeIntelEmbedBudgetError);
		expect((await fs.stat(path.join(dir, "matrix.f32"))).size).toBe(0);
	});
});
