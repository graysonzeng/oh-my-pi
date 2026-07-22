import type { PlanArtifactV1 } from "../types";

export interface PlanStageContext {
	workflowId: string;
	attemptId: string;
	summary?: string;
	assumptions?: string[];
	nonGoals?: string[];
	affectedFiles?: PlanArtifactV1["affectedFiles"];
	steps?: PlanArtifactV1["implementationSteps"];
	acceptanceCriteria?: string[];
	verificationCommands?: string[];
	risks?: string[];
	rollback?: string[];
}

export class PlanStage {
	async execute(context: PlanStageContext): Promise<PlanArtifactV1> {
		const plan: PlanArtifactV1 = {
			kind: "plan",
			summary: context.summary || "Default plan",
			assumptions: context.assumptions || [],
			nonGoals: context.nonGoals || [],
			affectedFiles: context.affectedFiles || [],
			implementationSteps: context.steps || [],
			acceptanceCriteria: context.acceptanceCriteria || [],
			verificationCommands: context.verificationCommands || [],
			risks: context.risks || [],
			rollback: context.rollback || [],
			schemaVersion: 1,
			workflowId: context.workflowId,
			attemptId: context.attemptId,
			stage: "planning",
			createdAt: new Date().toISOString(),
			modelProfileId: "claude_planner",
			provider: "anthropic",
			model: "claude-sonnet-*",
			promptVersion: "1.0",
		};
		return plan;
	}
}
