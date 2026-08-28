import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { ToolAbortError, ToolError } from "../tools/tool-errors";
import * as evaluator from "./evaluator";
import {
	buildGoalCompletionSettleSnapshot,
	evaluateGoalHostGate,
	flattenTodoSnapshot,
	type GoalCompletionSettleSnapshot,
	settleTurnMessages,
} from "./host-gate";
import type { GoalRuntime } from "./runtime";
import type { Goal, GoalToolDetails } from "./state";
import { buildGoalToolResponse, type GoalToolResponse } from "./tools/goal-tool";

export type GoalCompleteResult = {
	response: GoalToolResponse;
	details: GoalToolDetails;
	text: string;
};

function formatCompleteText(response: GoalToolResponse, extra?: string): string {
	if (!response.goal) return "No active goal.";
	let text = `Goal: ${response.goal.objective}\nStatus: ${response.goal.status}\nTokens: ${response.goal.tokensUsed} used`;
	if (response.goal.tokenBudget !== undefined) {
		text += ` / ${response.goal.tokenBudget} budget`;
	}
	if (response.remainingTokens !== null) {
		text += `\nRemaining tokens: ${response.remainingTokens}`;
	}
	if (extra) text += `\n${extra}`;
	if (response.completionBudgetReport) {
		text += `\n\n${response.completionBudgetReport}`;
	}
	return text;
}

function latestAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

export function snapshotForComplete(
	session: ToolSession,
	runtime: GoalRuntime,
	goal: Goal,
	excludeToolCallIds?: Iterable<string>,
): GoalCompletionSettleSnapshot {
	const messages = settleTurnMessages(session.snapshotConsultContext?.().messages ?? []);
	const assistant = latestAssistant(messages);
	if (!assistant) {
		return {
			turnId: runtime.currentTurnId() ?? "unknown-turn",
			generation: runtime.currentGeneration(),
			assistantText: "",
			stopReason: "stop",
			tools: [],
			goalId: goal.id,
			goalRevision: goal.hostGate?.goalRevision ?? 0,
			nomination: {
				outcome: "nominated",
				nominationId: goal.hostGate?.nominationId,
			},
			todos: flattenTodoSnapshot(session.getTodoPhases?.()),
			messages,
		};
	}
	return buildGoalCompletionSettleSnapshot({
		turnId: runtime.currentTurnId() ?? "unknown-turn",
		generation: runtime.currentGeneration(),
		assistant,
		messages,
		todos: session.getTodoPhases?.(),
		goal,
		nominationOutcome: "nominated",
		excludeToolCallIds,
	});
}

function completeResponse(
	goal: Goal,
	gate: GoalToolDetails["gate"],
	extra: string,
	includeCompletionReport = false,
): GoalCompleteResult {
	const response = buildGoalToolResponse(goal, { includeCompletionReport });
	return {
		response,
		details: {
			op: "complete",
			goal: response.goal,
			remainingTokens: response.remainingTokens,
			completionBudgetReport: includeCompletionReport ? response.completionBudgetReport : null,
			gate,
		},
		text: formatCompleteText(response, extra),
	};
}

