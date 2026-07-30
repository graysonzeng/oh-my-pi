/**
 * Ordinary/workflow adapters into compileModelPolicy.
 *
 * Facts come only from catalog Model identity/api/thinking/compat and explicit
 * descriptor decisions. Unknown stays unknown — never OpenAI-compatible optimism.
 * Compiler outputs policy only; provider wire builders stay outside this module.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import { isOfficialMoonshotEndpoint } from "@oh-my-pi/pi-catalog/compat/openai";
import { isKimiK3ModelId, modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import { compileModelPolicy } from "./compiler";
import { fingerprintModelFacts } from "./receipt";
import type {
	ActiveModelPolicyLever,
	CompiledModelPolicyReceiptV1,
	CompiledModelPolicyV1,
	ModelFactsV1,
	ModelPolicyFeatureGates,
	ModelPolicyRole,
	ReasoningEffortControl,
	ReasoningMode,
	ReasoningReplay,
	SemanticToolContract,
	SessionPolicyStateV1,
	TaskRolePolicyV1,
	ToolDescriptorPlacement,
} from "./types";

/** Adapter version stamped into ModelFacts identity (not a provider wire adapter). */
export const MODEL_FACTS_ADAPTER_VERSION = "catalog-facts-1" as const;

export interface DeriveModelFactsOverrides {
	/** Explicit product/runtime descriptor decision — never inferred from OpenAI-compat. */
	descriptorPlacement?: ToolDescriptorPlacement;
	/** Optional identity checkpoint (quantization / served revision). */
	checkpoint?: string;
	/** Optional parser version when a conformance probe recorded one. */
	parserVersion?: string;
	/** Provenance override; defaults to catalog. */
	provenance?: ModelFactsV1["provenance"];
	/** Partial deep merges applied after conservative derivation (user_override). */
	facts?: {
		identity?: Partial<ModelFactsV1["identity"]>;
		reasoning?: Partial<ModelFactsV1["reasoning"]>;
		tools?: Partial<ModelFactsV1["tools"]>;
		structuredOutput?: Partial<ModelFactsV1["structuredOutput"]>;
		context?: Partial<ModelFactsV1["context"]>;
		cache?: Partial<ModelFactsV1["cache"]>;
		provenance?: Partial<ModelFactsV1["provenance"]>;
	};
}

/** Minimal model surface accepted by deriveModelFacts (catalog Model or test doubles). */
export type ModelFactsSource = Pick<
	Model,
	"id" | "provider" | "api" | "reasoning" | "contextWindow" | "supportsTools" | "thinking"
> & {
	baseUrl?: string;
	compat?: unknown;
	requestModelId?: string;
	name?: string;
};

export interface OrdinaryTaskAdapterInput {
	goal?: string;
	constraints?: string[];
	acceptance?: string[];
	semanticToolIds?: string[];
	/** Only when independently gated; never inherit family prompt guesses. */
	overlayId?: string;
	risk?: TaskRolePolicyV1["risk"];
	reasoningIntent?: TaskRolePolicyV1["reasoningIntent"];
	allowParallelReadonly?: boolean;
}

export type WorkflowAdapterRole = Exclude<ModelPolicyRole, "interactive_coding">;

export interface WorkflowTaskAdapterInput {
	role: WorkflowAdapterRole;
	assignment: string;
	/** Role allowlist after policy intersection — never expanded by compiler. */
	allowedToolIds?: readonly string[];
	outputSchema?: unknown;
	constraints?: string[];
	acceptance?: string[];
	requiredArtifacts?: string[];
	verificationRequired?: boolean;
	scopeRequired?: boolean;
	overlayId?: string;
	risk?: TaskRolePolicyV1["risk"];
	reasoningIntent?: TaskRolePolicyV1["reasoningIntent"];
	allowParallelReadonly?: boolean;
}

export interface SessionPolicySeedInput {
	modelFacts: ModelFactsV1;
	turnOrStageId: string;
	/** Optional exact session state; missing fields filled conservatively. */
	seed?: Partial<SessionPolicyStateV1>;
}

export interface CompileOrdinaryPolicyInput {
	model: ModelFactsSource;
	task?: OrdinaryTaskAdapterInput;
	session?: Partial<SessionPolicyStateV1>;
	semanticTools?: SemanticToolContract[];
	featureGates?: ModelPolicyFeatureGates;
	factsOverrides?: DeriveModelFactsOverrides;
	turnOrStageId?: string;
}

