import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../tools";
import { PlanReviewArtifactV2JsonSchema, ReviewArtifactJsonSchema } from "../json-schemas";
import { coerceIsoDatetime, parseWorkflowArtifact } from "../parse-artifact";
import { PlanReviewArtifactV2StageSchema, ReviewArtifactSchema } from "../schemas";
import type {
	AuthorResponseV1,
	ContextLedgerV1,
	ModelProfile,
	PlanReviewArtifactV2,
	PlanReviewKindV1,
	PlanReviewTriggerReasonV1,
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
	/** Engine-owned V2 fields. Model values are ignored when an override is supplied. */
	requirementsSnapshotRef?: string;
	requirementsSnapshotSha256?: string;
	reviewKind?: PlanReviewKindV1;
	reviewRound?: 1 | 2;
	authorResponses?: AuthorResponseV1[];
	triggerReason?: Exclude<PlanReviewTriggerReasonV1, null> | null;
	routeSelectionReceiptRef?: string | null;
	cleanContextReceiptRef?: string | null;
	specEvidenceReceiptRef?: string | null;
	authorityReceiptRef?: string | null;
	/** Resume-only compatibility for persisted V1 plan-review workflows. */
	legacyV1?: boolean;
}

export interface PlanReviewStageResult {
	artifact: PlanReviewArtifactV2 | ReviewArtifactV1;
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
			role: input.reviewKind === "arbitration" ? "plan_arbitrator" : "plan_reviewer",
			profile: input.profile,
			assignment: input.assignment,
			context: input.context,
			outputSchema: input.legacyV1 ? ReviewArtifactJsonSchema : PlanReviewArtifactV2JsonSchema,
			session: input.session,
			signal: input.signal,
		});
		const result = await this.#runtime.run<PlanReviewArtifactV2 | ReviewArtifactV1>(request);
		if (input.legacyV1) {
			const modelArtifact = result.artifact as Partial<ReviewArtifactV1>;
			const artifact = parseWorkflowArtifact(
				ReviewArtifactSchema,
				{
					...modelArtifact,
					kind: "review",
					subject: "plan",
					schemaVersion: 1,
					workflowId: input.workflowId,
					attemptId: input.attemptId,
					stage: "plan_review",
					createdAt: coerceIsoDatetime(modelArtifact.createdAt),
					modelProfileId: input.profile.id,
					provider:
						result.identityReceipt?.attested.provider ??
						result.resolvedProvider ??
						modelArtifact.provider ??
						input.profile.vendor,
					model: result.identityReceipt?.attested.model ?? result.resolvedModel ?? modelArtifact.model,
					promptVersion: input.profile.promptVersion,
				},
				"ReviewArtifact",
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
		const modelArtifact = result.artifact as Partial<PlanReviewArtifactV2>;
		const reviewKind = input.reviewKind ?? modelArtifact.reviewKind ?? "initial";
		const artifact = parseWorkflowArtifact(
			PlanReviewArtifactV2StageSchema,
			{
				...modelArtifact,
				kind: "review",
				subject: "plan",
				schemaVersion: 2,
				workflowId: input.workflowId,
				attemptId: input.attemptId,
				stage: "plan_review",
				createdAt: coerceIsoDatetime(modelArtifact.createdAt),
				modelProfileId: input.profile.id,
				provider:
					result.identityReceipt?.attested.provider ??
					result.resolvedProvider ??
					modelArtifact.provider ??
					input.profile.vendor,
				model: result.identityReceipt?.attested.model ?? result.resolvedModel ?? modelArtifact.model ?? null,
				promptVersion: input.profile.promptVersion,
				reviewKind,
				requirementsSnapshotRef:
					input.requirementsSnapshotRef ??
					modelArtifact.requirementsSnapshotRef ??
					`artifact://${input.workflowId}/requirements`,
				requirementsSnapshotSha256:
					input.requirementsSnapshotSha256 ?? modelArtifact.requirementsSnapshotSha256 ?? "0".repeat(64),
				reviewRound: input.reviewRound ?? modelArtifact.reviewRound ?? (reviewKind === "initial" ? 1 : 2),
				authorResponses: input.authorResponses ?? modelArtifact.authorResponses ?? [],
				// Engine-owned V2 fields: never fall back to model artifact (forgery surface).
				triggerReason: input.triggerReason !== undefined ? input.triggerReason : null,
				routeSelectionReceiptRef:
					input.routeSelectionReceiptRef !== undefined ? input.routeSelectionReceiptRef : null,
				cleanContextReceiptRef: input.cleanContextReceiptRef !== undefined ? input.cleanContextReceiptRef : null,
				specEvidenceReceiptRef: input.specEvidenceReceiptRef !== undefined ? input.specEvidenceReceiptRef : null,
				authorityReceiptRef: input.authorityReceiptRef ?? modelArtifact.authorityReceiptRef ?? null,
			},
			"PlanReviewArtifactV2",
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
