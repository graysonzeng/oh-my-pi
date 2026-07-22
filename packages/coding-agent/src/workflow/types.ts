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

export interface ModelProfile {
	id: string;
	vendor: "anthropic" | "openai" | "xai" | string;
	modelPattern: string | string[];
	roles: WorkflowRole[];
	thinkingLevel?: string;
	promptTemplate: string;
	promptVersion: string;
	toolPolicyId: string;
	toolAliases?: Record<string, string>;
	argumentAliases?: Record<string, Record<string, string>>;
	disabledTools?: string[];
	maxRequests: number;
	maxRuntimeMs: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxCostUsd?: number;
	retryPolicy: {
		maxAttempts: number;
		retryableErrorKinds: string[]; // WorkflowErrorKind
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
	isolation?: StructuredSubagentIsolationControls;
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
}

export interface WorkflowRequest {
	workflowId: string;
	request: string;
	constraints: string;
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
	content?: string; // for tests
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

import type { Usage } from "@oh-my-pi/pi-ai";
import type { StructuredSubagentIsolationControls } from "../task/structured-subagent";
import type { ToolSession } from "../tools";
