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
import type { ModelProfile, WorkflowModelBackedStage, WorkflowRole, WorkflowStatusReportV1 } from "../types";
import { materializeBenchmarkFixture } from "./fixtures";
import type { BenchmarkRuntime, BenchmarkRuntimeRequest, BenchmarkRuntimeResponse } from "./runner";
import { resolveBenchmarkExperiment } from "./runner";
import type {
	BenchmarkExperiment,
	BenchmarkRoleIdentity,
	BenchmarkRoleIdentityMap,
	BenchmarkRuntimeProvenance,
} from "./types";

export type LiveBenchmarkRoleIdentity = BenchmarkRoleIdentity;
export type LiveBenchmarkRoleIdentityMap = BenchmarkRoleIdentityMap;

interface WorkflowToolDetails {
	workflowId?: string;
	status?: string;
	statusReport?: WorkflowStatusReportV1;
}

interface WorkflowToolInput {
	op: "start" | "status" | "resume";
	request?: string;
	constraints?: string;
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
	/** Reviewer provider defaults to the primary provider at the CLI boundary. */
	reviewerProvider?: string;
	/** Reviewer model is mandatory for live runs and must be a different model family. */
	reviewerModel: string;
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

const REVIEWER_ROLES: Partial<Record<WorkflowRole, true>> = {
	plan_reviewer: true,
	plan_arbitrator: true,
	code_reviewer: true,
};

interface LiveModelIdentityInput extends BenchmarkRoleIdentity {
	bareModel: string;
	modelPattern: string;
}

interface ParsedLiveProfileArguments {
	variant: BenchmarkRuntimeRequest["variant"];
	experiment: BenchmarkExperiment;
	reviewerProvider: string;
	reviewerModel: string;
}

function isBenchmarkVariant(value: string | undefined): value is BenchmarkRuntimeRequest["variant"] {
	return value === "baseline" || value === "optimized";
}

function isBenchmarkExperiment(value: string | undefined): boolean {
	return value === "profile-strategy" || value === "presentation";
}

function normalizeLiveModelIdentity(provider: string, model: string): LiveModelIdentityInput {
	const normalizedProvider = provider.trim();
	const normalizedModel = model.trim();
	const modelPattern = normalizedModel.includes("/") ? normalizedModel : `${normalizedProvider}/${normalizedModel}`;
	const bareModel = normalizedModel.startsWith(`${normalizedProvider}/`)
		? normalizedModel.slice(normalizedProvider.length + 1)
		: (normalizedModel.split("/").pop() ?? normalizedModel);
	return { provider: normalizedProvider, model: bareModel, bareModel, modelPattern };
}

function liveModelFamily(identity: LiveModelIdentityInput): string {
	return (
		modelFamilyToken(identity.bareModel) || modelFamilyToken(identity.modelPattern) || identity.provider.toLowerCase()
	);
}

/** Fail closed before any fixture/repetition work when live roles are not independent. */
export function validateLiveBenchmarkModelPair(
	provider: string,
	model: string,
	reviewerProvider?: string,
	reviewerModel?: string,
): { primary: LiveModelIdentityInput; reviewer: LiveModelIdentityInput } {
	const primary = normalizeLiveModelIdentity(provider, model);
	if (!primary.provider || !primary.bareModel) {
		throw new Error("Live benchmark requires explicit provider and model values");
	}
	const normalizedReviewerProvider = reviewerProvider?.trim() || primary.provider;
	if (!reviewerModel?.trim()) {
		throw new Error("Live benchmark requires explicit reviewer model");
	}
	const reviewer = normalizeLiveModelIdentity(normalizedReviewerProvider, reviewerModel);
	if (liveModelFamily(primary) === liveModelFamily(reviewer)) {
		throw new Error(
			`Live benchmark reviewer model family must differ from primary model family: ` +
				`primary=${liveModelFamily(primary)} reviewer=${liveModelFamily(reviewer)}`,
		);
	}
	return { primary, reviewer };
}

/** Build the fixed role→identity contract consumed by profile compilation and provenance verification. */
export function buildLiveBenchmarkRoleIdentityMap(
	provider: string,
	model: string,
	reviewerProviderOrModel?: string,
	reviewerModel?: string,
): BenchmarkRoleIdentityMap {
	const reviewerProvider = reviewerModel === undefined ? undefined : reviewerProviderOrModel;
	const reviewerModelValue = reviewerModel ?? reviewerProviderOrModel;
	const { primary, reviewer } = validateLiveBenchmarkModelPair(provider, model, reviewerProvider, reviewerModelValue);
	return {
		planner: { provider: primary.provider, model: primary.model },
		plan_reviewer: { provider: reviewer.provider, model: reviewer.model },
		plan_arbitrator: { provider: reviewer.provider, model: reviewer.model },
		implementer: { provider: primary.provider, model: primary.model },
		code_reviewer: { provider: reviewer.provider, model: reviewer.model },
		repair: { provider: primary.provider, model: primary.model },
	};
}

function parseLiveProfileArguments(
	provider: string,
	arg3: string | undefined,
	arg4: string | undefined,
	arg5: string | undefined,
	arg6: string | undefined,
): ParsedLiveProfileArguments {
	let variant: string | undefined;
	let experiment: string | undefined;
	let reviewerProvider: string | undefined;
	let reviewerModel: string | undefined;
	if (isBenchmarkVariant(arg3)) {
		variant = arg3;
		if (isBenchmarkExperiment(arg4) || arg4 === undefined) {
			experiment = arg4;
			if (arg6 === undefined && arg5 !== undefined) {
				reviewerModel = arg5;
			} else {
				reviewerProvider = arg5;
				reviewerModel = arg6;
			}
		} else {
			reviewerProvider = arg4;
			reviewerModel = arg5;
			experiment = arg6;
		}
	} else {
		reviewerProvider = arg3;
		reviewerModel = arg4;
		variant = arg5;
		experiment = arg6;
	}
	if (!isBenchmarkVariant(variant)) {
		throw new Error(`Invalid benchmark variant=${variant ?? "undefined"}. Use baseline or optimized.`);
	}
	return {
		variant,
		experiment: resolveBenchmarkExperiment(experiment),
		reviewerProvider: reviewerProvider?.trim() || provider.trim(),
		reviewerModel: reviewerModel?.trim() || "",
	};
}

/**
 * Live fixed-model runs rewrite every profile onto its role's provider/model.
 * Planner/implementer/repair profiles use primary; plan/code arbitration reviewers use reviewer.
 * Both arms keep strict identity, fixed retry policy, and catalog-supported thinking.
 */
export function buildLiveBenchmarkProfileOverrides(
	provider: string,
	model: string,
	arg3: string | undefined,
	arg4?: string,
	arg5?: string,
	arg6?: string,
): Record<string, Partial<ModelProfile>> {
	const parsed = parseLiveProfileArguments(provider, arg3, arg4, arg5, arg6);
	const { primary, reviewer } = validateLiveBenchmarkModelPair(
		provider,
		model,
		parsed.reviewerProvider,
		parsed.reviewerModel,
	);
	const profiles: Record<string, Partial<ModelProfile>> = {};
	for (const [id, base] of Object.entries(getDefaultConfig().profiles)) {
		const target = base.roles.some(role => REVIEWER_ROLES[role] === true) ? reviewer : primary;
		const providerReferences = getBundledProviderModelReferenceIndex(target.provider);
		const knownModel: Model | undefined =
			(providerReferences ? resolveModelReference(target.bareModel, providerReferences) : undefined) ??
			resolveModelReference(target.bareModel, getBundledModelReferenceIndex()) ??
			resolveModelReference(target.modelPattern, getBundledModelReferenceIndex());
		const supported = knownModel ? getSupportedEfforts(knownModel) : [];
		let thinkingLevel: ModelProfile["thinkingLevel"] = base.thinkingLevel;
		if (knownModel) {
			if (supported.length === 0) {
				thinkingLevel = undefined;
			} else if (thinkingLevel && thinkingLevel !== "auto" && supported.includes(thinkingLevel as Effort)) {
				// Keep requested supported effort.
			} else if (supported.includes(Effort.Max)) {
				thinkingLevel = Effort.Max;
			} else {
				thinkingLevel = clampThinkingLevelForModel(knownModel, thinkingLevel as Effort | undefined) ?? supported[0];
			}
		}
		const liveIdentity: Partial<ModelProfile> = {
			vendor: modelFamilyToken(target.bareModel) || modelFamilyToken(target.modelPattern) || target.provider,
			modelPattern: target.modelPattern,
			strictIdentity: true,
			maxRuntimeMs: 600_000,
			retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
			thinkingLevel,
		};
		profiles[id] =
			parsed.experiment === "presentation"
				? liveIdentity
				: parsed.variant === "baseline"
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

export interface LiveBenchmarkExperimentConfig {
	experiment: BenchmarkExperiment;
	profileOverrides: Record<string, Partial<ModelProfile>>;
	roleIdentityMap: BenchmarkRoleIdentityMap;
	presentationOptimizationEnabled: boolean;
}

/** Compile profile, role identity, and presentation inputs for one benchmark arm. */
export function buildLiveBenchmarkExperimentConfig(
	provider: string,
	model: string,
	arg3: string | undefined,
	arg4?: string,
	arg5?: string,
	arg6?: string,
): LiveBenchmarkExperimentConfig {
	const parsed = parseLiveProfileArguments(provider, arg3, arg4, arg5, arg6);
	const roleIdentityMap = buildLiveBenchmarkRoleIdentityMap(
		provider,
		model,
		parsed.reviewerProvider,
		parsed.reviewerModel,
	);
	return {
		experiment: parsed.experiment,
		profileOverrides: buildLiveBenchmarkProfileOverrides(
			provider,
			model,
			parsed.variant,
			parsed.experiment,
			parsed.reviewerProvider,
			parsed.reviewerModel,
		),
		roleIdentityMap,
		presentationOptimizationEnabled: parsed.experiment === "presentation" && parsed.variant === "optimized",
	};
}

/**
 * Select one default profile per required role using the target role identity's model family.
 * Live overrides rewrite each selected profile onto its expected primary or reviewer identity.
 */
export function buildLiveBenchmarkQualityRoutes(
	roleIdentityMap: BenchmarkRoleIdentityMap,
): Record<
	string,
	Partial<
		Record<"planner" | "plan_reviewer" | "plan_arbitrator" | "implementer" | "code_reviewer" | "repair", string[]>
	>
> {
	const profiles = getDefaultConfig().profiles;
	const profileForRole = (role: WorkflowRole): string => {
		const candidates = Object.values(profiles).filter(profile => profile.roles.includes(role));
		const targetFamily = modelFamilyToken(roleIdentityMap[role].model);
		const match = targetFamily
			? candidates.find(profile => {
					const patterns = Array.isArray(profile.modelPattern) ? profile.modelPattern : [profile.modelPattern];
					return patterns.some(pattern => modelFamilyToken(pattern) === targetFamily);
				})
			: undefined;
		const selected = match ?? candidates[0];
		if (!selected) throw new Error(`Live benchmark missing default profile for role ${role}`);
		return selected.id;
	};
	// Arbitration is conditional at runtime, but its identity and route must be
	// compiled so a real arbitration attempt is verifiable rather than unknown.
	return {
		balanced: {
			planner: [profileForRole("planner")],
			plan_reviewer: [profileForRole("plan_reviewer")],
			plan_arbitrator: [profileForRole("plan_arbitrator")],
			implementer: [profileForRole("implementer")],
			code_reviewer: [profileForRole("code_reviewer")],
			repair: [profileForRole("repair")],
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

/**
 * Build the workflow start input for one live benchmark case.
 * The authoritative allowed/forbidden path lists become structured constraints so the
 * requirements snapshot carries the path authority instead of leaving it to model assumption
 * (reviewers otherwise emit missing_authority findings and block the scope).
 */
export function buildLiveWorkflowStartInput(benchmarkCase: BenchmarkRuntimeRequest["case"]): WorkflowToolInput {
	const constraints = [
		`Allowed paths: ${benchmarkCase.allowedPaths.join(", ")}.`,
		...(benchmarkCase.forbiddenPaths.length > 0
			? [`Forbidden paths: ${benchmarkCase.forbiddenPaths.join(", ")}.`]
			: []),
	].join("\n");
	return {
		op: "start",
		request: benchmarkCase.request,
		constraints,
		// Quality routes require non-degraded mode; live fixed-model runs compile routes.
		degradedMode: false,
	};
}

async function executeWorkflow(
	tool: WorkflowToolPort,
	request: BenchmarkRuntimeRequest,
	maxResumeSteps: number,
): Promise<{ workflowId: string; terminalStatus: string; statusReport?: WorkflowStatusReportV1 }> {
	const started = await tool.execute(
		`workflow-bench-start-${request.repetition}`,
		buildLiveWorkflowStartInput(request.case),
	);
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

const REQUIRED_LIVE_STAGE_ROLES = {
	planning: ["planner"],
	plan_review: ["plan_reviewer", "plan_arbitrator"],
	implementing: ["implementer"],
	code_review: ["code_reviewer"],
} as const satisfies Record<Exclude<WorkflowModelBackedStage, "repairing">, readonly WorkflowRole[]>;

const PRIMARY_LIVE_ROLES: readonly WorkflowRole[] = ["planner", "implementer", "repair"];

export interface LiveWorkflowProvenanceVerification {
	runtimeProvenance?: BenchmarkRuntimeProvenance;
	fallbackCount: number;
	errors: string[];
}

/** Verify fixed-model provenance exclusively from hash-checked child workflow evidence. */
export function verifyLiveWorkflowProvenance(
	report: WorkflowStatusReportV1 | undefined,
	expectedOrProvider: BenchmarkRoleIdentityMap | string,
	model?: string,
	reviewerProvider?: string | BenchmarkRoleIdentityMap,
	reviewerModel?: string,
): LiveWorkflowProvenanceVerification {
	if (!report) return { fallbackCount: 0, errors: ["child workflow status evidence missing"] };
	const expectedRoleIdentities: BenchmarkRoleIdentityMap =
		typeof expectedOrProvider === "string"
			? (() => {
					if (!model?.trim()) throw new Error("Live provenance verification requires an expected model");
					if (reviewerProvider && typeof reviewerProvider === "object") return reviewerProvider;
					if (reviewerModel?.trim()) {
						return buildLiveBenchmarkRoleIdentityMap(expectedOrProvider, model, reviewerProvider, reviewerModel);
					}
					const primary = normalizeLiveModelIdentity(expectedOrProvider, model);
					return {
						planner: primary,
						plan_reviewer: primary,
						plan_arbitrator: primary,
						implementer: primary,
						code_reviewer: primary,
						repair: primary,
					};
				})()
			: expectedOrProvider;
	const errors: string[] = [];
	let fallbackCount = 0;
	const qualityRouteVerified = report.qualityRoute.status === "verified";
	if (!qualityRouteVerified && report.qualityRoute.status !== "legacy") {
		errors.push(`child quality route evidence ${report.qualityRoute.status}`);
	}
	const configuredProfilesByStage = new Map(
		report.qualityRoute.configuredStages.map(stage => [stage.stage, stage.orderedProfileIds] as const),
	);
	for (const route of report.qualityRoute.configuredStages) {
		const expectedRole = REQUIRED_LIVE_STAGE_ROLES[route.stage as keyof typeof REQUIRED_LIVE_STAGE_ROLES];
		if (expectedRole && !expectedRole.some(role => role === route.role)) {
			errors.push(`child configured route role mismatch: ${route.stage}`);
		}
	}
	const attemptsByStage = new Map<WorkflowModelBackedStage, typeof report.modelAttempts>();
	for (const attempt of report.modelAttempts) {
		const prior = attemptsByStage.get(attempt.stage) ?? [];
		prior.push(attempt);
		attemptsByStage.set(attempt.stage, prior);
	}
	for (const stage of REQUIRED_LIVE_MODEL_STAGES) {
		if ((attemptsByStage.get(stage)?.length ?? 0) === 0) errors.push(`child stage evidence missing: ${stage}`);
	}

	const identitiesByRole = new Map<WorkflowRole, Map<string, BenchmarkRuntimeProvenance>>();
	for (const attempt of report.modelAttempts) {
		const configuredProfiles = configuredProfilesByStage.get(attempt.stage);
		const expectedRole = REQUIRED_LIVE_STAGE_ROLES[attempt.stage as keyof typeof REQUIRED_LIVE_STAGE_ROLES];
		if (expectedRole && !expectedRole.some(role => role === attempt.role)) {
			errors.push(`child stage role mismatch: ${attempt.stage}`);
		}
		const expected = expectedRoleIdentities[attempt.role];
		const expectedIdentity = expected ? normalizeLiveModelIdentity(expected.provider, expected.model) : undefined;
		if (!expectedIdentity) errors.push(`child expected role identity missing: ${attempt.role}`);
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
				!expectedIdentity ||
				(attested.provenance !== "provider_echo" && attested.provenance !== "gateway_attestation") ||
				configured.provider !== expectedIdentity.provider ||
				configured.model !== expectedIdentity.model ||
				attested.provider !== expectedIdentity.provider ||
				attested.model !== expectedIdentity.model ||
				configured.profileId !== attempt.configuredProfileId ||
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
			const roleIdentities = identitiesByRole.get(attempt.role) ?? new Map<string, BenchmarkRuntimeProvenance>();
			roleIdentities.set(JSON.stringify([provenance.provider, provenance.model, provenance.checkpoint]), provenance);
			identitiesByRole.set(attempt.role, roleIdentities);
		}
	}
	for (const [role, identities] of identitiesByRole) {
		if (identities.size !== 1) errors.push(`child runtime identity mixed or missing: ${role}:${identities.size}`);
	}
	const primaryIdentityKeys = new Set<string>();
	for (const role of PRIMARY_LIVE_ROLES) {
		for (const key of identitiesByRole.get(role)?.keys() ?? []) primaryIdentityKeys.add(key);
	}
	if (primaryIdentityKeys.size !== 1)
		errors.push(`child runtime identity mixed or missing: ${primaryIdentityKeys.size}`);
	const primaryProvenance = identitiesByRole.get("planner")?.values().next().value;
	return {
		fallbackCount,
		errors: [...new Set(errors)],
		...(errors.length === 0 && primaryIdentityKeys.size === 1 && primaryProvenance
			? { runtimeProvenance: primaryProvenance }
			: {}),
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
	const experimentConfig = buildLiveBenchmarkExperimentConfig(
		options.provider,
		options.model,
		request.variant,
		request.experiment,
		options.reviewerProvider,
		options.reviewerModel,
	);
	const settings = Settings.isolated({
		"workflow.enabled": true,
		// Quality routes forbid degraded mode; live provenance requires a verified route snapshot.
		"workflow.degradedMode": false,
		"workflow.requireIndependentReview": true,
		"workflow.verificationCommands": request.case.verificationCommands,
		"workflow.profiles": experimentConfig.profileOverrides,
		"workflow.qualityRoutes": buildLiveBenchmarkQualityRoutes(experimentConfig.roleIdentityMap),
		"workflow.defaultQualityTier": "balanced",
		"workflow.presentationOptimization.enabled": experimentConfig.presentationOptimizationEnabled,
		"task.isolation.mode": "auto",
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: options.agentDir,
		settings,
		modelPattern: normalizeLiveModelIdentity(options.provider, options.model).modelPattern,
		hasUI: false,
		autoApprove: true,
		toolNames: ["workflow", "read", "bash", "grep", "glob", "edit", "write", "todo", "yield"],
	});
	try {
		const tool = session.getToolByName("workflow") as WorkflowToolPort | undefined;
		if (!tool) throw new Error("Workflow tool is unavailable in the live benchmark session");
		const workflow = await executeWorkflow(tool, request, options.maxResumeSteps ?? 32);
		const verified = verifyLiveWorkflowProvenance(workflow.statusReport, experimentConfig.roleIdentityMap);
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
	const { primary, reviewer } = validateLiveBenchmarkModelPair(
		options.provider,
		options.model,
		options.reviewerProvider,
		options.reviewerModel,
	);
	const normalizedOptions: LiveBenchmarkRuntimeOptions = {
		...options,
		provider: primary.provider,
		model: primary.model,
		reviewerProvider: reviewer.provider,
		reviewerModel: reviewer.model,
	};
	return request => runLiveCase(request, normalizedOptions);
}
