/**
 * Per-prompt difficulty classifier for the `auto` thinking level.
 *
 * Asks a {@link ChoiceQuestion} when multiple supported online tiers exist,
 * short-circuiting without a judge request when zero or one tier is available.
 * For task-spawned turns, it considers the delegator's `solutionSpace` alone.
 * It maps the selected level to a concrete {@link Effort} and clamps it into
 * the active model's supported range (never below {@link Effort.Low}).
 * The judge comes from the live `judge` role chain. A local on-device candidate
 * gets the coarser
 * `trivial|moderate|hard` question (3-class is more reliable
 * than 4-way ordinal on sub-2B models), mapped to `low|high|xhigh`.
 *
 * When the adaptive-thinking-context arm is on, the request is wrapped with
 * bounded operational signals. The wrapper is a static prompt asset; it does
 * not change the question or the judge chain.
 *
 * Throws on any failure (no judge, no key, unparseable output, abort/timeout);
 * the caller falls back to a concrete level and continues the turn.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { type ChoiceQuestion, Effort, judgeQuestions, type Model, renderQuestion } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import adaptiveThinkingContextPrompt from "../prompts/system/auto-thinking-adaptive-context.md" with { type: "text" };
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/auto-thinking.json" with { type: "json" };
import { clampAutoThinkingEffort } from "@oh-my-pi/pi-tui/thinking";
import { preprocessTinyMessage } from "../tiny/message-preproc";

import { cfgProvidersAutoThinkingMaxEffort } from "../session/settings";

type Level = "low" | "medium" | "high" | "xhigh" | "max";
type Bucket = "trivial" | "moderate" | "hard";

const LEVEL_EFFORT: Record<Level, Effort> = {
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

const BUCKET_EFFORT: Record<Bucket, Effort> = {
	trivial: Effort.Low,
	moderate: Effort.High,
	hard: Effort.XHigh,
};

/**
 * The on-device bucket question, the effort ladder (levels by how open-ended
 * the problem is, `max` last), and the solution-space instructions, which
 * reuse the ladder's levels.
 */
const QUESTIONS = judgeQuestions(questionFile);

/** Questions for one classification input kind: on-device bucket, full ladder, full ladder with `max`. */
interface QuestionSet {
	bucket: ChoiceQuestion<Bucket>;
	level: ChoiceQuestion<Exclude<Level, "max">>;
	/** Offers `max`; used only when the target model exposes that tier. */
	levelWithMax: ChoiceQuestion<Level>;
}

/**
 * Build the question set for one input kind. Only the instructions differ
 * between kinds; every kind shares the ladder's levels and the bucket criteria.
 */
function buildQuestionSet(instructions: string, bucketInstructions: string): QuestionSet {
	const ladder: ChoiceQuestion<Level> = { ...QUESTIONS.level, instructions };
	const { max: _max, ...levels } = ladder.criteria;
	return {
		bucket: { ...QUESTIONS.bucket, instructions: bucketInstructions },
		level: { ...renderQuestion(ladder, {}), criteria: levels },
		levelWithMax: renderQuestion(ladder, { withMax: true }),
	};
}

function isLevel(label: string): label is Level {
	return Object.hasOwn(LEVEL_EFFORT, label);
}

/** The ladder question narrowed to the levels the target model supports. */
interface SupportedLevelQuestion {
	question: ChoiceQuestion;
	levels: Level[];
}

/** Keep the judge's choices aligned with the effort surface the target can use. */
function filterSupportedLevels(
	question: ChoiceQuestion<Level> | ChoiceQuestion<Exclude<Level, "max">>,
	model: Model,
): SupportedLevelQuestion {
	const supported = getSupportedEfforts(model);
	const criteria: Record<string, string | null> = {};
	const levels: Level[] = [];
	for (const [label, rubric] of Object.entries(question.criteria)) {
		if (!isLevel(label) || !supported.includes(LEVEL_EFFORT[label])) continue;
		criteria[label] = rubric;
		levels.push(label);
	}
	return { question: { ...question, criteria }, levels };
}

