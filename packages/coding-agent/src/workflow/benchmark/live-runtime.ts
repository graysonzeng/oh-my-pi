import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-catalog";
import {
	getBundledModelReferenceIndex,
	getBundledProviderModelReferenceIndex,
	modelFamilyToken,
	resolveModelReference,
} from "@oh-my-pi/pi-catalog/identity";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { Settings } from "../../config/settings";
import { createAgentSession } from "../../sdk";
import { getDefaultConfig } from "../default-config";
import type { ModelProfile, WorkflowModelBackedStage, WorkflowStatusReportV1 } from "../types";
import { materializeBenchmarkFixture } from "./fixtures";
import type { BenchmarkRuntime, BenchmarkRuntimeRequest, BenchmarkRuntimeResponse } from "./runner";
import type { BenchmarkRuntimeProvenance } from "./types";

interface WorkflowToolDetails {
	workflowId?: string;
	status?: string;
	statusReport?: WorkflowStatusReportV1;
}

interface WorkflowToolInput {
	op: "start" | "status" | "resume";
	request?: string;
	workflowId?: string;
	degradedMode?: boolean;
	singleStep?: boolean;
}

interface WorkflowToolPort {
	execute(toolCallId: string, input: WorkflowToolInput): Promise<AgentToolResult<WorkflowToolDetails>>;
}

export interface LiveBenchmarkRuntimeOptions {
	provider: string;
	model: string;
	agentDir?: string;
	maxResumeSteps?: number;
	/** Test seam; production defaults to a real createAgentSession + workflow tool run. */
	agentRunner?: LiveBenchmarkAgentRunner;
}

export interface LiveBenchmarkAgentResult {
	terminalStatus: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheObservable: boolean;
	costUsd: number;
	usageObservable: boolean;
	toolCalls: number;
	/** Runtime-observed identity; requested flags are not accepted as provenance. */
	runtimeProvenance?: BenchmarkRuntimeProvenance;
	/** Actual fallback count when observable; omitted means unknown. */
	fallbackCount?: number;
	identityError?: string;
}

export type LiveBenchmarkAgentRunner = (
	request: BenchmarkRuntimeRequest,
	cwd: string,
	options: LiveBenchmarkRuntimeOptions,
) => Promise<LiveBenchmarkAgentResult>;

function exact<T>(value: T): { value: T; provenance: "exact" } {
	return { value, provenance: "exact" };
}

function providerFact<T>(value: T): { value: T; provenance: "provider_fact" } {
	return { value, provenance: "provider_fact" };
}

/**
 * Live fixed-model runs rewrite every profile onto one provider/model.
 * Preserve supported efforts; otherwise prefer the model default (`max` when available),
 * falling back to catalog clamp. deepseek-v4-flash defaults to max.
 * Profiles are strict-identity so quality-route snapshots can be compiled and
 * live provenance can verify configured stage routes.
 */

export function buildLiveBenchmarkProfileOverrides(
	provider: string,
	model: string,
	variant: BenchmarkRuntimeRequest["variant"],
): Record<string, Partial<ModelProfile>> {
	const modelPattern = model.includes("/") ? model : `${provider}/${model}`;
	const bareModel = model.includes("/") ? (model.split("/").pop() ?? model) : model;
	const providerReferences = getBundledProviderModelReferenceIndex(provider);
	const knownModel: Model | undefined =
		(providerReferences ? resolveModelReference(bareModel, providerReferences) : undefined) ??
		resolveModelReference(bareModel, getBundledModelReferenceIndex()) ??
		resolveModelReference(model, getBundledModelReferenceIndex());
	const supported = knownModel ? getSupportedEfforts(knownModel) : [];
	const profiles: Record<string, Partial<ModelProfile>> = {};
	for (const [id, base] of Object.entries(getDefaultConfig().profiles)) {
		let thinkingLevel: ModelProfile["thinkingLevel"] = base.thinkingLevel;
		if (knownModel) {
			if (supported.length === 0) {
				thinkingLevel = undefined;
			} else if (thinkingLevel && thinkingLevel !== "auto" && supported.includes(thinkingLevel as Effort)) {
				// keep requested supported effort
			} else if (supported.includes(Effort.Max)) {
				thinkingLevel = Effort.Max;
			} else {
				thinkingLevel = clampThinkingLevelForModel(knownModel, thinkingLevel as Effort | undefined) ?? supported[0];
			}
		}
		// Strict identity requires vendor == model lineage (not transport provider).
		const lineage = modelFamilyToken(bareModel) ?? modelFamilyToken(model) ?? provider;
		const liveIdentity: Partial<ModelProfile> = {
			vendor: lineage,
			modelPattern,
			// Fixed-model live acceptance requires strict identity + zero fallbacks.
			strictIdentity: true,
			maxRuntimeMs: 600_000,
			retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
			thinkingLevel,
		};
		profiles[id] =
			variant === "baseline"
				? {
						...liveIdentity,
						promptStrategy: undefined,
						toolStrategy: undefined,
						contextStrategy: undefined,
						outputStrategy: undefined,
						toolAliases: undefined,
						argumentAliases: undefined,
						presentationPolicy: { enabled: false, mode: "direct" },
					}
				: liveIdentity;
	}
	return profiles;
}

