/**
 * Capability-compiled model policy types.
 *
 * Three policy inputs stay separated:
 * - ModelFactsV1: what the model/transport can do
 * - TaskRolePolicyV1: what this task needs
 * - SessionPolicyStateV1: what remains open right now
 *
 * compileModelPolicy is the deep seam: callers supply those inputs + semantic tools
 * + feature gates and receive one CompiledModelPolicyV1. Provider wire adapters live
 * outside this module.
 */

/** Compiler contract version embedded in receipts. */
export const MODEL_POLICY_COMPILER_VERSION = "1.0.0" as const;

export type ModelFactsSchemaVersion = 1;
export type TaskRolePolicySchemaVersion = 1;
export type SessionPolicyStateSchemaVersion = 1;
export type CompiledModelPolicySchemaVersion = 1;
export type ProviderOpaqueStateSchemaVersion = 1;
export type CompiledModelPolicyReceiptSchemaVersion = 1;

/** Roles accepted by the policy compiler (ordinary + workflow). */
export type ModelPolicyRole =
	| "interactive_coding"
	| "planner"
	| "plan_reviewer"
	| "implementer"
	| "code_reviewer"
	| "repair";

export type ModelFactsProvenanceSource = "catalog" | "official_doc" | "conformance_probe" | "user_override";

export type ReasoningMode = "none" | "native_opaque" | "native_visible" | "hybrid" | "unknown";
export type ReasoningReplay =
	| "provider_items"
	| "signed_blocks"
	| "reasoning_content"
	| "sdk_state"
	| "none"
	| "unknown";
export type ReasoningEffortControl = "level" | "budget" | "model_variant" | "none" | "unknown";

export type ToolTransport = "native" | "template" | "text" | "unknown";
export type ToolStreamingShape = "delta" | "whole_call" | "none" | "unknown";
export type ToolDescriptorPlacement = "provider_schema" | "system_inline" | "either" | "unknown";

export type StructuredOutputTier = "native_json_schema" | "strict_tool" | "valid_json" | "text" | "unknown";
export type CompiledOutputTier = "native_json_schema" | "strict_tool" | "valid_json" | "text_repair";

export type CacheMode = "exact_prefix" | "explicit" | "conversation_affinity" | "none" | "unknown";

export type ContextContinuationMode = "provider_native" | "replay_messages" | "new_chain";

export type ToolPresentationMode = "direct" | "catalog";

export type TaskClass = "research" | "plan" | "implement" | "review" | "repair" | "verify";
export type TaskRisk = "low" | "medium" | "high";
export type ReasoningIntent = "fast" | "balanced" | "deep";
export type OutputContractKind = "natural_text" | "typed_artifact";

export type UnresolvedItemStatus = "open" | "blocked";
export type VerificationEvidenceStatus = "passed" | "failed" | "unknown";
export type ScopeStatus = "adhered" | "warning" | "violation" | "indeterminate";

export type ProviderOpaqueStateKind =
	| "openai_reasoning_item"
	| "anthropic_thinking_block"
	| "gemini_thought_signature"
	| "deepseek_reasoning_content"
	| "provider_native_other";

export type ProviderOpaqueReplay = "required_with_tool_result" | "required_full_turn" | "provider_managed";

export type ProviderOpaqueEncoding = "provider_native_object" | "provider_native_bytes";

export type SemanticToolPermission = "readonly" | "write" | "admin";

/**
 * Verifiable model/provider/transport facts.
 * Model IDs only select facts; they do not imply OpenAI-compatible behaviour.
 */
