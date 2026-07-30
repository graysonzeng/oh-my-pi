import { describe, expect, it } from "bun:test";
import {
	type CompileModelPolicyInput,
	compileModelPolicy,
	fingerprintModelFacts,
	fingerprintSessionState,
	fingerprintTaskPolicy,
	MODEL_POLICY_COMPILER_VERSION,
	type ModelFactsV1,
	type ModelPolicyFeatureGates,
	opaqueStateReceiptEntries,
	ownerHash,
	type ProviderOpaqueStateEnvelope,
	payloadHash,
	type SemanticToolContract,
	type SessionPolicyStateV1,
	sha256Hex,
	stableStringify,
	type TaskRolePolicyV1,
} from "../../src/model-policy";

const HARD_GUARDS = [
	"provider_protocol_schema_validation",
	"unknown_malformed_tool_name_reject",
	"tool_permission_scope_conflict_budget",
	"repeated_identical_tool_call_detection",
	"gemini_reasoning_header_runaway_interrupt",
	"opaque_state_owner_integrity_replay_validation",
	"artifact_recovery_uri_readability",
] as const;

function baseFacts(overrides: Partial<ModelFactsV1> = {}): ModelFactsV1 {
	const base: ModelFactsV1 = {
		schemaVersion: 1,
		identity: {
			provider: "openai",
			model: "gpt-5",
			api: "responses",
			adapterVersion: "test-adapter-1",
			parserVersion: "test-parser-1",
		},
		reasoning: {
			mode: "native_opaque",
			replay: "provider_items",
			effortControl: "level",
			supportedEfforts: ["low", "medium", "high"],
			incompatibleParams: ["temperature"],
		},
		tools: {
			transport: "native",
			strictArguments: true,
			parallelCalls: true,
			streamingShape: "delta",
			schemaDialect: "openai-functions",
			descriptorPlacement: "provider_schema",
		},
		structuredOutput: {
			tier: "native_json_schema",
			constraints: ["additionalProperties=false"],
		},
		context: {
			windowTokens: 200_000,
			nativeStatefulContinuation: true,
		},
		cache: {
			mode: "exact_prefix",
			ordering: ["instructions", "tools", "messages"],
			usageObservable: true,
		},
		provenance: {
			source: "official_doc",
			sourceVersion: "2026-07-28",
		},
	};
	return {
		...base,
		...overrides,
		identity: { ...base.identity, ...overrides.identity },
		reasoning: { ...base.reasoning, ...overrides.reasoning },
		tools: { ...base.tools, ...overrides.tools },
		structuredOutput: { ...base.structuredOutput, ...overrides.structuredOutput },
		context: { ...base.context, ...overrides.context },
		cache: { ...base.cache, ...overrides.cache },
		provenance: { ...base.provenance, ...overrides.provenance },
	};
}