/**
 * Compile a single-tier quality route for live fixed-model runs.
 * One default profile id per required role is enough: live overrides rewrite every
 * profile onto the same provider/model, and provenance only needs a verified route.
 */
export function buildLiveBenchmarkQualityRoutes(): Record<
	string,
	Partial<
		Record<"planner" | "plan_reviewer" | "plan_arbitrator" | "implementer" | "code_reviewer" | "repair", string[]>
	>
> {
	const profiles = getDefaultConfig().profiles;
	const firstId = (role: "planner" | "plan_reviewer" | "implementer" | "code_reviewer" | "repair"): string => {
		const match = Object.values(profiles).find(profile => profile.roles.includes(role));
		if (!match) throw new Error(`Live benchmark missing default profile for role ${role}`);
		return match.id;
	};
	// Omit plan_arbitrator: settings resolver rejects empty arrays, and the
	// snapshot compiler treats missing optional arbitrator routes as empty.
	return {
		balanced: {
			planner: [firstId("planner")],
			plan_reviewer: [firstId("plan_reviewer")],
			implementer: [firstId("implementer")],
			code_reviewer: [firstId("code_reviewer")],
			repair: [firstId("repair")],
		},
	};
}

async function runCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
	const child = Bun.spawn(["/bin/zsh", "-dfc", command], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, output: `${stdout}${stderr}` };
}

async function initializeFixtureRepository(
	root: string,
	benchmarkCase: BenchmarkRuntimeRequest["case"],
): Promise<void> {
	await materializeBenchmarkFixture(root, benchmarkCase);
	for (const command of [
		"git init",
		"git config user.email workflow-bench@example.invalid",
		"git config user.name workflow-bench",
		"git add -A",
		"git commit -m fixture",
	]) {
		const result = await runCommand(command, root);
		if (result.exitCode !== 0) throw new Error(`Fixture setup failed: ${command}: ${result.output.slice(0, 300)}`);
	}
}