export interface ModelFactsV1 {
	schemaVersion: ModelFactsSchemaVersion;
	identity: {
		provider: string;
		model: string;
		checkpoint?: string;
		api: string;
		adapterVersion: string;
		parserVersion?: string;
	};
	reasoning: {
		mode: ReasoningMode;
		replay: ReasoningReplay;
		effortControl: ReasoningEffortControl;
		supportedEfforts: string[];
		incompatibleParams: string[];
	};
	tools: {
		transport: ToolTransport;
		strictArguments: boolean | null;
		parallelCalls: boolean | null;
		streamingShape: ToolStreamingShape;
		schemaDialect: string | null;
		descriptorPlacement: ToolDescriptorPlacement;
	};
	structuredOutput: {
		tier: StructuredOutputTier;
		constraints: string[];
	};
	context: {
		windowTokens: number | null;
		nativeStatefulContinuation: boolean | null;
	};
	cache: {
		mode: CacheMode;
		ordering: string[];
		usageObservable: boolean | null;
	};
	provenance: {
		source: ModelFactsProvenanceSource;
		sourceVersion: string;
		observedAt?: string;
	};
}

/**
 * Task intent only — no provider facts.
 * Same role policy can compile against different model facts.
 */
export interface TaskRolePolicyV1 {
	schemaVersion: TaskRolePolicySchemaVersion;
	role: ModelPolicyRole;
	taskClass: TaskClass;
	risk: TaskRisk;
	promptContract: {
		goal: string;
		constraints: string[];
		acceptance: string[];
		overlayId?: string;
	};
	reasoningIntent: ReasoningIntent;
	toolIntent: {
		semanticToolIds: string[];
		allowParallelReadonly: boolean;
	};
	outputContract: {
		kind: OutputContractKind;
		schema?: unknown;
	};
	contextIntent: {
		requiredArtifacts: string[];
		preserveUnresolvedState: boolean;
	};
	completionRequirements: {
		requiredArtifacts: string[];
		verificationRequired: boolean;
		scopeRequired: boolean;
	};
}

/**
 * Provider-native opaque reasoning state envelope.
 * payload must never enter prompt templates, summaries, or generic text history.
 */
export interface ProviderOpaqueStateEnvelope {
	schemaVersion: ProviderOpaqueStateSchemaVersion;
	owner: {
		provider: string;
		model: string;
		api: string;
		conversationId?: string;
	};
	kind: ProviderOpaqueStateKind;
	payload: unknown;
	integrity: {
		byteHash: string;
		encoding: ProviderOpaqueEncoding;
	};
	replay: ProviderOpaqueReplay;
}

/**
 * Dynamic, recoverable session state for policy compilation.
 * Not a synonym for prompt history.
 */
export interface SessionPolicyStateV1 {
	schemaVersion: SessionPolicyStateSchemaVersion;
	activeModelFactsFingerprint: string;
	turnOrStageId: string;
	unresolvedItems: Array<{ id: string; kind: string; status: UnresolvedItemStatus }>;
	requiredArtifactStatus: Array<{ kind: string; present: boolean; artifactUri?: string }>;
	verificationEvidence: Array<{
		commandOrCheck: string;
		status: VerificationEvidenceStatus;
		artifactUri?: string;
	}>;
	scopeStatus: ScopeStatus;
	toolLedger: {
		calls: number;
		retries: number;
		duplicateReads: number | null;
		duplicateGreps: number | null;
	};
	providerState: ProviderOpaqueStateEnvelope[];
	contextCheckpoint?: {
		preservedStateArtifact: string;
		omittedArtifactUris: string[];
	};
}

/**
 * Stable semantic tool contract independent of provider wire shape.
 * Compiler projects these into descriptors according to model facts.
 */
export interface SemanticToolContract {
	id: string;
	description: string;
	parametersSchema: unknown;
	permission: SemanticToolPermission;
	resourceReadPaths?: string[];
	resourceWritePaths?: string[];
	errorContract?: string[];
}

/**
 * Per-lever feature gates. Hard guards are never gated off.
 */
export type CohortFeatureGate = boolean | Record<string, boolean>;

export interface ModelPolicyFeatureGates {
	compilerShadow?: boolean;
	compilerActive?: boolean;
	opaqueStateNativeReplay?: boolean;
	/** Overlay id → enabled. */
	promptOverlay?: Record<string, boolean>;
	toolSurface?: CohortFeatureGate;
	structuredOutput?: CohortFeatureGate;
	contextCache?: CohortFeatureGate;
	runtimeCompletionGate?: boolean;
}

