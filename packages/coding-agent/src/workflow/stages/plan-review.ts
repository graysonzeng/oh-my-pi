import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../tools";
import { ReviewArtifactJsonSchema } from "../json-schemas";
import { coerceIsoDatetime, parseWorkflowArtifact } from "../parse-artifact";
import { ReviewArtifactSchema } from "../schemas";
import type {
	ContextLedgerV1,
	ModelProfile,
	PromptAssemblyReceiptV1,
	ReviewArtifactV1,
	RuntimePort,
	WorkflowRuntimeIdentityReceiptV1,
} from "../types";

export interface PlanReviewStageInput {
	workflowId: string;
	attemptId: string;
	profile: ModelProfile;
	assignment: string;
	context: string;
	session: ToolSession;
	signal?: AbortSignal;
}

export interface PlanReviewStageResult {
	artifact: ReviewArtifactV1;
	usage?: Usage;
	promptAssemblyReceipt?: PromptAssemblyReceiptV1;
	contextLedger?: ContextLedgerV1;
	optimizationReceipts?: unknown[];
	resolvedProvider?: string;
	resolvedModel?: string;
	toolCalls?: number;
	identityReceipt?: WorkflowRuntimeIdentityReceiptV1;
	modelFamily?: string;
	/** Tool policy actually applied to this stage (named profile policy or role default). */
	resolvedToolPolicyId?: string;
}

export class PlanReviewStage {
	readonly #runtime: RuntimePort;

	constructor(runtime: RuntimePort) {
		this.#runtime = runtime;
	}

	async execute(input: PlanReviewStageInput): Promise<PlanReviewStageResult> {
		const request = this.#runtime.buildRequest({
			workflowId: input.workflowId,
			attemptId: input.attemptId,
			role: "plan_reviewer",
			profile: input.profile,
			assignment: input.assignment,
			context: input.context,
			outputSchema: ReviewArtifactJsonSchema,
			session: input.session,
			signal: input.signal,
		});
		const result = await this.#runtime.run<ReviewArtifactV1>(request);
		const artifact = parseWorkflowArtifact(
			ReviewArtifactSchema,
			{
				...result.artifact,
				kind: "review",
				subject: "plan",
				schemaVersion: 1,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "plan_review",
				createdAt: coerceIsoDatetime((result.artifact as ReviewArtifactV1).createdAt),
				modelProfileId: input.profile.id,
				provider: result.identityReceipt?.attested.provider ?? result.resolvedProvider ?? input.profile.vendor,
				model: result.identityReceipt?.attested.model ?? result.resolvedModel,
				promptVersion: input.profile.promptVersion,
			},
			"PlanReviewArtifact",
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
			resolvedToolPolicyId: result.resolvedToolPolicyId,
		};
	}
}
