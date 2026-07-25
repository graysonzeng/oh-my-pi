import {
	buildToolOptimizationReceipt,
	extractRawOutputFooter,
	preserveRawOutputFooter,
	type ToolOptimizationReceiptV1,
	type ToolOptimizationTransform,
	type ToolOutputArtifactAdapter,
	type WorkflowToolOptimizationResult,
} from "./optimization-receipt";
import type { ToolOutputTruncationRule, ToolStrategy, TruncationStrategy } from "./types";

/** UTF-8 byte length (not JS UTF-16 code units). */
export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

const DEFAULT_MAX_BYTES = 4000;
const DEFAULT_MAX_LINES = 50;
const ERROR_LINE_RE = /error|fail|exception|traceback/i;
const DEFAULT_PRESERVE = ["ERROR", "FAIL", "Exception", "Traceback"];
/** Failure-signal patterns retained for bash/test failure summaries. */
const FAILURE_SIGNAL_RE =
	/error|fail|exception|traceback|assert|expected|timeout|timed out|exit code|ENOENT|EACCES|TypeError|ReferenceError/i;

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

/**
 * Largest exclusive end index ≤ max such that buf[0..end) is valid UTF-8
 * (no truncated multi-byte sequences / replacement characters).
 */
function utf8SafeEnd(buf: Buffer, max: number): number {
	let end = Math.min(Math.max(0, max), buf.length);
	while (end > 0) {
		const slice = buf.subarray(0, end);
		if (Buffer.byteLength(slice.toString("utf-8"), "utf-8") === end) return end;
		end--;
	}
	return 0;
}

/**
 * Smallest start index ≥ min such that buf[start..) is valid UTF-8.
 */
function utf8SafeStart(buf: Buffer, min: number): number {
	let start = Math.min(Math.max(0, min), buf.length);
	while (start < buf.length) {
		const slice = buf.subarray(start);
		if (Buffer.byteLength(slice.toString("utf-8"), "utf-8") === slice.length) return start;
		start++;
	}
	return buf.length;
}

/**
 * Clamp text to at most `maxBytes` UTF-8 bytes (not JS string length).
 * Cuts on code-point boundaries safely by validating the byte slice.
 */
function clampBytes(text: string, maxBytes: number, mode: "head" | "tail"): string {
	const total = utf8ByteLength(text);
	if (total <= maxBytes) return text;
	const marker = mode === "head" ? "\n/* truncated */" : "/* truncated */\n";
	const markerBytes = utf8ByteLength(marker);
	const contentBudget = Math.max(0, maxBytes - markerBytes);
	const buf = Buffer.from(text, "utf-8");
	if (mode === "head") {
		const end = utf8SafeEnd(buf, contentBudget);
		return `${buf.subarray(0, end).toString("utf-8")}${marker}`;
	}
	const start = utf8SafeStart(buf, buf.length - contentBudget);
	return `${marker}${buf.subarray(start).toString("utf-8")}`;
}