export interface CompileModelPolicyInput {
	modelFacts: ModelFactsV1;
	taskPolicy: TaskRolePolicyV1;
	sessionState: SessionPolicyStateV1;
	semanticTools: SemanticToolContract[];
	featureGates: ModelPolicyFeatureGates;
}

export interface CompiledToolDescriptor {
	id: string;
	description: string;
	parametersSchema: unknown;
	permission: SemanticToolPermission;
	strictArguments: boolean;
	schemaDialect: string | null;
	transport: ToolTransport;
}

/**
 * Permanent online safety guards. Feature gates cannot disable these.
 */
export type HardGuardId =
	| "provider_protocol_schema_validation"
	| "unknown_malformed_tool_name_reject"
	| "tool_permission_scope_conflict_budget"
	| "repeated_identical_tool_call_detection"
	| "gemini_reasoning_header_runaway_interrupt"
	| "opaque_state_owner_integrity_replay_validation"
	| "artifact_recovery_uri_readability";

/**
 * Task completion / protocol guards selected from task + session state.
 */
export type TaskGuardId =
	| "unresolved_items_must_close"
	| "required_artifacts_must_present"
	| "verification_must_pass"
	| "scope_must_not_violate"
	| "schema_output_validator"
	| "unpaired_tool_call_result"
	| "tiny_local_serial_tools"
	| "tiny_local_minimal_allowlist";

export interface RuntimeGuardPlanV1 {
	hard: HardGuardId[];
	task: TaskGuardId[];
	/** Completion gate is evaluated only when explicit obligations exist. */
	completionGateActive: boolean;
}

export interface CompiledModelPolicyReceiptV1 {
	schemaVersion: CompiledModelPolicyReceiptSchemaVersion;
	compilerVersion: string;
	modelFactsFingerprint: string;
	taskPolicyFingerprint: string;
	sessionStateFingerprint: string;
	overlayId: string | null;
	leverGates: Record<string, boolean>;
	promptStableHash: string;
	promptDynamicHash: string;
	toolSurfaceHash: string;
	outputTier: CompiledOutputTier;
	reasoningParameters: string[];
	omittedIncompatibleParameters: string[];
	opaqueState: Array<{
		kind: string;
		ownerHash: string;
		payloadHash: string;
		replayed: boolean;
	}>;
	guards: string[];
	factsProvenance: Array<{ path: string; source: string; version: string }>;
	/** Non-fatal compile notes for conflict / unknown fallbacks. */
	notes: string[];
}

/**
 * Provider-executable policy produced by compileModelPolicy.
 * Six levers: prompt, reasoning/sampling, tools, structured output, context/cache, runtime guards.
 */
export interface CompiledModelPolicyV1 {
	schemaVersion: CompiledModelPolicySchemaVersion;
	prompt: {
		sharedContract: string;
		overlay: string | null;
		stableSections: string[];
		dynamicState: string;
	};
	reasoningAndSampling: {
		wireParameters: Record<string, unknown>;
		replayMode: ReasoningReplay;
		omittedIncompatibleParameters: string[];
	};
	tools: {
		descriptors: CompiledToolDescriptor[];
		presentationMode: ToolPresentationMode;
		descriptorPlacement: ToolDescriptorPlacement;
		strictArguments: boolean;
		parallelCalls: boolean;
		streamingShape: ToolStreamingShape;
		schemaDialect: string | null;
		maxConcurrentTools: number;
	};
	output: {
		tier: CompiledOutputTier;
		wireSchema?: unknown;
		hostValidationRequired: boolean;
	};
	contextAndCache: {
		stablePrefixOrder: string[];
		checkpointPolicy: string;
		continuationMode: ContextContinuationMode;
		replayOpaqueStateOwners: string[];
		cacheMode: CacheMode;
		cacheOrdering: string[];
		cacheUsageObservable: boolean;
	};
	guards: RuntimeGuardPlanV1;
	receipt: CompiledModelPolicyReceiptV1;
}
