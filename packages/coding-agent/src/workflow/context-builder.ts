import codeReviewContextTemplate from "../prompts/workflow/context-code-review.hbs.md" with { type: "text" };
import implementContextTemplate from "../prompts/workflow/context-implement.hbs.md" with { type: "text" };
import knownSourceTemplate from "../prompts/workflow/context-known-source.hbs.md" with { type: "text" };
import planContextTemplate from "../prompts/workflow/context-plan.hbs.md" with { type: "text" };
import planRecoveryTemplate from "../prompts/workflow/context-plan-recovery.hbs.md" with { type: "text" };
import planReviewContextTemplate from "../prompts/workflow/context-plan-review.hbs.md" with { type: "text" };
import repairContextTemplate from "../prompts/workflow/context-repair.hbs.md" with { type: "text" };
import stageHandoffContextTemplate from "../prompts/workflow/context-stage-handoff.hbs.md" with { type: "text" };
import type { ResolvedArtifactInclusion } from "./artifact-inclusion";
import { buildRepoMap } from "./repo-map-builder";
import { isProvenPersistedRef, isSyntheticRecoveryUri, stageHandoffEdge } from "./stage-handoff";
import type {
	ContextStrategy,
	ImplementationArtifactV1,
	PlanArtifactV1,
	PlanReviewArtifact,
	RequirementsSnapshotV1,
	ReviewFindingV1,
	StageHandoffArtifactRef,
	StageHandoffPreservedItem,
	StageHandoffV1,
	VerificationArtifactV1,
	WorkflowRequest,
	WorkflowStatus,
} from "./types";

const OMITTED = "(omitted by profile context inclusion)";
/** See plan JSON — used when full plan is already inlined so fields are not duplicated. */
const SEE_PLAN = "(see Approved plan above)";

/** Optional plan ref plus frozen request source for downstream stage prompts. */
export interface DownstreamContextOptions {
	planRef?: StageHandoffArtifactRef | null;
	requirementsSnapshot?: RequirementsSnapshotV1 | null;
}

/**
 * Assembly knobs for {@link ContextBuilder.appendStageHandoff}.
 * Parent wires this from `#buildStageContext`. `planRef` is accepted so the
 * engine can pass the same object it passes to the build* methods; projection
 * itself happens in those methods / {@link projectPlanForPrompt}.
 */
export interface StageContextAssembly {
	/** planning and plan_review already render request/constraints. Other stages receive the snapshot source. */
	stage?: WorkflowStatus;
	requirementsSnapshot?: RequirementsSnapshotV1 | null;
	planRef?: StageHandoffArtifactRef | null;
}

export interface PlanPromptProjection {
	planJson: string;
	mode: "full" | "projected" | "omitted";
	/** Set only when steps were omitted against a proven persisted file ref. */
	recoveryUri?: string;
	contentSha256?: string;
	omittedStepRange?: { fromIndex: number; toIndex: number; total: number } | null;
}

/**
 * Minimal Handlebars-subset renderer for static workflow context templates.
 * Avoids @oh-my-pi/pi-utils (natives) so pure workflow unit tests stay loadable.
 * Supports {{var}} and {{#if var}}...{{/if}} only.
 */
