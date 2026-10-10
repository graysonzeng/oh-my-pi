import { commandConsumed } from "../slash-commands/helpers/parse";
import type { SlashCommandResult, SlashCommandRuntime } from "../slash-commands/types";
import { isAwaitingGrill, type OverlaySidecar, type PipelineAuditor } from "../workflow/overlay";
import type { WorkflowTool, WorkflowToolDetails, WorkflowToolInput } from "../workflow/workflow-tool";

export interface ActiveDevflowSnapshot {
	workflowId: string;
	runnerOwner?: string;
	sidecar?: OverlaySidecar;
}

export interface DeliveryPipelineDeps {
	auditor?: PipelineAuditor;
	executeWorkflow?: (
		input: WorkflowToolInput,
	) => Promise<{ details?: WorkflowToolDetails; content?: ReadonlyArray<{ type: string; text?: string }> }>;
	collectRequest?: (args: string) => string;
	loadActiveDevflow?: () => Promise<ActiveDevflowSnapshot | null>;
	recoverGrill?: (workflowId: string, answers: readonly string[]) => Promise<void>;
}

type DeliveryPreflightState = { round: number; request: string; answers: string[] };

const preflightRounds = new WeakMap<object, DeliveryPreflightState>();

function collectSessionRequest(runtime: SlashCommandRuntime, args: string): string {
	const extra = args.trim();
	const entries = runtime.session.sessionManager?.getEntries?.() ?? [];
	const userLines: string[] = [];
	for (const entry of entries) {
		const record = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (record.type !== "message" || record.message?.role !== "user") continue;
		const content = record.message.content;
		if (typeof content === "string" && content.trim()) userLines.push(content.trim());
		else if (Array.isArray(content)) {
			for (const part of content) {
				if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
					userLines.push(part.text);
				}
			}
		}
	}
	const transcript = userLines.join("\n").trim();
	if (transcript && extra) return `${transcript}\n${extra}`;
	return extra || transcript;
}

function explicitGrillAnswer(args: string, lastQuestion = ""): string {
	const answer = args.trim();
	if (!answer || answer === lastQuestion) return "";
	return answer;
}

function toolAuditor(tool: WorkflowTool | undefined): PipelineAuditor | undefined {
	if (!tool || typeof tool.auditDeliveryCompleteness !== "function") return undefined;
	return input => tool.auditDeliveryCompleteness(input);
}

async function defaultLoadActiveDevflow(
	runtime: SlashCommandRuntime,
	tool: WorkflowTool | undefined,
): Promise<ActiveDevflowSnapshot | null> {
	if (!tool || typeof tool.findActiveDeliveryWorkflow !== "function") return null;
	const ownerSessionId = runtime.sessionManager.getSessionId();
	if (!ownerSessionId) return null;
	const state = await tool.findActiveDeliveryWorkflow(ownerSessionId);
	if (!state) return null;
	return {
		workflowId: state.id,
		runnerOwner: state.runnerOwner,
		sidecar: state.overlaySidecar,
	};
}

/**
 * Session coordinator for `/delivery`. Invokes `workflow op=run pipeline=devflow`.
 * Not a slash discovery entry and not workflowz.
 */
export async function runDeliveryPipeline(
	runtime: SlashCommandRuntime,
	args: string,
	deps: DeliveryPipelineDeps = {},
): Promise<SlashCommandResult> {
	const tool = runtime.session.getToolByName?.("workflow") as WorkflowTool | undefined;
	const execute =
		deps.executeWorkflow ??
		(async (input: WorkflowToolInput) => {
			if (!tool) throw new Error("Workflow tool is unavailable");
			return tool.execute("delivery", input);
		});

	const emitResult = async (result: {
		details?: WorkflowToolDetails;
		content?: ReadonlyArray<{ type: string; text?: string }>;
	}) => {
		let next = result;
		let details = next.details;
		while (details?.maxStepsReached && details.workflowId && !details.awaitingGrill) {
			next = await execute({ op: "resume", workflowId: details.workflowId });
			details = next.details;
		}
		const text = next.content?.[0] && "text" in next.content[0] ? next.content[0].text : undefined;
		if (details?.awaitingGrill) {
			await runtime.output(text ?? `Delivery paused for grilling (${details.overlayReason ?? "unknown"}).`);
			return commandConsumed();
		}
		await runtime.output(
			text ?? `Delivery workflow ${details?.workflowId ?? ""} status=${details?.status ?? "unknown"}`,
		);
		return commandConsumed();
	};

	const active = await (deps.loadActiveDevflow ?? (() => defaultLoadActiveDevflow(runtime, tool)))();
	if (active?.runnerOwner) {
		await runtime.output(
			`Delivery workflow ${active.workflowId} is active and locked by runner ${active.runnerOwner}; no resume was started.`,
		);
		return commandConsumed();
	}
	if (active && isAwaitingGrill(active.sidecar)) {
		const answer = explicitGrillAnswer(args, active.sidecar?.grill.lastQuestion ?? "");
		if (!answer) {
			await runtime.output(active.sidecar?.grill.lastQuestion || "Answer the open delivery question to continue.");
			return commandConsumed();
		}
		if (deps.recoverGrill) {
			await deps.recoverGrill(active.workflowId, [answer]);
		} else if (tool) {
			await tool.recoverDeliveryGrill(active.workflowId, [answer]);
		}
		return emitResult(await execute({ op: "resume", workflowId: active.workflowId }));
	}
	if (active) {
		return emitResult(await execute({ op: "resume", workflowId: active.workflowId }));
	}

	const prior = preflightRounds.get(runtime.session);
	const request = prior?.request ?? deps.collectRequest?.(args) ?? collectSessionRequest(runtime, args);
	if (!request.trim()) {
		await runtime.output("Usage: /delivery [optional request patch]");
		return commandConsumed();
	}

	const auditor = deps.auditor ?? toolAuditor(tool);
	const state = prior ?? { round: 0, request, answers: [] };
	const answer = state.round > 0 ? explicitGrillAnswer(args) : "";
	const answers = answer ? [...state.answers, answer] : state.answers;
	if (auditor) {
		const audit = await auditor({ kind: "preflight", request, grillAnswers: answers });
		if (!audit.complete) {
			const round = state.round + 1;
			if (round > 8) {
				preflightRounds.delete(runtime.session);
				await runtime.output(audit.missing.join("\n") || "Still missing required detail after 8 questions.");
				return commandConsumed();
			}
			preflightRounds.set(runtime.session, { round, request, answers });
			await runtime.output(audit.next ?? (audit.missing.join("\n") || "Need more detail before planning."));
			return commandConsumed();
		}
		preflightRounds.delete(runtime.session);
	}

	return emitResult(
		await execute({
			op: "run",
			request,
			pipeline: "devflow",
			...(answers.length > 0 ? { grillAnswers: answers } : {}),
		}),
	);
}
