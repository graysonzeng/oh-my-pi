import { commandConsumed } from "../slash-commands/helpers/parse";
import type { SlashCommandResult, SlashCommandRuntime } from "../slash-commands/types";
import type { PipelineAuditor } from "../workflow/overlay";
import type { WorkflowTool, WorkflowToolDetails, WorkflowToolInput } from "../workflow/workflow-tool";

export interface DeliveryPipelineDeps {
	auditor?: PipelineAuditor;
	executeWorkflow?: (
		input: WorkflowToolInput,
	) => Promise<{ details?: WorkflowToolDetails; content?: ReadonlyArray<{ type: string; text?: string }> }>;
	collectRequest?: (args: string) => string;
}

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

/**
 * Session coordinator for `/delivery`. Invokes `workflow op=run pipeline=devflow`.
 * Not a slash discovery entry and not workflowz.
 */
export async function runDeliveryPipeline(
	runtime: SlashCommandRuntime,
	args: string,
	deps: DeliveryPipelineDeps = {},
): Promise<SlashCommandResult> {
	const request = deps.collectRequest?.(args) ?? collectSessionRequest(runtime, args);
	if (!request.trim()) {
		await runtime.output("Usage: /delivery [optional request patch]");
		return commandConsumed();
	}

	const auditor = deps.auditor;
	if (auditor) {
		const preflight = await auditor({ kind: "preflight", request });
		if (!preflight.complete) {
			await runtime.output(preflight.next ?? (preflight.missing.join("\n") || "Need more detail before planning."));
			return commandConsumed();
		}
	}

	const execute =
		deps.executeWorkflow ??
		(async (input: WorkflowToolInput) => {
			const tool = runtime.session.getToolByName("workflow") as WorkflowTool | undefined;
			if (!tool) throw new Error("Workflow tool is unavailable");
			return tool.execute("delivery", input);
		});

	let result = await execute({
		op: "run",
		request,
		pipeline: "devflow",
	});
	let details = result.details;
	while (details?.maxStepsReached && details.workflowId && !details.awaitingGrill) {
		result = await execute({ op: "resume", workflowId: details.workflowId });
		details = result.details;
	}
	const text = result.content?.[0] && "text" in result.content[0] ? result.content[0].text : undefined;
	if (details?.awaitingGrill) {
		await runtime.output(text ?? `Delivery paused for grilling (${details.overlayReason ?? "unknown"}).`);
		return commandConsumed();
	}
	await runtime.output(
		text ?? `Delivery workflow ${details?.workflowId ?? ""} status=${details?.status ?? "unknown"}`,
	);
	return commandConsumed();
}
