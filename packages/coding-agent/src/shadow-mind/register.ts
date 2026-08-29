import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { AgentDefinition } from "../task/types";
import { runShadowCohort } from "./cohort";
import { isShadowReviewQualified, resolveAgentEnabled } from "./eligibility";
import { shouldSkipShadowReviewRegistration } from "./observation";
import { SHADOW_REVIEW_JOB_LABEL, type ShadowReviewMode } from "./types";

export function tryRegisterShadowReviewJob(options: {
	session: AgentSession;
	agent: AgentDefinition;
	cwd: string;
	spawnShadowReview?: ShadowReviewMode;
	restrictToolNames: boolean;
	settings: Settings;
	assignment?: string;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
}): string | undefined {
	try {
		const manager = options.session.asyncJobManager;
		const reviewerAgentId = options.session.getAgentId?.();
		if (typeof reviewerAgentId === "string" && reviewerAgentId.includes(":shadow:")) return undefined;
		const qualified = isShadowReviewQualified({
			agentName: options.agent.name,
			agentShadowReview: options.agent.shadowReview,
			spawnShadowReview: options.spawnShadowReview,
			enabled: options.settings.get("task.shadowReview.enabled"),
			agentEnabled: resolveAgentEnabled(
				options.settings.get("task.shadowReview.agents") as Record<string, boolean>,
				options.agent.name,
			),
			restrictToolNames: options.restrictToolNames,
			agentDisplayName: options.agent.name,
		});
		if (!qualified) return undefined;
		if (shouldSkipShadowReviewRegistration()) {
			logger.warn("shadow-review skipped: quality stop is active");
			return undefined;
		}
		if (!manager || !reviewerAgentId) {
			logger.warn("shadow-review skipped: no AsyncJobManager or agentId");
			return undefined;
		}
		if (!options.session.model) {
			logger.warn("shadow-review skipped: parent session has no model");
			return undefined;
		}
		return manager.register(
			"task",
			SHADOW_REVIEW_JOB_LABEL,
			async ctx => {
				return runShadowCohort({
					parent: options.session,
					cwd: options.cwd,
					reviewerAgentId,
					signal: ctx.signal,
					reportProgress: ctx.reportProgress,
					markRunning: ctx.markRunning,
					assignment: options.assignment,
				});
			},
			{
				ownerId: reviewerAgentId,
				agentId: reviewerAgentId,
				onProgress: options.onProgress,
			},
		);
	} catch (error) {
		logger.warn("shadow-review register failed; continuing single-core", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