const REQUEST_QUESTIONS = buildQuestionSet(QUESTIONS.level.instructions, QUESTIONS.bucket.instructions);
const SOLUTION_SPACE_QUESTIONS = buildQuestionSet(
	QUESTIONS.solutionSpace.instructions,
	renderQuestion(QUESTIONS.solutionSpace, {}).instructions,
);

/** The turn to classify. */
export interface DifficultyInput {
	/** The prompt text the agent is about to act on. */
	request: string;
	/**
	 * Delegator's description of how open-ended the subtask is (task `solutionSpace` field).
	 * When non-blank it replaces `request` as the sole classification input.
	 */
	solutionSpace?: string;
}

/** Window of recent tool-result messages used to count classifier failure signals. */
export const ADAPTIVE_THINKING_TOOL_RESULT_WINDOW = 8;

export type AdaptiveThinkingAgentRole = "main" | "sub";

/**
 * Bounded operational signals for the existing auto-thinking classifier call.
 * Ordinary sessions omit `deadlineRemainingMs`; never invent a deadline.
 */
export interface AdaptiveThinkingContextSignals {
	agentRole: AdaptiveThinkingAgentRole;
	recentToolFailures: number;
	contextUsagePercent?: number;
	deadlineRemainingMs?: number;
}

export interface ClassifyDifficultyDeps {
	settings: Settings;
	registry: ModelRegistry;
	model: Model;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	/** Present only when the adaptive-thinking-context arm is on. */
	adaptiveContext?: AdaptiveThinkingContextSignals;
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
}

/** Count `isError` among the most recent `window` tool-result messages. */
export function countRecentToolResultErrors(
	messages: ReadonlyArray<{ role: string; isError?: boolean }>,
	window: number = ADAPTIVE_THINKING_TOOL_RESULT_WINDOW,
): number {
	const bound = Math.min(ADAPTIVE_THINKING_TOOL_RESULT_WINDOW, Math.max(0, Math.trunc(window)));
	let seen = 0;
	let failures = 0;
	for (let i = messages.length - 1; i >= 0 && seen < bound; i--) {
		const message = messages[i];
		if (message?.role !== "toolResult") continue;
		seen++;
		if (message.isError) failures++;
	}
	return failures;
}

/** Normalize caller-supplied signals; drop free-form fields and invented deadlines. */
export function normalizeAdaptiveThinkingContextSignals(
	signals: AdaptiveThinkingContextSignals,
): AdaptiveThinkingContextSignals {
	const contextUsage =
		typeof signals.contextUsagePercent === "number" && Number.isFinite(signals.contextUsagePercent)
			? signals.contextUsagePercent
			: undefined;
	const deadline =
		typeof signals.deadlineRemainingMs === "number" && Number.isFinite(signals.deadlineRemainingMs)
			? signals.deadlineRemainingMs
			: undefined;
	const failures =
		typeof signals.recentToolFailures === "number" && Number.isFinite(signals.recentToolFailures)
			? signals.recentToolFailures
			: 0;
	return {
		agentRole: signals.agentRole === "sub" ? "sub" : "main",
		recentToolFailures: Math.min(ADAPTIVE_THINKING_TOOL_RESULT_WINDOW, Math.max(0, Math.trunc(failures))),
		...(contextUsage !== undefined
			? { contextUsagePercent: Math.min(100, Math.max(0, Math.trunc(contextUsage))) }
			: {}),
		...(deadline !== undefined && deadline >= 0 ? { deadlineRemainingMs: Math.trunc(deadline) } : {}),
	};
}

function wrapAdaptiveThinkingClassifierInput(
	preprocessedPrompt: string,
	signals: AdaptiveThinkingContextSignals,
): string {
	const normalized = normalizeAdaptiveThinkingContextSignals(signals);
	return prompt.render(adaptiveThinkingContextPrompt, {
		agentRole: normalized.agentRole,
		recentToolFailures: normalized.recentToolFailures,
		hasContextUsage: normalized.contextUsagePercent !== undefined,
		contextUsagePercent: normalized.contextUsagePercent,
		hasDeadline: normalized.deadlineRemainingMs !== undefined,
		deadlineRemainingMs: normalized.deadlineRemainingMs,
		prompt: preprocessedPrompt,
	});
}

