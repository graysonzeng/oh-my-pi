import { instrumentedCompleteSimple, resolveTelemetry, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, Effort, type Model } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { escapeXmlText, logger, prompt } from "@oh-my-pi/pi-utils";
import { extractTextContent, parseJsonPayload } from "../commit/utils";
import evaluatorSystemPrompt from "../prompts/goals/evaluator-system.md" with { type: "text" };
import evaluatorUserPrompt from "../prompts/goals/evaluator-user.md" with { type: "text" };
import type { ToolSession } from "../tools";
import * as git from "../utils/git";
import type { GoalCompletionSettleSnapshot } from "./host-gate";
import type { Goal } from "./state";

const FALLBACK_CONTEXT_WINDOW = 32_768;
const TODO_CHAR_LIMIT = 4 * 1024;
const GIT_CHAR_LIMIT = 8 * 1024;
const TRANSCRIPT_CHAR_LIMIT = 32 * 1024;
const TRANSCRIPT_ITEM_CHAR_LIMIT = 4 * 1024;
const PRIOR_GAPS_CHAR_LIMIT = 2 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 512;
const UNAVAILABLE_NEXT_STEP = "verification unavailable; keep working from current repo evidence";

export type GoalEvaluatorDecision = "continue" | "candidate_complete" | "blocked";

export type GoalEvaluatorResult = {
	decision: GoalEvaluatorDecision;
	evidence: string;
	nextStep: string;
	blockerKey: string;
	failOpen: boolean;
	truncated: boolean;
	objectiveOverBudget: boolean;
};

export type GoalEvaluatorBundle = {
	objective: string;
	todos: string;
	git: string;
	hostGate: string;
	priorGaps: string;
	transcript: string;
	truncated: boolean;
	objectiveOverBudget: boolean;
};

const ALLOWED_DECISIONS = new Set<GoalEvaluatorDecision>(["continue", "candidate_complete", "blocked"]);

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function failOpenContinue(evidence: string, extra?: Partial<GoalEvaluatorResult>): GoalEvaluatorResult {
	logger.warn("goal evaluator fail-open continue", { evidence });
	return {
		decision: "continue",
		evidence,
		nextStep: UNAVAILABLE_NEXT_STEP,
		blockerKey: "",
		failOpen: true,
		truncated: extra?.truncated === true,
		objectiveOverBudget: extra?.objectiveOverBudget === true,
		...extra,
	};
}

function inputBudget(model: Model, maxTokens: number): number {
	const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : FALLBACK_CONTEXT_WINDOW;
	return Math.max(0, window - maxTokens);
}

export function parseGoalEvaluatorJson(text: string): GoalEvaluatorResult | { error: string } {
	let parsed: unknown;
	try {
		parsed = parseJsonPayload(text);
	} catch (error) {
		return { error: error instanceof Error ? error.message : "invalid json" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: "evaluator payload is not an object" };
	}
	const record = parsed as Record<string, unknown>;
	const allowed = new Set(["decision", "evidence", "next_step", "blocker_key"]);
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) return { error: `unknown field ${key}` };
	}
	const decision = record.decision;
	if (typeof decision !== "string" || !ALLOWED_DECISIONS.has(decision as GoalEvaluatorDecision)) {
		return { error: "invalid decision" };
	}
	const evidence = typeof record.evidence === "string" ? record.evidence.trim() : "";
	const nextStep = typeof record.next_step === "string" ? record.next_step.trim() : "";
	const blockerKey = typeof record.blocker_key === "string" ? record.blocker_key.trim() : "";
	if (evidence.length === 0 || nextStep.length === 0) return { error: "missing evidence or next_step" };
	if (decision === "blocked") {
		if (!/^[a-z][a-z0-9_]*$/.test(blockerKey)) return { error: "invalid blocker_key" };
	} else if (blockerKey.length > 0) {
		return { error: "blocker_key must be empty unless blocked" };
	}
	return {
		decision: decision as GoalEvaluatorDecision,
		evidence,
		nextStep,
		blockerKey,
		failOpen: false,
		truncated: false,
		objectiveOverBudget: false,
	};
}

function transcriptLines(snapshot: GoalCompletionSettleSnapshot): string[] {
	const lines = [`assistant: ${clip(snapshot.assistantText, TRANSCRIPT_ITEM_CHAR_LIMIT)}`];
	for (const tool of snapshot.tools) {
		const args = clip(JSON.stringify(tool.args), TRANSCRIPT_ITEM_CHAR_LIMIT);
		const result = clip(tool.resultText, TRANSCRIPT_ITEM_CHAR_LIMIT);
		lines.push(`tool ${tool.name} ${tool.id} unpaired=${tool.unpaired} error=${tool.isError} args=${args}`);
		lines.push(`result ${tool.id}: ${result}`);
	}
	return lines;
}

