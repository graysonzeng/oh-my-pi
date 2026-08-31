/** Bundled reviewer-class agents whose request budget must fire before the 30m wall. */
export const REVIEWER_SOFT_REQUEST_BUDGET: Record<string, number> = {
	reviewer: 80,
	"subagent-sol": 80,
	"sol-xhigh-reviewer": 80,
	"security-reviewer": 80,
};

const EXPLORE_AGENT_NAMES: Record<string, true> = {
	scout: true,
	sonic: true,
};

/** Explore-class structured invocations cap the soft request budget at this value. */
export const EXPLORE_SOFT_REQUEST_BUDGET = 40;

/** Review-class wall-clock ceiling for task invocations that omit a caller runtime cap. */
export const REVIEW_GATE_MAX_RUNTIME_MS = 1_800_000;

/** Explore-class wall-clock ceiling for task invocations that omit a caller runtime cap. */
export const EXPLORE_MAX_RUNTIME_MS = 600_000;

/** Reviewer-class wall-clock wrap-up fires at this fraction of `task.maxRuntimeMs`. */
export const REVIEWER_SOFT_RUNTIME_RATIO = 0.75;

export type SubagentPerformanceClass = "review" | "explore" | "worker";

export interface ResolveSubagentPerformanceClassInput {
	agentName: string;
	agentShadowReview?: "code";
	spawnShadowReview?: "code" | "off";
}

export interface SubagentRequestPhase {
	index: number;
	startedAtMs: number;
	durationMs: number;
	queueMs?: number;
	ttftMs?: number;
	generationMs?: number;
	inputTokens?: number;
	cacheReadTokens?: number;
	outputTokens?: number;
	contextBytes?: number;
}

export interface SubagentToolPhase {
	name: string;
	durationMs: number;
	originalBytes?: number;
	visibleBytes?: number;
}

export interface SubagentCheckpointMetrics {
	atMs: number;
	requests: number;
	kind: "soft_budget" | "runtime_timeout";
}

export interface SubagentReviewMetrics {
	requestPhases: SubagentRequestPhase[];
	toolPhases: SubagentToolPhase[];
	checkpoints: SubagentCheckpointMetrics[];
	shadowWaitMs?: number;
	shadowChildCount?: number;
}

export function isReviewerAgentName(agentName: string): agentName is keyof typeof REVIEWER_SOFT_REQUEST_BUDGET {
	return Object.hasOwn(REVIEWER_SOFT_REQUEST_BUDGET, agentName);
}

/**
 * Classify a structured subagent after fresh discovery. Explore names win over
 * frontmatter/spawn `"code"` so a 10-minute scout is not widened to 30 minutes.
 * Spawn `"off"` is not a class veto.
 */
export function resolveSubagentPerformanceClass(input: ResolveSubagentPerformanceClassInput): SubagentPerformanceClass {
	if (EXPLORE_AGENT_NAMES[input.agentName] === true) return "explore";
	if (isReviewerAgentName(input.agentName)) return "review";
	if (input.agentShadowReview === "code") return "review";
	if (input.spawnShadowReview === "code") return "review";
	return "worker";
}

/** Class wall-clock ceiling. Worker has no extra ceiling. */
export function resolveClassMaxRuntimeMs(performanceClass: SubagentPerformanceClass): number {
	if (performanceClass === "review") return REVIEW_GATE_MAX_RUNTIME_MS;
	if (performanceClass === "explore") return EXPLORE_MAX_RUNTIME_MS;
	return Number.POSITIVE_INFINITY;
}

/** Advisory wrap-up deadline for review/explore; 0 disables the extra timer. */
export function resolveClassSoftRuntimeMs(performanceClass: SubagentPerformanceClass, maxRuntimeMs: number): number {
	if (maxRuntimeMs <= 0 || performanceClass === "worker") return 0;
	const softMs = Math.floor(maxRuntimeMs * REVIEWER_SOFT_RUNTIME_RATIO);
	return softMs > 0 && softMs < maxRuntimeMs ? softMs : 0;
}

export function emptyReviewMetrics(): SubagentReviewMetrics {
	return { requestPhases: [], toolPhases: [], checkpoints: [] };
}
