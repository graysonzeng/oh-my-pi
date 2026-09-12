import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CodeIntelTool, revalidateCandidates } from "@oh-my-pi/pi-coding-agent/tools/code-intel";
import { parseCodeIntelEnvelope } from "@oh-my-pi/pi-coding-agent/tools/code-intel-envelope";
import {
	__resetCodeIntelIndexesForTests,
	codeIntelContentHash,
} from "@oh-my-pi/pi-coding-agent/tools/code-intel-index";
import * as piUtils from "@oh-my-pi/pi-utils";

let indexHome: string | undefined;

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"codeIntel.enabled": true,
			"codeIntel.semantic": false,
			"codeIntel.maxIndexFiles": 1,
			"lsp.enabled": false,
			"tools.xdev": false,
		}),
		...overrides,
	};
}

async function runQuery(
	cwd: string,
	query: string,
	params: { depth?: "auto" | "focused" | "extended"; path?: string } = {},
	sessionOverrides: Partial<ToolSession> = {},
): Promise<{ text: string; found: boolean; evidence: string[]; coverage: string; detailsCoverage?: string }> {
	const session = createTestSession(cwd, sessionOverrides);
	const tools = await createTools(session, ["code_intel", "grep"]);
	const tool = tools.find(entry => entry.name === "code_intel");
	if (!tool) throw new Error("code_intel was not registered");
	const result = await tool.execute("t1", { query, ...params });
	const text = result.content.find(block => block.type === "text")?.text ?? "";
	const parsed = parseCodeIntelEnvelope(text);
	return {
		text,
		found: parsed.found,
		evidence: parsed.evidence,
		coverage: parsed.coverage,
		detailsCoverage: result.details && "coverage" in result.details ? String(result.details.coverage) : undefined,
	};
}

function expectAnchor(evidence: string[], file: string, symbol: string): void {
	expect(evidence.some(row => row.includes(file) && row.includes(`| ${symbol} |`))).toBe(true);
}

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

beforeEach(async () => {
	indexHome = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-corpus-home-"));
	vi.spyOn(piUtils, "getCodeIntelDir").mockReturnValue(path.join(indexHome, "code-intel"));
});

afterEach(async () => {
	await __resetCodeIntelIndexesForTests();
	vi.restoreAllMocks();
	if (indexHome) await piUtils.removeWithRetries(indexHome);
	indexHome = undefined;
});

describe("code_intel positive corpus", () => {
	it("hits ensureIsolation for English and Chinese isolation queries", async () => {
		const english = await runQuery(REPO_ROOT, "where is isolated task worktree created");
		expect(english.found).toBe(true);
		expectAnchor(english.evidence, "packages/coding-agent/src/task/worktree.ts", "ensureIsolation");
		expect(english.text).not.toContain("NOT_FOUND");

		const chinese = await runQuery(REPO_ROOT, "task 子代理 isolation 是在哪创建 worktree 的");
		expect(chinese.found).toBe(true);
		expectAnchor(chinese.evidence, "packages/coding-agent/src/task/worktree.ts", "ensureIsolation");
		expect(chinese.text).not.toContain("NOT_FOUND");
	});

	it("hits isWaitingPollDetails for hub wait timeout queries", async () => {
		const english = await runQuery(REPO_ROOT, "does hub wait timeout mark a still-running job useless");
		expect(english.found).toBe(true);
		expectAnchor(english.evidence, "packages/coding-agent/src/tools/hub/jobs.ts", "isWaitingPollDetails");
		expect(english.text).not.toContain("NOT_FOUND");

		const chinese = await runQuery(REPO_ROOT, "hub wait 超时后 job 会不会被标 useless");
		expect(chinese.found).toBe(true);
		expectAnchor(chinese.evidence, "packages/coding-agent/src/tools/hub/jobs.ts", "isWaitingPollDetails");
		expect(chinese.text).not.toContain("NOT_FOUND");
	});

	it("hits LSP rename default apply", async () => {
		const english = await runQuery(REPO_ROOT, "does LSP rename apply by default");
		expect(english.found).toBe(true);
		expectAnchor(english.evidence, "packages/coding-agent/src/lsp/tool.ts", "shouldApply");
		expect(english.text).not.toContain("NOT_FOUND");

		const chinese = await runQuery(REPO_ROOT, "LSP rename 默认 apply 吗");
		expect(chinese.found).toBe(true);
		expectAnchor(chinese.evidence, "packages/coding-agent/src/lsp/tool.ts", "shouldApply");
		expect(chinese.text).not.toContain("NOT_FOUND");
	});

	it("finds a declaration whose symbol is absent from the file name", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-hidden-symbol-"));
		try {
			await Bun.write(path.join(tempDir, "mod.rs"), `pub fn definitelyHiddenAnchor() {}\n`);
			const result = await runQuery(tempDir, "where is definitelyHiddenAnchor defined");
			expect(result.found).toBe(true);
			expectAnchor(result.evidence, "mod.rs", "definitelyHiddenAnchor");
			expect(result.text).not.toContain("NOT_FOUND");
		} finally {
			await piUtils.removeWithRetries(tempDir);
		}
	});
});