export function renderContextTemplate(template: string, vars: Record<string, string>): string {
	let out = template;
	out = out.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, name: string, body: string) => {
		const value = vars[name]?.trim() ?? "";
		return value ? body : "";
	});
	out = out.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => vars[name] ?? "");
	return `${out.replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function renderPlanRecovery(projected: PlanPromptProjection): string {
	if (projected.mode !== "projected" || !projected.recoveryUri || !projected.contentSha256) return "";
	return renderContextTemplate(planRecoveryTemplate, {
		planRecoveryUri: projected.recoveryUri,
		planContentSha256: projected.contentSha256,
	});
}

/** Frozen request/constraints block. Empty when the snapshot has neither. */
export function renderKnownSource(snapshot: RequirementsSnapshotV1 | null | undefined): string {
	const request = snapshot?.source.request?.trim() ?? "";
	const constraints = snapshot?.source.constraints?.trim() ?? "";
	if (!request && !constraints) return "";
	return renderContextTemplate(knownSourceTemplate, { request, constraints });
}

function contextAlreadyCarriesRequestSource(context: string): boolean {
	return (
		/## User request\b/.test(context) ||
		/## Authoritative requirements snapshot\b/.test(context) ||
		/## Frozen request\b/.test(context) ||
		/## Frozen constraints\b/.test(context)
	);
}

function stageSkipsKnownSource(stage: WorkflowStatus | undefined): boolean {
	return stage === "planning" || stage === "plan_review";
}

function planSectionInlined(context: string): boolean {
	const match = context.match(/## (?:Approved plan|Plan under review|Plan)\n([\s\S]*?)(?=\n## |$)/);
	if (!match) return false;
	const body = match[1]?.trim() ?? "";
	return body.length > 0 && !body.startsWith(OMITTED);
}

/**
 * Deterministic plan representation for prompts.
 * Full JSON unless includePlan is false, or a proven file ref exists and
 * inclusion.maxArtifactBytes is set and the full JSON exceeds that configured budget.
 * No guessed byte cap. Hard constraints stay complete; only steps may be omitted.
 */
export function projectPlanForPrompt(
	plan: PlanArtifactV1,
	inclusion?: ResolvedArtifactInclusion,
	planRef?: StageHandoffArtifactRef | null,
): PlanPromptProjection {
	if (inclusion?.includePlan === false) {
		return { planJson: OMITTED, mode: "omitted" };
	}
	const full = JSON.stringify(plan, null, 2);
	const budget = inclusion?.maxArtifactBytes;
	if (budget === undefined || utf8Bytes(full) <= budget || !isProvenPersistedRef(planRef)) {
		return { planJson: full, mode: "full" };
	}
	const provenRef = planRef;
	const recoverySha = provenRef.contentSha256;
	if (!recoverySha) return { planJson: full, mode: "full" };
	const steps = plan.implementationSteps;
	let kept = steps.length;
	let projected = "";
	let omittedFrom: number | null = null;
	while (kept >= 0) {
		omittedFrom = kept < steps.length ? kept : null;
		const body = {
			summary: plan.summary,
			acceptanceCriteria: plan.acceptanceCriteria,
			verificationCommands: plan.verificationCommands,
			assumptions: plan.assumptions,
			nonGoals: plan.nonGoals,
			affectedFiles: plan.affectedFiles,
			implementationSteps: steps.slice(0, kept),
			risks: plan.risks,
			rollback: plan.rollback,
			schemaVersion: plan.schemaVersion,
			workflowId: plan.workflowId,
			attemptId: plan.attemptId,
			omittedStepRange:
				omittedFrom === null ? null : { fromIndex: omittedFrom, toIndex: steps.length - 1, total: steps.length },
		};
		projected = JSON.stringify(body, null, 2);
		if (utf8Bytes(projected) <= budget || kept === 0) break;
		kept -= 1;
	}
	if (omittedFrom === null) {
		return { planJson: full, mode: "full" };
	}
	return {
		planJson: projected,
		mode: "projected",
		recoveryUri: provenRef.recoveryUri,
		contentSha256: recoverySha,
		omittedStepRange: { fromIndex: omittedFrom, toIndex: steps.length - 1, total: steps.length },
	};
}

function promptHandoffJson(handoff: StageHandoffV1, preservedItems: StageHandoffPreservedItem[]): string {
	const recoveryUris = handoff.recoveryUris.filter(uri => !isSyntheticRecoveryUri(uri));
	return JSON.stringify(
		{
			kind: handoff.kind,
			schemaVersion: handoff.schemaVersion,
			fromStage: handoff.fromStage,
			toStage: handoff.toStage,
			preservedItems: preservedItems.map(item => ({
				kind: item.kind,
				artifactId: item.artifactId,
				summary: item.summary,
				blocking: item.blocking,
				...(item.shardIndex === undefined ? {} : { shardIndex: item.shardIndex, shardCount: item.shardCount }),
			})),
			...(recoveryUris.length > 0 ? { recoveryUris } : {}),
		},
		null,
		2,
	);
}

/**
 * Deterministic context handoff from persisted artifacts only.
 * Templates live in static .md files under prompts/workflow/.
 */
export class ContextBuilder {
	buildPlanContext(input: {
		request: WorkflowRequest | { request: string; constraints?: string };
		priorReview?: PlanReviewArtifact | null;
		constraints?: string;
		grillAnswers?: readonly string[];
	}): string {
		const grillAnswers = (input.grillAnswers ?? []).map((answer, index) => `${index + 1}. ${answer}`).join("\n");
		return renderContextTemplate(planContextTemplate, {
			request: input.request.request,
			constraints: input.constraints ?? ("constraints" in input.request ? (input.request.constraints ?? "") : ""),
			priorReviewExplanation: input.priorReview?.explanation?.trim() ?? "",
			priorFindings: input.priorReview ? this.#findingsBlock(input.priorReview.findings) : "",
			grillAnswers,
		});
	}

	buildPlanReviewContext(
		plan: PlanArtifactV1,
		inclusion?: ResolvedArtifactInclusion,
		requirementsSnapshot?: RequirementsSnapshotV1 | null,
		planRef?: StageHandoffArtifactRef | null,
	): string {
		const projected = projectPlanForPrompt(plan, inclusion, planRef);
		const requirementsJson =
			requirementsSnapshot != null
				? JSON.stringify(
						{
							sha256: requirementsSnapshot.sha256,
							requirements: requirementsSnapshot.requirements,
							source: requirementsSnapshot.source,
						},
						null,
						2,
					)
				: "";
		return renderContextTemplate(planReviewContextTemplate, {
			planJson: projected.planJson,
			planRecovery: renderPlanRecovery(projected),
			requirementsJson,
		});
	}

	buildImplementContext(
		plan: PlanArtifactV1,
		review?: PlanReviewArtifact | null,
		inclusion?: ResolvedArtifactInclusion,
		options?: DownstreamContextOptions,
	): string {
		const includePlan = inclusion?.includePlan !== false;
		const includeReview = inclusion?.includeReviewFindings !== false;
		const projected = projectPlanForPrompt(plan, inclusion, options?.planRef);
		const reviewNotes =
			includeReview && review?.findings?.length
				? this.#findingsBlock(review.findings)
				: includeReview
					? ""
					: OMITTED;
		const acceptanceCriteria = !includePlan || projected.mode === "omitted" ? OMITTED : SEE_PLAN;
		const verificationCommands = !includePlan || projected.mode === "omitted" ? OMITTED : SEE_PLAN;
		return renderContextTemplate(implementContextTemplate, {
			knownSource: renderKnownSource(options?.requirementsSnapshot),
			planJson: projected.planJson,
			planRecovery: renderPlanRecovery(projected),
			acceptanceCriteria,
			verificationCommands,
			reviewNotes,
		});
	}

	buildCodeReviewContext(input: {
		plan: PlanArtifactV1;
		implementation: ImplementationArtifactV1;
		verification?: VerificationArtifactV1 | null;
		inclusion?: ResolvedArtifactInclusion;
		planRef?: StageHandoffArtifactRef | null;
		requirementsSnapshot?: RequirementsSnapshotV1 | null;
	}): string {
		const includeVerification = input.inclusion?.includeVerification !== false;
		const projected = projectPlanForPrompt(input.plan, input.inclusion, input.planRef);
		return renderContextTemplate(codeReviewContextTemplate, {
			knownSource: renderKnownSource(input.requirementsSnapshot),
			planJson: projected.planJson,
			planRecovery: renderPlanRecovery(projected),
			implementationSummary: input.implementation.summary,
			changedFiles: JSON.stringify(input.implementation.changedFiles),
			patchPath: input.implementation.patchPath ?? "(none)",
			branchName: input.implementation.branchName ?? "(none)",
			verificationJson:
				includeVerification && input.verification
					? JSON.stringify({ passed: input.verification.passed, checks: input.verification.checks }, null, 2)
					: includeVerification
						? "(none)"
						: OMITTED,
		});
	}

	buildRepairContext(input: {
		plan: PlanArtifactV1;
		findings: ReviewFindingV1[];
		verification?: VerificationArtifactV1 | null;
		implementation?: ImplementationArtifactV1 | null;
		reviewExplanation?: string;
		inclusion?: ResolvedArtifactInclusion;
		planRef?: StageHandoffArtifactRef | null;
		requirementsSnapshot?: RequirementsSnapshotV1 | null;
	}): string {
		const includeReview = input.inclusion?.includeReviewFindings !== false;
		const includeVerification = input.inclusion?.includeVerification !== false;
		const projected = projectPlanForPrompt(input.plan, input.inclusion, input.planRef);
		return renderContextTemplate(repairContextTemplate, {
			knownSource: renderKnownSource(input.requirementsSnapshot),
			planJson: projected.planJson,
			planRecovery: renderPlanRecovery(projected),
			findings: includeReview ? this.#findingsBlock(input.findings) : OMITTED,
			reviewExplanation: includeReview ? (input.reviewExplanation?.trim() ?? "") : OMITTED,
			verificationJson:
				includeVerification && input.verification
					? JSON.stringify({ passed: input.verification.passed, checks: input.verification.checks }, null, 2)
					: includeVerification
						? "(none)"
						: OMITTED,
			implementationSummary: input.implementation
				? `summary=${input.implementation.summary}; files=${JSON.stringify(input.implementation.changedFiles)}`
				: "(none)",
		});
	}

	/**
	 * Optionally append a compressed repo-map when contextStrategy.repoMap is enabled.
	 * Failures degrade to no map (never throw into the stage path).
	 */
	async appendRepoMapIfEnabled(
		context: string,
		opts: {
			cwd: string;
			contextStrategy?: ContextStrategy;
			relevantFiles?: string[];
		},
	): Promise<string> {
		const repo = opts.contextStrategy?.repoMap;
		if (!repo?.enabled) return context;
		try {
			const map = await buildRepoMap({
				cwd: opts.cwd,
				relevantFiles: opts.relevantFiles,
				maxFiles: repo.maxFiles,
				strategy: repo.strategy,
			});
			return `${context.trim()}\n\n## Repo map\n${map}\n`;
		} catch {
			return context;
		}
	}

	/**
	 * Append a persisted stage-boundary handoff block for the next role.
	 * Plan-kind extracts are omitted from the prompt view when the plan JSON is
	 * already inlined. Synthetic recovery URIs are not shown as production recovery.
	 * Downstream stages receive RequirementsSnapshotV1.source when it is not
	 * already rendered by the planning or plan-review templates.
	 *
	 * Note: `bytesAfterHandoff` on the StageHandoffV1 object counts preserved
	 * summary field bytes only — it is not final request / wire token size.
	 */
	appendStageHandoff(
		context: string,
		handoff: StageHandoffV1 | null | undefined,
		assembly?: StageContextAssembly,
	): string {
		let next = context;
		const stage = assembly?.stage ?? handoff?.toStage;
		if (
			assembly?.requirementsSnapshot &&
			stage !== undefined &&
			!stageSkipsKnownSource(stage) &&
			!contextAlreadyCarriesRequestSource(next)
		) {
			const source = renderKnownSource(assembly.requirementsSnapshot);
			if (source) next = `${source.trimEnd()}\n\n${next.trim()}\n`;
		}
		if (!handoff) return next.endsWith("\n") ? next : `${next}\n`;
		const dropPlanItems = planSectionInlined(next);
		const preservedItems = dropPlanItems
			? handoff.preservedItems.filter(item => item.kind !== "plan")
			: handoff.preservedItems;
		const provenUris = handoff.recoveryUris.filter(uri => !isSyntheticRecoveryUri(uri));
		if (preservedItems.length === 0 && provenUris.length === 0) {
			return next.endsWith("\n") ? next : `${next}\n`;
		}
		const edge = stageHandoffEdge(handoff.fromStage, handoff.toStage);
		const handoffJson =
			preservedItems.length === 0
				? JSON.stringify(
						{
							kind: handoff.kind,
							schemaVersion: handoff.schemaVersion,
							fromStage: handoff.fromStage,
							toStage: handoff.toStage,
							omittedArtifactIds: handoff.omittedArtifactIds,
							recoveryUris: provenUris,
						},
						null,
						2,
					)
				: promptHandoffJson(handoff, preservedItems);
		const block = renderContextTemplate(stageHandoffContextTemplate, { edge, handoffJson });
		return `${next.trim()}\n\n${block}`;
	}

	#findingsBlock(findings: ReviewFindingV1[]): string {
		if (findings.length === 0) return "(none)";
		return findings
			.map(
				f =>
					`- [${f.id}] ${f.priority} ${f.category} conf=${f.confidence}: ${f.summary}` +
					(f.file ? ` @ ${f.file}${f.line ? `:${f.line}` : ""}` : ""),
			)
			.join("\n");
	}
}
