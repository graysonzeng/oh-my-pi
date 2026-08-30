import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import workflowDescription from "../prompts/tools/workflow.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { WorkflowEngine } from "./engine";
import { WorkflowPolicyError } from "./errors";
import { emptyDevflowSidecar, type PipelineAuditorInput, type PipelineCompletenessResult } from "./overlay";
import { WorkflowStore } from "./sqlite-store";
import type { WorkflowAvailabilityReport, WorkflowStatus, WorkflowStatusReportV1 } from "./types";

const workflowSchema = type({
	"+": "reject",
	op: type("'start' | 'status' | 'resume' | 'cancel' | 'run'").describe("workflow operation"),
	"request?": type("string").describe("start/run: user request / objective"),
	"constraints?": type("string").describe("start/run: optional constraints"),
	"qualityTier?": type("'balanced' | 'critical'").describe("start/run: quality route tier; defaults from settings"),
	"workflowId?": type("string").describe("status/resume/cancel: workflow id"),
	"degradedMode?": type("boolean").describe("start/run: allow same-vendor review"),
	"singleStep?": type("boolean").describe("resume: run only one stage"),
	"forceUnlock?": type("boolean").describe("resume: clear stale runner_owner after crash"),
	"pipeline?": type("'devflow'").describe("start/run: DevFlow overlay; omit for legacy"),
	"grillAnswers?": type("string[]").describe("start/run: pre-stage grill answers copied into sidecar"),
});

export type WorkflowToolInput = typeof workflowSchema.infer;

export type WorkflowToolDetails = {
	op: WorkflowToolInput["op"];
	workflowId?: string;
	status?: WorkflowStatus;
	approvalTier: "read" | "write";
	availability?: WorkflowAvailabilityReport;
	statusReport?: WorkflowStatusReportV1;
	stepsExecuted?: number;
	maxStepsReached?: boolean;
	awaitingGrill?: boolean;
	overlayReason?: string;
};

/**
 * Approval tiers:
 * - status: read-only
 * - start | resume | cancel: write
 */
export function approvalTierForOp(op: WorkflowToolInput["op"]): "read" | "write" {
	return op === "status" ? "read" : "write";
}

function createOptsFromParams(params: WorkflowToolInput) {
	if (params.pipeline !== "devflow") return undefined;
	return {
		pipelineKind: "devflow" as const,
		overlaySidecar: emptyDevflowSidecar(params.grillAnswers ?? []),
	};
}

