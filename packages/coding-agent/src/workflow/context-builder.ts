import codeReviewContextTemplate from "../prompts/workflow/context-code-review.hbs.md" with { type: "text" };
import implementContextTemplate from "../prompts/workflow/context-implement.hbs.md" with { type: "text" };
import planContextTemplate from "../prompts/workflow/context-plan.hbs.md" with { type: "text" };
import planReviewContextTemplate from "../prompts/workflow/context-plan-review.hbs.md" with { type: "text" };
import repairContextTemplate from "../prompts/workflow/context-repair.hbs.md" with { type: "text" };
import type {
	ImplementationArtifactV1,
	PlanArtifactV1,
	ReviewArtifactV1,
	ReviewFindingV1,
	VerificationArtifactV1,
	WorkflowRequest,
} from "./types";

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
		priorReview?: ReviewArtifactV1 | null;
		constraints?: string;
	}): string {
		return renderContextTemplate(planContextTemplate, {
			request: input.request.request,
			constraints: input.constraints ?? ("constraints" in input.request ? (input.request.constraints ?? "") : ""),
			priorReviewExplanation: input.priorReview?.explanation?.trim() ?? "",
			priorFindings: input.priorReview ? this.#findingsBlock(input.priorReview.findings) : "",
		});
	}

	buildPlanReviewContext(plan: PlanArtifactV1): string {
		return renderContextTemplate(planReviewContextTemplate, {
			planJson: JSON.stringify(this.#truncatePlan(plan), null, 2),
		});
	}

	buildImplementContext(plan: PlanArtifactV1, review?: ReviewArtifactV1 | null): string {
		return renderContextTemplate(implementContextTemplate, {
			planJson: JSON.stringify(this.#truncatePlan(plan), null, 2),
			acceptanceCriteria: plan.acceptanceCriteria.map(c => `- ${c}`).join("\n"),
			verificationCommands: plan.verificationCommands.map(c => `- ${c}`).join("\n"),
			reviewNotes: review?.findings?.length ? this.#findingsBlock(review.findings) : "",
		});
	}

	buildCodeReviewContext(input: {
		plan: PlanArtifactV1;
		implementation: ImplementationArtifactV1;
		verification?: VerificationArtifactV1 | null;
	}): string {
		return renderContextTemplate(codeReviewContextTemplate, {
			planJson: JSON.stringify(this.#truncatePlan(input.plan), null, 2),
			implementationSummary: input.implementation.summary,
			changedFiles: JSON.stringify(input.implementation.changedFiles),
			patchPath: input.implementation.patchPath ?? "(none)",
			branchName: input.implementation.branchName ?? "(none)",
			verificationJson: input.verification
				? JSON.stringify({ passed: input.verification.passed, checks: input.verification.checks }, null, 2)
				: "(none)",
		});
	}

	buildRepairContext(input: {
		plan: PlanArtifactV1;
		findings: ReviewFindingV1[];
		verification?: VerificationArtifactV1 | null;
		implementation?: ImplementationArtifactV1 | null;
		reviewExplanation?: string;
	}): string {
		return renderContextTemplate(repairContextTemplate, {
			planJson: JSON.stringify(this.#truncatePlan(input.plan), null, 2),
			findings: this.#findingsBlock(input.findings),
			reviewExplanation: input.reviewExplanation?.trim() ?? "",
			verificationJson: input.verification
				? JSON.stringify({ passed: input.verification.passed, checks: input.verification.checks }, null, 2)
				: "(none)",
			implementationSummary: input.implementation
				? `summary=${input.implementation.summary}; files=${JSON.stringify(input.implementation.changedFiles)}`
				: "(none)",
		});
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
