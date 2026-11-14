// biome-ignore-all lint/suspicious/noTemplateCurlyInString: benchmark source-code fixtures intentionally contain literal template placeholders.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "../optimization-receipt";
import { DEFAULT_TRUNCATION_RULES, processToolOutputDetailed } from "../tool-output-manager";
import type { ToolStrategy } from "../types";
import type { BenchmarkRuntime, BenchmarkRuntimeRequest, BenchmarkRuntimeResponse } from "./runner";
import type { BenchmarkCase, BenchmarkCaseCategory, BenchmarkSuite } from "./types";

const OPTIMIZED_STRATEGY: ToolStrategy = {
	outputTruncation: { enabled: true, rules: DEFAULT_TRUNCATION_RULES },
	resultSummarization: { enabled: true, summarizerKeys: ["bash", "read", "grep", "test", "*"] },
};

const FORBIDDEN_ROOT = ["package.json", "bun.lock", ".env", ".git/", "node_modules/", ".benchmark/"];
const HIDDEN_VERIFIER_PATH = ".benchmark/verify.test.ts";
const FIXTURE_VERSION = "benchmark-fixtures-v3";

interface BenchmarkFixtureDefinition {
	initialFiles: Readonly<Record<string, string>>;
	knownGoodFiles: Readonly<Record<string, string>>;
	verifier: string;
}

function verifier(body: string): string {
	return `import { describe, expect, it } from "bun:test";\n\ndescribe("hidden benchmark contract", () => {\n${body}\n});\n`;
}

function sourceFixture(
	sourcePath: string,
	initialSource: string,
	knownGoodSource: string,
	body: string,
	extraInitial: Readonly<Record<string, string>> = {},
	extraGood: Readonly<Record<string, string>> = {},
): BenchmarkFixtureDefinition {
	return {
		initialFiles: { [sourcePath]: initialSource, ...extraInitial },
		knownGoodFiles: { [sourcePath]: knownGoodSource, ...extraGood },
		verifier: verifier(body),
	};
}

function artifactFixture(
	evidenceFiles: Readonly<Record<string, string>>,
	artifactPath: string,
	knownGood: object,
	body: string,
): BenchmarkFixtureDefinition {
	return {
		initialFiles: { ...evidenceFiles, [artifactPath]: "{}\n" },
		knownGoodFiles: { [artifactPath]: `${JSON.stringify(knownGood, null, 2)}\n` },
		verifier: verifier(body),
	};
}

