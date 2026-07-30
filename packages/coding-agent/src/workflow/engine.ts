import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ToolSession } from "../tools";
import { abortRegisteredWorkflow, registerWorkflowAbort, unregisterWorkflowAbort } from "./abort-registry";
import { resolveArtifactInclusion } from "./artifact-inclusion";
import { ArtifactStore } from "./artifact-store";
import {
	assertRequiredRolesAvailable,
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
} from "./errors";
import { FindingTracker } from "./finding-tracker";
import { assertSupportedModelProfile } from "./model-profile-registry";
import { ModelRouter, type RouteOptions, type RoutingDecision } from "./model-router";
import { RuntimeAdapter } from "./runtime-adapter";
import {
	buildScopeMetrics,
	collectScopeMetricsFromGit,
	plannedFilesFromPlan,
	type ScopeMetricsV1,
} from "./scope-metrics";
import { redactSecretsInText } from "./secret-redact";
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
import { PlanReviewStage } from "./stages/plan-review";
import { RepairStage } from "./stages/repair";
import { getNextStage, isValidTransition } from "./transitions";
import type {
	Artifact,
	ImplementationArtifactV1,
	ModelProfile,
	PlanArtifactV1,
	ReviewArtifactV1,
	ReviewFindingV1,
	RuntimePort,
	StageHandoffArtifactRef,
	StageHandoffV1,
	VerificationArtifactV1,
	VerifierPort,
	WorkflowAvailabilityPort,
	WorkflowAvailabilityReport,
	WorkflowRequest,
	WorkflowRole,
	WorkflowRuntimeEvidence,
	WorkflowState,
	WorkflowStatus,
} from "./types";
import { Verifier } from "./verifier";

const TERMINAL: ReadonlySet<WorkflowStatus> = new Set(["completed", "blocked", "cancelled", "failed"]);

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
	/** When true (default if store was created by engine), dispose() closes SQLite. */
	ownsStore?: boolean;
}

export interface WorkflowStartResult {
	workflowId: string;
	availability: WorkflowAvailabilityReport;
}

export interface WorkflowRunResult {
	state: WorkflowState;
	plan?: PlanArtifactV1;
	planReview?: ReviewArtifactV1;
	implementation?: ImplementationArtifactV1;
	verification?: VerificationArtifactV1;
	codeReview?: ReviewArtifactV1;
	finalVerification?: VerificationArtifactV1;
	routingAudit: Array<Record<string, unknown>>;
	/** Preflight report from this start/resume invocation (when availability port is configured). */
	availability?: WorkflowAvailabilityReport;
}

/**
 * Deterministic multi-stage workflow engine.
 * Models return artifacts only; this class owns transitions, budget, cancel, and resume.
 */
export class WorkflowEngine {
	readonly #store: WorkflowStore;
	readonly #router: ModelRouter;
	readonly #budgetLedger: BudgetLedger;
	readonly #findingTracker: FindingTracker;
	readonly #adapter: RuntimePort;
	readonly #availability: WorkflowAvailabilityPort | undefined;
	readonly #verifier: VerifierPort;
	readonly #artifactStore: ArtifactStore;
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

	// In-memory artifact cache for the current process (also persisted to store)
	#plan: PlanArtifactV1 | undefined;
	#planReview: ReviewArtifactV1 | undefined;
	#implementation: ImplementationArtifactV1 | undefined;
	#verification: VerificationArtifactV1 | undefined;
	#codeReview: ReviewArtifactV1 | undefined;
	#finalVerification: VerificationArtifactV1 | undefined;
	/** Durable refs for stage-handoff sizing / recovery (source artifacts never deleted). */
	#planArtifactRef: StageHandoffArtifactRef | undefined;
	#planReviewArtifactRef: StageHandoffArtifactRef | undefined;
	#implementationArtifactRef: StageHandoffArtifactRef | undefined;
	#verificationArtifactRef: StageHandoffArtifactRef | undefined;
	#codeReviewArtifactRef: StageHandoffArtifactRef | undefined;
	/** Real patch content persisted for implement→review handoff recovery. */
	#patchArtifactRef: StageHandoffArtifactRef | undefined;
	#plannerProfileId: string | undefined;
	#plannerVendor: string | undefined;
	#implementerVendor: string | undefined;
	#planCycles = 0;
	#lastRouteProfileId: string | undefined;
	#lastScopeMetrics: ScopeMetricsV1 | undefined;

