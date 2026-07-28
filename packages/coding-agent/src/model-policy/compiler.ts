/**
 * Pure capability compiler.
 *
 * Inputs: ModelFactsV1 + TaskRolePolicyV1 + SessionPolicyStateV1 + semantic tools + gates.
 * Output: CompiledModelPolicyV1 with six independently fingerprinted levers.
 *
 * Deterministic: no I/O, no clocks, no provider requests. Same inputs → same policy/receipt.
 * Does not build provider wire adapters — only policy decisions.
 */

import { prompt } from "@oh-my-pi/pi-utils";
import dynamicStateTemplate from "../prompts/model-policy/dynamic-state.hbs.md" with { type: "text" };
import sharedContractTemplate from "../prompts/model-policy/shared-contract.hbs.md" with { type: "text" };
import {
	fingerprintModelFacts,
	fingerprintSessionState,
	fingerprintTaskPolicy,
	opaqueStateReceiptEntries,
	ownerHash,
	sha256Hex,
	stableStringify,
} from "./receipt";
import type {
	CompiledModelPolicyReceiptV1,
	CompiledModelPolicyV1,
	CompiledOutputTier,
	CompiledToolDescriptor,
	CompileModelPolicyInput,
	ContextContinuationMode,
	HardGuardId,
	ModelFactsV1,
	ModelPolicyFeatureGates,
	ProviderOpaqueStateEnvelope,
	ReasoningReplay,
	RuntimeGuardPlanV1,
	SemanticToolContract,
	SessionPolicyStateV1,
	TaskGuardId,
	TaskRolePolicyV1,
	ToolDescriptorPlacement,
	ToolStreamingShape,
	ToolTransport,
} from "./types";
import { MODEL_POLICY_COMPILER_VERSION } from "./types";

const HARD_GUARDS: readonly HardGuardId[] = [
	"provider_protocol_schema_validation",
	"unknown_malformed_tool_name_reject",
	"tool_permission_scope_conflict_budget",
	"repeated_identical_tool_call_detection",
	"gemini_reasoning_header_runaway_interrupt",
	"opaque_state_owner_integrity_replay_validation",
	"artifact_recovery_uri_readability",
] as const;

const STABLE_PREFIX_ORDER = ["system_static", "role_policy", "tool_presentation", "skill_catalog"] as const;

const OUTPUT_TIER_RANK: Record<CompiledOutputTier | "text" | "unknown", number> = {
	native_json_schema: 4,
	strict_tool: 3,
	valid_json: 2,
	text_repair: 1,
	text: 1,
	unknown: 1,
};

function isTinyOrLocal(facts: ModelFactsV1): boolean {
	const provider = facts.identity.provider.toLowerCase();
	const model = facts.identity.model.toLowerCase();
	const api = facts.identity.api.toLowerCase();
	return (
		provider === "tiny" ||
		provider === "local" ||
		provider === "ollama" ||
		provider === "lmstudio" ||
		model.includes("tiny") ||
		model.startsWith("local/") ||
		api.includes("local") ||
		api.includes("ollama")
	);
}

function factsUnknownHeavy(facts: ModelFactsV1): boolean {
	return (
		facts.reasoning.mode === "unknown" &&
		facts.tools.transport === "unknown" &&
		facts.structuredOutput.tier === "unknown" &&
		facts.cache.mode === "unknown"
	);
}

function compilePrompt(
	task: TaskRolePolicyV1,
	session: SessionPolicyStateV1,
	gates: ModelPolicyFeatureGates,
	notes: string[],
): CompiledModelPolicyV1["prompt"] {
	const completion: string[] = [];
	if (task.completionRequirements.verificationRequired) {
		completion.push("verification required before success");
	}
	if (task.completionRequirements.scopeRequired) {
		completion.push("scope adherence required");
	}
	if (task.completionRequirements.requiredArtifacts.length > 0) {
		completion.push(`required artifacts: ${task.completionRequirements.requiredArtifacts.join(", ")}`);
	}

	const sharedContract = prompt
		.render(sharedContractTemplate, {
			role: task.role,
			taskClass: task.taskClass,
			goal: task.promptContract.goal.trim(),
			hasConstraints: task.promptContract.constraints.length > 0,
			constraints: task.promptContract.constraints,
			hasAcceptance: task.promptContract.acceptance.length > 0,
			acceptance: task.promptContract.acceptance,
			hasCompletion: completion.length > 0,
			completion,
		})
		.trim();

	const overlayId = task.promptContract.overlayId;
	let overlay: string | null = null;
	if (overlayId) {
		const enabled = gates.promptOverlay?.[overlayId] === true;
		if (enabled) {
			// Overlay wording lives in independently gated overlay assets; compiler only gates id inclusion.
			overlay = `overlay:${overlayId}`;
		} else {
			notes.push(`overlay_disabled:${overlayId}`);
		}
	}

	const dynamicState = prompt
		.render(dynamicStateTemplate, {
			turnOrStageId: session.turnOrStageId,
			unresolvedItems: session.unresolvedItems,
			requiredArtifacts: session.requiredArtifactStatus.map(a => ({
				kind: a.kind,
				presence: a.present ? "present" : "missing",
			})),
			verificationEvidence: session.verificationEvidence,
			scopeStatus: session.scopeStatus,
		})
		.trim();

	return {
		sharedContract,
		overlay,
		stableSections: [...STABLE_PREFIX_ORDER],
		dynamicState,
	};
}

