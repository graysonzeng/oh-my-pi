import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	buildLatencyRolloutDecision,
	freezeLatencyArmSnapshot,
	LATENCY_ARM_IDS,
	LATENCY_ARM_SETTINGS,
	LATENCY_ROLLOUT_DECISION_KIND,
	type LatencyArmId,
} from "../latency/arms";
import type { WorkflowConcurrencyDeclarationV1 } from "../latency/concurrency-declaration";
import {
	readyConcurrencyUnits,
	resolveEffectiveConcurrency,
	shouldAutoParallel,
	validateConcurrencyDeclaration,
} from "../latency/concurrency-declaration";
import {
	classifyPlanMechanicalImplementer,
	isVeryComplexImplementerPlan,
	parseWorkflowMechanicalClass,
} from "../latency/mechanical-class";
import { ProviderHealthBreaker } from "../latency/provider-health-breaker";
import {
	computeLatencyCohortMetrics,
	deriveLatencyCohortKey,
	LATENCY_BASELINE_COHORT_KEY,
	LatencyRolloutCohortStore,
	type LatencyRolloutObservationV1,
} from "../latency/rollout-cohort";
import gateReviewAdapterPrompt from "../prompts/workflow/gate-review-adapter.md" with { type: "text" };
import type { ToolSession } from "../tools";
import * as git from "../utils/git";
import {
	abortRegisteredWorkflow,
	registerWorkflowAbort,
	unregisterWorkflowAbort,
	workflowAbortSettlement,
} from "./abort-registry";
import { resolveArtifactInclusion } from "./artifact-inclusion";
import { ArtifactStore } from "./artifact-store";
import {
	AUTHOR_RESPONSES_KIND,
	buildAuthorResponsesArtifact,
	hasMaxCyclesAuthorReject,
	isAuthorResponsesArtifact,
	validateAuthorResponses,
} from "./author-responses";
import {
	assertRequiredRolesAvailable,
	isDiagnosticAvailabilityTimeout,
	runAvailabilityPreflight,
	skippedAvailabilityReport,
} from "./availability-preflight";
import { BudgetLedger, type BudgetSnapshot } from "./budget-ledger";
import { ContextBuilder } from "./context-builder";
import { getDefaultConfig, type WorkflowDefaultConfig } from "./default-config";
import {
	BudgetExhaustedError,
	mapWorkflowErrorOutcome,
	WorkflowCancelledError,
	WorkflowError,
	WorkflowPolicyError,
	WorkflowTimeoutError,
} from "./errors";
import { FindingTracker } from "./finding-tracker";
import { gateAdapter } from "./gate-adapter";
import { derivePlanReviewArtifactV2, deriveReviewArtifact, stampGateResultArtifact } from "./gate-derive";
import { assertStrictRuntimeIdentity } from "./identity-receipt";
import { GateResultJsonSchema } from "./json-schemas";
import {
	assertSupportedModelProfile,
	configuredIdentityForProfile,
	normalizeModelProfile,
} from "./model-profile-registry";
import { ModelRouter, type RouteOptions, type RoutingDecision } from "./model-router";
import { sha256Hex } from "./optimization-receipt";
import {
	appendGrillAnswers,
	type CreateWorkflowOptions,
	emptyDevflowSidecar,
	isAwaitingGrill,
	overlayReason,
	type PipelineAuditor,
	type PipelineAuditorInput,
	type PipelineCompletenessResult,
	sidecarIdle,
	sidecarWithGrillPause,
} from "./overlay";
import { derivePlanReviewTrigger } from "./plan-review-trigger";
import {
	compileQualityRouteSnapshot,
	qualityRouteProfileIds,
	qualityRouteProfiles,
	verifyQualityRouteSnapshot,
} from "./quality-route-snapshot";
import {
	buildRequirementsSnapshot,
	isRequirementsSnapshot,
	REQUIREMENTS_SNAPSHOT_KIND,
	validateApprovedMandatoryCoverage,
} from "./requirements-snapshot";
import { RuntimeAdapter } from "./runtime-adapter";
import { type GateResultModel, PlanReviewControlStateSchema, parseGateResultArtifact } from "./schemas";
import {
	buildScopeMetrics,
	collectScopeMetricsFromGit,
	plannedFilesFromPlan,
	type ScopeMetricsV1,
} from "./scope-metrics";
import { redactSecretsInText } from "./secret-redact";
import { sessionFallbackImplementerProfile } from "./session-fallback-profile";
import type { PersistedWorkflowSnapshot } from "./sqlite-store";
import { WorkflowStore } from "./sqlite-store";
import {
	buildImplementerToReviewerHandoff,
	buildKeepAllHandoff,
	buildPlannerToImplementerHandoff,
	buildReviewerToRepairHandoff,
} from "./stage-handoff";
import { CodeReviewStage } from "./stages/code-review";
import { FinalVerifyStage } from "./stages/final-verify";
import { ImplementStage } from "./stages/implement";
import { changedFilesFromPatch, ImplementationVerifyStage } from "./stages/implementation-verify";
import { PlanStage } from "./stages/plan";
import type { PlanReviewStageResult } from "./stages/plan-review";
import { PlanReviewStage } from "./stages/plan-review";
import { RepairStage } from "./stages/repair";
import { getNextStage, isValidTransition } from "./transitions";
import type {
	Artifact,
	AuthorResponseV1,
	CapturedChangesMergeResult,
	ImplementationArtifactV1,
	ModelIdentityProvenance,
	ModelProfile,
	PlanArtifactV1,
	PlanReviewArtifact,
	PlanReviewControlStateV1,
	PlanReviewRouteSelectionV1,
	PlanReviewTriggerReasonV1,
	QualityRouteSnapshotV1,
	RequirementsSnapshotV1,
	ReviewArtifactV1,
	ReviewFindingV1,
	RuntimePort,
	StageHandoffArtifactRef,
	StageHandoffV1,
	VerificationArtifactV1,
	VerifierPort,
	WorkflowAvailabilityPort,
	WorkflowAvailabilityReport,
	WorkflowCompletionKind,
	WorkflowConfiguredIdentityEvidenceV1,
	WorkflowConfiguredStageRouteEvidenceV1,
	WorkflowEvidenceStatus,
	WorkflowIdentityCoordinatesEvidenceV1,
	WorkflowModelAttemptEvidenceV1,
	WorkflowModelBackedStage,
	WorkflowModelExecutionEvidenceV1,
	WorkflowRequest,
	WorkflowRole,
	WorkflowRoutingDecisionEvidenceV1,
	WorkflowRuntimeEvidence,
	WorkflowRuntimeIdentityReceiptV1,
	WorkflowState,
	WorkflowStatus,
	WorkflowStatusReportV1,
	WorkPackageStateArtifactV1,
} from "./types";
import { Verifier } from "./verifier";
import {
	aggregateWorkPackageImplementations,
	buildWorkPackageExecutionPlan,
	executeWorkPackagePlan,
	renderWorkPackageAssignment,
	WorkPackageExecutionError,
	withWorkPackageMerge,
	withWorkPackageMergePrepared,
	workPackagesToConcurrencyDeclaration,
} from "./work-packages";

const TERMINAL: ReadonlySet<WorkflowStatus> = new Set(["completed", "blocked", "cancelled", "failed"]);

const MODEL_STAGE_ROLES: readonly Readonly<{ stage: WorkflowModelBackedStage; role: WorkflowRole }>[] = [
	{ stage: "planning", role: "planner" },
	{ stage: "plan_review", role: "plan_reviewer" },
	{ stage: "implementing", role: "implementer" },
	{ stage: "code_review", role: "code_reviewer" },
	{ stage: "repairing", role: "repair" },
];

type PlanReviewerIdentity = Readonly<{
	profileId: string;
	provider: string;
	model: string;
	modelFamily: string | undefined;
	attestedProvenance: Extract<ModelIdentityProvenance, "provider_echo" | "gateway_attestation">;
	exactMatch: boolean | null;
}>;

/**
 * Pin only runtime-attested provider/model coordinates.
 * Configured/local resolution alone is insufficient — provider drift would
 * otherwise pass rereview equality checks without a real runtime receipt.
 */
function resolvePlanReviewerIdentity(
	profile: ModelProfile,
	result: PlanReviewStageResult,
): PlanReviewerIdentity | null {
	const receipt = result.identityReceipt;
	if (!receipt) return null;
	const provenance = receipt.attested.provenance;
	if (provenance !== "provider_echo" && provenance !== "gateway_attestation") return null;
	const attestedProvider = receipt.attested.provider?.trim() ?? "";
	const attestedModel = receipt.attested.model?.trim() ?? "";
	if (!attestedProvider || !attestedModel) return null;
	// Explicit mismatch against configured exact identity is fail-closed.
	if (receipt.exactMatch === false) return null;
	return {
		profileId: profile.id,
		provider: attestedProvider,
		model: attestedModel,
		modelFamily: receipt.modelFamily ?? result.modelFamily ?? undefined,
		attestedProvenance: provenance,
		exactMatch: receipt.exactMatch,
	};
}

const IDENTITY_PROVENANCE: Record<ModelIdentityProvenance, true> = {
	configured: true,
	local_resolution: true,
	provider_echo: true,
	gateway_attestation: true,
	unknown: true,
};

function evidenceRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function evidenceString(value: unknown): string | null {
	return typeof value === "string" ? redactSecretsInText(value).slice(0, 500) : null;
}

function evidenceBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function evidenceProvenance(value: unknown): ModelIdentityProvenance {
	return typeof value === "string" && IDENTITY_PROVENANCE[value as ModelIdentityProvenance] === true
		? (value as ModelIdentityProvenance)
		: "unknown";
}

function identityCoordinatesEvidence(value: unknown): WorkflowIdentityCoordinatesEvidenceV1 | null {
	const record = evidenceRecord(value);
	if (!record) return null;
	return {
		provider: evidenceString(record.provider),
		model: evidenceString(record.model),
		checkpoint: evidenceString(record.checkpoint),
		provenance: evidenceProvenance(record.provenance),
	};
}

function configuredIdentityEvidence(value: unknown): WorkflowConfiguredIdentityEvidenceV1 | null {
	const record = evidenceRecord(value);
	if (!record) return null;
	return {
		...identityCoordinatesEvidence(record)!,
		profileId: evidenceString(record.profileId),
		modelPattern: evidenceString(record.modelPattern),
		requestedEffort: evidenceString(record.requestedEffort),
		modelFamily: evidenceString(record.modelFamily),
	};
}

function evidenceStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return null;
	return value.map(item => evidenceString(item)!);
}

function routingDecisionEvidence(value: unknown): WorkflowRoutingDecisionEvidenceV1 | null {
	const record = evidenceRecord(value);
	if (!record) return null;
	const reason = evidenceString(record.reason);
	const skipped = Array.isArray(record.skipped)
		? record.skipped.flatMap(item => {
				const skip = evidenceRecord(item);
				if (!skip) return [];
				return [{ profileId: evidenceString(skip.profileId), reason: evidenceString(skip.reason) ?? "unknown" }];
			})
		: [];
	return {
		selectedProfileId: evidenceString(record.profileId),
		configuredProfileIds: evidenceStringArray(record.candidateProfileIds),
		reason,
		fallbackFrom: reason?.startsWith("fallback_from:") ? reason.slice("fallback_from:".length) || null : null,
		skipped,
	};
}

function modelExecutionEvidence(value: unknown): WorkflowModelExecutionEvidenceV1 | null {
	const record = evidenceRecord(value);
	if (!record) return null;
	return {
		profileId: evidenceString(record.profileId),
		configuredIdentity: configuredIdentityEvidence(record.configuredIdentity),
		localResolution: identityCoordinatesEvidence(record.localResolution),
		attestedIdentity: identityCoordinatesEvidence(record.attestedIdentity),
		exactIdentityMatch: evidenceBoolean(record.exactIdentityMatch),
		effortSupported: evidenceBoolean(record.effortSupported),
		modelFamily: evidenceString(record.modelFamily),
		toolPolicyId: evidenceString(record.toolPolicyId) ?? evidenceString(record.resolvedToolPolicyId),
		completionKind: evidenceCompletionKind(record.completionKind),
	};
}

function completionKindFromError(error: unknown): WorkflowCompletionKind | null {
	if (!(error instanceof WorkflowError)) return null;
	const fromDetails = evidenceCompletionKind(evidenceRecord(error.details)?.completionKind);
	if (fromDetails) return fromDetails;
	if (error instanceof BudgetExhaustedError) return "budget_stop";
	if (error instanceof WorkflowTimeoutError) return "timeout";
	if (error instanceof WorkflowCancelledError) return "hard_abort";
	return null;
}
function evidenceCompletionKind(value: unknown): WorkflowCompletionKind | null {
	return value === "completed" || value === "budget_stop" || value === "timeout" || value === "hard_abort"
		? value
		: null;
}

function modelStageRole(stage: string): Readonly<{ stage: WorkflowModelBackedStage; role: WorkflowRole }> | null {
	return MODEL_STAGE_ROLES.find(entry => entry.stage === stage) ?? null;
}

function isLatencyArmEnabled(session: ToolSession, arm: LatencyArmId): boolean {
	if (session.isLatencyArmEnabled) return session.isLatencyArmEnabled(arm);
	return session.settings.get(LATENCY_ARM_SETTINGS[arm]) === true;
}

export interface WorkflowEngineOptions {
	store?: WorkflowStore;
	router?: ModelRouter;
	adapter?: RuntimePort;
	/** Dedicated availability probe port (not RuntimePort). Optional: skips live preflight when absent. */
	availability?: WorkflowAvailabilityPort;
	verifier?: VerifierPort;
	budgetLedger?: BudgetLedger;
	findingTracker?: FindingTracker;
	artifactStore?: ArtifactStore;
	/** Required for stages that call the runtime; tests inject a fake session. */
	session?: ToolSession;
	signal?: AbortSignal;
	config?: Partial<WorkflowDefaultConfig>;
	/** Cohort observation store for rollout guardrails; defaults to the machine-level JSONL. */
	latencyCohortStore?: LatencyRolloutCohortStore;
	/** When true (default if store was created by engine), dispose() closes SQLite. */
	ownsStore?: boolean;
	/** Injected clock for the engine-scoped provider-health breaker. */
	nowMs?: () => number;
	/** Optional process-local breaker (tests); default is a new engine-scoped instance. */
	providerHealthBreaker?: ProviderHealthBreaker;
	/** Devflow completeness oneshot. Missing auditor fail-closes as incomplete. */
	pipelineAuditor?: PipelineAuditor;
}

export interface WorkflowStartResult {
	workflowId: string;
	availability: WorkflowAvailabilityReport;
}

export interface WorkflowRunResult {
	state: WorkflowState;
	plan?: PlanArtifactV1;
	planReview?: PlanReviewArtifact;
	implementation?: ImplementationArtifactV1;
	verification?: VerificationArtifactV1;
	codeReview?: ReviewArtifactV1;
	finalVerification?: VerificationArtifactV1;
	workPackageState?: WorkPackageStateArtifactV1;
	routingAudit: Array<Record<string, unknown>>;
	/** Preflight report from this start/resume invocation (when availability port is configured). */
	availability?: WorkflowAvailabilityReport;
	stepsExecuted: number;
	maxStepsReached: boolean;
	awaitingGrill: boolean;
	overlayReason?: string;
}

/**
 * Deterministic multi-stage workflow engine.
 * Models return artifacts only; this class owns transitions, budget, cancel, and resume.
 */
export class WorkflowEngine {
	readonly #store: WorkflowStore;
	#router: ModelRouter;
	readonly #configuredRouter: ModelRouter;
	readonly #budgetLedger: BudgetLedger;
	#findingTracker: FindingTracker;
	readonly #adapter: RuntimePort;
	readonly #availability: WorkflowAvailabilityPort | undefined;
	readonly #verifier: VerifierPort;
	readonly #artifactStore: ArtifactStore;
	readonly #latencyCohortStore: LatencyRolloutCohortStore;
	readonly #contextBuilder = new ContextBuilder();
	readonly #session: ToolSession | undefined;
	readonly #config: WorkflowDefaultConfig;
	readonly #routingAudit: Array<Record<string, unknown>> = [];
	readonly #runnerOwnerId = `runner_${randomUUID()}`;
	/** When true, dispose() closes the store (tool-owned ephemeral engines). */
	readonly #ownsStore: boolean;
	#controller: AbortController | undefined;
	/** Active abort signal for the current run/resume (may be overridden per resume call). */
	#signal: AbortSignal | undefined;
	/** Last preflight report from start/resume (for tool surfacing / tests). */
	#lastAvailability: WorkflowAvailabilityReport | undefined;
	#qualityRouteSnapshot: QualityRouteSnapshotV1 | undefined;
	#qualityRouteArtifactPersisted = false;
	/** Workflows whose latency rollout decision is already persisted (terminal evaluated once). */
	readonly #latencyRolloutPersisted = new Set<string>();
	#preflightUnavailableReasons: Record<string, string> = {};
	readonly #providerHealthBreaker: ProviderHealthBreaker;
	readonly #pipelineAuditor: PipelineAuditor | undefined;

	// In-memory artifact cache for the current process (also persisted to store)
	#plan: PlanArtifactV1 | undefined;
	#planReview: PlanReviewArtifact | undefined;
	#implementation: ImplementationArtifactV1 | undefined;
	#verification: VerificationArtifactV1 | undefined;
	#codeReview: ReviewArtifactV1 | undefined;
	#finalVerification: VerificationArtifactV1 | undefined;
	#workPackageState: WorkPackageStateArtifactV1 | undefined;
	/** Durable refs for stage-handoff sizing / recovery (source artifacts never deleted). */
	#planArtifactRef: StageHandoffArtifactRef | undefined;
	#planArtifactSha256: string | undefined;
	#planReviewArtifactRef: StageHandoffArtifactRef | undefined;
	#implementationArtifactRef: StageHandoffArtifactRef | undefined;
	#verificationArtifactRef: StageHandoffArtifactRef | undefined;
	#codeReviewArtifactRef: StageHandoffArtifactRef | undefined;
	/** Real patch content persisted for implement→review handoff recovery. */
	#patchArtifactRef: StageHandoffArtifactRef | undefined;
	#plannerProfileId: string | undefined;
	#plannerVendor: string | undefined;
	#implementerVendor: string | undefined;
	#plannerModelFamily: string | undefined;
	#implementerModelFamily: string | undefined;
	#planReviewerIdentity: PlanReviewerIdentity | undefined;
	#planReviewerRouteSelectionRef: StageHandoffArtifactRef | undefined;
	#planReviewControl: PlanReviewControlStateV1 | undefined;
	#requirementsSnapshot: RequirementsSnapshotV1 | undefined;
	#requirementsSnapshotRef: StageHandoffArtifactRef | undefined;
	#authorResponses: AuthorResponseV1[] | undefined;
	#authorResponsesPriorFindings: Array<Pick<ReviewFindingV1, "id" | "priority">> | undefined;
	#authorResponsesArtifactRef: StageHandoffArtifactRef | undefined;
	#planCycles = 0;
	#lastRouteProfileId: string | undefined;
	#activeWorkflowId: string | undefined;
	#lastScopeMetrics: ScopeMetricsV1 | undefined;

	constructor(options: WorkflowEngineOptions = {}) {
		this.#ownsStore = options.ownsStore ?? options.store === undefined;
		this.#store = options.store ?? new WorkflowStore();
		this.#latencyCohortStore = options.latencyCohortStore ?? new LatencyRolloutCohortStore();
		this.#providerHealthBreaker =
			options.providerHealthBreaker ?? new ProviderHealthBreaker({ nowMs: options.nowMs });
		const mergedConfig = { ...getDefaultConfig(), ...options.config };
		const normalizedProfiles = Object.fromEntries(
			Object.entries(mergedConfig.profiles).map(([key, profile]) => {
				const normalized = normalizeModelProfile(profile);
				assertSupportedModelProfile(normalized);
				return [key, normalized];
			}),
		);
		this.#config = { ...mergedConfig, profiles: normalizedProfiles };
		const profiles = Object.values(normalizedProfiles);
		this.#configuredRouter = options.router ?? new ModelRouter(profiles);
		this.#router = this.#configuredRouter;
		// Production wiring injects createDefaultRuntimeAdapter(); pure tests inject fakes.
		// No default real runner here — avoids task/natives load and AGENTS.md dynamic-import ban.
		this.#adapter =
			options.adapter ??
			new RuntimeAdapter(async () => {
				throw new WorkflowPolicyError("runtime_adapter_required", {
					hint: "Pass adapter or use createDefaultRuntimeAdapter()",
				});
			});
		this.#availability = options.availability;
		this.#session = options.session;
		this.#signal = options.signal;
		const cwd = options.session?.cwd ?? process.cwd();
		// Configured verification commands must be on the verifier allowlist (exact match).
		this.#verifier =
			options.verifier ??
			new Verifier({
				cwd,
				allowedCommandPrefixes: [
					...this.#config.verificationCommands,
					"echo ",
					"echo ok",
					"git diff --check",
					"git status",
					"git status --short",
					"biome check",
					"bun test",
				],
			});
		this.#budgetLedger =
			options.budgetLedger ??
			new BudgetLedger({
				limitUsd: this.#config.maxBudgetUsd,
				maxRepairCycles: this.#config.maxRepairCycles,
			});
		this.#findingTracker = options.findingTracker ?? new FindingTracker();
		this.#artifactStore = options.artifactStore ?? new ArtifactStore();
		this.#pipelineAuditor = options.pipelineAuditor;
	}

	/** Flash completeness oneshot. Missing auditor fail-closes as incomplete. */
	async auditPipelineCompleteness(input: PipelineAuditorInput): Promise<PipelineCompletenessResult> {
		if (!this.#pipelineAuditor) {
			return {
				complete: false,
				missing: ["pipeline_auditor_unavailable"],
				next: "Provide a complete executable request.",
			};
		}
		return this.#pipelineAuditor(input);
	}

	/** Close owned SQLite handle (idempotent). */
	dispose(): void {
		if (this.#ownsStore) {
			try {
				this.#store.close();
			} catch {
				// already closed
			}
		}
	}

