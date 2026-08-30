import { commandConsumed } from "../slash-commands/helpers/parse";
import type { SlashCommandResult, SlashCommandRuntime } from "../slash-commands/types";
import { isAwaitingGrill, type OverlaySidecar, overlayReason, type PipelineAuditor } from "../workflow/overlay";
import { WorkflowStore } from "../workflow/sqlite-store";
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
	appendAnswers?: (workflowId: string, answers: readonly string[]) => Promise<void>;
	replanFromRedesign?: (workflowId: string) => Promise<void>;
}

type DeliveryPreflightState = { round: number; answers: string[] };

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

function storeFromRuntime(runtime: SlashCommandRuntime): WorkflowStore | null {
	if (!runtime.settings) return null;
	const storageRaw = runtime.settings.get("workflow.storagePath");
	const storage = typeof storageRaw === "string" && storageRaw.length > 0 ? storageRaw : "";
	return storage ? new WorkflowStore(storage) : new WorkflowStore();
}

async function defaultLoadActiveDevflow(runtime: SlashCommandRuntime): Promise<ActiveDevflowSnapshot | null> {
	const store = storeFromRuntime(runtime);
	if (!store) return null;
	try {
		const state = await store.findLatestActiveDevflow();
		if (!state) return null;
		return {
			workflowId: state.id,
			runnerOwner: state.runnerOwner,
			sidecar: state.overlaySidecar,
		};
	} finally {
		store.close();
	}
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

	const active = await (deps.loadActiveDevflow ?? (() => defaultLoadActiveDevflow(runtime)))();
	if (active && isAwaitingGrill(active.sidecar) && !active.runnerOwner) {
		const answer = explicitGrillAnswer(args, active.sidecar?.grill.lastQuestion ?? "");
		if (!answer) {
			await runtime.output(active.sidecar?.grill.lastQuestion || "Answer the open delivery question to continue.");
			return commandConsumed();
		}
		if (deps.appendAnswers) {
			await deps.appendAnswers(active.workflowId, [answer]);
			if (overlayReason(active.sidecar) === "needs_redesign") {
				await deps.replanFromRedesign?.(active.workflowId);
			}
		} else if (tool) {
			await tool.recoverDeliveryGrill(active.workflowId, [answer], overlayReason(active.sidecar));
		}
		return emitResult(await execute({ op: "resume", workflowId: active.workflowId }));
	}

	const request = deps.collectRequest?.(args) ?? collectSessionRequest(runtime, args);
	if (!request.trim()) {
		await runtime.output("Usage: /delivery [optional request patch]");
		return commandConsumed();
	}

	const auditor = deps.auditor ?? toolAuditor(tool);
	const prior = preflightRounds.get(runtime.session) ?? { round: 0, answers: [] };
	const answer = prior.round > 0 ? explicitGrillAnswer(args) : "";
	const answers = answer ? [...prior.answers, answer] : prior.answers;
	if (auditor) {
		const preflight = await auditor({ kind: "preflight", request, grillAnswers: answers });
		if (!preflight.complete) {
			const round = prior.round + 1;
			if (round >= 8) {
				preflightRounds.delete(runtime.session);
				await runtime.output(preflight.missing.join("\n") || "Still missing required detail after 8 questions.");
				return commandConsumed();
			}
			preflightRounds.set(runtime.session, { round, answers });
			await runtime.output(preflight.next ?? (preflight.missing.join("\n") || "Need more detail before planning."));
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
