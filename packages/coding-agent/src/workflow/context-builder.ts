import codeReviewContextTemplate from "../prompts/workflow/context-code-review.hbs.md" with { type: "text" };
import implementContextTemplate from "../prompts/workflow/context-implement.hbs.md" with { type: "text" };
import planContextTemplate from "../prompts/workflow/context-plan.hbs.md" with { type: "text" };
import planReviewContextTemplate from "../prompts/workflow/context-plan-review.hbs.md" with { type: "text" };
import repairContextTemplate from "../prompts/workflow/context-repair.hbs.md" with { type: "text" };
import type { ResolvedArtifactInclusion } from "./artifact-inclusion";
import { buildRepoMap } from "./repo-map-builder";
import { serializeStageHandoff, stageHandoffEdge } from "./stage-handoff";
import type {
	ContextStrategy,
	ImplementationArtifactV1,
	PlanArtifactV1,
	PlanReviewArtifact,
	RequirementsSnapshotV1,
	ReviewFindingV1,
	StageHandoffV1,
	VerificationArtifactV1,
	WorkflowRequest,
} from "./types";

const OMITTED = "(omitted by profile context inclusion)";
/** See plan JSON — used when full plan is already inlined so fields are not duplicated. */
const SEE_PLAN = "(see Approved plan above)";
/**
 * Soft size for "small plan" full inline. Larger plans use a deterministic
 * field projection + recovery hint. Not a per-model token guess.
 */
const SMALL_PLAN_JSON_BYTES = 8_192;

/**
 * Minimal Handlebars-subset renderer for static workflow context templates.
 * Avoids @oh-my-pi/pi-utils (natives) so pure workflow unit tests stay loadable.
 * Supports {{var}} and {{#if var}}...{{/if}} only.
 */
export function renderContextTemplate(template: string, vars: Record<string, string>): string {
	let out = template;
	// {{#if name}}...{{/if}}
	out = out.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, name: string, body: string) => {
		const value = vars[name]?.trim() ?? "";
		return value ? body : "";
	});
	// {{name}}
	out = out.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => vars[name] ?? "");
	return `${out.replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Deterministic plan representation for prompts.
 * Small plans: full JSON. Large plans: hard constraints + steps + recovery hint.
 * Acceptance / verification / blocking constraints are never 500-char truncated alone.
 */
export function projectPlanForPrompt(
	plan: PlanArtifactV1,
	inclusion?: ResolvedArtifactInclusion,
): { planJson: string; mode: "full" | "projected" | "omitted" } {
	if (inclusion?.includePlan === false) {
		return { planJson: OMITTED, mode: "omitted" };
	}
	const full = JSON.stringify(plan, null, 2);
	const maxBytes = inclusion?.maxArtifactBytes ?? SMALL_PLAN_JSON_BYTES;
	const budget = Math.min(maxBytes, SMALL_PLAN_JSON_BYTES);
	if (utf8Bytes(full) <= budget) {
		return { planJson: full, mode: "full" };
	}
	const projected = {
		summary: plan.summary,
		acceptanceCriteria: plan.acceptanceCriteria,
		verificationCommands: plan.verificationCommands,
		assumptions: plan.assumptions,
		nonGoals: plan.nonGoals,
		affectedFiles: plan.affectedFiles,
		implementationSteps: plan.implementationSteps,
		risks: plan.risks,
		rollback: plan.rollback,
		schemaVersion: plan.schemaVersion,
		workflowId: plan.workflowId,
		attemptId: plan.attemptId,
		_projection: "large_plan_fields",
		_recoveryHint: "Full plan artifact remains recoverable from workflow store / stage handoff sources.",
	};
	return { planJson: JSON.stringify(projected, null, 2), mode: "projected" };
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
	): string {
		const projected = projectPlanForPrompt(plan, inclusion);
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
			requirementsJson,
		});
	}

	buildImplementContext(
		plan: PlanArtifactV1,
		review?: PlanReviewArtifact | null,
		inclusion?: ResolvedArtifactInclusion,
	): string {
		const includePlan = inclusion?.includePlan !== false;
		const includeReview = inclusion?.includeReviewFindings !== false;
		const projected = projectPlanForPrompt(plan, inclusion);
		const reviewNotes =
			includeReview && review?.findings?.length
				? this.#findingsBlock(review.findings)
				: includeReview
					? ""
					: OMITTED;
		// Full / projected plan already carries acceptance + verification — do not
		// expand the same lists again beside the plan JSON.
		const acceptanceCriteria =
			!includePlan || projected.mode === "omitted"
				? OMITTED
				: projected.mode === "full"
					? SEE_PLAN
					: plan.acceptanceCriteria.map(c => `- ${c}`).join("\n") || "(none)";
		const verificationCommands =
			!includePlan || projected.mode === "omitted"
				? OMITTED
				: projected.mode === "full"
					? SEE_PLAN
					: plan.verificationCommands.map(c => `- ${c}`).join("\n") || "(none)";
		return renderContextTemplate(implementContextTemplate, {
			planJson: projected.planJson,
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
	}): string {
		const includeVerification = input.inclusion?.includeVerification !== false;
		const projected = projectPlanForPrompt(input.plan, input.inclusion);
		return renderContextTemplate(codeReviewContextTemplate, {
			planJson: projected.planJson,
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
	}): string {
		const includeReview = input.inclusion?.includeReviewFindings !== false;
		const includeVerification = input.inclusion?.includeVerification !== false;
		const projected = projectPlanForPrompt(input.plan, input.inclusion);
		return renderContextTemplate(repairContextTemplate, {
			planJson: projected.planJson,
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
	 * When the base context already inlines a full Approved plan, omit plan-kind
	 * preserved items that would duplicate acceptance / verification / steps.
	 * Source artifacts remain intact; this is a deterministic extract only.
	 *
	 * Note: `bytesAfterHandoff` on the StageHandoffV1 object counts preserved
	 * summary field bytes only — it is not final request / wire token size.
	 */
	appendStageHandoff(context: string, handoff: StageHandoffV1 | null | undefined): string {
		if (!handoff) return context;
		const edge = stageHandoffEdge(handoff.fromStage, handoff.toStage);
		const baseHasFullPlan = /## Approved plan\b/.test(context) && !context.includes(OMITTED);
		const promptHandoff: StageHandoffV1 = baseHasFullPlan
			? {
					...handoff,
					preservedItems: handoff.preservedItems.filter(item => item.kind !== "plan"),
				}
			: handoff;
		if (baseHasFullPlan && promptHandoff.preservedItems.length === 0) {
			const compact = {
				kind: handoff.kind,
				schemaVersion: handoff.schemaVersion,
				fromStage: handoff.fromStage,
				toStage: handoff.toStage,
				omittedArtifactIds: handoff.omittedArtifactIds,
				recoveryUris: handoff.recoveryUris,
				dedupeNote:
					"plan-kind preservedItems omitted from prompt view because Approved plan is already inlined; artifact sources remain recoverable",
			};
			return `${context.trim()}\n\n## Stage handoff (${edge})\n\`\`\`json\n${JSON.stringify(compact, null, 2)}\n\`\`\`\n`;
		}
		return `${context.trim()}\n\n## Stage handoff (${edge})\n\`\`\`json\n${serializeStageHandoff(promptHandoff)}\n\`\`\`\n`;
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