export interface CompileWorkflowPolicyInput {
	/** Exact catalog model when available. */
	model?: ModelFactsSource;
	/** When model is absent, build conservative shadow facts from this identity. */
	profileIdentity?: {
		provider: string;
		model: string;
		api?: string;
	};
	/** Exact facts win over model/profile derivation. */
	modelFacts?: ModelFactsV1;
	task: WorkflowTaskAdapterInput;
	session?: Partial<SessionPolicyStateV1>;
	semanticTools?: SemanticToolContract[];
	featureGates?: ModelPolicyFeatureGates;
	factsOverrides?: DeriveModelFactsOverrides;
	turnOrStageId?: string;
}

export interface AdaptedCompiledPolicy {
	modelFacts: ModelFactsV1;
	taskPolicy: TaskRolePolicyV1;
	sessionState: SessionPolicyStateV1;
	compiledPolicy: CompiledModelPolicyV1;
	receipt: CompiledModelPolicyReceiptV1;
}

/** Optional compiler inputs on workflow requests. */
export interface WorkflowCompilerRequestFields {
	modelFacts?: ModelFactsV1;
	model?: ModelFactsSource;
	sessionPolicyState?: Partial<SessionPolicyStateV1>;
	modelPolicyFeatureGates?: ModelPolicyFeatureGates;
	semanticTools?: SemanticToolContract[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCompatBool(compat: unknown, key: string): boolean | undefined {
	if (!isRecord(compat)) return undefined;
	const value = compat[key];
	return typeof value === "boolean" ? value : undefined;
}

function readCompatString(compat: unknown, key: string): string | undefined {
	if (!isRecord(compat)) return undefined;
	const value = compat[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mapThinkingEffortControl(mode: string | undefined): ReasoningEffortControl {
	switch (mode) {
		case "effort":
		case "google-level":
		case "anthropic-adaptive":
			return "level";
		case "budget":
		case "anthropic-budget-effort":
			return "budget";
		default:
			return "unknown";
	}
}

function deriveReasoningFromModel(model: ModelFactsSource): ModelFactsV1["reasoning"] {
	if (!model.reasoning) {
		return {
			mode: "none",
			replay: "none",
			effortControl: "none",
			supportedEfforts: [],
			incompatibleParams: [],
		};
	}

	const api = String(model.api ?? "").toLowerCase();
	const compat = model.compat;
	const thinking = model.thinking;
	const supportedEfforts = thinking?.efforts ? [...thinking.efforts] : [];
	// reasoning:true without thinking surface = non-controllable, not inventable levels
	const effortControl: ReasoningEffortControl = thinking ? mapThinkingEffortControl(thinking.mode) : "none";

	let mode: ReasoningMode = "unknown";
	let replay: ReasoningReplay = "unknown";

	if (api.includes("anthropic")) {
		mode = "native_opaque";
		replay = "signed_blocks";
	} else if (
		api === "openai-responses" ||
		api === "azure-openai-responses" ||
		api === "openai-codex-responses" ||
		api === "openrouter"
	) {
		mode = "native_opaque";
		replay = "provider_items";
	} else if (api.startsWith("google-") || api.includes("gemini")) {
		mode = "native_opaque";
		// Thought signatures are provider-native; exact replay owned by provider-state.
		replay = "sdk_state";
	} else if (readCompatString(compat, "reasoningContentField")) {
		mode = "native_opaque";
		replay = "reasoning_content";
	} else {
		// reasoning:true on unknown transport — do not invent native wire params
		mode = "unknown";
		replay = "unknown";
	}

	const incompatibleParams: string[] = [];
	if (readCompatBool(compat, "supportsSamplingParams") === false) {
		incompatibleParams.push("temperature", "top_p", "top_k", "min_p");
	}

	return {
		mode,
		replay,
		effortControl,
		supportedEfforts,
		incompatibleParams: [...new Set(incompatibleParams)].sort(),
	};
}

function deriveToolsFromModel(
	model: ModelFactsSource,
	descriptorPlacement: ToolDescriptorPlacement | undefined,
): ModelFactsV1["tools"] {
	const api = String(model.api ?? "").toLowerCase();
	const compat = model.compat;

	let transport: ModelFactsV1["tools"]["transport"] = "unknown";
	if (model.supportsTools === false) {
		transport = "text";
	} else if (
		api.includes("anthropic") ||
		api.includes("openai") ||
		api.includes("google") ||
		api === "openrouter" ||
		api === "bedrock-converse-stream"
	) {
		// Native tool APIs are catalog identity facts, not OpenAI-compatible guesses.
		transport = "native";
	}

	const strictFlag = readCompatBool(compat, "supportsStrictMode");
	const strictArguments: boolean | null = strictFlag === undefined ? null : strictFlag;
	// Parallel tool calls are never inferred from OpenAI-compatible branding.
	const parallelCalls: boolean | null = null;
	const streamingShape: ModelFactsV1["tools"]["streamingShape"] = "unknown";
	const schemaDialect: string | null = null;

	let placement: ToolDescriptorPlacement = "unknown";
	if (descriptorPlacement) {
		placement = descriptorPlacement;
	} else if (modelFamilyToken(model.id) === "gemini") {
		// Product auto policy: Gemini prefers system-inline descriptors.
		placement = "system_inline";
	} else if (transport === "native") {
		placement = "provider_schema";
	}

	return {
		transport,
		strictArguments,
		parallelCalls,
		streamingShape,
		schemaDialect,
		descriptorPlacement: placement,
	};
}

function applyOfficialMoonshotK3Facts(facts: ModelFactsV1, model: ModelFactsSource): void {
	if (
		model.api !== "openai-completions" ||
		model.provider !== "moonshot" ||
		!isOfficialMoonshotEndpoint(model.provider, model.baseUrl ?? "") ||
		!isKimiK3ModelId(model.id)
	) {
		return;
	}

	// Fill only unresolved catalog axes. Explicit catalog facts and caller
	// overrides retain precedence over this first-party documented contract.
	if (facts.reasoning.mode === "unknown") facts.reasoning.mode = "native_opaque";
	if (facts.reasoning.replay === "unknown") facts.reasoning.replay = "reasoning_content";
	if (facts.tools.transport === "native" && facts.tools.parallelCalls === null) {
		facts.tools.parallelCalls = true;
	}
	if (facts.structuredOutput.tier === "unknown") {
		facts.structuredOutput.tier = "native_json_schema";
		if (facts.structuredOutput.constraints.length === 0) facts.structuredOutput.constraints = ["MFJS"];
	}
	if (facts.context.nativeStatefulContinuation === null) facts.context.nativeStatefulContinuation = false;
	if (facts.cache.mode === "unknown") facts.cache.mode = "exact_prefix";
	if (facts.cache.usageObservable === null) facts.cache.usageObservable = true;
}

/**
 * Derive ModelFactsV1 from a catalog Model.
 * Unproven capability axes remain unknown/null — never OpenAI-compatible defaults.
 */
export function deriveModelFacts(model: ModelFactsSource, overrides?: DeriveModelFactsOverrides): ModelFactsV1 {
	const window =
		typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0
			? model.contextWindow
			: null;

	const api = String(model.api ?? "").toLowerCase();
	let cache: ModelFactsV1["cache"] = {
		mode: "unknown",
		ordering: [],
		usageObservable: null,
	};
	// Only stamp cache contracts that are official for the exact API surface.
	if (api.includes("anthropic")) {
		cache = {
			mode: "exact_prefix",
			ordering: ["tools", "system", "messages"],
			usageObservable: true,
		};
	} else if (api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") {
		cache = {
			mode: "exact_prefix",
			ordering: ["instructions", "tools", "messages"],
			usageObservable: true,
		};
	}

	const base: ModelFactsV1 = {
		schemaVersion: 1,
		identity: {
			provider: model.provider,
			model: model.id,
			checkpoint: overrides?.checkpoint,
			api: String(model.api ?? "unknown"),
			adapterVersion: MODEL_FACTS_ADAPTER_VERSION,
			parserVersion: overrides?.parserVersion,
		},
		reasoning: deriveReasoningFromModel(model),
		tools: deriveToolsFromModel(model, overrides?.descriptorPlacement),
		// No catalog field proves structured-output tier.
		structuredOutput: {
			tier: "unknown",
			constraints: [],
		},
		context: {
			windowTokens: window,
			// Stateful continuation is provider-protocol specific; unproven → null.
			nativeStatefulContinuation: null,
		},
		cache,
		provenance: overrides?.provenance ?? {
			source: "catalog",
			sourceVersion: MODEL_FACTS_ADAPTER_VERSION,
		},
	};
	applyOfficialMoonshotK3Facts(base, model);

	const partial = overrides?.facts;
	if (!partial) return base;

	return {
		schemaVersion: 1,
		identity: { ...base.identity, ...partial.identity },
		reasoning: { ...base.reasoning, ...partial.reasoning },
		tools: { ...base.tools, ...partial.tools },
		structuredOutput: { ...base.structuredOutput, ...partial.structuredOutput },
		context: { ...base.context, ...partial.context },
		cache: { ...base.cache, ...partial.cache },
		provenance: {
			...base.provenance,
			...partial.provenance,
			source: partial.provenance?.source ?? "user_override",
		},
	};
}

/**
 * Conservative shadow facts from workflow profile identity when no catalog Model is available.
 * Every capability axis is unknown/null — only identity is filled.
 */
export function deriveShadowFactsFromIdentity(identity: {
	provider: string;
	model: string;
	api?: string;
}): ModelFactsV1 {
	return {
		schemaVersion: 1,
		identity: {
			provider: identity.provider,
			model: identity.model,
			api: identity.api ?? "unknown",
			adapterVersion: MODEL_FACTS_ADAPTER_VERSION,
		},
		reasoning: {
			mode: "unknown",
			replay: "unknown",
			effortControl: "unknown",
			supportedEfforts: [],
			incompatibleParams: [],
		},
		tools: {
			transport: "unknown",
			strictArguments: null,
			parallelCalls: null,
			streamingShape: "unknown",
			schemaDialect: null,
			descriptorPlacement: "unknown",
		},
		structuredOutput: {
			tier: "unknown",
			constraints: [],
		},
		context: {
			windowTokens: null,
			nativeStatefulContinuation: null,
		},
		cache: {
			mode: "unknown",
			ordering: [],
			usageObservable: null,
		},
		provenance: {
			source: "catalog",
			sourceVersion: `${MODEL_FACTS_ADAPTER_VERSION}:shadow-identity`,
		},
	};
}

/** Ordinary interactive coding task policy (no provider facts). */
export function buildOrdinaryTaskPolicy(input: OrdinaryTaskAdapterInput = {}): TaskRolePolicyV1 {
	return {
		schemaVersion: 1,
		role: "interactive_coding",
		taskClass: "implement",
		risk: input.risk ?? "medium",
		promptContract: {
			goal: input.goal?.trim() || "Complete the user request",
			constraints: input.constraints ?? [],
			acceptance: input.acceptance ?? [],
			overlayId: input.overlayId,
		},
		reasoningIntent: input.reasoningIntent ?? "balanced",
		toolIntent: {
			semanticToolIds: input.semanticToolIds ? [...input.semanticToolIds] : [],
			allowParallelReadonly: input.allowParallelReadonly ?? true,
		},
		outputContract: {
			kind: "natural_text",
		},
		contextIntent: {
			requiredArtifacts: [],
			preserveUnresolvedState: true,
		},
		completionRequirements: {
			requiredArtifacts: [],
			verificationRequired: false,
			scopeRequired: false,
		},
	};
}

function workflowRoleToTaskClass(role: WorkflowAdapterRole): TaskRolePolicyV1["taskClass"] {
	switch (role) {
		case "planner":
			return "plan";
		case "plan_reviewer":
		case "code_reviewer":
			return "review";
		case "implementer":
			return "implement";
		case "repair":
			return "repair";
		default:
			return "implement";
	}
}

/** Workflow role task policy from assignment/allowlist/schema — no provider facts. */
export function buildWorkflowTaskPolicy(input: WorkflowTaskAdapterInput): TaskRolePolicyV1 {
	const hasSchema = input.outputSchema !== undefined && input.outputSchema !== null;
	const requiredArtifacts = input.requiredArtifacts ?? (hasSchema ? ["typed_artifact"] : []);
	const writeRole = input.role === "implementer" || input.role === "repair";

	return {
		schemaVersion: 1,
		role: input.role,
		taskClass: workflowRoleToTaskClass(input.role),
		risk: input.risk ?? (writeRole ? "high" : "medium"),
		promptContract: {
			goal: input.assignment.trim() || `Execute workflow role ${input.role}`,
			constraints: input.constraints ?? [],
			acceptance: input.acceptance ?? [],
			overlayId: input.overlayId,
		},
		reasoningIntent: input.reasoningIntent ?? "balanced",
		toolIntent: {
			// Empty list means compiler keeps provided semanticTools; allowlist intersection is caller's job.
			semanticToolIds: input.allowedToolIds ? [...input.allowedToolIds] : [],
			allowParallelReadonly: input.allowParallelReadonly ?? !writeRole,
		},
		outputContract: {
			kind: hasSchema ? "typed_artifact" : "natural_text",
			schema: input.outputSchema,
		},
		contextIntent: {
			requiredArtifacts: [...requiredArtifacts],
			preserveUnresolvedState: true,
		},
		completionRequirements: {
			requiredArtifacts: [...requiredArtifacts],
			verificationRequired: input.verificationRequired ?? false,
			scopeRequired: input.scopeRequired ?? writeRole,
		},
	};
}

/**
 * Session state for compilation. Missing seed → conservative empty obligations
 * (no invented unresolved work; completion gate stays inactive without explicit obligations).
 */
export function buildSessionPolicyState(input: SessionPolicySeedInput): SessionPolicyStateV1 {
	const factsFp = fingerprintModelFacts(input.modelFacts);
	const seed = input.seed;
	return {
		schemaVersion: 1,
		activeModelFactsFingerprint: seed?.activeModelFactsFingerprint ?? factsFp,
		turnOrStageId: seed?.turnOrStageId ?? input.turnOrStageId,
		unresolvedItems: seed?.unresolvedItems ? [...seed.unresolvedItems] : [],
		requiredArtifactStatus: seed?.requiredArtifactStatus ? [...seed.requiredArtifactStatus] : [],
		verificationEvidence: seed?.verificationEvidence ? [...seed.verificationEvidence] : [],
		// indeterminate until an explicit scope check runs
		scopeStatus: seed?.scopeStatus ?? "indeterminate",
		toolLedger: {
			calls: seed?.toolLedger?.calls ?? 0,
			retries: seed?.toolLedger?.retries ?? 0,
			duplicateReads: seed?.toolLedger?.duplicateReads ?? null,
			duplicateGreps: seed?.toolLedger?.duplicateGreps ?? null,
		},
		providerState: seed?.providerState ? [...seed.providerState] : [],
		contextCheckpoint: seed?.contextCheckpoint,
	};
}

/** Default gates: shadow receipts on, active wire takeover off. */
export function defaultShadowFeatureGates(gates?: ModelPolicyFeatureGates): ModelPolicyFeatureGates {
	return {
		compilerShadow: true,
		compilerActive: false,
		...gates,
	};
}

/** Ordinary feature gates when modelOptimization.enabled. */
export function ordinaryCompilerFeatureGates(
	enabled: boolean,
	extra?: ModelPolicyFeatureGates,
): ModelPolicyFeatureGates {
	if (!enabled) {
		return {
			compilerShadow: false,
			compilerActive: false,
			...extra,
		};
	}
	return defaultShadowFeatureGates(extra);
}

/** Filter semantic tools to a role allowlist without expanding permissions. */
export function intersectSemanticTools(
	tools: SemanticToolContract[],
	allowedToolIds: readonly string[] | undefined,
): SemanticToolContract[] {
	if (!allowedToolIds || allowedToolIds.length === 0) return tools;
	const allow = new Set(allowedToolIds);
	return tools.filter(tool => allow.has(tool.id));
}

/** Ordinary path: derive facts + task + session, compile deterministic policy. */
export function compileOrdinaryAdaptedPolicy(input: CompileOrdinaryPolicyInput): AdaptedCompiledPolicy {
	const modelFacts = deriveModelFacts(input.model, input.factsOverrides);
	const taskPolicy = buildOrdinaryTaskPolicy(input.task);
	const sessionState = buildSessionPolicyState({
		modelFacts,
		turnOrStageId: input.turnOrStageId ?? "ordinary",
		seed: input.session,
	});
	const compiledPolicy = compileModelPolicy({
		modelFacts,
		taskPolicy,
		sessionState,
		semanticTools: input.semanticTools ?? [],
		featureGates: defaultShadowFeatureGates(input.featureGates),
	});
	return {
		modelFacts,
		taskPolicy,
		sessionState,
		compiledPolicy,
		receipt: compiledPolicy.receipt,
	};
}

/** Workflow path: same compiler; optional exact facts / session seed / gates. */
export function compileWorkflowAdaptedPolicy(input: CompileWorkflowPolicyInput): AdaptedCompiledPolicy {
	const modelFacts =
		input.modelFacts ??
		(input.model
			? deriveModelFacts(input.model, input.factsOverrides)
			: deriveShadowFactsFromIdentity(
					input.profileIdentity ?? {
						provider: "unknown",
						model: "unknown",
					},
				));

	const taskPolicy = buildWorkflowTaskPolicy(input.task);
	const sessionState = buildSessionPolicyState({
		modelFacts,
		turnOrStageId: input.turnOrStageId ?? `workflow:${input.task.role}`,
		seed: input.session,
	});
	const semanticTools = intersectSemanticTools(input.semanticTools ?? [], input.task.allowedToolIds);
	const compiledPolicy = compileModelPolicy({
		modelFacts,
		taskPolicy,
		sessionState,
		semanticTools,
		featureGates: defaultShadowFeatureGates(input.featureGates),
	});
	return {
		modelFacts,
		taskPolicy,
		sessionState,
		compiledPolicy,
		receipt: compiledPolicy.receipt,
	};
}

/**
 * Map compiled descriptor placement to ordinary session decision surface.
 * `either`/`unknown` → provider_schema (matches existing non-Gemini default).
 */
export function compiledDescriptorToOrdinaryDecision(
	placement: ToolDescriptorPlacement,
): "system_inline" | "provider_schema" {
	return placement === "system_inline" ? "system_inline" : "provider_schema";
}

/**
 * Capability decision axes that must match for ordinary/workflow parity on the same model facts.
 */
export function capabilityDecisionSnapshot(policy: CompiledModelPolicyV1): {
	reasoningParameters: string[];
	omittedIncompatibleParameters: string[];
	replayMode: string;
	descriptorPlacement: string;
	strictArguments: boolean;
	parallelCalls: boolean;
	streamingShape: string;
	outputTier: string;
	cacheMode: string;
	hardGuards: string[];
	wireKeys: string[];
} {
	return {
		reasoningParameters: [...policy.receipt.reasoningParameters].sort(),
		omittedIncompatibleParameters: [...policy.receipt.omittedIncompatibleParameters].sort(),
		replayMode: policy.reasoningAndSampling.replayMode,
		descriptorPlacement: policy.tools.descriptorPlacement,
		strictArguments: policy.tools.strictArguments,
		parallelCalls: policy.tools.parallelCalls,
		streamingShape: policy.tools.streamingShape,
		outputTier: policy.output.tier,
		cacheMode: policy.contextAndCache.cacheMode,
		hardGuards: [...policy.guards.hard].sort(),
		wireKeys: Object.keys(policy.reasoningAndSampling.wireParameters).sort(),
	};
}

/** Deterministic capability-decision equality for parity tests. */
export function sameCapabilityDecisions(a: CompiledModelPolicyV1, b: CompiledModelPolicyV1): boolean {
	return JSON.stringify(capabilityDecisionSnapshot(a)) === JSON.stringify(capabilityDecisionSnapshot(b));
}

/**
 * Profile identity → shadow facts when workflow request lacks a catalog Model.
 * modelPattern arrays use the first entry as model id label only.
 */
export function profileIdentityFromWorkflowProfile(profile: {
	vendor: string;
	modelPattern: string | string[];
	id?: string;
}): { provider: string; model: string } {
	const pattern = Array.isArray(profile.modelPattern) ? profile.modelPattern[0] : profile.modelPattern;
	return {
		provider: profile.vendor,
		model: pattern || profile.id || "unknown",
	};
}

/**
 * Shadow-compile helper for ordinary/workflow with the same model facts source.
 */
export function shadowCompileForModel(
	model: ModelFactsSource,
	options?: {
		role?: "ordinary" | WorkflowAdapterRole;
		assignment?: string;
		allowedToolIds?: readonly string[];
		featureGates?: ModelPolicyFeatureGates;
		factsOverrides?: DeriveModelFactsOverrides;
		outputSchema?: unknown;
	},
): AdaptedCompiledPolicy {
	if (!options?.role || options.role === "ordinary") {
		return compileOrdinaryAdaptedPolicy({
			model,
			task: {
				semanticToolIds: options?.allowedToolIds ? [...options.allowedToolIds] : undefined,
			},
			featureGates: options?.featureGates,
			factsOverrides: options?.factsOverrides,
		});
	}
	return compileWorkflowAdaptedPolicy({
		model,
		task: {
			role: options.role,
			assignment: options.assignment ?? "",
			allowedToolIds: options.allowedToolIds,
			outputSchema: options.outputSchema,
		},
		featureGates: options.featureGates,
		factsOverrides: options.factsOverrides,
	});
}

/**
 * Ordinary reconcile compile when modelOptimization is enabled.
 * Returns undefined when feature-off.
 */
export function compileForOrdinaryReconcile(input: {
	model: ModelFactsSource;
	enabled: boolean;
	semanticToolIds?: string[];
	descriptorPlacement?: ToolDescriptorPlacement;
	featureGates?: ModelPolicyFeatureGates;
	turnOrStageId?: string;
}): AdaptedCompiledPolicy | undefined {
	if (!input.enabled) return undefined;
	return compileOrdinaryAdaptedPolicy({
		model: input.model,
		task: {
			semanticToolIds: input.semanticToolIds,
		},
		featureGates: ordinaryCompilerFeatureGates(true, input.featureGates),
		factsOverrides: input.descriptorPlacement ? { descriptorPlacement: input.descriptorPlacement } : undefined,
		turnOrStageId: input.turnOrStageId,
	});
}

/**
 * Attach compiled shadow policy onto a resolved ordinary optimization result.
 * Does not replace profile-driven prompt/tool/context execution when shadow-only.
 */
export function attachCompiledPolicyShadow<T extends object>(
	resolved: T,
	adapted: AdaptedCompiledPolicy | undefined,
): T & {
	compiledPolicy?: CompiledModelPolicyV1;
	compiledReceipt?: CompiledModelPolicyReceiptV1;
	compiledModelFacts?: ModelFactsV1;
	compilerActive: boolean;
	activeLever?: ActiveModelPolicyLever;
} {
	if (!adapted) {
		return { ...resolved, compilerActive: false, activeLever: undefined };
	}
	const active = adapted.receipt.leverGates["compiler.active"] === true;
	return {
		...resolved,
		compiledPolicy: adapted.compiledPolicy,
		compiledReceipt: adapted.receipt,
		compiledModelFacts: adapted.modelFacts,
		compilerActive: active,
		activeLever: active ? (adapted.receipt.activeLever ?? undefined) : undefined,
	};
}

/**
 * Prepare workflow compiler inputs from a request-like object without importing workflow types.
 */
export function compileFromWorkflowRequestFields(
	fields: WorkflowCompilerRequestFields & {
		role: WorkflowAdapterRole;
		assignment: string;
		allowedToolIds?: readonly string[];
		outputSchema?: unknown;
		profileIdentity: { provider: string; model: string; api?: string };
		turnOrStageId?: string;
		constraints?: string[];
		acceptance?: string[];
		requiredArtifacts?: string[];
		verificationRequired?: boolean;
		scopeRequired?: boolean;
	},
): AdaptedCompiledPolicy {
	return compileWorkflowAdaptedPolicy({
		model: fields.model,
		modelFacts: fields.modelFacts,
		profileIdentity: fields.profileIdentity,
		task: {
			role: fields.role,
			assignment: fields.assignment,
			allowedToolIds: fields.allowedToolIds,
			outputSchema: fields.outputSchema,
			constraints: fields.constraints,
			acceptance: fields.acceptance,
			requiredArtifacts: fields.requiredArtifacts,
			verificationRequired: fields.verificationRequired,
			scopeRequired: fields.scopeRequired,
		},
		session: fields.sessionPolicyState,
		semanticTools: fields.semanticTools,
		featureGates: fields.modelPolicyFeatureGates,
		turnOrStageId: fields.turnOrStageId,
	});
}

/** Receipt core for deterministic equality checks (no wall-clock). */
export function receiptCapabilityCore(receipt: CompiledModelPolicyReceiptV1): {
	compilerVersion: string;
	modelFactsFingerprint: string;
	overlayId: string | null;
	outputTier: string;
	reasoningParameters: string[];
	omittedIncompatibleParameters: string[];
	guards: string[];
	leverGates: Record<string, boolean>;
} {
	return {
		compilerVersion: receipt.compilerVersion,
		modelFactsFingerprint: receipt.modelFactsFingerprint,
		overlayId: receipt.overlayId,
		outputTier: receipt.outputTier,
		reasoningParameters: [...receipt.reasoningParameters].sort(),
		omittedIncompatibleParameters: [...receipt.omittedIncompatibleParameters].sort(),
		guards: [...receipt.guards].sort(),
		leverGates: { ...receipt.leverGates },
	};
}