function compileReasoning(
	facts: ModelFactsV1,
	task: TaskRolePolicyV1,
	notes: string[],
): {
	wireParameters: Record<string, unknown>;
	replayMode: ReasoningReplay;
	omittedIncompatibleParameters: string[];
	reasoningParameters: string[];
} {
	const omitted = new Set<string>(facts.reasoning.incompatibleParams);
	const wireParameters: Record<string, unknown> = {};
	const reasoningParameters: string[] = [];

	const mode = facts.reasoning.mode;
	const effortControl = facts.reasoning.effortControl;
	const replayMode: ReasoningReplay = facts.reasoning.replay === "unknown" ? "none" : facts.reasoning.replay;

	if (mode === "unknown" || mode === "none") {
		// Unknown/none: never invent reasoning wire params.
		if (mode === "unknown") {
			notes.push("reasoning_mode_unknown:omit_wire_params");
		}
		for (const param of ["reasoning_effort", "thinking_budget", "thinking_level", "temperature", "top_p"]) {
			omitted.add(param);
		}
		return {
			wireParameters,
			replayMode,
			omittedIncompatibleParameters: [...omitted].sort(),
			reasoningParameters,
		};
	}

	// Intent only selects among facts.supportedEfforts / budget values proven by facts.
	// Never invent level labels or numeric budgets not present in supportedEfforts.
	const intentRank: Record<TaskRolePolicyV1["reasoningIntent"], number> = {
		fast: 0,
		balanced: 1,
		deep: 2,
	};
	const pickSupportedEffort = (): string | undefined => {
		const supported = facts.reasoning.supportedEfforts;
		if (supported.length === 0) return undefined;
		const rank = intentRank[task.reasoningIntent];
		const idx = Math.min(rank, supported.length - 1);
		return supported[idx];
	};

	if (effortControl === "none" || effortControl === "unknown") {
		notes.push(
			effortControl === "unknown" ? "effort_control_unknown:omit_effort" : "effort_control_none:omit_effort",
		);
		omitted.add("reasoning_effort");
		omitted.add("thinking_budget");
		omitted.add("thinking_level");
	} else if (effortControl === "level") {
		const effort = pickSupportedEffort();
		if (effort === undefined) {
			notes.push("effort_level_no_supported_efforts:omit_effort");
			omitted.add("reasoning_effort");
		} else if (!omitted.has("reasoning_effort")) {
			wireParameters.reasoning_effort = effort;
			reasoningParameters.push("reasoning_effort");
		}
	} else if (effortControl === "budget") {
		// Budgets must be numeric values present in supportedEfforts — never hardcoded.
		const effort = pickSupportedEffort();
		const budget = effort !== undefined && /^\d+$/.test(effort) ? Number(effort) : undefined;
		if (budget === undefined) {
			notes.push("effort_budget_no_supported_numeric:omit_budget");
			omitted.add("thinking_budget");
		} else if (!omitted.has("thinking_budget")) {
			wireParameters.thinking_budget = budget;
			reasoningParameters.push("thinking_budget");
		}
	} else if (effortControl === "model_variant") {
		// Variant is identity-level; no sampling wire param.
		reasoningParameters.push("model_variant");
		notes.push("effort_via_model_variant");
	}

	// Strip any incompatible params that might have been set.
	for (const param of facts.reasoning.incompatibleParams) {
		if (param in wireParameters) {
			delete wireParameters[param];
			const idx = reasoningParameters.indexOf(param);
			if (idx >= 0) reasoningParameters.splice(idx, 1);
		}
		omitted.add(param);
	}

	return {
		wireParameters,
		replayMode,
		omittedIncompatibleParameters: [...omitted].sort(),
		reasoningParameters: [...reasoningParameters].sort(),
	};
}

