import { readPathFromToolArgs, shouldPreserveExplicitReadRange } from "../tools/read-selector";
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

/** Pass/ok line shapes used to count successful tests for compressed success summaries. */
const PASS_LINE_RE =
	/^\s*(?:✓|✔|√|●)\s|\b(?:PASS(?:ED)?|pass(?:ed)?|ok)\b.*\b(?:ms|s)\b|^\s*(?:pass|ok|passed)\b|\(\s*pass\s*\)/i;

/** Lines that name a failed test case (not just any ERROR log). */
const FAILED_TEST_LINE_RE = /\b(?:FAIL|failed|×|✗)\b/i;

function resolveExitCode(output: string, args?: unknown, hadErrors = false): number {
	const exitFromArgs =
		args && typeof args === "object" && args !== null && "exitCode" in args
			? Number((args as { exitCode?: number }).exitCode)
			: undefined;
	const exitMatch = output.match(/exit\s*code[:\s]+(-?\d+)/i);
	return exitFromArgs ?? (exitMatch ? Number(exitMatch[1]) : hadErrors ? 1 : 0);
}

function resolveCommand(args?: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const rec = args as { command?: unknown; cmd?: unknown };
	const raw = rec.command ?? rec.cmd;
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	// Bound so a multi-kilobyte command string does not explode the summary.
	return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}

function extractFailedTestNames(lines: string[]): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		if (!FAILED_TEST_LINE_RE.test(line)) continue;
		// Prefer lines that look like test identity (path, suite, it/describe, (fail)).
		const looksLikeTest =
			/test|spec|it\(|describe|\(fail\)|›|>|::|\.ts|\.js|\.py/i.test(line) || /^\s*(?:×|✗|FAIL)\b/i.test(line);
		if (!looksLikeTest) continue;
		const key = line.trim();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		names.push(key);
		if (names.length >= 8) break;
	}
	return names;
}

function countPassedTests(lines: string[]): number {
	let n = 0;
	for (const line of lines) {
		if (line.trim() && PASS_LINE_RE.test(line)) n++;
	}
	return n;
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
	const command = resolveCommand(args);

	if (errorLines.length > 0 || exitCode !== 0 || timedOut) {
		// Failure: exit code, first failure block, tail errors, failed test names, reproduce cmd.
		const firstFailIdx = lines.findIndex(l => FAILURE_SIGNAL_RE.test(l));
		const firstBlock =
			firstFailIdx >= 0 ? lines.slice(firstFailIdx, Math.min(lines.length, firstFailIdx + 8)).join("\n") : "";
		const tailErrors = errorLines.slice(-5).join("\n");
		const failedTests = extractFailedTestNames(lines);
		const parts = [
			`Exit code: ${exitCode}${timedOut ? " (timeout)" : ""}`,
			command ? `Reproduce: ${command}` : "",
			firstBlock ? `First failure:\n${firstBlock}` : "",
			tailErrors && tailErrors !== firstBlock ? `Tail errors:\n${tailErrors}` : "",
			failedTests.length > 0 ? `Failed tests:\n${failedTests.join("\n")}` : "",
		].filter(Boolean);
		const summary = parts.join("\n");
		return footer ? `${summary}\n${footer}` : summary;
	}

	// Success: compress pass lists to "N tests passed"; keep short head+tail of remaining signal.
	const passCount = countPassedTests(lines);
	const signal = lines.filter(l => l.trim() && !PROGRESS_NOISE_RE.test(l) && !PASS_LINE_RE.test(l));
	const dropped = lines.length - signal.length;

	if (signal.length === 0) {
		const empty =
			passCount > 0
				? `Exit code: ${exitCode}, ${passCount} tests passed`
				: `Exit code: ${exitCode}, ${lines.length} lines output (noise stripped)`;
		return footer ? `${empty}\n${footer}` : empty;
	}

	const head = signal.slice(0, 8);
	const tail = signal.length > 12 ? signal.slice(-4) : [];
	const bodyLines =
		tail.length > 0 ? [...head, `... [${signal.length - 12} signal lines omitted] ...`, ...tail] : head;
	const passNote = passCount > 0 ? `${passCount} tests passed` : undefined;
	const stripNote = dropped > 0 ? `${dropped} progress/pass lines stripped` : undefined;
	const notes = [passNote, stripNote].filter(Boolean).join("; ");
	const suffix = notes ? `\n(${notes})` : "";
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
	return finalizeToolOutput(processToolOutputCore(output, toolName, toolStrategy, args), artifact, toolName, {
		awaitSave: false,
		failClosedWithoutRecovery: false,
	}) as WorkflowToolOptimizationResult;
}

