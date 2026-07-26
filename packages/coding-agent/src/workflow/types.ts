import type { Usage } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { ToolSession } from "../tools";
import type { PromptAssemblyReceiptV1 } from "./prompt-assembly";

/** Re-export for consumers that import receipt types from workflow/types. */
export type { PromptAssemblyReceiptV1 } from "./prompt-assembly";

/** Isolation controls for write stages (mirrors task isolation without importing task). */
export interface WorkflowIsolationControls {
	requested?: boolean;
	merge?: "patch" | "branch";
	apply?: boolean;
}

export type WorkflowStatus =
	| "created"
	| "planning"
	| "plan_review"
	| "implementing"
	| "implementation_verify"
	| "code_review"
	| "repairing"
	| "final_verify"
	| "completed"
	| "blocked"
	| "cancelled"
	| "failed";

export interface ArtifactHeader {
	schemaVersion: 1;
	workflowId: string;
	attemptId: string;
	stage: WorkflowStatus;
	createdAt: string;
	modelProfileId?: string;
	provider?: string;
	model?: string;
	promptVersion?: string;
}

export interface PlanArtifactV1 extends ArtifactHeader {
	kind: "plan";
	summary: string;
	assumptions: string[];
	nonGoals: string[];
	affectedFiles: Array<{
		path: string;
		action: "create" | "modify" | "delete";
		reason: string;
	}>;
	implementationSteps: Array<{
		id: string;
		description: string;
		dependsOn: string[];
	}>;
	acceptanceCriteria: string[];
	verificationCommands: string[];
	risks: string[];
	rollback: string[];
}

export interface ReviewFindingV1 {
	id: string;
	priority: "P0" | "P1" | "P2" | "P3";
	category:
		| "correctness"
		| "architecture"
		| "security"
		| "concurrency"
		| "compatibility"
		| "testing"
		| "maintainability";
	status: "open" | "in_progress" | "resolved" | "rejected";
	confidence: number;
	summary: string;
	explanation: string;
	file?: string;
	line?: number;
	suggestedOwner: "implementer" | "reasoning_repair" | "human";
	/** Engine-owned disposition captured from the accepted review decision. */
	blocking?: boolean;
	/** Engine-owned evidence for resolved/rejected transitions. */
	resolutionEvidence?: string[];
}

export interface ReviewArtifactV1 extends ArtifactHeader {
	kind: "review";
	subject: "plan" | "implementation";
	decision: "approved" | "changes_requested" | "blocked";
	findings: ReviewFindingV1[];
	explanation: string;
	confidence: number;
}

export interface ImplementationArtifactV1 extends ArtifactHeader {
	kind: "implementation";
	summary: string;
	changedFiles: string[];
	addressedStepIds: string[];
	commandsRun: Array<{
		command: string;
		exitCode: number;
		summary: string;
	}>;
	patchPath?: string;
	branchName?: string;
	unresolved: string[];
}

export interface VerificationArtifactV1 extends ArtifactHeader {
	kind: "verification";
	passed: boolean;
	checks: Array<{
		id: string;
		command?: string;
		status: "passed" | "failed" | "skipped";
		exitCode?: number;
		summary: string;
		logPath?: string;
	}>;
}

/** Kind of a preserved stage-handoff item (deterministic extract, not model summary). */
export type StageHandoffItemKind = "plan" | "finding" | "patch" | "verification";

/** One retained fragment at a stage boundary. */
export interface StageHandoffPreservedItem {
	kind: StageHandoffItemKind;
	artifactId: string;
	/** Compact deterministic summary; ≤500 characters. */
	summary: string;
	/** UTF-8 byte length of `summary`. */
	bytes: number;
	/**
	 * When true, item must not be dropped under budget pressure
	 * (blocking findings, patch refs, failed verification, etc.).
	 */
	blocking: boolean;
}

/**
 * Deterministic stage-boundary role-aware handoff (P1).
 * Built only on successful stage completion; sources are never deleted.
 */
export interface StageHandoffV1 {
	schemaVersion: 1;
	kind: "stage_handoff";
	fromStage: WorkflowStatus;
	toStage: WorkflowStatus;
	preservedItems: StageHandoffPreservedItem[];
	/** Source artifact ids whose full bodies were not inlined (still recoverable). */
	omittedArtifactIds: string[];
	/** Recovery URIs for full source content (typically artifact://relativePath). */
	recoveryUris: string[];
	/** Total UTF-8 bytes of candidate source artifacts before extract. */
	bytesBeforeHandoff: number;
	/** Total UTF-8 bytes of preserved item summaries after extract. */
	bytesAfterHandoff: number;
	/** sha256 of canonical payload (stable key order; excludes timestamps). */
	contentFingerprint: string;
}