async function prepareFixture(request: BenchmarkRuntimeRequest): Promise<string> {
	if (!request.case.repoFixture) {
		throw new Error(`Live benchmark fixture is not configured: ${request.case.id}`);
	}
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-workflow-bench-${request.case.id}-`));
	await initializeFixtureRepository(root, request.case);
	return root;
}

function workflowIdFrom(result: AgentToolResult<WorkflowToolDetails>): string | undefined {
	return result.details?.workflowId;
}

async function executeWorkflow(
	tool: WorkflowToolPort,
	request: BenchmarkRuntimeRequest,
	maxResumeSteps: number,
): Promise<{ workflowId: string; terminalStatus: string; statusReport?: WorkflowStatusReportV1 }> {
	const started = await tool.execute(`workflow-bench-start-${request.repetition}`, {
		op: "start",
		request: request.case.request,
		// Quality routes require non-degraded mode; live fixed-model runs compile routes.
		degradedMode: false,
	} satisfies WorkflowToolInput);
	const workflowId = workflowIdFrom(started);
	if (!workflowId) throw new Error("Workflow start did not return a workflowId");

	let terminalStatus = started.details?.status ?? "created";
	for (let step = 0; step < maxResumeSteps && !/^(completed|blocked|cancelled|failed)$/.test(terminalStatus); step++) {
		const resumed = await tool.execute(`workflow-bench-resume-${request.repetition}-${step}`, {
			op: "resume",
			workflowId,
			singleStep: true,
		} satisfies WorkflowToolInput);
		terminalStatus = resumed.details?.status ?? terminalStatus;
	}
	const status = await tool.execute(`workflow-bench-status-${request.repetition}`, {
		op: "status",
		workflowId,
	} satisfies WorkflowToolInput);
	return { workflowId, terminalStatus, statusReport: status.details?.statusReport };
}

const REQUIRED_LIVE_MODEL_STAGES: readonly WorkflowModelBackedStage[] = [
	"planning",
	"plan_review",
	"implementing",
	"code_review",
];

export interface LiveWorkflowProvenanceVerification {
	runtimeProvenance?: BenchmarkRuntimeProvenance;
	fallbackCount: number;
	errors: string[];
}

/** Verify fixed-model provenance exclusively from hash-checked child workflow evidence. */
export function verifyLiveWorkflowProvenance(
	report: WorkflowStatusReportV1 | undefined,
	provider: string,
	model: string,
): LiveWorkflowProvenanceVerification {
	if (!report) return { fallbackCount: 0, errors: ["child workflow status evidence missing"] };
	const errors: string[] = [];
	let fallbackCount = 0;
	const qualityRouteVerified = report.qualityRoute.status === "verified";
	if (!qualityRouteVerified && report.qualityRoute.status !== "legacy") {
		errors.push(`child quality route evidence ${report.qualityRoute.status}`);
	}
	const expectedModel = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
	const configuredProfilesByStage = new Map(
		report.qualityRoute.configuredStages.map(stage => [stage.stage, stage.orderedProfileIds] as const),
	);
	const attemptsByStage = new Map<WorkflowModelBackedStage, typeof report.modelAttempts>();
	for (const attempt of report.modelAttempts) {
		const prior = attemptsByStage.get(attempt.stage) ?? [];
		prior.push(attempt);
		attemptsByStage.set(attempt.stage, prior);
	}
	for (const stage of REQUIRED_LIVE_MODEL_STAGES) {
		if ((attemptsByStage.get(stage)?.length ?? 0) === 0) errors.push(`child stage evidence missing: ${stage}`);
	}

	const identities = new Map<string, BenchmarkRuntimeProvenance>();
	for (const attempt of report.modelAttempts) {
		const configuredProfiles = configuredProfilesByStage.get(attempt.stage);
		if (attempt.status !== "completed") errors.push(`child stage attempt not completed: ${attempt.stage}`);
		if (attempt.evidenceStatus !== "verified") {
			errors.push(`child stage evidence not verified: ${attempt.stage}`);
		}
		if (!attempt.configuredProfileId) errors.push(`child configured profile missing: ${attempt.stage}`);
		if (qualityRouteVerified) {
			if (!configuredProfiles?.length) errors.push(`child configured route missing: ${attempt.stage}`);
			else if (attempt.configuredProfileId && !configuredProfiles.includes(attempt.configuredProfileId)) {
				errors.push(`child profile outside configured route: ${attempt.stage}`);
			}
		}
		if (attempt.routing.length === 0) {
			errors.push(`child routing audit missing: ${attempt.stage}`);
		} else {
			const ambiguousRouting = attempt.routing.some(
				route =>
					!route.selectedProfileId ||
					route.selectedProfileId !== attempt.configuredProfileId ||
					route.fallbackFrom !== null ||
					route.skipped.length > 0 ||
					(qualityRouteVerified && !configuredProfiles?.includes(route.selectedProfileId)),
			);
			const attemptFallbacks = Math.max(0, attempt.routing.length - 1) + (ambiguousRouting ? 1 : 0);
			fallbackCount += attemptFallbacks;
			if (attemptFallbacks > 0) errors.push(`child fallback or routing ambiguity: ${attempt.stage}`);
		}
		if (attempt.executions.length === 0) errors.push(`child runtime evidence missing: ${attempt.stage}`);
		for (const execution of attempt.executions) {
			const configured = execution.configuredIdentity;
			const attested = execution.attestedIdentity;
			if (
				execution.exactIdentityMatch !== true ||
				execution.effortSupported !== true ||
				!configured ||
				!attested ||
				(attested.provenance !== "provider_echo" && attested.provenance !== "gateway_attestation") ||
				configured.provider !== provider ||
				configured.model !== expectedModel ||
				attested.provider !== provider ||
				attested.model !== expectedModel ||
				!execution.profileId ||
				execution.profileId !== attempt.configuredProfileId
			) {
				errors.push(`child exact identity not verified: ${attempt.stage}`);
				continue;
			}
			const provenance: BenchmarkRuntimeProvenance = {
				source: "runtime_observed",
				provider: attested.provider,
				model: attested.model,
				checkpoint: attested.checkpoint,
				api: null,
				adapter: "coding-agent:workflow-child-evidence",
				parser: "workflow-status-report:v1",
			};
			identities.set(JSON.stringify([provenance.provider, provenance.model, provenance.checkpoint]), provenance);
		}
	}
	if (identities.size !== 1) errors.push(`child runtime identity mixed or missing: ${identities.size}`);
	return {
		fallbackCount,
		errors: [...new Set(errors)],
		...(errors.length === 0 && identities.size === 1 ? { runtimeProvenance: identities.values().next().value! } : {}),
	};
}

function pathAllowed(file: string, allowedPaths: readonly string[]): boolean {
	return allowedPaths.some(allowed => file === allowed || file.startsWith(`${allowed.replace(/\/$/, "")}/`));
}

async function runProductionWorkflow(
	request: BenchmarkRuntimeRequest,
	cwd: string,
	options: LiveBenchmarkRuntimeOptions,
): Promise<LiveBenchmarkAgentResult> {
	const profileOverrides = buildLiveBenchmarkProfileOverrides(options.provider, options.model, request.variant);
	const settings = Settings.isolated({
		"workflow.enabled": true,
		// Quality routes forbid degraded mode; live provenance requires a verified route snapshot.
		"workflow.degradedMode": false,
		"workflow.requireIndependentReview": false,
		"workflow.verificationCommands": request.case.verificationCommands,
		"workflow.profiles": profileOverrides,
		"workflow.qualityRoutes": buildLiveBenchmarkQualityRoutes(),
		"workflow.defaultQualityTier": "balanced",
		"workflow.presentationOptimization.enabled": request.variant === "optimized",
		"task.isolation.mode": "auto",
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: options.agentDir,
		settings,
		modelPattern: `${options.provider}/${options.model}`,
		hasUI: false,
		autoApprove: true,
		toolNames: ["workflow", "read", "bash", "grep", "glob", "edit", "write", "todo", "yield"],
	});
	try {
		const tool = session.getToolByName("workflow") as WorkflowToolPort | undefined;
		if (!tool) throw new Error("Workflow tool is unavailable in the live benchmark session");
		const workflow = await executeWorkflow(tool, request, options.maxResumeSteps ?? 32);
		const verified = verifyLiveWorkflowProvenance(workflow.statusReport, options.provider, options.model);
		const stats = session.getSessionStats();
		return {
			terminalStatus: workflow.terminalStatus,
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			cacheReadTokens: stats.tokens.cacheRead,
			cacheWriteTokens: stats.tokens.cacheWrite,
			// Outer workflow sessions do not aggregate child-agent provider usage.
			cacheObservable: false,
			usageObservable: false,
			costUsd: stats.cost,
			toolCalls: stats.toolCalls,
			fallbackCount: verified.fallbackCount,
			identityError: verified.errors.join("; ") || undefined,
			...(verified.runtimeProvenance ? { runtimeProvenance: verified.runtimeProvenance } : {}),
		};
	} finally {
		await session.dispose();
	}
}

async function observeScope(
	cwd: string,
	allowedPaths: readonly string[],
): Promise<{ scopeStatus: "adhered" | "violation"; changedFiles: string[] }> {
	const diff = await runCommand("git status --porcelain=v1 -z --untracked-files=all", cwd);
	const changedFiles = diff.output
		.split("\0")
		.filter(Boolean)
		.map(record => record.slice(3))
		.map(file => (file.includes(" -> ") ? file.slice(file.lastIndexOf(" -> ") + 4) : file));
	const scopeViolation = changedFiles.some(file => !pathAllowed(file, allowedPaths));
	return { scopeStatus: scopeViolation ? "violation" : "adhered", changedFiles };
}

async function runLiveCase(
	request: BenchmarkRuntimeRequest,
	options: LiveBenchmarkRuntimeOptions,
): Promise<BenchmarkRuntimeResponse> {
	const cwd = await prepareFixture(request);
	const startedAt = performance.now();
	try {
		let agentResult: LiveBenchmarkAgentResult;
		try {
			agentResult = await (options.agentRunner ?? runProductionWorkflow)(request, cwd, options);
		} catch (err) {
			// Availability / policy failures must still emit observed scope evidence for live gates.
			const scope = await observeScope(cwd, request.case.allowedPaths);
			return {
				passed: false,
				firstPassed: false,
				qualityScore: 0,
				durationMs: performance.now() - startedAt,
				runtimeProvenance: undefined,
				scopeStatus: scope.scopeStatus,
				error: err instanceof Error ? err.message : String(err),
				tokens: { cacheObservable: false },
				stage: {
					provider: null,
					model: null,
					durationMs: exact(performance.now() - startedAt),
					toolCalls: exact(0),
				},
			};
		}
		const verification = await Promise.all(
			request.case.verificationCommands.map(command => runCommand(command, cwd)),
		);
		const scope = await observeScope(cwd, request.case.allowedPaths);
		const passed =
			agentResult.terminalStatus === "completed" &&
			verification.every(result => result.exitCode === 0) &&
			scope.scopeStatus === "adhered" &&
			Boolean(agentResult.runtimeProvenance) &&
			agentResult.fallbackCount === 0 &&
			!agentResult.identityError;
		return {
			passed,
			firstPassed: passed,
			qualityScore: passed ? 1 : 0,
			durationMs: performance.now() - startedAt,
			runtimeProvenance: agentResult.runtimeProvenance,
			scopeStatus: scope.scopeStatus,
			error: passed
				? undefined
				: [
						`workflow=${agentResult.terminalStatus}`,
						`verification=${verification.map(result => result.exitCode).join(",")}`,
						`changed=${scope.changedFiles.join(",")}`,
						...(agentResult.identityError ? [`identity=${agentResult.identityError}`] : []),
						...(agentResult.fallbackCount === undefined ? ["fallbacks=unknown"] : []),
					].join("; "),
			tokens: {
				...(agentResult.usageObservable
					? {
							inputTokens: providerFact(agentResult.inputTokens),
							outputTokens: providerFact(agentResult.outputTokens),
							costUsd: providerFact(agentResult.costUsd),
						}
					: {}),
				...(agentResult.cacheObservable
					? {
							cacheReadTokens: providerFact(agentResult.cacheReadTokens),
							cacheWriteTokens: providerFact(agentResult.cacheWriteTokens),
						}
					: {}),
				cacheObservable: agentResult.cacheObservable,
			},
			stage: {
				provider: agentResult.runtimeProvenance?.provider ?? null,
				model: agentResult.runtimeProvenance?.model ?? null,
				durationMs: exact(performance.now() - startedAt),
				toolCalls: exact(agentResult.toolCalls),
				...(agentResult.fallbackCount === undefined ? {} : { fallbacks: exact(agentResult.fallbackCount) }),
			},
		};
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

/** Costly, credentialed benchmark path. Callers must opt in explicitly. */
export function createLiveWorkflowBenchmarkRuntime(options: LiveBenchmarkRuntimeOptions): BenchmarkRuntime {
	if (!options.provider.trim() || !options.model.trim()) {
		throw new Error("Live benchmark requires explicit provider and model values");
	}
	return request => runLiveCase(request, options);
}
