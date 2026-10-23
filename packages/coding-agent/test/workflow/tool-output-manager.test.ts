import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_OPTIMIZATION_PROFILES } from "../../src/model-optimization/default-profiles";
import {
	buildToolOptimizationReceipt,
	sha256Hex,
	TOOL_OPTIMIZATION_RECEIPT_KIND,
	TOOL_OPTIMIZATION_RECEIPT_VERSION,
	type ToolOutputArtifactAdapter,
} from "../../src/workflow/optimization-receipt";
import {
	DEFAULT_SUMMARIZERS,
	DEFAULT_TRUNCATION_RULES,
	processToolOutput,
	processToolOutputDetailed,
	processToolOutputDetailedAsync,
	SUBAGENT_READ_TRUNCATION_RULE,
	summarizeToolOutput,
	truncateToolOutput,
	utf8ByteLength,
	withSubagentReadClamp,
} from "../../src/workflow/tool-output-manager";
import type { ToolStrategy } from "../../src/workflow/types";

const strategy: ToolStrategy = {
	outputTruncation: {
		enabled: true,
		rules: DEFAULT_TRUNCATION_RULES,
	},
	resultSummarization: {
		enabled: true,
		summarizerKeys: ["bash", "read", "test", "*"],
	},
};

describe("truncateToolOutput", () => {
	it("returns short output unchanged for all strategies", () => {
		const short = "ok\nline2";
		for (const s of ["head", "tail", "smart", "none"] as const) {
			expect(truncateToolOutput(short, { strategy: s, maxBytes: 1000 })).toBe(short);
		}
	});

	it("head keeps prefix and marks truncation", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
		const out = truncateToolOutput(lines.join("\n"), { strategy: "head", maxLines: 10, maxBytes: 50_000 });
		expect(out).toContain("line-0");
		expect(out).toContain("lines omitted");
		expect(out).not.toContain("line-99");
	});

	it("tail keeps suffix", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
		const out = truncateToolOutput(lines.join("\n"), { strategy: "tail", maxLines: 10, maxBytes: 50_000 });
		expect(out).toContain("line-99");
		expect(out).toContain("lines omitted");
		expect(out).not.toContain("line-0");
	});

	it("smart retains ERROR/FAIL context when oversized", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `noise-${i}`);
		lines[80] = "ERROR: boom at step";
		lines[81] = "  at runner.ts:10";
		lines[150] = "FAIL test_foo";
		const out = truncateToolOutput(lines.join("\n"), {
			strategy: "smart",
			maxBytes: 500,
			maxLines: 20,
			preservePatterns: ["ERROR", "FAIL"],
		});
		expect(out).toMatch(/ERROR/);
		expect(out).toMatch(/FAIL/);
		expect(out.length).toBeLessThan(lines.join("\n").length);
	});

	it("smart without errors uses head+tail omit marker", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `ok-${i}`);
		const out = truncateToolOutput(lines.join("\n"), { strategy: "smart", maxBytes: 50_000, maxLines: 40 });
		expect(out).toContain("ok-0");
		expect(out).toContain("ok-99");
		expect(out).toContain("lines omitted");
	});

	it("none never truncates", () => {
		const big = "x".repeat(10_000);
		expect(truncateToolOutput(big, { strategy: "none", maxBytes: 10 })).toBe(big);
	});

	it("clamps by UTF-8 bytes for multi-byte text and ultra-long single line", () => {
		const multi = "你好😀".repeat(800);
		const maxBytes = 3000;
		expect(utf8ByteLength(multi)).toBeGreaterThan(maxBytes);
		const out = truncateToolOutput(multi, { strategy: "head", maxBytes, maxLines: 10_000 });
		expect(utf8ByteLength(out)).toBeLessThanOrEqual(maxBytes);

		const longLine = `prefix-${"中".repeat(5000)}-suffix`;
		const out2 = truncateToolOutput(longLine, { strategy: "tail", maxBytes: 500, maxLines: 10 });
		expect(utf8ByteLength(out2)).toBeLessThanOrEqual(500);
		expect(out2).toMatch(/suffix|truncated/);
	});
});