/** Durable source ref used when sizing handoff bytes / recovery. */
export interface StageHandoffArtifactRef {
	artifactId: string;
	/** UTF-8 byte length of full stored content. */
	bytes: number;
	/** Loadable recovery URI (e.g. artifact://workflowId/art_….json). */
	recoveryUri: string;
}

export type WorkflowRole = "planner" | "plan_reviewer" | "implementer" | "code_reviewer" | "repair";

/** Per-model system prompt style and instruction shaping. */
export interface PromptStrategy {
	kind: "verbose" | "concise" | "structured" | "custom";
	/** Template id: default | concise-claude | structured-gpt | explicit-grok */
	systemPromptTemplate?: string;
	/** Reserved: static example bank not shipped; applyPromptStrategy ignores for now. */
	fewShotPolicy?: {
		enabled: boolean;
		maxExamples: number;
		dynamicSelection: boolean;
	};
	thinkingPrompt?: {
		enabled: boolean;
		style: "step-by-step" | "scratchpad" | "none";
	};
	roleEmphasis?: "light" | "medium" | "heavy";
	instructionFormat?: "natural" | "numbered" | "xml-tagged";
}

export type TruncationStrategy = "head" | "tail" | "smart" | "none";

export interface ToolOutputTruncationRule {
	toolName: string | string[];
	strategy: TruncationStrategy;
	maxBytes?: number;
	maxLines?: number;
	preservePatterns?: string[];
}

export interface ToolStrategy {
	toolAliases?: Record<string, string>;
	argumentAliases?: Record<string, Record<string, string>>;
	outputTruncation?: {
		enabled: boolean;
		rules: ToolOutputTruncationRule[];
	};
	resultSummarization?: {
		enabled: boolean;
		/** Built-in summarizer keys: bash, read, grep, test, ls — or "*" default. */
		summarizerKeys?: string[];
	};
	/**
	 * Cap concurrent shared tools in a single agent-loop batch.
	 * Wired via Agent.toolScheduling.maxConcurrentTools when session installs the policy.
	 */
	maxConcurrentTools?: number;
	/**
	 * Hard remaining tool-call budget for this stage (mutable across batches).
	 * null/undefined = unlimited. Not derived from toolHistory.maxToolCalls.
	 */
	remainingToolCalls?: number | null;
	/** Remaining stage wall time in ms; ≤0 skips remaining tools. null = unknown. */
	remainingStageTimeMs?: number | null;
	/**
	 * Resource conflict mode for concurrent tools:
	 * - serialize/conservative: same-path writes and mutating bash serialize
	 * - fail: later conflicting tool is skipped with error
	 * - permissive: only explicit exclusive / same-path write pairs conflict
	 */
	resourceConflictMode?: "serialize" | "fail" | "conservative" | "permissive";
}

export interface ContextStrategy {
	targetUtilization: number;
	repoMap?: {
		enabled: boolean;
		maxFiles: number;
		strategy: "full-content" | "symbols-only" | "hybrid";
	};
	eviction?: {
		enabled: boolean;
		preserveUserTurns: boolean;
		evictPersisted: boolean;
		keepRecentN: number;
	};
	artifactInclusion?: {
		includePlan: boolean;
		includeReviewFindings: boolean;
		includeVerification: boolean;
		maxArtifactBytes: number;
	};
	toolHistory?: {
		maxToolCalls: number;
		summarizeOld: boolean;
	};
}

export interface OutputStrategy {
	schemaEnhancement?: {
		addDescriptions: boolean;
		addExamples: boolean;
		strictMode: boolean;
	};
	outputPrefixPrompt?: string;
	retryOnSchemaViolation?: {
		enabled: boolean;
		maxRetries: number;
		includeErrorInRetry: boolean;
	};
}

/**
 * Workflow model profile: role/budget/schema binding plus optional model optimization.
 * Shared model-level strategies may also be referenced via optimizationProfileId.
 */
