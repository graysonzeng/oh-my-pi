import { describe, expect, it } from "bun:test";
import {
	DEFAULT_SUMMARIZERS,
	DEFAULT_TRUNCATION_RULES,
	processToolOutput,
	processToolOutputDetailed,
	summarizeToolOutput,
	truncateToolOutput,
} from "../../src/workflow/tool-output-manager";
import type { ToolStrategy } from "../../src/workflow/types";

describe("truncateToolOutput", () => {
	it("returns short output unchanged for all strategies", () => {
		const short = "ok\nline2";
		for (const strategy of ["head", "tail", "smart", "none"] as const) {
			expect(truncateToolOutput(short, { strategy, maxBytes: 1000 })).toBe(short);
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
});

describe("summarizeToolOutput", () => {
	it("bash summarizer surfaces exit and errors", () => {
		const output = [
			"running...",
			...Array.from({ length: 40 }, (_, i) => `log ${i}`),
			"ERROR: missing file",
			"FAIL suite",
			"done",
		].join("\n");
		const summary = summarizeToolOutput(output, "bash", { exitCode: 1 });
		expect(summary).toContain("Exit code: 1");
		expect(summary).toMatch(/ERROR|FAIL/);
		expect(summary.length).toBeLessThan(output.length);
	});

	it("bash success keeps short signal head and strips progress noise", () => {
		const output = [
			...Array.from({ length: 20 }, (_, i) => `✓ pass test_${i} (1ms)`),
			...Array.from({ length: 20 }, (_, i) => `signal ${i}`),
		].join("\n");
		const summary = DEFAULT_SUMMARIZERS.bash!(output, "bash");
		expect(summary).toMatch(/Exit code: 0/);
		expect(summary).toMatch(/signal 0/);
		expect(summary).toMatch(/stripped|omitted/i);
		expect(summary.length).toBeLessThan(output.length);
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

describe("processToolOutput", () => {
	const strategy: ToolStrategy = {
		outputTruncation: {
			enabled: true,
			rules: DEFAULT_TRUNCATION_RULES,
		},
		resultSummarization: {
			enabled: true,
			summarizerKeys: ["bash", "read", "*"],
		},
	};

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

	it("read processToolOutput keeps body and does not invent recovery URI", () => {
		const content = Array.from({ length: 200 }, (_, i) => `line ${i} with body`).join("\n");
		const detailed = processToolOutputDetailed(content, "read", strategy, { path: "src/x.ts" });
		expect(detailed.text).toContain("line 0 with body");
		expect(detailed.receipt?.recoveryUri).toBeUndefined();
		// Truncation may apply but body is not replaced with metadata-only text
		expect(detailed.text).not.toMatch(/^Read src\/x\.ts: \d+ lines, \d+ bytes \(use 'grep'/);
	});

	it("never fabricates recovery URI when no footer existed", () => {
		const huge = `${"pass ok\n".repeat(200)}ERROR: last\n`;
		const detailed = processToolOutputDetailed(huge, "bash", strategy, { exitCode: 1 });
		expect(detailed.receipt?.recoveryUri).toBeUndefined();
		expect(detailed.text).not.toMatch(/artifact:\/\/(?!.*\])/); // no fake artifact footer
		expect(detailed.text).not.toContain("[raw output: artifact://");
	});
});