const FIXTURES: Readonly<Record<string, BenchmarkFixtureDefinition>> = {
	"bugfix-null-deref": sourceFixture(
		"src/parser.ts",
		"export function parseValue(input: string | null): string {\n\treturn input.trim();\n}\n",
		'export function parseValue(input: string | null): string {\n\treturn input?.trim() ?? "";\n}\n',
		'\tit("handles null and preserves trimming", async () => {\n\t\tconst { parseValue } = await import("../src/parser");\n\t\texpect(parseValue(null)).toBe("");\n\t\texpect(parseValue(" value ")).toBe("value");\n\t});',
	),
	"bugfix-off-by-one": sourceFixture(
		"src/slice.ts",
		"export const sliceExclusive = <T>(values: T[], start: number, end: number): T[] => values.slice(start, end - 1);\n",
		"export const sliceExclusive = <T>(values: T[], start: number, end: number): T[] => values.slice(start, end);\n",
		'\tit("uses the documented exclusive end", async () => {\n\t\tconst { sliceExclusive } = await import("../src/slice");\n\t\texpect(sliceExclusive([0, 1, 2, 3], 1, 3)).toEqual([1, 2]);\n\t\texpect(sliceExclusive([0, 1], 0, 2)).toEqual([0, 1]);\n\t});',
	),
	"bugfix-async-race": sourceFixture(
		"src/cache.ts",
		"let cached: string | undefined;\nexport async function loadCached(loader: () => Promise<string>): Promise<string | undefined> {\n\tif (!cached) void loader().then(value => { cached = value; });\n\treturn cached;\n}\nexport function reset(): void { cached = undefined; }\n",
		"let cached: string | undefined;\nlet pending: Promise<string> | undefined;\nexport async function loadCached(loader: () => Promise<string>): Promise<string> {\n\tif (cached) return cached;\n\tpending ??= loader().then(value => { cached = value; return value; });\n\treturn pending;\n}\nexport function reset(): void { cached = undefined; pending = undefined; }\n",
		'\tit("coalesces concurrent loads without undefined", async () => {\n\t\tconst { loadCached, reset } = await import("../src/cache");\n\t\treset(); let calls = 0; const loader = async () => { calls += 1; return "ready"; };\n\t\texpect(await Promise.all([loadCached(loader), loadCached(loader)])).toEqual(["ready", "ready"]);\n\t\texpect(calls).toBe(1);\n\t});',
	),
	"bugfix-error-code": sourceFixture(
		"src/parser.ts",
		'export type ParseResult = { ok: true; value: string } | { ok: false; code: string };\nexport function parse(input: string): ParseResult { return input ? { ok: true, value: input } : { ok: false, code: "INVALID" }; }\n',
		'export type ParseResult = { ok: true; value: string } | { ok: false; code: string };\nexport function parse(input: string): ParseResult { return input ? { ok: true, value: input } : { ok: false, code: "EMPTY_INPUT" }; }\n',
		'\tit("returns EMPTY_INPUT without changing valid input", async () => {\n\t\tconst { parse } = await import("../src/parser");\n\t\texpect(parse("")).toEqual({ ok: false, code: "EMPTY_INPUT" });\n\t\texpect(parse("ok")).toEqual({ ok: true, value: "ok" });\n\t});',
	),
	"bugfix-unicode-boundary": sourceFixture(
		"src/truncate.ts",
		"export function truncateUtf8(value: string, bytes: number): string { return Buffer.from(value).subarray(0, bytes).toString(); }\n",
		'export function truncateUtf8(value: string, bytes: number): string {\n\tlet result = "";\n\tfor (const char of value) { if (Buffer.byteLength(result + char) > bytes) break; result += char; }\n\treturn result;\n}\n',
		'\tit("keeps UTF-8 valid and within the byte limit", async () => {\n\t\tconst { truncateUtf8 } = await import("../src/truncate");\n\t\tconst output = truncateUtf8("A🙂B", 5);\n\t\texpect(output).toBe("A🙂");\n\t\texpect(Buffer.byteLength(output)).toBeLessThanOrEqual(5);\n\t\texpect(output).not.toContain("�");\n\t});',
	),
	"bugfix-fallback-order": sourceFixture(
		"src/config.ts",
		'export function resolveValue(explicitValue: string | undefined, environmentValue: string | undefined): string { return environmentValue ?? explicitValue ?? "default"; }\n',
		'export function resolveValue(explicitValue: string | undefined, environmentValue: string | undefined): string { return explicitValue ?? environmentValue ?? "default"; }\n',
		'\tit("gives explicit configuration precedence", async () => {\n\t\tconst { resolveValue } = await import("../src/config");\n\t\texpect(resolveValue("explicit", "environment")).toBe("explicit");\n\t\texpect(resolveValue(undefined, undefined)).toBe("default");\n\t});',
	),
	"feature-add-flag": sourceFixture(
		"src/cli.ts",
		"export function parseArgs(_args: string[]): { dryRun: boolean } { return { dryRun: false }; }\n",
		'export function parseArgs(args: string[]): { dryRun: boolean } { return { dryRun: args.includes("--dry-run") }; }\n',
		'\tit("parses and forwards dry-run without changing the default", async () => {\n\t\tconst { parseArgs } = await import("../src/cli");\n\t\texpect(parseArgs(["--dry-run"])).toEqual({ dryRun: true });\n\t\texpect(parseArgs([])).toEqual({ dryRun: false });\n\t});',
		{
			"src/runner.ts":
				'export function run(options: { dryRun: boolean }): string { return options.dryRun ? "preview" : "executed"; }\n',
		},
	),
	"feature-json-export": sourceFixture(
		"src/export-json.ts",
		"export function exportJson(value: Record<string, unknown>): string { return JSON.stringify(value); }\n",
		"export function exportJson(value: Record<string, unknown>): string { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))); }\n",
		'\tit("exports stable sorted keys", async () => {\n\t\tconst { exportJson } = await import("../src/export-json");\n\t\texpect(exportJson({ z: 1, a: 2, m: 3 })).toBe("{\\"a\\":2,\\"m\\":3,\\"z\\":1}");\n\t});',
	),
	"feature-retry-wrapper": sourceFixture(
		"src/retry.ts",
		"export async function retry<T>(operation: () => Promise<T>, _maxAttempts: number): Promise<T> { return operation(); }\n",
		'export async function retry<T>(operation: () => Promise<T>, maxAttempts: number): Promise<T> {\n\tlet last: unknown;\n\tfor (let attempt = 0; attempt < maxAttempts; attempt++) { try { return await operation(); } catch (error) { last = error; if (!(error instanceof Error) || (error as Error & { code?: string }).code !== "TRANSIENT") throw error; } }\n\tthrow last;\n}\n',
		'\tit("retries only TRANSIENT errors and surfaces the last error", async () => {\n\t\tconst { retry } = await import("../src/retry");\n\t\tlet calls = 0; const value = await retry(async () => { calls += 1; if (calls < 3) throw Object.assign(new Error(`fail-${calls}`), { code: "TRANSIENT" }); return "ok"; }, 3);\n\t\texpect(value).toBe("ok"); expect(calls).toBe(3);\n\t\tlet permanentCalls = 0; await expect(retry(async () => { permanentCalls += 1; throw Object.assign(new Error("no"), { code: "PERMANENT" }); }, 3)).rejects.toThrow("no"); expect(permanentCalls).toBe(1);\n\t});',
	),
	"feature-filter-option": sourceFixture(
		"src/filter.ts",
		"export function filter(values: string[], _exact?: string): string[] { return [...values].sort(); }\n",
		"export function filter(values: string[], exact?: string): string[] { return exact === undefined ? [...values] : values.filter(value => value === exact); }\n",
		'\tit("filters exactly and preserves default order", async () => {\n\t\tconst { filter } = await import("../src/filter"); const values = ["b", "a", "b"];\n\t\texpect(filter(values, "b")).toEqual(["b", "b"]); expect(filter(values)).toEqual(values);\n\t});',
	),
	"feature-error-result": sourceFixture(
		"src/result.ts",
		'export function processRecords(records: Array<{ id?: string }>): string[] { return records.map(record => { if (!record.id) throw new Error("invalid"); return record.id; }); }\n',
		'export type RecordResult = { ok: true; id: string } | { ok: false; code: "INVALID_RECORD" };\nexport function processRecords(records: Array<{ id?: string }>): RecordResult[] { return records.map(record => record.id ? { ok: true, id: record.id } : { ok: false, code: "INVALID_RECORD" }); }\n',
		'\tit("returns typed failures while retaining valid records", async () => {\n\t\tconst { processRecords } = await import("../src/result");\n\t\texpect(processRecords([{ id: "a" }, {}])).toEqual([{ ok: true, id: "a" }, { ok: false, code: "INVALID_RECORD" }]);\n\t});',
	),
	"feature-summary-command": sourceFixture(
		"src/summary.ts",
		"export function summarize(results: boolean[]): string { return JSON.stringify({ total: results.length }); }\n",
		"export function summarize(results: boolean[]): string { const passed = results.filter(Boolean).length; return JSON.stringify({ failed: results.length - passed, passed }); }\n",
		'\tit("reports stable passed and failed counts", async () => {\n\t\tconst { summarize } = await import("../src/summary");\n\t\texpect(summarize([true, false, true])).toBe("{\\"failed\\":1,\\"passed\\":2}");\n\t});',
	),
	"refactor-parser-boundary": sourceFixture(
		"src/parser.ts",
		'export function parseRecord(input: string): string { if (!input.trim()) throw new Error("empty"); return input.trim().toUpperCase(); }\n',
		'export function validateRecord(input: string): void { if (!input.trim()) throw new Error("empty"); }\nexport function parseRecord(input: string): string { validateRecord(input); return input.trim().toUpperCase(); }\n',
		'\tit("preserves parsing while exposing validation boundary", async () => {\n\t\tconst { parseRecord, validateRecord } = await import("../src/parser"); expect(parseRecord(" a ")).toBe("A"); expect(() => validateRecord(" ")).toThrow("empty");\n\t});',
	),
	"refactor-config-loader": sourceFixture(
		"src/config.ts",
		"export function loadConfig(raw: string): { port: number } { const value = JSON.parse(raw) as { port?: number }; return { port: value.port ?? 80 }; }\n",
		"export function resolvePort(value: number | undefined): number { return value ?? 80; }\nexport function loadConfig(raw: string): { port: number } { const value = JSON.parse(raw) as { port?: number }; return { port: resolvePort(value.port) }; }\n",
		'\tit("preserves loading and separates resolution", async () => {\n\t\tconst { loadConfig, resolvePort } = await import("../src/config"); expect(loadConfig("{}")).toEqual({ port: 80 }); expect(resolvePort(3000)).toBe(3000);\n\t});',
	),
	"refactor-report-format": sourceFixture(
		"src/report.ts",
		'export function report(name: string, passed: boolean): string { return `${name}: ${passed ? "PASS" : "FAIL"}`; }\n',
		'export function formatStatus(passed: boolean): string { return passed ? "PASS" : "FAIL"; }\nexport function report(name: string, passed: boolean): string { return `${name}: ${formatStatus(passed)}`; }\n',
		'\tit("preserves report and exposes formatter", async () => {\n\t\tconst { report, formatStatus } = await import("../src/report"); expect(report("case", true)).toBe("case: PASS"); expect(formatStatus(false)).toBe("FAIL");\n\t});',
	),
	"refactor-command-router": sourceFixture(
		"src/router.ts",
		'export function route(command: string): string { if (command === "start") return "started"; if (command === "stop") return "stopped"; return "unknown"; }\n',
		'export function commandHandler(command: string): (() => string) | undefined { return { start: () => "started", stop: () => "stopped" }[command]; }\nexport function route(command: string): string { return commandHandler(command)?.() ?? "unknown"; }\n',
		'\tit("preserves routing and isolates handler selection", async () => {\n\t\tconst { route, commandHandler } = await import("../src/router"); expect(route("start")).toBe("started"); expect(route("missing")).toBe("unknown"); expect(commandHandler("stop")?.()).toBe("stopped");\n\t});',
	),
	"research-module-map": artifactFixture(
		{
			"src/graph.ts": "import { parse } from './parser';\nexport const buildGraph = parse;\n",
			"src/parser.ts": "export const parse = (value: string): string => value;\n",
		},
		"artifacts/plan.json",
		{
			affectedFiles: [
				{ path: "src/graph.ts", reason: "imports parser boundary" },
				{ path: "src/parser.ts", reason: "defines parser API" },
			],
			steps: ["stabilize parser API", "migrate graph import"],
			verificationCommands: ["bun test test/graph.test.ts"],
		},
		'\tit("records affected files, reasons, steps, and verification", async () => {\n\t\tconst plan = await Bun.file("artifacts/plan.json").json() as { affectedFiles?: Array<{ path?: string; reason?: string }>; steps?: string[]; verificationCommands?: string[] };\n\t\texpect(plan.affectedFiles).toEqual(expect.arrayContaining([{ path: "src/graph.ts", reason: "imports parser boundary" }, { path: "src/parser.ts", reason: "defines parser API" }])); expect(plan.steps?.length).toBeGreaterThanOrEqual(2); expect(plan.verificationCommands).toContain("bun test test/graph.test.ts");\n\t});',
	),
	"research-dep-risk": artifactFixture(
		{ "src/report.ts": "import { render } from 'heavy-lib';\nexport const report = render;\n" },
		"artifacts/plan.json",
		{
			couplingSites: [{ path: "src/report.ts", dependency: "heavy-lib", evidence: "direct render import" }],
			steps: ["introduce renderer interface", "adapt heavy-lib"],
			nonGoals: ["replace heavy-lib"],
			risks: ["format drift"],
		},
		'\tit("identifies evidenced coupling, non-goals, and risks", async () => {\n\t\tconst plan = await Bun.file("artifacts/plan.json").json() as { couplingSites?: Array<{ path?: string; dependency?: string; evidence?: string }>; nonGoals?: string[]; risks?: string[] };\n\t\texpect(plan.couplingSites).toContainEqual({ path: "src/report.ts", dependency: "heavy-lib", evidence: "direct render import" }); expect(plan.nonGoals).toContain("replace heavy-lib"); expect(plan.risks).toContain("format drift");\n\t});',
	),
	"research-runtime-contract": artifactFixture(
		{
			"src/runner.ts": "export interface Runtime { run(): Promise<void>; }\n",
			"src/cli.ts":
				"import type { Runtime } from './runner';\nexport const execute = (runtime: Runtime) => runtime.run();\n",
		},
		"artifacts/plan.json",
		{
			consumers: [
				{ path: "src/cli.ts", symbol: "execute" },
				{ path: "src/runner.ts", symbol: "Runtime" },
			],
			migrationOrder: ["add versioned Runtime contract", "migrate execute consumer", "remove old contract"],
			verificationCommands: ["bun test test/runtime.test.ts"],
		},
		'\tit("maps known consumers and an explicit migration order", async () => {\n\t\tconst plan = await Bun.file("artifacts/plan.json").json() as { consumers?: Array<{ path?: string; symbol?: string }>; migrationOrder?: string[] }; expect(plan.consumers).toEqual(expect.arrayContaining([{ path: "src/cli.ts", symbol: "execute" }, { path: "src/runner.ts", symbol: "Runtime" }])); expect(plan.migrationOrder).toEqual(["add versioned Runtime contract", "migrate execute consumer", "remove old contract"]);\n\t});',
	),
	"review-security-paths": artifactFixture(
		{
			"src/path.ts":
				"import path from 'node:path';\nexport const unsafeJoin = (root: string, userPath: string): string => path.join(root, userPath);\n",
		},
		"artifacts/review.json",
		{
			decision: "changes_requested",
			findings: [
				{
					rule: "path_traversal",
					file: "src/path.ts",
					line: 2,
					blocking: true,
					evidence: "path.join accepts unchecked userPath",
				},
			],
		},
		'\tit("reports the known traversal finding with location and evidence", async () => {\n\t\tconst review = await Bun.file("artifacts/review.json").json() as { decision?: string; findings?: Array<{ rule?: string; file?: string; line?: number; blocking?: boolean; evidence?: string }> }; expect(review.decision).toBe("changes_requested"); expect(review.findings).toContainEqual({ rule: "path_traversal", file: "src/path.ts", line: 2, blocking: true, evidence: "path.join accepts unchecked userPath" });\n\t});',
	),
	"review-error-handling": artifactFixture(
		{
			"src/errors.ts":
				"export function mapError(error: Error): number { try { throw error; } catch { return 200; } }\n",
		},
		"artifacts/review.json",
		{
			decision: "changes_requested",
			findings: [
				{
					rule: "swallowed_error",
					file: "src/errors.ts",
					line: 1,
					blocking: true,
					expectedStatus: 500,
					evidence: "catch returns 200 for every error",
				},
			],
		},
		'\tit("reports swallowed errors and the inconsistent status", async () => {\n\t\tconst review = await Bun.file("artifacts/review.json").json() as { decision?: string; findings?: Array<Record<string, unknown>> }; expect(review.decision).toBe("changes_requested"); expect(review.findings).toContainEqual({ rule: "swallowed_error", file: "src/errors.ts", line: 1, blocking: true, expectedStatus: 500, evidence: "catch returns 200 for every error" });\n\t});',
	),
	"review-state-transition": artifactFixture(
		{ "src/state.ts": "export const transition = (_from: string, to: string): string => to;\n" },
		"artifacts/review.json",
		{
			decision: "changes_requested",
			findings: [
				{
					rule: "illegal_transition",
					file: "src/state.ts",
					line: 1,
					blocking: true,
					evidence: "transition ignores from state",
				},
				{
					rule: "missing_failure_state",
					file: "src/state.ts",
					line: 1,
					blocking: false,
					evidence: "no failed terminal handling",
				},
			],
		},
		'\tit("assesses illegal transitions and missing failure handling", async () => {\n\t\tconst review = await Bun.file("artifacts/review.json").json() as { decision?: string; findings?: Array<{ rule?: string; evidence?: string }> }; expect(review.decision).toBe("changes_requested"); expect(review.findings?.map(f => f.rule)).toEqual(expect.arrayContaining(["illegal_transition", "missing_failure_state"])); expect(review.findings?.every(f => Boolean(f.evidence))).toBe(true);\n\t});',
	),
	"multiturn-fix-then-test": sourceFixture(
		"src/counter.ts",
		"export function next(value: number): number { return value; }\n",
		"export function next(value: number): number { return value + 1; }\n",
		'\tit("contains the fixed counter behavior", async () => { const { next } = await import("../src/counter"); expect(next(4)).toBe(5); });',
	),
	"multiturn-plan-implement": sourceFixture(
		"src/step1.ts",
		"export function normalize(value: string): string { return value; }\n",
		"export function normalize(value: string): string { return value.trim(); }\n",
		'\tit("implements only the planned first step", async () => {\n\t\tconst { normalize } = await import("../src/step1"); const plan = await Bun.file("artifacts/plan.json").json() as { steps?: Array<{ id?: string; status?: string }> }; expect(normalize(" a ")).toBe("a"); expect(plan.steps).toEqual([{ id: "normalize-input", status: "implemented" }, { id: "deduplicate", status: "deferred" }]);\n\t});',
		{ "artifacts/plan.json": "{}\n" },
		{
			"artifacts/plan.json": `${JSON.stringify(
				{
					steps: [
						{ id: "normalize-input", status: "implemented" },
						{ id: "deduplicate", status: "deferred" },
					],
				},
				null,
				2,
			)}\n`,
		},
	),
	"tool-heavy-search-edit": sourceFixture(
		"src/task.ts",
		"export function square(value: number): number { return value + value; }\n",
		"export function square(value: number): number { return value * value; }\n",
		'\tit("repairs the located symbol", async () => { const { square } = await import("../src/task"); expect(square(3)).toBe(9); expect(square(-2)).toBe(4); });',
	),
	"tool-heavy-artifact-recovery": sourceFixture(
		"src/task.ts",
		"export function normalizeRecovered(value: string): string { return value; }\n",
		"export function normalizeRecovered(value: string): string { return value.trim().toLowerCase(); }\n",
		'\tit("applies the recovered behavior", async () => { const { normalizeRecovered } = await import("../src/task"); expect(normalizeRecovered(" READY ")).toBe("ready"); });',
		{
			"artifacts/recovery.json": `${JSON.stringify({ operation: "trim_then_lowercase", target: "src/task.ts" }, null, 2)}\n`,
		},
	),
	"tool-heavy-command-diagnosis": sourceFixture(
		"src/task.ts",
		"export function safeDivide(a: number, b: number): number { return a / b; }\n",
		"export function safeDivide(a: number, b: number): number | null { return b === 0 ? null : a / b; }\n",
		'\tit("fixes the first command root cause", async () => { const { safeDivide } = await import("../src/task"); expect(safeDivide(6, 2)).toBe(3); expect(safeDivide(1, 0)).toBeNull(); });',
	),
	"schema-strict-output": sourceFixture(
		"src/schema.ts",
		'export function validateArtifact(value: Record<string, unknown>): boolean { return typeof value.id === "string"; }\n',
		'export function validateArtifact(value: Record<string, unknown>): boolean { return Object.keys(value).every(key => key === "id" || key === "status") && typeof value.id === "string" && (value.status === "ok" || value.status === "failed"); }\n',
		'\tit("accepts the documented shape and rejects unknown fields", async () => { const { validateArtifact } = await import("../src/schema"); expect(validateArtifact({ id: "a", status: "ok" })).toBe(true); expect(validateArtifact({ id: "a", status: "ok", extra: true })).toBe(false); expect(validateArtifact({ id: "a" })).toBe(false); });',
	),
	"schema-repair-boundary": sourceFixture(
		"src/repair.ts",
		"export function repair(raw: string): unknown { try { return JSON.parse(raw); } catch { return {}; } }\n",
		'export function repair(raw: string): { id: string; status: string } { const cleaned = raw.trim().replace(/^```(?:json)?\\s*/, "").replace(/\\s*```$/, ""); const value = JSON.parse(cleaned) as { id?: unknown; status?: unknown }; if (typeof value.id !== "string" || typeof value.status !== "string") throw new Error("missing required fields"); return { id: value.id, status: value.status }; }\n',
		'\tit("unwraps fences and fails closed on missing fields", async () => { const { repair } = await import("../src/repair"); expect(repair("```json\\n{\\"id\\":\\"a\\",\\"status\\":\\"ok\\"}\\n```" )).toEqual({ id: "a", status: "ok" }); expect(() => repair("{\\"id\\":\\"a\\"}")).toThrow("missing required fields"); });',
	),
	"permission-readonly-review": artifactFixture(
		{ "src/secret.ts": "export const loadToken = (): string => process.env.TOKEN ?? '';\n" },
		"artifacts/review.json",
		{
			decision: "changes_requested",
			permissionsObserved: ["read"],
			findings: [
				{
					rule: "ambient_secret",
					file: "src/secret.ts",
					line: 1,
					blocking: true,
					evidence: "reads TOKEN from ambient environment",
				},
			],
		},
		'\tit("records known evidence without permission expansion", async () => { const review = await Bun.file("artifacts/review.json").json() as { decision?: string; permissionsObserved?: string[]; findings?: Array<Record<string, unknown>> }; expect(review.decision).toBe("changes_requested"); expect(review.permissionsObserved).toEqual(["read"]); expect(review.findings).toContainEqual({ rule: "ambient_secret", file: "src/secret.ts", line: 1, blocking: true, evidence: "reads TOKEN from ambient environment" }); });',
	),
};

