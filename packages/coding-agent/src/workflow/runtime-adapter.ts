import type { SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai";
import type { SubagentCompletionKind } from "../task/types";
import type { ToolSession } from "../tools";
import { withContextProviderUsage } from "./context-ledger";
import {
	BudgetExhaustedError,
	WorkflowCancelledError,
	WorkflowError,
	WorkflowPolicyError,
	WorkflowSchemaError,
	WorkflowTimeoutError,
} from "./errors";
import {
	assertStrictRuntimeIdentity,
	buildRuntimeIdentityReceipt,
	ProviderIdentityCollector,
} from "./identity-receipt";
import { sha256Hex } from "./optimization-receipt";
import { withProviderCacheMetrics } from "./prompt-assembly";
import {
	optimizeWorkflowRequestContext,
	type PreparedWorkflowInvocation,
	prepareWorkflowInvocation,
} from "./runtime-invocation";
import type { ToolDescriptor } from "./schema-enhancer";
import {
	boundOutputFragment,
	budgetBlockReason,
	budgetFromProfileUsage,
	defaultSchemaValidator,
	renderSchemaRetryPrompt,
	repairStructuredOutput,
	SCHEMA_REPAIR_RECEIPT_KIND,
	SCHEMA_REPAIR_RECEIPT_VERSION,
	type SchemaRepairAttempt,
	type SchemaRepairFinalStatus,
	type SchemaRepairReceiptV1,
	type SchemaViolationRecord,
	type StructuredRepairBudget,
	schemaFieldsSummary,
	schemaTypeName,
	totalSchemaModelAttempts,
} from "./structured-output-repair";
import type {
	CapturedChangesMerger,
	RuntimePort,
	WorkflowAgentRequest,
	WorkflowAgentResult,
	WorkflowErrorKind,
	WorkflowIsolationControls,
	WorkflowRuntimeIdentityReceiptV1,
} from "./types";

/** Minimal request shape accepted by the injectable structured runner. */
export interface StructuredRunnerRequest {
	session: ToolSession;
	invocationKind: "task" | "eval";
	assignment: string;
	context?: string;
	workflowRole?: WorkflowAgentRequest["role"];
	agent?: string;
	model?: string | string[];
	thinkingLevel?: WorkflowAgentRequest["profile"]["thinkingLevel"];
	outputSchema?: unknown;
	schemaMode?: "permissive" | "strict";
	isolation?: WorkflowIsolationControls;
	maxRuntimeMs?: number;
	signal?: AbortSignal;
	/** Provider response observer used to collect execution identity attestation. */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Disable every inner model replacement path for exact-identity execution. */
	strictModelIdentity?: boolean;
	/** When true, task runtime keeps isolation artifacts for verification. */
	retainArtifacts?: boolean;
	/** Used to place durable patch copies under workflow artifact storage. */
	workflowId?: string;
	attemptId?: string;
	/** Scoped tool allowlist forwarded to structured-subagent. */
	allowedTools?: readonly string[];
	/**
	 * Per-model tool-result post-processor (truncation/summarization).
	 * Also installed on session.workflowToolOptimization for the live tool path.
	 */
	processToolResult?: (toolName: string, output: string, args?: unknown) => string;
	/** Remap tool descriptors (aliases) for the model wire surface. */
	transformTools?: (tools: ToolDescriptor[]) => ToolDescriptor[];
	/** Devflow plan/code review requests `shadowReview: "code"`. */
	shadowReview?: "code" | "off";
}

/** Minimal shape returned by runStructuredSubagent — kept local so pure tests need no natives. */
export interface StructuredRunnerResult {
	result: {
		id: string;
		structuredOutput?: {
			status: "valid" | "invalid" | string;
			data?: unknown;
			error?: string;
		};
		/**
		 * Invalid or pre-validation raw model text when available.
		 * Used by deterministic schema repair (BOM/fence/single-object extract).
		 */
		rawOutput?: string;
		patchPath?: string;
		branchName?: string;
		usage?: Usage;
		exitCode?: number;
		error?: string;
		aborted?: boolean;
		/** Present when aborted — distinguishes wall-clock maxRuntime from parent cancel. */
		abortReason?: string;
		resolvedModel?: string;
		toolCalls?: number;
		/** Terminal provenance forwarded from SingleResult. */
		completionKind?: SubagentCompletionKind;
	};
	/** Whether isolated changes were applied to the main worktree. null when N/A. */
	changesApplied?: boolean | null;
	mergeSummary?: string;
}

export type StructuredRunner = (request: StructuredRunnerRequest) => Promise<StructuredRunnerResult>;

/**
 * Map workflow roles onto registered bundled agents.
 * Workflow roles are policy names; task runtime only knows bundled agent names.
 */
export const WORKFLOW_ROLE_TO_AGENT: Readonly<Record<WorkflowAgentRequest["role"], string>> = {
	planner: "designer",
	plan_reviewer: "reviewer",
	plan_arbitrator: "reviewer",
	implementer: "task",
	code_reviewer: "reviewer",
	repair: "task",
};

export interface PipelineReviewAgentOpts {
	pipelineKind?: "devflow";
	authorModelFamily?: string | null;
	reviewerModel?: string | string[] | null;
	preferredReviewer?: "subagent-sol" | "subagent-grok";
}

/** Devflow review agent follows the selected profile model; grok never reviews grok-authored work. */
export function resolvePipelineReviewAgent(role: WorkflowAgentRequest["role"], opts?: PipelineReviewAgentOpts): string {
	if (opts?.pipelineKind === "devflow" && (role === "plan_reviewer" || role === "code_reviewer")) {
		const reviewerModel =
			typeof opts.reviewerModel === "string" ? opts.reviewerModel : (opts.reviewerModel?.join(" ") ?? "");
		const reviewer = reviewerModel.toLowerCase();
		const authorGrok = (opts.authorModelFamily ?? "").toLowerCase().includes("grok");
		if ((reviewer.includes("grok") || (!reviewer && opts.preferredReviewer === "subagent-grok")) && !authorGrok) {
			return "subagent-grok";
		}
		if (reviewer.includes("claude")) return "claude-opus-5-thinking-high";
		return "subagent-sol";
	}
	return WORKFLOW_ROLE_TO_AGENT[role] ?? "task";
}

function resolvePipelineReviewModel(agentName: string, modelPattern: string | string[]): string | string[] {
	const patterns = Array.isArray(modelPattern) ? modelPattern : [modelPattern];
	const marker =
		agentName === "subagent-sol"
			? "sol"
			: agentName === "subagent-grok"
				? "grok"
				: agentName.includes("claude")
					? "claude"
					: "";
	if (!marker) return modelPattern;
	const matching = patterns.filter(pattern => pattern.toLowerCase().includes(marker));
	if (matching.length === 0) {
		throw new WorkflowPolicyError("review_agent_model_mismatch", { agentName, modelPattern: patterns });
	}
	return Array.isArray(modelPattern) ? matching : matching[0]!;
}

// Re-export preparation helpers so existing imports keep working.
export { injectWorkflowPrompt, wrapSessionForWorkflowIsolation } from "./runtime-invocation";

/**
 * Sole workflow module allowed to call the structured runner port.
 */
export class RuntimeAdapter implements RuntimePort {
	readonly #runner: StructuredRunner;
	readonly mergeCapturedChanges?: CapturedChangesMerger;

	constructor(runner: StructuredRunner, mergeCapturedChanges?: CapturedChangesMerger) {
		this.#runner = runner;
		this.mergeCapturedChanges = mergeCapturedChanges;
	}

	buildRequest(request: WorkflowAgentRequest): WorkflowAgentRequest {
		return request;
	}

	static agentNameForRole(role: WorkflowAgentRequest["role"], opts?: PipelineReviewAgentOpts): string {
		return resolvePipelineReviewAgent(role, opts);
	}

	async run<TArtifact = unknown>(request: WorkflowAgentRequest): Promise<WorkflowAgentResult<TArtifact>> {
		const retry = request.profile.outputStrategy?.retryOnSchemaViolation;
		// maxRetries = additional model calls after the first (total = 1 + maxRetries).
		const maxRetries = retry?.enabled ? Math.max(0, retry.maxRetries) : 0;
		const maxAttempts = retry?.enabled ? totalSchemaModelAttempts(maxRetries) : 1;
		let working: WorkflowAgentRequest = request;
		let lastSchemaError: WorkflowSchemaError | undefined;
		/** Accumulates L1 per-invocation receipts across outer model attempts (Layer 3/4). */
		let accumulated = emptySchemaRepairReceipt(maxRetries);
		let usedCostUsd = 0;
		const startedAt = Date.now();
		let accumulatedUsage: Usage | undefined;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				// Carry remaining wall-clock budget into each schema retry invocation.
				const elapsedMs = Date.now() - startedAt;
				const profileMax = request.profile.maxRuntimeMs;
				const remainingRuntime =
					typeof profileMax === "number" && profileMax > 0 ? Math.max(1, profileMax - elapsedMs) : undefined;
				const attemptRequest =
					remainingRuntime !== undefined
						? {
								...working,
								profile: { ...working.profile, maxRuntimeMs: remainingRuntime },
							}
						: working;
				const result = await this.#runOnce<TArtifact>(attemptRequest, {
					schemaRetryMaxRetries: maxRetries,
				});
				accumulatedUsage = mergeUsage(accumulatedUsage, result.usage as Usage | undefined);
				// Layer1 deterministic success on this invocation.
				if (result.schemaRepairReceipt) {
					const r = result.schemaRepairReceipt as SchemaRepairReceiptV1;
					if (r.finalStatus === "repaired_layer1" || r.layer1Success) {
						// First-call L1 only: no prior schema failures, zero model-retry calls.
						if (attempt === 0) {
							return {
								...result,
								schemaRepairReceipt: finalizeSchemaRepairReceipt(r, {
									maxRetries,
									modelCalls: 0,
									finalStatus: "repaired_layer1",
									repaired: true,
									layer1Success: true,
									layer3RetryCount: 0,
								}),
							};
						}
						// Prior failures + this invocation fixed via L1 (fence/BOM/prose):
						// keep accumulated violation history; status is layer3 path (model retries ran).
						const merged = mergeSchemaRepairReceipt(accumulated, r, attempt, maxRetries, {
							modelCalls: attempt + 1,
							finalStatus: "repaired_layer3",
							repaired: true,
						});
						return {
							...result,
							usage: accumulatedUsage ?? result.usage,
							schemaRepairReceipt: finalizeSchemaRepairReceipt(merged, {
								maxRetries,
								modelCalls: attempt + 1,
								finalStatus: "repaired_layer3",
								repaired: true,
								// Final fix was deterministic extract on the latest raw.
								layer1Success: true,
								layer3RetryCount: attempt,
							}),
						};
					}
				}
				// Structured-valid success after prior schema failures (no L1 receipt on this call).
				// modelCalls = total runner invocations on the schema path (first + retries).
				if (attempt > 0) {
					return {
						...result,
						usage: accumulatedUsage ?? result.usage,
						schemaRepairReceipt: finalizeSchemaRepairReceipt(accumulated, {
							maxRetries,
							modelCalls: attempt + 1,
							finalStatus: "repaired_layer3",
							repaired: true,
							layer1Success: false,
							layer3RetryCount: attempt,
						}),
					};
				}
				return { ...result, usage: accumulatedUsage ?? result.usage };
			} catch (error) {
				const normalized = this.#normalizeError(error);
				if (!(normalized instanceof WorkflowSchemaError)) {
					throw normalized;
				}
				lastSchemaError = normalized;
				const details = normalized.details as
					| { schemaRepairReceipt?: SchemaRepairReceiptV1; usage?: Usage; rawOutput?: string }
					| undefined;
				// Fold this invocation's L1 receipt (or synthetic failure) into multi-attempt history.
				accumulated = mergeSchemaRepairReceipt(accumulated, details?.schemaRepairReceipt, attempt, maxRetries, {
					modelCalls: attempt + 1,
					finalStatus: "schema_error",
					repaired: false,
					fallbackError: normalized.message,
					fallbackRaw:
						typeof details?.rawOutput === "string" && details.rawOutput.length > 0
							? details.rawOutput
							: normalized.message,
				});
				accumulatedUsage = mergeUsage(accumulatedUsage, details?.usage);
				const usageCost = details?.usage?.cost?.total;
				if (typeof usageCost === "number") usedCostUsd += usageCost;

				// No more additional model attempts left → Layer 4 full receipt.
				if (attempt >= maxAttempts - 1) {
					throw withSchemaRepairDetails(
						normalized,
						finalizeSchemaRepairReceipt(accumulated, {
							maxRetries,
							modelCalls: attempt + 1,
							finalStatus: "schema_error",
							repaired: false,
							layer3RetryCount: Math.max(0, attempt),
						}),
					);
				}

				// Layer 2: budget check before every model retry (request / cost / runtime).
				const budget = budgetFromProfileUsage({
					maxRequests: Math.min(request.profile.maxRequests, maxAttempts),
					maxCostUsd: request.profile.maxCostUsd,
					maxRuntimeMs: request.profile.maxRuntimeMs,
					usedRequests: attempt + 1,
					usedCostUsd,
					elapsedMs: Date.now() - startedAt,
				});
				const remainingSchemaSlots = maxAttempts - attempt - 1;
				const effectiveBudget: StructuredRepairBudget = {
					...budget,
					remainingModelCalls:
						typeof budget.remainingModelCalls === "number"
							? Math.min(budget.remainingModelCalls, remainingSchemaSlots)
							: remainingSchemaSlots,
				};
				const blocked = budgetBlockReason(effectiveBudget);
				if (blocked) {
					const exhausted = finalizeSchemaRepairReceipt(accumulated, {
						maxRetries,
						modelCalls: attempt + 1,
						finalStatus: "budget_exhausted",
						repaired: false,
						budgetExhausted: true,
						budgetExhaustedReason: blocked,
						layer3RetryCount: Math.max(0, attempt),
						extraAttempt: {
							attemptIndex: attempt,
							phase: "model_retry",
							inputSha256: sha256Hex(normalized.message),
							ok: false,
							error: `budget exhausted before retry: ${blocked}`,
							outputPreview: boundOutputFragment(normalized.message),
						},
					});
					throw withSchemaRepairDetails(normalized, exhausted);
				}

				if (retry?.includeErrorInRetry) {
					const rawPreview =
						typeof details?.rawOutput === "string" && details.rawOutput.length > 0
							? details.rawOutput
							: normalized.message;
					const hint = renderSchemaRetryPrompt({
						violation: normalized.message,
						schemaTypeName: schemaTypeName(working.outputSchema),
						schemaFields: schemaFieldsSummary(working.outputSchema),
						previousOutputPreview: boundOutputFragment(rawPreview),
						attemptNumber: attempt + 1,
					});
					working = {
						...working,
						context: `${working.context?.trim() ?? ""}\n\n${hint}`,
					};
				}
			}
		}

		throw withSchemaRepairDetails(
			lastSchemaError ?? new WorkflowSchemaError("schema retry exhausted"),
			finalizeSchemaRepairReceipt(accumulated, {
				maxRetries,
				modelCalls: maxAttempts,
				finalStatus: "schema_error",
				repaired: false,
			}),
		);
	}

	/**
	 * Repair a raw model string against the request schema (shared by embedded/CLI adapters).
	 * maxRetries counts additional model calls after the provided raw.
	 */
	async repairRawOutput(
		raw: string,
		schema: unknown,
		options?: {
			maxRetries?: number;
			retryWithModel?: (prompt: string) => Promise<string>;
			remainingModelCalls?: number;
			remainingCostUsd?: number | null;
			remainingTimeMs?: number | null;
		},
	) {
		return repairStructuredOutput(raw, {
			maxRetries: options?.maxRetries ?? 0,
			schema,
			validate: defaultSchemaValidator,
			retryWithModel: options?.retryWithModel,
			budget: {
				remainingModelCalls: options?.remainingModelCalls,
				remainingCostUsd: options?.remainingCostUsd,
				remainingTimeMs: options?.remainingTimeMs,
			},
		});
	}

	async #runOnce<TArtifact>(
		request: WorkflowAgentRequest,
		hooks?: {
			onSchemaRepairReceipt?: (receipt: SchemaRepairReceiptV1) => void;
			/** Profile maxRetries for receipt metadata (L1 still uses no model retry here). */
			schemaRetryMaxRetries?: number;
		},
	): Promise<WorkflowAgentResult<TArtifact>> {
		const optimizedContext = await optimizeWorkflowRequestContext(request);
		const prepared = prepareWorkflowInvocation(optimizedContext.request, optimizedContext);
		// strictMode:true → strict; strictMode:false → permissive; omitted → strict (safe default).
		const schemaMode =
			request.profile.outputStrategy?.schemaEnhancement?.strictMode === false ? "permissive" : "strict";

		const identityCollector = new ProviderIdentityCollector();
		const mappedAgent =
			request.agent ??
			RuntimeAdapter.agentNameForRole(request.role, {
				pipelineKind: request.pipelineKind,
				authorModelFamily: request.authorModelFamily,
				reviewerModel: request.profile.modelPattern,
			});
		const mappedModel =
			request.pipelineKind === "devflow" && (request.role === "plan_reviewer" || request.role === "code_reviewer")
				? resolvePipelineReviewModel(mappedAgent, request.profile.modelPattern)
				: request.profile.modelPattern;
		const mappedRequest: StructuredRunnerRequest = {
			session: prepared.session,
			invocationKind: "task",
			assignment: prepared.assignment,
			workflowRole: request.role,
			// Assembled stable+dynamic prompt text is the production model-facing context.
			context: prepared.assembledPromptText || prepared.context,
			agent: mappedAgent,
			model: mappedModel,
			thinkingLevel: request.profile.thinkingLevel,
			outputSchema: prepared.outputSchema ?? request.outputSchema,
			schemaMode,
			isolation: prepared.isolation,
			maxRuntimeMs: request.profile.maxRuntimeMs,
			signal: request.signal,
			retainArtifacts: prepared.isolationRequested,
			workflowId: request.workflowId,
			attemptId: request.attemptId,
			allowedTools: prepared.allowedTools,
			processToolResult: prepared.processToolResult,
			transformTools: prepared.transformTools,
			onResponse: identityCollector.onResponse,
			strictModelIdentity: request.profile.strictIdentity === true,
			shadowReview:
				request.pipelineKind === "devflow" && (request.role === "plan_reviewer" || request.role === "code_reviewer")
					? "code"
					: undefined,
		};

		try {
			const result = await this.#runner(mappedRequest);
			const body = result.result;

			if (body.aborted) {
				const abortText = `${body.abortReason ?? ""}\n${body.error ?? ""}`;
				const kind = body.completionKind;
				// Soft request budget is a budget stop, not caller cancellation.
				if (kind === "budget_stop" || /soft request budget exceeded/i.test(abortText)) {
					throw new BudgetExhaustedError(1, "unknown", 0, { completionKind: "budget_stop" });
				}
				// Wall-clock profile maxRuntimeMs abort is a retryable timeout — not a user cancel.
				if (kind === "timeout" || /runtime limit exceeded|maxRuntimeMs|timed? ?out/i.test(abortText)) {
					throw new WorkflowTimeoutError(
						body.abortReason ?? body.error ?? "Workflow subagent runtime limit exceeded",
						{ exitCode: body.exitCode, abortReason: body.abortReason, completionKind: "timeout" },
					);
				}
				throw new WorkflowCancelledError(body.error ?? body.abortReason ?? "Workflow subagent was aborted", {
					exitCode: body.exitCode,
					abortReason: body.abortReason,
					completionKind: kind === "hard_abort" ? "hard_abort" : undefined,
				});
			}
			const kind = body.completionKind;
			if (kind === "budget_stop") {
				throw new BudgetExhaustedError(1, "unknown", 0, { completionKind: "budget_stop" });
			}
			if (kind === "timeout") {
				throw new WorkflowTimeoutError(
					body.abortReason ?? body.error ?? "Workflow subagent runtime limit exceeded",
					{
						exitCode: body.exitCode,
						abortReason: body.abortReason,
						completionKind: "timeout",
					},
				);
			}
			if (kind === "hard_abort") {
				throw new WorkflowCancelledError(body.error ?? body.abortReason ?? "Workflow subagent was aborted", {
					exitCode: body.exitCode,
					abortReason: body.abortReason,
					completionKind: "hard_abort",
				});
			}
			// Structured-invalid results must take the schema repair path even when executor
			// also sets `error` (schema_violation headline). Do not throw generic WorkflowError first.
			if (body.error && !(body.structuredOutput && body.structuredOutput.status !== "valid")) {
				const kind = this.#classifyErrorKind(body.error);
				// Schema failures surfaced only as an error headline (no structured block) must
				// still reach the schema-retry loop — a generic WorkflowError would skip retry.
				if (kind === "schema_violation") {
					throw new WorkflowSchemaError(body.error, {
						status: "invalid",
						rawOutput: body.rawOutput ?? extractInvalidRaw(body),
						exitCode: body.exitCode,
						usage: body.usage,
					});
				}
				throw new WorkflowError(body.error, kind, { exitCode: body.exitCode });
			}
			const identityReceipt = buildRuntimeIdentityReceipt(request.profile, identityCollector, body.resolvedModel);
			if (request.profile.strictIdentity) assertStrictRuntimeIdentity(identityReceipt);
			if (body.exitCode !== undefined && body.exitCode !== 0) {
				// Schema violation often surfaces as exitCode=1 + structured invalid — try repair first.
				const structuredFail = body.structuredOutput;
				if (structuredFail && structuredFail.status !== "valid") {
					const repaired = await this.#tryRepairStructured<TArtifact>(
						body,
						prepared.outputSchema ?? request.outputSchema,
						prepared,
						request,
						result.changesApplied ?? null,
						identityReceipt,
						hooks,
					);
					if (repaired) return repaired;
					const failedReceipt = await captureFailedRepairReceipt(
						body,
						prepared.outputSchema ?? request.outputSchema,
						hooks?.schemaRetryMaxRetries ?? 0,
					);
					if (failedReceipt) hooks?.onSchemaRepairReceipt?.(failedReceipt);
					// Fall through to schema error so the outer retry loop can re-prompt.
					throw new WorkflowSchemaError(
						structuredFail.error ?? "Workflow subagent did not return a valid structured artifact",
						{
							status: structuredFail.status,
							rawOutput: body.rawOutput ?? extractInvalidRaw(body),
							exitCode: body.exitCode,
							usage: body.usage,
							schemaRepairReceipt: failedReceipt,
						},
					);
				}
				throw new WorkflowError(`Workflow subagent exited with code ${body.exitCode}`, "tool_failure", {
					exitCode: body.exitCode,
				});
			}

			// Fail closed when isolation apply was requested but changes did not land.
			if (prepared.isolationRequested && prepared.isolation?.apply !== false && result.changesApplied === false) {
				throw new WorkflowPolicyError("isolation_changes_not_applied", {
					patchPath: body.patchPath,
					branchName: body.branchName,
					mergeSummary: result.mergeSummary,
				});
			}

			const structured = body.structuredOutput;
			if (structured?.status !== "valid") {
				const repaired = await this.#tryRepairStructured<TArtifact>(
					body,
					prepared.outputSchema ?? request.outputSchema,
					prepared,
					request,
					result.changesApplied ?? null,
					identityReceipt,
					hooks,
				);
				if (repaired) return repaired;
				const failedReceipt = await captureFailedRepairReceipt(
					body,
					prepared.outputSchema ?? request.outputSchema,
					hooks?.schemaRetryMaxRetries ?? 0,
				);
				if (failedReceipt) hooks?.onSchemaRepairReceipt?.(failedReceipt);
				throw new WorkflowSchemaError(
					structured?.error ?? "Workflow subagent did not return a valid structured artifact",
					{
						status: structured?.status,
						rawOutput: body.rawOutput ?? extractInvalidRaw(body),
						usage: body.usage,
						schemaRepairReceipt: failedReceipt,
					},
				);
			}
			const resolved = parseResolvedModel(body.resolvedModel);
			// Merge provider cache counters after usage is known (prepare-time receipt is unobservable).
			const promptAssemblyReceipt = withProviderCacheMetrics(prepared.promptAssemblyReceipt, body.usage);
			return {
				artifact: structured.data as TArtifact,
				rawResultId: body.id,
				attemptId: request.attemptId,
				patchPath: body.patchPath,
				branchName: body.branchName,
				usage: body.usage,
				changesApplied: result.changesApplied ?? null,
				resolvedProvider: resolved?.provider,
				resolvedModel: resolved?.model,
				toolCalls: body.toolCalls,
				// After the live tool path finishes, optimization receipts (if any) sit on the shared array.
				promptAssemblyReceipt,
				contextLedger: withContextProviderUsage(prepared.contextLedger, body.usage),
				optimizationReceipts:
					prepared.optimizationReceipts.length > 0 ? [...prepared.optimizationReceipts] : undefined,
				identityReceipt,
				modelFamily: identityReceipt.modelFamily ?? undefined,
				resolvedToolPolicyId: prepared.resolvedToolPolicyId,
				completionKind: body.completionKind,
			};
		} catch (error) {
			throw this.#normalizeError(error);
		}
	}

	/**
	 * Deterministic raw repair (BOM/fence/single-object) before model schema retry.
	 * Returns a result when repair succeeds with zero model calls; otherwise undefined.
	 */
	async #tryRepairStructured<TArtifact>(
		body: StructuredRunnerResult["result"],
		schema: unknown,
		prepared: PreparedWorkflowInvocation,
		request: WorkflowAgentRequest,
		changesApplied: boolean | null,
		identityReceipt: WorkflowRuntimeIdentityReceiptV1,
		hooks?: {
			onSchemaRepairReceipt?: (receipt: SchemaRepairReceiptV1) => void;
			schemaRetryMaxRetries?: number;
		},
	): Promise<WorkflowAgentResult<TArtifact> | undefined> {
		const raw = extractInvalidRaw(body);
		if (!raw) return undefined;
		// L1 only (no retryWithModel). maxRetries is profile metadata for the receipt.
		const repaired = await repairStructuredOutput(raw, {
			maxRetries: hooks?.schemaRetryMaxRetries ?? 0,
			schema,
			validate: defaultSchemaValidator,
			budget: { remainingModelCalls: 0 },
		});
		hooks?.onSchemaRepairReceipt?.(repaired.receipt);
		if (!repaired.ok || repaired.value === undefined) return undefined;
		const resolved = parseResolvedModel(body.resolvedModel);
		const receipt = finalizeSchemaRepairReceipt(repaired.receipt, {
			maxRetries: hooks?.schemaRetryMaxRetries ?? repaired.receipt.maxRetries,
			// Deterministic L1 only — no model-retry calls.
			modelCalls: 0,
			finalStatus: "repaired_layer1",
			repaired: true,
			layer1Success: true,
			layer3RetryCount: 0,
		});
		return {
			artifact: repaired.value as TArtifact,
			rawResultId: body.id,
			attemptId: request.attemptId,
			patchPath: body.patchPath,
			branchName: body.branchName,
			usage: body.usage,
			changesApplied,
			resolvedProvider: resolved?.provider,
			resolvedModel: resolved?.model,
			toolCalls: body.toolCalls,
			promptAssemblyReceipt: withProviderCacheMetrics(prepared.promptAssemblyReceipt, body.usage),
			contextLedger: withContextProviderUsage(prepared.contextLedger, body.usage),
			optimizationReceipts:
				prepared.optimizationReceipts.length > 0 ? [...prepared.optimizationReceipts] : undefined,
			identityReceipt,
			modelFamily: identityReceipt.modelFamily ?? undefined,
			resolvedToolPolicyId: prepared.resolvedToolPolicyId,
			completionKind: body.completionKind,
			schemaRepairReceipt: receipt,
		};
	}

	#classifyErrorKind(message: string): WorkflowErrorKind {
		const m = message.toLowerCase();
		if (/auth|unauthorized|401|403|credential|api.?key/.test(m)) return "authentication";
		if (/quota|billing|insufficient.?quota/.test(m)) return "quota";
		if (/rate.?limit|429|too many requests/.test(m)) return "rate_limit";
		if (/timeout|timed out|deadline/.test(m)) return "timeout";
		if (/transient|temporarily|503|502|overloaded|retry/.test(m)) return "provider_transient";
		if (/schema|structured|invalid output/.test(m)) return "schema_violation";
		if (/isolat|git repository/.test(m)) return "configuration";
		return "provider_permanent";
	}

	#normalizeError(error: unknown): WorkflowError {
		if (error instanceof WorkflowError) return error;
		const message = error instanceof Error ? error.message : String(error);
		const name = error instanceof Error ? error.name : "";
		if (name === "AbortError" || /abort|cancel/i.test(message)) {
			return new WorkflowCancelledError(message, { cause: error });
		}
		if (/timeout|timed out/i.test(message)) {
			return new WorkflowTimeoutError(message, { cause: error });
		}
		// Match schema-ish failures only — do not treat "invalid private field" TypeErrors as schema.
		if (/schema|structured|invalid output/i.test(message)) {
			return new WorkflowSchemaError(message, { cause: error });
		}

		return new WorkflowError(message, this.#classifyErrorKind(message), { cause: error });
	}
}

function mergeUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
	if (!a) return b;
	if (!b) return a;
	// Never invent cost: only emit a cost object when at least one side reported one,
	// and only sum fields actually present. A fabricated total of 0 would make the
	// budget ledger treat an unknown-cost retry as known-zero (budget bypass).
	const hasCostA = a.cost !== undefined && Object.keys(a.cost).length > 0;
	const hasCostB = b.cost !== undefined && Object.keys(b.cost).length > 0;
	const cost = hasCostA || hasCostB ? { ...(a.cost ?? {}), ...(b.cost ?? {}) } : undefined;
	if (cost) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
			const left = (a.cost as Record<string, number> | undefined)?.[key];
			const right = (b.cost as Record<string, number> | undefined)?.[key];
			if (typeof left === "number" && typeof right === "number") {
				cost[key] = left + right;
			} else if (typeof left === "number") {
				cost[key] = left;
			} else if (typeof right === "number") {
				cost[key] = right;
			} else {
				delete (cost as Record<string, number>)[key];
			}
		}
	}
	const merged: Usage = {
		input: (a.input ?? 0) + (b.input ?? 0),
		output: (a.output ?? 0) + (b.output ?? 0),
		cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
		cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
		totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
		reasoningTokens:
			a.reasoningTokens === undefined && b.reasoningTokens === undefined
				? undefined
				: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
		// The shared Usage type declares cost required, but this merge NEVER invents
		// it: when neither side reported one, cost stays undefined (unknown ≠ zero).
		// Consumers must read defensively (usage.cost?.total); the ledger does.
		...(cost !== undefined ? { cost } : {}),
	} as Usage;
	return merged;
}
function extractInvalidRaw(body: StructuredRunnerResult["result"]): string | undefined {
	if (typeof body.rawOutput === "string" && body.rawOutput.length > 0) return body.rawOutput;
	const data = body.structuredOutput?.data;
	if (typeof data === "string" && data.length > 0) return data;
	if (data !== undefined && data !== null) {
		try {
			return JSON.stringify(data);
		} catch {
			// fall through
		}
	}
	const err = body.structuredOutput?.error;
	if (typeof err === "string" && (err.includes("{") || err.includes("```"))) return err;
	return undefined;
}

