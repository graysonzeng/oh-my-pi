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
		const includePlan = inclusion?.includePlan !== false;
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
			planJson: includePlan ? JSON.stringify(this.#truncatePlan(plan), null, 2) : OMITTED,
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
		const reviewNotes =
			includeReview && review?.findings?.length
				? this.#findingsBlock(review.findings)
				: includeReview
					? ""
					: OMITTED;
		return renderContextTemplate(implementContextTemplate, {
			planJson: includePlan ? JSON.stringify(this.#truncatePlan(plan), null, 2) : OMITTED,
			acceptanceCriteria: includePlan ? plan.acceptanceCriteria.map(c => `- ${c}`).join("\n") : OMITTED,
			verificationCommands: includePlan ? plan.verificationCommands.map(c => `- ${c}`).join("\n") : OMITTED,
			reviewNotes,
		});
	}

	buildCodeReviewContext(input: {
		plan: PlanArtifactV1;
		implementation: ImplementationArtifactV1;
		verification?: VerificationArtifactV1 | null;
		inclusion?: ResolvedArtifactInclusion;
	}): string {
		const includePlan = input.inclusion?.includePlan !== false;
		const includeVerification = input.inclusion?.includeVerification !== false;
		return renderContextTemplate(codeReviewContextTemplate, {
			planJson: includePlan ? JSON.stringify(this.#truncatePlan(input.plan), null, 2) : OMITTED,
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
		const includePlan = input.inclusion?.includePlan !== false;
		const includeReview = input.inclusion?.includeReviewFindings !== false;
		const includeVerification = input.inclusion?.includeVerification !== false;
		return renderContextTemplate(repairContextTemplate, {
			planJson: includePlan ? JSON.stringify(this.#truncatePlan(input.plan), null, 2) : OMITTED,
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
	 * Source artifacts remain intact; this is a deterministic extract only.
	 */
	appendStageHandoff(context: string, handoff: StageHandoffV1 | null | undefined): string {
		if (!handoff) return context;
		const edge = stageHandoffEdge(handoff.fromStage, handoff.toStage);
		return `${context.trim()}\n\n## Stage handoff (${edge})\n\`\`\`json\n${serializeStageHandoff(handoff)}\n\`\`\`\n`;
	}

	#truncatePlan(plan: PlanArtifactV1): PlanArtifactV1 {
		return plan;
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
