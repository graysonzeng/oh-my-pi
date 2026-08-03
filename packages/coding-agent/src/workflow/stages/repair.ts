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
	ReviewFindingV1,
	RuntimePort,
	WorkflowRuntimeIdentityReceiptV1,
} from "../types";

export interface RepairStageInput {
	workflowId: string;
	attemptId: string;
	profile: ModelProfile;
	findingIds: string[];
	findings: ReviewFindingV1[];
	assignment: string;
	context: string;
	session: ToolSession;
	signal?: AbortSignal;
	isolation?: { merge?: "patch" | "branch"; apply?: boolean };
}

export interface RepairStageResult {
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
}

export class RepairStage {
	readonly #runtime: RuntimePort;

	constructor(runtime: RuntimePort) {
		this.#runtime = runtime;
	}

	async execute(input: RepairStageInput): Promise<RepairStageResult> {
		const strictIdentity = input.profile.strictIdentity === true;
		const isolation = {
			requested: true,
			merge: strictIdentity ? ("patch" as const) : (input.isolation?.merge ?? "patch"),
			apply: strictIdentity ? false : (input.isolation?.apply ?? true),
		};
		const request = this.#runtime.buildRequest({
			workflowId: input.workflowId,
			attemptId: input.attemptId,
			role: "repair",
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
		// Trust only runtime isolation metadata for patch/branch.
		const patchPath = result.patchPath;
		const branchName = result.branchName;
		if (!patchPath && !branchName) {
			throw new WorkflowPolicyError("repair_missing_isolation_artifact", {
				attemptId: input.attemptId,
				hint: "Repair must return patchPath or branchName from the runtime adapter",
			});
		}
		// Empty addressedStepIds must NOT auto-resolve all findings (fail-closed honesty).
		const addressed =
			Array.isArray(modelArtifact.addressedStepIds) && modelArtifact.addressedStepIds.length > 0
				? modelArtifact.addressedStepIds.filter(id => input.findingIds.includes(id))
				: [];
		const artifact = parseWorkflowArtifact(
			ImplementationArtifactSchema,
			{
				...modelArtifact,
				kind: "implementation",
				schemaVersion: 1,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "repairing",
				createdAt: coerceIsoDatetime(modelArtifact.createdAt),
				modelProfileId: input.profile.id,
				provider: result.identityReceipt?.attested.provider ?? result.resolvedProvider ?? input.profile.vendor,
				model: result.identityReceipt?.attested.model ?? result.resolvedModel,
				promptVersion: input.profile.promptVersion,
				patchPath,
				branchName,
				addressedStepIds: addressed,
				// Union model-reported unresolved work with unrepaired finding ids.
				unresolved: [
					...new Set([
						...(modelArtifact.unresolved ?? []),
						...input.findingIds.filter(id => !addressed.includes(id)),
					]),
				],
				commandsRun: modelArtifact.commandsRun ?? [],
				changedFiles: modelArtifact.changedFiles ?? [],
				summary: modelArtifact.summary ?? "repair",
			},
			"RepairArtifact",
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
		};
	}
}
