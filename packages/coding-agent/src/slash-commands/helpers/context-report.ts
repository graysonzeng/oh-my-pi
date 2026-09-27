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
		const decision = recommendContextAction({
			contextWindow: breakdown.contextWindow,
			usedTokens: breakdown.usedTokens,
			goalActive: goal?.status === "active" || goal?.status === "budget-limited",
			goalPausedNoProgress: goal?.status === "paused" && Boolean(goal.hostGate?.lastPauseReason),
			hasUnfinishedWork: goal?.hostGate?.lastDecision === "continue" || goal?.hostGate?.pendingVerification === true,
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
		const rows = diagnoseRuleSources({
			items: rulesResult.items,
			all: rulesResult.all ?? rulesResult.items,
			disabledNames: ttsr.disabledRules,
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