export function packGoalEvaluatorBundle(input: {
	goal: Goal;
	snapshot: GoalCompletionSettleSnapshot;
	gitSummary: string;
	model?: Model;
	maxOutputTokens?: number;
}): GoalEvaluatorBundle {
	const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
	const todos = clip(
		input.snapshot.todos.map(todo => `[${todo.status}] ${todo.phase}: ${todo.content}`).join("\n") || "(none)",
		TODO_CHAR_LIMIT,
	);
	const gitSummary = clip(input.gitSummary || "git_unavailable", GIT_CHAR_LIMIT);
	const hostGate = clip(
		JSON.stringify({
			reasons: input.goal.hostGate?.lastReasons ?? [],
			decision: input.goal.hostGate?.lastDecision ?? null,
			pendingVerification: input.goal.hostGate?.pendingVerification === true,
		}),
		1024,
	);
	const priorGaps = clip((input.goal.hostGate?.lastGaps ?? []).join("\n") || "(none)", PRIOR_GAPS_CHAR_LIMIT);
	const objectiveXml = `<objective>\n${escapeXmlText(input.goal.objective)}\n</objective>`;
	const lines = transcriptLines(input.snapshot);
	let transcript = clip(lines.join("\n"), TRANSCRIPT_CHAR_LIMIT);
	let truncated = transcript.length < lines.join("\n").length;
	let objectiveOverBudget = false;

	if (input.model) {
		const tokenizer = new Tokenizer(input.model);
		const budget = inputBudget(input.model, maxOutputTokens);
		const render = (keptTranscript: string) =>
			prompt.render(evaluatorUserPrompt, {
				objective: objectiveXml,
				todos,
				git: gitSummary,
				hostGate,
				priorGaps,
				transcript: keptTranscript,
			});
		let userPrompt = render(transcript);
		const systemPrompt = prompt.render(evaluatorSystemPrompt);
		if (!tokenizer.checkTokenBudget([systemPrompt, userPrompt], budget).fits) {
			truncated = true;
			const droppable = lines.slice();
			while (
				droppable.length > 1 &&
				!tokenizer.checkTokenBudget([systemPrompt, render(droppable.join("\n"))], budget).fits
			) {
				droppable.shift();
			}
			transcript = clip(droppable.join("\n"), TRANSCRIPT_CHAR_LIMIT);
			userPrompt = render(transcript);
			if (!tokenizer.checkTokenBudget([systemPrompt, userPrompt], budget).fits) {
				objectiveOverBudget = true;
			}
		}
	}

	return {
		objective: objectiveXml,
		todos,
		git: gitSummary,
		hostGate,
		priorGaps,
		transcript,
		truncated,
		objectiveOverBudget,
	};
}

export async function collectGoalGitSummary(cwd: string, signal?: AbortSignal): Promise<string> {
	try {
		const [shortStatus, diffStat] = await Promise.all([
			git.status(cwd, { short: true, signal }),
			git.diff(cwd, { stat: true, allowFailure: true, signal }),
		]);
		const parts = [shortStatus.trim(), diffStat.trim()].filter(part => part.length > 0);
		return parts.length > 0 ? parts.join("\n") : "(clean)";
	} catch {
		return "git_unavailable";
	}
}

export async function runGoalEvaluator(input: {
	session: ToolSession;
	goal: Goal;
	snapshot: GoalCompletionSettleSnapshot;
	signal?: AbortSignal;
}): Promise<GoalEvaluatorResult> {
	const model = input.session.getActiveModel?.();
	if (!model) {
		return failOpenContinue("no_model");
	}
	const timeoutMs = input.session.settings.get("goal.hostGate.timeoutMs") || DEFAULT_TIMEOUT_MS;
	const maxTokens = input.session.settings.get("goal.hostGate.maxOutputTokens") || DEFAULT_MAX_OUTPUT_TOKENS;
	const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
	const effectiveSignal = timeoutSignal
		? input.signal
			? AbortSignal.any([input.signal, timeoutSignal])
			: timeoutSignal
		: input.signal;
	const gitSummary = await collectGoalGitSummary(input.session.cwd, effectiveSignal);
	const bundle = packGoalEvaluatorBundle({
		goal: input.goal,
		snapshot: input.snapshot,
		gitSummary,
		model,
		maxOutputTokens: maxTokens,
	});
	if (bundle.objectiveOverBudget) {
		return {
			decision: "blocked",
			evidence: "objective exceeds evaluator token budget",
			nextStep: "Shorten the goal objective, then nominate complete again.",
			blockerKey: "objective_over_budget",
			failOpen: false,
			truncated: true,
			objectiveOverBudget: true,
		};
	}

	const systemPrompt = prompt.render(evaluatorSystemPrompt);
	const userPrompt = prompt.render(evaluatorUserPrompt, {
		objective: bundle.objective,
		todos: bundle.todos,
		git: bundle.git,
		hostGate: bundle.hostGate,
		priorGaps: bundle.priorGaps,
		transcript: bundle.transcript,
	});
	const telemetry = resolveTelemetry(input.session.getTelemetry?.(), input.session.getSessionId?.() ?? undefined);
	const reasoning = clampThinkingLevelForModel(model, Effort.Low);
	const apiKey = await input.session.getApiKey?.(model);
	let response: AssistantMessage;
	try {
		response = await instrumentedCompleteSimple(
			model,
			{
				systemPrompt: [systemPrompt],
				messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			},
			{
				apiKey,
				signal: effectiveSignal,
				reasoning,
				maxTokens,
			},
			{ telemetry, oneshotKind: "goal_evaluator" },
		);
	} catch (error) {
		const timedOut = Boolean(timeoutSignal?.aborted) && !input.signal?.aborted;
		return failOpenContinue(timedOut ? "timeout" : isAbortError(error) ? "aborted" : "provider_error", {
			truncated: bundle.truncated,
		});
	}
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return failOpenContinue(response.stopReason, { truncated: bundle.truncated });
	}
	const parsed = parseGoalEvaluatorJson(extractTextContent(response));
	if ("error" in parsed) {
		return failOpenContinue(parsed.error, { truncated: bundle.truncated });
	}
	return { ...parsed, truncated: bundle.truncated };
}