export async function executeGoalComplete(
	session: ToolSession,
	runtime: GoalRuntime,
	signal?: AbortSignal,
	toolCallId?: string,
): Promise<GoalCompleteResult> {
	if (session.settings.get("goal.hostGate.enabled") === false) {
		const completed = await runtime.completeGoalFromTool();
		return completeResponse(completed, "user_confirmed", "", true);
	}

	const existing = session.getGoalModeState?.()?.goal;
	if (!existing) throw new ToolError("cannot complete goal because no goal is active");
	const nominationId = String(Snowflake.next());
	const turnId = runtime.currentTurnId() ?? "unknown-turn";
	const generation = runtime.currentGeneration();
	const nominated = await runtime.nominateComplete({ nominationId, turnId, generation });
	const goal = nominated.goal;
	const snapshot = snapshotForComplete(session, runtime, goal, toolCallId ? [toolCallId] : undefined);
	const host = evaluateGoalHostGate(snapshot);

	if (nominated.shared) {
		if (nominated.flight) await nominated.flight;
		const latest = session.getGoalModeState?.()?.goal ?? goal;
		const decision = latest.hostGate?.lastDecision;
		if (decision === "blocked") {
			return completeResponse(
				latest,
				"blocked",
				`Host gate: blocked\nblocker_key: ${latest.hostGate?.lastBlockerKey ?? ""}\n${latest.hostGate?.lastNextStep ?? ""}`,
			);
		}
		if (decision === "continue") {
			return completeResponse(
				latest,
				"continue",
				`Host gate: continue\nReasons: ${(latest.hostGate?.lastReasons ?? host.reasons).join(", ")}\nNext step: ${latest.hostGate?.lastNextStep ?? host.nextStep}`,
			);
		}
		return completeResponse(
			latest,
			"candidate_complete",
			`Host checks passed. Ask the user to confirm with /goal complete.\nNext step: ${latest.hostGate?.lastNextStep ?? host.nextStep}`,
		);
	}

	const settle = nominated.settle;
	if (host.decision === "continue") {
		try {
			const applied = await runtime.applyNominationResult({
				goalId: goal.id,
				goalRevision: goal.hostGate?.goalRevision ?? 0,
				nominationId: goal.hostGate?.nominationId ?? nominationId,
				turnId,
				generation,
				decision: "continue",
				evidence: host.reasons.join(","),
				nextStep: host.nextStep,
				reasons: host.reasons,
			});
			if (applied === "stale") {
				logger.warn("discarded stale goal host-gate continue", {
					goalId: goal.id,
					nominationId,
					turnId,
					generation,
				});
			}
			const latest = session.getGoalModeState?.()?.goal ?? goal;
			return completeResponse(
				latest,
				"continue",
				`Host gate: continue\nReasons: ${host.reasons.join(", ")}\nNext step: ${host.nextStep}`,
			);
		} finally {
			settle?.resolve();
		}
	}

	const controller = settle?.controller ?? new AbortController();
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	try {
		const result = await evaluator.runGoalEvaluator({ session, goal, snapshot, signal: combined });
		if (combined.aborted) throw new ToolAbortError();
		const applied = await runtime.applyNominationResult({
			goalId: goal.id,
			goalRevision: goal.hostGate?.goalRevision ?? 0,
			nominationId: goal.hostGate?.nominationId ?? nominationId,
			turnId,
			generation,
			decision: result.decision === "blocked" ? "blocked" : "candidate_complete",
			evidence: result.evidence,
			nextStep: result.nextStep,
			blockerKey: result.blockerKey || undefined,
			reasons: host.reasons,
		});
		if (applied === "stale") {
			logger.warn("discarded stale goal evaluator result", {
				goalId: goal.id,
				nominationId,
				turnId,
				generation,
			});
		}
	} catch (error) {
		if (error instanceof ToolAbortError || combined.aborted) {
			await runtime.recoverPendingVerification();
			throw error instanceof ToolAbortError ? error : new ToolAbortError();
		}
		throw error;
	} finally {
		settle?.resolve();
	}

	const latest = session.getGoalModeState?.()?.goal ?? goal;
	if (latest.hostGate?.lastDecision === "blocked") {
		await runtime.pauseGoal();
		const paused = session.getGoalModeState?.()?.goal ?? latest;
		const extra = `Host gate: blocked\nblocker_key: ${paused.hostGate?.lastBlockerKey ?? latest.hostGate?.lastBlockerKey}\n${paused.hostGate?.lastNextStep ?? latest.hostGate?.lastNextStep}`;
		return completeResponse(paused, "blocked", extra);
	}

	return completeResponse(
		latest,
		"candidate_complete",
		`Host checks passed. Ask the user to confirm with /goal complete.\nNext step: ${latest.hostGate?.lastNextStep ?? host.nextStep}`,
	);
}