function resolveDescriptorPlacement(facts: ModelFactsV1, notes: string[]): ToolDescriptorPlacement {
	const placement = facts.tools.descriptorPlacement;
	if (placement === "unknown") {
		notes.push("descriptor_placement_unknown:system_inline");
		return "system_inline";
	}
	if (placement === "either") {
		// Prefer provider schema when either is allowed — Gemini auto re-evaluates per model.
		return "provider_schema";
	}
	return placement;
}

function resolveStreamingShape(facts: ModelFactsV1, notes: string[]): ToolStreamingShape {
	if (facts.tools.streamingShape === "unknown") {
		notes.push("streaming_shape_unknown:whole_call");
		return "whole_call";
	}
	return facts.tools.streamingShape;
}

function resolveTransport(facts: ModelFactsV1, notes: string[], tiny: boolean): ToolTransport {
	if (facts.tools.transport === "unknown") {
		notes.push(tiny ? "tool_transport_unknown_tiny:text" : "tool_transport_unknown:native_host_validated");
		return tiny ? "text" : "native";
	}
	return facts.tools.transport;
}

function compileTools(
	facts: ModelFactsV1,
	task: TaskRolePolicyV1,
	semanticTools: SemanticToolContract[],
	gates: ModelPolicyFeatureGates,
	tiny: boolean,
	notes: string[],
): CompiledModelPolicyV1["tools"] {
	const transport = resolveTransport(facts, notes, tiny);
	const placement = resolveDescriptorPlacement(facts, notes);
	const streamingShape = resolveStreamingShape(facts, notes);
	const schemaDialect = facts.tools.schemaDialect;

	const strictKnown = facts.tools.strictArguments === true;
	const strictArguments = strictKnown;
	if (facts.tools.strictArguments !== true) {
		notes.push(
			facts.tools.strictArguments === null
				? "strict_arguments_null:host_validation"
				: "strict_arguments_false:host_validation",
		);
	}

	const factsParallel = facts.tools.parallelCalls === true;
	const taskParallel = task.toolIntent.allowParallelReadonly === true;
	const parallelCalls = factsParallel && taskParallel && !tiny;
	if (!parallelCalls) {
		if (facts.tools.parallelCalls !== true) {
			notes.push(
				facts.tools.parallelCalls === null
					? "parallel_calls_null:serial"
					: "parallel_calls_false_or_unknown:serial",
			);
		} else if (!taskParallel) {
			notes.push("parallel_calls_task_disallows:serial");
		} else if (tiny) {
			notes.push("parallel_calls_tiny_local:serial");
		}
	}

	const allowedIds = new Set(task.toolIntent.semanticToolIds);
	let selected = semanticTools.filter(tool => allowedIds.size === 0 || allowedIds.has(tool.id));

	if (tiny) {
		// Minimal allowlist: prefer readonly tools first, cap at 4.
		selected = selected.filter(tool => tool.permission === "readonly").slice(0, 4);
		if (selected.length === 0) {
			selected = semanticTools.filter(tool => allowedIds.has(tool.id)).slice(0, 1);
		}
		notes.push("tiny_local_minimal_tool_allowlist");
	}

	// toolSurface gate only controls catalog presentation elevation, not hard deny.
	const presentationMode: CompiledModelPolicyV1["tools"]["presentationMode"] =
		gates.toolSurface === false || selected.length > 12 || tiny ? "catalog" : "direct";

	const descriptors: CompiledToolDescriptor[] = selected.map(tool => ({
		id: tool.id,
		description: tool.description,
		parametersSchema: tool.parametersSchema,
		permission: tool.permission,
		strictArguments,
		schemaDialect,
		transport,
	}));

	const maxConcurrentTools = parallelCalls ? Math.min(4, Math.max(1, selected.length || 1)) : 1;

	return {
		descriptors,
		presentationMode,
		descriptorPlacement: placement,
		strictArguments,
		parallelCalls,
		streamingShape,
		schemaDialect,
		maxConcurrentTools,
	};
}

function mapFactsTierToCompiled(tier: ModelFactsV1["structuredOutput"]["tier"]): CompiledOutputTier {
	if (tier === "text" || tier === "unknown") return "text_repair";
	return tier;
}