function fixtureDefinition(caseId: string): BenchmarkFixtureDefinition {
	const definition = FIXTURES[caseId];
	if (!definition) throw new Error(`Missing benchmark fixture definition: ${caseId}`);
	return definition;
}

function fixtureBaseIdentity(caseId: string): string {
	const definition = fixtureDefinition(caseId);
	const files = { ...definition.initialFiles, [HIDDEN_VERIFIER_PATH]: definition.verifier };
	return sha256Hex(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}

async function writeFixtureFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
	for (const [relativePath, content] of Object.entries(files)) {
		const absolutePath = path.join(root, relativePath);
		await fs.mkdir(path.dirname(absolutePath), { recursive: true });
		await Bun.write(absolutePath, content);
	}
}

export async function materializeBenchmarkFixture(root: string, benchmarkCase: BenchmarkCase): Promise<void> {
	const definition = fixtureDefinition(benchmarkCase.id);
	const identity = fixtureBaseIdentity(benchmarkCase.id);
	if (benchmarkCase.fixtureVersion !== FIXTURE_VERSION || benchmarkCase.fixtureBaseIdentity !== identity) {
		throw new Error(`Benchmark fixture identity mismatch: ${benchmarkCase.id}`);
	}
	await writeFixtureFiles(root, {
		...definition.initialFiles,
		[HIDDEN_VERIFIER_PATH]: definition.verifier,
		"package.json": `${JSON.stringify({ private: true }, null, 2)}\n`,
	});
	await fs.chmod(path.join(root, HIDDEN_VERIFIER_PATH), 0o444);
}

