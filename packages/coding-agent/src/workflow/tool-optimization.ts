import type { ToolSession } from "../tools";
import { withToolHistoryEviction } from "./artifact-inclusion";
import { type ContextSegment, estimateTokens, evictContext } from "./context-evictor";
import type { ContextStrategy } from "./types";

/**
 * Apply session-scoped workflow tool-output optimization when present.
 * No-op when the session is not a workflow write/read stage with optimization attached.
 *
 * Argument/tool aliases are applied on the live AgentTool surface by
 * `wrapAgentToolWithWorkflowAliases` in `tools/workflow-alias-wrap.ts` (createTools).
 * This module stays free of pi-ai / pi-agent-core so workflow unit tests do not load pi_natives.
 */
export function applySessionToolOutput(
	session: Pick<ToolSession, "workflowToolOptimization">,
	toolName: string,
	output: string,
	args?: unknown,
): string {
	const processResult = session.workflowToolOptimization?.processResult;
	if (!processResult || !output) return output;
	return processResult(toolName, output, args);
}

/** Resolve customWireName for a built-in tool from workflow aliases. */
export function workflowToolWireName(
	session: Pick<ToolSession, "workflowToolOptimization">,
	toolName: string,
): string | undefined {
	const alias = session.workflowToolOptimization?.toolAliases?.[toolName];
	return alias && alias !== toolName ? alias : undefined;
}

/**
 * Evict oversized workflow handoff context under contextStrategy pressure.
 * Splits on markdown `## ` section headers so artifact blocks can be dropped
 * while preserving the lead-in (assignment framing) as a user-like segment.
 */
export function applyContextStrategyEviction(
	context: string | undefined,
	strategy: ContextStrategy | undefined,
	maxBytesBudget: number,
): string | undefined {
	const effective = withToolHistoryEviction(strategy);
	if (!context || !effective?.eviction?.enabled) return context;

	const maxTokens = Math.max(1, Math.ceil(maxBytesBudget / 4));
	const currentTokens = estimateTokens(context);
	const targetTokens = Math.floor(maxTokens * effective.targetUtilization);
	if (currentTokens <= targetTokens) return context;

	const parts = context.split(/(?=^## )/m).filter(p => p.length > 0);
	if (parts.length <= 1) {
		// Single blob: hard-cap with marker rather than inventing fake structure.
		const keep = Math.max(0, Math.floor(maxBytesBudget * effective.targetUtilization) - 40);
		return `${context.slice(0, keep)}\n/* truncated by contextStrategy eviction */`;
	}

	const segments: ContextSegment[] = parts.map((content, i) => ({
		id: `ctx_${i}`,
		type: i === 0 ? "user" : "artifact",
		persisted: /patch|changed.?files|implementation|write|verification/i.test(content),
		turnIndex: i,
		tokens: estimateTokens(content),
		content,
	}));

	const kept = evictContext({
		segments,
		strategy: effective,
		currentTokens,
		maxTokens,
	});
	return kept.map(s => s.content).join("");
}