function minTier(a: CompiledOutputTier, b: CompiledOutputTier): CompiledOutputTier {
	return OUTPUT_TIER_RANK[a] <= OUTPUT_TIER_RANK[b] ? a : b;
}

function compileOutput(
	facts: ModelFactsV1,
	task: TaskRolePolicyV1,
	gates: ModelPolicyFeatureGates,
	tiny: boolean,
	notes: string[],
): CompiledModelPolicyV1["output"] {
	const factsTier = mapFactsTierToCompiled(facts.structuredOutput.tier);
	let tier = factsTier;

	if (facts.structuredOutput.tier === "unknown") {
		notes.push("structured_output_unknown:text_repair");
		tier = "text_repair";
	}

	if (task.outputContract.kind === "natural_text") {
		// Natural text still may use lower tiers only for optional scaffolding.
		if (tier === "native_json_schema" || tier === "strict_tool") {
			tier = "valid_json";
			notes.push("natural_text_contract:cap_below_native_schema");
		}
	}

	if (gates.structuredOutput === false) {
		// Gate can only lower tier, never raise, and never disable host validation.
		tier = minTier(tier, "text_repair");
		notes.push("structured_output_gate_off:text_repair");
	}

	if (tiny && task.outputContract.kind === "typed_artifact") {
		// Tiny/local: prefer scaffold + host validation; do not claim native schema without facts.
		if (facts.structuredOutput.tier === "unknown" || facts.structuredOutput.tier === "text") {
			tier = "text_repair";
			notes.push("tiny_local_typed_artifact:text_repair");
		} else {
			tier = minTier(tier, "strict_tool");
			notes.push("tiny_local_typed_artifact:cap_strict_tool");
		}
	}

	const hostValidationRequired = true;
	const wireSchema =
		task.outputContract.kind === "typed_artifact" && task.outputContract.schema !== undefined
			? task.outputContract.schema
			: undefined;

	if (facts.structuredOutput.constraints.length > 0) {
		notes.push(`structured_constraints:${facts.structuredOutput.constraints.join(",")}`);
	}

	return { tier, wireSchema, hostValidationRequired };
}

function compileContextAndCache(
	facts: ModelFactsV1,
	task: TaskRolePolicyV1,
	session: SessionPolicyStateV1,
	gates: ModelPolicyFeatureGates,
	notes: string[],
): {
	policy: CompiledModelPolicyV1["contextAndCache"];
	replayedOwnerKeys: Set<string>;
} {
	const ownerKey = (owner: ProviderOpaqueStateEnvelope["owner"]) => `${owner.provider}|${owner.model}|${owner.api}`;

	const replayedOwnerKeys = new Set<string>();
	const replayOpaqueStateOwners: string[] = [];

	let continuationMode: ContextContinuationMode;
	const native = facts.context.nativeStatefulContinuation;
	if (native === true) {
		continuationMode = "provider_native";
	} else if (native === false) {
		continuationMode = "replay_messages";
	} else {
		continuationMode = "new_chain";
		notes.push("native_stateful_continuation_unknown:new_chain");
	}

	const opaqueReplayEnabled = gates.opaqueStateNativeReplay !== false;
	if (opaqueReplayEnabled && continuationMode === "provider_native") {
		for (const envelope of session.providerState) {
			const key = ownerKey(envelope.owner);
			const compatible =
				envelope.owner.provider === facts.identity.provider &&
				envelope.owner.model === facts.identity.model &&
				envelope.owner.api === facts.identity.api;
			if (compatible) {
				replayedOwnerKeys.add(key);
				const hash = ownerHash(envelope.owner);
				if (!replayOpaqueStateOwners.includes(hash)) {
					replayOpaqueStateOwners.push(hash);
				}
			} else {
				notes.push(`opaque_state_owner_mismatch:${key}`);
			}
		}
	} else if (session.providerState.length > 0 && !opaqueReplayEnabled) {
		notes.push("opaque_state_native_replay_gate_off");
		// Incompatible or gated-off: keep envelopes in session state but do not replay.
		if (continuationMode === "provider_native") {
			continuationMode = "new_chain";
		}
	} else if (session.providerState.length > 0 && continuationMode !== "provider_native") {
		// State present but continuation not native → do not replay opaque payloads.
		notes.push("opaque_state_present_without_native_continuation");
	}

	let cacheMode = facts.cache.mode;
	let cacheOrdering = [...facts.cache.ordering];
	let cacheUsageObservable = facts.cache.usageObservable === true;

	if (gates.contextCache === false) {
		cacheMode = "none";
		cacheOrdering = [];
		cacheUsageObservable = false;
		notes.push("context_cache_gate_off");
	} else if (cacheMode === "unknown") {
		notes.push("cache_mode_unknown:no_claim");
		cacheUsageObservable = false;
		// Do not invent cache ordering parameters.
		cacheOrdering = [];
	}

	if (facts.cache.usageObservable === null && cacheMode !== "none") {
		cacheUsageObservable = false;
		notes.push("cache_usage_unobservable");
	}

	const checkpointPolicy = task.contextIntent.preserveUnresolvedState
		? "preserve_unresolved_verification_tool_pairs_opaque"
		: "standard_turn_boundary";

	return {
		policy: {
			stablePrefixOrder: [...STABLE_PREFIX_ORDER],
			checkpointPolicy,
			continuationMode,
			replayOpaqueStateOwners,
			cacheMode,
			cacheOrdering,
			cacheUsageObservable,
		},
		replayedOwnerKeys,
	};
}