describe("summarizeToolOutput", () => {
	it("bash failure surfaces exit, first block, tail errors, failed tests, and reproduce command", () => {
		const output = [
			"running suite...",
			...Array.from({ length: 20 }, (_, i) => `log ${i}`),
			"FAIL packages/coding-agent/test/foo.test.ts > does the thing",
			"Error: expected true",
			"  at assert (test.ts:10)",
			...Array.from({ length: 10 }, (_, i) => `middle ${i}`),
			"× packages/coding-agent/test/bar.test.ts > other case",
			"Exception: boom in teardown",
			"Traceback (most recent call last):",
			"  File app.py, line 1",
		].join("\n");
		const summary = summarizeToolOutput(output, "bash", {
			exitCode: 1,
			command: "bun test packages/coding-agent/test/foo.test.ts",
		});
		expect(summary).toContain("Exit code: 1");
		expect(summary).toContain("Reproduce: bun test packages/coding-agent/test/foo.test.ts");
		expect(summary).toMatch(/First failure:/);
		expect(summary).toMatch(/FAIL packages\/coding-agent\/test\/foo/);
		expect(summary).toMatch(/Failed tests:/);
		expect(summary).toMatch(/foo\.test\.ts|bar\.test\.ts/);
		expect(summary).toMatch(/Exception|Traceback|Tail errors/);
		// Diagnostic summary is structured; for larger dumps it must stay bounded.
		expect(summary.split("\n").length).toBeLessThan(output.split("\n").length);
	});

	it("bash timeout marks exit and retains failure signal", () => {
		const output = "starting...\ntimed out after 30s\n";
		const summary = summarizeToolOutput(output, "bash", { exitCode: 124, timedOut: true, command: "sleep 999" });
		expect(summary).toContain("Exit code: 124");
		expect(summary).toContain("(timeout)");
		expect(summary).toContain("Reproduce: sleep 999");
		expect(summary).toMatch(/timed out|timeout/i);
	});

	it("bash success compresses pass lists to N tests passed (not full dump)", () => {
		const output = Array.from({ length: 200 }, (_, i) => `✓ pass test_${i} (1ms)`).join("\n");
		const summary = DEFAULT_SUMMARIZERS.bash!(output, "bash");
		expect(summary).toMatch(/Exit code: 0/);
		expect(summary).toMatch(/200 tests passed/);
		expect(summary.length).toBeLessThan(output.length / 4);
		// Must not enumerate every pass line
		expect(summary).not.toContain("test_50");
		expect(summary).not.toContain("test_199");
	});

	it("bash success keeps short signal head when non-pass content remains", () => {
		const output = [
			...Array.from({ length: 20 }, (_, i) => `✓ pass test_${i} (1ms)`),
			...Array.from({ length: 20 }, (_, i) => `signal ${i}`),
		].join("\n");
		const summary = DEFAULT_SUMMARIZERS.bash!(output, "bash");
		expect(summary).toMatch(/Exit code: 0/);
		expect(summary).toMatch(/signal 0/);
		expect(summary).toMatch(/tests passed|stripped|omitted/i);
		expect(summary.length).toBeLessThan(output.length);
	});

	it("test summarizer reuses bash failure-preserving path", () => {
		const output = "FAIL test/spec.ts > case a\nError: no\n";
		const summary = summarizeToolOutput(output, "test", { exitCode: 1, command: "bun test" });
		expect(summary).toContain("Exit code: 1");
		expect(summary).toContain("Reproduce: bun test");
		expect(summary).toMatch(/case a|FAIL/);
	});

	it("read summarizer retains body content (no metadata-only replacement)", () => {
		const content = Array.from({ length: 100 }, (_, i) => `const x${i} = 1;`).join("\n");
		const summary = summarizeToolOutput(content, "read", { path: "src/a.ts" });
		expect(summary).toContain("src/a.ts");
		expect(summary).toContain("100 lines");
		// Body must remain recoverable for the model — not path/size only.
		expect(summary).toContain("const x0 = 1;");
		expect(summary).toContain("const x99 = 1;");
	});

	it("preserves existing artifact footer through bash summarization (never double-strip)", () => {
		const output = `${"ok\n".repeat(30)}ERROR: boom\n[raw output: artifact://keep-me]`;
		const summary = summarizeToolOutput(output, "bash", { exitCode: 1 });
		expect(summary).toContain("[raw output: artifact://keep-me]");
		expect(summary.match(/\[raw output: artifact:\/\//g)?.length).toBe(1);
	});

	it("grep summarizer caps matches", () => {
		const matches = Array.from({ length: 30 }, (_, i) => `file.ts:${i}: hit`).join("\n");
		const summary = summarizeToolOutput(matches, "grep");
		expect(summary).toContain("30 matches");
		expect(summary).toContain("file.ts:0:");
		expect(summary.split("\n").length).toBeLessThan(20);
	});

	it("ls summarizer extracts names", () => {
		const ls = "-rw-r--r-- 1 u g 10 Jan 1 a.ts\n-rw-r--r-- 1 u g 10 Jan 1 b.ts";
		const summary = summarizeToolOutput(ls, "ls");
		expect(summary).toContain("2 items");
		expect(summary).toContain("a.ts");
		expect(summary).toContain("b.ts");
	});
});

describe("processToolOutput / processToolOutputDetailed", () => {
	it("applies summarization then truncation for bash", () => {
		const huge = `${"pass ok\n".repeat(200)}ERROR: last\n`;
		const out = processToolOutput(huge, "bash", strategy, { exitCode: 1 });
		expect(out.length).toBeLessThan(huge.length);
		expect(out).toMatch(/ERROR|Exit code/);
	});

	it("returns original when strategy disabled", () => {
		const text = "full output";
		expect(processToolOutput(text, "bash", { outputTruncation: { enabled: false, rules: [] } })).toBe(text);
		expect(processToolOutput(text, "bash", undefined)).toBe(text);
	});

	it("preserves existing [raw output: artifact://] footer through bash summarization", () => {
		const huge = `${"ok line\n".repeat(200)}ERROR: boom\n[raw output: artifact://42]`;
		const out = processToolOutput(huge, "bash", strategy, { exitCode: 1 });
		expect(out).toContain("[raw output: artifact://42]");
		expect(out).toMatch(/ERROR|Exit code/);
		const detailed = processToolOutputDetailed(huge, "bash", strategy, { exitCode: 1 });
		expect(detailed.receipt?.recoveryUri).toBe("artifact://42");
		expect(detailed.receipt?.reversible).toBe(true);
	});

	it("read processToolOutput keeps body and does not invent recovery URI without adapter", () => {
		const content = Array.from({ length: 200 }, (_, i) => `line ${i} with body`).join("\n");
		const detailed = processToolOutputDetailed(content, "read", strategy, { path: "src/x.ts" });
		expect(detailed.text).toContain("line 0 with body");
		expect(detailed.receipt?.recoveryUri).toBeUndefined();
		// Truncation may apply but body is not replaced with metadata-only text
		expect(detailed.text).not.toMatch(/^Read src\/x\.ts: \d+ lines, \d+ bytes \(use 'grep'/);
	});

	it("never fabricates recovery URI when no footer existed and no adapter", () => {
		const huge = `${"pass ok\n".repeat(200)}ERROR: last\n`;
		const detailed = processToolOutputDetailed(huge, "bash", strategy, { exitCode: 1 });
		expect(detailed.receipt?.recoveryUri).toBeUndefined();
		expect(detailed.text).not.toContain("[raw output: artifact://");
	});

	it("lossy path with saveRaw success attaches real footer and recoveryUri", () => {
		const huge = `${"noise line\n".repeat(100)}ERROR: compile failed\n`;
		const saved = new Map<string, string>();
		const adapter: ToolOutputArtifactAdapter = {
			saveRaw: (tool, text) => {
				const id = `id-${tool}`;
				saved.set(id, text);
				return id;
			},
		};
		const detailed = processToolOutputDetailed(huge, "bash", strategy, { exitCode: 1 }, adapter);
		expect(detailed.text).toContain("[raw output: artifact://id-bash]");
		expect(detailed.receipt?.recoveryUri).toBe("artifact://id-bash");
		expect(detailed.receipt?.reversible).toBe(true);
		expect(saved.get("id-bash")).toBe(huge);
		expect(detailed.receipt?.originalSha256).toBe(sha256Hex(huge));
	});

	it("lossy path with saveRaw failure never invents URI", () => {
		const huge = `${"noise line\n".repeat(100)}ERROR: compile failed\n`;
		const detailed = processToolOutputDetailed(huge, "bash", strategy, { exitCode: 1 }, { saveRaw: () => undefined });
		expect(detailed.text).not.toMatch(/artifact:\/\//);
		expect(detailed.receipt?.recoveryUri).toBeUndefined();
		expect(detailed.receipt?.reversible).toBe(false);
		// Still retains failure diagnostics after conservative path
		expect(detailed.text).toMatch(/Exit code|ERROR/);
	});

	it("receipt on lossy transform includes required fields", () => {
		const huge = `${"ok\n".repeat(80)}ERROR: x\n`;
		const detailed = processToolOutputDetailed(
			huge,
			"bash",
			strategy,
			{ exitCode: 1 },
			{
				saveRaw: () => "recv-1",
			},
		);
		const r = detailed.receipt;
		expect(r).toBeDefined();
		expect(r!.schemaVersion).toBe(TOOL_OPTIMIZATION_RECEIPT_VERSION);
		expect(r!.kind).toBe(TOOL_OPTIMIZATION_RECEIPT_KIND);
		expect(r!.tool).toBe("bash");
		expect(r!.transform).toMatch(/summarize|truncate/);
		expect(r!.originalBytes).toBe(utf8ByteLength(huge));
		expect(r!.originalLines).toBe(huge.split("\n").length);
		expect(r!.visibleBytes).toBe(utf8ByteLength(detailed.text));
		expect(r!.visibleLines).toBeGreaterThan(0);
		expect(r!.originalSha256).toBe(sha256Hex(huge));
		expect(r!.visibleSha256).toBe(sha256Hex(detailed.text));
		expect(Array.isArray(r!.omittedRanges)).toBe(true);
		expect(r!.recoveryUri).toBe("artifact://recv-1");
		expect(r!.reversible).toBe(true);
		expect(typeof r!.createdAt).toBe("string");
	});
});

describe("integration: shipped process path contracts", () => {
	it("read of >300-line fixture returns usable body content (not path/metadata stub)", () => {
		const body = Array.from({ length: 350 }, (_, i) => `export const item${i} = ${i}; // content line`).join("\n");
		expect(body.split("\n").length).toBeGreaterThan(300);

		const detailed = processToolOutputDetailed(body, "read", strategy, {
			path: "packages/coding-agent/src/fixture-large.ts",
		});

		// Multiple real content lines visible — not metadata-only
		expect(detailed.text).toContain("export const item0 = 0;");
		expect(detailed.text).toContain("export const item10 = 10;");
		// Bounded truncation may shrink, but remaining text is still body
		const contentHits = (detailed.text.match(/export const item\d+/g) ?? []).length;
		expect(contentHits).toBeGreaterThanOrEqual(5);
		// Forbidden: old body-zeroing contract
		expect(detailed.text).not.toMatch(/^Read packages\/coding-agent\/src\/fixture-large\.ts: \d+ lines, \d+ bytes$/);
		expect(detailed.text).not.toMatch(/use ['"]grep['"] to search/);
	});

	it("failed bash/test-like output retains exit code and diagnostic content", () => {
		const failOut = [
			"bun test v1.0",
			...Array.from({ length: 50 }, (_, i) => `(pass) suite > ok_${i}`),
			"(fail) suite > broken_case",
			"error: expect(received).toBe(expected)",
			"Expected: 1",
			"Received: 0",
			"  at packages/coding-agent/test/broken.test.ts:42",
			"  tests 1 fail, 50 pass",
		].join("\n");

		const detailed = processToolOutputDetailed(
			failOut,
			"bash",
			strategy,
			{ exitCode: 1, command: "bun test packages/coding-agent/test/broken.test.ts" },
			{ saveRaw: () => "fail-art-1" },
		);

		expect(detailed.text).toContain("Exit code: 1");
		expect(detailed.text).toContain("Reproduce: bun test packages/coding-agent/test/broken.test.ts");
		expect(detailed.text).toMatch(/broken_case|error:|Expected:|Received:/);
		expect(detailed.text).toContain("[raw output: artifact://fail-art-1]");
		expect(detailed.receipt?.recoveryUri).toBe("artifact://fail-art-1");
		expect(detailed.receipt?.tool).toBe("bash");
		expect(detailed.receipt?.originalSha256).toBe(sha256Hex(failOut));
	});

	it("multi-block errors keep first failure and tail error diagnostics", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `noise-${i}`);
		lines[5] = "ERROR: first block start";
		lines[6] = "  detail A";
		lines[40] = "FAIL test/second.spec.ts > later case";
		lines[55] = "Exception: final tail";
		const out = processToolOutputDetailed(lines.join("\n"), "bash", strategy, { exitCode: 2 });
		expect(out.text).toContain("Exit code: 2");
		expect(out.text).toMatch(/first block|ERROR/);
		expect(out.text).toMatch(/Exception|later case|FAIL/);
	});
});

describe("buildToolOptimizationReceipt", () => {
	it("marks reversible when recoveryUri present or preserve_body", () => {
		const withUri = buildToolOptimizationReceipt({
			tool: "bash",
			transform: "summarize",
			original: "abcdefghij",
			visible: "ab",
			recoveryUri: "artifact://x",
		});
		expect(withUri.reversible).toBe(true);
		expect(withUri.recoveryUri).toBe("artifact://x");

		const preserve = buildToolOptimizationReceipt({
			tool: "read",
			transform: "preserve_body",
			original: "body",
			visible: "body",
		});
		expect(preserve.reversible).toBe(true);
		expect(preserve.recoveryUri).toBeUndefined();
	});
});

describe("processToolOutputDetailedAsync + ordinary defaults", () => {
	it("awaits saveRaw and attaches recovery URI", async () => {
		const huge = `${"noise line\n".repeat(100)}ERROR: compile failed\n`;
		const saved = new Map<string, string>();
		const adapter: ToolOutputArtifactAdapter = {
			saveRaw: async (tool, text) => {
				const id = `async-${tool}`;
				saved.set(id, text);
				return id;
			},
		};
		const detailed = await processToolOutputDetailedAsync(huge, "bash", strategy, { exitCode: 1 }, adapter);
		expect(detailed.text).toContain("[raw output: artifact://async-bash]");
		expect(detailed.receipt?.recoveryUri).toBe("artifact://async-bash");
		expect(detailed.receipt?.reversible).toBe(true);
		expect(saved.get("async-bash")).toBe(huge);
	});

	it("fails closed to original text when lossy without recovery", async () => {
		const huge = `${"noise line\n".repeat(100)}ERROR: compile failed\n`;
		const detailed = await processToolOutputDetailedAsync(
			huge,
			"bash",
			strategy,
			{ exitCode: 1 },
			{
				saveRaw: async () => undefined,
			},
		);
		expect(detailed.text).toBe(huge);
		expect(detailed.receipt).toBeUndefined();
	});

	it("built-in ordinary profiles disable resultSummarization by default", () => {
		for (const profile of Object.values(DEFAULT_MODEL_OPTIMIZATION_PROFILES)) {
			expect(profile.toolStrategy?.resultSummarization?.enabled).toBe(false);
			expect(profile.toolStrategy?.outputTruncation?.enabled).toBe(true);
		}
	});

	it("ordinary default profile truncation still works without summarizer", async () => {
		const profile = DEFAULT_MODEL_OPTIMIZATION_PROFILES.claude;
		const huge = Array.from({ length: 200 }, (_, i) => `line ${i} content body`).join("\n");
		const detailed = await processToolOutputDetailedAsync(
			huge,
			"read",
			profile.toolStrategy,
			{ path: "src/x.ts" },
			{ saveRaw: async () => "ord-1" },
		);
		expect(detailed.text.length).toBeLessThan(huge.length);
		expect(detailed.text).toContain("[raw output: artifact://ord-1]");
		expect(detailed.receipt?.recoveryUri).toBe("artifact://ord-1");
		// Without summarizer, body content remains (not metadata-only).
		expect(detailed.text).toContain("line 0 content body");
	});

	it("skips truncation for explicit raw and range reads via path or file_path", async () => {
		const profile = DEFAULT_MODEL_OPTIMIZATION_PROFILES.claude;
		const huge = Array.from({ length: 200 }, (_, i) => `line ${i} content body`).join("\n");
		const viaPath = await processToolOutputDetailedAsync(
			huge,
			"read",
			profile.toolStrategy,
			{ path: "src/x.ts:raw" },
			{ saveRaw: async () => "raw-1" },
		);
		expect(viaPath.text).toBe(huge);
		expect(viaPath.receipt).toBeUndefined();

		const viaFilePath = await processToolOutputDetailedAsync(
			huge,
			"read",
			profile.toolStrategy,
			{ file_path: "src/x.ts:10-20" },
			{ saveRaw: async () => "range-1" },
		);
		expect(viaFilePath.text).toBe(huge);
		expect(viaFilePath.receipt).toBeUndefined();
	});

	it("summarization-only strategy still transforms when truncation is disabled", async () => {
		const huge = Array.from({ length: 80 }, (_, i) => `noise line ${i} ok 12ms`).join("\n");
		const strategy: ToolStrategy = {
			outputTruncation: { enabled: false, rules: [] },
			resultSummarization: { enabled: true, summarizerKeys: ["bash", "*"] },
		};
		const detailed = await processToolOutputDetailedAsync(
			huge,
			"bash",
			strategy,
			{ exitCode: 0, command: "echo ok" },
			{ saveRaw: async () => "sum-only" },
		);
		expect(detailed.text).not.toBe(huge);
		expect(detailed.receipt?.transform).toBe("summarize");
		expect(detailed.receipt?.recoveryUri).toBe("artifact://sum-only");
	});
});

function ruleFor(rules: { toolName: string | string[]; maxBytes?: number; maxLines?: number }[], name: string) {
	return rules.find(rule => rule.toolName === name);
}

describe("ordinary truncation defaults vs conservative families", () => {
	it("raises ordinary family read/grep/star caps without widening DeepSeek or Sol", () => {
		const grok = DEFAULT_MODEL_OPTIMIZATION_PROFILES.grok.toolStrategy?.outputTruncation?.rules ?? [];
		const claude = DEFAULT_MODEL_OPTIMIZATION_PROFILES.claude.toolStrategy?.outputTruncation?.rules ?? [];
		expect(ruleFor(grok, "bash")).toEqual(expect.objectContaining({ maxBytes: 4000, maxLines: 80 }));
		expect(ruleFor(grok, "read")).toEqual(expect.objectContaining({ maxBytes: 8000, maxLines: 160 }));
		expect(ruleFor(grok, "grep")).toEqual(expect.objectContaining({ maxBytes: 8000, maxLines: 120 }));
		expect(ruleFor(grok, "*")).toEqual(expect.objectContaining({ maxBytes: 4000, maxLines: 80 }));
		expect(ruleFor(claude, "grep")).toEqual(expect.objectContaining({ maxBytes: 8000, maxLines: 120 }));
		expect(DEFAULT_TRUNCATION_RULES.find(r => r.toolName === "read")).toEqual(
			expect.objectContaining({ maxBytes: 8000, maxLines: 160 }),
		);

		const deepseek = DEFAULT_MODEL_OPTIMIZATION_PROFILES.deepseek.toolStrategy?.outputTruncation?.rules ?? [];
		const sol = DEFAULT_MODEL_OPTIMIZATION_PROFILES.sol.toolStrategy?.outputTruncation?.rules ?? [];
		expect(ruleFor(deepseek, "bash")).toEqual(expect.objectContaining({ maxBytes: 1500, maxLines: 30 }));
		expect(ruleFor(deepseek, "grep")).toEqual(expect.objectContaining({ maxBytes: 3000, maxLines: 40 }));
		expect(ruleFor(sol, "bash")).toEqual(expect.objectContaining({ maxBytes: 2000, maxLines: 40 }));
		expect(ruleFor(sol, "grep")).toEqual(expect.objectContaining({ maxBytes: 3000, maxLines: 40 }));
	});

	it("clamps only the read rule for subagents and leaves grep/bash unchanged", () => {
		const parent = DEFAULT_MODEL_OPTIMIZATION_PROFILES.grok.toolStrategy;
		const clamped = withSubagentReadClamp(parent);
		expect(clamped).not.toBe(parent);
		expect(ruleFor(clamped?.outputTruncation?.rules ?? [], "read")).toEqual(
			expect.objectContaining({
				maxBytes: SUBAGENT_READ_TRUNCATION_RULE.maxBytes,
				maxLines: SUBAGENT_READ_TRUNCATION_RULE.maxLines,
			}),
		);
		expect(ruleFor(clamped?.outputTruncation?.rules ?? [], "grep")).toEqual(
			ruleFor(parent?.outputTruncation?.rules ?? [], "grep"),
		);
		expect(ruleFor(clamped?.outputTruncation?.rules ?? [], "bash")).toEqual(
			ruleFor(parent?.outputTruncation?.rules ?? [], "bash"),
		);

		const deepseek = DEFAULT_MODEL_OPTIMIZATION_PROFILES.deepseek.toolStrategy;
		const deepseekClamped = withSubagentReadClamp(deepseek);
		expect(ruleFor(deepseekClamped?.outputTruncation?.rules ?? [], "read")).toEqual(
			ruleFor(deepseek?.outputTruncation?.rules ?? [], "read"),
		);

		const disabled = withSubagentReadClamp({
			outputTruncation: { enabled: false, rules: DEFAULT_TRUNCATION_RULES },
		});
		expect(disabled?.outputTruncation?.enabled).toBe(false);
	});
});
