import { randomUUID } from "node:crypto";
import type { ToolSession } from "../tools";
import { abortRegisteredWorkflow, registerWorkflowAbort, unregisterWorkflowAbort } from "./abort-registry";
import { ArtifactStore } from "./artifact-store";
import { BudgetLedger, type BudgetSnapshot } from "./budget-ledger";
import { ContextBuilder } from "./context-builder";
import { DEFAULT_MODEL_PROFILES, getDefaultConfig, type WorkflowDefaultConfig } from "./default-config";
import { BudgetExhaustedError, WorkflowCancelledError, WorkflowError, WorkflowPolicyError } from "./errors";
import { FindingTracker } from "./finding-tracker";
import { ModelRouter, type RouteOptions, type RoutingDecision } from "./model-router";
import { RuntimeAdapter } from "./runtime-adapter";
import { redactSecretsInText } from "./secret-redact";
import type { PersistedWorkflowSnapshot } from "./sqlite-store";
import { WorkflowStore } from "./sqlite-store";
import { CodeReviewStage } from "./stages/code-review";
import { FinalVerifyStage } from "./stages/final-verify";
import { ImplementStage } from "./stages/implement";
import { ImplementationVerifyStage } from "./stages/implementation-verify";
import { PlanStage } from "./stages/plan";
import { PlanReviewStage } from "./stages/plan-review";
import { RepairStage } from "./stages/repair";
import { getNextStage, isValidTransition } from "./transitions";
import type {
	ImplementationArtifactV1,
	ModelProfile,
	PlanArtifactV1,
	ReviewArtifactV1,
	ReviewFindingV1,
	RuntimePort,
	VerificationArtifactV1,
	VerifierPort,
	WorkflowRequest,
	WorkflowRole,
	WorkflowState,
	WorkflowStatus,
} from "./types";
import { Verifier } from "./verifier";

const TERMINAL: ReadonlySet<WorkflowStatus> = new Set(["completed", "blocked", "cancelled", "failed"]);

export interface WorkflowEngineOptions {
	store?: WorkflowStore;
	router?: ModelRouter;
	adapter?: RuntimePort;
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

export interface WorkflowRunResult {
	state: WorkflowState;
	plan?: PlanArtifactV1;
	planReview?: ReviewArtifactV1;
	implementation?: ImplementationArtifactV1;
	verification?: VerificationArtifactV1;
	codeReview?: ReviewArtifactV1;
	finalVerification?: VerificationArtifactV1;
	routingAudit: Array<Record<string, unknown>>;
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

	// In-memory artifact cache for the current process (also persisted to store)
	#plan: PlanArtifactV1 | undefined;
	#planReview: ReviewArtifactV1 | undefined;
	#implementation: ImplementationArtifactV1 | undefined;
	#verification: VerificationArtifactV1 | undefined;
	#codeReview: ReviewArtifactV1 | undefined;
	#finalVerification: VerificationArtifactV1 | undefined;
	#implementerVendor: string | undefined;
	#planCycles = 0;
	#lastRouteProfileId: string | undefined;