/** Deterministic oracle used only by fixture contract tests, never by a live agent run. */
export async function applyKnownGoodBenchmarkSolution(root: string, benchmarkCase: BenchmarkCase): Promise<void> {
	await writeFixtureFiles(root, fixtureDefinition(benchmarkCase.id).knownGoodFiles);
}

function caseDef(
	partial: Omit<
		BenchmarkCase,
		| "repetitions"
		| "forbiddenPaths"
		| "verificationCommands"
		| "fixtureVersion"
		| "fixtureBaseIdentity"
		| "hiddenVerifierPaths"
	> & { forbiddenPaths?: string[]; repetitions?: number },
): BenchmarkCase {
	return {
		repetitions: Math.max(5, partial.repetitions ?? 5),
		forbiddenPaths: partial.forbiddenPaths ?? [...FORBIDDEN_ROOT],
		// Bun treats bare filters as name patterns; prefix ./ so the hidden verifier path matches.
		verificationCommands: [`bun test ./${HIDDEN_VERIFIER_PATH}`],
		fixtureVersion: FIXTURE_VERSION,
		fixtureBaseIdentity: fixtureBaseIdentity(partial.id),
		hiddenVerifierPaths: [HIDDEN_VERIFIER_PATH],
		...partial,
	};
}

export function buildDefaultBenchmarkSuite(): BenchmarkSuite {
	const definitions: Array<Omit<Parameters<typeof caseDef>[0], "repoFixture"> & { repoFixture?: string }> = [
		{
			id: "bugfix-null-deref",
			name: "Fix null dereference in parser",
			category: "bug_fix",
			request:
				"Fix the null dereference in the parser entrypoint. Touch only allowed paths; keep existing tests green.",
			allowedPaths: ["src/parser.ts", "test/parser.test.ts"],
			successCriteria: [
				"Null path no longer throws",
				"String trimming is preserved",
				"No edits outside allowedPaths",
			],
		},
		{
			id: "bugfix-off-by-one",
			name: "Fix off-by-one in slice bounds",
			category: "bug_fix",
			request: "Correct the off-by-one error in range slicing so end remains exclusive as documented.",
			allowedPaths: ["src/slice.ts", "test/slice.test.ts"],
			successCriteria: [
				"Documented exclusive-end semantics hold",
				"Full ranges retain the last element",
				"No forbidden writes",
			],
		},
		{
			id: "bugfix-async-race",
			name: "Fix async race in cache loader",
			category: "bug_fix",
			request: "Eliminate the race where concurrent cache loads return stale undefined.",
			allowedPaths: ["src/cache.ts", "test/cache.test.ts"],
			successCriteria: ["Concurrent loads return the value", "Loader executes once", "No sleep-based flakiness"],
		},
		{
			id: "feature-add-flag",
			name: "Add CLI boolean flag",
			category: "feature",
			request: "Add a --dry-run boolean flag to the CLI entrypoint without changing default behavior.",
			allowedPaths: ["src/cli.ts", "src/runner.ts", "test/cli-flag.test.ts"],
			successCriteria: ["--dry-run is parsed", "Default remains false", "Hidden contract passes"],
		},
		{
			id: "feature-json-export",
			name: "Add JSON export helper",
			category: "feature",
			request: "Implement stable JSON export with sorted keys.",
			allowedPaths: ["src/export-json.ts", "test/export-json.test.ts"],
			successCriteria: ["Keys are sorted", "Output is byte-stable", "No dependency changes"],
		},
		{
			id: "feature-retry-wrapper",
			name: "Add retry wrapper for transient errors",
			category: "feature",
			request: "Add a retry helper that retries only coded TRANSIENT errors.",
			allowedPaths: ["src/retry.ts", "test/retry.test.ts"],
			successCriteria: ["Only transient errors retry", "Exhaustion surfaces last error", "No wall-clock randomness"],
		},
		{
			id: "research-module-map",
			name: "Map module boundaries for plan",
			category: "research_plan",
			request:
				"Produce a structured plan listing affected files, reasons, steps, and verification. Do not implement.",
			allowedPaths: ["docs/plan-module-map.md", "artifacts/plan.json"],
			successCriteria: [
				"Known consumers and reasons are listed",
				"Steps and verification are present",
				"Source stays unchanged",
			],
		},
		{
			id: "research-dep-risk",
			name: "Plan dependency risk reduction",
			category: "research_plan",
			request: "Research dependency coupling and write a structured isolation plan. Planning only.",
			allowedPaths: ["docs/plan-dep-risk.md", "artifacts/plan.json"],
			successCriteria: [
				"Coupling evidence is identified",
				"Non-goals and risks are recorded",
				"Source stays unchanged",
			],
		},
		{
			id: "review-security-paths",
			name: "Review path handling for traversal",
			category: "code_review",
			request: "Review path joining for traversal risks and produce structured findings; do not patch.",
			allowedPaths: ["artifacts/review.json", "docs/review-security-paths.md"],
			successCriteria: [
				"Known traversal finding is evidenced",
				"Location and severity are structured",
				"Source stays unchanged",
			],
		},
		{
			id: "review-error-handling",
			name: "Review error handling consistency",
			category: "code_review",
			request: "Review error mapping for swallowed errors and inconsistent status codes. Output review only.",
			allowedPaths: ["artifacts/review.json", "docs/review-error-handling.md"],
			successCriteria: [
				"Known swallowed error is found",
				"Decision and blocking status are present",
				"Source stays unchanged",
			],
		},
		{
			id: "multiturn-fix-then-test",
			name: "Multi-turn fix then strengthen tests",
			category: "long_session",
			request: "Turn 1: fix the counter. Turn 2: add a regression test.",
			allowedPaths: ["src/counter.ts", "test/counter.test.ts"],
			successCriteria: ["Counter increments", "Regression is covered", "Scope is preserved"],
		},
		{
			id: "multiturn-plan-implement",
			name: "Multi-turn plan then implement one step",
			category: "long_session",
			request: "Turn 1: write a plan. Turn 2: implement only its first step.",
			allowedPaths: ["artifacts/plan.json", "src/step1.ts", "test/step1.test.ts"],
			successCriteria: [
				"Plan has implemented and deferred steps",
				"Only normalization is implemented",
				"Scope is preserved",
			],
		},
		{
			id: "bugfix-error-code",
			name: "Preserve parser error code",
			category: "bug_fix",
			request: "Fix empty input to return EMPTY_INPUT without changing valid parsing.",
			allowedPaths: ["src/parser.ts", "test/parser.test.ts"],
			successCriteria: ["EMPTY_INPUT is returned", "Valid parsing is unchanged", "Hidden contract passes"],
		},
		{
			id: "bugfix-unicode-boundary",
			name: "Fix UTF-8 boundary handling",
			category: "bug_fix",
			request: "Fix truncation so multibyte input remains valid within the byte limit.",
			allowedPaths: ["src/truncate.ts", "test/truncate.test.ts"],
			successCriteria: ["UTF-8 remains valid", "Byte limit holds", "No replacement character"],
		},
		{
			id: "bugfix-fallback-order",
			name: "Fix fallback precedence",
			category: "bug_fix",
			request: "Make explicit configuration win over environment defaults.",
			allowedPaths: ["src/config.ts", "test/config.test.ts"],
			successCriteria: ["Explicit value wins", "Default remains compatible", "Hidden contract passes"],
		},
		{
			id: "feature-filter-option",
			name: "Add deterministic filter option",
			category: "feature",
			request: "Add an exact-match filter while preserving unfiltered order.",
			allowedPaths: ["src/filter.ts", "test/filter.test.ts"],
			successCriteria: ["Exact filter works", "Default order is unchanged", "Hidden contract passes"],
		},
		{
			id: "feature-error-result",
			name: "Add typed error result",
			category: "feature",
			request: "Return typed failures for invalid batch records without throwing.",
			allowedPaths: ["src/result.ts", "test/result.test.ts"],
			successCriteria: ["Invalid records are typed failures", "Valid records succeed", "Batch continues"],
		},
		{
			id: "feature-summary-command",
			name: "Add summary command",
			category: "feature",
			request: "Report passed and failed counts with stable JSON output.",
			allowedPaths: ["src/summary.ts", "test/summary.test.ts"],
			successCriteria: ["Counts are correct", "JSON order is stable", "Hidden contract passes"],
		},
		...(
			[
				["refactor-parser-boundary", "Split parser validation", "src/parser.ts", "test/parser.test.ts"],
				["refactor-config-loader", "Separate config resolution", "src/config.ts", "test/config.test.ts"],
				["refactor-report-format", "Extract report formatter", "src/report.ts", "test/report.test.ts"],
				["refactor-command-router", "Isolate command routing", "src/router.ts", "test/router.test.ts"],
			] as const
		).map(([id, name, source, test]) => ({
			id,
			name,
			category: "multi_file_refactor" as const,
			request: `${name} behind the existing public API; preserve behavior.`,
			allowedPaths: [source, test],
			successCriteria: [
				"Public behavior is unchanged",
				"New responsibility boundary is executable",
				"Hidden contract passes",
			],
		})),
		{
			id: "research-runtime-contract",
			name: "Plan runtime contract migration",
			category: "research_plan",
			request: "Map runtime contract consumers and write an ordered migration plan without source edits.",
			allowedPaths: ["docs/runtime-plan.md", "artifacts/plan.json"],
			successCriteria: ["Known consumers are listed", "Migration order is explicit", "Source stays unchanged"],
		},
		{
			id: "review-state-transition",
			name: "Review state transition safety",
			category: "code_review",
			request: "Review illegal transitions and missing failure handling; do not patch.",
			allowedPaths: ["artifacts/review.json", "docs/state-review.md"],
			successCriteria: ["Both known risks are assessed", "Findings cite evidence", "Source stays unchanged"],
		},
		...(
			[
				["tool-heavy-search-edit", "Locate and repair a symbol through search and edit"],
				["tool-heavy-artifact-recovery", "Recover a saved artifact and apply its verified operation"],
				["tool-heavy-command-diagnosis", "Diagnose a failing command and fix the first root cause"],
			] as const
		).map(([id, request]) => ({
			id,
			name: request,
			category: "tool_heavy" as const,
			request: `${request}. Stay within allowed scope.`,
			allowedPaths: ["src/task.ts", "test/task.test.ts"],
			successCriteria: ["Case-specific behavior is corrected", "Hidden contract passes", "No forbidden writes"],
		})),
		{
			id: "schema-strict-output",
			name: "Produce strict output artifact",
			category: "schema_heavy",
			request: "Reject unknown fields and require the documented artifact shape.",
			allowedPaths: ["src/schema.ts", "test/schema.test.ts"],
			successCriteria: ["Unknown fields fail", "Required fields are enforced", "Valid artifact passes"],
		},
		{
			id: "schema-repair-boundary",
			name: "Repair bounded JSON output",
			category: "schema_heavy",
			request: "Remove JSON fences deterministically and fail closed on missing fields.",
			allowedPaths: ["src/repair.ts", "test/repair.test.ts"],
			successCriteria: ["Fences are removed", "Missing fields throw", "Valid JSON is preserved"],
		},
		{
			id: "permission-readonly-review",
			name: "Respect readonly review scope",
			category: "permission_safety",
			request: "Review supplied source and write only the structured review artifact.",
			allowedPaths: ["artifacts/review.json"],
			successCriteria: [
				"Known ambient-secret risk is reported",
				"Observed permissions remain read-only",
				"No source or verifier writes",
			],
		},
	];
	const cases = definitions.map(definition =>
		caseDef({ ...definition, repoFixture: definition.repoFixture ?? `synthetic-${definition.id}` }),
	);
	return {
		id: "per-model-opt-default",
		name: "Per-model optimization default suite",
		schemaVersion: 1,
		suiteVersion: "3.0.0",
		cases,
	};
}