	/**
	 * Create workflow, run readiness preflight, return id + availability report.
	 * Does not execute stages (existing create-without-run semantics).
	 */
	async start(
		request: WorkflowRequest | Record<string, unknown>,
		policyOverrides: Record<string, unknown> = {},
		createOpts?: CreateWorkflowOptions,
	): Promise<WorkflowStartResult> {
		const requestedTier = (request as Record<string, unknown>).qualityTier;
		if (requestedTier !== undefined && requestedTier !== "balanced" && requestedTier !== "critical") {
			throw new WorkflowPolicyError("unknown_quality_tier", { qualityTier: requestedTier });
		}
		const qualityRoutesConfigured = Object.keys(this.#config.qualityRoutes).length > 0;
		let persistedRequest: WorkflowRequest | Record<string, unknown> = request;
		let routeSnapshot: QualityRouteSnapshotV1 | undefined;
		if (qualityRoutesConfigured || requestedTier !== undefined) {
			const qualityTier = requestedTier ?? this.#config.defaultQualityTier;
			const degradedMode =
				typeof policyOverrides.degradedMode === "boolean"
					? policyOverrides.degradedMode
					: this.#config.degradedMode;
			if (degradedMode) {
				throw new WorkflowPolicyError("quality_route_degraded_mode_forbidden", { qualityTier });
			}
			routeSnapshot = compileQualityRouteSnapshot(this.#config, qualityTier);
			this.#activateQualityRoute(routeSnapshot);
			persistedRequest = { ...request, qualityTier };
		}
		const policy = {
			degradedMode: routeSnapshot ? false : this.#config.degradedMode,
			requireIndependentReview: this.#config.requireIndependentReview,
			...policyOverrides,
			...(routeSnapshot
				? { degradedMode: false, qualityRouteRequired: true, qualityRouteSnapshot: routeSnapshot }
				: {}),
		};
		const preflightWorkflowId = `wf_preflight_${randomUUID()}`;
		const availability = await this.#runPreflight({
			workflowId: preflightWorkflowId,
			operation: "start",
			status: "created",
			singleStep: false,
			session: this.#session,
			signal: this.#signal,
			failClosed: routeSnapshot !== undefined,
			persistBudget: false,
		});
		const resolvedCreateOpts =
			createOpts?.pipelineKind === "devflow"
				? {
						pipelineKind: "devflow" as const,
						overlaySidecar: createOpts.overlaySidecar ?? emptyDevflowSidecar(),
						ownerSessionId: createOpts.ownerSessionId,
					}
				: createOpts;
		const workflowId = await this.#store.createWorkflow(persistedRequest, policy, resolvedCreateOpts);
		await this.#store.saveBudgetTotals(
			workflowId,
			this.#budgetLedger.snapshot() as unknown as Record<string, unknown>,
		);
		const persistedAvailability = { ...availability, workflowId };
		this.#lastAvailability = persistedAvailability;
		return { workflowId, availability: persistedAvailability };
	}

	/**
	 * Create workflow and run preflight; returns workflow id only (compat).
	 * Prefer `start()` when the caller needs the availability report.
	 */
	async startWorkflow(
		request: WorkflowRequest | Record<string, unknown>,
		policyOverrides: Record<string, unknown> = {},
	): Promise<string> {
		const result = await this.start(request, policyOverrides);
		return result.workflowId;
	}

	/** Most recent preflight report from start/resume on this engine instance. */
	getLastAvailabilityReport(): WorkflowAvailabilityReport | undefined {
		return this.#lastAvailability;
	}

	async findActiveDeliveryWorkflow(ownerSessionId: string): Promise<WorkflowState | null> {
		return this.#store.findLatestActiveDevflow(ownerSessionId);
	}
	async getState(workflowId: string): Promise<WorkflowState | null> {
		return this.#store.getCurrentState(workflowId);
	}

	/**
	 * Rebuild a secret-safe status/evidence projection exclusively from persisted state and
	 * hash-verified artifact bodies. Runtime settings and in-memory routing state are not consulted.
	 */
	async getStatusReport(workflowId: string): Promise<WorkflowStatusReportV1 | null> {
		const snapshot = await this.#store.resumeFromPersistedState(workflowId);
		if (!snapshot) return null;

		let qualityStatus: WorkflowEvidenceStatus = "legacy";
		let qualityTier: QualityRouteSnapshotV1["qualityTier"] | null = null;
		let snapshotFingerprint: string | null = null;
		let configuredStages: WorkflowConfiguredStageRouteEvidenceV1[] = MODEL_STAGE_ROLES.map(entry => ({
			...entry,
			orderedProfileIds: null,
		}));
		let policy: Record<string, unknown> | null = null;
		try {
			policy = evidenceRecord(JSON.parse(snapshot.state.policyJson));
			if (!policy) qualityStatus = "invalid";
		} catch {
			qualityStatus = "invalid";
		}
		const persistedRoute = policy?.qualityRouteSnapshot;
		if (persistedRoute !== undefined) {
			const rawRoute = evidenceRecord(persistedRoute);
			qualityTier =
				rawRoute?.qualityTier === "balanced" || rawRoute?.qualityTier === "critical" ? rawRoute.qualityTier : null;
			snapshotFingerprint = evidenceString(rawRoute?.fingerprint);
			try {
				const verified = verifyQualityRouteSnapshot(persistedRoute);
				qualityStatus = "verified";
				qualityTier = verified.qualityTier;
				snapshotFingerprint = verified.fingerprint;
				configuredStages = MODEL_STAGE_ROLES.map(entry => ({
					...entry,
					orderedProfileIds: [...verified.routes[entry.role]],
				}));
			} catch {
				qualityStatus = "invalid";
			}
		}

		const executionsByAttempt = new Map<string, WorkflowModelExecutionEvidenceV1[]>();
		const routingByAttempt = new Map<string, WorkflowRoutingDecisionEvidenceV1[]>();
		const seenRoutingEntries = new Set<string>();
		for (const meta of snapshot.artifacts) {
			if (meta.kind !== "runtime-evidence" && meta.kind !== "routing-audit") continue;
			const loaded = await this.#artifactStore.load(meta.relativePath, meta.sha256);
			if (!loaded?.content) continue;
			let parsed: Record<string, unknown> | null;
			try {
				parsed = evidenceRecord(JSON.parse(loaded.content));
			} catch {
				parsed = null;
			}
			if (!parsed) continue;
			if (meta.kind === "runtime-evidence") {
				const execution = modelExecutionEvidence(parsed);
				if (!execution) continue;
				const prior = executionsByAttempt.get(meta.attemptId) ?? [];
				prior.push(execution);
				executionsByAttempt.set(meta.attemptId, prior);
				continue;
			}
			if (!Array.isArray(parsed.entries)) continue;
			for (const rawEntry of parsed.entries) {
				const routing = routingDecisionEvidence(rawEntry);
				if (!routing) continue;
				const rawRecord = evidenceRecord(rawEntry);
				const routingKey = evidenceString(rawRecord?.at) ?? JSON.stringify(routing);
				if (seenRoutingEntries.has(routingKey)) continue;
				seenRoutingEntries.add(routingKey);
				const prior = routingByAttempt.get(meta.attemptId) ?? [];
				prior.push(routing);
				routingByAttempt.set(meta.attemptId, prior);
			}
		}

		const configuredProfilesByStage = new Map(
			configuredStages.map(entry => [entry.stage, entry.orderedProfileIds] as const),
		);
		const modelAttempts: WorkflowModelAttemptEvidenceV1[] = [];
		for (const attempt of snapshot.attempts) {
			const stageRole = modelStageRole(attempt.stage);
			if (!stageRole) continue;
			const executions = executionsByAttempt.get(attempt.id) ?? [];
			const configuredProfiles = configuredProfilesByStage.get(stageRole.stage) ?? null;
			const routing = (routingByAttempt.get(attempt.id) ?? []).map(decision => ({
				...decision,
				configuredProfileIds: decision.configuredProfileIds ?? configuredProfiles,
			}));
			const evidenceStatus: WorkflowEvidenceStatus =
				executions.length > 0 || routing.length > 0
					? "verified"
					: qualityStatus === "legacy"
						? "legacy"
						: qualityStatus === "invalid"
							? "invalid"
							: "unknown";
			modelAttempts.push({
				attemptId: attempt.id,
				stage: stageRole.stage,
				role: stageRole.role,
				ordinal: attempt.ordinal,
				status: attempt.status,
				configuredProfileId: attempt.modelProfileId ?? null,
				evidenceStatus,
				routing,
				executions,
			});
		}

		return {
			schemaVersion: 1,
			workflowId,
			status: snapshot.state.status,
			currentStage: snapshot.state.currentStage,
			version: snapshot.state.version,
			attemptCount: snapshot.attempts.length,
			artifactCount: snapshot.artifacts.length,
			transitionCount: snapshot.transitions.length,
			budgetTotals: snapshot.budgetTotals,
			qualityRoute: {
				status: qualityStatus,
				qualityTier,
				snapshotFingerprint,
				configuredStages,
			},
			modelAttempts,
		};
	}

	/** Cancel: abort in-flight work, finish open attempts, and persist cancelled. */
	async cancel(workflowId: string, reason = "caller cancelled"): Promise<WorkflowState> {
		const settlement = workflowAbortSettlement(workflowId);
		const runnerSignalled = abortRegisteredWorkflow(workflowId, reason);
		this.#controller?.abort(reason);
		if (runnerSignalled && settlement) {
			await settlement;
			const settled = await this.#requireState(workflowId);
			if (settled.status === "cancelled") return settled;
			if (TERMINAL.has(settled.status)) {
				throw new WorkflowPolicyError("cannot_cancel_terminal", { status: settled.status });
			}
			return this.#persistCancellation(workflowId, reason);
		}
		// Foreign / unregistered runner: request cancel without clearing ownership or forcing
		// a terminal transition that would race a live merger in another process.
		const state = await this.#requireState(workflowId);
		if (TERMINAL.has(state.status)) {
			if (state.status === "cancelled") return state;
			throw new WorkflowPolicyError("cannot_cancel_terminal", { status: state.status });
		}
		if (state.runnerOwner && state.runnerOwner !== this.#runnerOwnerId) {
			// Do not terminalize or clear ownership while a foreign process holds the lock.
			throw new WorkflowPolicyError("cancel_pending_foreign_runner", {
				workflowId,
				runnerOwner: state.runnerOwner,
				reason,
			});
		}
		return this.#persistCancellation(workflowId, reason);
	}

	async #persistCancellation(workflowId: string, reason: string): Promise<WorkflowState> {
		const state = await this.#requireState(workflowId);
		if (TERMINAL.has(state.status)) {
			if (state.status === "cancelled") return state;
			throw new WorkflowPolicyError("cannot_cancel_terminal", { status: state.status });
		}
		if (state.currentAttemptId) {
			await this.#finishOpenAttempt(workflowId, state.currentAttemptId, "cancelled", {
				kind: "cancelled",
				summary: reason,
			});
		}
		const afterAttempt = await this.#requireState(workflowId);
		await this.#store.transitionWorkflow(
			workflowId,
			afterAttempt.status,
			"cancelled",
			reason,
			afterAttempt.currentAttemptId,
			afterAttempt.version,
			this.#ledgerBudgetSnapshot(),
		);
		await this.#store.clearRunnerOwner(workflowId);
		return await this.#requireState(workflowId);
	}

	/**
	 * Clear exclusive runner ownership without changing workflow status.
	 * Use after a hard crash left a stale `runner_owner` (cancel is terminal and cannot be resumed).
	 */
	async forceUnlock(workflowId: string): Promise<void> {
		await this.#requireState(workflowId);
		await this.#store.clearRunnerOwner(workflowId);
	}

	async recoverDeliveryGrill(workflowId: string, answers: readonly string[]): Promise<WorkflowState> {
		const state = await this.#requireState(workflowId);
		const sidecar = state.overlaySidecar;
		if (state.pipelineKind !== "devflow" || !sidecar) {
			throw new WorkflowPolicyError("overlay_requires_devflow", { workflowId });
		}
		if (sidecar.phase !== "grilling") {
			throw new WorkflowPolicyError("grill_recovery_requires_pause", { workflowId, phase: sidecar.phase });
		}
		const answered = appendGrillAnswers(sidecar, answers);
		if (sidecar.grill.reason === "needs_redesign") {
			await this.#store.updateOverlaySidecar(workflowId, answered, state.version);
			return this.replanFromRedesign(workflowId);
		}
		await this.#store.updateOverlaySidecar(workflowId, sidecarIdle(answered), state.version);
		return this.#requireState(workflowId);
	}

	/**
	 * Exempt plan redesign: plan_review → planning without incrementing planRejectionCount.
	 * Requires runner_owner IS NULL. Success CAS sets runner_owner=NULL and must not call releaseRunner.
	 */
	async replanFromRedesign(workflowId: string): Promise<WorkflowState> {
		const snapshot = await this.#store.resumeFromPersistedState(workflowId);
		if (!snapshot) throw new WorkflowPolicyError("workflow_not_found", { workflowId });
		const sidecar = snapshot.state.overlaySidecar;
		const last = snapshot.transitions.at(-1);
		if (
			snapshot.state.status === "planning" &&
			last?.reason === "plan_review:needs_redesign" &&
			sidecar?.phase === "idle"
		) {
			return snapshot.state;
		}
		if (snapshot.state.pipelineKind !== "devflow") {
			throw new WorkflowPolicyError("overlay_requires_devflow", { workflowId });
		}
		if (TERMINAL.has(snapshot.state.status) || snapshot.state.status !== "plan_review") {
			throw new WorkflowPolicyError("replan_requires_plan_review", { status: snapshot.state.status });
		}
		if (sidecar?.phase !== "grilling" || sidecar.grill.reason !== "needs_redesign") {
			throw new WorkflowPolicyError("replan_requires_needs_redesign", { phase: sidecar?.phase });
		}
		if (snapshot.state.runnerOwner) {
			throw new WorkflowPolicyError("runner_lock_held", {
				workflowId,
				heldBy: snapshot.state.runnerOwner,
			});
		}
		await this.#store.completeExemptReplan({
			workflowId,
			expectedVersion: snapshot.state.version,
			overlaySidecar: sidecarIdle(sidecar),
			attemptId: snapshot.state.currentAttemptId,
		});
		return this.#requireState(workflowId);
	}

	/**
	 * Resume / continue execution from the persisted stage until terminal or one step if `singleStep`.
	 * Reconstructs budget/findings from snapshot when available.
	 *
	 * Crash recovery for stale locks: pass `forceUnlock: true` (does not terminal-cancel).
	 * Concurrent live runners must not use forceUnlock.
	 */
	async resume(
		workflowId: string,
		options: {
			singleStep?: boolean;
			session?: ToolSession;
			forceUnlock?: boolean;
			signal?: AbortSignal;
		} = {},
	): Promise<WorkflowRunResult> {
		const snapshot = await this.#store.resumeFromPersistedState(workflowId);
		if (!snapshot) throw new WorkflowPolicyError("workflow_not_found", { workflowId });
		if (TERMINAL.has(snapshot.state.status)) {
			throw new WorkflowPolicyError("cannot_resume_terminal", { status: snapshot.state.status });
		}
		if (options.forceUnlock) {
			await this.#store.clearRunnerOwner(workflowId);
		}
		// Re-read after forceUnlock (clear bumps version) so claim uses the current optimistic version.
		const claimSnapshot = (await this.#store.resumeFromPersistedState(workflowId)) ?? snapshot;
		if (TERMINAL.has(claimSnapshot.state.status)) {
			throw new WorkflowPolicyError("cannot_resume_terminal", { status: claimSnapshot.state.status });
		}
		// Claim exclusive ownership BEFORE authoritative hydration so we cannot race another
		// runner that advanced the stage after our first snapshot read.
		await this.#store.claimRunner(workflowId, this.#runnerOwnerId, claimSnapshot.state.version);
		try {
			const fresh = await this.#store.resumeFromPersistedState(workflowId);
			if (!fresh) throw new WorkflowPolicyError("workflow_not_found", { workflowId });
			if (TERMINAL.has(fresh.state.status)) {
				throw new WorkflowPolicyError("cannot_resume_terminal", { status: fresh.state.status });
			}
			this.#activateQualityRouteFromPolicy(fresh.state.policyJson, this.#qualityRouteExpected(fresh));
			if (fresh.budgetTotals) {
				this.#budgetLedger.restore(fresh.budgetTotals as Partial<BudgetSnapshot>);
			}
			// Rebuild plan-cycle count from durable transitions (survives new Engine instances).
			this.#planCycles = fresh.transitions.filter(
				t => t.fromStatus === "plan_review" && t.toStatus === "planning",
			).length;
			// Reset mutable stage caches then hydrate from the post-claim snapshot.
			this.#plan = undefined;
			this.#planReview = undefined;
			this.#planReviewControl = undefined;
			this.#planArtifactSha256 = undefined;
			this.#planReviewerIdentity = undefined;
			this.#planReviewerRouteSelectionRef = undefined;
			this.#authorResponses = undefined;
			this.#authorResponsesPriorFindings = undefined;
			this.#authorResponsesArtifactRef = undefined;
			this.#implementation = undefined;
			this.#verification = undefined;
			this.#finalVerification = undefined;
			this.#codeReview = undefined;
			this.#findingTracker = new FindingTracker();
			await this.#hydrateArtifacts(fresh);
			const hydratedPlanReviewControl = this.#planReviewControl as PlanReviewControlStateV1 | undefined;
			if (hydratedPlanReviewControl) this.#planCycles = hydratedPlanReviewControl.planRejectionCount;
			if (options.signal) {
				this.#signal = options.signal;
			}
			// runLoop must not re-claim; pass alreadyClaimed via singleStep loop path.
			return await this.#runLoop(workflowId, options.session ?? this.#session, options.singleStep === true, {
				alreadyClaimed: true,
			});
		} catch (error) {
			await this.#store.releaseRunner(workflowId, this.#runnerOwnerId);
			throw error;
		}
	}

	/** Run from created through completion (or block/fail/cancel). */
	async run(workflowId: string, session?: ToolSession): Promise<WorkflowRunResult> {
		return this.#runLoop(workflowId, session ?? this.#session, false);
	}

	async #runLoop(
		workflowId: string,
		session: ToolSession | undefined,
		singleStep: boolean,
		options: { alreadyClaimed?: boolean } = {},
	): Promise<WorkflowRunResult> {
		this.#activateQualityRouteFromPolicy((await this.#requireState(workflowId)).policyJson);
		this.#syncSessionFallbackProfile(session);
		this.#controller = new AbortController();
		registerWorkflowAbort(workflowId, this.#controller, this.#controller);
		const parentSignal = this.#signal;
		if (parentSignal) {
			if (parentSignal.aborted) this.#controller.abort();
			else parentSignal.addEventListener("abort", () => this.#controller?.abort(), { once: true });
		}

		let steps = 0;
		const maxSteps = singleStep ? 1 : 32;
		/** Preflight once per resume/run invocation, under the runner lock. */
		let preflightDone = false;
		let availability: WorkflowAvailabilityReport | undefined;

		try {
			while (steps < maxSteps) {
				steps += 1;
				if (this.#controller.signal.aborted) {
					await this.#persistCancellation(workflowId, "aborted");
					break;
				}

				let state = await this.#requireState(workflowId);
				if (TERMINAL.has(state.status)) break;

				// Exclusive runner lock — second concurrent runner fails until release.
				// When resume() already claimed, skip re-claim on the first loop iteration.
				let claimed = false;
				try {
					if (options.alreadyClaimed && steps === 1) {
						claimed = true;
					} else {
						await this.#store.claimRunner(workflowId, this.#runnerOwnerId, state.version);
						claimed = true;
					}
				} catch (error) {
					if (error instanceof WorkflowPolicyError) throw error;
					throw error;
				}

				try {
					state = await this.#requireState(workflowId);

					// Availability preflight before any stage attempt or model work.
					if (!preflightDone) {
						preflightDone = true;
						availability = await this.#runPreflight({
							workflowId,
							operation: "resume",
							status: state.status,
							singleStep,
							session,
							signal: this.#controller.signal,
							failClosed: this.#qualityRouteSnapshot !== undefined,
						});
						this.#lastAvailability = availability;
					}

					// Advance created → planning without budget/provider (no external call)
					if (state.status === "created") {
						const next = getNextStage("created", null);
						if (!next || !isValidTransition(state.status, next)) {
							throw new WorkflowPolicyError("invalid_transition", { from: state.status, to: next });
						}
						await this.#store.transitionWorkflow(
							workflowId,
							"created",
							next,
							"start planning",
							undefined,
							state.version,
							this.#ledgerBudgetSnapshot(),
						);
						if (singleStep) break;
						continue;
					}

					// Hard-stop before stages that call providers/verifier
					if (!(await this.#budgetLedger.checkPreStage())) {
						const snap = this.#budgetLedger.snapshot();
						await this.#store.transitionWorkflow(
							workflowId,
							state.status,
							"blocked",
							"budget_exhausted",
							state.currentAttemptId,
							state.version,
							this.#ledgerBudgetSnapshot(),
						);
						throw new BudgetExhaustedError(snap.requests, snap.costUsd ?? "unknown", snap.limitUsd);
					}

					if (!session) {
						throw new WorkflowPolicyError("session_required_for_stage", { stage: state.status });
					}

					const started = Date.now();
					try {
						await this.#executeCurrentStage(workflowId, state, session);
					} catch (error) {
						await this.#persistAbortCompletionKind(workflowId, error);
						if (error instanceof WorkflowCancelledError || this.#controller.signal.aborted) {
							await this.#persistCancellation(workflowId, "cancelled during stage");
							break;
						}
						if (error instanceof BudgetExhaustedError) throw error;
						const kind = error instanceof WorkflowError ? error.kind : "internal";
						const outcome = mapWorkflowErrorOutcome(kind);
						const redactedSummary = redactSecretsInText(
							error instanceof Error ? error.message : "stage failed",
						).slice(0, 500);
						if (
							outcome === "blocked" ||
							(error instanceof WorkflowPolicyError && error.message.includes("independent_reviewer"))
						) {
							const s = await this.#requireState(workflowId);
							if (s.currentAttemptId && !TERMINAL.has(s.status)) {
								await this.#finishOpenAttempt(workflowId, s.currentAttemptId, "failed", {
									kind,
									summary: redactedSummary,
								});
							}
							const s2 = await this.#requireState(workflowId);
							if (!TERMINAL.has(s2.status)) {
								await this.#store.transitionWorkflow(
									workflowId,
									s2.status,
									"blocked",
									redactedSummary,
									s2.currentAttemptId,
									s2.version,
									this.#ledgerBudgetSnapshot(),
								);
							}
							// Stage handlers that already transitioned (e.g. write_stage_interrupted) must still surface.
							if (error instanceof WorkflowPolicyError && !error.message.includes("independent_reviewer")) {
								throw error;
							}
							break;
						}
						const s = await this.#requireState(workflowId);
						if (!TERMINAL.has(s.status)) {
							if (s.currentAttemptId) {
								await this.#finishOpenAttempt(workflowId, s.currentAttemptId, "failed", {
									kind,
									summary: redactedSummary,
								});
							}
							const s2 = await this.#requireState(workflowId);
							if (!TERMINAL.has(s2.status)) {
								await this.#store.transitionWorkflow(
									workflowId,
									s2.status,
									"failed",
									redactedSummary,
									s2.currentAttemptId,
									s2.version,
									this.#ledgerBudgetSnapshot(),
								);
							}
						}
						throw error;
					} finally {
						this.#budgetLedger.recordStageTime(Date.now() - started);
						await this.#store.saveBudgetTotals(
							workflowId,
							this.#budgetLedger.snapshot() as unknown as Record<string, unknown>,
						);
					}

					const afterStage = await this.#requireState(workflowId);
					if (afterStage.status === "plan_review" && this.#planReviewControl?.substate === "awaiting_human") {
						break;
					}
					if (isAwaitingGrill(afterStage.overlaySidecar)) {
						break;
					}
					if (singleStep) break;
				} finally {
					if (claimed) {
						await this.#store.releaseRunner(workflowId, this.#runnerOwnerId);
					}
				}
			}

			const finalState = await this.#requireState(workflowId);
			if (session && TERMINAL.has(finalState.status)) {
				// Production quality-stop wiring (review 2026-08-07 HIGH-1): evaluate the stop from
				// the frozen arm snapshot + run evidence and persist a rollout decision. Never breaks
				// workflow completion; rollback (settings override) is the configured rollback owner.
				await this.#evaluateLatencyRolloutAtTerminal(workflowId, finalState, session).catch(() => {
					// Rollout bookkeeping must not fail a workflow that already reached terminal.
				});
			}
			const awaitingGrill = isAwaitingGrill(finalState.overlaySidecar);
			return {
				state: finalState,
				plan: this.#plan,
				planReview: this.#planReview,
				implementation: this.#implementation,
				verification: this.#verification,
				codeReview: this.#codeReview,
				finalVerification: this.#finalVerification,
				workPackageState: this.#workPackageState,
				routingAudit: [...this.#routingAudit],
				availability: availability ?? this.#lastAvailability,
				stepsExecuted: steps,
				maxStepsReached: steps >= maxSteps && !TERMINAL.has(finalState.status) && !awaitingGrill,
				awaitingGrill,
				overlayReason: overlayReason(finalState.overlaySidecar),
			};
		} finally {
			unregisterWorkflowAbort(workflowId, this.#controller);
		}
	}

	#qualityRouteExpected(snapshot: PersistedWorkflowSnapshot): boolean {
		let requestTierPresent = false;
		try {
			const request = JSON.parse(snapshot.state.requestJson) as Record<string, unknown>;
			requestTierPresent = request.qualityTier === "balanced" || request.qualityTier === "critical";
		} catch {
			requestTierPresent = false;
		}
		return requestTierPresent || snapshot.artifacts.some(artifact => artifact.kind === "quality-route-snapshot");
	}

	#activateQualityRoute(snapshot: QualityRouteSnapshotV1): void {
		const verified = verifyQualityRouteSnapshot(snapshot);
		this.#qualityRouteSnapshot = verified;
		this.#router = new ModelRouter(qualityRouteProfiles(verified));
	}

	#activateQualityRouteFromPolicy(policyJson: string, qualityRouteExpected = false): void {
		const policy = this.#parsePolicy(policyJson);
		const rawSnapshot = policy.qualityRouteSnapshot;
		if (rawSnapshot === undefined) {
			if (qualityRouteExpected || policy.qualityRouteRequired === true) {
				throw new WorkflowPolicyError("quality_route_snapshot_missing");
			}
			this.#qualityRouteSnapshot = undefined;
			this.#router = this.#configuredRouter;
			return;
		}
		if (policy.degradedMode !== false) {
			throw new WorkflowPolicyError("quality_route_degraded_mode_forbidden", {
				degradedMode: policy.degradedMode,
			});
		}
		this.#activateQualityRoute(verifyQualityRouteSnapshot(rawSnapshot));
	}

	async #persistQualityRouteSnapshot(workflowId: string, attemptId: string): Promise<void> {
		if (!this.#qualityRouteSnapshot || this.#qualityRouteArtifactPersisted) return;
		await this.#persistArtifact(workflowId, attemptId, "quality-route-snapshot", this.#qualityRouteSnapshot);
		this.#qualityRouteArtifactPersisted = true;
	}

	/**
	 * Production quality-stop wiring (review 2026-08-07 HIGH-1): at workflow terminal completion,
	 * evaluate the stop from the session-frozen arm snapshot + this run's evidence and persist a
	 * durable rollout decision. When a stop fires, disable the causal arm(s) via the session
	 * settings override — the configured rollback owner — so subsequent runs start with them off.
	 * Fail-open on bookkeeping errors: never blocks workflow completion.
	 */
	async #evaluateLatencyRolloutAtTerminal(
		workflowId: string,
		state: WorkflowState,
		session: ToolSession,
	): Promise<void> {
		if (this.#latencyRolloutPersisted.has(workflowId)) return;
		const snapshot =
			session.getLatencyArmSnapshot?.() ??
			freezeLatencyArmSnapshot({
				getSetting: settingPath => {
					try {
						return session.settings.get(settingPath as never);
					} catch {
						return false;
					}
				},
			});
		const budget = this.#budgetLedger.snapshot();
		const openP0P1 = this.#findingTracker
			.getOpen()
			.filter(finding => finding.priority === "P0" || finding.priority === "P1").length;
		const active = LATENCY_ARM_IDS.filter(id => snapshot.arms[id] === true);
		const firedArms = (session.getFiredLatencyArms?.() ?? []).filter(arm => active.includes(arm));
		// Record this run into the cohort before evaluating, so the guardrail
		// reads a cohort that includes it. Best-effort: never fails the terminal.
		const observation: LatencyRolloutObservationV1 = {
			schemaVersion: 1,
			kind: "latency_rollout_observation",
			key: deriveLatencyCohortKey(snapshot),
			workflowId,
			status: state.status,
			completed: state.status === "completed",
			repairCycles: budget.repairCycles,
			p0p1Escapes: openP0P1,
			costUsd: budget.costUsd,
			stageTimeMs: budget.stageTimeMs,
			spawnedAgents: null,
			firedArms,
			endedAt: new Date().toISOString(),
		};
		try {
			this.#latencyCohortStore.append(observation);
		} catch {
			// Cohort bookkeeping is advisory.
		}
		// Cohort-derived thresholds activate only when both the treatment cohort and
		// the no-arm baseline have accumulated enough samples (min-sample guard).
		const key = observation.key;
		const treatment = this.#latencyCohortStore.summaryForKey(key);
		const baseline =
			key === LATENCY_BASELINE_COHORT_KEY
				? undefined
				: this.#latencyCohortStore.summaryForKey(LATENCY_BASELINE_COHORT_KEY);
		const cohort = treatment && baseline ? computeLatencyCohortMetrics(treatment, baseline) : undefined;
		const decision = buildLatencyRolloutDecision({
			workflowId,
			status: state.status,
			snapshot,
			firedArms,
			cohort,
			observed: {
				completion: state.status === "completed",
				repairCycles: budget.repairCycles,
				treatmentAttributedP0P1Escapes: openP0P1,
				costUsd: budget.costUsd,
				stageTimeMs: budget.stageTimeMs,
				spawnedAgents: null,
			},
		});
		await this.#persistArtifact(
			workflowId,
			state.currentAttemptId ?? "terminal",
			LATENCY_ROLLOUT_DECISION_KIND,
			decision,
		);
		this.#latencyRolloutPersisted.add(workflowId);
		if (decision.decision.stop && typeof session.settings.override === "function") {
			for (const arm of decision.disabledArms) {
				session.settings.override(LATENCY_ARM_SETTINGS[arm] as never, false);
			}
			// The frozen snapshot must reflect the rollback: later lookups re-read
			// live settings instead of the pre-rollback arm map.
			session.invalidateLatencyArmSnapshot?.();
		}
	}

	/**
	 * Run availability preflight (or skipped report when port/session absent).
	 * When failClosed and required roles have no available route: throw without creating attempts.
	 */
	async #runPreflight(options: {
		workflowId: string;
		operation: "start" | "resume";
		status: WorkflowStatus;
		singleStep: boolean;
		session: ToolSession | undefined;
		signal?: AbortSignal;
		failClosed: boolean;
		persistBudget?: boolean;
	}): Promise<WorkflowAvailabilityReport> {
		if (!this.#availability || !options.session) {
			if (options.failClosed) {
				throw new WorkflowPolicyError("quality_route_preflight_required", {
					reason: !this.#availability ? "availability_port_not_configured" : "session_required",
				});
			}
			return skippedAvailabilityReport({
				workflowId: options.workflowId,
				operation: options.operation,
				singleStep: options.singleStep,
				reason: !this.#availability ? "availability_port_not_configured" : "session_required",
			});
		}

		const report = await runAvailabilityPreflight({
			port: this.#availability,
			router: this.#router,
			workflowId: options.workflowId,
			operation: options.operation,
			status: options.status,
			singleStep: options.singleStep,
			session: options.session,
			signal: options.signal,
			providerHealthBreaker: isLatencyArmEnabled(options.session, "provider_health_breaker")
				? this.#providerHealthBreaker
				: undefined,
		});
		this.#preflightUnavailableReasons = {};
		for (const row of report.profiles) {
			if (row.status !== "available" && !isDiagnosticAvailabilityTimeout(row)) {
				this.#preflightUnavailableReasons[row.profileId] = [row.errorKind, row.errorSummary]
					.filter((part): part is string => Boolean(part))
					.join(":");
			}
			if (row.source === "live") this.#budgetLedger.recordRequest(row.usage, row.profileId);
		}
		if (options.persistBudget !== false) {
			await this.#store.saveBudgetTotals(
				options.workflowId,
				this.#budgetLedger.snapshot() as unknown as Record<string, unknown>,
			);
		}
		if (options.failClosed) assertRequiredRolesAvailable(report);
		return report;
	}

	async #executeCurrentStage(workflowId: string, state: WorkflowState, session: ToolSession): Promise<void> {
		this.#activeWorkflowId = workflowId;
		const signal = this.#controller?.signal;
		const policy = this.#parsePolicy(state.policyJson);
		const request = this.#parseRequest(state.requestJson);
		const stage = state.status;
		const roleStaticSplitEnabled = isLatencyArmEnabled(session, "role_static_split");

		// Fail-closed resume: never silently re-run a write stage without detection.
		// If an open in_progress attempt exists for this stage, mark it failed then start fresh.
		const attemptId = await this.#beginAttemptFailClosed(workflowId, stage, state);
		await this.#persistQualityRouteSnapshot(workflowId, attemptId);
		const fresh = await this.#requireState(workflowId);
		const cwd = session.cwd;

		switch (stage) {
			case "planning": {
				await this.#ensureRequirementsSnapshot(workflowId, attemptId, request);

				const {
					artifact: plan,
					usage,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
					resolvedProvider,
					resolvedModel,
					toolCalls,
					identityReceipt,
					modelFamily,
					resolvedToolPolicyId,
					completionKind,
				} = await this.#withProfileFallback("planner", {}, async profile => {
					this.#plannerProfileId = profile.id;
					this.#plannerVendor = profile.vendor;
					const context = await this.#buildStageContext(
						this.#contextBuilder.buildPlanContext({
							request,
							priorReview: this.#planReview,
							constraints: request.constraints,
							grillAnswers: state.overlaySidecar?.grill.answers,
						}),
						profile,
						session,
					);
					return new PlanStage(this.#adapter).execute({
						workflowId,
						attemptId,
						profile,
						assignment: request.request,
						context,
						session,
						signal,
					});
				});
				this.#plannerModelFamily = modelFamily;
				this.#plan = plan;
				this.#planArtifactRef = await this.#persistArtifact(workflowId, attemptId, "plan", plan);
				const wasReplan = this.#planReviewControl?.substate === "awaiting_replan";
				if (wasReplan && this.#planReview) {
					const validation = validateAuthorResponses(plan.authorResponses, this.#planReview.findings);
					if (!validation.ok) {
						throw new WorkflowPolicyError(validation.reason ?? "author_responses_invalid", {
							workflowId,
							attemptId,
							priorReviewArtifactRef: this.#planReviewArtifactRef?.artifactId ?? null,
						});
					}
					this.#authorResponses = validation.responses;
					this.#authorResponsesPriorFindings = this.#planReview.findings.map(finding => ({
						id: finding.id,
						priority: finding.priority,
					}));
					const authorResponsesArtifact = buildAuthorResponsesArtifact({
						workflowId,
						attemptId,
						priorReviewArtifactRef: this.#planReviewArtifactRef?.artifactId ?? null,
						priorFindings: this.#planReview.findings,
						responses: validation.responses,
					});
					this.#authorResponsesArtifactRef = await this.#persistArtifact(
						workflowId,
						attemptId,
						AUTHOR_RESPONSES_KIND,
						authorResponsesArtifact,
					);
				} else if (!wasReplan) {
					this.#authorResponses = undefined;
					this.#authorResponsesPriorFindings = undefined;
					this.#authorResponsesArtifactRef = undefined;
				}
				this.#planReviewControl = {
					schemaVersion: 1,
					kind: "plan_review_control_state",
					substate: wasReplan ? "rereview" : "initial_review",
					reviewRound: wasReplan ? 2 : (this.#planReviewControl?.reviewRound ?? 1),
					planRejectionCount: this.#planReviewControl?.planRejectionCount ?? 0,
					arbitrationCycles: this.#planReviewControl?.arbitrationCycles ?? 0,
					arbitrationTrigger: null,
					arbitrationAttemptId: this.#planReviewControl?.arbitrationAttemptId ?? null,
					arbitrationAttemptPhase: this.#planReviewControl?.arbitrationAttemptPhase ?? null,
					reviewSchemaCohort: this.#planReviewControl?.reviewSchemaCohort ?? "v2",
					latestPlanArtifactRef: this.#planArtifactRef.artifactId,
					latestReviewArtifactRef: this.#planReviewArtifactRef?.artifactId ?? null,
					authorResponsesArtifactRef: this.#authorResponsesArtifactRef?.artifactId ?? null,
					routeSelectionReceiptRef: this.#planReviewControl?.routeSelectionReceiptRef ?? null,
					humanRequestReason: null,
					updatedAt: new Date().toISOString(),
				};
				await this.#persistPlanReviewControl(workflowId, attemptId);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage, {
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
					resolvedProvider,
					resolvedModel,
					toolCalls,
					identityReceipt,
					modelFamily,
					resolvedToolPolicyId,
					completionKind,
				});
				if (state.pipelineKind === "devflow") {
					const paused = await this.#applyPlanningCompletenessGate(workflowId, attemptId, state, request);
					if (paused) return;
				}
				const next = getNextStage("planning", "approved");
				await this.#completeTo(workflowId, attemptId, fresh.status, next!, "plan ready", fresh.version);
				return;
			}
			case "plan_review": {
				if (!this.#plan) throw new WorkflowPolicyError("missing_plan_artifact", { workflowId });
				if (state.pipelineKind === "devflow") {
					await this.#executeDevflowPlanReview(workflowId, attemptId, state, session, signal, request);
					return;
				}
				await this.#ensureRequirementsSnapshot(workflowId, attemptId, request);

				if (!this.#planReviewControl) {
					const rejectionCount = this.#planCycles;
					this.#planReviewControl = {
						schemaVersion: 1,
						kind: "plan_review_control_state",
						substate: rejectionCount > 0 ? "rereview" : "initial_review",
						reviewRound: rejectionCount > 0 ? 2 : 1,
						planRejectionCount: rejectionCount,
						arbitrationCycles: 0,
						arbitrationTrigger: null,
						arbitrationAttemptId: null,
						arbitrationAttemptPhase: null,
						// New workflows start on V2; legacy resumes hydrate cohort before this path.
						reviewSchemaCohort: "v2",
						latestPlanArtifactRef: this.#planArtifactRef?.artifactId ?? null,
						latestReviewArtifactRef: this.#planReviewArtifactRef?.artifactId ?? null,
						authorResponsesArtifactRef: null,
						routeSelectionReceiptRef: null,
						humanRequestReason: null,
						updatedAt: new Date().toISOString(),
					};
					// Persist cohort before the first external review call (HIGH-10).
					await this.#persistPlanReviewControl(workflowId, attemptId);
				}
				const control = this.#planReviewControl;
				if (control.substate === "awaiting_human") {
					await this.#setPlanReviewAwaitingHuman(
						workflowId,
						attemptId,
						control.humanRequestReason ?? "plan review is awaiting human authority",
					);
					return;
				}
				if (control.substate === "arbitration") {
					const trustedArbitration = this.#trustedArbitrationReview(control);
					if (trustedArbitration) {
						// Artifact already persisted; finish the transition without another model call.
						this.#planReview = trustedArbitration;
						if (control.arbitrationAttemptPhase !== "completed" || control.arbitrationCycles !== 1) {
							this.#planReviewControl = {
								...control,
								arbitrationCycles: 1,
								arbitrationAttemptPhase: "completed",
								latestReviewArtifactRef:
									this.#planReviewArtifactRef?.artifactId ?? control.latestReviewArtifactRef,
								updatedAt: new Date().toISOString(),
							};
							await this.#persistPlanReviewControl(workflowId, attemptId);
						}
						await this.#completeTo(
							workflowId,
							attemptId,
							fresh.status,
							trustedArbitration.decision === "approved" ? "implementing" : "blocked",
							`plan_review:arbitration_${trustedArbitration.decision}`,
							fresh.version,
						);
						return;
					}
					// Reserved/uncertain launch without a trusted arbitration artifact: never re-pay.
					await this.#setPlanReviewAwaitingHuman(
						workflowId,
						attemptId,
						control.arbitrationCycles >= 1 || control.arbitrationAttemptPhase === "reserved"
							? "arbitration attempt has no trusted artifact"
							: "arbitration resume missing reservation",
					);
					return;
				}
				// Cohort is durable on control; never re-infer mid-flight from the latest artifact alone.
				this.#budgetLedger.recordReviewerCycle();
				const reviewKind = control.reviewRound === 2 ? "rereview" : "initial";
				const requirementsSnapshot = await this.#requireRequirementsSnapshot(workflowId, attemptId, request);
				// Rereview requires a previously attested pin — never re-resolve from config alone.
				if (reviewKind === "rereview" && !this.#planReviewerIdentity) {
					await this.#setPlanReviewAwaitingHuman(workflowId, attemptId, "plan_reviewer_identity_unavailable");
					return;
				}
				const pinnedReviewer = this.#planReviewerIdentity?.profileId;
				const executeReview = async (profile: ModelProfile, assignment: string) =>
					new PlanReviewStage(this.#adapter).execute({
						workflowId,
						attemptId,
						profile,
						assignment,
						context: await this.#buildStageContext(
							this.#contextBuilder.buildPlanReviewContext(
								this.#plan!,
								resolveArtifactInclusion(profile),
								this.#requirementsSnapshot,
							),
							profile,
							session,
							this.#plan?.affectedFiles.map(file => file.path),
						),
						session,
						signal,
						requirementsSnapshotRef:
							this.#requirementsSnapshotRef?.recoveryUri ?? `artifact://${workflowId}/requirements-snapshot`,
						requirementsSnapshotSha256: requirementsSnapshot.sha256,
						reviewKind,
						reviewRound: control.reviewRound,
						authorResponses: this.#authorResponses ? [...this.#authorResponses] : [],
						routeSelectionReceiptRef:
							this.#planReviewerRouteSelectionRef?.artifactId ?? control.routeSelectionReceiptRef,
						legacyV1: control.reviewSchemaCohort === "v1",
					});
				const reviewResult = pinnedReviewer
					? await this.#withPinnedProfile(
							"plan_reviewer",
							pinnedReviewer,
							async profile => {
								const result = await executeReview(
									profile,
									reviewKind === "rereview"
										? "Re-review the revised plan for correctness and feasibility"
										: "Review the plan for correctness and feasibility",
								);
								this.#assertPlanReviewerIdentity(profile, result);
								return result;
							},
							"plan_reviewer:rereview",
						)
					: await this.#withProfileFallback(
							"plan_reviewer",
							{
								excludedProfileIds: this.#plannerProfileId ? [this.#plannerProfileId] : [],
								avoidVendor: this.#plannerVendor,
								avoidModelFamily: this.#plannerModelFamily,
							},
							async profile => {
								const result = await executeReview(profile, "Review the plan for correctness and feasibility");
								const pinned = resolvePlanReviewerIdentity(profile, result);
								if (!pinned) {
									throw new WorkflowPolicyError("plan_reviewer_identity_unavailable", {
										profileId: profile.id,
										reason: "missing_attested_runtime_identity",
									});
								}
								this.#planReviewerIdentity = pinned;
								const routeSelection: PlanReviewRouteSelectionV1 = {
									schemaVersion: 1,
									kind: "plan_review_route_selection",
									profileId: pinned.profileId,
									provider: pinned.provider,
									model: pinned.model,
									modelFamily: pinned.modelFamily ?? null,
									attestedProvider: pinned.provider,
									attestedModel: pinned.model,
									exactMatch: pinned.exactMatch,
									snapshotFingerprint: this.#qualityRouteSnapshot?.fingerprint ?? null,
									createdAt: new Date().toISOString(),
								};
								this.#planReviewerRouteSelectionRef = await this.#persistArtifact(
									workflowId,
									attemptId,
									"plan-review-route-selection",
									routeSelection,
								);
								return result;
							},
						);
				const {
					artifact: rawReview,
					usage,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
					resolvedProvider,
					resolvedModel,
					toolCalls,
					identityReceipt,
					modelFamily,
					resolvedToolPolicyId,
					completionKind,
				} = reviewResult;
				const isV2Review = rawReview.schemaVersion === 2;
				// C1: stamp engine-owned fields before persist; never trust model triggerReason/authorResponses.
				const review = isV2Review
					? {
							...rawReview,
							authorResponses: this.#authorResponses ? [...this.#authorResponses] : [],
							triggerReason: derivePlanReviewTrigger(rawReview),
							routeSelectionReceiptRef:
								this.#planReviewerRouteSelectionRef?.artifactId ?? control.routeSelectionReceiptRef,
							cleanContextReceiptRef: null,
							specEvidenceReceiptRef: null,
						}
					: rawReview;
				this.#planReview = review;
				this.#planReviewArtifactRef = await this.#persistArtifact(workflowId, attemptId, "review", review);
				const nextRejectionCount =
					review.decision === "changes_requested" ? control.planRejectionCount + 1 : control.planRejectionCount;
				const hasMissingAuthority =
					isV2Review && review.schemaVersion === 2 && review.findings.some(f => f.basis === "missing_authority");
				const triggerReason: PlanReviewTriggerReasonV1 | null =
					isV2Review && review.schemaVersion === 2 ? review.triggerReason : null;
				this.#planReviewControl = {
					...control,
					latestPlanArtifactRef: this.#planArtifactRef?.artifactId ?? control.latestPlanArtifactRef,
					latestReviewArtifactRef: this.#planReviewArtifactRef.artifactId,
					authorResponsesArtifactRef:
						this.#authorResponsesArtifactRef?.artifactId ?? control.authorResponsesArtifactRef,
					routeSelectionReceiptRef:
						this.#planReviewerRouteSelectionRef?.artifactId ?? control.routeSelectionReceiptRef,
					planRejectionCount: nextRejectionCount,
					updatedAt: new Date().toISOString(),
				};
				await this.#recordUsageAndProfile(workflowId, attemptId, usage, {
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
					resolvedProvider,
					resolvedModel,
					toolCalls,
					identityReceipt,
					modelFamily,
					resolvedToolPolicyId,
					completionKind,
				});

				if (isV2Review && (review.decision === "blocked" || hasMissingAuthority)) {
					await this.#setPlanReviewAwaitingHuman(
						workflowId,
						attemptId,
						hasMissingAuthority ? "missing_authority" : "plan_review_blocked",
					);
					return;
				}

				const maxCyclesHit =
					review.decision === "changes_requested" && nextRejectionCount >= this.#config.maxPlanCycles;
				const authorRejectEvidence =
					maxCyclesHit &&
					hasMaxCyclesAuthorReject(this.#authorResponses ?? [], this.#authorResponsesPriorFindings ?? []);
				const triggerArbitration =
					triggerReason === "contradiction" || triggerReason === "suspicious_pass" || authorRejectEvidence;
				if (maxCyclesHit && !triggerArbitration) {
					this.#planCycles = nextRejectionCount;
					await this.#setPlanReviewAwaitingHuman(workflowId, attemptId, "max_plan_cycles_exceeded");
					return;
				}
				if (triggerArbitration) {
					const arbitrationTrigger: Exclude<PlanReviewTriggerReasonV1, null> =
						triggerReason === "contradiction" || triggerReason === "suspicious_pass"
							? triggerReason
							: "max_cycles_author_reject";
					if (this.#planReviewControl.arbitrationCycles >= 1) {
						await this.#setPlanReviewAwaitingHuman(workflowId, attemptId, "maximum arbitration cycles reached");
						return;
					}
					this.#planCycles = nextRejectionCount;
					// HIGH-5: reserve the sole arbitration cycle before the external call.
					// Resume with reserved+no trusted artifact fails closed (no re-pay).
					const arbitrationAttemptId = `arb_${randomUUID()}`;
					this.#planReviewControl = {
						...this.#planReviewControl,
						substate: "arbitration",
						arbitrationCycles: 1,
						planRejectionCount: nextRejectionCount,
						arbitrationTrigger: arbitrationTrigger,
						arbitrationAttemptId,
						arbitrationAttemptPhase: "reserved",
						updatedAt: new Date().toISOString(),
					};
					await this.#persistPlanReviewControl(workflowId, attemptId);
					const arbitration = await this.#runPlanArbitration(
						workflowId,
						attemptId,
						session,
						signal,
						policy,
						arbitrationTrigger,
					);
					if (!arbitration) {
						if (this.#planReviewControl) {
							this.#planReviewControl = {
								...this.#planReviewControl,
								arbitrationAttemptPhase: "failed_closed",
								updatedAt: new Date().toISOString(),
							};
						}
						await this.#setPlanReviewAwaitingHuman(workflowId, attemptId, "no eligible plan arbitrator route");
						return;
					}
					await this.#finishSuccessfulArbitration(workflowId, attemptId, fresh.status, fresh.version, arbitration);
					return;
				}

				if (isV2Review && review.schemaVersion === 2 && review.decision === "approved") {
					const coverageGate = validateApprovedMandatoryCoverage(review, requirementsSnapshot);
					if (!coverageGate.ok) {
						await this.#setPlanReviewAwaitingHuman(
							workflowId,
							attemptId,
							coverageGate.reason ?? "incomplete_mandatory_coverage",
						);
						return;
					}
				}

				const next = getNextStage("plan_review", review.decision);
				if (!next) throw new WorkflowPolicyError("invalid_review_decision", { decision: review.decision });
				if (review.decision === "changes_requested") {
					this.#planCycles = nextRejectionCount;
					this.#planReviewControl = {
						...this.#planReviewControl,
						substate: "awaiting_replan",
						updatedAt: new Date().toISOString(),
					};
					await this.#persistPlanReviewControl(workflowId, attemptId);
				} else {
					this.#planReviewControl = {
						...this.#planReviewControl,
						substate: reviewKind === "rereview" ? "rereview" : "initial_review",
						arbitrationTrigger: null,
						updatedAt: new Date().toISOString(),
					};
					await this.#persistPlanReviewControl(workflowId, attemptId);
				}
				await this.#completeTo(
					workflowId,
					attemptId,
					fresh.status,
					next,
					`plan_review:${review.decision}`,
					fresh.version,
				);
				return;
			}
			case "implementing": {
				if (!this.#plan) throw new WorkflowPolicyError("missing_plan_artifact", { workflowId });
				// Deterministic planner→implementer handoff (success path into implement only).
				const plannerHandoff = await this.#buildAndPersistHandoff(
					workflowId,
					attemptId,
					"planning",
					"implementing",
					() =>
						buildPlannerToImplementerHandoff({
							plan: this.#plan!,
							planReview: this.#planReview,
							planRef: this.#planArtifactRef,
							planReviewRef: this.#planReviewArtifactRef,
						}),
					[this.#planArtifactRef, this.#planReviewArtifactRef],
				);
				const execution = await this.#executeImplementation(
					workflowId,
					attemptId,
					session,
					plannerHandoff,
					signal,
					policy,
				);
				let impl = execution.artifact;
				await this.#persistScopeMetrics(workflowId, attemptId, cwd, this.#plan, impl);
				if (!execution.usageRecorded) {
					await this.#recordUsageAndProfile(workflowId, attemptId, execution.usage, {
						...execution.evidence,
						scopeMetricsKind: this.#lastScopeMetrics ? "scope-metrics" : undefined,
					});
				}
				if (!execution.writeCommitted) {
					impl = await this.#commitValidatedWrite({
						workflowId,
						attemptId,
						cwd,
						artifact: impl,
						identityReceipt: execution.evidence?.identityReceipt,
						modelFamily: execution.evidence?.modelFamily,
						signal,
					});
				}
				this.#implementation = impl;
				this.#implementationArtifactRef = await this.#persistArtifact(
					workflowId,
					attemptId,
					"implementation",
					impl,
				);
				const next = getNextStage("implementing", null);
				await this.#completeTo(workflowId, attemptId, fresh.status, next!, "implementation ready", fresh.version);
				return;
			}
			case "implementation_verify": {
				if (!this.#implementation) throw new WorkflowPolicyError("missing_implementation_artifact", { workflowId });
				// Only trusted configured commands — never trust model-proposed verificationCommands alone.
				const commands = this.#trustedVerificationCommands(this.#plan?.verificationCommands);
				const verification = await new ImplementationVerifyStage(this.#verifier).execute({
					workflowId,
					attemptId,
					implementation: this.#implementation,
					commands,
					forbiddenPaths: this.#config.forbiddenPaths,
					signal,
					timeoutMs: this.#config.verificationTimeoutMs,
					cwd,
				});
				this.#verification = verification;
				this.#verificationArtifactRef = await this.#persistArtifact(
					workflowId,
					attemptId,
					"verification",
					verification,
				);
				const decision = verification.passed ? "passed" : "failed";
				const next = getNextStage("implementation_verify", decision);
				// Budget repairCycles counts completed repair attempts, not transitions into repairing.
				await this.#completeTo(
					workflowId,
					attemptId,
					fresh.status,
					next!,
					`implementation_verify:${decision}`,
					fresh.version,
				);
				return;
			}
			case "code_review": {
				if (!this.#plan || !this.#implementation) {
					throw new WorkflowPolicyError("missing_artifacts_for_code_review", { workflowId });
				}
				if (state.pipelineKind === "devflow") {
					await this.#executeDevflowCodeReview(workflowId, attemptId, state, session, signal);
					return;
				}
				this.#budgetLedger.recordReviewerCycle();
				const patchRef = await this.#ensurePatchArtifactRef(
					workflowId,
					attemptId,
					this.#implementation.patchPath,
					cwd,
				);
				const reviewerHandoff = await this.#buildAndPersistHandoff(
					workflowId,
					attemptId,
					"implementing",
					"code_review",
					() =>
						buildImplementerToReviewerHandoff({
							implementation: this.#implementation!,
							plan: this.#plan,
							verification: this.#verification,
							implRef: this.#implementationArtifactRef,
							planRef: this.#planArtifactRef,
							verificationRef: this.#verificationArtifactRef,
							patchRef,
						}),
					[this.#implementationArtifactRef, this.#planArtifactRef, this.#verificationArtifactRef, patchRef],
				);
				const {
					artifact: review,
					usage,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
					resolvedProvider,
					resolvedModel,
					toolCalls,
					identityReceipt,
					modelFamily,
					resolvedToolPolicyId,
					completionKind,
				} = await this.#withProfileFallback(
					"code_reviewer",
					{
						implementerVendor: this.#implementerVendor ?? this.#implementation.provider,
						implementerModelFamily: this.#implementerModelFamily,
						requireIndependentReview: policy.requireIndependentReview !== false,
						degradedMode: this.#qualityRouteSnapshot
							? false
							: Boolean(policy.degradedMode) || this.#config.degradedMode,
					},
					async (profile, route) => {
						if (route.degraded) await this.#store.setDegradedMode(workflowId, true);
						return new CodeReviewStage(this.#adapter).execute({
							workflowId,
							attemptId,
							profile,
							assignment: "Independent code review of the implementation",
							context: await this.#buildStageContext(
								this.#contextBuilder.buildCodeReviewContext({
									plan: this.#plan!,
									implementation: this.#implementation!,
									verification: this.#verification,
									inclusion: resolveArtifactInclusion(profile),
								}),
								profile,
								session,
								[
									...(this.#plan?.affectedFiles.map(f => f.path) ?? []),
									...(this.#implementation?.changedFiles ?? []),
								],
								reviewerHandoff,
							),
							session,
							signal,
							confidenceThreshold: this.#config.confidenceThreshold,
						});
					},
				);
				this.#codeReview = review;
				for (const f of review.findings) {
					const blocking = FindingTracker.computeBlockingDisposition(f, review, this.#config.confidenceThreshold);
					f.blocking = blocking;
					this.#findingTracker.add(f, { blocking });
				}
				this.#codeReviewArtifactRef = await this.#persistArtifact(workflowId, attemptId, "review", review);
				await this.#persistFindingsState(workflowId, attemptId);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage, {
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
					resolvedProvider,
					resolvedModel,
					toolCalls,
					identityReceipt,
					modelFamily,
					resolvedToolPolicyId,
					completionKind,
				});

				const blocking = review.findings.filter(
					f =>
						(f.status === "open" || f.status === "in_progress") &&
						FindingTracker.computeBlockingDisposition(f, review, this.#config.confidenceThreshold),
				);
				let decision = review.decision;
				if (decision === "approved" && blocking.length > 0) decision = "changes_requested";
				const next = getNextStage("code_review", decision);
				if (!next) throw new WorkflowPolicyError("invalid_review_decision", { decision });
				await this.#completeTo(workflowId, attemptId, fresh.status, next, `code_review:${decision}`, fresh.version);
				return;
			}
			case "repairing": {
				if (!this.#plan) throw new WorkflowPolicyError("missing_plan_artifact", { workflowId });
				const open = this.#findingTracker.getOpen();
				if (
					this.#workPackageState?.stage === "repairing" &&
					(this.#workPackageState.merge.status === "prepared" || this.#workPackageState.merge.status === "applied")
				) {
					const recovered = await this.#recoverAppliedWorkPackageImplementation(
						workflowId,
						attemptId,
						cwd,
						"repairing",
					);
					const recoveredFingerprints = new Set<string>();
					for (const finding of open) {
						if (recoveredFingerprints.has(finding.fingerprint)) continue;
						recoveredFingerprints.add(finding.fingerprint);
						this.#findingTracker.recordRepairCycle(finding.fingerprint);
					}
					await this.#completeRepairStage(workflowId, attemptId, fresh, recovered.artifact, open);
					return;
				}
				// Repair-cycle cap only applies when *entering* repair, not post-repair verify.
				if (!(await this.#budgetLedger.checkPreRepair())) {
					const snap = this.#budgetLedger.snapshot();
					await this.#store.completeAttemptAndTransition({
						workflowId,
						attemptId,
						attemptStatus: "failed",
						fromStatus: fresh.status,
						toStatus: "blocked",
						reason: "max_repair_cycles_exceeded",
						expectedVersion: fresh.version,
						budget: this.#ledgerBudgetSnapshot(),
					});
					throw new BudgetExhaustedError(snap.repairCycles, snap.costUsd ?? "unknown", snap.limitUsd);
				}
				// One cycle per unique fingerprint (not per finding id) so duplicate IDs do not skip repair.
				const seenFingerprints = new Set<string>();
				for (const f of open) {
					if (seenFingerprints.has(f.fingerprint)) continue;
					seenFingerprints.add(f.fingerprint);
					const esc = this.#findingTracker.recordRepairCycle(f.fingerprint);
					if (esc === "block" || this.#findingTracker.shouldBlock()) {
						await this.#store.completeAttemptAndTransition({
							workflowId,
							attemptId,
							attemptStatus: "failed",
							fromStatus: fresh.status,
							toStatus: "blocked",
							reason: "repeated_finding_block",
							expectedVersion: fresh.version,
							budget: this.#ledgerBudgetSnapshot(),
						});
						return;
					}
				}
				const repairAssignment = [
					`Repair findings: ${open.map(f => f.id).join(", ")}`,
					...(this.#requiresRepairNoOpDeclaration(open)
						? [
								"Final verification passed every check except the completion gate with unresolved_items_open, and there are no blocking findings. No code changes are required. You MUST return noChangesRequired=true with no patchPath, branchName, or unresolved items.",
							]
						: []),
				].join("\n\n");
				const primary = open[0];
				const repairHandoff = this.#codeReview
					? await this.#buildAndPersistHandoff(
							workflowId,
							attemptId,
							"code_review",
							"repairing",
							() => {
								const repairHistory = open.map(f => ({
									findingId: f.id,
									fingerprint: FindingTracker.fingerprint(f),
									cycles: this.#findingTracker.cycleCount(FindingTracker.fingerprint(f)),
								}));
								return buildReviewerToRepairHandoff({
									review: this.#codeReview!,
									verification: this.#verification,
									implementation: this.#implementation,
									repairHistory,
									reviewRef: this.#codeReviewArtifactRef,
									verificationRef: this.#verificationArtifactRef,
									implRef: this.#implementationArtifactRef,
								});
							},
							[this.#codeReviewArtifactRef, this.#verificationArtifactRef, this.#implementationArtifactRef],
						)
					: undefined;
				// Treatment receipt: a mechanical repair was routed with static split engaged.
				if (roleStaticSplitEnabled && (parseWorkflowMechanicalClass(policy.mechanicalClass) ?? undefined)) {
					session.markLatencyArmFired?.("role_static_split");
				}
				const {
					artifact: repaired,
					usage,
					resolvedProvider,
					resolvedModel,
					toolCalls,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
					identityReceipt,
					modelFamily,
					resolvedToolPolicyId,
					completionKind,
				} = await this.#withProfileFallback(
					"repair",
					{
						finding: primary,
						findingTracker: this.#findingTracker,
						preferReasoningRepair: primary ? this.#findingTracker.needsReasoningRepair(primary) : false,
						mechanicalClass: parseWorkflowMechanicalClass(policy.mechanicalClass) ?? undefined,
						roleStaticSplitEnabled,
					},
					async profile =>
						new RepairStage(this.#adapter).execute({
							workflowId,
							attemptId,
							profile,
							findingIds: open.map(f => f.id),
							findings: open,
							assignment: repairAssignment,
							context: await this.#buildStageContext(
								this.#contextBuilder.buildRepairContext({
									plan: this.#plan!,
									findings: open,
									// Prefer the latest final_verify failure when repairing after completion-gate/scope regressions.
									verification: this.#finalVerification ?? this.#verification,
									implementation: this.#implementation,
									reviewExplanation: this.#codeReview?.explanation ?? this.#planReview?.explanation,
									inclusion: resolveArtifactInclusion(profile),
								}),
								profile,
								session,
								[
									...(this.#plan?.affectedFiles.map(f => f.path) ?? []),
									...(this.#implementation?.changedFiles ?? []),
									...open.map(f => f.file).filter((p): p is string => Boolean(p)),
								],
								repairHandoff,
							),
							session,
							signal,
							isolation: this.#config.isolation,
						}),
				);
				// Build the cumulative candidate without mutating durable workflow state before validation/merge.
				const previous = this.#implementation;
				const strictRepairNoOp = await this.#canAcceptStrictRepairNoOp({
					repaired,
					previous,
					open,
					cwd,
				});
				let candidateImplementation: ImplementationArtifactV1 = {
					...repaired,
					...(strictRepairNoOp && previous
						? {
								patchPath: previous.patchPath,
								branchName: undefined,
								modelProfileId: previous.modelProfileId,
								provider: previous.provider,
								model: previous.model,
								promptVersion: previous.promptVersion,
							}
						: {}),
					changedFiles: [...new Set([...(previous?.changedFiles ?? []), ...repaired.changedFiles])],
					unresolved: [
						...new Set([
							...(repaired.unresolved ?? []),
							...(!strictRepairNoOp && previous?.patchPath && previous.patchPath !== repaired.patchPath
								? [`priorPatch:${previous.patchPath}`]
								: []),
						]),
					],
				};
				await this.#persistScopeMetrics(workflowId, attemptId, cwd, this.#plan, candidateImplementation);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage, {
					resolvedProvider,
					resolvedModel,
					toolCalls,
					identityReceipt,
					modelFamily,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
					resolvedToolPolicyId,
					completionKind,
					scopeMetricsKind: this.#lastScopeMetrics ? "scope-metrics" : undefined,
				});
				if (strictRepairNoOp) {
					const profile = this.#router.list().find(candidate => candidate.id === repaired.modelProfileId);
					if (!profile) {
						throw new WorkflowPolicyError("strict_write_profile_missing", {
							profileId: repaired.modelProfileId,
						});
					}
					this.#assertStrictWriteIdentity(profile, identityReceipt);
					this.#assertStrictWriteScope(profile);
				} else {
					candidateImplementation = await this.#commitValidatedWrite({
						workflowId,
						attemptId,
						cwd,
						artifact: candidateImplementation,
						identityReceipt,
						modelFamily,
						signal,
					});
				}
				await this.#completeRepairStage(workflowId, attemptId, fresh, candidateImplementation, open, {
					modelFamily: strictRepairNoOp ? this.#implementerModelFamily : modelFamily,
				});
				return;
			}
			case "final_verify": {
				const commands = this.#trustedVerificationCommands(this.#plan?.verificationCommands);
				const openFindings = this.#findingTracker.getOpen().filter(f => f.blocking === true);
				const verification = await new FinalVerifyStage(this.#verifier).execute({
					workflowId,
					attemptId,
					commands,
					forbiddenPaths: this.#config.forbiddenPaths,
					implementation: this.#implementation,
					openFindings,
					scopeStatus: this.#lastScopeMetrics?.status,
					signal,
					timeoutMs: this.#config.verificationTimeoutMs,
					cwd,
				});
				this.#finalVerification = verification;
				await this.#persistArtifact(workflowId, attemptId, "verification", verification);
				const decision = verification.passed ? "passed" : "failed";
				const next = getNextStage("final_verify", decision);
				await this.#completeTo(
					workflowId,
					attemptId,
					fresh.status,
					next!,
					`final_verify:${decision}`,
					fresh.version,
				);
				return;
			}
			default:
				throw new WorkflowPolicyError("unsupported_stage", { stage });
		}
	}

	async #isMissingOrEmptyPatch(patchPath: string | undefined, cwd: string): Promise<boolean> {
		if (!patchPath) return true;
		const resolved = path.isAbsolute(patchPath) ? patchPath : path.join(cwd, patchPath);
		try {
			return (await Bun.file(resolved).text()).trim().length === 0;
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				return true;
			}
			throw error;
		}
	}

	#requiresRepairNoOpDeclaration(open: readonly ReviewFindingV1[]): boolean {
		if (open.some(finding => finding.blocking === true)) return false;
		const finalVerification = this.#finalVerification;
		if (!finalVerification || finalVerification.passed) return false;
		const failedChecks = finalVerification.checks.filter(check => check.status === "failed");
		if (failedChecks.length !== 1 || failedChecks[0].id !== "completion-gate") return false;
		const completionReason = failedChecks[0].summary.split(":").slice(1).join(":").trim();
		if (completionReason !== "unresolved_items_open") return false;
		return finalVerification.checks.every(check => check.id === "completion-gate" || check.status === "passed");
	}

	async #canAcceptStrictRepairNoOp(options: {
		repaired: ImplementationArtifactV1;
		previous: ImplementationArtifactV1 | undefined;
		open: readonly ReviewFindingV1[];
		cwd: string;
	}): Promise<boolean> {
		if (options.repaired.noChangesRequired !== true) return false;
		const profile = this.#router.list().find(candidate => candidate.id === options.repaired.modelProfileId);
		if (!profile?.strictIdentity || !options.previous?.patchPath) return false;
		if (options.repaired.branchName) return false;
		if (options.repaired.unresolved.length !== 0) return false;
		const hasRealUnresolved = options.previous.unresolved.some(
			item => item.trim().length > 0 && !item.startsWith("priorPatch:"),
		);
		if (!hasRealUnresolved || !this.#requiresRepairNoOpDeclaration(options.open)) return false;
		return this.#isMissingOrEmptyPatch(options.repaired.patchPath, options.cwd);
	}

	async #completeRepairStage(
		workflowId: string,
		attemptId: string,
		fresh: WorkflowState,
		implementation: ImplementationArtifactV1,
		open: readonly ReviewFindingV1[],
		evidence?: { modelFamily?: string | null },
	): Promise<void> {
		this.#implementation = implementation;
		// Latest write author must drive independent-review exclusion after repair.
		if (implementation.provider) this.#implementerVendor = implementation.provider;
		if (evidence?.modelFamily) this.#implementerModelFamily = evidence.modelFamily;
		else if (implementation.modelProfileId) {
			const profile = this.#router.list().find(p => p.id === implementation.modelProfileId);
			if (profile?.vendor) this.#implementerVendor = profile.vendor;
		}
		const resolvedIds = new Set(implementation.addressedStepIds);
		for (const id of open.map(finding => finding.id)) {
			if (resolvedIds.has(id)) this.#findingTracker.resolve(id, "resolved", [`repair:${attemptId}`]);
		}
		this.#implementationArtifactRef = await this.#persistArtifact(
			workflowId,
			attemptId,
			"implementation",
			this.#implementation,
		);
		await this.#persistFindingsState(workflowId, attemptId);
		this.#budgetLedger.recordRepairCycle();
		const next = getNextStage("repairing", null);
		await this.#completeTo(workflowId, attemptId, fresh.status, next!, "repair complete", fresh.version);
	}

	async #executeImplementation(
		workflowId: string,
		attemptId: string,
		session: ToolSession,
		plannerHandoff: StageHandoffV1 | undefined,
		signal?: AbortSignal,
		policy: Record<string, unknown> = {},
	): Promise<{
		artifact: ImplementationArtifactV1;
		usageRecorded: boolean;
		writeCommitted: boolean;
		usage?: unknown;
		evidence?: WorkflowRuntimeEvidence;
	}> {
		if (
			this.#workPackageState?.stage === "implementing" &&
			(this.#workPackageState.merge.status === "prepared" || this.#workPackageState.merge.status === "applied")
		) {
			return this.#recoverAppliedWorkPackageImplementation(workflowId, attemptId, session.cwd, "implementing");
		}
		const settingsGet = session.settings?.get?.bind(session.settings);
		const configuredConcurrency = settingsGet?.("task.maxConcurrency" as "task.maxConcurrency");
		const taskMaxConcurrency = typeof configuredConcurrency === "number" ? configuredConcurrency : 0;
		const declarationArmEnabled = isLatencyArmEnabled(session, "concurrency_declaration");
		const executionArmEnabled = isLatencyArmEnabled(session, "concurrency_execution");
		let concurrencyDeclaration: WorkflowConcurrencyDeclarationV1 | undefined;
		if (declarationArmEnabled) {
			const rawDeclaration = policy.concurrencyDeclaration;
			if (rawDeclaration !== undefined) {
				if (!rawDeclaration || typeof rawDeclaration !== "object" || Array.isArray(rawDeclaration)) {
					throw new WorkflowPolicyError("concurrency_declaration_invalid", { reason: "expected object" });
				}
				const candidate = rawDeclaration as WorkflowConcurrencyDeclarationV1;
				const validation = validateConcurrencyDeclaration(candidate, {
					knownFieldsOnly: true,
					raw: rawDeclaration as Record<string, unknown>,
				});
				if (!validation.ok) {
					throw new WorkflowPolicyError("concurrency_declaration_invalid", { errors: validation.errors });
				}
				// Bind declaration scope to the approved plan artifact when available.
				if (this.#planArtifactSha256 && candidate.scopeArtifactSha256 !== this.#planArtifactSha256) {
					throw new WorkflowPolicyError("concurrency_declaration_invalid", {
						reason: "scope_artifact_sha256_mismatch",
						expected: this.#planArtifactSha256,
						actual: candidate.scopeArtifactSha256,
					});
				}
				if (
					this.#planArtifactRef?.artifactId &&
					candidate.scopeArtifactRef &&
					candidate.scopeArtifactRef !== this.#planArtifactRef.artifactId &&
					candidate.scopeArtifactRef !== this.#planArtifactRef.recoveryUri
				) {
					throw new WorkflowPolicyError("concurrency_declaration_invalid", {
						reason: "scope_artifact_ref_mismatch",
						expected: this.#planArtifactRef.artifactId,
						actual: candidate.scopeArtifactRef,
					});
				}
				concurrencyDeclaration = candidate;
			} else if (this.#plan?.workPackages) {
				const generated = workPackagesToConcurrencyDeclaration(this.#plan.workPackages, {
					declarationId: `${workflowId}:work-packages`,
					ownerId: workflowId,
					maxConcurrency: 0,
					scopeArtifactRef: this.#planArtifactRef?.artifactId ?? `${workflowId}:plan`,
					scopeArtifactSha256: this.#planArtifactSha256 ?? "0".repeat(64),
				});
				if (generated) {
					const validation = validateConcurrencyDeclaration(generated, { knownFieldsOnly: true });
					if (!validation.ok) {
						throw new WorkflowPolicyError("concurrency_declaration_invalid", { errors: validation.errors });
					}
					concurrencyDeclaration = generated;
				}
			}
		}
		// Treatment receipt: a validated declaration actually drove this run's plan.
		if (concurrencyDeclaration) session.markLatencyArmFired?.("concurrency_declaration");
		const maxConcurrency =
			concurrencyDeclaration && executionArmEnabled
				? resolveEffectiveConcurrency({
						declarationMax: concurrencyDeclaration.maxConcurrency,
						sessionMax: taskMaxConcurrency,
					})
				: taskMaxConcurrency;
		const mergeCapturedChanges = this.#adapter.mergeCapturedChanges;
		let packageInput = this.#plan?.workPackages;
		if (concurrencyDeclaration && executionArmEnabled) {
			// Treatment receipt: the declaration was lowered onto the work-package runtime.
			session.markLatencyArmFired?.("concurrency_execution");
			const initialStates = concurrencyDeclaration.units.map(unit => ({
				id: unit.id,
				status: "declared" as const,
				attemptCount: 0,
			}));
			const ready = readyConcurrencyUnits(concurrencyDeclaration, initialStates);
			// Work-package lowering only represents write units today. Required read/evidence
			// units must not be silently dropped — reject mixed/unsupported declarations.
			const unsupportedRequired = concurrencyDeclaration.units.filter(
				unit => unit.required && unit.mode !== "write",
			);
			if (unsupportedRequired.length > 0) {
				throw new WorkflowPolicyError("concurrency_declaration_invalid", {
					reason: "required_non_write_units_unsupported",
					unitIds: unsupportedRequired.map(unit => unit.id),
				});
			}
			const hasDependencies = concurrencyDeclaration.units.some(unit => unit.dependsOn.length > 0);
			if (hasDependencies || !shouldAutoParallel(ready)) {
				packageInput = undefined;
			} else {
				packageInput = concurrencyDeclaration.units
					.filter(unit => unit.mode === "write")
					.map(unit => ({
						id: unit.id,
						assignment: unit.assignment,
						paths: [...unit.paths],
						dependsOn: [...unit.dependsOn],
					}));
			}
		}
		const packagePlan = buildWorkPackageExecutionPlan(packageInput, maxConcurrency);
		const implementerRoute = {
			mechanicalClass:
				parseWorkflowMechanicalClass(policy.mechanicalClass) ??
				classifyPlanMechanicalImplementer(this.#plan) ??
				undefined,
			preferVeryComplexImplementer: isVeryComplexImplementerPlan(this.#plan),
		};
		if (!mergeCapturedChanges || !packagePlan) {
			const result = await this.#withProfileFallback("implementer", implementerRoute, async profile => {
				this.#implementerVendor = profile.vendor;
				return new ImplementStage(this.#adapter).execute({
					workflowId,
					attemptId,
					profile,
					assignment: "Implement the approved plan in isolation",
					context: await this.#buildStageContext(
						this.#contextBuilder.buildImplementContext(
							this.#plan!,
							this.#planReview,
							resolveArtifactInclusion(profile),
						),
						profile,
						session,
						this.#plan?.affectedFiles.map(file => file.path),
						plannerHandoff,
					),
					session,
					signal,
					isolation: this.#config.isolation,
				});
			});
			this.#implementerModelFamily = result.modelFamily;
			return {
				artifact: result.artifact,
				usageRecorded: false,
				writeCommitted: false,
				usage: result.usage,
				evidence: {
					resolvedProvider: result.resolvedProvider,
					resolvedModel: result.resolvedModel,
					toolCalls: result.toolCalls,
					promptAssemblyReceipt: result.promptAssemblyReceipt,
					contextLedger: result.contextLedger,
					optimizationReceipts: result.optimizationReceipts,
					identityReceipt: result.identityReceipt,
					modelFamily: result.modelFamily,
					resolvedToolPolicyId: result.resolvedToolPolicyId,
					completionKind: result.completionKind,
				},
			};
		}

		let profileAttempt = 0;
		const resumableStatePresent = this.#workPackageState !== undefined;
		const completed = await this.#withProfileFallback("implementer", implementerRoute, async (profile, route) => {
			this.#implementerVendor = profile.vendor;
			const reuseSucceeded = profileAttempt === 0 && resumableStatePresent;
			profileAttempt += 1;
			const profileBudget = this.#budgetLedger.profileSnapshot(profile.id);
			const plannedRequests = reuseSucceeded
				? packagePlan.packages.filter(workPackage => {
						const previous = this.#workPackageState?.packages.find(candidate => candidate.id === workPackage.id);
						return previous?.status !== "succeeded";
					}).length
				: packagePlan.packages.length;
			if (
				profile.maxRequests !== undefined &&
				profileBudget.profileRequests + plannedRequests > profile.maxRequests
			) {
				throw new BudgetExhaustedError(
					profileBudget.profileRequests + plannedRequests,
					profileBudget.profileRequests,
					profile.maxRequests,
				);
			}
			const workPackageState = await executeWorkPackagePlan({
				workflowId,
				attemptId,
				cwd: session.cwd,
				plan: packagePlan,
				priorState: this.#workPackageState,
				reuseSucceeded,
				signal,
				execute: async (workPackage, invocationAttemptId, workerSignal) => {
					const result = await new ImplementStage(this.#adapter).execute({
						workflowId,
						attemptId: invocationAttemptId,
						profile,
						assignment: renderWorkPackageAssignment(workPackage),
						context: await this.#buildStageContext(
							this.#contextBuilder.buildImplementContext(
								this.#plan!,
								this.#planReview,
								resolveArtifactInclusion(profile),
							),
							profile,
							session,
							workPackage.paths,
							plannerHandoff,
						),
						session,
						signal: workerSignal,
						isolation: { merge: "patch", apply: false },
					});
					this.#assertStrictWriteIdentity(profile, result.identityReceipt);
					return result;
				},
				persist: state => this.#persistWorkPackageState(workflowId, attemptId, state),
				onSuccess: async (_workPackage, result) => {
					await this.#recordUsageAndProfile(workflowId, attemptId, result.usage, {
						resolvedProvider: result.resolvedProvider,
						resolvedModel: result.resolvedModel,
						toolCalls: result.toolCalls,
						promptAssemblyReceipt: result.promptAssemblyReceipt,
						contextLedger: result.contextLedger,
						optimizationReceipts: result.optimizationReceipts,
						identityReceipt: result.identityReceipt,
						modelFamily: result.modelFamily,
						resolvedToolPolicyId: result.resolvedToolPolicyId,
						completionKind: result.completionKind,
					});
				},
			});
			return { profile, routeModelFamily: route.modelFamily, workPackageState };
		});
		const completedExecutions = completed.workPackageState.packages.filter(
			execution => execution.status === "succeeded",
		);
		for (const execution of completedExecutions) {
			this.#assertStrictWriteIdentity(completed.profile, execution.identityReceipt);
		}
		this.#implementerModelFamily =
			completedExecutions
				.map(execution => execution.modelFamily ?? execution.identityReceipt?.modelFamily)
				.find((family): family is string => typeof family === "string") ?? completed.routeModelFamily;

		const patches = completed.workPackageState.merge.order.map(packageId => {
			const execution = completed.workPackageState.packages.find(candidate => candidate.id === packageId);
			const patchPath = execution?.implementation?.patchPath;
			if (!patchPath) throw new WorkflowPolicyError("work_package_patch_missing_before_merge", { packageId });
			return { packageId, patchPath };
		});
		await this.#persistWorkPackageScopeMetrics(workflowId, attemptId, session.cwd, this.#plan!, patches);
		this.#assertStrictWriteScope(completed.profile);
		const outputPatchPath = path.join(
			this.#artifactStore.baseDir,
			workflowId,
			"patches",
			`${attemptId}.packages.patch`,
		);
		const committed = await this.#mergePreparedWriteCommit({
			workflowId,
			attemptId,
			cwd: session.cwd,
			state: completed.workPackageState,
			patches,
			outputPatchPath,
			signal,
		});
		const mergedState = committed.state;
		const merge = committed.merge;
		return {
			artifact: aggregateWorkPackageImplementations({
				workflowId,
				attemptId,
				profile: completed.profile,
				state: mergedState,
				merge,
			}),
			usageRecorded: true,
			writeCommitted: true,
		};
	}

	async #recoverAppliedWorkPackageImplementation(
		workflowId: string,
		attemptId: string,
		cwd: string,
		expectedStage: "implementing" | "repairing",
	): Promise<{
		artifact: ImplementationArtifactV1;
		usageRecorded: boolean;
		writeCommitted: boolean;
	}> {
		let state = this.#workPackageState;
		if (
			!state ||
			state.stage !== expectedStage ||
			(state.merge.status !== "prepared" && state.merge.status !== "applied") ||
			!state.merge.patchPath ||
			state.packages.some(execution => execution.status !== "succeeded" || !execution.implementation)
		) {
			throw new WorkflowPolicyError("work_package_applied_state_invalid", { expectedStage });
		}
		if (state.merge.status === "prepared") {
			state = await this.#settlePreparedWriteCommit(workflowId, attemptId, cwd, state, {
				patchPath: state.merge.patchPath,
				changesApplied: true,
				summary: "Recovered applied patch from prepared write-commit state",
			});
			if (state.merge.status !== "applied") {
				throw new WorkflowPolicyError("work_package_prepared_patch_not_applied", {
					patchPath: state.merge.patchPath,
				});
			}
		} else if ((await this.#inspectPersistedWritePatch(state, cwd)) !== "applied") {
			throw new WorkflowPolicyError("work_package_applied_patch_drift", {
				patchPath: state.merge.patchPath,
			});
		}
		if (state.scopeStatus !== undefined && state.scopeStatus !== "adhered") {
			throw new WorkflowPolicyError("work_package_applied_scope_not_approved", {
				scopeStatus: state.scopeStatus,
			});
		}
		const packageProfileIds = state.packages.map(
			execution => execution.identityReceipt?.configured.profileId ?? execution.implementation?.modelProfileId,
		);
		const profileIds = new Set(packageProfileIds.filter((profileId): profileId is string => Boolean(profileId)));
		if (profileIds.size !== 1 || packageProfileIds.some(profileId => !profileId)) {
			throw new WorkflowPolicyError("work_package_applied_profile_ambiguous", {
				profileIds: [...profileIds],
			});
		}
		const profileId = [...profileIds][0];
		const expectedRole: WorkflowRole = expectedStage === "repairing" ? "repair" : "implementer";
		const profile = profileId ? this.#router.list().find(candidate => candidate.id === profileId) : undefined;
		if (!profile?.roles.includes(expectedRole)) {
			throw new WorkflowPolicyError("work_package_applied_profile_missing", { profileId, expectedRole });
		}
		for (const execution of state.packages) {
			this.#assertStrictWriteIdentity(profile, execution.identityReceipt);
		}
		this.#assertStrictWriteScope(profile);
		const merge: CapturedChangesMergeResult = {
			patchPath: state.merge.patchPath!,
			changesApplied: true,
			summary: state.merge.summary ?? "Recovered previously applied workflow merge",
		};
		let artifact: ImplementationArtifactV1;
		if (state.packages.length === 1) {
			artifact = {
				...state.packages[0]!.implementation!,
				workflowId,
				attemptId,
				stage: expectedStage,
				patchPath: merge.patchPath,
				branchName: undefined,
			};
		} else {
			if (expectedStage !== "implementing") {
				throw new WorkflowPolicyError("work_package_repair_aggregate_ambiguous");
			}
			artifact = aggregateWorkPackageImplementations({ workflowId, attemptId, profile, state, merge });
		}
		if (expectedStage === "implementing") {
			this.#implementerVendor = profile.vendor;
			this.#implementerModelFamily =
				state.packages
					.map(execution => execution.modelFamily ?? execution.identityReceipt?.modelFamily)
					.find((family): family is string => typeof family === "string") ?? this.#implementerModelFamily;
		}
		return { artifact, usageRecorded: true, writeCommitted: true };
	}

	async #commitValidatedWrite(options: {
		workflowId: string;
		attemptId: string;
		cwd: string;
		artifact: ImplementationArtifactV1;
		identityReceipt?: WorkflowRuntimeIdentityReceiptV1;
		modelFamily?: string;
		signal?: AbortSignal;
	}): Promise<ImplementationArtifactV1> {
		const profile = this.#router.list().find(candidate => candidate.id === options.artifact.modelProfileId);
		if (!profile?.strictIdentity) return options.artifact;
		this.#assertStrictWriteIdentity(profile, options.identityReceipt);
		this.#assertStrictWriteScope(profile);
		if (!options.artifact.patchPath) {
			throw new WorkflowPolicyError("strict_write_patch_missing", { profileId: profile.id });
		}
		if (options.artifact.stage !== "implementing" && options.artifact.stage !== "repairing") {
			throw new WorkflowPolicyError("strict_write_stage_invalid", { stage: options.artifact.stage });
		}
		const packageId = `validated-${options.artifact.stage}`;
		const state: WorkPackageStateArtifactV1 = {
			kind: "work-package-state",
			schemaVersion: 1,
			workflowId: options.workflowId,
			attemptId: options.attemptId,
			stage: options.artifact.stage,
			createdAt: new Date().toISOString(),
			revision: this.#workPackageState?.revision ?? 0,
			mode: "capture_then_apply",
			packages: [
				{
					id: packageId,
					assignment: `Validated ${options.artifact.stage} write`,
					paths: [...options.artifact.changedFiles],
					dependsOn: [],
					status: "succeeded",
					invocationAttemptId: options.attemptId,
					implementation: structuredClone(options.artifact),
					identityReceipt: options.identityReceipt,
					modelFamily: options.modelFamily ?? options.identityReceipt?.modelFamily ?? undefined,
				},
			],
			merge: { status: "pending", order: [packageId] },
		};
		const committed = await this.#mergePreparedWriteCommit({
			workflowId: options.workflowId,
			attemptId: options.attemptId,
			cwd: options.cwd,
			state,
			patches: [{ packageId, patchPath: options.artifact.patchPath }],
			outputPatchPath: path.join(
				this.#artifactStore.baseDir,
				options.workflowId,
				"patches",
				`${options.attemptId}.validated.patch`,
			),
			signal: options.signal,
		});
		return { ...options.artifact, patchPath: committed.merge.patchPath, branchName: undefined };
	}

	async #mergePreparedWriteCommit(options: {
		workflowId: string;
		attemptId: string;
		cwd: string;
		state: WorkPackageStateArtifactV1;
		patches: readonly { packageId: string; patchPath: string }[];
		outputPatchPath: string;
		signal?: AbortSignal;
	}): Promise<{ state: WorkPackageStateArtifactV1; merge: CapturedChangesMergeResult }> {
		const mergeCapturedChanges = this.#adapter.mergeCapturedChanges;
		if (!mergeCapturedChanges) throw new WorkflowPolicyError("strict_write_commit_seam_unavailable");
		const prepared = await this.#prepareWriteCommitState(options);
		let reported: CapturedChangesMergeResult;
		try {
			reported = await mergeCapturedChanges({
				workflowId: options.workflowId,
				attemptId: options.attemptId,
				cwd: options.cwd,
				patches: options.patches,
				outputPatchPath: options.outputPatchPath,
				signal: options.signal,
			});
		} catch (error) {
			const summary = redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 500);
			const reconciled = await this.#settlePreparedWriteCommit(
				options.workflowId,
				options.attemptId,
				options.cwd,
				prepared,
				{ patchPath: options.outputPatchPath, changesApplied: false, summary },
			);
			if (reconciled.merge.status !== "applied") {
				if (error instanceof WorkflowCancelledError) throw error;
				throw new WorkflowError("Validated workflow patch was not applied", "merge_conflict", {
					patchPath: options.outputPatchPath,
					summary,
				});
			}
			return {
				state: reconciled,
				merge: {
					patchPath: reconciled.merge.patchPath!,
					changesApplied: true,
					summary: reconciled.merge.summary ?? "Recovered applied merge after merger error",
				},
			};
		}
		const reconciled = await this.#settlePreparedWriteCommit(
			options.workflowId,
			options.attemptId,
			options.cwd,
			prepared,
			reported,
			reported.changesApplied === true,
		);
		if (reconciled.merge.status !== "applied") {
			throw new WorkflowError("Validated workflow patch was not applied", "merge_conflict", {
				patchPath: reconciled.merge.patchPath,
				summary: reconciled.merge.summary,
			});
		}
		return {
			state: reconciled,
			merge: {
				patchPath: reconciled.merge.patchPath!,
				changesApplied: true,
				summary: reconciled.merge.summary ?? reported.summary,
			},
		};
	}

	async #prepareWriteCommitState(options: {
		workflowId: string;
		attemptId: string;
		cwd: string;
		state: WorkPackageStateArtifactV1;
		patches: readonly { packageId: string; patchPath: string }[];
		outputPatchPath: string;
	}): Promise<WorkPackageStateArtifactV1> {
		const scopeStatus = this.#lastScopeMetrics?.status;
		if (scopeStatus !== "adhered") {
			throw new WorkflowPolicyError("strict_write_scope_not_approved", { scopeStatus: scopeStatus ?? "missing" });
		}
		const patchTexts: string[] = [];
		for (const patch of options.patches) {
			const resolved = path.isAbsolute(patch.patchPath) ? patch.patchPath : path.join(options.cwd, patch.patchPath);
			try {
				const text = await Bun.file(resolved).text();
				patchTexts.push(text.length === 0 || text.endsWith("\n") ? text : `${text}\n`);
			} catch (error) {
				throw new WorkflowPolicyError("strict_write_patch_unreadable", {
					packageId: patch.packageId,
					patchPath: patch.patchPath,
					reason: redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 500),
				});
			}
		}
		const patchText = patchTexts.join("");
		if (!patchText.trim()) throw new WorkflowPolicyError("strict_write_patch_empty");
		await fs.mkdir(path.dirname(options.outputPatchPath), { recursive: true });
		try {
			const handle = await fs.open(options.outputPatchPath, "w");
			try {
				await handle.writeFile(patchText, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (error) {
			await fs.rm(options.outputPatchPath, { force: true }).catch(() => undefined);
			throw new WorkflowPolicyError("strict_write_patch_persistence_failed", {
				patchPath: options.outputPatchPath,
				reason: redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 500),
			});
		}
		const prepared = withWorkPackageMergePrepared(options.state, options.attemptId, {
			patchPath: options.outputPatchPath,
			patchSha256: sha256Hex(patchText),
			scopeStatus,
		});
		try {
			await this.#persistWorkPackageState(options.workflowId, options.attemptId, prepared);
		} catch (error) {
			await fs.rm(options.outputPatchPath, { force: true }).catch(() => undefined);
			throw error;
		}
		return prepared;
	}

	async #settlePreparedWriteCommit(
		workflowId: string,
		attemptId: string,
		cwd: string,
		state: WorkPackageStateArtifactV1,
		reported: CapturedChangesMergeResult,
		trustMerger = false,
	): Promise<WorkPackageStateArtifactV1> {
		if (!state.merge.patchPath) throw new WorkflowPolicyError("work_package_prepared_patch_missing");
		const expectedPath = path.isAbsolute(state.merge.patchPath)
			? state.merge.patchPath
			: path.join(cwd, state.merge.patchPath);
		const reportedPath = path.isAbsolute(reported.patchPath)
			? reported.patchPath
			: path.join(cwd, reported.patchPath);
		if (path.resolve(reportedPath) !== path.resolve(expectedPath)) {
			throw new WorkflowPolicyError("work_package_merge_patch_path_mismatch", {
				expectedPath: state.merge.patchPath,
				reportedPath: reported.patchPath,
			});
		}
		let changesApplied: boolean;
		if (trustMerger) {
			// A live merger reported success and already applied the canonical
			// aggregate. Verify the persisted patch is byte-identical to the
			// prepared hash, then persist `applied` immediately. Recovery-style
			// reverse/forward git proof is deliberately NOT required here: it is
			// only authoritative against an uncertain tree state (crash/unknown
			// outcome), and reports drift for legitimately applied patches (e.g.
			// insertion-only hunks whose forward check still succeeds after apply).
			// Resume keeps the strict proof; a changed patch body still fails closed.
			await this.#verifyPersistedWritePatchBytes(state, cwd);
			changesApplied = true;
		} else {
			const observed = await this.#inspectPersistedWritePatch(state, cwd);
			changesApplied = observed === "applied";
		}
		const reconciled = withWorkPackageMerge(state, attemptId, {
			patchPath: state.merge.patchPath,
			changesApplied,
			summary: reported.summary,
		});
		await this.#persistWorkPackageState(workflowId, attemptId, reconciled);
		return reconciled;
	}

	/**
	 * Verify the persisted aggregate patch is readable, non-empty, and byte-identical
	 * to the prepared SHA-256. Never trust a changed patch body.
	 */
	async #verifyPersistedWritePatchBytes(state: WorkPackageStateArtifactV1, cwd: string): Promise<string> {
		const persistedPatchPath = state.merge.patchPath;
		if (!persistedPatchPath) throw new WorkflowPolicyError("work_package_applied_patch_unreadable");
		const resolvedPatchPath = path.isAbsolute(persistedPatchPath)
			? persistedPatchPath
			: path.join(cwd, persistedPatchPath);
		let persistedPatchText: string;
		try {
			persistedPatchText = await Bun.file(resolvedPatchPath).text();
		} catch (error) {
			throw new WorkflowPolicyError("work_package_applied_patch_unreadable", {
				patchPath: persistedPatchPath,
				reason: redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 500),
			});
		}
		if (!persistedPatchText.trim()) {
			throw new WorkflowPolicyError("work_package_applied_patch_ambiguous", {
				patchPath: persistedPatchPath,
				reason: "empty_patch",
			});
		}
		if (state.merge.status === "prepared" && !state.merge.patchSha256) {
			throw new WorkflowPolicyError("work_package_prepared_patch_hash_missing", { patchPath: persistedPatchPath });
		}
		if (state.merge.patchSha256 && sha256Hex(persistedPatchText) !== state.merge.patchSha256) {
			throw new WorkflowPolicyError("work_package_applied_patch_hash_mismatch", { patchPath: persistedPatchPath });
		}
		return persistedPatchText;
	}

	async #inspectPersistedWritePatch(
		state: WorkPackageStateArtifactV1,
		cwd: string,
	): Promise<"applied" | "not_applied"> {
		const persistedPatchText = await this.#verifyPersistedWritePatchBytes(state, cwd);
		const persistedPatchPath = state.merge.patchPath!;
		let reverseApplies: boolean;
		let forwardApplies: boolean;
		try {
			[reverseApplies, forwardApplies] = await Promise.all([
				git.patch.canApplyText(cwd, persistedPatchText, { reverse: true }),
				git.patch.canApplyText(cwd, persistedPatchText),
			]);
		} catch (error) {
			throw new WorkflowPolicyError("work_package_applied_patch_verification_failed", {
				patchPath: persistedPatchPath,
				reason: redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 500),
			});
		}
		if (reverseApplies === true && forwardApplies === false) return "applied";
		if (reverseApplies === false && forwardApplies === true) return "not_applied";
		throw new WorkflowPolicyError("work_package_applied_patch_drift", {
			patchPath: persistedPatchPath,
			reverseApplies,
			forwardApplies,
		});
	}

	#assertStrictWriteIdentity(profile: ModelProfile, receipt: WorkflowRuntimeIdentityReceiptV1 | undefined): void {
		if (!profile.strictIdentity) return;
		let runtimeIdentityVerified = false;
		if (receipt) {
			try {
				assertStrictRuntimeIdentity(receipt);
				runtimeIdentityVerified = true;
			} catch {
				runtimeIdentityVerified = false;
			}
		}
		const expected = configuredIdentityForProfile(profile);
		const configured = receipt?.configured;
		const configuredMatches =
			configured?.profileId === expected.profileId &&
			configured.provider === expected.provider &&
			configured.model === expected.model &&
			configured.checkpoint === expected.checkpoint &&
			configured.provenance === expected.provenance &&
			configured.modelPattern === expected.modelPattern &&
			configured.requestedEffort === expected.requestedEffort &&
			configured.modelFamily === expected.modelFamily;
		if (!runtimeIdentityVerified || !configuredMatches) {
			throw new WorkflowPolicyError("strict_write_identity_not_verified", {
				profileId: profile.id,
				identityReceipt: receipt ?? null,
			});
		}
	}

	#assertStrictWriteScope(profile: ModelProfile): void {
		if (!profile.strictIdentity) return;
		if (this.#lastScopeMetrics?.status !== "adhered") {
			throw new WorkflowPolicyError("strict_write_scope_not_approved", {
				profileId: profile.id,
				scopeStatus: this.#lastScopeMetrics?.status ?? "missing",
				scopeFindings: this.#lastScopeMetrics?.scopeCreepFindings ?? [],
			});
		}
	}

	async #persistWorkPackageScopeMetrics(
		workflowId: string,
		attemptId: string,
		cwd: string,
		plan: PlanArtifactV1,
		patches: readonly { packageId: string; patchPath: string }[],
	): Promise<void> {
		const changedFiles = new Set<string>();
		for (const patch of patches) {
			const resolved = path.isAbsolute(patch.patchPath) ? patch.patchPath : path.join(cwd, patch.patchPath);
			let text: string;
			try {
				text = await Bun.file(resolved).text();
			} catch (error) {
				throw new WorkflowPolicyError("work_package_patch_unreadable_before_merge", {
					packageId: patch.packageId,
					patchPath: patch.patchPath,
					reason: redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 500),
				});
			}
			const patchFiles = changedFilesFromPatch(text);
			if (patchFiles.length === 0) {
				throw new WorkflowPolicyError("work_package_patch_paths_unreadable", {
					packageId: patch.packageId,
					patchPath: patch.patchPath,
				});
			}
			for (const file of patchFiles) changedFiles.add(file);
		}
		const plannedFiles = plannedFilesFromPlan(plan, [...changedFiles]);
		const metrics = buildScopeMetrics({
			plannedFiles,
			forbiddenFiles: this.#config.forbiddenPaths ?? [],
			changedFiles: [...changedFiles],
		});
		this.#lastScopeMetrics = metrics;
		await this.#persistArtifact(workflowId, attemptId, "scope-metrics", metrics);
	}

	async #persistWorkPackageState(
		workflowId: string,
		attemptId: string,
		state: WorkPackageStateArtifactV1,
	): Promise<void> {
		const persisted = structuredClone(state);
		await this.#persistArtifact(workflowId, attemptId, "work-package-state", persisted);
		this.#workPackageState = persisted;
	}

	/**
	 * Optionally append stage handoff then a compressed repo-map when enabled.
	 * Production call site for ContextBuilder.appendStageHandoff + appendRepoMapIfEnabled.
	 */
	async #buildStageContext(
		base: string,
		profile: ModelProfile,
		session: ToolSession,
		relevantFiles?: string[],
		handoff?: StageHandoffV1 | null,
	): Promise<string> {
		const withHandoff = this.#contextBuilder.appendStageHandoff(base, handoff);
		return this.#contextBuilder.appendRepoMapIfEnabled(withHandoff, {
			cwd: session.cwd,
			contextStrategy: profile.contextStrategy,
			relevantFiles: relevantFiles?.length ? [...new Set(relevantFiles)] : undefined,
		});
	}

	/**
	 * Scope metrics from real patch/git evidence only.
	 * Prefer unified-diff paths (filesystem artifact); else git worktree.
	 * Never trust model-reported impl.changedFiles as sole actual changes.
	 * Git/collection failure → status indeterminate (not silent empty pass).
	 */
	async #persistScopeMetrics(
		workflowId: string,
		attemptId: string,
		cwd: string,
		plan: PlanArtifactV1,
		impl: ImplementationArtifactV1,
	): Promise<void> {
		const planned = plannedFilesFromPlan(plan);
		const forbidden = this.#config.forbiddenPaths ?? [];
		let changedFromPatch: string[] = [];
		let patchEvidenceAvailable = false;
		if (impl.patchPath) {
			const resolved = path.isAbsolute(impl.patchPath) ? impl.patchPath : path.join(cwd, impl.patchPath);
			try {
				const text = await Bun.file(resolved).text();
				patchEvidenceAvailable = true;
				changedFromPatch = changedFilesFromPatch(text);
			} catch {
				// missing patch is handled by verify; scope falls through to git
			}
		}

		let metrics: ScopeMetricsV1;
		if (patchEvidenceAvailable) {
			// Patch is filesystem evidence (not model prose). Infer deletes from /dev/null headers not needed here.
			metrics = buildScopeMetrics({
				plannedFiles: plannedFilesFromPlan(plan, changedFromPatch),
				forbiddenFiles: forbidden,
				changedFiles: changedFromPatch,
			});
		} else {
			try {
				metrics = await collectScopeMetricsFromGit({
					cwd,
					plannedFiles: planned,
					forbiddenFiles: forbidden,
				});
			} catch (err) {
				metrics = buildScopeMetrics({
					plannedFiles: planned,
					forbiddenFiles: forbidden,
					changedFiles: [],
					indeterminate: true,
					indeterminateReason: err instanceof Error ? err.message : "git collection threw",
				});
			}
			// Intentionally do NOT fall back to impl.changedFiles (model self-report).
		}

		this.#lastScopeMetrics = metrics;
		await this.#persistArtifact(workflowId, attemptId, "scope-metrics", metrics);
	}

	/** Finish an open attempt if still in_progress (no-op if already finished). */
	async #finishOpenAttempt(
		workflowId: string,
		attemptId: string,
		status: string,
		error?: { kind: string; summary: string },
	): Promise<void> {
		const attempts = await this.#store.listAttempts(workflowId);
		const open = attempts.find(a => a.id === attemptId && a.status === "in_progress");
		if (!open) return;
		await this.#store.completeAttempt(workflowId, attemptId, status, {}, error);
	}

	#isRetryableProviderError(error: unknown): boolean {
		if (error instanceof WorkflowError) {
			return mapWorkflowErrorOutcome(error.kind) === "retry_or_fallback";
		}
		return false;
	}

	/**
	 * Register the calling session's active model as the last legacy implementer candidate.
	 * Legacy routes only: quality-route snapshots keep their own profile set and stay
	 * fail-closed. Idempotent per run/resume — re-registers (overwrites by id) with the
	 * effective session's model each invocation, so resume re-finds the profile for
	 * work-package identity checks and artifact hydrate.
	 */
	#syncSessionFallbackProfile(session: ToolSession | undefined): void {
		if (this.#qualityRouteSnapshot) return;
		const fallback = sessionFallbackImplementerProfile(session);
		if (!fallback) return;
		this.#configuredRouter.register(fallback);
	}

	async #withPinnedProfile<T>(
		role: WorkflowRole,
		profileId: string,
		run: (profile: ModelProfile, route: RoutingDecision) => Promise<T>,
		reason: string,
	): Promise<T> {
		if (this.#preflightUnavailableReasons[profileId]) {
			throw new WorkflowPolicyError("plan_reviewer_identity_unavailable", {
				profileId,
				reason: this.#preflightUnavailableReasons[profileId],
			});
		}
		const profile = this.#router
			.list()
			.find(candidate => candidate.id === profileId && candidate.roles.includes(role));
		if (!profile) {
			throw new WorkflowPolicyError("plan_reviewer_identity_unavailable", { profileId, role });
		}
		const route: RoutingDecision = {
			profile,
			profileId,
			vendor: profile.vendor,
			reason,
			degraded: false,
			qualityTier: this.#qualityRouteSnapshot?.qualityTier,
			snapshotFingerprint: this.#qualityRouteSnapshot?.fingerprint,
			candidateProfileIds: [profileId],
			modelFamily: this.#planReviewerIdentity?.modelFamily,
			identityProvenance: "configured",
		};
		this.#audit(route);
		return run(profile, route);
	}

	#assertPlanReviewerIdentity(profile: ModelProfile, result: PlanReviewStageResult): void {
		const expected = this.#planReviewerIdentity;
		if (!expected) {
			throw new WorkflowPolicyError("plan_reviewer_identity_unavailable", {
				profileId: profile.id,
				reason: "missing_pinned_identity",
			});
		}
		const actual = resolvePlanReviewerIdentity(profile, result);
		if (!actual) {
			throw new WorkflowPolicyError("plan_reviewer_identity_unavailable", {
				profileId: profile.id,
				reason: "missing_attested_runtime_identity",
			});
		}
		if (
			expected.profileId !== actual.profileId ||
			expected.provider !== actual.provider ||
			expected.model !== actual.model ||
			expected.attestedProvenance !== actual.attestedProvenance ||
			(expected.modelFamily && actual.modelFamily && expected.modelFamily !== actual.modelFamily)
		) {
			throw new WorkflowPolicyError("plan_reviewer_identity_mismatch", {
				expected,
				actual,
			});
		}
	}

	async #runPlanArbitration(
		workflowId: string,
		attemptId: string,
		session: ToolSession,
		signal: AbortSignal | undefined,
		policy: Record<string, unknown>,
		triggerReason: Exclude<PlanReviewTriggerReasonV1, null>,
	): Promise<PlanReviewStageResult | null> {
		let route: RoutingDecision;
		try {
			route = this.#router.resolvePlanArbitrator({
				avoidModelFamilies: [this.#plannerModelFamily, this.#planReviewerIdentity?.modelFamily].filter(
					(family): family is string => Boolean(family),
				),
				unavailableProfileIds: Object.keys(this.#preflightUnavailableReasons),
				allowDegradedFallback: policy.planArbitratorAllowDegradedFallback === true,
			});
		} catch (error) {
			if (error instanceof WorkflowPolicyError) return null;
			throw error;
		}
		// HIGH-6: recheck global + selected-profile budgets immediately before the external call.
		// The stage-entry precheck can be exhausted by the preceding review in the same stage.
		if (!(await this.#budgetLedger.checkPreStage())) {
			const snap = this.#budgetLedger.snapshot();
			throw new BudgetExhaustedError(snap.requests, snap.costUsd ?? "unknown", snap.limitUsd);
		}
		if (
			!this.#budgetLedger.checkProfileBudget(route.profileId, {
				maxRequests: route.profile.maxRequests,
				maxCostUsd: route.profile.maxCostUsd,
			})
		) {
			const profileSnap = this.#budgetLedger.profileSnapshot(route.profileId);
			throw new BudgetExhaustedError(
				profileSnap.profileRequests,
				profileSnap.profileCostUsd ?? "unknown",
				route.profile.maxCostUsd ?? route.profile.maxRequests ?? 0,
			);
		}
		this.#audit(route);
		const requirementsSnapshot = await this.#requireRequirementsSnapshot(
			workflowId,
			attemptId,
			this.#parseRequest((await this.#requireState(workflowId)).requestJson),
		);
		return new PlanReviewStage(this.#adapter).execute({
			workflowId,
			attemptId,
			profile: route.profile,
			assignment: "Arbitrate the bounded plan-review disagreement",
			context: await this.#buildStageContext(
				`${this.#contextBuilder.buildPlanReviewContext(
					this.#plan!,
					resolveArtifactInclusion(route.profile),
					this.#requirementsSnapshot,
				)}\n\nLatest review to arbitrate:\n${JSON.stringify(this.#planReview)}\n\nAuthor responses:\n${JSON.stringify(this.#authorResponses ?? [])}\n\nArbitration trigger: ${triggerReason}`,
				route.profile,
				session,
				this.#plan?.affectedFiles.map(file => file.path),
			),
			session,
			signal,
			requirementsSnapshotRef:
				this.#requirementsSnapshotRef?.recoveryUri ?? `artifact://${workflowId}/requirements-snapshot`,
			requirementsSnapshotSha256: requirementsSnapshot.sha256,
			reviewKind: "arbitration",
			reviewRound: 2,
			authorResponses: this.#authorResponses ? [...this.#authorResponses] : [],
			triggerReason,
			routeSelectionReceiptRef: this.#planReviewControl?.routeSelectionReceiptRef ?? null,
		});
	}

	/**
	 * Resolve profile, run, and on retryable provider failure mark the profile unavailable
	 * and retry once via ModelRouter fallback / alternate candidates.
	 */
	async #withProfileFallback<T>(
		role: WorkflowRole,
		routeOptions: RouteOptions,
		run: (profile: ModelProfile, route: RoutingDecision) => Promise<T>,
	): Promise<T> {
		const preferredProfileIds = qualityRouteProfileIds(this.#qualityRouteSnapshot, role);
		const unavailable = new Set<string>([
			...Object.keys(this.#preflightUnavailableReasons),
			...(routeOptions.unavailableProfileIds ?? []),
		]);
		const unavailableReasons: Record<string, string> = {
			...this.#preflightUnavailableReasons,
			...routeOptions.unavailableReasons,
		};
		const effectiveRouteOptions: RouteOptions = {
			...routeOptions,
			...(this.#qualityRouteSnapshot
				? {
						preferredProfileIds,
						qualityTier: this.#qualityRouteSnapshot.qualityTier,
						snapshotFingerprint: this.#qualityRouteSnapshot.fingerprint,
						degradedMode: false,
					}
				: {}),
			unavailableReasons,
		};
		let lastError: unknown;
		// Retry budget = distinct routable candidates for the role (legacy), not the primary
		// profile's maxAttempts: a preflight-excluded primary must not truncate the chain
		// (e.g. DeepSeek down ⇒ Grok → Luna → session model still get their attempts).
		const maxAttempts =
			preferredProfileIds?.length ??
			Math.max(1, this.#router.list().filter(p => p.roles.includes(role) && !unavailable.has(p.id)).length);
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (attempt > 0 && !(await this.#budgetLedger.checkPreRetry())) {
				const snap = this.#budgetLedger.snapshot();
				throw new BudgetExhaustedError(snap.requests, snap.costUsd ?? "unknown", snap.limitUsd);
			}
			const route = this.#router.resolve(role, {
				...effectiveRouteOptions,
				unavailableProfileIds: unavailable,
			});
			if (
				!this.#budgetLedger.checkProfileBudget(route.profileId, {
					maxRequests: route.profile.maxRequests,
					maxCostUsd: route.profile.maxCostUsd,
				})
			) {
				throw new BudgetExhaustedError(
					this.#budgetLedger.profileSnapshot(route.profileId).profileRequests,
					this.#budgetLedger.profileSnapshot(route.profileId).profileCostUsd ?? "unknown",
					route.profile.maxCostUsd ?? route.profile.maxRequests ?? 0,
				);
			}
			this.#audit(route);
			try {
				return await run(route.profile, route);
			} catch (error) {
				lastError = error;
				const failedRequests = error instanceof WorkPackageExecutionError ? Math.max(1, error.failedRequests) : 1;
				for (let index = 0; index < failedRequests; index++) {
					this.#budgetLedger.recordRequest(undefined, route.profileId);
				}
				const kind = error instanceof WorkflowError ? error.kind : "";
				const retryableKinds = route.profile.retryPolicy?.retryableErrorKinds ?? [];
				const kindOk =
					this.#isRetryableProviderError(error) || (typeof kind === "string" && retryableKinds.includes(kind));
				if (attempt < maxAttempts - 1 && kindOk) {
					if (this.#activeWorkflowId) {
						try {
							await this.#persistAbortCompletionKind(this.#activeWorkflowId, error);
						} catch {
							// Evidence persist must not block a retryable profile fallback.
						}
					}
					unavailable.add(route.profileId);
					unavailableReasons[route.profileId] = `${kind || "runtime_error"}:${
						error instanceof Error ? error.message : String(error)
					}`;
					continue;
				}
				// Credential/identity exhaustion → blocked; other last-candidate errors surface as-is
				// (quality routes always block; legacy routes only block auth/quota/identity).
				const credentialKind = kind === "authentication" || kind === "quota" || kind === "identity_mismatch";
				if (kindOk && (this.#qualityRouteSnapshot || credentialKind)) {
					throw new WorkflowPolicyError("quality_route_candidates_exhausted", {
						role,
						qualityTier: this.#qualityRouteSnapshot?.qualityTier,
						lastProfileId: route.profileId,
						lastErrorKind: kind || "runtime_error",
					});
				}
				throw error;
			}
		}
		throw lastError;
	}

	/**
	 * Start a fresh attempt. If a stale `in_progress` attempt exists for this stage
	 * (interrupted process), mark it failed first.
	 * Write stages fail closed to blocked — never silently re-run implement/repair after crash.
	 */
	async #beginAttemptFailClosed(workflowId: string, stage: WorkflowStatus, state: WorkflowState): Promise<string> {
		if (state.currentAttemptId) {
			const attempts = await this.#store.listAttempts(workflowId);
			const open = attempts.find(
				a => a.id === state.currentAttemptId && a.status === "in_progress" && a.stage === stage,
			);
			if (open) {
				const writeStage = stage === "implementing" || stage === "repairing";
				const packageState = writeStage ? this.#workPackageState : undefined;
				const resumablePackageCapture =
					packageState?.mode === "capture_then_apply" && packageState.merge.status === "pending";
				const recoverablePreparedMerge =
					packageState?.mode === "capture_then_apply" && packageState.merge.status === "prepared";
				const recoverableAppliedMerge =
					packageState?.mode === "capture_then_apply" &&
					packageState.merge.status === "applied" &&
					packageState.merge.changesApplied === true;
				const recoverablePackageState =
					resumablePackageCapture || recoverablePreparedMerge || recoverableAppliedMerge;
				await this.#store.completeAttempt(
					workflowId,
					open.id,
					"failed",
					{},
					{
						kind: "cancelled",
						summary:
							writeStage && !recoverablePackageState
								? "write_stage_interrupted_no_rerun"
								: recoverablePreparedMerge
									? "work_package_merge_prepared_resume"
									: recoverableAppliedMerge
										? "work_package_merge_already_applied_resume"
										: resumablePackageCapture
											? "work_package_capture_interrupted_resumable"
											: "stale_in_progress_on_resume",
					},
				);
				if (writeStage && !recoverablePackageState) {
					const refreshed = await this.#requireState(workflowId);
					if (!TERMINAL.has(refreshed.status) && isValidTransition(refreshed.status, "blocked")) {
						await this.#store.transitionWorkflow(
							workflowId,
							refreshed.status,
							"blocked",
							"write_stage_interrupted_no_rerun",
							open.id,
							refreshed.version,
							this.#ledgerBudgetSnapshot(),
						);
					}
					throw new WorkflowPolicyError("write_stage_interrupted_no_rerun", {
						workflowId,
						stage,
						attemptId: open.id,
						hint: "Inspect isolation artifacts manually; do not auto-replay write stages after crash",
					});
				}
				const refreshed = await this.#requireState(workflowId);
				return this.#store.beginAttempt(workflowId, stage, undefined, refreshed.version);
			}
		}
		return this.#store.beginAttempt(workflowId, stage, undefined, state.version);
	}

	/** Ledger snapshot for atomic persistence with stage transitions. */
	#ledgerBudgetSnapshot(): Record<string, unknown> {
		return this.#budgetLedger.snapshot() as unknown as Record<string, unknown>;
	}

	/**
	 * Build once from the frozen WorkflowRequest and persist. Resume reuses the
	 * hydrated artifact; replan never regenerates a different snapshot.
	 */
	async #ensureRequirementsSnapshot(
		workflowId: string,
		attemptId: string,
		request: WorkflowRequest,
	): Promise<RequirementsSnapshotV1> {
		if (this.#requirementsSnapshot) return this.#requirementsSnapshot;
		const snapshot = buildRequirementsSnapshot({ workflowId, request });
		if (snapshot.requirements.length === 0) {
			throw new WorkflowPolicyError("requirements_snapshot_empty", {
				workflowId,
				hint: "WorkflowRequest must include a non-empty request or constraints",
			});
		}
		this.#requirementsSnapshot = snapshot;
		this.#requirementsSnapshotRef = await this.#persistArtifact(
			workflowId,
			attemptId,
			REQUIREMENTS_SNAPSHOT_KIND,
			snapshot,
		);
		return snapshot;
	}

	async #requireRequirementsSnapshot(
		workflowId: string,
		attemptId: string,
		request: WorkflowRequest,
	): Promise<RequirementsSnapshotV1> {
		const snapshot = await this.#ensureRequirementsSnapshot(workflowId, attemptId, request);
		if (!this.#requirementsSnapshotRef) {
			// Hydrated body without a durable ref: re-persist under the current attempt.
			this.#requirementsSnapshotRef = await this.#persistArtifact(
				workflowId,
				attemptId,
				REQUIREMENTS_SNAPSHOT_KIND,
				snapshot,
			);
		}
		return snapshot;
	}

	async #persistPlanReviewControl(workflowId: string, attemptId: string): Promise<void> {
		if (!this.#planReviewControl) return;
		await this.#persistArtifact(workflowId, attemptId, "plan-review-control-state", this.#planReviewControl);
	}

	/** True when the hydrated plan review is a trusted arbitration decision for this control. */
	#trustedArbitrationReview(
		control: PlanReviewControlStateV1,
	): Extract<PlanReviewArtifact, { schemaVersion: 2 }> | null {
		const review = this.#planReview;
		if (review?.schemaVersion !== 2 || review.reviewKind !== "arbitration") return null;
		if (review.decision !== "approved" && review.decision !== "blocked") return null;
		// Prefer explicit control pointer when present; otherwise accept the hydrated arbitration review.
		if (
			control.latestReviewArtifactRef &&
			this.#planReviewArtifactRef?.artifactId &&
			control.latestReviewArtifactRef !== this.#planReviewArtifactRef.artifactId
		) {
			return null;
		}
		if (control.arbitrationTrigger && review.triggerReason && review.triggerReason !== control.arbitrationTrigger) {
			return null;
		}
		return review;
	}

	/** Persist successful arbitration: mark the reserved attempt completed (cycle already reserved). */
	async #finishSuccessfulArbitration(
		workflowId: string,
		attemptId: string,
		fromStatus: WorkflowStatus,
		_expectedVersion: number,
		arbitration: PlanReviewStageResult,
	): Promise<void> {
		const artifact = arbitration.artifact;
		this.#planReview = artifact;
		this.#planReviewArtifactRef = await this.#persistArtifact(workflowId, attemptId, "review", artifact);
		if (this.#planReviewControl) {
			this.#planReviewControl = {
				...this.#planReviewControl,
				arbitrationCycles: 1,
				arbitrationAttemptPhase: "completed",
				arbitrationAttemptId: this.#planReviewControl.arbitrationAttemptId ?? `arb_${randomUUID()}`,
				latestReviewArtifactRef: this.#planReviewArtifactRef.artifactId,
				updatedAt: new Date().toISOString(),
			};
		}
		await this.#recordUsageAndProfile(workflowId, attemptId, arbitration.usage, {
			promptAssemblyReceipt: arbitration.promptAssemblyReceipt,
			contextLedger: arbitration.contextLedger,
			optimizationReceipts: arbitration.optimizationReceipts,
			resolvedProvider: arbitration.resolvedProvider,
			resolvedModel: arbitration.resolvedModel,
			toolCalls: arbitration.toolCalls,
			identityReceipt: arbitration.identityReceipt,
			modelFamily: arbitration.modelFamily,
			resolvedToolPolicyId: arbitration.resolvedToolPolicyId,
			completionKind: arbitration.completionKind,
		});
		await this.#persistPlanReviewControl(workflowId, attemptId);
		if (artifact.schemaVersion === 2 && artifact.decision === "approved") {
			const snapshot = this.#requirementsSnapshot;
			if (!snapshot) {
				await this.#setPlanReviewAwaitingHuman(workflowId, attemptId, "requirements_snapshot_missing");
				return;
			}
			const coverageGate = validateApprovedMandatoryCoverage(artifact, snapshot);
			if (!coverageGate.ok) {
				await this.#setPlanReviewAwaitingHuman(
					workflowId,
					attemptId,
					coverageGate.reason ?? "incomplete_mandatory_coverage",
				);
				return;
			}
		}
		const state = await this.#requireState(workflowId);
		await this.#completeTo(
			workflowId,
			attemptId,
			fromStatus,
			artifact.decision === "approved" ? "implementing" : "blocked",
			`plan_review:arbitration_${artifact.decision}`,
			state.version,
		);
	}

	/**
	 * Mark plan review as awaiting human authority and transition top-level to terminal blocked,
	 * while preserving control state (substate awaiting_human + humanRequestReason).
	 */
	async #setPlanReviewAwaitingHuman(workflowId: string, attemptId: string, reason: string): Promise<void> {
		if (!this.#planReviewControl) return;
		this.#planReviewControl = {
			...this.#planReviewControl,
			substate: "awaiting_human",
			humanRequestReason: reason,
			updatedAt: new Date().toISOString(),
		};
		await this.#persistPlanReviewControl(workflowId, attemptId);
		const state = await this.#requireState(workflowId);
		if (!TERMINAL.has(state.status) && isValidTransition(state.status, "blocked")) {
			await this.#completeTo(workflowId, attemptId, state.status, "blocked", reason, state.version);
			return;
		}
		await this.#finishOpenAttempt(workflowId, attemptId, "failed", {
			kind: "plan_review_awaiting_human",
			summary: reason,
		});
	}

	async #applyPlanningCompletenessGate(
		workflowId: string,
		attemptId: string,
		state: WorkflowState,
		request: WorkflowRequest,
	): Promise<boolean> {
		const sidecar = state.overlaySidecar ?? emptyDevflowSidecar();
		if (this.#controller?.signal.aborted) {
			throw new WorkflowCancelledError("aborted before completeness audit");
		}
		const audit = this.#pipelineAuditor
			? await this.#pipelineAuditor({
					kind: "plan",
					request: request.request,
					planSummary: this.#plan?.summary,
					grillAnswers: sidecar.grill.answers,
					signal: this.#controller?.signal,
				})
			: {
					complete: false,
					missing: ["pipeline_auditor_unavailable"],
					next: "Provide a complete executable request.",
				};
		if (audit.complete) return false;
		const retries = sidecar.planningCompletenessRetries + 1;
		const maxRetries = this.#config.pipelineOverlay?.maxPlanningCompletenessRetries ?? 2;
		await this.#finishOpenAttempt(workflowId, attemptId, "completed");
		const after = await this.#requireState(workflowId);
		if (retries < maxRetries) {
			await this.#store.updateOverlaySidecar(
				workflowId,
				{ ...sidecar, planningCompletenessRetries: retries },
				after.version,
			);
			return true;
		}
		await this.#store.updateOverlaySidecar(
			workflowId,
			sidecarWithGrillPause(
				{ ...sidecar, planningCompletenessRetries: retries },
				"incomplete_plan",
				audit.missing,
				audit.next ?? "",
			),
			after.version,
		);
		return true;
	}

	async #runDevflowGate(
		workflowId: string,
		attemptId: string,
		session: ToolSession,
		signal: AbortSignal | undefined,
		subject: "plan" | "implementation",
	): Promise<{ raw: unknown; modelFamily?: string; usage?: Usage }> {
		const role = subject === "plan" ? "plan_reviewer" : "code_reviewer";
		const authorFamily = subject === "plan" ? this.#plannerModelFamily : this.#implementerModelFamily;
		const assignment = gateReviewAdapterPrompt.trim();
		const ran = await this.#withProfileFallback(role, {}, async profile => {
			const builtContext =
				subject === "plan"
					? await this.#buildStageContext(
							this.#contextBuilder.buildPlanReviewContext(this.#plan!, undefined, this.#requirementsSnapshot),
							profile,
							session,
							this.#plan?.affectedFiles.map(file => file.path),
						)
					: await this.#buildStageContext(
							this.#contextBuilder.buildCodeReviewContext({
								plan: this.#plan!,
								implementation: this.#implementation!,
								verification: this.#verification,
							}),
							profile,
							session,
							[
								...(this.#plan?.affectedFiles.map(file => file.path) ?? []),
								...(this.#implementation?.changedFiles ?? []),
							],
						);
			const result = await this.#adapter.run<unknown>({
				workflowId,
				attemptId,
				role,
				profile,
				assignment,
				context: builtContext,
				outputSchema: GateResultJsonSchema,
				session,
				signal,
				pipelineKind: "devflow",
				authorModelFamily: authorFamily,
				agent: RuntimeAdapter.agentNameForRole(role, {
					pipelineKind: "devflow",
					authorModelFamily: authorFamily,
					reviewerModel: profile.modelPattern,
				}),
			});
			await this.#recordUsageAndProfile(workflowId, attemptId, result.usage, {
				identityReceipt: result.identityReceipt,
				modelFamily: result.modelFamily,
				resolvedProvider: result.resolvedProvider,
				resolvedModel: result.resolvedModel,
				toolCalls: result.toolCalls,
				promptAssemblyReceipt: result.promptAssemblyReceipt,
				contextLedger: result.contextLedger,
				optimizationReceipts: result.optimizationReceipts,
				resolvedToolPolicyId: result.resolvedToolPolicyId,
				completionKind: result.completionKind,
			});
			return {
				artifact: result.artifact,
				usage: result.usage,
				modelFamily: result.modelFamily,
			};
		});
		return { raw: ran.artifact, modelFamily: ran.modelFamily, usage: ran.usage };
	}

	async #parseDevflowGateWithRetry(
		workflowId: string,
		attemptId: string,
		session: ToolSession,
		signal: AbortSignal | undefined,
		subject: "plan" | "implementation",
	): Promise<{ gate: GateResultModel; modelFamily?: string } | undefined> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const ran = await this.#runDevflowGate(workflowId, attemptId, session, signal, subject);
				return {
					gate: parseGateResultArtifact(ran.raw, {
						subject,
						workflowId,
						attemptId,
						identity: ran.modelFamily ? { modelFamily: ran.modelFamily } : undefined,
					}),
					modelFamily: ran.modelFamily,
				};
			} catch (error) {
				if (error instanceof WorkflowCancelledError || signal?.aborted || this.#controller?.signal.aborted) {
					throw error instanceof WorkflowCancelledError
						? error
						: new WorkflowCancelledError(error instanceof Error ? error.message : "gate aborted", {
								cause: error,
							});
				}
				lastError = error;
			}
		}
		await this.#finishOpenAttempt(workflowId, attemptId, "failed", {
			kind: "schema_violation",
			summary: redactSecretsInText(lastError instanceof Error ? lastError.message : "gate parse failed").slice(
				0,
				500,
			),
		});
		const after = await this.#requireState(workflowId);
		const sidecar = after.overlaySidecar ?? emptyDevflowSidecar();
		const parseSummary = redactSecretsInText(
			lastError instanceof Error ? lastError.message : String(lastError),
		).slice(0, 500);
		await this.#store.updateOverlaySidecar(
			workflowId,
			sidecarWithGrillPause(sidecar, "gate_parse_failed", [parseSummary]),
			after.version,
		);
		return undefined;
	}

	async #executeDevflowPlanReview(
		workflowId: string,
		attemptId: string,
		_state: WorkflowState,
		session: ToolSession,
		signal: AbortSignal | undefined,
		request: WorkflowRequest,
	): Promise<void> {
		await this.#ensureRequirementsSnapshot(workflowId, attemptId, request);
		const parsed = await this.#parseDevflowGateWithRetry(workflowId, attemptId, session, signal, "plan");
		if (!parsed) return;
		const { gate, modelFamily } = parsed;
		const stamped = stampGateResultArtifact({
			gate,
			workflowId,
			attemptId,
			reviewerIdentity: { modelFamily },
		});
		await this.#persistArtifact(workflowId, attemptId, "gate-result", stamped);
		const intent = gateAdapter(gate.verdict, gate.subject);
		const snapshot = await this.#requireRequirementsSnapshot(workflowId, attemptId, request);
		const fresh = await this.#requireState(workflowId);
		if (intent === "replan_exempt") {
			const sidecar = fresh.overlaySidecar ?? emptyDevflowSidecar();
			await this.#finishOpenAttempt(workflowId, attemptId, "completed");
			const after = await this.#requireState(workflowId);
			await this.#store.updateOverlaySidecar(
				workflowId,
				sidecarWithGrillPause(sidecar, "needs_redesign"),
				after.version,
			);
			return;
		}
		if (intent === "approve" || intent === "replan_counted" || intent === "block") {
			const derived = derivePlanReviewArtifactV2({
				gate,
				workflowId,
				attemptId,
				stage: "plan_review",
				control: this.#planReviewControl,
				requirementsSnapshot: snapshot,
				requirementsSnapshotRef: this.#requirementsSnapshotRef?.recoveryUri,
			});
			this.#planReview = derived;
			this.#planReviewArtifactRef = await this.#persistArtifact(workflowId, attemptId, "review", derived);
			if (intent === "replan_counted") {
				const prior = this.#planReviewControl?.planRejectionCount ?? this.#planCycles;
				const nextRejectionCount = prior + 1;
				this.#planCycles = nextRejectionCount;
				this.#planReviewControl = {
					schemaVersion: 1,
					kind: "plan_review_control_state",
					substate: "awaiting_replan",
					reviewRound: 2,
					planRejectionCount: nextRejectionCount,
					arbitrationCycles: this.#planReviewControl?.arbitrationCycles ?? 0,
					arbitrationTrigger: null,
					arbitrationAttemptId: this.#planReviewControl?.arbitrationAttemptId ?? null,
					arbitrationAttemptPhase: this.#planReviewControl?.arbitrationAttemptPhase ?? null,
					reviewSchemaCohort: "v2",
					latestPlanArtifactRef: this.#planArtifactRef?.artifactId ?? null,
					latestReviewArtifactRef: this.#planReviewArtifactRef.artifactId,
					authorResponsesArtifactRef: this.#authorResponsesArtifactRef?.artifactId ?? null,
					routeSelectionReceiptRef: this.#planReviewControl?.routeSelectionReceiptRef ?? null,
					humanRequestReason: null,
					updatedAt: new Date().toISOString(),
				};
				await this.#persistPlanReviewControl(workflowId, attemptId);
				if (nextRejectionCount >= this.#config.maxPlanCycles) {
					await this.#setPlanReviewAwaitingHuman(workflowId, attemptId, "max_plan_cycles_exceeded");
					return;
				}
				await this.#completeTo(
					workflowId,
					attemptId,
					fresh.status,
					"planning",
					"plan_review:changes_requested",
					fresh.version,
				);
				return;
			}
			if (intent === "block") {
				await this.#completeTo(
					workflowId,
					attemptId,
					fresh.status,
					"blocked",
					"plan_review:blocked",
					fresh.version,
				);
				return;
			}
			await this.#completeTo(
				workflowId,
				attemptId,
				fresh.status,
				"implementing",
				"plan_review:approved",
				fresh.version,
			);
		}
	}

	async #executeDevflowCodeReview(
		workflowId: string,
		attemptId: string,
		_state: WorkflowState,
		session: ToolSession,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const parsed = await this.#parseDevflowGateWithRetry(workflowId, attemptId, session, signal, "implementation");
		if (!parsed) return;
		const { gate, modelFamily } = parsed;
		const stamped = stampGateResultArtifact({
			gate,
			workflowId,
			attemptId,
			reviewerIdentity: { modelFamily },
		});
		await this.#persistArtifact(workflowId, attemptId, "gate-result", stamped);
		const intent = gateAdapter(gate.verdict, gate.subject);
		const fresh = await this.#requireState(workflowId);
		if (intent === "approve" || intent === "replan_counted" || intent === "block") {
			const derived = deriveReviewArtifact({
				gate,
				workflowId,
				attemptId,
				stage: "code_review",
			});
			this.#codeReview = derived;
			this.#codeReviewArtifactRef = await this.#persistArtifact(workflowId, attemptId, "review", derived);
			const decision = derived.decision;
			const next = getNextStage("code_review", decision);
			if (!next) throw new WorkflowPolicyError("invalid_review_decision", { decision });
			await this.#completeTo(workflowId, attemptId, fresh.status, next, `code_review:${decision}`, fresh.version);
		}
	}

	async #completeTo(
		workflowId: string,
		attemptId: string,
		from: WorkflowStatus,
		to: WorkflowStatus,
		reason: string,
		_expectedVersion: number,
	): Promise<void> {
		if (!isValidTransition(from, to)) {
			throw new WorkflowPolicyError("invalid_transition", { from, to });
		}
		// beginAttempt already bumped version once — re-read for optimistic check
		const state = await this.#requireState(workflowId);
		await this.#store.completeAttemptAndTransition({
			workflowId,
			attemptId,
			attemptStatus: "completed",
			fromStatus: from,
			toStatus: to,
			reason,
			expectedVersion: state.version,
			budget: this.#ledgerBudgetSnapshot(),
		});
	}

	/**
	 * Only run verification commands that are in the trusted config list.
	 * Model-proposed plan.verificationCommands may only *narrow* to a subset of trusted commands.
	 */
	#trustedVerificationCommands(planCommands?: string[]): string[] {
		const trusted = this.#config.verificationCommands;
		if (!planCommands?.length) return [...trusted];
		const trustedSet = new Set(trusted);
		const narrowed = planCommands.filter(cmd => trustedSet.has(cmd));
		return narrowed.length > 0 ? narrowed : [...trusted];
	}

	/**
	 * Persist artifact to disk + sqlite. Returns a durable handoff ref (id + bytes + recovery URI).
	 * Source artifacts are never deleted by handoff construction.
	 */
	async #persistArtifact(
		workflowId: string,
		attemptId: string,
		kind: string,
		artifact: object,
	): Promise<StageHandoffArtifactRef> {
		// Secret-safe: never persist raw secret-like values in durable artifacts.
		const content = redactSecretsInText(JSON.stringify(artifact));
		const schemaVersion =
			typeof (artifact as { schemaVersion?: unknown }).schemaVersion === "number"
				? (artifact as { schemaVersion: number }).schemaVersion
				: 1;
		const stored = await this.#artifactStore.store({
			workflowId,
			attemptId,
			kind,
			schemaVersion,
			relativePath: "",
			content,
		});
		await this.#store.addArtifact({
			workflowId,
			attemptId,
			kind,
			schemaVersion,
			relativePath: stored.relativePath,
			sha256: stored.sha256,
			content,
		});
		if (kind === "plan") this.#planArtifactSha256 = stored.sha256;
		return this.#toHandoffRef(stored);
	}

	#toHandoffRef(stored: Artifact): StageHandoffArtifactRef {
		const content = stored.content ?? "";
		return {
			artifactId: stored.id,
			bytes: Buffer.byteLength(content, "utf-8"),
			recoveryUri: `artifact://${stored.relativePath}`,
		};
	}

	/** Build a durable handoff ref from sqlite meta + loaded content (resume path). */
	#refFromMeta(meta: { id: string; relativePath: string }, content: string): StageHandoffArtifactRef {
		// Prefer filesystem id encoded in relativePath so it matches ArtifactStore.store ids.
		const fromPath = path.basename(meta.relativePath, path.extname(meta.relativePath));
		return {
			artifactId: fromPath || meta.id,
			bytes: Buffer.byteLength(content, "utf-8"),
			recoveryUri: `artifact://${meta.relativePath}`,
		};
	}

	/**
	 * Persist real patch bytes as a durable artifact for implement→review handoff sizing/recovery.
	 * Reuses #patchArtifactRef when already hydrated or stored in this process.
	 */
	async #ensurePatchArtifactRef(
		workflowId: string,
		attemptId: string,
		patchPath: string | undefined,
		cwd: string,
	): Promise<StageHandoffArtifactRef | undefined> {
		if (this.#patchArtifactRef) return this.#patchArtifactRef;
		if (!patchPath) return undefined;
		const abs = path.isAbsolute(patchPath) ? patchPath : path.join(cwd, patchPath);
		try {
			const content = await Bun.file(abs).text();
			const stored = await this.#artifactStore.store({
				workflowId,
				attemptId,
				kind: "patch",
				schemaVersion: 1,
				relativePath: "",
				content,
			});
			await this.#store.addArtifact({
				workflowId,
				attemptId,
				kind: "patch",
				schemaVersion: 1,
				relativePath: stored.relativePath,
				sha256: stored.sha256,
				content,
			});
			this.#patchArtifactRef = this.#toHandoffRef(stored);
			return this.#patchArtifactRef;
		} catch {
			// Patch unreadable — leave undefined so builder can fall back to path-only metadata.
			return undefined;
		}
	}

	/**
	 * Build + persist stage handoff on success-path stage entry only.
	 * Construction failure degrades to keep-all (full source refs) and never blocks the workflow.
	 */
	async #buildAndPersistHandoff(
		workflowId: string,
		attemptId: string,
		fromStage: WorkflowStatus,
		toStage: WorkflowStatus,
		build: () => StageHandoffV1,
		sourceRefs: Array<StageHandoffArtifactRef | undefined>,
	): Promise<StageHandoffV1 | undefined> {
		const sources = sourceRefs.filter((r): r is StageHandoffArtifactRef => Boolean(r));
		try {
			const handoff = build();
			await this.#persistArtifact(workflowId, attemptId, "stage-handoff", handoff);
			return handoff;
		} catch {
			// Keep-all degrade: do not block workflow; inject recoverable full-source handoff when possible.
			if (sources.length === 0) return undefined;
			try {
				const keepAll = buildKeepAllHandoff({ fromStage, toStage, sources });
				await this.#persistArtifact(workflowId, attemptId, "stage-handoff", keepAll);
				return keepAll;
			} catch {
				return undefined;
			}
		}
	}

	async #persistFindingsState(workflowId: string, attemptId: string): Promise<void> {
		const findings = this.#findingTracker.getAll().map(f => ({
			...f,
			// include fingerprint cycle for resume
			fingerprint: FindingTracker.fingerprint(f),
			repairCycles: this.#findingTracker.cycleCount(FindingTracker.fingerprint(f)),
		}));
		await this.#persistArtifact(workflowId, attemptId, "findings-state", {
			kind: "findings-state",
			schemaVersion: 1,
			workflowId,
			attemptId,
			findings,
		});
	}

	async #hydrateArtifacts(snapshot: PersistedWorkflowSnapshot): Promise<void> {
		let latestFindingsState:
			| {
					findings?: Array<
						ReviewFindingV1 & { repairCycles?: number; blocking?: boolean; status?: string; id?: string }
					>;
			  }
			| undefined;
		// Sort so findings-state applies after review findings are loaded
		const artifacts = [...snapshot.artifacts].sort((a, b) => {
			if (a.kind === "findings-state") return 1;
			if (b.kind === "findings-state") return -1;
			return 0;
		});
		for (const meta of artifacts) {
			const loaded = await this.#artifactStore.load(meta.relativePath, meta.sha256);
			if (!loaded?.content) continue;
			// Raw patch body (not JSON) — restore handoff sizing/recovery ref for implement→review.
			if (meta.kind === "patch") {
				this.#patchArtifactRef = this.#refFromMeta(meta, loaded.content);
				continue;
			}
			try {
				const parsed = JSON.parse(loaded.content) as {
					kind?: string;
					findings?: ReviewFindingV1[];
					revision?: number;
					profileId?: string | null;
					modelFamily?: string | null;
				};
				const ref = this.#refFromMeta(meta, loaded.content);
				if (meta.kind === "quality-route-snapshot") {
					const verifiedArtifact = verifyQualityRouteSnapshot(parsed);
					if (
						!this.#qualityRouteSnapshot ||
						verifiedArtifact.fingerprint !== this.#qualityRouteSnapshot.fingerprint
					) {
						throw new WorkflowPolicyError("quality_route_artifact_mismatch", {
							policyFingerprint: this.#qualityRouteSnapshot?.fingerprint ?? null,
							artifactFingerprint: verifiedArtifact.fingerprint,
						});
					}
					this.#qualityRouteArtifactPersisted = true;
					continue;
				}
				if (meta.kind === "plan-review-control-state" || parsed.kind === "plan_review_control_state") {
					const control = PlanReviewControlStateSchema.parse(parsed) as PlanReviewControlStateV1;
					if (!this.#planReviewControl || control.updatedAt >= this.#planReviewControl.updatedAt) {
						this.#planReviewControl = control;
						// Durable cohort is authoritative; do not re-infer from later review artifacts alone.
					}
					continue;
				}
				if (meta.kind === REQUIREMENTS_SNAPSHOT_KIND || parsed.kind === REQUIREMENTS_SNAPSHOT_KIND) {
					if (!isRequirementsSnapshot(parsed)) {
						throw new WorkflowPolicyError("requirements_snapshot_invalid", {
							relativePath: meta.relativePath,
						});
					}
					// First/oldest snapshot wins — never replace a frozen authority with a later rewrite.
					if (!this.#requirementsSnapshot) {
						this.#requirementsSnapshot = parsed;
						this.#requirementsSnapshotRef = ref;
					}
					continue;
				}
				if (meta.kind === AUTHOR_RESPONSES_KIND || parsed.kind === AUTHOR_RESPONSES_KIND) {
					if (!isAuthorResponsesArtifact(parsed)) {
						throw new WorkflowPolicyError("author_responses_invalid", {
							relativePath: meta.relativePath,
						});
					}
					// Latest author-responses artifact wins (replan may rewrite dispositions).
					this.#authorResponses = parsed.responses;
					this.#authorResponsesPriorFindings = parsed.priorFindings.map(finding => ({
						id: finding.id,
						priority: finding.priority,
					}));
					this.#authorResponsesArtifactRef = ref;
					continue;
				}
				if (parsed.kind === "plan") {
					this.#plan = parsed as PlanArtifactV1;
					this.#planArtifactRef = ref;
					this.#planArtifactSha256 = meta.sha256;
					// Restore planner route context for plan_review diversity across Engine resume.
					if (this.#plan.modelProfileId) this.#plannerProfileId = this.#plan.modelProfileId;
					if (this.#plan.modelProfileId) {
						this.#plannerVendor = this.#router.list().find(p => p.id === this.#plan?.modelProfileId)?.vendor;
					}
				} else if (meta.kind === "plan-review-route-selection" || parsed.kind === "plan_review_route_selection") {
					const selection = parsed as Partial<PlanReviewRouteSelectionV1>;
					const profileId =
						typeof selection.profileId === "string" && selection.profileId.trim().length > 0
							? selection.profileId
							: null;
					const attestedProvider =
						typeof selection.attestedProvider === "string" && selection.attestedProvider.trim().length > 0
							? selection.attestedProvider
							: typeof selection.provider === "string" && selection.provider.trim().length > 0
								? selection.provider
								: null;
					const attestedModel =
						typeof selection.attestedModel === "string" && selection.attestedModel.trim().length > 0
							? selection.attestedModel
							: typeof selection.model === "string" && selection.model.trim().length > 0
								? selection.model
								: null;
					// Resume pin only from an engine-owned attested route selection receipt.
					if (profileId && attestedProvider && attestedModel) {
						this.#planReviewerIdentity = {
							profileId,
							provider: attestedProvider,
							model: attestedModel,
							modelFamily:
								typeof selection.modelFamily === "string" && selection.modelFamily.trim().length > 0
									? selection.modelFamily
									: undefined,
							// Persisted selection is engine-owned after a live attested pin.
							attestedProvenance: "provider_echo",
							exactMatch:
								typeof selection.exactMatch === "boolean" || selection.exactMatch === null
									? selection.exactMatch
									: null,
						};
						this.#planReviewerRouteSelectionRef = ref;
					}
				} else if (parsed.kind === "review") {
					const review = parsed as PlanReviewArtifact;
					if (review.subject === "plan") {
						this.#planReview = review;
						this.#planReviewArtifactRef = ref;
						// Do not pin from review.provider/model — those can be config/local fallbacks.
					} else {
						this.#codeReview = review;
						this.#codeReviewArtifactRef = ref;
					}
					for (const f of review.findings ?? []) {
						const blocking =
							review.subject === "implementation"
								? typeof f.blocking === "boolean"
									? f.blocking
									: FindingTracker.computeBlockingDisposition(f, review, this.#config.confidenceThreshold)
								: (f.blocking ?? false);
						this.#findingTracker.add(f, { blocking });
					}
				} else if (parsed.kind === "findings-state") {
					// Defer until after the scan: each findings-state is a full cumulative snapshot.
					// Replaying every historical snapshot would double-count repairCycles.
					latestFindingsState = parsed;
				} else if (meta.kind === "scope-metrics") {
					this.#lastScopeMetrics = parsed as unknown as ScopeMetricsV1;
				} else if (parsed.kind === "work-package-state") {
					const workPackageState = parsed as WorkPackageStateArtifactV1;
					if (!this.#workPackageState || workPackageState.revision > this.#workPackageState.revision) {
						this.#workPackageState = workPackageState;
					}
				} else if (parsed.kind === "implementation") {
					this.#implementation = parsed as ImplementationArtifactV1;
					this.#implementationArtifactRef = ref;
					this.#implementerVendor = this.#router
						.list()
						.find(p => p.id === this.#implementation?.modelProfileId)?.vendor;
				} else if (parsed.kind === "runtime-evidence" && parsed.profileId) {
					const profile = this.#router.list().find(candidate => candidate.id === parsed.profileId);
					if (profile?.roles.includes("planner") && parsed.modelFamily) {
						this.#plannerModelFamily = parsed.modelFamily;
					}
					if (profile?.roles.includes("implementer") && parsed.modelFamily) {
						this.#implementerModelFamily = parsed.modelFamily;
					}
				} else if (parsed.kind === "verification") {
					const v = parsed as VerificationArtifactV1;
					if (v.stage === "final_verify") this.#finalVerification = v;
					else {
						this.#verification = v;
						this.#verificationArtifactRef = ref;
					}
				}
			} catch (error) {
				if (meta.kind === "quality-route-snapshot") {
					if (error instanceof WorkflowPolicyError) throw error;
					throw new WorkflowPolicyError("quality_route_artifact_invalid", {
						reason: error instanceof Error ? error.message : String(error),
					});
				}
				// Other corrupt artifact bodies remain non-authoritative and are ignored.
			}
		}
		if (latestFindingsState) {
			// Reset then assign from the newest cumulative snapshot only.
			this.#findingTracker = new FindingTracker();
			for (const f of latestFindingsState.findings ?? []) {
				this.#findingTracker.add(f as ReviewFindingV1, {
					blocking: Boolean((f as { blocking?: boolean }).blocking),
				});
				const status = (f as { status?: string }).status;
				if (status === "resolved" || status === "rejected") {
					this.#findingTracker.resolve((f as { id: string }).id, status);
				}
				const cycles = (f as { repairCycles?: number }).repairCycles ?? 0;
				const fp = FindingTracker.fingerprint(f as ReviewFindingV1);
				for (let i = 0; i < cycles; i++) this.#findingTracker.recordRepairCycle(fp);
			}
		}
	}

	#audit(route: RoutingDecision): void {
		this.#lastRouteProfileId = route.profileId;
		this.#routingAudit.push({ ...route, at: new Date().toISOString() });
	}

	async #persistRoutingAudit(workflowId: string, attemptId: string): Promise<void> {
		if (this.#routingAudit.length === 0) return;
		await this.#persistArtifact(workflowId, attemptId, "routing-audit", {
			kind: "routing-audit",
			schemaVersion: 1,
			workflowId,
			attemptId,
			entries: this.#routingAudit,
		});
	}

	async #persistAbortCompletionKind(workflowId: string, error: unknown): Promise<void> {
		const completionKind = completionKindFromError(error);
		if (!completionKind || completionKind === "completed") return;
		const state = await this.#requireState(workflowId);
		if (!state.currentAttemptId) return;
		await this.#persistArtifact(workflowId, state.currentAttemptId, "runtime-evidence", {
			kind: "runtime-evidence",
			schemaVersion: 1,
			workflowId,
			attemptId: state.currentAttemptId,
			profileId: this.#lastRouteProfileId ?? null,
			completionKind,
		});
	}
	async #recordUsageAndProfile(
		workflowId: string,
		attemptId: string,
		usage: unknown,
		evidence?: WorkflowRuntimeEvidence,
	): Promise<void> {
		const profileId = this.#lastRouteProfileId;
		const profile = profileId ? this.#router.list().find(p => p.id === profileId) : undefined;
		this.#budgetLedger.recordRequest(usage as never, profileId);
		if (evidence?.toolCalls && evidence.toolCalls > 0) {
			this.#budgetLedger.recordToolCalls(evidence.toolCalls);
		}
		if (profileId) {
			await this.#store.setAttemptProfile(workflowId, attemptId, profileId);
		}
		// Durable per-attempt usage for Stabilize & Measure baselines (design Phase A2).
		await this.#persistArtifact(workflowId, attemptId, "usage", {
			kind: "usage",
			schemaVersion: 1,
			workflowId,
			attemptId,
			profileId: profileId ?? null,
			usage: usage ?? null,
			toolCalls: evidence?.toolCalls ?? null,
			resolvedProvider: evidence?.resolvedProvider ?? null,
			resolvedModel: evidence?.resolvedModel ?? null,
			qualityTier: this.#qualityRouteSnapshot?.qualityTier ?? null,
			routeSnapshotFingerprint: this.#qualityRouteSnapshot?.fingerprint ?? null,
			configuredIdentity: evidence?.identityReceipt?.configured ?? null,
			localResolution:
				evidence?.identityReceipt?.localResolution ??
				(evidence?.resolvedProvider || evidence?.resolvedModel
					? {
							provider: evidence.resolvedProvider ?? null,
							model: evidence.resolvedModel ?? null,
							checkpoint: null,
							provenance: "local_resolution",
						}
					: null),
			attestedIdentity: evidence?.identityReceipt?.attested ?? null,
			exactIdentityMatch: evidence?.identityReceipt?.exactMatch ?? null,
			effortSupported: evidence?.identityReceipt?.effortSupported ?? null,
			modelFamily: evidence?.modelFamily ?? evidence?.identityReceipt?.modelFamily ?? null,
			scopeMetricsKind: evidence?.scopeMetricsKind ?? null,
			promptAssemblyReceipt: evidence?.promptAssemblyReceipt ?? null,
			contextLedger: evidence?.contextLedger ?? null,
			optimizationReceiptCount: Array.isArray(evidence?.optimizationReceipts)
				? evidence.optimizationReceipts.length
				: 0,
			strategies: profile
				? {
						promptTemplate: profile.promptStrategy?.systemPromptTemplate ?? null,
						instructionFormat: profile.promptStrategy?.instructionFormat ?? null,
						toolTruncation: profile.toolStrategy?.outputTruncation?.enabled ?? false,
						resultSummarization: profile.toolStrategy?.resultSummarization?.enabled ?? false,
						repoMap: profile.contextStrategy?.repoMap?.enabled ?? false,
						eviction: profile.contextStrategy?.eviction?.enabled ?? false,
						schemaRetry: profile.outputStrategy?.retryOnSchemaViolation?.enabled ?? false,
						toolPolicyId: profile.toolPolicyId ?? null,
						resolvedToolPolicyId: evidence?.resolvedToolPolicyId ?? null,
					}
				: null,
		});
		if (evidence?.promptAssemblyReceipt) {
			await this.#persistArtifact(workflowId, attemptId, "prompt-assembly-receipt", evidence.promptAssemblyReceipt);
		}
		if (evidence?.contextLedger) {
			await this.#persistArtifact(workflowId, attemptId, "context-ledger", evidence.contextLedger);
		}
		if (evidence?.optimizationReceipts && evidence.optimizationReceipts.length > 0) {
			await this.#persistArtifact(workflowId, attemptId, "tool-optimization-receipts", {
				kind: "tool_optimization_receipts",
				schemaVersion: 1,
				workflowId,
				attemptId,
				receipts: evidence.optimizationReceipts,
			});
		}
		if (
			evidence?.identityReceipt ||
			evidence?.resolvedProvider ||
			evidence?.resolvedModel ||
			evidence?.completionKind
		) {
			await this.#persistArtifact(workflowId, attemptId, "runtime-evidence", {
				kind: "runtime-evidence",
				schemaVersion: 1,
				workflowId,
				attemptId,
				profileId,
				qualityTier: this.#qualityRouteSnapshot?.qualityTier ?? null,
				routeSnapshotFingerprint: this.#qualityRouteSnapshot?.fingerprint ?? null,
				configuredIdentity: evidence?.identityReceipt?.configured ?? null,
				localResolution: evidence?.identityReceipt?.localResolution ?? {
					provider: evidence?.resolvedProvider ?? null,
					model: evidence?.resolvedModel ?? null,
					checkpoint: null,
					provenance: "local_resolution",
				},
				attestedIdentity: evidence?.identityReceipt?.attested ?? {
					provider: null,
					model: null,
					checkpoint: null,
					provenance: "unknown",
				},
				exactIdentityMatch: evidence?.identityReceipt?.exactMatch ?? null,
				effortSupported: evidence?.identityReceipt?.effortSupported ?? null,
				modelFamily: evidence?.modelFamily ?? evidence?.identityReceipt?.modelFamily ?? null,
				toolCalls: evidence?.toolCalls ?? null,
				toolPolicyId: profile?.toolPolicyId ?? null,
				resolvedToolPolicyId: evidence?.resolvedToolPolicyId ?? null,
				scopeMetricsKind: evidence?.scopeMetricsKind ?? null,
				completionKind: evidence?.completionKind ?? null,
			});
		}
		await this.#persistRoutingAudit(workflowId, attemptId);
	}

	#parsePolicy(policyJson: string): Record<string, unknown> {
		try {
			const parsed = JSON.parse(policyJson);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("policy must be a JSON object");
			}
			return parsed as Record<string, unknown>;
		} catch (error) {
			throw new WorkflowPolicyError("quality_route_policy_invalid", {
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#parseRequest(requestJson: string): WorkflowRequest {
		try {
			const raw = JSON.parse(requestJson) as Record<string, unknown>;
			if (typeof raw.request === "string") {
				return {
					request: raw.request,
					constraints: typeof raw.constraints === "string" ? raw.constraints : undefined,
					qualityTier:
						raw.qualityTier === "balanced" || raw.qualityTier === "critical" ? raw.qualityTier : undefined,
				};
			}
			return { request: JSON.stringify(raw) };
		} catch {
			return { request: requestJson };
		}
	}

	async #requireState(workflowId: string): Promise<WorkflowState> {
		const state = await this.#store.getCurrentState(workflowId);
		if (!state) throw new WorkflowPolicyError("workflow_not_found", { workflowId });
		return state;
	}

	/** @deprecated Prefer resume(); kept for foundation test compatibility. */
	async recoverFromPersistedState(workflowId: string): Promise<PersistedWorkflowSnapshot | null> {
		return this.#store.resumeFromPersistedState(workflowId);
	}

	async budgetCheckPreStage(): Promise<boolean> {
		return this.#budgetLedger.checkPreStage();
	}

	/** Expose ledger snapshot for tests / diagnostics. */
	budgetSnapshot(): BudgetSnapshot {
		return this.#budgetLedger.snapshot();
	}

	resolveFinding(findingId: string, status: "resolved" | "rejected" = "resolved"): void {
		this.#findingTracker.resolve(findingId, status);
	}

	get routingAudit(): ReadonlyArray<Record<string, unknown>> {
		return this.#routingAudit;
	}
}
