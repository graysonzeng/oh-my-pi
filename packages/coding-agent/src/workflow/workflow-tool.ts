import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import workflowDescription from "../prompts/tools/workflow.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { WorkflowEngine } from "./engine";
import { WorkflowPolicyError } from "./errors";
import { WorkflowStore } from "./sqlite-store";
import type { WorkflowStatus } from "./types";

const workflowSchema = type({
	op: type("'start' | 'status' | 'resume' | 'cancel'").describe("workflow operation"),
	"request?": type("string").describe("start: user request / objective"),
	"constraints?": type("string").describe("start: optional constraints"),
	"workflowId?": type("string").describe("status/resume/cancel: workflow id"),
	"degradedMode?": type("boolean").describe("start: allow same-vendor review"),
	"singleStep?": type("boolean").describe("resume: run only one stage"),
	"forceUnlock?": type("boolean").describe("resume: clear stale runner_owner after crash"),
});

export type WorkflowToolInput = typeof workflowSchema.infer;

export type WorkflowToolDetails = {
	op: WorkflowToolInput["op"];
	workflowId?: string;
	status?: WorkflowStatus;
	approvalTier: "read" | "write";
};

/**
 * Approval tiers:
 * - status: read-only
 * - start | resume | cancel: write
 */
export function approvalTierForOp(op: WorkflowToolInput["op"]): "read" | "write" {
	return op === "status" ? "read" : "write";
}

export class WorkflowTool implements AgentTool<typeof workflowSchema, WorkflowToolDetails> {
	readonly name = "workflow";
	readonly label = "Workflow";
	// Static prompt file — no Handlebars vars; avoid pi-utils/prompt (pulls natives) for pure tests
	readonly description = workflowDescription.trim();
	readonly parameters = workflowSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	/** status → read; start|resume|cancel → write (never default to bare exec). */
	readonly approval = (args: unknown): "read" | "write" => {
		const op = args && typeof args === "object" && "op" in args ? String((args as { op?: unknown }).op) : "";
		if (op === "start" || op === "resume" || op === "cancel" || op === "status") {
			return approvalTierForOp(op as WorkflowToolInput["op"]);
		}
		// Unknown op: fail closed to write (requires approval)
		return "write";
	};
	readonly #session: ToolSession;
	readonly #engineFactory: (session: ToolSession) => WorkflowEngine;

	constructor(session: ToolSession, engineFactory?: (session: ToolSession) => WorkflowEngine) {
		this.#session = session;
		this.#engineFactory =
			engineFactory ??
			(s => {
				// Tests / pure paths: store-only engine. Production wires adapter via tools/index factory.
				const storage = s.settings?.get?.("workflow.storagePath" as never) as string | undefined;
				const store = storage ? new WorkflowStore(storage) : new WorkflowStore();
				return new WorkflowEngine({ store, session: s });
			});
	}

	static createIf(session: ToolSession): WorkflowTool | null {
		const enabled = session.settings?.get?.("workflow.enabled" as never);
		if (enabled === false) return null;
		return new WorkflowTool(session);
	}

	async execute(
		_toolCallId: string,
		params: WorkflowToolInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WorkflowToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<WorkflowToolDetails>> {
		const tier = approvalTierForOp(params.op);
		const engine = this.#engineFactory(this.#session);
		if (signal?.aborted) {
			throw new ToolError("workflow tool call aborted before start");
		}
		let activeWorkflowId = params.workflowId?.trim() || "";
		const onAbort = () => {
			if (activeWorkflowId) void engine.cancel(activeWorkflowId, "tool abort signal");
		};
		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			if (params.op === "start") {
				const request = params.request?.trim();
				if (!request) throw new ToolError("request is required when op=start");
				const workflowId = await engine.startWorkflow(
					{ request, constraints: params.constraints },
					{ degradedMode: params.degradedMode === true },
				);
				activeWorkflowId = workflowId;
				const state = await engine.getState(workflowId);
				return {
					content: [
						{ type: "text", text: `Workflow started: ${workflowId}\nStatus: ${state?.status ?? "created"}` },
					],
					details: { op: "start", workflowId, status: state?.status, approvalTier: tier },
				};
			}

			if (params.op === "status") {
				const workflowId = params.workflowId?.trim();
				if (!workflowId) throw new ToolError("workflowId is required when op=status");
				const snapshot = await engine.recoverFromPersistedState(workflowId);
				if (!snapshot) throw new ToolError(`Workflow not found: ${workflowId}`);
				const text = [
					`Workflow: ${workflowId}`,
					`Status: ${snapshot.state.status}`,
					`Stage: ${snapshot.state.currentStage}`,
					`Version: ${snapshot.state.version}`,
					`Attempts: ${snapshot.attempts.length}`,
					`Artifacts: ${snapshot.artifacts.length}`,
					`Transitions: ${snapshot.transitions.length}`,
					snapshot.budgetTotals ? `Budget: ${JSON.stringify(snapshot.budgetTotals)}` : "Budget: (none)",
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: {
						op: "status",
						workflowId,
						status: snapshot.state.status,
						approvalTier: tier,
					},
				};
			}

			if (params.op === "resume") {
				const workflowId = params.workflowId?.trim();
				if (!workflowId) throw new ToolError("workflowId is required when op=resume");
				activeWorkflowId = workflowId;
				const result = await engine.resume(workflowId, {
					singleStep: params.singleStep === true,
					session: this.#session,
					signal,
					forceUnlock: params.forceUnlock === true,
				});
				return {
					content: [
						{
							type: "text",
							text: `Workflow resumed: ${workflowId}\nStatus: ${result.state.status}\nStage: ${result.state.currentStage}`,
						},
					],
					details: {
						op: "resume",
						workflowId,
						status: result.state.status,
						approvalTier: tier,
					},
				};
			}

			const workflowId = params.workflowId?.trim();
			if (!workflowId) throw new ToolError("workflowId is required when op=cancel");
			const state = await engine.cancel(workflowId);
			return {
				content: [{ type: "text", text: `Workflow cancelled: ${workflowId}\nStatus: ${state.status}` }],
				details: { op: "cancel", workflowId, status: state.status, approvalTier: tier },
			};
		} catch (error) {
			if (error instanceof ToolError) throw error;
			if (error instanceof WorkflowPolicyError) {
				throw new ToolError(error.message);
			}
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			// Dispose engine-owned SQLite handle when this tool call ends.
			engine.dispose?.();
		}
	}
}