/**
 * Awaitable ordinary-session path: same deterministic transforms as
 * {@link processToolOutputDetailed}, but awaits `artifact.saveRaw` and fails closed
 * (returns original text, no irreversible shrink) when a lossy transform cannot
 * obtain a real recovery URI.
 */
export async function processToolOutputDetailedAsync(
	output: string,
	toolName: string,
	toolStrategy: ToolStrategy | undefined,
	args?: unknown,
	artifact?: ToolOutputArtifactAdapter,
): Promise<WorkflowToolOptimizationResult> {
	return finalizeToolOutput(processToolOutputCore(output, toolName, toolStrategy, args), artifact, toolName, {
		awaitSave: true,
		failClosedWithoutRecovery: true,
	});
}

interface ToolOutputCoreResult {
	original: string;
	result: string;
	transform: ToolOptimizationTransform;
	didSummarize: boolean;
	didTruncate: boolean;
}

function processToolOutputCore(
	output: string,
	toolName: string,
	toolStrategy: ToolStrategy | undefined,
	args?: unknown,
): ToolOutputCoreResult {
	if (!output || !toolStrategy) {
		return {
			original: output,
			result: output,
			transform: "none",
			didSummarize: false,
			didTruncate: false,
		};
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
	if (rule && !(toolName === "read" && shouldPreserveExplicitReadRange(readPathFromToolArgs(args)))) {
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

	let transform: ToolOptimizationTransform = "none";
	if (!didSummarize && !didTruncate && result === original) {
		transform = "none";
	} else if (toolName === "read" && !didSummarize && didTruncate) {
		transform = "truncate";
	} else if (toolName === "read" && !didSummarize && !didTruncate) {
		transform = "preserve_body";
	} else if (didSummarize && didTruncate) {
		transform = "summarize+truncate";
	} else if (didSummarize) {
		transform = "summarize";
	} else if (didTruncate) {
		transform = "truncate";
	}

	return { original, result, transform, didSummarize, didTruncate };
}

function finalizeToolOutput(
	core: ToolOutputCoreResult,
	artifact: ToolOutputArtifactAdapter | undefined,
	toolName: string,
	opts: { awaitSave: false; failClosedWithoutRecovery: boolean },
): WorkflowToolOptimizationResult;
function finalizeToolOutput(
	core: ToolOutputCoreResult,
	artifact: ToolOutputArtifactAdapter | undefined,
	toolName: string,
	opts: { awaitSave: true; failClosedWithoutRecovery: boolean },
): Promise<WorkflowToolOptimizationResult>;
function finalizeToolOutput(
	core: ToolOutputCoreResult,
	artifact: ToolOutputArtifactAdapter | undefined,
	toolName: string,
	opts: { awaitSave: boolean; failClosedWithoutRecovery: boolean },
): WorkflowToolOptimizationResult | Promise<WorkflowToolOptimizationResult> {
	const { original, transform } = core;
	let result = core.result;

	if (transform === "none" && result === original) {
		return opts.awaitSave ? Promise.resolve({ text: result }) : { text: result };
	}

	const existing = extractRawOutputFooter(result);
	let recoveryUri = existing.artifactId ? `artifact://${existing.artifactId}` : undefined;
	const lossy = result !== original || transform !== "none";

	const finish = (savedId: string | undefined): WorkflowToolOptimizationResult => {
		if (lossy && !recoveryUri && savedId) {
			const footer = `[raw output: artifact://${savedId}]`;
			const sep = result.endsWith("\n") ? "" : "\n";
			result = `${result}${sep}${footer}`;
			recoveryUri = `artifact://${savedId}`;
		}

		// Ordinary sessions: never ship irreversible loss without recovery.
		if (opts.failClosedWithoutRecovery && lossy && !recoveryUri) {
			return { text: original };
		}

		const receipt: ToolOptimizationReceiptV1 = buildToolOptimizationReceipt({
			tool: toolName,
			transform,
			original,
			visible: result,
			recoveryUri,
		});

		if ((utf8ByteLength(result) < utf8ByteLength(original) || lossy) && !recoveryUri) {
			receipt.reversible = false;
		}

		return { text: result, receipt };
	};

	if (lossy && !recoveryUri && artifact?.saveRaw) {
		const saved = artifact.saveRaw(toolName, original);
		if (opts.awaitSave) {
			return Promise.resolve(saved).then(id => finish(typeof id === "string" && id.length > 0 ? id : undefined));
		}
		// Sync path only — ignore Promise (processResult is sync).
		if (typeof saved === "string" && saved.length > 0) {
			return finish(saved);
		}
	}

	return opts.awaitSave ? Promise.resolve(finish(undefined)) : finish(undefined);
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

/** Default smart truncation rules used by quality-first ordinary profiles. */
export const DEFAULT_TRUNCATION_RULES: ToolOutputTruncationRule[] = [
	{
		toolName: "bash",
		strategy: "smart",
		maxBytes: 4000,
		maxLines: 80,
		preservePatterns: ["ERROR", "FAIL", "Exception", "Traceback"],
	},
	{ toolName: "read", strategy: "smart", maxBytes: 8000, maxLines: 160 },
	{ toolName: "grep", strategy: "head", maxBytes: 8000, maxLines: 120 },
	{ toolName: "*", strategy: "head", maxBytes: 4000, maxLines: 80 },
];

/** Subagent read clamp: keep explore/worker visible reads tighter than the parent. */
export const SUBAGENT_READ_TRUNCATION_RULE: ToolOutputTruncationRule = {
	toolName: "read",
	strategy: "smart",
	maxBytes: 5000,
	maxLines: 100,
};

/**
 * Immutable overlay: tighten only the `read` rule for subagent sessions.
 * Never raises an existing family cap (DeepSeek/Sol stay conservative).
 * No-op when truncation is off or there is no read rule to overlay.
 */
export function withSubagentReadClamp<
	T extends { outputTruncation?: { enabled: boolean; rules: ToolOutputTruncationRule[] } },
>(strategy: T | undefined): T | undefined {
	const truncation = strategy?.outputTruncation;
	if (!strategy || !truncation?.enabled) return strategy;
	const rules = truncation.rules;
	if (
		!rules.some(rule => rule.toolName === "read" || (Array.isArray(rule.toolName) && rule.toolName.includes("read")))
	) {
		return strategy;
	}
	return {
		...strategy,
		outputTruncation: {
			...truncation,
			rules: rules.map(rule => {
				const names = Array.isArray(rule.toolName) ? rule.toolName : [rule.toolName];
				if (!names.includes("read")) return rule;
				const maxBytes = Math.min(
					rule.maxBytes ?? SUBAGENT_READ_TRUNCATION_RULE.maxBytes!,
					SUBAGENT_READ_TRUNCATION_RULE.maxBytes!,
				);
				const maxLines = Math.min(
					rule.maxLines ?? SUBAGENT_READ_TRUNCATION_RULE.maxLines!,
					SUBAGENT_READ_TRUNCATION_RULE.maxLines!,
				);
				if (maxBytes === rule.maxBytes && maxLines === rule.maxLines) return rule;
				return { ...rule, maxBytes, maxLines };
			}),
		},
	};
}
