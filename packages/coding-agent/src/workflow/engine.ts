import type { ToolSession } from "../tools";
import { BudgetLedger } from "./budget-ledger";
import { DEFAULT_MODEL_PROFILES } from "./default-config";
import { BudgetExhaustedError, WorkflowPolicyError } from "./errors";
import { FindingTracker } from "./finding-tracker";
import { ModelRouter } from "./model-router";
import { RuntimeAdapter } from "./runtime-adapter";
import { WorkflowStore } from "./sqlite-store";
import { isValidTransition } from "./transitions";
import type { WorkflowAgentResult, WorkflowRequest, WorkflowRole, WorkflowStatus } from "./types";

export interface WorkflowStageContext {
	session: ToolSession;
	assignment: string;
	context?: string;
	outputSchema?: unknown;
	isolation?: {
		requested?: boolean;
		merge?: "patch" | "branch";
		apply?: boolean;
	};
	signal?: AbortSignal;
}

export interface WorkflowEngineOptions {
	store?: WorkflowStore;
	router?: ModelRouter;
	adapter?: RuntimeAdapter;
	budgetLedger?: BudgetLedger;
	findingTracker?: FindingTracker;
}

export class WorkflowEngine {
	readonly #store: WorkflowStore;
	readonly #router: ModelRouter;
	readonly #budgetLedger: BudgetLedger;
	readonly #findingTracker: FindingTracker;
	readonly #adapter: RuntimeAdapter;

	constructor(options: WorkflowEngineOptions = {}) {
		this.#store = options.store ?? new WorkflowStore();
		this.#router = options.router ?? new ModelRouter(Object.values(DEFAULT_MODEL_PROFILES));
		this.#adapter = options.adapter ?? new RuntimeAdapter();
		this.#budgetLedger = options.budgetLedger ?? new BudgetLedger();
		this.#findingTracker = options.findingTracker ?? new FindingTracker();
	}

	async startWorkflow(
		request: WorkflowRequest | Record<string, unknown>,
		policyOverrides: Record<string, unknown> = {},
	): Promise<string> {
		return this.#store.createWorkflow(request, { degradedMode: false, ...policyOverrides });
	}

	async getState(workflowId: string) {
		return this.#store.getCurrentState(workflowId);
	}

	async runStage(
		workflowId: string,
		stage: WorkflowStatus,
		role: WorkflowRole,
		stageContext: WorkflowStageContext,
	): Promise<WorkflowAgentResult> {
		const state = await this.#store.getCurrentState(workflowId);
		if (!state) throw new WorkflowPolicyError("workflow_not_found", { workflowId });
		if (!isValidTransition(state.status, stage)) {
			throw new WorkflowPolicyError("invalid_transition", { from: state.status, to: stage });
		}

		if (!(await this.#budgetLedger.checkPreStage())) {
			throw new BudgetExhaustedError(
				1,
				this.#budgetLedger.snapshot().costUsd,
				this.#budgetLedger.snapshot().limitUsd,
			);
		}

		const profile = this.#router.getProfileForRole(role);
		if (!profile) throw new WorkflowPolicyError("model_profile_not_found", { role });
		const attemptId = state.currentAttemptId ?? `att_${workflowId}_1`;
		await this.#store.transitionWorkflow(workflowId, state.status, stage, `starting ${role}`, attemptId);

		try {
			const result = await this.#adapter.run(
				this.#adapter.buildRequest({
					workflowId,
					attemptId,
					role,
					profile,
					assignment: stageContext.assignment,
					context: stageContext.context,
					outputSchema: stageContext.outputSchema,
					isolation: stageContext.isolation,
					session: stageContext.session,
					signal: stageContext.signal,
				}),
			);
			this.#budgetLedger.recordRequest(result.usage);
			await this.#store.completeAttempt(workflowId, attemptId, "completed", result.usage);
			return result;
		} catch (error) {
			await this.#store.transitionWorkflow(workflowId, stage, "failed", "stage execution failed", attemptId);
			throw error;
		}
	}

	async recoverFromPersistedState(workflowId: string) {
		return this.#store.resumeFromPersistedState(workflowId);
	}

	async finalize(workflowId: string): Promise<void> {
		const state = await this.#store.getCurrentState(workflowId);
		if (!state) throw new WorkflowPolicyError("workflow_not_found", { workflowId });
		await this.#store.transitionWorkflow(workflowId, state.status, "completed", "verification passed");
	}

	resolveFinding(findingId: string, status: "resolved" | "rejected" = "resolved"): void {
		this.#findingTracker.resolve(findingId, status);
	}

	async budgetCheckPreStage(): Promise<boolean> {
		return this.#budgetLedger.checkPreStage();
	}
}