	constructor(options: WorkflowEngineOptions = {}) {
		this.#ownsStore = options.ownsStore ?? options.store === undefined;
		this.#store = options.store ?? new WorkflowStore();
		this.#config = { ...getDefaultConfig(), ...options.config };
		const profiles = Object.values(this.#config.profiles);
		for (const profile of profiles) assertSupportedModelProfile(profile);
		this.#router = options.router ?? new ModelRouter(profiles);
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
	): Promise<WorkflowStartResult> {
		const policy = {
			degradedMode: this.#config.degradedMode,
			requireIndependentReview: this.#config.requireIndependentReview,
			...policyOverrides,
		};
		const workflowId = await this.#store.createWorkflow(request, policy);
		const availability = await this.#runPreflight({
			workflowId,
			operation: "start",
			status: "created",
			singleStep: false,
			session: this.#session,
			signal: this.#signal,
			// start is diagnostic only — never fail-closed into a stage transition
			failClosed: false,
		});
		this.#lastAvailability = availability;
		return { workflowId, availability };
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

	async getState(workflowId: string): Promise<WorkflowState | null> {
		return this.#store.getCurrentState(workflowId);
	}

	/** Cancel: abort in-flight work, finish open attempts, and persist cancelled. */
	async cancel(workflowId: string, reason = "caller cancelled"): Promise<WorkflowState> {
		// Signal any in-process runner registered under this workflow id (other engine instances).
		abortRegisteredWorkflow(workflowId, reason);
		this.#controller?.abort();
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
		);
		// Cancel also clears exclusive locks (including foreign/stuck owners).
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
		if (snapshot.budgetTotals) {
			this.#budgetLedger.restore(snapshot.budgetTotals as Partial<BudgetSnapshot>);
		}
		if (options.forceUnlock) {
			await this.#store.clearRunnerOwner(workflowId);
		}
		// Rebuild plan-cycle count from durable transitions (survives new Engine instances).
		this.#planCycles = snapshot.transitions.filter(
			t => t.fromStatus === "plan_review" && t.toStatus === "planning",
		).length;
		// Reload latest artifacts of each kind from metadata + content when present
		await this.#hydrateArtifacts(snapshot);
		// Merge caller abort signal for this run
		if (options.signal) {
			this.#signal = options.signal;
		}
		return this.#runLoop(workflowId, options.session ?? this.#session, options.singleStep === true);
	}

	/** Run from created through completion (or block/fail/cancel). */
	async run(workflowId: string, session?: ToolSession): Promise<WorkflowRunResult> {
		return this.#runLoop(workflowId, session ?? this.#session, false);
	}

	async #runLoop(
		workflowId: string,
		session: ToolSession | undefined,
		singleStep: boolean,
	): Promise<WorkflowRunResult> {
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
					await this.cancel(workflowId, "aborted");
					break;
				}

				let state = await this.#requireState(workflowId);
				if (TERMINAL.has(state.status)) break;

				// Exclusive runner lock — second concurrent runner fails until release.
				let claimed = false;
				try {
					await this.#store.claimRunner(workflowId, this.#runnerOwnerId, state.version);
					claimed = true;
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
							failClosed: true,
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
						if (error instanceof WorkflowCancelledError || this.#controller.signal.aborted) {
							await this.cancel(workflowId, "cancelled during stage");
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

					if (singleStep) break;
				} finally {
					if (claimed) {
						await this.#store.releaseRunner(workflowId, this.#runnerOwnerId);
					}
				}
			}

			const finalState = await this.#requireState(workflowId);
			return {
				state: finalState,
				plan: this.#plan,
				planReview: this.#planReview,
				implementation: this.#implementation,
				verification: this.#verification,
				codeReview: this.#codeReview,
				finalVerification: this.#finalVerification,
				routingAudit: [...this.#routingAudit],
				availability: availability ?? this.#lastAvailability,
			};
		} finally {
			unregisterWorkflowAbort(workflowId, this.#controller);
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
	}): Promise<WorkflowAvailabilityReport> {
		if (!this.#availability || !options.session) {
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
		});

		if (options.failClosed) {
			assertRequiredRolesAvailable(report);
		}
		return report;
	}

	async #executeCurrentStage(workflowId: string, state: WorkflowState, session: ToolSession): Promise<void> {
		const signal = this.#controller?.signal;
		const policy = this.#parsePolicy(state.policyJson);
		const request = this.#parseRequest(state.requestJson);
		const stage = state.status;

		// Fail-closed resume: never silently re-run a write stage without detection.
		// If an open in_progress attempt exists for this stage, mark it failed then start fresh.
		const attemptId = await this.#beginAttemptFailClosed(workflowId, stage, state);
		const fresh = await this.#requireState(workflowId);
		const cwd = session.cwd;

		switch (stage) {
			case "planning": {
				const {
					artifact: plan,
					usage,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
				} = await this.#withProfileFallback("planner", {}, async profile => {
					this.#plannerProfileId = profile.id;
					this.#plannerVendor = profile.vendor;
					const context = await this.#buildStageContext(
						this.#contextBuilder.buildPlanContext({
							request,
							priorReview: this.#planReview,
							constraints: request.constraints,
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
				this.#plan = plan;
				this.#planArtifactRef = await this.#persistArtifact(workflowId, attemptId, "plan", plan);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage, {
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
				});
				const next = getNextStage("planning", "approved");
				await this.#completeTo(workflowId, attemptId, fresh.status, next!, "plan ready", fresh.version);
				return;
			}
			case "plan_review": {
				if (!this.#plan) throw new WorkflowPolicyError("missing_plan_artifact", { workflowId });
				this.#budgetLedger.recordReviewerCycle();
				const {
					artifact: review,
					usage,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
				} = await this.#withProfileFallback(
					"plan_reviewer",
					{
						excludedProfileIds: this.#plannerProfileId ? [this.#plannerProfileId] : [],
						avoidVendor: this.#plannerVendor,
					},
					async profile =>
						new PlanReviewStage(this.#adapter).execute({
							workflowId,
							attemptId,
							profile,
							assignment: "Review the plan for correctness and feasibility",
							context: await this.#buildStageContext(
								this.#contextBuilder.buildPlanReviewContext(this.#plan!, resolveArtifactInclusion(profile)),
								profile,
								session,
								this.#plan?.affectedFiles.map(f => f.path),
							),
							session,
							signal,
						}),
				);
				this.#planReview = review;
				this.#planReviewArtifactRef = await this.#persistArtifact(workflowId, attemptId, "review", review);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage, {
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
				});
				const next = getNextStage("plan_review", review.decision);
				if (!next) throw new WorkflowPolicyError("invalid_review_decision", { decision: review.decision });
				if (review.decision === "changes_requested") {
					this.#planCycles += 1;
					if (this.#planCycles >= this.#config.maxPlanCycles) {
						await this.#store.completeAttemptAndTransition({
							workflowId,
							attemptId,
							attemptStatus: "failed",
							fromStatus: fresh.status,
							toStatus: "blocked",
							reason: "max_plan_cycles_exceeded",
							expectedVersion: fresh.version,
						});
						return;
					}
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
				const {
					artifact: impl,
					usage,
					resolvedProvider,
					resolvedModel,
					toolCalls,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
				} = await this.#withProfileFallback("implementer", {}, async profile => {
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
							this.#plan?.affectedFiles.map(f => f.path),
							plannerHandoff,
						),
						session,
						signal,
						isolation: this.#config.isolation,
					});
				});
				this.#implementation = impl;
				this.#implementationArtifactRef = await this.#persistArtifact(
					workflowId,
					attemptId,
					"implementation",
					impl,
				);
				await this.#persistScopeMetrics(workflowId, attemptId, cwd, this.#plan, impl);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage, {
					resolvedProvider,
					resolvedModel,
					toolCalls,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
					scopeMetricsKind: this.#lastScopeMetrics ? "scope-metrics" : undefined,
				});
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
				} = await this.#withProfileFallback(
					"code_reviewer",
					{
						implementerVendor: this.#implementerVendor ?? this.#implementation.provider,
						requireIndependentReview: policy.requireIndependentReview !== false,
						degradedMode: Boolean(policy.degradedMode) || this.#config.degradedMode,
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
					});
					throw new BudgetExhaustedError(snap.repairCycles, snap.costUsd ?? "unknown", snap.limitUsd);
				}
				const open = this.#findingTracker.getOpen();
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
						});
						return;
					}
				}
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
				const {
					artifact: repaired,
					usage,
					resolvedProvider,
					resolvedModel,
					toolCalls,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
				} = await this.#withProfileFallback(
					"repair",
					{
						finding: primary,
						findingTracker: this.#findingTracker,
						preferReasoningRepair: primary ? this.#findingTracker.needsReasoningRepair(primary) : false,
					},
					async profile =>
						new RepairStage(this.#adapter).execute({
							workflowId,
							attemptId,
							profile,
							findingIds: open.map(f => f.id),
							findings: open,
							assignment: `Repair findings: ${open.map(f => f.id).join(", ")}`,
							context: await this.#buildStageContext(
								this.#contextBuilder.buildRepairContext({
									plan: this.#plan!,
									findings: open,
									verification: this.#verification,
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
				// Accumulate cumulative changed files / patch refs so prior deltas remain auditable.
				const previous = this.#implementation;
				this.#implementation = {
					...repaired,
					changedFiles: [...new Set([...(previous?.changedFiles ?? []), ...repaired.changedFiles])],
					// Keep prior patch path in unresolved metadata when both exist
					unresolved: [
						...new Set([
							...(repaired.unresolved ?? []),
							...(previous?.patchPath && previous.patchPath !== repaired.patchPath
								? [`priorPatch:${previous.patchPath}`]
								: []),
						]),
					],
				};
				// Resolve only explicitly addressed finding IDs (never auto-all).
				const resolvedIds = new Set(repaired.addressedStepIds);
				for (const id of open.map(f => f.id)) {
					if (resolvedIds.has(id)) {
						this.#findingTracker.resolve(id, "resolved", [`repair:${attemptId}`]);
					}
				}
				this.#implementationArtifactRef = await this.#persistArtifact(
					workflowId,
					attemptId,
					"implementation",
					this.#implementation,
				);
				await this.#persistFindingsState(workflowId, attemptId);
				if (this.#plan) {
					await this.#persistScopeMetrics(workflowId, attemptId, cwd, this.#plan, this.#implementation);
				}
				await this.#recordUsageAndProfile(workflowId, attemptId, usage, {
					resolvedProvider,
					resolvedModel,
					toolCalls,
					promptAssemblyReceipt,
					contextLedger,
					optimizationReceipts,
					scopeMetricsKind: this.#lastScopeMetrics ? "scope-metrics" : undefined,
				});
				// One completed repair attempt toward maxRepairCycles.
				this.#budgetLedger.recordRepairCycle();
				const next = getNextStage("repairing", null);
				await this.#completeTo(workflowId, attemptId, fresh.status, next!, "repair complete", fresh.version);
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
		if (impl.patchPath) {
			const resolved = path.isAbsolute(impl.patchPath) ? impl.patchPath : path.join(cwd, impl.patchPath);
			try {
				const text = await Bun.file(resolved).text();
				changedFromPatch = changedFilesFromPatch(text);
			} catch {
				// missing patch is handled by verify; scope falls through to git
			}
		}

		let metrics: ScopeMetricsV1;
		if (changedFromPatch.length > 0) {
			// Patch is filesystem evidence (not model prose). Infer deletes from /dev/null headers not needed here.
			metrics = buildScopeMetrics({
				plannedFiles: planned,
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
	 * Resolve profile, run, and on retryable provider failure mark the profile unavailable
	 * and retry once via ModelRouter fallback / alternate candidates.
	 */
	async #withProfileFallback<T>(
		role: WorkflowRole,
		routeOptions: RouteOptions,
		run: (profile: ModelProfile, route: RoutingDecision) => Promise<T>,
	): Promise<T> {
		const unavailable = new Set<string>([...(routeOptions.unavailableProfileIds ?? [])]);
		let lastError: unknown;
		// First resolve to read profile retry policy for max attempts (default 2).
		const probe = this.#router.resolve(role, { ...routeOptions, unavailableProfileIds: unavailable });
		const maxAttempts = Math.max(1, probe.profile.retryPolicy?.maxAttempts ?? 2);
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (attempt > 0 && !(await this.#budgetLedger.checkPreRetry())) {
				const snap = this.#budgetLedger.snapshot();
				throw new BudgetExhaustedError(snap.requests, snap.costUsd ?? "unknown", snap.limitUsd);
			}
			const route = this.#router.resolve(role, { ...routeOptions, unavailableProfileIds: unavailable });
			// Per-profile request/cost hard-stop before external call.
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
				const result = await run(route.profile, route);
				return result;
			} catch (error) {
				lastError = error;
				// Count the failed attempt toward request budget even when retrying.
				this.#budgetLedger.recordRequest(undefined, route.profileId);
				const kind = error instanceof WorkflowError ? error.kind : "";
				const retryableKinds = route.profile.retryPolicy?.retryableErrorKinds ?? [];
				const kindOk =
					this.#isRetryableProviderError(error) || (typeof kind === "string" && retryableKinds.includes(kind));
				if (attempt < maxAttempts - 1 && kindOk) {
					unavailable.add(route.profileId);
					continue;
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
				await this.#store.completeAttempt(
					workflowId,
					open.id,
					"failed",
					{},
					{
						kind: "cancelled",
						summary: writeStage ? "write_stage_interrupted_no_rerun" : "stale_in_progress_on_resume",
					},
				);
				if (writeStage) {
					const refreshed = await this.#requireState(workflowId);
					if (!TERMINAL.has(refreshed.status) && isValidTransition(refreshed.status, "blocked")) {
						await this.#store.transitionWorkflow(
							workflowId,
							refreshed.status,
							"blocked",
							"write_stage_interrupted_no_rerun",
							open.id,
							refreshed.version,
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
		const stored = await this.#artifactStore.store({
			workflowId,
			attemptId,
			kind,
			schemaVersion: 1,
			relativePath: "",
			content,
		});
		await this.#store.addArtifact({
			workflowId,
			attemptId,
			kind,
			schemaVersion: 1,
			relativePath: stored.relativePath,
			sha256: stored.sha256,
			content,
		});
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
				const parsed = JSON.parse(loaded.content) as { kind?: string; findings?: ReviewFindingV1[] };
				const ref = this.#refFromMeta(meta, loaded.content);
				if (parsed.kind === "plan") {
					this.#plan = parsed as PlanArtifactV1;
					this.#planArtifactRef = ref;
					// Restore planner route context for plan_review diversity across Engine resume.
					if (this.#plan.modelProfileId) this.#plannerProfileId = this.#plan.modelProfileId;
					if (this.#plan.provider) this.#plannerVendor = this.#plan.provider;
				} else if (parsed.kind === "review") {
					const review = parsed as ReviewArtifactV1;
					if (review.subject === "plan") {
						this.#planReview = review;
						this.#planReviewArtifactRef = ref;
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
					for (const f of parsed.findings ?? []) {
						this.#findingTracker.add(f, { blocking: f.blocking });
						if (f.status === "resolved" || f.status === "rejected") {
							this.#findingTracker.resolve(f.id, f.status);
						}
						const cycles = (f as { repairCycles?: number }).repairCycles ?? 0;
						for (let i = 0; i < cycles; i++) {
							this.#findingTracker.recordRepairCycle(FindingTracker.fingerprint(f));
						}
					}
				} else if (parsed.kind === "implementation") {
					this.#implementation = parsed as ImplementationArtifactV1;
					this.#implementationArtifactRef = ref;
					this.#implementerVendor = this.#implementation.provider;
				} else if (parsed.kind === "verification") {
					const v = parsed as VerificationArtifactV1;
					if (v.stage === "final_verify") this.#finalVerification = v;
					else {
						this.#verification = v;
						this.#verificationArtifactRef = ref;
					}
				}
			} catch {
				// ignore corrupt bodies; hash already verified
			}
		}
	}

	#audit(route: { profileId: string; vendor: string; reason: string; degraded: boolean }): void {
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
		if (evidence?.resolvedProvider || evidence?.resolvedModel) {
			await this.#persistArtifact(workflowId, attemptId, "runtime-evidence", {
				kind: "runtime-evidence",
				schemaVersion: 1,
				workflowId,
				attemptId,
				resolvedProvider: evidence.resolvedProvider,
				resolvedModel: evidence.resolvedModel,
				toolCalls: evidence.toolCalls,
				profileId,
				scopeMetricsKind: evidence.scopeMetricsKind ?? null,
			});
		}
		await this.#persistRoutingAudit(workflowId, attemptId);
	}

	#parsePolicy(policyJson: string): Record<string, unknown> {
		try {
			return JSON.parse(policyJson) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	#parseRequest(requestJson: string): WorkflowRequest {
		try {
			const raw = JSON.parse(requestJson) as Record<string, unknown>;
			if (typeof raw.request === "string") {
				return {
					request: raw.request,
					constraints: typeof raw.constraints === "string" ? raw.constraints : undefined,
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
