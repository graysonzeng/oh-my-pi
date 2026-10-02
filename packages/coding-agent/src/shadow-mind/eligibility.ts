import type { AgentDefinition } from "../task/types";
import type { ShadowReviewMode } from "./types";

export interface ShadowReviewEligibilityInput {
	agentName: string;
	agentShadowReview?: "code";
	spawnShadowReview?: ShadowReviewMode;
	enabled: boolean;
	/** Per-agent override from `task.shadowReview.agents[name]`. `false` always closes. */
	agentEnabled?: boolean;
	restrictToolNames: boolean;
	agentDisplayName?: string;
}

export function isShadowReviewQualified(input: ShadowReviewEligibilityInput): boolean {
	if (input.restrictToolNames) return false;
	if (input.spawnShadowReview === "off") return false;
	if (!input.enabled) return false;
	if (input.agentEnabled === false) return false;
	if (input.agentDisplayName?.startsWith("shadow:")) return false;
	if (input.spawnShadowReview === "code") return true;
	return input.agentShadowReview === "code";
}

export function resolveAgentEnabled(
	agents: Record<string, boolean> | undefined,
	agentName: string,
): boolean | undefined {
	if (!agents || !Object.hasOwn(agents, agentName)) return undefined;
	return agents[agentName];
}

export function eligibilityFromAgent(
	agent: AgentDefinition,
	extra: Omit<ShadowReviewEligibilityInput, "agentName" | "agentShadowReview">,
): ShadowReviewEligibilityInput {
	return {
		agentName: agent.name,
		agentShadowReview: agent.shadowReview,
		...extra,
	};
}
