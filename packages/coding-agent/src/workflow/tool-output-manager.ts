import type { ToolOutputTruncationRule, ToolStrategy, TruncationStrategy } from "./types";

const DEFAULT_MAX_BYTES = 4000;
const DEFAULT_MAX_LINES = 50;
const ERROR_LINE_RE = /error|fail|exception|traceback/i;
const DEFAULT_PRESERVE = ["ERROR", "FAIL", "Exception", "Traceback"];

export type SummarizerFn = (output: string, toolName: string, args?: unknown) => string;

export interface TruncateOptions {
	strategy: TruncationStrategy;
	maxBytes?: number;
	maxLines?: number;
	preservePatterns?: string[];
}

/**
 * Truncate tool output by strategy.
 * - head: keep first maxBytes/maxLines
 * - tail: keep last maxBytes/maxLines
 * - smart: prefer error context; else head+tail with omit marker
 * - none: return as-is
 */
export function truncateToolOutput(output: string, options: TruncateOptions): string {
	if (options.strategy === "none" || output.length === 0) return output;

	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const lines = output.split("\n");

	if (options.strategy === "head") {
		return clampBytes(clampLines(lines, maxLines, "head").join("\n"), maxBytes, "head");
	}
	if (options.strategy === "tail") {
		return clampBytes(clampLines(lines, maxLines, "tail").join("\n"), maxBytes, "tail");
	}
	if (options.strategy === "smart") {
		return smartTruncate(output, lines, maxBytes, maxLines, options.preservePatterns);
	}
	return output;
}

function clampLines(lines: string[], maxLines: number, mode: "head" | "tail"): string[] {
	if (lines.length <= maxLines) return lines;
	if (mode === "head") {
		return [...lines.slice(0, maxLines), `... [${lines.length - maxLines} lines omitted] ...`];
	}
	return [`... [${lines.length - maxLines} lines omitted] ...`, ...lines.slice(-maxLines)];
}

function clampBytes(text: string, maxBytes: number, mode: "head" | "tail"): string {
	if (text.length <= maxBytes) return text;
	if (mode === "head") {
		return `${text.slice(0, Math.max(0, maxBytes - 20))}\n/* truncated */`;
	}
	return `/* truncated */\n${text.slice(-Math.max(0, maxBytes - 20))}`;
}

function smartTruncate(
	output: string,
	lines: string[],
	maxBytes: number,
	maxLines: number,
	preservePatterns?: string[],
): string {
	if (output.length <= maxBytes && lines.length <= maxLines) return output;

	const patterns = preservePatterns?.length
		? preservePatterns.map(p => new RegExp(escapeRegExp(p), "i"))
		: [ERROR_LINE_RE];

	const errorIndexes: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (patterns.some(re => re.test(line))) errorIndexes.push(i);
	}

	if (errorIndexes.length > 0) {
		const preserved = new Set<number>();
		for (const idx of errorIndexes) {
			for (let i = Math.max(0, idx - 3); i <= Math.min(lines.length - 1, idx + 3); i++) {
				preserved.add(i);
			}
		}
		const ordered = [...preserved].sort((a, b) => a - b);
		const parts: string[] = [];
		let prev = -2;
		for (const idx of ordered) {
			if (idx > prev + 1 && prev >= 0) {
				parts.push("... [context omitted] ...");
			}
			parts.push(lines[idx] ?? "");
			prev = idx;
		}
		let result = parts.join("\n");
		if (result.length > maxBytes) {
			// Still oversized: keep error-bearing lines first, then clamp.
			const errorOnly = errorIndexes.map(i => lines[i] ?? "").join("\n");
			result = errorOnly.length <= maxBytes ? errorOnly : clampBytes(errorOnly, maxBytes, "head");
		}
		return result;
	}

	// No errors: head + tail
	const headCount = Math.min(20, Math.floor(maxLines / 2));
	const tailCount = Math.min(20, maxLines - headCount);
	if (lines.length <= headCount + tailCount) {
		return clampBytes(output, maxBytes, "head");
	}
	const head = lines.slice(0, headCount).join("\n");
	const tail = lines.slice(-tailCount).join("\n");
	const omitted = lines.length - headCount - tailCount;
	const combined = `${head}\n\n... [${omitted} lines omitted] ...\n\n${tail}`;
	return combined.length <= maxBytes ? combined : clampBytes(combined, maxBytes, "head");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve truncation rule for a tool from profile strategy (exact match wins over *). */
export function resolveTruncationRule(
	toolName: string,
	strategy: ToolStrategy | undefined,
): ToolOutputTruncationRule | null {
	if (!strategy?.outputTruncation?.enabled) return null;
	const rules = strategy.outputTruncation.rules;
	let wildcard: ToolOutputTruncationRule | null = null;
	for (const rule of rules) {
		const names = Array.isArray(rule.toolName) ? rule.toolName : [rule.toolName];
		if (names.includes(toolName)) return rule;
		if (!wildcard && names.includes("*")) wildcard = rule;
	}
	return wildcard;
}