function compileGuards(
	task: TaskRolePolicyV1,
	session: SessionPolicyStateV1,
	gates: ModelPolicyFeatureGates,
	tiny: boolean,
): RuntimeGuardPlanV1 {
	// Hard guards are permanent — feature gates cannot remove them.
	const hard: HardGuardId[] = [...HARD_GUARDS];

	const taskGuards: TaskGuardId[] = ["schema_output_validator", "unpaired_tool_call_result"];

	const hasExplicitObligations =
		session.unresolvedItems.some(i => i.status === "open" || i.status === "blocked") ||
		task.completionRequirements.requiredArtifacts.length > 0 ||
		task.completionRequirements.verificationRequired ||
		task.completionRequirements.scopeRequired;

	const completionGateActive = gates.runtimeCompletionGate !== false && hasExplicitObligations;

	if (completionGateActive) {
		if (session.unresolvedItems.some(i => i.status === "open" || i.status === "blocked")) {
			taskGuards.push("unresolved_items_must_close");
		}
		if (task.completionRequirements.requiredArtifacts.length > 0) {
			taskGuards.push("required_artifacts_must_present");
		}
		if (task.completionRequirements.verificationRequired) {
			taskGuards.push("verification_must_pass");
		}
		if (task.completionRequirements.scopeRequired) {
			taskGuards.push("scope_must_not_violate");
		}
	}

	if (tiny) {
		taskGuards.push("tiny_local_serial_tools", "tiny_local_minimal_allowlist");
	}

	return {
		hard,
		task: taskGuards,
		completionGateActive,
	};
}

function resolveCohortGate(gate: ModelPolicyFeatureGates["toolSurface"], cohort: string): boolean {
	if (typeof gate === "boolean") return gate;
	if (gate === undefined) return true;
	return gate[cohort] === true;
}

function buildLeverGates(
	gates: ModelPolicyFeatureGates,
	overlayId: string | null,
	cohort: string,
): Record<string, boolean> {
	const toolSurface = resolveCohortGate(gates.toolSurface, cohort);
	const structuredOutput = resolveCohortGate(gates.structuredOutput, cohort);
	const contextCache = resolveCohortGate(gates.contextCache, cohort);
	const leverGates: Record<string, boolean> = {
		"compiler.shadow": gates.compilerShadow === true,
		"compiler.active": gates.compilerActive !== false,
		"opaqueState.nativeReplay": gates.opaqueStateNativeReplay !== false,
		toolSurface,
		[`toolSurface.${cohort}`]: toolSurface,
		structuredOutput,
		[`structuredOutput.${cohort}`]: structuredOutput,
		contextCache,
		[`contextCache.${cohort}`]: contextCache,
		runtimeCompletionGate: gates.runtimeCompletionGate !== false,
	};
	if (overlayId) {
		leverGates[`promptOverlay.${overlayId}`] = gates.promptOverlay?.[overlayId] === true;
	}
	return leverGates;
}

function buildFactsProvenance(facts: ModelFactsV1): CompiledModelPolicyReceiptV1["factsProvenance"] {
	const source = facts.provenance.source;
	const version = facts.provenance.sourceVersion;
	const paths = ["identity", "reasoning", "tools", "structuredOutput", "context", "cache"] as const;
	return paths.map(path => ({ path, source, version }));
}