function withSchemaRepairDetails(
	error: WorkflowSchemaError,
	receipt: SchemaRepairReceiptV1 | undefined,
): WorkflowSchemaError {
	if (!receipt) return error;
	const prev = error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : {};
	return new WorkflowSchemaError(error.message, { ...prev, schemaRepairReceipt: receipt });
}

function emptySchemaRepairReceipt(maxRetries: number): SchemaRepairReceiptV1 {
	return {
		schemaVersion: SCHEMA_REPAIR_RECEIPT_VERSION,
		kind: SCHEMA_REPAIR_RECEIPT_KIND,
		attempts: [],
		modelCalls: 0,
		maxRetries,
		repaired: false,
		totalAttempts: 0,
		layer1Success: false,
		layer3RetryCount: 0,
		finalStatus: "schema_error",
		budgetExhausted: false,
		violationHistory: [],
	};
}

/**
 * Merge a per-invocation L1 receipt into the outer multi-attempt accumulator.
 * Remaps attemptIndex to the outer model-invocation index so Layer4 history is complete.
 */
function mergeSchemaRepairReceipt(
	acc: SchemaRepairReceiptV1,
	incoming: SchemaRepairReceiptV1 | undefined,
	outerAttemptIndex: number,
	maxRetries: number,
	opts: {
		modelCalls: number;
		finalStatus: SchemaRepairFinalStatus;
		repaired: boolean;
		fallbackError?: string;
		fallbackRaw?: string;
	},
): SchemaRepairReceiptV1 {
	const remapped: SchemaRepairAttempt[] = (incoming?.attempts ?? []).map(a => ({
		...a,
		attemptIndex: outerAttemptIndex,
	}));
	const remappedViolations: SchemaViolationRecord[] = (incoming?.violationHistory ?? []).map(v => ({
		...v,
		attemptIndex: outerAttemptIndex,
	}));

	// No L1 receipt (e.g. invalid structured with empty raw) → synthetic failure record.
	if (remapped.length === 0) {
		const raw = opts.fallbackRaw ?? opts.fallbackError ?? "schema validation failed";
		const err = opts.fallbackError ?? "schema validation failed";
		remapped.push({
			attemptIndex: outerAttemptIndex,
			phase: "validate",
			inputSha256: sha256Hex(raw),
			outputPreview: boundOutputFragment(raw),
			ok: false,
			error: err,
		});
		remappedViolations.push({
			attemptIndex: outerAttemptIndex,
			phase: "validate",
			error: err,
			outputPreview: boundOutputFragment(raw),
		});
	}

	const attempts = [...acc.attempts, ...remapped];
	const violationHistory = [...acc.violationHistory, ...remappedViolations];
	return {
		schemaVersion: SCHEMA_REPAIR_RECEIPT_VERSION,
		kind: SCHEMA_REPAIR_RECEIPT_KIND,
		attempts,
		modelCalls: opts.modelCalls,
		maxRetries,
		repaired: opts.repaired,
		totalAttempts: attempts.length,
		layer1Success: acc.layer1Success || (incoming?.layer1Success ?? false),
		layer3RetryCount: Math.max(0, opts.modelCalls - 1),
		finalStatus: opts.finalStatus,
		budgetExhausted: false,
		violationHistory,
	};
}