function smartTruncate(
	output: string,
	lines: string[],
	maxBytes: number,
	maxLines: number,
	preservePatterns?: string[],
): string {
	if (utf8ByteLength(output) <= maxBytes && lines.length <= maxLines) return output;

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
		if (utf8ByteLength(result) > maxBytes) {
			// Still oversized: keep error-bearing lines first, then clamp.
			const errorOnly = errorIndexes.map(i => lines[i] ?? "").join("\n");
			result = utf8ByteLength(errorOnly) <= maxBytes ? errorOnly : clampBytes(errorOnly, maxBytes, "head");
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
	return utf8ByteLength(combined) <= maxBytes ? combined : clampBytes(combined, maxBytes, "head");
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

const PROGRESS_NOISE_RE =
	/^\s*(?:✓|✔|√|●|○|◌|·|\*|[-|\\/])\s|^\s*\d+%|\b(?:PASS(?:ED)?|ok)\b.*\b(?:ms|s)\b|Downloading|Installing|Compiling|Building\s+\.\.\./i;

function resolveExitCode(output: string, args?: unknown, hadErrors = false): number {
	const exitFromArgs =
		args && typeof args === "object" && args !== null && "exitCode" in args
			? Number((args as { exitCode?: number }).exitCode)
			: undefined;
	const exitMatch = output.match(/exit\s*code[:\s]+(-?\d+)/i);
	return exitFromArgs ?? (exitMatch ? Number(exitMatch[1]) : hadErrors ? 1 : 0);
}

/** Summarize bash while keeping failure blocks + recovery footer intact via processToolOutput. */
function summarizeBash(output: string, _tool: string, args?: unknown): string {
	const { body, footer } = extractRawOutputFooter(output);
	const lines = body.split("\n");
	const errorLines = lines.filter(l => FAILURE_SIGNAL_RE.test(l));
	const exitCode = resolveExitCode(body, args, errorLines.length > 0);
	const timedOut =
		(args && typeof args === "object" && args !== null && (args as { timedOut?: boolean }).timedOut === true) ||
		/timed out|timeout/i.test(body);

	if (errorLines.length > 0 || exitCode !== 0 || timedOut) {
		// Failure: exit code, first failure block, tail errors, failed test names, recovery.
		const firstFailIdx = lines.findIndex(l => FAILURE_SIGNAL_RE.test(l));
		const firstBlock =
			firstFailIdx >= 0 ? lines.slice(firstFailIdx, Math.min(lines.length, firstFailIdx + 8)).join("\n") : "";
		const tailErrors = errorLines.slice(-5).join("\n");
		const failedTests = lines
			.filter(l => /\b(?:FAIL|failed|×|✗)\b/i.test(l) && /test|spec|it\(|describe/i.test(l))
			.slice(0, 8);
		const parts = [
			`Exit code: ${exitCode}${timedOut ? " (timeout)" : ""}`,
			firstBlock ? `First failure:\n${firstBlock}` : "",
			tailErrors && tailErrors !== firstBlock ? `Tail errors:\n${tailErrors}` : "",
			failedTests.length > 0 ? `Failed tests:\n${failedTests.join("\n")}` : "",
		].filter(Boolean);
		const summary = parts.join("\n");
		return footer ? `${summary}\n${footer}` : summary;
	}

	// Success: RTK-style drop progress/pass noise; keep short head+tail of signal.
	const signal = lines.filter(l => l.trim() && !PROGRESS_NOISE_RE.test(l));
	const dropped = lines.length - signal.length;
	if (signal.length === 0) {
		const empty = `Exit code: ${exitCode}, ${lines.length} lines output (noise stripped)`;
		return footer ? `${empty}\n${footer}` : empty;
	}
	const head = signal.slice(0, 8);
	const tail = signal.length > 12 ? signal.slice(-4) : [];
	const bodyLines =
		tail.length > 0 ? [...head, `... [${signal.length - 12} signal lines omitted] ...`, ...tail] : head;
	const suffix = dropped > 0 ? `\n(${dropped} progress/pass lines stripped)` : "";
	const summary = `Exit code: ${exitCode}\n${bodyLines.join("\n")}${suffix}`;
	return footer ? `${summary}\n${footer}` : summary;
}

/**
 * Read: never zero the body. Keep content; range/offset already applied by the tool.
 * Only bounded truncation is applied later via toolStrategy rules.
 */
function summarizeRead(output: string, _tool: string, args?: unknown): string {
	const path =
		args && typeof args === "object" && args !== null
			? String(
					(args as { path?: string; file_path?: string }).path ??
						(args as { file_path?: string }).file_path ??
						"file",
				)
			: "file";
	const lines = output.split("\n");
	// Header + body: models need the content, not only path/size metadata.
	return `Read ${path}: ${lines.length} lines, ${output.length} bytes\n${output}`;
}

export const DEFAULT_SUMMARIZERS: Record<string, SummarizerFn> = {
	bash: summarizeBash,

	read: summarizeRead,

	grep: output => {
		const matches = output.split("\n").filter(Boolean);
		if (matches.length === 0) return "No matches";
		if (matches.length <= 10) return output;
		return `${matches.length} matches (showing first 10):\n${matches.slice(0, 10).join("\n")}`;
	},

	test: (output, _tool, args) => {
		// Reuse bash failure-preserving path for test runners (footer preserved).
		return summarizeBash(output, "test", args);
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
	const fn = summarizers[toolName];
	if (fn) return fn(output, toolName, args);
	// Heuristic: test-like tools share the test summarizer.
	if (/test/i.test(toolName) && summarizers.test) return summarizers.test(output, toolName, args);
	return output;
}

/**
 * Apply profile toolStrategy: optional summarization then truncation.
 * Always re-attaches an existing `[raw output: artifact://…]` footer when present
 * on the original text so bash/test recovery links survive summarization.
 * When lossy and no footer exists, optionally persists full text via `artifact.saveRaw`
 * before returning; never invents a recovery URI when save fails or is absent.
 */
export function processToolOutputDetailed(
	output: string,
	toolName: string,
	toolStrategy: ToolStrategy | undefined,
	args?: unknown,
	artifact?: ToolOutputArtifactAdapter,
): WorkflowToolOptimizationResult {
	if (!output || !toolStrategy) {
		return { text: output };
	}

	const original = output;
	let result = output;
	let didSummarize = false;
	let didTruncate = false;

	if (toolStrategy.resultSummarization?.enabled) {
		const keys = toolStrategy.resultSummarization.summarizerKeys;
		const allowed = !keys || keys.includes(toolName) || keys.includes("*");
		if (allowed) {
			// read: skip body-zeroing summarizer; keep content for range/truncation only.
			if (toolName === "read") {
				// no-op summarization — body retained; truncation rule still applies
			} else {
				const hasNamed = toolName in DEFAULT_SUMMARIZERS || /test/i.test(toolName);
				if (hasNamed || keys?.includes("*")) {
					const summarized = summarizeToolOutput(result, toolName, args);
					if (summarized !== result) didSummarize = true;
					result = summarized;
				}
			}
		}
	}

	const rule = resolveTruncationRule(toolName, toolStrategy);
	if (rule) {
		// Strip footer before byte/line clamps so the footer is not counted as content,
		// then re-attach after.
		const { body, footer } = extractRawOutputFooter(result);
		const truncated = truncateToolOutput(body, {
			strategy: rule.strategy,
			maxBytes: rule.maxBytes,
			maxLines: rule.maxLines,
			preservePatterns: rule.preservePatterns ?? DEFAULT_PRESERVE,
		});
		if (truncated !== body) didTruncate = true;
		result = footer ? `${truncated}${truncated.endsWith("\n") ? "" : "\n"}${footer}` : truncated;
	}

	// Defense in depth: re-attach original recovery footer if any transform dropped it.
	result = preserveRawOutputFooter(original, result);

	if (!didSummarize && !didTruncate && result === original) {
		return { text: result };
	}

	let transform: ToolOptimizationTransform = "none";
	if (toolName === "read" && !didSummarize && didTruncate) transform = "truncate";
	else if (toolName === "read" && !didSummarize && !didTruncate) transform = "preserve_body";
	else if (didSummarize && didTruncate) transform = "summarize+truncate";
	else if (didSummarize) transform = "summarize";
	else if (didTruncate) transform = "truncate";

	const existing = extractRawOutputFooter(result);
	let recoveryUri = existing.artifactId ? `artifact://${existing.artifactId}` : undefined;

	// Lossy + no pre-existing footer → try to persist original before the model sees the shrink.
	const lossy = result !== original || transform !== "none";
	if (lossy && !recoveryUri && artifact?.saveRaw) {
		const saved = artifact.saveRaw(toolName, original);
		// Sync path only — ignore Promise (processResult is sync).
		if (typeof saved === "string" && saved.length > 0) {
			const footer = `[raw output: artifact://${saved}]`;
			const sep = result.endsWith("\n") ? "" : "\n";
			result = `${result}${sep}${footer}`;
			recoveryUri = `artifact://${saved}`;
		}
	}

	const receipt: ToolOptimizationReceiptV1 = buildToolOptimizationReceipt({
		tool: toolName,
		transform,
		original,
		visible: result,
		recoveryUri,
	});

	// If lossy and no recovery URI, mark non-reversible (conservative truncate already applied).
	if ((utf8ByteLength(result) < utf8ByteLength(original) || lossy) && !recoveryUri) {
		receipt.reversible = false;
	}

	return { text: result, receipt };
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
	artifact?: ToolOutputArtifactAdapter,
): string {
	return processToolOutputDetailed(output, toolName, toolStrategy, args, artifact).text;
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
