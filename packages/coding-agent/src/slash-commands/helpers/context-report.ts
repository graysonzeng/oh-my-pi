import { computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import type { SlashCommandRuntime } from "../types";
import { renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";
import { loadCapability } from "../../capability";
import { ruleCapability, type Rule } from "../../capability/rule";
import { diagnoseRuleSources, formatRuleSourceDiagnosis } from "../../capability/rule-source-diagnosis";
import { cfgTtsr } from "../../export/ttsr-settings";
import { formatContextDecisionHint, recommendContextAction } from "./context-decision";
import { observeLimiterAttribution } from "../../latency/limiter-observation";
import { AgentRegistry } from "../../registry/agent-registry";
import { AsyncJobManager } from "../../async/job-manager";
import { logger } from "@oh-my-pi/pi-utils";
import { collectPendingToolCalls } from "../../session/exit-diagnostics";
import type { Goal } from "../../goals/state";

/**
 * Tri-state unfinished acceptance / work signal for `/context`.
 * `undefined` = unknown (must not claim "no unfinished acceptance").
 * `false` only with positive evidence that nothing is pending.
 */
export function resolveHasUnfinishedWork(runtime: SlashCommandRuntime, goal: Goal | undefined): boolean | undefined {
	const pendingTools = (() => {
		try {
			return collectPendingToolCalls(runtime.session.sessionManager.getBranch()).length > 0;
		} catch {
			return false;
		}
	})();
	const openTodos = (() => {
		try {
			const phases = runtime.session.getTodoPhases?.() ?? [];
			return phases.some(phase =>
				phase.tasks.some(task => task.status !== "completed" && task.status !== "abandoned"),
			);
		} catch {
			return false;
		}
	})();
	if (
		goal?.hostGate?.pendingVerification === true ||
		goal?.hostGate?.lastDecision === "continue" ||
		pendingTools ||
		openTodos
	) {
		return true;
	}
	// Positive evidence of none: goal terminal (complete/dropped) or explicit
	// non-continue decision with no open todos/tools.
	if (
		goal &&
		(goal.status === "complete" ||
			goal.status === "dropped" ||
			goal.hostGate?.lastDecision === "user_confirmed" ||
			goal.hostGate?.lastDecision === "candidate_complete" ||
			goal.hostGate?.lastDecision === "blocked")
	) {
		return false;
	}
	// No goal / no decision signals → unknown, never "none".
	return undefined;
}

/**
 * Build the `/context` ACP-mode text. Tries the rich breakdown first
 * (categories + auto-compact buffer + free slack) and falls back to the
 * minimal "window/used" lines when the breakdown helper throws.
 *
 * D3 appends recommended action / reason / impact.
 * D5 appends rule source diagnosis (winner/shadowed/disabled) from live discovery.
 * D8 appends limiter attribution when occupancy is observable (unknown otherwise).
 */
export function buildContextReportText(runtime: SlashCommandRuntime): string {
	try {
		const breakdown = computeSessionContextBreakdown(runtime.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			return "Context usage is unavailable: no model is selected for this session.";
		}
		const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
		const lines = [`Context window: ${breakdown.contextWindow} tokens (${usedPct}% used)`];
		for (const category of breakdown.categories) {
			if (category.tokens === 0) continue;
			const fraction = category.tokens / breakdown.contextWindow;
			lines.push(`  ${category.label.padEnd(16)} ${renderAsciiBar(fraction)}  ${category.tokens} tokens`);
		}
		if (breakdown.autoCompactBufferTokens > 0) {
			const fraction = breakdown.autoCompactBufferTokens / breakdown.contextWindow;
			lines.push(
				`  ${"Auto-compact buf".padEnd(16)} ${renderAsciiBar(fraction)}  ${breakdown.autoCompactBufferTokens} tokens`,
			);
		}
		if (breakdown.freeTokens > 0) {
			const fraction = breakdown.freeTokens / breakdown.contextWindow;
			lines.push(`  ${"Free".padEnd(16)} ${renderAsciiBar(fraction)}  ${breakdown.freeTokens} tokens`);
		}
		const snap = breakdown.snapcompact;
		if (snap) {
			if (!snap.visionCapable) {
				lines.push("Snapcompact: inactive (model has no image input)");
			} else {
				lines.push("Snapcompact (estimated wire savings):");
				if (snap.systemPrompt) {
					const sp = snap.systemPrompt;
					lines.push(
						sp.applied
							? `  System prompt: ${sp.textTokens} text tokens → ${sp.frames} frame${sp.frames === 1 ? "" : "s"} ≈ ${sp.imageTokens} tokens (saves ~${sp.savedTokens})`
							: "  System prompt: stays text (no net savings)",
					);
				}
				if (snap.toolResults) {
					const tr = snap.toolResults;
					lines.push(
						tr.swapped > 0
							? `  Tool results: ${tr.swapped} of ${tr.total} imaged, ${tr.textTokens} text tokens → ${tr.frames} frames ≈ ${tr.imageTokens} tokens (saves ~${tr.savedTokens})`
							: `  Tool results: none imaged (${tr.total} in history)`,
					);
				}
				if (snap.savedTokens > 0) {
					lines.push(`  Estimated next request: ~${breakdown.usedTokens - snap.savedTokens} tokens on the wire`);
				}
			}
		}

		const goalState = runtime.session.getGoalModeState?.();
		const goal = goalState?.goal;
		const childCount = AgentRegistry.global()
			.list()
			.filter(ref => ref.kind === "sub" && ref.status !== "aborted").length;
		// Tri-state unfinished: unknown ≠ none. Only claim false with positive evidence.
		const hasUnfinishedWork = resolveHasUnfinishedWork(runtime, goal);
		const decision = recommendContextAction({
			contextWindow: breakdown.contextWindow,
			usedTokens: breakdown.usedTokens,
			goalActive: goal?.status === "active" || goal?.status === "budget-limited",
			goalPausedNoProgress: goal?.status === "paused" && Boolean(goal.hostGate?.lastPauseReason),
			hasUnfinishedWork,
			hasChildAgents: childCount > 0,
		});
		lines.push("", formatContextDecisionHint(decision));

		return lines.join("\n");
	} catch {
		const fallback = runtime.session.getContextUsage();
		if (!fallback) return "Context usage is unavailable.";
		return ["Context", `Window: ${fallback.contextWindow}`, `Used: ${fallback.tokens ?? 0}`].join("\n");
	}
}

/**
 * Async diagnosis sections for `/context` (rules + limiter). Kept separate so
 * the sync usage breakdown still works when discovery fails.
 */
export async function appendContextDiagnosisSections(runtime: SlashCommandRuntime, base: string): Promise<string> {
	const sections = [base];
	try {
		const ttsr = cfgTtsr.get(runtime.settings);
		const rulesResult = await loadCapability<Rule>(ruleCapability.id, { cwd: runtime.cwd });
		const agentName =
			typeof (runtime.session as { agentName?: string }).agentName === "string"
				? (runtime.session as { agentName?: string }).agentName
				: "main";
		const rows = diagnoseRuleSources({
			items: rulesResult.items,
			all: rulesResult.all ?? rulesResult.items,
			disabledNames: ttsr.disabledRules,
			builtinRules: ttsr.builtinRules,
			agentName,
		});
		if (rows.length > 0) {
			sections.push("", formatRuleSourceDiagnosis(rows));
		}
	} catch (error) {
		logger.debug("context rule diagnosis skipped", {
			error: error instanceof Error ? error.message : String(error),
		});
		sections.push("", "rule source diagnosis (D5): unavailable");
	}

	try {
		const observation = await observeLimiterAttribution({
			asyncJobManager: AsyncJobManager.instance() ?? null,
			// TaskTool spawn semaphore is process-local to the tool instance; when
			// unreachable from `/context`, task_concurrency stays in unknown_occupancy
			// (unknown ≠ idle). Callers that hold a TaskTool may pass taskSpawnSemaphore.
		});
		sections.push("", observation.formatted);
	} catch (error) {
		logger.debug("context limiter observation skipped", {
			error: error instanceof Error ? error.message : String(error),
		});
		sections.push("", "limiter attribution (D8): unknown (occupancy sample failed)");
	}

	return sections.join("\n");
}