function finalizeSchemaRepairReceipt(
	base: SchemaRepairReceiptV1,
	opts: {
		maxRetries: number;
		modelCalls: number;
		finalStatus: SchemaRepairFinalStatus;
		repaired: boolean;
		layer1Success?: boolean;
		layer3RetryCount?: number;
		budgetExhausted?: boolean;
		budgetExhaustedReason?: SchemaRepairReceiptV1["budgetExhaustedReason"];
		extraAttempt?: SchemaRepairAttempt;
	},
): SchemaRepairReceiptV1 {
	const attempts = opts.extraAttempt ? [...base.attempts, opts.extraAttempt] : base.attempts;
	const violationHistory =
		opts.extraAttempt && !opts.extraAttempt.ok && opts.extraAttempt.error
			? [
					...base.violationHistory,
					{
						attemptIndex: opts.extraAttempt.attemptIndex,
						phase: opts.extraAttempt.phase,
						error: opts.extraAttempt.error,
						outputPreview: opts.extraAttempt.outputPreview,
					},
				]
			: base.violationHistory;
	return {
		...base,
		attempts,
		violationHistory,
		schemaVersion: SCHEMA_REPAIR_RECEIPT_VERSION,
		kind: SCHEMA_REPAIR_RECEIPT_KIND,
		maxRetries: opts.maxRetries,
		modelCalls: opts.modelCalls,
		repaired: opts.repaired,
		totalAttempts: attempts.length,
		layer1Success: opts.layer1Success ?? base.layer1Success,
		// Additional model calls after the first invocation (0 for pure L1).
		layer3RetryCount: opts.layer3RetryCount ?? Math.max(0, opts.modelCalls - 1),
		finalStatus: opts.finalStatus,
		budgetExhausted: opts.budgetExhausted ?? false,
		budgetExhaustedReason: opts.budgetExhaustedReason,
	};
}

async function captureFailedRepairReceipt(
	body: StructuredRunnerResult["result"],
	schema: unknown,
	schemaRetryMaxRetries = 0,
): Promise<SchemaRepairReceiptV1 | undefined> {
	const raw = extractInvalidRaw(body);
	if (!raw) return undefined;
	const repaired = await repairStructuredOutput(raw, {
		// Metadata only — no retryWithModel, so no model calls; budget blocks retries.
		maxRetries: schemaRetryMaxRetries,
		schema,
		validate: defaultSchemaValidator,
		budget: { remainingModelCalls: 0 },
	});
	return finalizeSchemaRepairReceipt(repaired.receipt, {
		maxRetries: schemaRetryMaxRetries,
		modelCalls: 0,
		finalStatus: repaired.ok ? "repaired_layer1" : "schema_error",
		repaired: repaired.ok,
		layer1Success: repaired.ok,
	});
}

function parseResolvedModel(value: string | undefined): { provider: string; model: string } | undefined {
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	const provider = value.slice(0, slash);
	const selector = value.slice(slash + 1);
	const thinkingSuffix = selector.lastIndexOf(":");
	const model = thinkingSuffix > 0 ? selector.slice(0, thinkingSuffix) : selector;
	return { provider, model };
}
