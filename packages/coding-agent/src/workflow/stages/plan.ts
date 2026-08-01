import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../tools";
import { PlanArtifactJsonSchema } from "../json-schemas";
import { coerceIsoDatetime, parseWorkflowArtifact } from "../parse-artifact";
import { PlanArtifactSchema } from "../schemas";
import type {
	ContextLedgerV1,
	ModelProfile,
	PlanArtifactV1,
	PromptAssemblyReceiptV1,
	RuntimePort,
	WorkflowRuntimeIdentityReceiptV1,
} from "../types";

export interface PlanStageInput {
	workflowId: string;
	attemptId: string;
	profile: ModelProfile;
	assignment: string;
	context: string;
	session: ToolSession;
	signal?: AbortSignal;
}

export interface PlanStageResult {
	artifact: PlanArtifactV1;
	usage?: Usage;
	promptAssemblyReceipt?: PromptAssemblyReceiptV1;
	contextLedger?: ContextLedgerV1;
	optimizationReceipts?: unknown[];
	resolvedProvider?: string;
	resolvedModel?: string;
	toolCalls?: number;
	identityReceipt?: WorkflowRuntimeIdentityReceiptV1;
	modelFamily?: string;
}

export class PlanStage {
	readonly #runtime: RuntimePort;

	constructor(runtime: RuntimePort) {
		this.#runtime = runtime;
	}

	async execute(input: PlanStageInput): Promise<PlanStageResult> {
		const request = this.#runtime.buildRequest({
			workflowId: input.workflowId,
			attemptId: input.attemptId,
			role: "planner",
			profile: input.profile,
			assignment: input.assignment,
			context: input.context,
			outputSchema: PlanArtifactJsonSchema,
			session: input.session,
			signal: input.signal,
		});
		const result = await this.#runtime.run<PlanArtifactV1>(request);
		const artifact = parseWorkflowArtifact(
			PlanArtifactSchema,
			{
				...result.artifact,
				kind: "plan",
				schemaVersion: 1,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "planning",
				createdAt: coerceIsoDatetime((result.artifact as PlanArtifactV1).createdAt),
				modelProfileId: input.profile.id,
				provider: result.identityReceipt?.attested.provider ?? result.resolvedProvider ?? input.profile.vendor,
				model: result.identityReceipt?.attested.model ?? result.resolvedModel,
				promptVersion: input.profile.promptVersion,
			},
			"PlanArtifact",
		);
		return {
			artifact,
			usage: result.usage,
			resolvedProvider: result.resolvedProvider,
			resolvedModel: result.resolvedModel,
			toolCalls: result.toolCalls,
			identityReceipt: result.identityReceipt,
			modelFamily: result.modelFamily,
			promptAssemblyReceipt: result.promptAssemblyReceipt,
			contextLedger: result.contextLedger,
			optimizationReceipts: result.optimizationReceipts,
		};
	}
}