export class WorkflowTool implements AgentTool<typeof workflowSchema, WorkflowToolDetails> {
	readonly name = "workflow";
	readonly label = "Workflow";
	readonly loadMode = "discoverable" as const;
	// Static prompt file — no Handlebars vars; avoid pi-utils/prompt (pulls natives) for pure tests
	readonly description = workflowDescription.trim();
	readonly parameters = workflowSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	/** status → read; start|resume|cancel → write (never default to bare exec). */
	readonly approval = (args: unknown): "read" | "write" => {
		const op = args && typeof args === "object" && "op" in args ? String((args as { op?: unknown }).op) : "";
		if (op === "start" || op === "resume" || op === "cancel" || op === "status" || op === "run") {
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

	async auditDeliveryCompleteness(input: PipelineAuditorInput): Promise<PipelineCompletenessResult> {
		const engine = this.#engineFactory(this.#session);
		try {
			return await engine.auditPipelineCompleteness(input);
		} finally {
			engine.dispose?.();
		}
	}

	async recoverDeliveryGrill(workflowId: string, answers: readonly string[], reason?: string): Promise<void> {
		const engine = this.#engineFactory(this.#session);
		try {
			await engine.appendGrillAnswers(workflowId, answers);
			if (reason === "needs_redesign") {
				await engine.replanFromRedesign(workflowId);
			}
		} finally {
			engine.dispose?.();
		}
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
				const started = await engine.start(
					{ request, constraints: params.constraints, qualityTier: params.qualityTier },
					{ degradedMode: params.degradedMode === true },
					createOptsFromParams(params),
				);
				const workflowId = started.workflowId;
				activeWorkflowId = workflowId;
				const state = await engine.getState(workflowId);
				const availabilityText = `${formatQualityRoutePolicy(state?.policyJson)}\n${formatAvailabilitySummary(started.availability)}`;
				return {
					content: [
						{
							type: "text",
							text: `Workflow started: ${workflowId}\nStatus: ${state?.status ?? "created"}\n${availabilityText}`,
						},
					],
					details: {
						op: "start",
						workflowId,
						status: state?.status,
						approvalTier: tier,
						availability: started.availability,
					},
				};
			}

			if (params.op === "status") {
				const workflowId = params.workflowId?.trim();
				if (!workflowId) throw new ToolError("workflowId is required when op=status");
				const report = await engine.getStatusReport(workflowId);
				if (!report) throw new ToolError(`Workflow not found: ${workflowId}`);
				const text = [
					`Workflow: ${workflowId}`,
					`Status: ${report.status}`,
					`Stage: ${report.currentStage}`,
					`Version: ${report.version}`,
					`Attempts: ${report.attemptCount}`,
					`Artifacts: ${report.artifactCount}`,
					`Transitions: ${report.transitionCount}`,
					report.budgetTotals ? `Budget: ${JSON.stringify(report.budgetTotals)}` : "Budget: (none)",
					formatWorkflowStatusReport(report),
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: {
						op: "status",
						workflowId,
						status: report.status,
						approvalTier: tier,
						statusReport: report,
					},
				};
			}

			if (params.op === "run") {
				const request = params.request?.trim();
				if (!request) throw new ToolError("request is required when op=run");
				const started = await engine.start(
					{ request, constraints: params.constraints, qualityTier: params.qualityTier },
					{ degradedMode: params.degradedMode === true },
					createOptsFromParams(params),
				);
				const workflowId = started.workflowId;
				activeWorkflowId = workflowId;
				const result = await engine.run(workflowId, this.#session);
				const availabilityText = result.availability ? `\n${formatAvailabilitySummary(result.availability)}` : "";
				const statusReport = await engine.getStatusReport(workflowId);
				const qualityRouteText = `\n${
					statusReport
						? formatWorkflowStatusReport(statusReport)
						: formatQualityRoutePolicy(result.state.policyJson)
				}`;
				const capText = result.maxStepsReached ? "\nmaxStepsReached=true (resume to continue; cap=32)" : "";
				const grillText = result.awaitingGrill
					? `\nawaitingGrill=true reason=${result.overlayReason ?? "unknown"}`
					: "";
				return {
					content: [
						{
							type: "text",
							text: `Workflow run: ${workflowId}\nStatus: ${result.state.status}\nStage: ${result.state.currentStage}\nstepsExecuted=${result.stepsExecuted}${capText}${grillText}${qualityRouteText}${availabilityText}`,
						},
					],
					details: {
						op: "run",
						workflowId,
						status: result.state.status,
						approvalTier: tier,
						availability: result.availability ?? started.availability,
						stepsExecuted: result.stepsExecuted,
						maxStepsReached: result.maxStepsReached,
						awaitingGrill: result.awaitingGrill,
						overlayReason: result.overlayReason,
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
				const availabilityText = result.availability ? `\n${formatAvailabilitySummary(result.availability)}` : "";
				const statusReport = await engine.getStatusReport(workflowId);
				const qualityRouteText = `\n${
					statusReport
						? formatWorkflowStatusReport(statusReport)
						: formatQualityRoutePolicy(result.state.policyJson)
				}`;
				return {
					content: [
						{
							type: "text",
							text: `Workflow resumed: ${workflowId}\nStatus: ${result.state.status}\nStage: ${result.state.currentStage}${qualityRouteText}${availabilityText}`,
						},
					],
					details: {
						op: "resume",
						workflowId,
						status: result.state.status,
						approvalTier: tier,
						availability: result.availability,
						stepsExecuted: result.stepsExecuted,
						maxStepsReached: result.maxStepsReached,
						awaitingGrill: result.awaitingGrill,
						overlayReason: result.overlayReason,
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

function formatAvailabilitySummary(report: WorkflowAvailabilityReport): string {
	const lines = [`Availability: ${report.status} (scope=${report.scope}, wall=${report.wallLatencyMs}ms)`];
	for (const row of report.profiles) {
		const id = `${row.role}/${row.profileId}`;
		const local =
			row.localProvider || row.localModel
				? `${row.localProvider ?? "unknown"}/${row.localModel ?? "unknown"}`
				: "unknown";
		const attested =
			row.attestedProvider || row.attestedModel
				? `${row.attestedProvider ?? "unknown"}/${row.attestedModel ?? "unknown"}`
				: "unknown";
		const identity = `local=${local} attested=${attested} exact=${row.exactIdentityMatch ?? "unknown"}`;
		const cost = row.reportedCostUsd === undefined ? "" : ` cost=${row.reportedCostUsd ?? "unknown"}`;
		if (row.status === "available") {
			lines.push(`  - ${id}: available ${identity} ${row.latencyMs ?? "?"}ms${cost} [${row.requirement}]`);
		} else {
			const err = row.errorKind ? ` ${row.errorKind}` : "";
			const latency = row.latencyMs === undefined ? "" : ` ${row.latencyMs}ms`;
			lines.push(`  - ${id}: ${row.status}${err}${latency}${cost} ${identity} [${row.requirement}]`);
		}
	}
	if (report.blockedRoles && report.blockedRoles.length > 0) {
		lines.push(`  blocked roles: ${report.blockedRoles.join(", ")}`);
	}
	return lines.join("\n");
}

function formatQualityRoutePolicy(policyJson: string | undefined): string {
	if (!policyJson) return "Quality route: legacy role-based routing";
	try {
		const policy = JSON.parse(policyJson) as {
			qualityRouteSnapshot?: {
				qualityTier?: unknown;
				fingerprint?: unknown;
				routes?: Record<string, unknown>;
			};
		};
		const route = policy.qualityRouteSnapshot;
		if (!route) return "Quality route: legacy role-based routing";
		const roles = Object.entries(route.routes ?? {})
			.map(([role, value]) => `${role}=[${Array.isArray(value) ? value.map(String).join(",") : ""}]`)
			.join(" ");
		return `Quality route: tier=${String(route.qualityTier ?? "unknown")} fingerprint=${String(
			route.fingerprint ?? "unknown",
		)}${roles ? `\nConfigured routes: ${roles}` : ""}`;
	} catch {
		return "Quality route: invalid persisted policy";
	}
}

function formatWorkflowStatusReport(report: WorkflowStatusReportV1): string {
	const quality = report.qualityRoute;
	const lines = [
		`Quality route: status=${quality.status} tier=${quality.qualityTier ?? "unknown"} fingerprint=${quality.snapshotFingerprint ?? "unknown"}`,
	];
	const configuredRoutes = quality.configuredStages
		.filter(stage => stage.orderedProfileIds !== null)
		.map(stage => `${stage.role}=[${stage.orderedProfileIds!.join(",")}]`)
		.join(" ");
	if (configuredRoutes) lines.push(`Configured routes: ${configuredRoutes}`);
	for (const attempt of report.modelAttempts) {
		lines.push(
			`Model attempt: stage=${attempt.stage} role=${attempt.role} ordinal=${attempt.ordinal} status=${attempt.status} profile=${attempt.configuredProfileId ?? "unknown"} evidence=${attempt.evidenceStatus}`,
		);
		for (const routing of attempt.routing) {
			const skipped = routing.skipped.map(entry => `${entry.profileId ?? "unknown"}:${entry.reason}`).join(",");
			lines.push(
				`  route: selected=${routing.selectedProfileId ?? "unknown"} fallbackFrom=${routing.fallbackFrom ?? "none"} reason=${routing.reason ?? "none"}${skipped ? ` skipped=[${skipped}]` : ""}`,
			);
		}
		for (const execution of attempt.executions) {
			const configured = execution.configuredIdentity;
			const local = execution.localResolution;
			const attested = execution.attestedIdentity;
			lines.push(
				`  execution: profile=${execution.profileId ?? "unknown"} configured=${configured?.provider ?? "unknown"}/${configured?.model ?? "unknown"}:${configured?.requestedEffort ?? "unknown"} local=${local?.provider ?? "unknown"}/${local?.model ?? "unknown"} attested=${attested?.provider ?? "unknown"}/${attested?.model ?? "unknown"}@${attested?.checkpoint ?? "unknown"} provenance=${attested?.provenance ?? "unknown"} exact=${execution.exactIdentityMatch ?? "unknown"} effortSupported=${execution.effortSupported ?? "unknown"} lineage=${execution.modelFamily ?? "unknown"}`,
			);
		}
	}
	return lines.join("\n");
}
