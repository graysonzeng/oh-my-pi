import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../tools";
import { WorkflowPolicyError } from "../errors";
import { ImplementationArtifactJsonSchema } from "../json-schemas";
import { coerceIsoDatetime, parseWorkflowArtifact } from "../parse-artifact";
import { ImplementationArtifactSchema } from "../schemas";
import type {
	ContextLedgerV1,
	ImplementationArtifactV1,
	ModelProfile,
	PromptAssemblyReceiptV1,
	RuntimePort,
	WorkflowCompletionKind,
	WorkflowRuntimeIdentityReceiptV1,
} from "../types";

export interface ImplementStageInput {
	workflowId: string;
	attemptId: string;
	profile: ModelProfile;
	assignment: string;
	context: string;
	session: ToolSession;
	signal?: AbortSignal;
	isolation?: { requested?: boolean; merge?: "patch" | "branch"; apply?: boolean };
}

export interface ImplementStageResult {
	artifact: ImplementationArtifactV1;
	usage?: Usage;
	changesApplied?: boolean | null;
	resolvedProvider?: string;
	resolvedModel?: string;
	toolCalls?: number;
	promptAssemblyReceipt?: PromptAssemblyReceiptV1;
	contextLedger?: ContextLedgerV1;
	optimizationReceipts?: unknown[];
	identityReceipt?: WorkflowRuntimeIdentityReceiptV1;
	modelFamily?: string;
	/** Tool policy actually applied to this stage (named profile policy or role default). */
	resolvedToolPolicyId?: string;
	completionKind?: WorkflowCompletionKind;
}

export class ImplementStage {
	readonly #runtime: RuntimePort;

	constructor(runtime: RuntimePort) {
		this.#runtime = runtime;
	}

	async execute(input: ImplementStageInput): Promise<ImplementStageResult> {
		const strictIdentity = input.profile.strictIdentity === true;
		const isolation = {
			...input.isolation,
			merge: strictIdentity ? ("patch" as const) : (input.isolation?.merge ?? "patch"),
			apply: strictIdentity ? false : (input.isolation?.apply ?? true),
			requested: true, // isolation required for write stages
		};
		const request = this.#runtime.buildRequest({
			workflowId: input.workflowId,
			attemptId: input.attemptId,
			role: "implementer",
			profile: input.profile,
			assignment: input.assignment,
			context: input.context,
			outputSchema: ImplementationArtifactJsonSchema,
			isolation,
			session: input.session,
			signal: input.signal,
		});
		const result = await this.#runtime.run<ImplementationArtifactV1>(request);
		const modelArtifact = result.artifact as ImplementationArtifactV1;
		// Trust only runtime isolation metadata for patch/branch — never model fiction alone.
		const patchPath = result.patchPath;
		const branchName = result.branchName;
		if (isolation.requested && !patchPath && !branchName) {
			throw new WorkflowPolicyError("implementation_missing_isolation_artifact", {
				attemptId: input.attemptId,
				hint: "Isolation write stages must return patchPath or branchName from the runtime adapter",
			});
		}
		const artifact = parseWorkflowArtifact<ImplementationArtifactV1>(
			ImplementationArtifactSchema,
			{
				...modelArtifact,
				kind: "implementation",
				schemaVersion: 1,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "implementing",
				createdAt: coerceIsoDatetime(modelArtifact.createdAt),
				modelProfileId: input.profile.id,
				provider: result.identityReceipt?.attested.provider ?? result.resolvedProvider ?? input.profile.vendor,
				model: result.identityReceipt?.attested.model ?? result.resolvedModel,
				promptVersion: input.profile.promptVersion,
				patchPath,
				branchName,
				// Model-reported changedFiles are advisory only when a real patch exists;
				// empty until verify derives paths from patch content.
				changedFiles: modelArtifact.changedFiles ?? [],
				commandsRun: modelArtifact.commandsRun ?? [],
				addressedStepIds: modelArtifact.addressedStepIds ?? [],
				unresolved: modelArtifact.unresolved ?? [],
				summary: modelArtifact.summary ?? "implementation",
			},
			"ImplementationArtifact",
		);
		return {
			artifact,
			usage: result.usage,
			changesApplied: result.changesApplied,
			resolvedProvider: result.resolvedProvider,
			resolvedModel: result.resolvedModel,
			toolCalls: result.toolCalls,
			identityReceipt: result.identityReceipt,
			modelFamily: result.modelFamily,
			promptAssemblyReceipt: result.promptAssemblyReceipt,
			contextLedger: result.contextLedger,
			optimizationReceipts: result.optimizationReceipts,
			resolvedToolPolicyId: result.resolvedToolPolicyId,
			completionKind: result.completionKind,
		};
	}
}
