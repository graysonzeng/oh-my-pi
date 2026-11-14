/**
 * Manual product latency qualification (parent/child).
 * Not a bun:test file. Invoked via test:latency:smoke / test:latency:release
 * or the CLI flags below. Importing this module performs no provider calls.
 *
 * Live smoke/release:
 *   bun packages/coding-agent/test/task/product-latency-fixture.ts --mode smoke --output <treatment.json>
 *   bun packages/coding-agent/test/task/product-latency-fixture.ts --mode smoke --output <treatment.json> --compare-baseline <baseline.json>
 * Offline compare (no provider calls):
 *   bun packages/coding-agent/test/task/product-latency-fixture.ts --compare-baseline <baseline.json> --against <treatment.json> --output <compare.json>
 * Paired experiment (two isolated repo roots with identical harness/dependencies):
 *   --mode smoke --paired-control <root> --paired-treatment <root> --experiment advisories|sonic-effort --output <pairs.json>
 * Add --paired-preflight to verify source/config conditions without provider calls.
 * Bare `--experiment advisories|sonic-effort` (including npm aliases) fail closed into
 * paired mode and require the paired roots/output — never unpaired QUALIFICATION_VARIANTS.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
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
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, isRecord } from "@oh-my-pi/pi-utils";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import { computeActiveWallMs } from "../../src/latency/active-wall";
import { sha256Hex } from "../../src/latency/stable-serialize";
import { truncateMiddle } from "@oh-my-pi/pi-tui/tools/streaming-output";
import reviewerAssignment from "./product-latency-reviewer-assignment.md" with { type: "text" };
import scoutAssignment from "./product-latency-scout-assignment.md" with { type: "text" };
import sonicAssignment from "./product-latency-sonic-assignment.md" with { type: "text" };
import {
	type AttemptRecord,
	QUALIFICATION_OUTPUT_SCHEMAS,
	type FrontmatterIdentity,
	type Mode,
	type QualificationReport,
	REVIEWER_MODEL_CHAIN,
	SCOUT_MODEL_CHAIN,
	SONIC_MODEL_CHAIN,
	VARIANT_LIMITS,
	type TokenUsage,
	type Variant,
	buildQualificationReport,
	compareQualificationReports,
	launchCeiling,
	measuredCount,
	parseQualificationReport,
	QUALIFICATION_VARIANTS,
	scoreAttempt,
} from "./product-latency-qualification";
import {
	runPairedQualification,
	requestsPairedQualification,
	type PairedQualificationReport,
} from "./product-latency-paired";
import {
	assertQualificationSourcePair,
	captureQualificationSource,
	PAIRED_FIXTURE_PATH,
} from "./product-latency-source";
import { replaceFileAtomically } from "../../src/utils/atomic-file";

const FIXTURE_PATH = path.resolve(import.meta.path);
const PI_CONFIG_DIR_NAME = ".omp-latency-fixture";
const DELETED_CHILD_ENV = ["PI_CODING_AGENT_DIR", "COPILOT_HOME", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"] as const;
const ASSIGNMENTS: Record<Variant, string> = {
	scout: scoutAssignment.trimEnd(),
	reviewer: reviewerAssignment.trimEnd(),
	sonic: sonicAssignment.trimEnd(),
};

interface ChildRecord {
	variant: Variant;
	repetition: number;
	completionKind: string | null;
	durationMs: number | null;
	activeWallMs: number | null;
	providerRequests: number | null;
	runtimeModel: string | undefined;
	effectiveEffort: string | undefined;
	runtimeProvenance: AttemptRecord["runtimeProvenance"];
	hardTimeout: boolean;
	effectiveAgentSource: string;
	effectiveFrontmatterIdentity: FrontmatterIdentity;
	tokenUsage?: TokenUsage;
	costTotal?: number;
}

interface ChildPayload {
	ok: boolean;
	unverified?: string;
	skip?: boolean;
	record?: ChildRecord;
	scoringOutput?: unknown;
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

function usageFromResult(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost?: { total: number };
}): { tokenUsage: TokenUsage; costTotal?: number } {
	return {
		tokenUsage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
		},
		...(typeof usage.cost?.total === "number" ? { costTotal: usage.cost.total } : {}),
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
	} else if (variant === "reviewer") {
		if (agent.shadowReview !== "code") {
			throw new UnverifiedError(
				`reviewer identity mismatch: shadowReview=${String(agent.shadowReview)} thinkingLevel=${agent.thinkingLevel} maxEffort=${agent.maxEffort}`,
			);
		}
		if (!modelsEqual(agent.model, REVIEWER_MODEL_CHAIN)) {
			throw new UnverifiedError(`reviewer model chain mismatch: ${JSON.stringify(agent.model)}`);
		}
	} else {
		if (!modelsEqual(agent.model, SONIC_MODEL_CHAIN)) {
			throw new UnverifiedError(`sonic model chain mismatch: ${JSON.stringify(agent.model)}`);
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

function stubChildRecord(variant: Variant, repetition: number): ChildRecord {
	return {
		variant,
		repetition,
		completionKind: null,
		durationMs: null,
		activeWallMs: null,
		providerRequests: null,
		runtimeModel: undefined,
		effectiveEffort: undefined,
		runtimeProvenance: null,
		hardTimeout: false,
		effectiveAgentSource: "unknown",
		effectiveFrontmatterIdentity: {
			thinkingLevel: undefined,
			maxEffort: undefined,
			readSummarize: undefined,
			shadowReview: undefined,
			model: undefined,
		},
	};
}

async function flushStdout(value: unknown, pretty = false): Promise<void> {
	const text = `${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`;
	await Bun.write(Bun.stdout, text);
}

async function writeReportArtifact(outputPath: string | undefined, value: unknown): Promise<void> {
	if (!outputPath) return;
	const target = path.resolve(outputPath);
	const temporary = `${target}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
		await replaceFileAtomically(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
}

function parseChildPayload(value: unknown): ChildPayload | undefined {
	if (!isRecord(value) || typeof value.ok !== "boolean") return undefined;
	return value as unknown as ChildPayload;
}

async function readUtf8(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
	const decoder = new TextDecoder();
	const parts: string[] = [];
	for await (const line of readLines(stream, signal)) {
		parts.push(decoder.decode(line));
	}
	return parts.join("\n");
}

async function runChild(argv: string[]): Promise<void> {
	const variantRaw = argValue(argv, "--variant");
	const repetitionRaw = argValue(argv, "--repetition");
	const authAgentDir = argValue(argv, "--auth-agent-dir");
	if (variantRaw !== "scout" && variantRaw !== "reviewer" && variantRaw !== "sonic") {
		throw new UnverifiedError("child requires --variant scout|reviewer|sonic", true);
	}
	const variant = variantRaw;
	const repetition = Number(repetitionRaw);
	if (!Number.isInteger(repetition) || repetition < 0) {
		throw new UnverifiedError("child requires --repetition <n>", true);
	}
	if (!authAgentDir) {
		throw new UnverifiedError("child requires --auth-agent-dir", true);
	}
	const expectedSourceRoot = argValue(argv, "--expected-source-root");
	if (expectedSourceRoot) {
		const expectedPackage = path.join(expectedSourceRoot, "packages/coding-agent");
		const resolved = Bun.resolveSync("@oh-my-pi/pi-coding-agent/config/model-registry", import.meta.dir);
		const relative = path.relative(expectedPackage, resolved);
		if (
			FIXTURE_PATH !== path.join(expectedSourceRoot, PAIRED_FIXTURE_PATH) ||
			relative.startsWith("..") ||
			path.isAbsolute(relative)
		) {
			throw new UnverifiedError("child package resolution escaped its paired source root");
		}
	}

	const cwd = process.cwd();
	const settings = Settings.isolated();
	const authStorage = await discoverAuthStorage(authAgentDir);
	// Auth lives under --auth-agent-dir; models.yml must too. Isolated HOME
	// would otherwise make getAgentDir() miss gateway/* from ~/.omp/agent.
	const modelRegistry = new ModelRegistry(authStorage, path.join(authAgentDir, "models.yml"));
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

	let execution: StructuredSubagentResult;
	try {
		execution = await runStructuredSubagent({
			session: {
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
			} as ToolSession,
			invocationKind: "task",
			assignment: ASSIGNMENTS[variant],
			agent: variant,
			...(variant === "sonic"
				? {}
				: { outputSchema: QUALIFICATION_OUTPUT_SCHEMAS[variant], schemaMode: "strict" as const }),
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
	const usageFields = result.usage ? usageFromResult(result.usage) : {};
	const observedModel = parsedModel
		? modelRegistry
				.getAvailable()
				.find(model => model.provider === parsedModel.provider && model.id === parsedModel.model)
		: undefined;
	const effectiveEffort =
		result.resolvedThinkingLevel ??
		execution.policy.effectiveAgent.thinkingLevel ??
		(observedModel && getSupportedEfforts(observedModel).length === 0 ? "not_configurable" : undefined);
	const record: ChildRecord = {
		variant,
		repetition,
		completionKind: result.completionKind ?? null,
		durationMs: result.durationMs,
		activeWallMs,
		providerRequests: typeof result.requests === "number" ? result.requests : null,
		runtimeModel: result.resolvedModel,
		effectiveEffort,
		runtimeProvenance,
		hardTimeout: result.completionKind === "timeout",
		effectiveAgentSource: result.agentSource,
		effectiveFrontmatterIdentity: frontmatterIdentity,
		...usageFields,
	};

	await sessionManager.close();
	authStorage.close();
	const ok = result.exitCode === 0 && !result.error && !result.aborted;
	await flushStdout({
		ok,
		...(ok
			? {}
			: { unverified: redact(result.error || result.stderr || `child execution failed (exit ${result.exitCode})`) }),
		record,
		scoringOutput: result.structuredOutput?.data ?? result.output,
	} satisfies ChildPayload);
	process.exit(0);
}

async function spawnChild(args: {
	variant: Variant;
	repetition: number;
	tempHome: string;
	tempCwd: string;
	authAgentDir: string;
	signal: AbortSignal;
	sourceRoot?: string;
}): Promise<ChildPayload> {
	const timeoutMs = VARIANT_LIMITS[args.variant].tailMs;
	const proc = Bun.spawn(
		[
			process.execPath,
			args.sourceRoot ? path.join(args.sourceRoot, PAIRED_FIXTURE_PATH) : FIXTURE_PATH,
			"--child",
			"--variant",
			args.variant,
			"--repetition",
			String(args.repetition),
			"--auth-agent-dir",
			args.authAgentDir,
			...(args.sourceRoot ? ["--expected-source-root", args.sourceRoot] : []),
		],
		{
			cwd: args.tempCwd,
			env: childEnv(args.tempHome),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const abort = () => {
		if (proc.exitCode === null) proc.kill("SIGTERM");
	};
	if (args.signal.aborted) abort();
	args.signal.addEventListener("abort", abort, { once: true });

	const stderrPromise = readUtf8(proc.stderr);
	const decoder = new TextDecoder();
	const firstPayload = Promise.withResolvers<ChildPayload | undefined>();
	let payloadSettled = false;
	const stdoutPromise = (async () => {
		try {
			for await (const line of readLines(proc.stdout)) {
				if (payloadSettled) continue;
				try {
					const parsed = parseChildPayload(JSON.parse(decoder.decode(line)));
					if (parsed) {
						payloadSettled = true;
						firstPayload.resolve(parsed);
					}
				} catch {
					// non-JSON stdout
				}
			}
		} catch {
			// stdout closed
		}
		if (!payloadSettled) {
			payloadSettled = true;
			firstPayload.resolve(undefined);
		}
	})();

	const timeoutGate = Promise.withResolvers<"timeout">();
	const timeoutId = setTimeout(() => timeoutGate.resolve("timeout"), timeoutMs);
	const failChild = async (
		unverified: string,
		opts?: { skip?: boolean; hardTimeout?: boolean },
	): Promise<ChildPayload> => {
		if (proc.exitCode === null) proc.kill("SIGTERM");
		const linger = Promise.withResolvers<"linger">();
		const lingerId = setTimeout(() => linger.resolve("linger"), 2_000);
		const term = await Promise.race([proc.exited, linger.promise]);
		clearTimeout(lingerId);
		if (term === "linger" && proc.exitCode === null) proc.kill("SIGKILL");
		await proc.exited;
		return {
			ok: false,
			skip: opts?.skip === true || args.signal.aborted,
			unverified: args.signal.aborted ? "maintainer interrupted" : unverified,
			record: {
				...stubChildRecord(args.variant, args.repetition),
				hardTimeout: opts?.hardTimeout === true,
				completionKind: opts?.hardTimeout === true ? "timeout" : null,
			},
		};
	};

	try {
		const winner = await Promise.race([
			firstPayload.promise.then(payload => ({ kind: "payload" as const, payload })),
			timeoutGate.promise.then(() => ({ kind: "timeout" as const })),
		]);
		clearTimeout(timeoutId);
		if (args.signal.aborted) return await failChild("maintainer interrupted", { skip: true });
		if (winner.kind === "timeout") {
			return await failChild(`per-attempt timeout ${timeoutMs}ms`, { hardTimeout: true });
		}
		const payload = winner.payload;
		if (!payload) {
			const linger = Promise.withResolvers<"linger">();
			const lingerId = setTimeout(() => linger.resolve("linger"), 2_000);
			const exitOrLinger = await Promise.race([proc.exited, linger.promise]);
			clearTimeout(lingerId);
			if (exitOrLinger === "linger") {
				return await failChild("partial child result: child lingered without payload");
			}
			const stderr = await stderrPromise;
			const detail = redact(stderr.trim() || `child exit ${exitOrLinger}`);
			return {
				ok: false,
				skip: isSkipMessage(detail),
				unverified: `partial child result: ${detail}`,
				record: stubChildRecord(args.variant, args.repetition),
			};
		}
		const exitGate = Promise.withResolvers<number | "linger">();
		const graceId = setTimeout(() => exitGate.resolve("linger"), 2_000);
		void proc.exited.then(code => {
			clearTimeout(graceId);
			exitGate.resolve(code);
		});
		const exitOrLinger = await exitGate.promise;
		if (exitOrLinger === "linger") return await failChild("child lingered after payload");
		if (args.signal.aborted) return await failChild("maintainer interrupted", { skip: true });
		if (exitOrLinger !== 0) {
			if (payload.ok === false) return payload;
			return {
				ok: false,
				skip: isSkipMessage(payload.unverified ?? ""),
				unverified: payload.unverified ?? `child exit ${exitOrLinger}`,
				record: payload.record ?? stubChildRecord(args.variant, args.repetition),
			};
		}
		return payload;
	} finally {
		clearTimeout(timeoutId);
		args.signal.removeEventListener("abort", abort);
		await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
	}
}

function toAttempt(args: {
	variant: Variant;
	repetition: number;
	payload: ChildPayload;
	startedAt: number;
	addTsSource?: string;
}): AttemptRecord {
	const record = args.payload.record ?? stubChildRecord(args.variant, args.repetition);
	const skip = args.payload.skip === true;
	let result: AttemptRecord["result"] = "ok";
	if (skip) result = "skip";
	else if (!args.payload.ok) result = "error";
	const score = skip
		? { accepted: false, reason: args.payload.unverified ?? "skipped" }
		: !args.payload.ok
			? { accepted: false, reason: args.payload.unverified ?? "child failed" }
			: scoreAttempt(args.variant, {
					outputText: args.payload.scoringOutput,
					addTsSource: args.addTsSource,
				});
	const outputEvidence =
		args.payload.scoringOutput === undefined
			? undefined
			: truncateMiddle(
					redact(
						typeof args.payload.scoringOutput === "string"
							? args.payload.scoringOutput
							: JSON.stringify(args.payload.scoringOutput),
					),
					{ maxBytes: 2_000 },
				).content;
	return {
		variant: args.variant,
		repetition: args.repetition,
		warmup: args.repetition === 0,
		skip,
		result,
		accepted: record.completionKind === "completed" && score.accepted,
		reason:
			record.completionKind === "completed"
				? redact(score.reason)
				: `completionKind=${record.completionKind ?? "unknown"}: ${redact(score.reason)}`,
		completionKind: record.completionKind,
		durationMs: record.durationMs,
		activeWallMs: record.activeWallMs,
		acceptanceWallMs: Date.now() - args.startedAt,
		providerRequests: record.providerRequests,
		runtimeModel: record.runtimeModel,
		effectiveEffort: record.effectiveEffort,
		runtimeProvenance: record.runtimeProvenance,
		hardTimeout: record.hardTimeout,
		effectiveAgentSource: record.effectiveAgentSource,
		effectiveFrontmatterIdentity: record.effectiveFrontmatterIdentity,
		...(record.tokenUsage ? { tokenUsage: record.tokenUsage } : {}),
		...(typeof record.costTotal === "number" ? { costTotal: record.costTotal } : {}),
		...(outputEvidence !== undefined ? { outputEvidence } : {}),
	};
}

async function loadReportFile(filePath: string): Promise<QualificationReport> {
	const parsed = parseQualificationReport(JSON.parse(await Bun.file(path.resolve(filePath)).text()) as unknown);
	if ("error" in parsed) {
		throw new UnverifiedError(`invalid report ${filePath}: ${parsed.error}`, true);
	}
	return parsed;
}

async function runCompareOnly(argv: string[]): Promise<void> {
	const baselinePath = argValue(argv, "--compare-baseline");
	const againstPath = argValue(argv, "--against");
	if (!baselinePath || !againstPath) {
		throw new UnverifiedError("usage: --compare-baseline <file> --against <file>", true);
	}
	const baseline = await loadReportFile(baselinePath);
	const treatment = await loadReportFile(againstPath);
	const benefit = compareQualificationReports(baseline, treatment);
	const comparison = {
		status: benefit.status,
		benefit,
		baseline: path.resolve(baselinePath),
		against: path.resolve(againstPath),
	};
	await flushStdout(comparison, true);
	await writeReportArtifact(argValue(argv, "--output"), comparison);
	if (benefit.status !== "PASS") process.exitCode = 1;
}

async function runFixtureAttempt(args: {
	variant: Variant;
	repetition: number;
	authAgentDir: string;
	signal: AbortSignal;
	sourceRoot?: string;
	onLaunch?: () => void;
}): Promise<AttemptRecord> {
	const tempHome = await mkdtemp(path.join(os.tmpdir(), "omp-latency-"));
	try {
		const tempCwd = path.join(tempHome, "workspace");
		for (const directory of ["workspace", "xdg-data", "xdg-state", "xdg-cache", "xdg-config"]) {
			await mkdir(path.join(tempHome, directory), { recursive: true });
		}
		await seedWorkspace(tempCwd);
		args.onLaunch?.();
		const startedAt = Date.now();
		const payload = await spawnChild({ ...args, tempHome, tempCwd });
		let addTsSource: string | undefined;
		if (args.variant === "sonic") {
			try {
				addTsSource = await Bun.file(path.join(tempCwd, "add.ts")).text();
			} catch {
				addTsSource = undefined;
			}
		}
		return toAttempt({ ...args, payload, startedAt, addTsSource });
	} finally {
		await rm(tempHome, { recursive: true, force: true });
	}
}

async function runPairedParent(argv: string[]): Promise<void> {
	const mode = parseMode(argv);
	const controlRoot = argValue(argv, "--paired-control");
	const treatmentRoot = argValue(argv, "--paired-treatment");
	const experiment = argValue(argv, "--experiment");
	const outputPath = argValue(argv, "--output");
	if (
		!controlRoot ||
		!treatmentRoot ||
		!outputPath ||
		(experiment !== "advisories" && experiment !== "sonic-effort")
	) {
		throw new UnverifiedError(
			"paired mode requires --paired-control <root> --paired-treatment <root> --experiment advisories|sonic-effort --output <file>",
			true,
		);
	}
	const authAgentDir = getAgentDir();
	const modelsPath = path.join(authAgentDir, "models.yml");
	const sources = {
		control: await captureQualificationSource(controlRoot),
		treatment: await captureQualificationSource(treatmentRoot),
	};
	const changedSources = assertQualificationSourcePair(sources.control, sources.treatment, experiment);
	// The coordinator's scorer must also be the exact frozen harness in both arms.
	for (const [file, digest] of Object.entries(sources.control.files)) {
		if (!file.startsWith("packages/coding-agent/test/task/product-latency-")) continue;
		const current = path.join(import.meta.dir, path.basename(file));
		if (new Bun.CryptoHasher("sha256").update(await Bun.file(current).bytes()).digest("hex") !== digest) {
			throw new UnverifiedError(`coordinator harness differs from paired sources: ${file}`, true);
		}
	}
	const modelsConfigSha256 = sha256Hex(await Bun.file(modelsPath).text());
	const sourceEvidence = {
		sources,
		changedSources,
		runtime: { bunVersion: Bun.version, platform: process.platform, arch: process.arch },
	};
	if (argv.includes("--paired-preflight")) {
		const preflight = { status: "UNVERIFIED", phase: "preflight", experiment, modelsConfigSha256, ...sourceEvidence };
		await writeReportArtifact(outputPath, preflight);
		await flushStdout(preflight, true);
		return;
	}
	const abort = new AbortController();
	const onAbort = () => abort.abort();
	process.once("SIGINT", onAbort);
	process.once("SIGTERM", onAbort);
	const checkpoint = async (report: PairedQualificationReport) => {
		await writeReportArtifact(outputPath, { ...report, ...sourceEvidence });
	};
	try {
		const report = await runPairedQualification({
			mode,
			experiment,
			modelsConfigSha256,
			signal: abort.signal,
			checkpoint,
			verifyConditions: async () => {
				if (sha256Hex(await Bun.file(modelsPath).text()) !== modelsConfigSha256)
					throw new Error("models.yml changed during paired qualification");
				for (const source of Object.values(sources)) {
					if ((await captureQualificationSource(source.root)).fingerprint !== source.fingerprint)
						throw new Error("source changed during paired qualification");
				}
			},
			execute: slot =>
				runFixtureAttempt({
					variant: slot.variant,
					repetition: slot.repetition,
					authAgentDir,
					signal: abort.signal,
					sourceRoot: sources[slot.arm].root,
				}),
		});
		await flushStdout({ ...report, ...sourceEvidence }, true);
		if (report.status !== "PASS") process.exitCode = 1;
	} finally {
		process.off("SIGINT", onAbort);
		process.off("SIGTERM", onAbort);
	}
}

async function runParent(argv: string[]): Promise<void> {
	const mode = parseMode(argv);
	const outputPath = argValue(argv, "--output");
	const baselinePath = argValue(argv, "--compare-baseline");
	const authAgentDir = getAgentDir();
	const abort = new AbortController();
	const onAbort = () => abort.abort();
	process.once("SIGINT", onAbort);
	process.once("SIGTERM", onAbort);

	let launches = 0;
	const started = Date.now();
	const attempts: AttemptRecord[] = [];
	const ceiling = launchCeiling(mode);
	let modelsConfigSha256 = "unobserved";

	try {
		const modelsPath = path.join(authAgentDir, "models.yml");
		modelsConfigSha256 = sha256Hex(await Bun.file(modelsPath).text());
		variantLoop: for (const variant of QUALIFICATION_VARIANTS) {
			for (let repetition = 0; repetition <= measuredCount(mode); repetition++) {
				if (abort.signal.aborted) throw new UnverifiedError("maintainer interrupted", true);
				if (launches >= ceiling) {
					throw new UnverifiedError(`launch ceiling ${ceiling} exceeded`);
				}
				const attempt = await runFixtureAttempt({
					variant,
					repetition,
					authAgentDir,
					signal: abort.signal,
					onLaunch: () => {
						launches += 1;
					},
				});
				attempts.push(attempt);
				if (outputPath) {
					await writeReportArtifact(outputPath, {
						...buildQualificationReport({
							mode,
							attempts,
							launches,
							elapsedMs: Date.now() - started,
							modelsConfigSha256,
						}),
						status: "UNVERIFIED",
						phase: "in_progress",
					});
				}
				if (attempt.skip) break variantLoop;
			}
		}
		if (modelsConfigSha256 !== sha256Hex(await Bun.file(modelsPath).text())) {
			throw new UnverifiedError("models.yml changed during qualification", true);
		}

		let benefit: QualificationReport["benefit"] | undefined;
		if (baselinePath) {
			const baseline = await loadReportFile(baselinePath);
			const draft = buildQualificationReport({
				mode,
				attempts,
				launches,
				elapsedMs: Date.now() - started,
				modelsConfigSha256,
			});
			benefit = compareQualificationReports(baseline, draft);
		}
		const report = buildQualificationReport({
			mode,
			attempts,
			launches,
			elapsedMs: Date.now() - started,
			modelsConfigSha256,
			benefit,
		});
		await flushStdout(report, true);
		await writeReportArtifact(outputPath, report);
		if (report.status !== "PASS") process.exitCode = 1;
		if (report.benefit.status === "FAIL") process.exitCode = 1;
	} catch (error) {
		const unverified = error instanceof UnverifiedError ? error.message : redact(String(error));
		const skip = error instanceof UnverifiedError ? error.skip : false;
		const report = buildQualificationReport({
			mode,
			attempts,
			launches,
			elapsedMs: Date.now() - started,
			modelsConfigSha256,
			benefit: { status: "NO_BASELINE", reason: unverified },
		});
		report.status = skip ? "UNVERIFIED" : "FAIL";
		report.runtimeSmoke = { status: skip ? "UNVERIFIED" : "FAIL", reason: unverified };
		await flushStdout(
			{
				...report,
				skip,
				reason: unverified,
			},
			true,
		);
		await writeReportArtifact(outputPath, { ...report, skip, reason: unverified });
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", onAbort);
		process.off("SIGTERM", onAbort);
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	try {
		if (argv.includes("--child")) {
			await runChild(argv);
			return;
		}
		// Fail closed: --experiment advisories|sonic-effort must enter paired mode
		// (requires --paired-control/--paired-treatment/--output). Never fall through
		// to unpaired QUALIFICATION_VARIANTS, which would mis-attribute the run.
		if (requestsPairedQualification(argv)) {
			await runPairedParent(argv);
			return;
		}
		if (argValue(argv, "--against")) {
			await runCompareOnly(argv);
			return;
		}
		await runParent(argv);
	} catch (error) {
		const unverified = error instanceof UnverifiedError ? error.message : redact(String(error));
		const skip = error instanceof UnverifiedError ? error.skip : false;
		const payload: ChildPayload = { ok: false, skip, unverified };
		await flushStdout(payload);
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