	constructor(options: WorkflowEngineOptions = {}) {
		this.#ownsStore = options.ownsStore ?? options.store === undefined;
		this.#store = options.store ?? new WorkflowStore();
		this.#router = options.router ?? new ModelRouter(Object.values(DEFAULT_MODEL_PROFILES));
		// Production wiring injects createDefaultRuntimeAdapter(); pure tests inject fakes.
		// No default real runner here — avoids task/natives load and AGENTS.md dynamic-import ban.
		this.#adapter =
			options.adapter ??
			new RuntimeAdapter(async () => {
				throw new WorkflowPolicyError("runtime_adapter_required", {
					hint: "Pass adapter or use createDefaultRuntimeAdapter()",
				});
			});
		this.#config = { ...getDefaultConfig(), ...options.config };
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

	async startWorkflow(
		request: WorkflowRequest | Record<string, unknown>,
		policyOverrides: Record<string, unknown> = {},
	): Promise<string> {
		const policy = {
			degradedMode: this.#config.degradedMode,
			requireIndependentReview: this.#config.requireIndependentReview,
			...policyOverrides,
		};
		return this.#store.createWorkflow(request, policy);
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
		registerWorkflowAbort(workflowId, this.#controller);
		const parentSignal = this.#signal;
		if (parentSignal) {
			if (parentSignal.aborted) this.#controller.abort();
			else parentSignal.addEventListener("abort", () => this.#controller?.abort(), { once: true });
		}

		let steps = 0;
		const maxSteps = singleStep ? 1 : 32;

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
					if (error instanceof WorkflowPolicyError && error.message.includes("independent_reviewer")) {
						const s = await this.#requireState(workflowId);
						if (s.currentAttemptId) {
							await this.#finishOpenAttempt(workflowId, s.currentAttemptId, "failed", {
								kind: "policy_violation",
								summary: "independent_reviewer_unavailable",
							});
						}
						const s2 = await this.#requireState(workflowId);
						await this.#store.transitionWorkflow(
							workflowId,
							s2.status,
							"blocked",
							"independent_reviewer_unavailable",
							s2.currentAttemptId,
							s2.version,
						);
						break;
					}
					const s = await this.#requireState(workflowId);
					if (!TERMINAL.has(s.status)) {
						if (s.currentAttemptId) {
							await this.#finishOpenAttempt(workflowId, s.currentAttemptId, "failed", {
								kind: "internal",
								summary: error instanceof Error ? error.message : "stage failed",
							});
						}
						const s2 = await this.#requireState(workflowId);
						if (!TERMINAL.has(s2.status)) {
							await this.#store.transitionWorkflow(
								workflowId,
								s2.status,
								"failed",
								error instanceof Error ? error.message : "stage failed",
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
		};
		} finally {
			unregisterWorkflowAbort(workflowId);
		}
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
				const { artifact: plan, usage } = await this.#withProfileFallback("planner", {}, profile =>
					new PlanStage(this.#adapter).execute({
						workflowId,
						attemptId,
						profile,
						assignment: request.request,
						context: this.#contextBuilder.buildPlanContext({
							request,
							priorReview: this.#planReview,
							constraints: request.constraints,
						}),
						session,
						signal,
					}),
				);
				this.#plan = plan;
				await this.#persistArtifact(workflowId, attemptId, "plan", plan);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage);
				const next = getNextStage("planning", "approved");
				await this.#completeTo(workflowId, attemptId, fresh.status, next!, "plan ready", fresh.version);
				return;
			}
			case "plan_review": {
				if (!this.#plan) throw new WorkflowPolicyError("missing_plan_artifact", { workflowId });
				this.#budgetLedger.recordReviewerCycle();
				const { artifact: review, usage } = await this.#withProfileFallback("plan_reviewer", {}, profile =>
					new PlanReviewStage(this.#adapter).execute({
						workflowId,
						attemptId,
						profile,
						assignment: "Review the plan for correctness and feasibility",
						context: this.#contextBuilder.buildPlanReviewContext(this.#plan!),
						session,
						signal,
					}),
				);
				this.#planReview = review;
				await this.#persistArtifact(workflowId, attemptId, "review", review);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage);
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
				const { artifact: impl, usage } = await this.#withProfileFallback("implementer", {}, async profile => {
					this.#implementerVendor = profile.vendor;
					return new ImplementStage(this.#adapter).execute({
						workflowId,
						attemptId,
						profile,
						assignment: "Implement the approved plan in isolation",
						context: this.#contextBuilder.buildImplementContext(this.#plan!, this.#planReview),
						session,
						signal,
						isolation: this.#config.isolation,
					});
				});
				this.#implementation = impl;
				await this.#persistArtifact(workflowId, attemptId, "implementation", impl);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage);
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
					cwd,
				});
				this.#verification = verification;
				await this.#persistArtifact(workflowId, attemptId, "verification", verification);
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
				const { artifact: review, usage } = await this.#withProfileFallback(
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
							context: this.#contextBuilder.buildCodeReviewContext({
								plan: this.#plan!,
								implementation: this.#implementation!,
								verification: this.#verification,
							}),
							session,
							signal,
							confidenceThreshold: this.#config.confidenceThreshold,
						});
					},
				);
				this.#codeReview = review;
				for (const f of review.findings) this.#findingTracker.add(f);
				await this.#persistArtifact(workflowId, attemptId, "review", review);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage);

				const blocking = review.findings.filter(
					f =>
						(f.status === "open" || f.status === "in_progress") &&
						f.confidence >= this.#config.confidenceThreshold &&
						(f.priority === "P0" || f.priority === "P1" || review.decision === "changes_requested"),
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
				const { artifact: repaired, usage } = await this.#withProfileFallback(
					"repair",
					{
						finding: primary,
						findingTracker: this.#findingTracker,
						preferReasoningRepair: primary ? this.#findingTracker.needsReasoningRepair(primary) : false,
					},
					profile =>
						new RepairStage(this.#adapter).execute({
							workflowId,
							attemptId,
							profile,
							findingIds: open.map(f => f.id),
							findings: open,
							assignment: `Repair findings: ${open.map(f => f.id).join(", ")}`,
							context: this.#contextBuilder.buildRepairContext({
								plan: this.#plan!,
								findings: open,
								verification: this.#verification,
								implementation: this.#implementation,
								reviewExplanation: this.#codeReview?.explanation ?? this.#planReview?.explanation,
							}),
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
					if (resolvedIds.has(id)) this.#findingTracker.resolve(id, "resolved");
				}
				await this.#persistArtifact(workflowId, attemptId, "implementation", this.#implementation);
				await this.#persistFindingsState(workflowId, attemptId);
				await this.#recordUsageAndProfile(workflowId, attemptId, usage);
				// One completed repair attempt toward maxRepairCycles.
				this.#budgetLedger.recordRepairCycle();
				const next = getNextStage("repairing", null);
				await this.#completeTo(workflowId, attemptId, fresh.status, next!, "repair complete", fresh.version);
				return;
			}
			case "final_verify": {
				const commands = this.#trustedVerificationCommands(this.#plan?.verificationCommands);
				const threshold = this.#config.confidenceThreshold;
				const openFindings = this.#findingTracker
					.getOpen()
					.filter(f => f.confidence >= threshold && (f.priority === "P0" || f.priority === "P1"));
				const verification = await new FinalVerifyStage(this.#verifier).execute({
					workflowId,
					attemptId,
					commands,
					forbiddenPaths: this.#config.forbiddenPaths,
					implementation: this.#implementation,
					openFindings,
					signal,
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
			return (
				error.kind === "timeout" ||
				error.kind === "rate_limit" ||
				error.kind === "schema_violation" ||
				error.kind === "provider_transient" ||
				error.kind === "quota"
			);
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
					this.#isRetryableProviderError(error) ||
					(typeof kind === "string" && retryableKinds.includes(kind));
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

	async #persistArtifact(workflowId: string, attemptId: string, kind: string, artifact: object): Promise<void> {
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
			try {
				const parsed = JSON.parse(loaded.content) as { kind?: string; findings?: ReviewFindingV1[] };
				if (parsed.kind === "plan") this.#plan = parsed as PlanArtifactV1;
				else if (parsed.kind === "review") {
					const review = parsed as ReviewArtifactV1;
					if (review.subject === "plan") this.#planReview = review;
					else this.#codeReview = review;
					for (const f of review.findings ?? []) this.#findingTracker.add(f);
				} else if (parsed.kind === "findings-state") {
					for (const f of parsed.findings ?? []) {
						this.#findingTracker.add(f);
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
					this.#implementerVendor = this.#implementation.provider;
				} else if (parsed.kind === "verification") {
					const v = parsed as VerificationArtifactV1;
					if (v.stage === "final_verify") this.#finalVerification = v;
					else this.#verification = v;
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
	): Promise<void> {
		const profileId = this.#lastRouteProfileId;
		this.#budgetLedger.recordRequest(usage as never, profileId);
		if (profileId) {
			await this.#store.setAttemptProfile(workflowId, attemptId, profileId);
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
