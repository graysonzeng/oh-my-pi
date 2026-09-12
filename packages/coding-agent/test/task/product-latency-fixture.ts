/**
 * Manual product latency qualification (parent/child).
 * Not a bun:test file. Invoked only via test:latency:smoke / test:latency:release.
 * Importing this module performs no provider calls; only the child execution path does.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentResult,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { SubagentCompletionKind } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { computeActiveWallMs, percentile } from "../../src/latency";

type Mode = "smoke" | "release";
type Variant = "scout" | "reviewer";

const FIXTURE_PATH = path.resolve(import.meta.path);
const PI_CONFIG_DIR_NAME = ".omp-latency-fixture";
const DELETED_CHILD_ENV = ["PI_CODING_AGENT_DIR", "COPILOT_HOME", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"] as const;

const SCOUT_P50_MS = 5 * 60_000;
const SCOUT_P90_MS = 8 * 60_000;
const REVIEWER_P50_MS = 12 * 60_000;
const REVIEWER_P90_MS = 20 * 60_000;

const SCOUT_MODEL_CHAIN = ["gateway/deepseek-v4-flash:max", "gateway/grok-4.6:high"] as const;
const REVIEWER_MODEL_CHAIN = ["gateway/gpt-5.6-sol", "gateway/claude-opus-5", "@task"] as const;

const SCOUT_ASSIGNMENT =
	"Locate the definition of resolveClassMaxRuntimeMs (successor of resolveTaskMaxRuntimeMs) and its callers in this workspace. Return a compressed handoff: path, signature, and call sites. Do not keep going after the answer is complete.";
const REVIEWER_ASSIGNMENT =
	"Review the small diff and evidence pack in this workspace. Produce a verdict with patch-anchored findings (or an explicit empty-finding verdict). Do not keep searching after the verdict is ready.";

interface FrontmatterIdentity {
	thinkingLevel: string | undefined;
	maxEffort: string | undefined;
	readSummarize: boolean | undefined;
	shadowReview: "code" | undefined;
	model: string[] | undefined;
}

interface RuntimeProvenance {
	source: "runtime_observed";
	provider: string;
	model: string;
	fallback: false;
}

interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

interface QualificationRecord {
	variant: Variant;
	repetition: number;
	completionKind: SubagentCompletionKind | null;
	durationMs: number;
	activeWallMs: number | null;
	runtimeProvenance: RuntimeProvenance | null;
	hardTimeout: boolean;
	effectiveAgentSource: string;
	effectiveModel: string | undefined;
	effectiveEffort: string | undefined;
	effectiveFrontmatterIdentity: FrontmatterIdentity;
	tokenUsage?: TokenUsage;
}

interface ChildPayload {
	ok: boolean;
	unverified?: string;
	skip?: boolean;
	record?: QualificationRecord;
}

class UnverifiedError extends Error {
	readonly skip: boolean;
	constructor(reason: string, skip = false) {
		super(reason);
		this.name = "UnverifiedError";
		this.skip = skip;
	}
}

function parseMode(argv: string[]): Mode {
	const index = argv.indexOf("--mode");
	const value = index >= 0 ? argv[index + 1] : undefined;
	if (value === "smoke" || value === "release") return value;
	throw new UnverifiedError("usage: --mode smoke|release", true);
}

function argValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
}

function measuredCount(mode: Mode): number {
	return mode === "smoke" ? 5 : 20;
}

function callCeiling(mode: Mode): number {
	return mode === "smoke" ? 12 : 42;
}

function modelsEqual(actual: string[] | undefined, expected: readonly string[]): boolean {
	return actual !== undefined && actual.length === expected.length && actual.every((item, i) => item === expected[i]);
}

function isSkipMessage(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes("no working credentials") ||
		lower.includes("could not resolve requested model") ||
		lower.includes("not authenticated") ||
		lower.includes("unauthenticated") ||
		lower.includes("credential") ||
		lower.includes("quota") ||
		lower.includes("rate limit") ||
		lower.includes("429") ||
		lower.includes("insufficient") ||
		(lower.includes("provider") && (lower.includes("unavailable") || lower.includes("not found"))) ||
		lower.includes("interrupted") ||
		lower.includes("sigint") ||
		lower.includes("sigterm")
	);
}

function redact(text: string): string {
	return text
		.replace(/\bauthorization\s*:\s*bearer\s+\S+/gi, "Authorization: Bearer <redacted>")
		.replace(/\bbearer\s+\S+/gi, "Bearer <redacted>")
		.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=<redacted>")
		.replace(/\bsk-[A-Za-z0-9._-]+\b/g, "<redacted>")
		.slice(0, 400);
}

function parseResolvedModel(resolved: string | undefined): { provider: string; model: string } | undefined {
	if (!resolved) return undefined;
	const slash = resolved.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = resolved.slice(0, slash);
	const rest = resolved.slice(slash + 1);
	const colon = rest.lastIndexOf(":");
	const model = colon > 0 ? rest.slice(0, colon) : rest;
	if (!provider || !model) return undefined;
	return { provider, model };
}

function usageWithoutCost(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}): TokenUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
	};
}

function childEnv(tempHome: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of DELETED_CHILD_ENV) delete env[key];
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PI_CONFIG_DIR = PI_CONFIG_DIR_NAME;
	env.OMP_PROFILE = "";
	env.PI_PROFILE = "";
	env.XDG_DATA_HOME = path.join(tempHome, "xdg-data");
	env.XDG_STATE_HOME = path.join(tempHome, "xdg-state");
	env.XDG_CACHE_HOME = path.join(tempHome, "xdg-cache");
	env.XDG_CONFIG_HOME = path.join(tempHome, "xdg-config");
	return env;
}

async function seedWorkspace(tempCwd: string): Promise<void> {
	const srcDir = path.join(tempCwd, "src", "task");
	await mkdir(srcDir, { recursive: true });
	await writeFile(
		path.join(srcDir, "review-performance.ts"),
		[
			'export type SubagentPerformanceClass = "review" | "explore" | "worker";',
			"export const EXPLORE_MAX_RUNTIME_MS = 600_000;",
			"export const REVIEW_GATE_MAX_RUNTIME_MS = 1_800_000;",
			"export function resolveClassMaxRuntimeMs(performanceClass: SubagentPerformanceClass, configuredMaxRuntimeMs: number): number {",
			"	if (configuredMaxRuntimeMs === 0) return 0;",
			'	if (performanceClass === "explore") return Math.min(configuredMaxRuntimeMs, EXPLORE_MAX_RUNTIME_MS);',
			'	if (performanceClass === "review") return Math.min(configuredMaxRuntimeMs, REVIEW_GATE_MAX_RUNTIME_MS);',
			"	return configuredMaxRuntimeMs;",
			"}",
			"export function resolveTaskSpawnRuntime(configuredMaxRuntimeMs: number): number {",
			'	return resolveClassMaxRuntimeMs("explore", configuredMaxRuntimeMs);',
			"}",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		path.join(tempCwd, "add.ts"),
		["export function add(left: number, right: number): number {", "	return left - right;", "}", ""].join("\n"),
		"utf8",
	);
	await writeFile(
		path.join(tempCwd, "add.diff"),
		[
			"diff --git a/add.ts b/add.ts",
			"--- a/add.ts",
			"+++ b/add.ts",
			"@@ -1,3 +1,3 @@",
			" export function add(left: number, right: number): number {",
			"-	return left + right;",
			"+	return left - right;",
			" }",
			"",
		].join("\n"),
		"utf8",
	);
}

function assertBundledIdentity(
	variant: Variant,
	agent: {
		source: string;
		thinkingLevel?: string;
		maxEffort?: string;
		readSummarize?: boolean;
		shadowReview?: "code";
		model?: string[];
	},
): FrontmatterIdentity {
	if (agent.source !== "bundled") {
		throw new UnverifiedError(`${variant} effectiveAgent.source is ${agent.source}, expected bundled`);
	}
	const identity: FrontmatterIdentity = {
		thinkingLevel: agent.thinkingLevel,
		maxEffort: agent.maxEffort,
		readSummarize: agent.readSummarize,
		shadowReview: agent.shadowReview,
		model: agent.model,
	};
	if (variant === "scout") {
		if (agent.thinkingLevel !== "medium" || agent.maxEffort !== "medium" || agent.readSummarize !== true) {
			throw new UnverifiedError(
				`scout identity mismatch: thinkingLevel=${agent.thinkingLevel} maxEffort=${agent.maxEffort} readSummarize=${String(agent.readSummarize)}`,
			);
		}
		if (!modelsEqual(agent.model, SCOUT_MODEL_CHAIN)) {
			throw new UnverifiedError(`scout model chain mismatch: ${JSON.stringify(agent.model)}`);
		}
	} else {
		if (agent.thinkingLevel !== "medium" || agent.maxEffort !== "xhigh" || agent.shadowReview !== "code") {
			throw new UnverifiedError(
				`reviewer identity mismatch: thinkingLevel=${agent.thinkingLevel} maxEffort=${agent.maxEffort} shadowReview=${String(agent.shadowReview)}`,
			);
		}
		if (!modelsEqual(agent.model, REVIEWER_MODEL_CHAIN)) {
			throw new UnverifiedError(`reviewer model chain mismatch: ${JSON.stringify(agent.model)}`);
		}
	}
	return identity;
}

function extractAssistantTimestamps(entries: unknown[]): number[] {
	const timestamps: number[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; message?: unknown };
		if (record.type !== "message" || !record.message || typeof record.message !== "object") continue;
		const message = record.message as { role?: unknown; timestamp?: unknown };
		if (message.role !== "assistant") continue;
		if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
			timestamps.push(message.timestamp);
		}
	}
	return timestamps;
}

async function runChild(argv: string[]): Promise<void> {
	const variant = argValue(argv, "--variant");
	const repetitionRaw = argValue(argv, "--repetition");
	const authAgentDir = argValue(argv, "--auth-agent-dir");
	if (variant !== "scout" && variant !== "reviewer") {
		throw new UnverifiedError("child requires --variant scout|reviewer", true);
	}
	const repetition = Number(repetitionRaw);
	if (!Number.isInteger(repetition) || repetition < 0) {
		throw new UnverifiedError("child requires --repetition <n>", true);
	}
	if (!authAgentDir) {
		throw new UnverifiedError("child requires --auth-agent-dir", true);
	}

	const cwd = process.cwd();
	const settings = Settings.isolated();
	const authStorage = await discoverAuthStorage(authAgentDir);
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();

	const discovery = await discoverAgents(cwd);
	const agent = getAgent(discovery.agents, variant);
	if (!agent) {
		throw new UnverifiedError(`bundled agent ${variant} not discovered`);
	}
	const frontmatterIdentity = assertBundledIdentity(variant, agent);

	const sessionManager = SessionManager.create(cwd);
	await sessionManager.setSessionName(`latency-${variant}`, "auto");
	await sessionManager.ensureOnDisk();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		throw new UnverifiedError("child session could not be persisted");
	}

	const abort = new AbortController();
	const onAbort = () => abort.abort();
	process.once("SIGINT", onAbort);
	process.once("SIGTERM", onAbort);

	const toolSession = {
		cwd,
		hasUI: false,
		suppressSpawnAdvisory: true,
		enableLsp: false,
		enableIrc: false,
		enableMCP: false,
		eventBus: new EventBus(),
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionManager.getSessionId(),
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getArtifactManager: () => sessionManager.getArtifactManager(),
		getAgentId: () => MAIN_AGENT_ID,
		getSessionSpawns: () => "*",
		getModelString: () => agent.model?.[0],
		getActiveModelString: () => agent.model?.[0],
		sessionManager,
		settings,
		authStorage,
		modelRegistry,
	} as ToolSession;

	let execution: StructuredSubagentResult;
	try {
		execution = await runStructuredSubagent({
			session: toolSession,
			invocationKind: "task",
			assignment: variant === "scout" ? SCOUT_ASSIGNMENT : REVIEWER_ASSIGNMENT,
			agent: variant,
			identity: { label: `latency-${variant}` },
			strictModelIdentity: true,
			keepAlive: false,
			enableLsp: false,
			enableIrc: false,
			signal: abort.signal,
		});
	} catch (error) {
		const message = error instanceof StructuredSubagentError ? error.message : String(error);
		throw new UnverifiedError(redact(message), isSkipMessage(message) || abort.signal.aborted);
	} finally {
		process.off("SIGINT", onAbort);
		process.off("SIGTERM", onAbort);
	}

	const result = execution.result;
	if (execution.policy.effectiveAgent.source !== "bundled" || execution.policy.agent.source !== "bundled") {
		throw new UnverifiedError(
			`${variant} dispatched source is ${execution.policy.effectiveAgent.source}, expected bundled`,
		);
	}
	assertBundledIdentity(variant, execution.policy.effectiveAgent);

	const childJsonl = path.join(execution.artifactsDir, `${result.id}.jsonl`);
	const sessionManagerChild = await SessionManager.open(childJsonl, undefined, undefined, {
		suppressBreadcrumb: true,
	});
	const timestamps = extractAssistantTimestamps(sessionManagerChild.getEntries());
	await sessionManagerChild.close();
	const activeWallMs = computeActiveWallMs(timestamps) ?? null;

	const parsedModel = parseResolvedModel(result.resolvedModel);
	const runtimeProvenance =
		parsedModel && result.resolvedModelIsFallback !== true
			? {
					source: "runtime_observed" as const,
					provider: parsedModel.provider,
					model: parsedModel.model,
					fallback: false as const,
				}
			: null;

	const record: QualificationRecord = {
		variant,
		repetition,
		completionKind: result.completionKind ?? null,
		durationMs: result.durationMs,
		activeWallMs,
		runtimeProvenance,
		hardTimeout: result.completionKind === "timeout",
		effectiveAgentSource: result.agentSource,
		effectiveModel: result.resolvedModel,
		effectiveEffort: execution.policy.effectiveAgent.thinkingLevel,
		effectiveFrontmatterIdentity: frontmatterIdentity,
		...(result.usage ? { tokenUsage: usageWithoutCost(result.usage) } : {}),
	};

	const payload: ChildPayload = { ok: true, record };
	await sessionManager.close();
	authStorage.close();
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function spawnChild(args: {
	variant: Variant;
	repetition: number;
	tempHome: string;
	tempCwd: string;
	authAgentDir: string;
	signal: AbortSignal;
}): Promise<QualificationRecord> {
	const proc = Bun.spawn(
		[
			process.execPath,
			FIXTURE_PATH,
			"--child",
			"--variant",
			args.variant,
			"--repetition",
			String(args.repetition),
			"--auth-agent-dir",
			args.authAgentDir,
		],
		{
			cwd: args.tempCwd,
			env: childEnv(args.tempHome),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const abort = () => proc.kill();
	if (args.signal.aborted) abort();
	args.signal.addEventListener("abort", abort, { once: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	args.signal.removeEventListener("abort", abort);
	if (args.signal.aborted) {
		throw new UnverifiedError("maintainer interrupted", true);
	}
	let payload: ChildPayload | undefined;
	const trimmed = stdout.trim();
	if (trimmed) {
		try {
			payload = JSON.parse(trimmed.split("\n").at(-1)!) as ChildPayload;
		} catch {
			payload = undefined;
		}
	}
	if (!payload) {
		const detail = redact(stderr.trim() || `child exit ${exitCode}`);
		throw new UnverifiedError(`partial child result: ${detail}`, isSkipMessage(detail) || exitCode === null);
	}
	if (!payload.ok || !payload.record) {
		throw new UnverifiedError(payload.unverified ?? "child failed", payload.skip === true);
	}
	if (exitCode !== 0) {
		throw new UnverifiedError(`partial child result (exit ${exitCode})`);
	}
	return payload.record;
}

function gateVariant(mode: Mode, variant: Variant, samples: QualificationRecord[]): void {
	if (samples.length !== measuredCount(mode)) {
		throw new UnverifiedError(`${variant} valid sample count ${samples.length}, expected ${measuredCount(mode)}`);
	}
	if (samples.some(sample => sample.hardTimeout)) {
		throw new UnverifiedError(`${variant} hard timeout count > 0`);
	}
	if (samples.some(sample => sample.completionKind !== "completed")) {
		throw new UnverifiedError(`${variant} non-completed completionKind`);
	}
	if (samples.some(sample => !sample.runtimeProvenance || sample.effectiveAgentSource !== "bundled")) {
		throw new UnverifiedError(`${variant} identity/provenance missing or mixed`);
	}
	const runtimeIdentities = new Set(
		samples.map(sample =>
			sample.runtimeProvenance
				? `${sample.runtimeProvenance.provider}/${sample.runtimeProvenance.model}`
				: "missing",
		),
	);
	if (runtimeIdentities.size !== 1) {
		throw new UnverifiedError(`${variant} runtime identity mixed across samples`);
	}
	if (samples.some(sample => sample.activeWallMs === null)) {
		throw new UnverifiedError(`${variant} active wall excluded (<2 assistant timestamps)`);
	}
	const walls = samples.map(sample => sample.activeWallMs!).sort((a, b) => a - b);
	const p50 = percentile(walls, 50);
	const max = walls[walls.length - 1];
	if (p50 === undefined || max === undefined) {
		throw new UnverifiedError(`${variant} percentile unavailable`);
	}
	const p50Limit = variant === "scout" ? SCOUT_P50_MS : REVIEWER_P50_MS;
	const tailLimit = variant === "scout" ? SCOUT_P90_MS : REVIEWER_P90_MS;
	if (p50 > p50Limit) {
		throw new UnverifiedError(`${variant} p50 ${p50}ms exceeds ${p50Limit}ms`);
	}
	if (max > tailLimit) {
		throw new UnverifiedError(`${variant} max ${max}ms exceeds ${tailLimit}ms`);
	}
	if (mode === "release") {
		const p90 = percentile(walls, 90);
		if (p90 === undefined || p90 > tailLimit) {
			throw new UnverifiedError(`${variant} p90 ${String(p90)}ms exceeds ${tailLimit}ms`);
		}
	}
}

function reportVariant(mode: Mode, variant: Variant, samples: QualificationRecord[]): Record<string, unknown> {
	const walls = samples.map(sample => sample.activeWallMs!).sort((a, b) => a - b);
	const p50 = percentile(walls, 50);
	const max = walls[walls.length - 1];
	const models = [...new Set(samples.map(sample => sample.effectiveModel).filter(Boolean))];
	const tokenUsage = samples.reduce(
		(sum, sample) => {
			if (!sample.tokenUsage) return sum;
			sum.input += sample.tokenUsage.input;
			sum.output += sample.tokenUsage.output;
			sum.cacheRead += sample.tokenUsage.cacheRead;
			sum.cacheWrite += sample.tokenUsage.cacheWrite;
			sum.totalTokens += sample.tokenUsage.totalTokens;
			return sum;
		},
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
	);
	const hasUsage = samples.some(sample => sample.tokenUsage);
	return {
		variant,
		n: samples.length,
		p50Ms: p50,
		maxMs: max,
		...(mode === "release" ? { p90Ms: percentile(walls, 90) } : {}),
		models,
		...(hasUsage ? { tokenUsage } : {}),
	};
}

async function runParent(argv: string[]): Promise<void> {
	const mode = parseMode(argv);
	const authAgentDir = getAgentDir();
	const abort = new AbortController();
	const onAbort = () => abort.abort();
	process.once("SIGINT", onAbort);
	process.once("SIGTERM", onAbort);

	const tempHomes: string[] = [];
	let calls = 0;
	const started = Date.now();
	const measured: Record<Variant, QualificationRecord[]> = { scout: [], reviewer: [] };
	const variants: Variant[] = ["scout", "reviewer"];

	try {
		for (const variant of variants) {
			for (let repetition = 0; repetition <= measuredCount(mode); repetition++) {
				if (abort.signal.aborted) throw new UnverifiedError("maintainer interrupted", true);
				if (calls >= callCeiling(mode)) {
					throw new UnverifiedError(`call ceiling ${callCeiling(mode)} exceeded`);
				}
				const tempHome = await mkdtemp(path.join(os.tmpdir(), "omp-latency-"));
				tempHomes.push(tempHome);
				const tempCwd = path.join(tempHome, "workspace");
				await mkdir(tempCwd, { recursive: true });
				await mkdir(path.join(tempHome, "xdg-data"), { recursive: true });
				await mkdir(path.join(tempHome, "xdg-state"), { recursive: true });
				await mkdir(path.join(tempHome, "xdg-cache"), { recursive: true });
				await mkdir(path.join(tempHome, "xdg-config"), { recursive: true });
				await seedWorkspace(tempCwd);
				calls += 1;
				const record = await spawnChild({
					variant,
					repetition,
					tempHome,
					tempCwd,
					authAgentDir,
					signal: abort.signal,
				});
				if (repetition === 0) continue;
				measured[variant].push(record);
			}
		}
		gateVariant(mode, "scout", measured.scout);
		gateVariant(mode, "reviewer", measured.reviewer);
		const report = {
			status: "PASS",
			mode,
			calls,
			elapsedMs: Date.now() - started,
			scout: reportVariant(mode, "scout", measured.scout),
			reviewer: reportVariant(mode, "reviewer", measured.reviewer),
		};
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} catch (error) {
		const unverified = error instanceof UnverifiedError ? error.message : redact(String(error));
		const skip = error instanceof UnverifiedError ? error.skip : false;
		process.stdout.write(
			`${JSON.stringify(
				{
					status: "UNVERIFIED",
					mode,
					calls,
					elapsedMs: Date.now() - started,
					skip,
					reason: unverified,
				},
				null,
				2,
			)}\n`,
		);
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", onAbort);
		process.off("SIGTERM", onAbort);
		await Promise.all(tempHomes.map(dir => rm(dir, { recursive: true, force: true })));
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	try {
		if (argv.includes("--child")) {
			await runChild(argv);
			return;
		}
		await runParent(argv);
	} catch (error) {
		const unverified = error instanceof UnverifiedError ? error.message : redact(String(error));
		const skip = error instanceof UnverifiedError ? error.skip : false;
		const payload: ChildPayload = { ok: false, skip, unverified };
		process.stdout.write(`${JSON.stringify(payload)}\n`);
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	await main();
}