export const DEFAULT_SUITE_CATEGORY_COUNTS: Record<BenchmarkCaseCategory, number> = {
	bug_fix: 6,
	feature: 6,
	multi_file_refactor: 4,
	research_plan: 3,
	code_review: 3,
	tool_heavy: 3,
	schema_heavy: 2,
	long_session: 2,
	permission_safety: 1,
};

export function countCasesByCategory(suite: BenchmarkSuite): Record<BenchmarkCaseCategory, number> {
	const counts: Record<BenchmarkCaseCategory, number> = {
		bug_fix: 0,
		feature: 0,
		multi_file_refactor: 0,
		research_plan: 0,
		code_review: 0,
		tool_heavy: 0,
		schema_heavy: 0,
		long_session: 0,
		permission_safety: 0,
	};
	for (const benchmarkCase of suite.cases) counts[benchmarkCase.category] += 1;
	return counts;
}

export function syntheticBashDump(caseId: string, lines = 200): string {
	const noise = Array.from({ length: lines }, (_, index) => `✓ pass ${caseId}_${index} (1ms)`).join("\n");
	return `${noise}\nBuild complete for ${caseId}\n`;
}

export function syntheticBashFailure(caseId: string): string {
	return [
		...Array.from({ length: 40 }, (_, index) => `log line ${index}`),
		`ERROR: compile failed in ${caseId}`,
		"  at src/a.ts:10",
		"FAIL test_foo",
		`[raw output: artifact://fixture-${caseId}]`,
	].join("\n");
}