/**
 * Compile three policy inputs into one provider-executable policy.
 * Pure and deterministic. Hard guards always present.
 */
export function compileModelPolicy(input: CompileModelPolicyInput): CompiledModelPolicyV1 {
	const { modelFacts, taskPolicy, sessionState, semanticTools, featureGates } = input;
	const notes: string[] = [];
	const tiny = isTinyOrLocal(modelFacts);
	const cohort = `${modelFacts.identity.provider}/${modelFacts.identity.model}`;
	const effectiveFeatureGates: ModelPolicyFeatureGates = {
		...featureGates,
		toolSurface: resolveCohortGate(featureGates.toolSurface, cohort),
		structuredOutput: resolveCohortGate(featureGates.structuredOutput, cohort),
		contextCache: resolveCohortGate(featureGates.contextCache, cohort),
	};

	if (factsUnknownHeavy(modelFacts)) {
		notes.push("facts_unknown_heavy:conservative_fallback");
	}
	if (tiny) {
		notes.push("cohort_tiny_local:conservative");
	}

	// Conflict: session claims a different facts fingerprint than the active facts.
	const modelFactsFingerprint = fingerprintModelFacts(modelFacts);
	if (sessionState.activeModelFactsFingerprint && sessionState.activeModelFactsFingerprint !== modelFactsFingerprint) {
		notes.push("session_facts_fingerprint_conflict:using_active_facts");
	}

	const prompt = compilePrompt(taskPolicy, sessionState, effectiveFeatureGates, notes);
	const reasoning = compileReasoning(modelFacts, taskPolicy, notes);
	const tools = compileTools(modelFacts, taskPolicy, semanticTools, effectiveFeatureGates, tiny, notes);
	const output = compileOutput(modelFacts, taskPolicy, effectiveFeatureGates, tiny, notes);
	const { policy: contextAndCache, replayedOwnerKeys } = compileContextAndCache(
		modelFacts,
		taskPolicy,
		sessionState,
		effectiveFeatureGates,
		notes,
	);
	const guards = compileGuards(taskPolicy, sessionState, effectiveFeatureGates, tiny);

	const taskPolicyFingerprint = fingerprintTaskPolicy(taskPolicy);
	const sessionStateFingerprint = fingerprintSessionState(sessionState);

	const promptStableHash = sha256Hex(
		stableStringify({
			sharedContract: prompt.sharedContract,
			overlay: prompt.overlay,
			stableSections: prompt.stableSections,
		}),
	);
	const promptDynamicHash = sha256Hex(prompt.dynamicState);
	const toolSurfaceHash = sha256Hex(
		stableStringify({
			descriptors: tools.descriptors,
			presentationMode: tools.presentationMode,
			descriptorPlacement: tools.descriptorPlacement,
			strictArguments: tools.strictArguments,
			parallelCalls: tools.parallelCalls,
			streamingShape: tools.streamingShape,
			schemaDialect: tools.schemaDialect,
			maxConcurrentTools: tools.maxConcurrentTools,
		}),
	);

	const overlayId = taskPolicy.promptContract.overlayId ?? null;
	const leverGates = buildLeverGates(effectiveFeatureGates, overlayId, cohort);

	// Opaque receipt entries: owner/payload hash only — never payload body.
	const opaqueState = opaqueStateReceiptEntries(sessionState.providerState, replayedOwnerKeys);

	const guardIds = [...guards.hard, ...guards.task];

	const receipt: CompiledModelPolicyReceiptV1 = {
		schemaVersion: 1,
		compilerVersion: MODEL_POLICY_COMPILER_VERSION,
		modelFactsFingerprint,
		taskPolicyFingerprint,
		sessionStateFingerprint,
		overlayId: prompt.overlay ? overlayId : null,
		leverGates,
		promptStableHash,
		promptDynamicHash,
		toolSurfaceHash,
		outputTier: output.tier,
		reasoningParameters: reasoning.reasoningParameters,
		omittedIncompatibleParameters: reasoning.omittedIncompatibleParameters,
		opaqueState,
		guards: guardIds,
		factsProvenance: buildFactsProvenance(modelFacts),
		notes: [...notes].sort(),
	};

	return {
		schemaVersion: 1,
		prompt,
		reasoningAndSampling: {
			wireParameters: reasoning.wireParameters,
			replayMode: reasoning.replayMode,
			omittedIncompatibleParameters: reasoning.omittedIncompatibleParameters,
		},
		tools,
		output,
		contextAndCache,
		guards,
		receipt,
	};
}