function baseTask(overrides: Partial<TaskRolePolicyV1> = {}): TaskRolePolicyV1 {
	const base: TaskRolePolicyV1 = {
		schemaVersion: 1,
		role: "interactive_coding",
		taskClass: "implement",
		risk: "medium",
		promptContract: {
			goal: "Implement the feature",
			constraints: ["do not touch unrelated files"],
			acceptance: ["focused tests pass"],
		},
		reasoningIntent: "balanced",
		toolIntent: {
			semanticToolIds: ["read", "edit", "bash"],
			allowParallelReadonly: true,
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
	return {
		...base,
		...overrides,
		promptContract: { ...base.promptContract, ...overrides.promptContract },
		toolIntent: { ...base.toolIntent, ...overrides.toolIntent },
		outputContract: { ...base.outputContract, ...overrides.outputContract },
		contextIntent: { ...base.contextIntent, ...overrides.contextIntent },
		completionRequirements: {
			...base.completionRequirements,
			...overrides.completionRequirements,
		},
	};
}

function baseSession(overrides: Partial<SessionPolicyStateV1> = {}): SessionPolicyStateV1 {
	const factsFp = fingerprintModelFacts(baseFacts());
	const base: SessionPolicyStateV1 = {
		schemaVersion: 1,
		activeModelFactsFingerprint: factsFp,
		turnOrStageId: "turn-1",
		unresolvedItems: [],
		requiredArtifactStatus: [],
		verificationEvidence: [],
		scopeStatus: "adhered",
		toolLedger: {
			calls: 0,
			retries: 0,
			duplicateReads: null,
			duplicateGreps: null,
		},
		providerState: [],
	};
	return {
		...base,
		...overrides,
		toolLedger: { ...base.toolLedger, ...overrides.toolLedger },
	};
}

const SEMANTIC_TOOLS: SemanticToolContract[] = [
	{
		id: "read",
		description: "Read a file",
		parametersSchema: { type: "object", properties: { path: { type: "string" } } },
		permission: "readonly",
	},
	{
		id: "edit",
		description: "Edit a file",
		parametersSchema: { type: "object", properties: { path: { type: "string" } } },
		permission: "write",
	},
	{
		id: "bash",
		description: "Run a shell command",
		parametersSchema: { type: "object", properties: { command: { type: "string" } } },
		permission: "admin",
	},
	{
		id: "grep",
		description: "Search files",
		parametersSchema: { type: "object", properties: { pattern: { type: "string" } } },
		permission: "readonly",
	},
];

function compile(
	partial: {
		modelFacts?: ModelFactsV1;
		taskPolicy?: TaskRolePolicyV1;
		sessionState?: SessionPolicyStateV1;
		semanticTools?: SemanticToolContract[];
		featureGates?: ModelPolicyFeatureGates;
	} = {},
) {
	const input: CompileModelPolicyInput = {
		modelFacts: partial.modelFacts ?? baseFacts(),
		taskPolicy: partial.taskPolicy ?? baseTask(),
		sessionState: partial.sessionState ?? baseSession(),
		semanticTools: partial.semanticTools ?? SEMANTIC_TOOLS,
		featureGates: partial.featureGates ?? {},
	};
	return compileModelPolicy(input);
}

describe("compileModelPolicy", () => {
	it("is deterministic for identical inputs", () => {
		const a = compile();
		const b = compile();
		expect(stableStringify(a)).toBe(stableStringify(b));
		expect(a.receipt.modelFactsFingerprint).toBe(b.receipt.modelFactsFingerprint);
		expect(a.receipt.taskPolicyFingerprint).toBe(b.receipt.taskPolicyFingerprint);
		expect(a.receipt.sessionStateFingerprint).toBe(b.receipt.sessionStateFingerprint);
		expect(a.receipt.compilerVersion).toBe(MODEL_POLICY_COMPILER_VERSION);
	});

	it("compiles known GPT-like facts into native tiers and effort wire params", () => {
		const policy = compile({
			taskPolicy: baseTask({
				reasoningIntent: "deep",
				outputContract: {
					kind: "typed_artifact",
					schema: { type: "object", properties: { ok: { type: "boolean" } } },
				},
			}),
		});

		expect(policy.reasoningAndSampling.wireParameters.reasoning_effort).toBe("high");
		expect(policy.reasoningAndSampling.omittedIncompatibleParameters).toContain("temperature");
		expect(policy.reasoningAndSampling.replayMode).toBe("provider_items");
		expect(policy.tools.strictArguments).toBe(true);
		expect(policy.tools.parallelCalls).toBe(true);
		expect(policy.tools.descriptorPlacement).toBe("provider_schema");
		expect(policy.tools.streamingShape).toBe("delta");
		expect(policy.tools.schemaDialect).toBe("openai-functions");
		expect(policy.output.tier).toBe("native_json_schema");
		expect(policy.output.hostValidationRequired).toBe(true);
		expect(policy.output.wireSchema).toEqual({
			type: "object",
			properties: { ok: { type: "boolean" } },
		});
		expect(policy.contextAndCache.continuationMode).toBe("provider_native");
		expect(policy.contextAndCache.cacheMode).toBe("exact_prefix");
		expect(policy.contextAndCache.cacheUsageObservable).toBe(true);
		expect(policy.contextAndCache.stablePrefixOrder).toEqual([
			"system_static",
			"role_policy",
			"tool_presentation",
			"skill_catalog",
		]);
	});

	it("omits unknown reasoning wire params and degrades tools/output conservatively", () => {
		const policy = compile({
			modelFacts: baseFacts({
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
				structuredOutput: { tier: "unknown", constraints: [] },
				context: { windowTokens: null, nativeStatefulContinuation: null },
				cache: { mode: "unknown", ordering: ["tools"], usageObservable: null },
			}),
			taskPolicy: baseTask({ reasoningIntent: "deep" }),
		});

		expect(policy.reasoningAndSampling.wireParameters).toEqual({});
		expect(policy.reasoningAndSampling.replayMode).toBe("none");
		expect(policy.reasoningAndSampling.omittedIncompatibleParameters).toContain("reasoning_effort");
		expect(policy.tools.strictArguments).toBe(false);
		expect(policy.tools.parallelCalls).toBe(false);
		expect(policy.tools.maxConcurrentTools).toBe(1);
		expect(policy.tools.streamingShape).toBe("whole_call");
		expect(policy.tools.descriptorPlacement).toBe("system_inline");
		expect(policy.output.tier).toBe("text_repair");
		expect(policy.output.hostValidationRequired).toBe(true);
		expect(policy.contextAndCache.continuationMode).toBe("new_chain");
		expect(policy.contextAndCache.cacheUsageObservable).toBe(false);
		expect(policy.contextAndCache.cacheOrdering).toEqual([]);
		expect(policy.receipt.notes.some(n => n.includes("unknown"))).toBe(true);
	});

	it("records session/facts fingerprint conflicts without inventing OpenAI defaults", () => {
		const policy = compile({
			sessionState: baseSession({ activeModelFactsFingerprint: "stale-fingerprint" }),
			modelFacts: baseFacts({
				tools: {
					transport: "unknown",
					strictArguments: null,
					parallelCalls: false,
					streamingShape: "unknown",
					schemaDialect: null,
					descriptorPlacement: "unknown",
				},
			}),
		});
		expect(policy.receipt.notes).toContain("session_facts_fingerprint_conflict:using_active_facts");
		expect(policy.tools.parallelCalls).toBe(false);
		expect(policy.tools.strictArguments).toBe(false);
	});

	it("consumes every ModelFactsV1 capability field into compiled policy", () => {
		const facts = baseFacts({
			reasoning: {
				mode: "native_opaque",
				replay: "signed_blocks",
				effortControl: "budget",
				supportedEfforts: ["1024", "4096", "8192"],
				incompatibleParams: ["top_p", "temperature"],
			},
			tools: {
				transport: "template",
				strictArguments: false,
				parallelCalls: true,
				streamingShape: "whole_call",
				schemaDialect: "hermes",
				descriptorPlacement: "system_inline",
			},
			structuredOutput: { tier: "valid_json", constraints: ["no_empty"] },
			context: { windowTokens: 32_000, nativeStatefulContinuation: false },
			cache: {
				mode: "conversation_affinity",
				ordering: ["system", "messages"],
				usageObservable: false,
			},
		});
		const policy = compile({
			modelFacts: facts,
			taskPolicy: baseTask({
				reasoningIntent: "fast",
				toolIntent: { semanticToolIds: ["read", "grep"], allowParallelReadonly: true },
				outputContract: { kind: "typed_artifact", schema: { type: "object" } },
			}),
		});

		// reasoning.mode/replay/effortControl/supportedEfforts/incompatibleParams
		expect(policy.reasoningAndSampling.replayMode).toBe("signed_blocks");
		expect(policy.reasoningAndSampling.wireParameters.thinking_budget).toBe(1024);
		expect(policy.reasoningAndSampling.omittedIncompatibleParameters).toEqual(
			expect.arrayContaining(["temperature", "top_p"]),
		);

		// tools.*
		expect(policy.tools.descriptors[0]?.transport).toBe("template");
		expect(policy.tools.strictArguments).toBe(false);
		expect(policy.tools.parallelCalls).toBe(true);
		expect(policy.tools.streamingShape).toBe("whole_call");
		expect(policy.tools.schemaDialect).toBe("hermes");
		expect(policy.tools.descriptorPlacement).toBe("system_inline");

		// structuredOutput
		expect(policy.output.tier).toBe("valid_json");
		expect(policy.receipt.notes.some(n => n.includes("structured_constraints:no_empty"))).toBe(true);

		// context
		expect(policy.contextAndCache.continuationMode).toBe("replay_messages");

		// cache
		expect(policy.contextAndCache.cacheMode).toBe("conversation_affinity");
		expect(policy.contextAndCache.cacheOrdering).toEqual(["system", "messages"]);
		expect(policy.contextAndCache.cacheUsageObservable).toBe(false);

		// identity+provenance land in receipt fingerprints/provenance, not inert
		expect(policy.receipt.modelFactsFingerprint).toBe(fingerprintModelFacts(facts));
		expect(policy.receipt.factsProvenance).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "reasoning", source: "official_doc" }),
				expect.objectContaining({ path: "tools", source: "official_doc" }),
				expect.objectContaining({ path: "cache", source: "official_doc" }),
			]),
		);
	});

	it("omits level/budget wire params when supportedEfforts cannot prove a value", () => {
		const levelNoSupport = compile({
			modelFacts: baseFacts({
				reasoning: {
					mode: "native_opaque",
					replay: "provider_items",
					effortControl: "level",
					supportedEfforts: [],
					incompatibleParams: [],
				},
			}),
			taskPolicy: baseTask({ reasoningIntent: "deep" }),
		});
		expect(levelNoSupport.reasoningAndSampling.wireParameters).toEqual({});
		expect(levelNoSupport.receipt.notes).toContain("effort_level_no_supported_efforts:omit_effort");

		const budgetNonNumeric = compile({
			modelFacts: baseFacts({
				reasoning: {
					mode: "native_opaque",
					replay: "provider_items",
					effortControl: "budget",
					supportedEfforts: ["low", "medium", "high"],
					incompatibleParams: [],
				},
			}),
			taskPolicy: baseTask({ reasoningIntent: "balanced" }),
		});
		expect(budgetNonNumeric.reasoningAndSampling.wireParameters).toEqual({});
		expect(budgetNonNumeric.receipt.notes).toContain("effort_budget_no_supported_numeric:omit_budget");
	});

	it("intersects parallel tool calls with task intent and forces serial when facts deny", () => {
		const denied = compile({
			modelFacts: baseFacts({
				tools: {
					transport: "native",
					strictArguments: true,
					parallelCalls: false,
					streamingShape: "delta",
					schemaDialect: "openai-functions",
					descriptorPlacement: "provider_schema",
				},
			}),
			taskPolicy: baseTask({
				toolIntent: { semanticToolIds: ["read", "grep"], allowParallelReadonly: true },
			}),
		});
		expect(denied.tools.parallelCalls).toBe(false);
		expect(denied.tools.maxConcurrentTools).toBe(1);

		const taskDenies = compile({
			taskPolicy: baseTask({
				toolIntent: { semanticToolIds: ["read", "grep"], allowParallelReadonly: false },
			}),
		});
		expect(taskDenies.tools.parallelCalls).toBe(false);
	});

	it("degrades structured output by facts tier and always requires host validation", () => {
		const tiers = [
			["native_json_schema", "native_json_schema"],
			["strict_tool", "strict_tool"],
			["valid_json", "valid_json"],
			["text", "text_repair"],
			["unknown", "text_repair"],
		] as const;

		for (const [factsTier, expected] of tiers) {
			const policy = compile({
				modelFacts: baseFacts({
					structuredOutput: { tier: factsTier, constraints: [] },
				}),
				taskPolicy: baseTask({
					outputContract: { kind: "typed_artifact", schema: { type: "object" } },
				}),
			});
			expect(policy.output.tier).toBe(expected);
			expect(policy.output.hostValidationRequired).toBe(true);
		}
	});

	it("keeps hard guards online even when every lever feature gate is off", () => {
		const policy = compile({
			featureGates: {
				compilerActive: false,
				opaqueStateNativeReplay: false,
				toolSurface: false,
				structuredOutput: false,
				contextCache: false,
				runtimeCompletionGate: false,
				promptOverlay: { "explicit-grok": false },
			},
			taskPolicy: baseTask({
				promptContract: {
					goal: "x",
					constraints: [],
					acceptance: [],
					overlayId: "explicit-grok",
				},
				completionRequirements: {
					requiredArtifacts: ["plan"],
					verificationRequired: true,
					scopeRequired: true,
				},
			}),
			sessionState: baseSession({
				unresolvedItems: [{ id: "t1", kind: "todo", status: "open" }],
			}),
		});

		for (const guard of HARD_GUARDS) {
			expect(policy.guards.hard).toContain(guard);
			expect(policy.receipt.guards).toContain(guard);
		}
		// Feature gates cannot remove hard guards; completion gate may be off.
		expect(policy.guards.completionGateActive).toBe(false);
		expect(policy.prompt.overlay).toBeNull();
		expect(policy.output.tier).toBe("text_repair");
		expect(policy.contextAndCache.cacheMode).toBe("none");
		expect(policy.contextAndCache.cacheUsageObservable).toBe(false);
	});

	it("isolates rollout levers by exact cohort key", () => {
		const cohort = "openai/gpt-5";
		const allowed = compile({
			featureGates: {
				toolSurface: { [cohort]: true },
				structuredOutput: { [cohort]: true },
				contextCache: { [cohort]: true },
			},
		});
		expect(allowed.output.tier).toBe("valid_json");
		expect(allowed.contextAndCache.cacheMode).toBe("exact_prefix");
		expect(allowed.receipt.leverGates[`structuredOutput.${cohort}`]).toBe(true);

		const blocked = compile({
			featureGates: {
				toolSurface: { "anthropic/claude": true },
				structuredOutput: { "anthropic/claude": true },
				contextCache: { "anthropic/claude": true },
			},
		});
		expect(blocked.output.tier).toBe("text_repair");
		expect(blocked.contextAndCache.cacheMode).toBe("none");
		expect(blocked.receipt.leverGates[`structuredOutput.${cohort}`]).toBe(false);
	});

	it("activates completion task guards only for explicit obligations", () => {
		const withObligations = compile({
			taskPolicy: baseTask({
				completionRequirements: {
					requiredArtifacts: ["diff"],
					verificationRequired: true,
					scopeRequired: true,
				},
			}),
			sessionState: baseSession({
				unresolvedItems: [{ id: "u1", kind: "todo", status: "open" }],
				requiredArtifactStatus: [{ kind: "diff", present: false }],
			}),
		});
		expect(withObligations.guards.completionGateActive).toBe(true);
		expect(withObligations.guards.task).toEqual(
			expect.arrayContaining([
				"unresolved_items_must_close",
				"required_artifacts_must_present",
				"verification_must_pass",
				"scope_must_not_violate",
			]),
		);

		const plainChat = compile();
		expect(plainChat.guards.completionGateActive).toBe(false);
		expect(plainChat.guards.task).not.toContain("unresolved_items_must_close");
	});

	it("uses tiny/local conservative fallback: serial tools, minimal allowlist, no native schema claim", () => {
		const policy = compile({
			modelFacts: baseFacts({
				identity: {
					provider: "ollama",
					model: "tinyllama",
					api: "ollama-local",
					adapterVersion: "local-1",
				},
				reasoning: {
					mode: "unknown",
					replay: "none",
					effortControl: "unknown",
					supportedEfforts: [],
					incompatibleParams: [],
				},
				tools: {
					transport: "unknown",
					strictArguments: null,
					parallelCalls: true,
					streamingShape: "unknown",
					schemaDialect: null,
					descriptorPlacement: "unknown",
				},
				structuredOutput: { tier: "unknown", constraints: [] },
				context: { windowTokens: 4096, nativeStatefulContinuation: false },
				cache: { mode: "unknown", ordering: [], usageObservable: null },
			}),
			taskPolicy: baseTask({
				toolIntent: {
					semanticToolIds: ["read", "edit", "bash", "grep"],
					allowParallelReadonly: true,
				},
				outputContract: { kind: "typed_artifact", schema: { type: "object" } },
			}),
		});

		expect(policy.tools.parallelCalls).toBe(false);
		expect(policy.tools.maxConcurrentTools).toBe(1);
		expect(policy.tools.descriptors.every(d => d.permission === "readonly")).toBe(true);
		expect(policy.tools.descriptors.length).toBeLessThanOrEqual(4);
		expect(policy.output.tier).toBe("text_repair");
		expect(policy.guards.task).toEqual(
			expect.arrayContaining(["tiny_local_serial_tools", "tiny_local_minimal_allowlist"]),
		);
		expect(policy.receipt.notes).toContain("cohort_tiny_local:conservative");
	});

	it("replays opaque state only for matching owner and never embeds payload in receipt", () => {
		const secretPayload = { thought: "do-not-leak", signature: "sig-abc" };
		const matching: ProviderOpaqueStateEnvelope = {
			schemaVersion: 1,
			owner: { provider: "openai", model: "gpt-5", api: "responses" },
			kind: "openai_reasoning_item",
			payload: secretPayload,
			integrity: { byteHash: "deadbeef", encoding: "provider_native_object" },
			replay: "required_with_tool_result",
		};
		const foreign: ProviderOpaqueStateEnvelope = {
			schemaVersion: 1,
			owner: { provider: "anthropic", model: "claude-4", api: "messages" },
			kind: "anthropic_thinking_block",
			payload: { thinking: "also-secret" },
			integrity: { byteHash: "cafebabe", encoding: "provider_native_object" },
			replay: "required_full_turn",
		};

		const policy = compile({
			sessionState: baseSession({ providerState: [matching, foreign] }),
		});

		expect(policy.contextAndCache.replayOpaqueStateOwners).toEqual([ownerHash(matching.owner)]);
		expect(policy.receipt.opaqueState).toHaveLength(2);
		expect(policy.receipt.opaqueState[0]).toEqual({
			kind: "openai_reasoning_item",
			ownerHash: ownerHash(matching.owner),
			payloadHash: payloadHash(matching),
			replayed: true,
		});
		expect(policy.receipt.opaqueState[1]?.replayed).toBe(false);

		const receiptJson = stableStringify(policy.receipt);
		expect(receiptJson).not.toContain("do-not-leak");
		expect(receiptJson).not.toContain("also-secret");
		expect(receiptJson).not.toContain("sig-abc");

		// Opaque helper also omits payload body.
		const entries = opaqueStateReceiptEntries(
			[matching],
			new Set([`${matching.owner.provider}|${matching.owner.model}|${matching.owner.api}`]),
		);
		expect(entries[0]?.payloadHash).toBe(payloadHash(matching));
		expect(stableStringify(entries)).not.toContain("do-not-leak");
	});

	it("omits effort wire params when facts mark effort uncontrollable despite deep intent", () => {
		const policy = compile({
			modelFacts: baseFacts({
				reasoning: {
					mode: "native_opaque",
					replay: "none",
					effortControl: "none",
					supportedEfforts: [],
					incompatibleParams: ["reasoning_effort", "temperature"],
				},
			}),
			taskPolicy: baseTask({ reasoningIntent: "deep" }),
		});
		expect(policy.reasoningAndSampling.wireParameters).toEqual({});
		expect(policy.reasoningAndSampling.omittedIncompatibleParameters).toEqual(
			expect.arrayContaining(["reasoning_effort", "temperature"]),
		);
		expect(policy.receipt.notes).toContain("effort_control_none:omit_effort");
	});

	it("fingerprints inputs independently and stably", () => {
		const facts = baseFacts();
		const task = baseTask();
		const session = baseSession();
		expect(fingerprintModelFacts(facts)).toBe(fingerprintModelFacts(facts));
		expect(fingerprintTaskPolicy(task)).toBe(fingerprintTaskPolicy(task));
		expect(fingerprintSessionState(session)).toBe(fingerprintSessionState(session));
		expect(fingerprintModelFacts(facts)).not.toBe(fingerprintTaskPolicy(task));
		expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
		expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
	});

	it("includes dynamic unresolved state in prompt dynamic capsule and receipt hash", () => {
		const a = compile({
			sessionState: baseSession({
				unresolvedItems: [{ id: "todo-1", kind: "todo", status: "open" }],
				scopeStatus: "warning",
			}),
		});
		const b = compile({
			sessionState: baseSession({
				unresolvedItems: [],
				scopeStatus: "adhered",
			}),
		});
		expect(a.prompt.dynamicState).toContain("todo-1");
		expect(a.prompt.dynamicState).toContain("Scope: warning");
		expect(a.receipt.promptDynamicHash).not.toBe(b.receipt.promptDynamicHash);
		expect(a.receipt.sessionStateFingerprint).not.toBe(b.receipt.sessionStateFingerprint);
	});

	it("selects only task-allowlisted semantic tools", () => {
		const policy = compile({
			taskPolicy: baseTask({
				toolIntent: { semanticToolIds: ["read", "grep"], allowParallelReadonly: true },
			}),
		});
		expect(policy.tools.descriptors.map(d => d.id).sort()).toEqual(["grep", "read"]);
	});

	it("keeps compiler shadowed unless one explicit supported lever is selected", () => {
		const implicit = compile({ featureGates: { compilerActive: true } });
		const concurrency = compile({
			featureGates: { compilerActive: true, activeLever: "tool_concurrency_ceiling" },
		});
		const descriptor = compile({
			featureGates: { compilerActive: true, activeLever: "descriptor_placement" },
		});

		expect(implicit.receipt.leverGates["compiler.active"]).toBe(false);
		expect(implicit.receipt.activeLever).toBeNull();
		expect(implicit.receipt.notes).toContain("compiler_active_without_single_lever:shadow");
		expect(concurrency.receipt.leverGates["compiler.active"]).toBe(true);
		expect(concurrency.receipt.activeLever).toBe("tool_concurrency_ceiling");
		expect(descriptor.receipt.activeLever).toBe("descriptor_placement");
	});

	it("keeps catalog, overlay, and cache levers disabled when their gates lack evidence", () => {
		const policy = compile({
			taskPolicy: baseTask({
				promptContract: {
					goal: "Implement the feature",
					constraints: [],
					acceptance: [],
					overlayId: "needs_explicit_completion",
				},
			}),
			featureGates: {
				compilerShadow: true,
				compilerActive: false,
				toolSurface: false,
				contextCache: false,
				promptOverlay: { needs_explicit_completion: false },
			},
		});

		expect(policy.tools.presentationMode).toBe("direct");
		expect(policy.prompt.overlay).toBeNull();
		expect(policy.contextAndCache.cacheMode).toBe("none");
		expect(policy.receipt.leverGates["toolSurface.openai/gpt-5"]).toBe(false);
		expect(policy.receipt.leverGates["promptOverlay.needs_explicit_completion"]).toBe(false);
	});
});