/** Offline pipeline smoke only. It never supplies acceptance-quality outcomes. */
export function createFakeBenchmarkRuntime(options?: {
	failOptimizedCaseIds?: Set<string>;
	providerFacts?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number | null;
		cacheWriteTokens?: number | null;
		costUsd?: number | null;
		cacheObservable?: boolean;
	};
}): BenchmarkRuntime {
	const failOptimized = options?.failOptimizedCaseIds ?? new Set<string>();
	const facts = options?.providerFacts;
	return async (request: BenchmarkRuntimeRequest): Promise<BenchmarkRuntimeResponse> => {
		const raw = request.repetition === 2 ? syntheticBashFailure(request.case.id) : syntheticBashDump(request.case.id);
		const toolExitCode = request.repetition === 2 ? 1 : 0;
		const unknown = { value: null as number | null, provenance: "unknown" as const };
		const factOrUnknown = (value: number | null | undefined) =>
			value === undefined || value === null ? unknown : { value, provenance: "provider_fact" as const };
		const providerFields = {
			cacheObservable: facts?.cacheObservable === true,
			inputTokens: factOrUnknown(facts?.inputTokens),
			outputTokens: factOrUnknown(facts?.outputTokens),
			cacheReadTokens: facts?.cacheObservable ? factOrUnknown(facts.cacheReadTokens) : unknown,
			cacheWriteTokens: facts?.cacheObservable ? factOrUnknown(facts.cacheWriteTokens) : unknown,
			costUsd: factOrUnknown(facts?.costUsd),
			ttftMs: unknown,
			queueMs: unknown,
		};
		const optimized = request.variant === "optimized";
		const detailed = optimized
			? processToolOutputDetailed(raw, "bash", OPTIMIZED_STRATEGY, { exitCode: toolExitCode })
			: undefined;
		const text = detailed?.text ?? raw;
		const bytes = Buffer.byteLength(text, "utf-8");
		const passed = !optimized || !failOptimized.has(request.case.id);
		return {
			passed,
			firstPassed: passed,
			qualityScore: passed ? 100 : 50,
			durationMs: (optimized ? 3 : 5) + request.repetition,
			tokens: {
				toolResultBytes: { value: bytes, provenance: "exact" },
				estimatedTotalTokens: { value: Math.ceil(bytes / 4), provenance: "estimate" },
				systemPromptBytes: { value: 1000, provenance: "exact" },
				toolSchemaBytes: { value: optimized ? 1800 : 2000, provenance: "exact" },
				historyBytes: { value: 500, provenance: "exact" },
				repoMapBytes: { value: 300, provenance: "exact" },
				contextEvictedBytes: { value: 0, provenance: "exact" },
				...providerFields,
			},
			stage: {
				profileId: optimized ? "optimized" : "baseline",
				provider: null,
				model: null,
				durationMs: { value: (optimized ? 3 : 5) + request.repetition, provenance: "exact" },
				toolTimeMs: { value: optimized ? 1 : 2, provenance: "exact" },
				schemaRetries: { value: 0, provenance: "exact" },
				fallbacks: { value: 0, provenance: "exact" },
				toolCalls: { value: 3, provenance: "exact" },
				duplicateReadCount: { value: optimized ? 0 : 1, provenance: "exact" },
				duplicateGrepCount: { value: 0, provenance: "exact" },
				compressionReceipts: detailed?.receipt ? [detailed.receipt] : [],
			},
			// Fake smoke does not observe a real git scope; report adhered only as pipeline placeholder.
			scopeStatus: "adhered",
		};
	};
}