export const DEFAULT_SUMMARIZERS: Record<string, SummarizerFn> = {
	bash: (output, _tool, args) => {
		const lines = output.split("\n");
		const errors = lines.filter(l => ERROR_LINE_RE.test(l));
		const exitFromArgs =
			args && typeof args === "object" && args !== null && "exitCode" in args
				? Number((args as { exitCode?: number }).exitCode)
				: undefined;
		const exitMatch = output.match(/exit\s*code[:\s]+(-?\d+)/i);
		const exitCode = exitFromArgs ?? (exitMatch ? Number(exitMatch[1]) : errors.length > 0 ? 1 : 0);
		if (errors.length > 0) {
			return `Exit code: ${exitCode}\nErrors (${errors.length}):\n${errors.slice(0, 10).join("\n")}`;
		}
		return `Exit code: ${exitCode}, ${lines.length} lines output (truncated)`;
	},

	read: (output, _tool, args) => {
		const lines = output.split("\n");
		const path =
			args && typeof args === "object" && args !== null
				? String(
						(args as { path?: string; file_path?: string }).path ??
							(args as { file_path?: string }).file_path ??
							"file",
					)
				: "file";
		return `Read ${path}: ${lines.length} lines, ${output.length} bytes (use 'grep' to search)`;
	},

	grep: output => {
		const matches = output.split("\n").filter(Boolean);
		if (matches.length === 0) return "No matches";
		if (matches.length <= 10) return output;
		return `${matches.length} matches (showing first 10):\n${matches.slice(0, 10).join("\n")}`;
	},

	test: output => {
		const passed = (output.match(/\bpass(?:ed|ing)?\b/gi) ?? []).length;
		const failed = (output.match(/\bfail(?:ed|ure|ing)?\b/gi) ?? []).length;
		const errors = output.split("\n").filter(l => ERROR_LINE_RE.test(l));
		return `Tests: ${passed} passed, ${failed} failed\n${errors.slice(0, 5).join("\n")}`.trim();
	},

	ls: output => {
		const lines = output.split("\n").filter(Boolean);
		const names = lines.map(l => l.trim().split(/\s+/).pop() ?? l);
		return `${lines.length} items:\n${names.join("\n")}`;
	},
};

export function summarizeToolOutput(
	output: string,
	toolName: string,
	args?: unknown,
	summarizers: Record<string, SummarizerFn> = DEFAULT_SUMMARIZERS,
): string {
	const key =
		toolName in summarizers ? toolName : toolName === "bash" || toolName.endsWith("test") ? toolName : toolName;
	const fn = summarizers[key] ?? summarizers[toolName];
	if (fn) return fn(output, toolName, args);
	// Heuristic: test-like tools
	if (/test/i.test(toolName) && summarizers.test) return summarizers.test(output, toolName, args);
	return output;
}

/**
 * Apply profile toolStrategy: optional summarization then truncation.
 * Returns original output when strategy disabled or empty.
 */
export function processToolOutput(
	output: string,
	toolName: string,
	toolStrategy: ToolStrategy | undefined,
	args?: unknown,
): string {
	if (!output || !toolStrategy) return output;

	let result = output;

	if (toolStrategy.resultSummarization?.enabled) {
		const keys = toolStrategy.resultSummarization.summarizerKeys;
		const allowed = !keys || keys.includes(toolName) || keys.includes("*");
		if (allowed) {
			const hasNamed = toolName in DEFAULT_SUMMARIZERS || /test/i.test(toolName);
			if (hasNamed || keys?.includes("*")) {
				result = summarizeToolOutput(result, toolName, args);
			}
		}
	}

	const rule = resolveTruncationRule(toolName, toolStrategy);
	if (rule) {
		result = truncateToolOutput(result, {
			strategy: rule.strategy,
			maxBytes: rule.maxBytes,
			maxLines: rule.maxLines,
			preservePatterns: rule.preservePatterns ?? DEFAULT_PRESERVE,
		});
	}

	return result;
}

/** Default smart truncation rules used by quality-first profiles. */
export const DEFAULT_TRUNCATION_RULES: ToolOutputTruncationRule[] = [
	{
		toolName: "bash",
		strategy: "smart",
		maxBytes: 4000,
		maxLines: 80,
		preservePatterns: ["ERROR", "FAIL", "Exception", "Traceback"],
	},
	{ toolName: "read", strategy: "smart", maxBytes: 6000, maxLines: 100 },
	{ toolName: "grep", strategy: "head", maxBytes: 3000, maxLines: 40 },
	{ toolName: "*", strategy: "head", maxBytes: 2000, maxLines: 50 },
];