describe("code_intel negative corpus", () => {
	it("returns NOT_FOUND for a fictional symbol", async () => {
		const result = await runQuery(REPO_ROOT, "DefinitelyNotInRepo_XYZ");
		expect(result.found).toBe(false);
		expect(result.text).toContain("NOT_FOUND");
		expect(result.text).toMatch(/gaps:/);
	});

	it("does not emit a call edge from a comment that says calls beta", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-comment-"));
		try {
			await Bun.write(path.join(tempDir, "lib.rs"), `fn alpha() {}\nfn beta() {}\nfn gamma() {}\n// calls beta\n`);
			const result = await runQuery(tempDir, "who calls beta");
			expect(result.evidence.join("\n")).not.toMatch(/\b(calls|called by)\b/);
		} finally {
			await piUtils.removeWithRetries(tempDir);
		}
	});
});

describe("code_intel path and live-file contract", () => {
	it("rejects a path clue that escapes authorized roots before reading", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-root-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-secret-"));
		const secret = path.join(outside, "secret.ts");
		try {
			await Bun.write(path.join(cwd, "mod.ts"), "export function alpha() {}\n");
			await Bun.write(secret, "export const leaked = 1;\n");
			const spy = vi.spyOn(Bun, "file");
			const tool = new CodeIntelTool(createTestSession(cwd));
			await expect(tool.execute("t1", { query: "find leaked", path: "../secret.ts" })).rejects.toThrow(
				/escapes authorized workspace roots/,
			);
			expect(spy.mock.calls.some(call => String(call[0]).includes("secret.ts"))).toBe(false);
		} finally {
			await piUtils.removeWithRetries(cwd);
			await piUtils.removeWithRetries(outside);
		}
	});

	it("drops stale hash and out-of-range candidates while keeping live ones ordered", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-live-"));
		try {
			const source = "export function keepMe() {}\nexport function other() {}\n";
			await Bun.write(path.join(cwd, "keep.ts"), source);
			const gaps: string[] = [];
			let stalePath: string | undefined;
			const live = await revalidateCandidates({
				cwd,
				roots: [path.resolve(cwd)],
				gaps,
				onStalePath: path => {
					stalePath = path;
				},
				candidates: [
					{
						path: "keep.ts",
						startLine: 1,
						endLine: 1,
						symbol: "keepMe",
						provenance: "grep-exact",
						contentHash: codeIntelContentHash(source),
					},
					{
						path: "keep.ts",
						startLine: 1,
						endLine: 1,
						symbol: "keepMe",
						provenance: "graph-ranked-context",
						contentHash: "deadbeefdeadbeef",
					},
					{
						path: "keep.ts",
						startLine: 99,
						endLine: 99,
						symbol: "keepMe",
						provenance: "lsp-reference",
					},
				],
			});
			expect(live).toEqual([
				{
					path: "keep.ts",
					startLine: 1,
					endLine: 1,
					symbol: "keepMe",
					provenance: "grep-exact",
					contentHash: codeIntelContentHash(source),
				},
			]);
			expect(gaps.some(gap => gap.includes("dropped 2"))).toBe(true);
			expect(stalePath).toBe("keep.ts");
		} finally {
			await piUtils.removeWithRetries(cwd);
		}
	});

	it("stops live-file revalidation when its signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const gaps: string[] = [];
		const live = await revalidateCandidates({
			cwd: process.cwd(),
			roots: [path.resolve(process.cwd())],
			gaps,
			signal: controller.signal,
			candidates: [
				{
					path: "package.json",
					startLine: 1,
					endLine: 1,
					symbol: "{",
					provenance: "grep-exact",
				},
			],
		});
		expect(live).toEqual([]);
		expect(gaps).toContain("live evidence revalidation interrupted by timeout");
	});

	it("finds a kebab-case literal on a non-declaration line", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-kebab-"));
		try {
			await Bun.write(
				path.join(cwd, "mod.ts"),
				"export function kebabCaseName() {\n  return 'kebab-case-name';\n}\n",
			);
			const result = await runQuery(cwd, "where is kebab-case-name defined");
			expect(result.found).toBe(true);
			expectAnchor(result.evidence, "mod.ts", "kebab-case-name");
			const upper = await runQuery(cwd, "where is KEBAB-CASE-NAME defined");
			expect(upper.found).toBe(true);
			expectAnchor(upper.evidence, "mod.ts", "kebab-case-name");
		} finally {
			await piUtils.removeWithRetries(cwd);
		}
	});

	it("forwards focused coverage onto the envelope", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-focus-"));
		try {
			await Bun.write(path.join(cwd, "mod.ts"), "export function alpha() {}\nexport function beta() { alpha(); }\n");
			const result = await runQuery(cwd, "who calls alpha", { depth: "focused" });
			expect(result.coverage).toBe("focused");
			expect(result.detailsCoverage).toBe("focused");
			expect(result.evidence.join("\n")).not.toMatch(/\b(calls|called by)\b/);
		} finally {
			await piUtils.removeWithRetries(cwd);
		}
	});
});
