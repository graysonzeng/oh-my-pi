import * as path from "node:path";
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
	WorkflowCompletionKind,
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
	/** Tool policy actually applied to this stage (named profile policy or role default). */
	resolvedToolPolicyId?: string;
	completionKind?: WorkflowCompletionKind;
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
		const modelArtifact = result.artifact;
		const noChangesRequired = modelArtifact.noChangesRequired === true;
		// Trust runtime isolation metadata for real writes. An explicit strict no-op may
		// carry no patch or a newly emitted empty patch, but never a branch artifact or
		// a non-empty patch (that would contradict the declaration).
		const patchPath = result.patchPath;
		const branchName = result.branchName;
		if (noChangesRequired) {
			if (branchName) {
				throw new WorkflowPolicyError("repair_noop_branch_conflict", {
					attemptId: input.attemptId,
					branchName,
				});
			}
			if (patchPath) {
				const resolved = path.isAbsolute(patchPath) ? patchPath : path.join(input.session.cwd, patchPath);
				try {
					const patch = await Bun.file(resolved).text();
					if (patch.trim().length > 0) {
						throw new WorkflowPolicyError("repair_noop_patch_non_empty", {
							attemptId: input.attemptId,
							patchPath,
						});
					}
				} catch (error) {
					if (error instanceof WorkflowPolicyError) throw error;
					if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
						throw error;
					}
				}
			}
		} else if (!patchPath && !branchName) {
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
		const artifact = parseWorkflowArtifact<ImplementationArtifactV1>(
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
			resolvedToolPolicyId: result.resolvedToolPolicyId,
			completionKind: result.completionKind,
		};
	}
}
