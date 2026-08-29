import { splitInternalUrlSel, splitPathAndSel } from "../tools/path-utils";
import { type ParsedSelector, parseSel } from "../tools/read-selector";

/** Bundled reviewer-class agents whose request budget must fire before the 20m wall. */
export const REVIEWER_SOFT_REQUEST_BUDGET: Record<string, number> = {
	reviewer: 40,
	"subagent-sol": 40,
	"sol-xhigh-reviewer": 40,
	"security-reviewer": 40,
};

const REVIEWER_AGENT_NAMES: Record<string, true> = {
	reviewer: true,
	"subagent-sol": true,
	"sol-xhigh-reviewer": true,
	"security-reviewer": true,
};

/** Default fast evidence-scout chain: DeepSeek V4 Flash max, then Grok 4.6 xhigh. */
export const DEFAULT_EVIDENCE_SCOUT_MODEL = ["gateway/deepseek-v4-flash:max", "gateway/grok-4.6:xhigh"] as const;

export const EVIDENCE_SCOUT_JOB_LABEL = "review-evidence";

/** Reviewer-class wall-clock wrap-up fires at this fraction of `task.maxRuntimeMs`. */
export const REVIEWER_SOFT_RUNTIME_RATIO = 0.75;

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
	return REVIEWER_AGENT_NAMES[agentName] === true;
}
export function resolveReviewerSoftRequestBudget(agentName: string, configuredBudget: number): number {
	const normalized = Math.max(0, Math.trunc(configuredBudget));
	if (normalized === 0) return 0;
	const reviewerCap = REVIEWER_SOFT_REQUEST_BUDGET[agentName];
	if (reviewerCap === undefined) return normalized;
	return Math.min(normalized, reviewerCap);
}

function isInternalUrl(path: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

export function parseReadPathSelector(path: unknown): ParsedSelector {
	if (typeof path !== "string" || path.length === 0) return { kind: "none" };
	const split = isInternalUrl(path) ? splitInternalUrlSel(path) : splitPathAndSel(path);
	return parseSel(split.sel);
}

/** Explicit bounded ranges and `:raw` must survive ordinary-session tool-output clamps. */
export function shouldPreserveExplicitReadRange(path: unknown): boolean {
	const parsed = parseReadPathSelector(path);
	return parsed.kind === "raw" || parsed.kind === "lines";
}

/** Read tool args historically use `path`; some call sites still pass `file_path`. */
export function readPathFromToolArgs(args: unknown): unknown {
	if (!args || typeof args !== "object") return undefined;
	if (Object.hasOwn(args, "path")) return Reflect.get(args, "path");
	if (Object.hasOwn(args, "file_path")) return Reflect.get(args, "file_path");
	return undefined;
}

/** Soft wrap-up deadline for a hung reviewer request; 0 disables the extra timer. */
export function resolveReviewerSoftRuntimeMs(agentName: string, maxRuntimeMs: number): number {
	if (maxRuntimeMs <= 0 || !isReviewerAgentName(agentName)) return 0;
	const softMs = Math.floor(maxRuntimeMs * REVIEWER_SOFT_RUNTIME_RATIO);
	return softMs > 0 && softMs < maxRuntimeMs ? softMs : 0;
}

export function emptyReviewMetrics(): SubagentReviewMetrics {
	return { requestPhases: [], toolPhases: [], checkpoints: [] };
}