export interface WorkflowModelProfile {
	id: string;
	vendor: "anthropic" | "openai" | "xai" | string;
	modelPattern: string | string[];
	roles: WorkflowRole[];
	/**
	 * Optional reference to a shared ModelOptimizationProfile id.
	 * When set with inline strategy fields, inline fields override the referenced profile
	 * for workflow-local use (normalizer materializes the merge).
	 */
	optimizationProfileId?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	promptTemplate: string;
	promptVersion: string;
	toolPolicyId: string;
	toolAliases?: Record<string, string>;
	argumentAliases?: Record<string, Record<string, string>>;
	/** Per-model prompt shaping (style template, few-shot, role emphasis). */
	promptStrategy?: PromptStrategy;
	/** Per-model tool output truncation, summarization, and concurrency. */
	toolStrategy?: ToolStrategy;
	/** Per-model context window utilization, eviction, and repo-map. */
	contextStrategy?: ContextStrategy;
	/** Per-model structured-output schema enhancement and retry. */
	outputStrategy?: OutputStrategy;
	/**
	 * Gated tool/skill presentation. Default (missing) is direct mode with feature off.
	 * When enabled + catalog, non-essential tools get xd://tools/{name} locators without full schema.
	 * Also gated by settings `workflow.presentationOptimization.enabled` (default false).
	 */
	presentationPolicy?: {
		enabled?: boolean;
		mode?: "direct" | "catalog";
		essentialTools?: string[];
		skillCatalogOnly?: boolean;
		/** Skill names whose full body is injected immediately when catalog mode is on. */
		autoloadSkills?: string[];
	};
	disabledTools?: string[];
	maxRequests: number;
	maxRuntimeMs: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxCostUsd?: number;
	retryPolicy: {
		maxAttempts: number;
		retryableErrorKinds: string[];
		fallbackProfileIds: string[];
	};
	contextPolicy: {
		includePlan: boolean;
		includeReviewFindings: boolean;
		includeVerification: boolean;
		includeFullTranscript: boolean;
		maxArtifactBytes: number;
	};
}

/**
 * @deprecated Use {@link WorkflowModelProfile}. Alias retained for one release cycle.
 */
export type ModelProfile = WorkflowModelProfile;

export interface WorkflowAgentRequest {
	workflowId: string;
	attemptId: string;
	role: WorkflowRole;
	profile: ModelProfile;
	assignment: string;
	context?: string;
	outputSchema?: unknown;
	isolation?: WorkflowIsolationControls;
	session: ToolSession;
	signal?: AbortSignal;
}

export interface WorkflowAgentResult<TArtifact = unknown> {
	artifact: TArtifact;
	rawResultId: string;
	attemptId: string;
	patchPath?: string;
	branchName?: string;
	usage?: Usage;
	/** Isolation merge result: true applied, false failed/not applied, null N/A. */
	changesApplied?: boolean | null;
	resolvedProvider?: string;
	resolvedModel?: string;
	toolCalls?: number;
	/**
	 * Prompt assembly receipt from prepareWorkflowInvocation (attempt evidence).
	 * After a successful run, provider cache counters are merged when usage reports them.
	 */
	promptAssemblyReceipt?: PromptAssemblyReceiptV1;
	/** Tool optimization receipts accumulated on the live tool path during the attempt. */
	optimizationReceipts?: unknown[];
	/** Deterministic schema repair attempt receipt when raw repair ran. */
	schemaRepairReceipt?: unknown;
}

export interface WorkflowRuntimeEvidence {
	usage?: Usage;
	resolvedProvider?: string;
	resolvedModel?: string;
	toolCalls?: number;
	promptAssemblyReceipt?: PromptAssemblyReceiptV1;
	optimizationReceipts?: unknown[];
	/** Relative artifact kind ref when scope-metrics was persisted. */
	scopeMetricsKind?: string;
}

export interface WorkflowRequest {
	workflowId?: string;
	request: string;
	constraints?: string;
}

export type WorkflowErrorKind =
	| "configuration"
	| "authentication"
	| "quota"
	| "rate_limit"
	| "timeout"
	| "cancelled"
	| "provider_transient"
	| "provider_permanent"
	| "schema_violation"
	| "tool_failure"
	| "verification_failure"
	| "policy_violation"
	| "merge_conflict"
	| "budget_exhausted"
	| "internal";

export interface WorkflowState {
	id: string;
	status: WorkflowStatus;
	currentStage: WorkflowStatus;
	currentAttemptId?: string;
	degradedMode: boolean;
	createdAt: string;
	updatedAt: string;
	version: number;
	requestJson: string;
	policyJson: string;
}

