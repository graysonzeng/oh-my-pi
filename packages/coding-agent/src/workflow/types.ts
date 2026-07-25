import type { Usage } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { ToolSession } from "../tools";

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

export interface ModelProfile {
	id: string;
	vendor: "anthropic" | "openai" | "xai" | string;
	modelPattern: string | string[];
	roles: WorkflowRole[];
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
	 * When enabled + catalog, non-essential tools get xd:// locators without full schema.
	 */
	presentationPolicy?: {
		enabled?: boolean;
		mode?: "direct" | "catalog";
		essentialTools?: string[];
		skillCatalogOnly?: boolean;
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
	/** Prompt assembly receipt from prepareWorkflowInvocation (attempt evidence). */
	promptAssemblyReceipt?: unknown;
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
	promptAssemblyReceipt?: unknown;
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
