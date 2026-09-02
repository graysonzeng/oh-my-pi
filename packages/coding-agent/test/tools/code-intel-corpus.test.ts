import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { parseCodeIntelEnvelope } from "@oh-my-pi/pi-coding-agent/tools/code-intel-envelope";
import { __resetCodeIntelIndexesForTests } from "@oh-my-pi/pi-coding-agent/tools/code-intel-index";
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

async function runQuery(cwd: string, query: string): Promise<{ text: string; found: boolean; evidence: string[] }> {
	const session = createTestSession(cwd);
	const tools = await createTools(session, ["code_intel", "grep"]);
	const tool = tools.find(entry => entry.name === "code_intel");
	if (!tool) throw new Error("code_intel was not registered");
	const result = await tool.execute("t1", { query });
	const text = result.content.find(block => block.type === "text")?.text ?? "";
	const parsed = parseCodeIntelEnvelope(text);
	return { text, found: parsed.found, evidence: parsed.evidence };
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