export interface Artifact {
	id: string;
	workflowId: string;
	attemptId: string;
	kind: string;
	schemaVersion: number;
	relativePath: string;
	sha256: string;
	createdAt: string;
	content?: string;
}

export interface Transition {
	id: number;
	workflowId: string;
	fromStatus: WorkflowStatus;
	toStatus: WorkflowStatus;
	reason: string;
	attemptId?: string;
	createdAt: string;
}

export interface Attempt {
	id: string;
	workflowId: string;
	stage: string;
	ordinal: number;
	modelProfileId?: string;
	status: string;
	errorKind?: string;
	errorSummary?: string;
	usageJson?: string;
	startedAt: string;
	finishedAt?: string;
}

/** Port used by stages — only adapter implements real provider I/O. */
export interface RuntimePort {
	buildRequest(request: WorkflowAgentRequest): WorkflowAgentRequest;
	run<TArtifact = unknown>(request: WorkflowAgentRequest): Promise<WorkflowAgentResult<TArtifact>>;
}

/** Port used by verify stages — deterministic commands only. */
export interface VerifierPort {
	verify(
		artifact: Pick<ArtifactHeader, "workflowId" | "attemptId" | "stage"> &
			Partial<Pick<ArtifactHeader, "modelProfileId" | "provider" | "model" | "promptVersion">> & {
				changedFiles?: string[];
				patchContent?: string;
			},
		commands: string[],
		forbiddenPaths?: string[],
		options?: { signal?: AbortSignal; timeoutMs?: number; expectDirtyTree?: boolean },
	): Promise<VerificationArtifactV1>;
}

// ---------------------------------------------------------------------------
// Availability preflight (dedicated probe seam — not RuntimePort.run)
// ---------------------------------------------------------------------------

export type AvailabilityProbeStatus = "available" | "unavailable" | "indeterminate";
export type AvailabilityRequirement = "required" | "conditional";
export type AvailabilityScopeStatus = "ready" | "degraded" | "blocked" | "not_required";

/** Single physical probe request for one profile/runtime target. */
export interface WorkflowAvailabilityProbeRequest {
	profile: ModelProfile;
	role: WorkflowRole;
	session: ToolSession;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Outcome of one physical probe before per-profile expansion. */
export interface WorkflowAvailabilityProbeResult {
	status: AvailabilityProbeStatus;
	/** Only from runtime response metadata — never from profile config/vendor. */
	actualProvider?: string;
	/** Only from runtime response metadata — never from profile config/vendor. */
	actualModel?: string;
	/** Omitted when the target never started before the overall deadline. */
	latencyMs?: number;
	/** Observable response usage for this diagnostic request only. */
	usage?: Usage;
	/** Provider/runtime-reported cost. null means explicitly unknown; never infer zero. */
	reportedCostUsd?: number | null;
	errorKind?: string;
	errorSummary?: string;
}

/**
 * Dedicated availability probe port.
 * Must not be implemented by forging schema artifacts through RuntimePort.run().
 */
export interface WorkflowAvailabilityPort {
	probe(request: WorkflowAvailabilityProbeRequest): Promise<WorkflowAvailabilityProbeResult>;
}

/** Per-profile row in a preflight report (after single-flight expansion). */
export interface WorkflowAvailabilityProfileResult {
	profileId: string;
	role: WorkflowRole;
	requirement: AvailabilityRequirement;
	status: AvailabilityProbeStatus;
	runtime: "embedded";
	actualProvider?: string;
	actualModel?: string;
	latencyMs?: number;
	source?: "live" | "shared_live";
	/** Marks this usage as preflight diagnostics, not stage/workflow model usage. */
	usageKind: "diagnostic";
	usage?: Usage;
	reportedCostUsd?: number | null;
	errorKind?: string;
	errorSummary?: string;
}

/** Full preflight report returned from start/resume. */
export interface WorkflowAvailabilityReport {
	workflowId: string;
	invocationId: string;
	operation: "start" | "resume";
	scope: "full" | "single_step";
	checkedAt: string;
	wallLatencyMs: number;
	status: AvailabilityScopeStatus;
	profiles: WorkflowAvailabilityProfileResult[];
	/** Aggregate of physical live probes only; shared_live rows are not double-counted. */
	usageKind: "diagnostic";
	usage?: Usage;
	/** Aggregate reported cost, or null when any physical probe cost is unknown. */
	reportedCostUsd?: number | null;
	/** Required roles with zero available routes (present when status is blocked). */
	blockedRoles?: WorkflowRole[];
}