/**
 * Highest effort this turn's classification may resolve to: the configured
 * ceiling, further limited by what the target model actually exposes. The
 * default keeps `auto` one tier below the top, so only an explicit
 * `ultrathink` reaches {@link Effort.Max}.
 */
function autoEffortCeiling(deps: ClassifyDifficultyDeps): Effort {
	if (cfgProvidersAutoThinkingMaxEffort.get(deps.settings) !== Effort.Max) return Effort.XHigh;
	return getSupportedEfforts(deps.model).includes(Effort.Max) ? Effort.Max : Effort.XHigh;
}

/**
 * Classify `input` and return a concrete effort clamped to `deps.model`,
 * or `undefined` when the model has no controllable effort surface or no
 * supported effort under the active ceiling (auto has nothing to pick — the
 * caller falls back to its provisional auto level).
 * @throws when the backend cannot produce a usable classification.
 */
export async function classifyDifficulty(
	input: DifficultyInput,
	deps: ClassifyDifficultyDeps,
): Promise<Effort | undefined> {
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		sessionModel: deps.model,
		sessionId: deps.sessionId,
		metadataResolver: deps.metadataResolver,
		purpose: "auto-thinking",
		onUsage: deps.onUsage,
		telemetry: deps.telemetry,
		cache: sharedJudgmentCache(),
	});
	const solutionSpace = input.solutionSpace?.trim();
	const questions = solutionSpace ? SOLUTION_SPACE_QUESTIONS : REQUEST_QUESTIONS;
	const preprocessedRequest = preprocessTinyMessage(input.request);
	const request =
		deps.adaptiveContext !== undefined
			? wrapAdaptiveThinkingClassifierInput(preprocessedRequest, deps.adaptiveContext)
			: preprocessedRequest;
	const state: Record<string, string> = solutionSpace
		? { solution_space: preprocessTinyMessage(solutionSpace) }
		: { request };
	const options = { signal: deps.signal };
	const ceiling = autoEffortCeiling(deps);
	const level = filterSupportedLevels(ceiling === Effort.Max ? questions.levelWithMax : questions.level, deps.model);
	const [onlyLevel, ...otherLevels] = level.levels;
	// One eligible tier below Max is the answer every candidate reaches (the local
	// bucket clamps into the same pool), so it needs no judge and no judge credential.
	if (onlyLevel !== undefined && otherLevels.length === 0 && onlyLevel !== "max") return LEVEL_EFFORT[onlyLevel];
	// With no online tier, every candidate lands in the same place: the local
	// bucket's XHigh-capped pool, which is empty (`["max"]`) or holds only a
	// sub-Low tier (`["minimal"]`).
	if (onlyLevel === undefined) return clampAutoThinkingEffort(deps.model, Effort.Low, Effort.XHigh);
	const classified = await judge.withCandidate(async (candidate, kind) => {
		// The 3-bucket local question cannot select `max`, so its ceiling stays at
		// XHigh whatever the setting says — otherwise a sparse ladder would snap its
		// `hard` bucket up to a tier it never chose.
		if (kind === "local") {
			const { answers } = await candidate.judge({ state, questions: { bucket: questions.bucket } }, options);
			return { effort: BUCKET_EFFORT[answers.bucket.choice], ceiling: Effort.XHigh };
		}
		if (otherLevels.length === 0) return { effort: LEVEL_EFFORT[onlyLevel], ceiling };
		const { answers } = await candidate.judge({ state, questions: { level: level.question } }, options);
		const chosen = level.levels.find(label => label === answers.level.choice);
		if (chosen === undefined) {
			throw new Error(`auto-thinking: judge chose unsupported level "${answers.level.choice}"`);
		}
		return { effort: LEVEL_EFFORT[chosen], ceiling };
	}, options);
	// Local bucket choices are unfiltered and may fall below every supported tier.
	// Passing the ceiling prevents snapping upward into an excluded tier.
	return clampAutoThinkingEffort(deps.model, classified.effort, classified.ceiling);
}
