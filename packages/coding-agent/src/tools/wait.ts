import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { Ellipsis, replaceTabs, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, previewLine, shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import * as os from "node:os";
import { IrcBus } from "../irc/bus";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import type { ToolSession } from ".";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import { buildJobResult, snapshotJobs, undeliveredJobs } from "../async/job-control";
import { hasLiveOwnedService, listServicesTolerant, waitForOwnedServiceCompletion } from "../launch/services";
import { drainPendingInbox, messageResult } from "../irc/messaging";
import type { AgentRegistry } from "../registry/agent-registry";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { throwIfAborted } from "./tool-errors";

import { cfgLaunchEnabled } from "./settings";

const waitSchema = type({});
const WAIT_MAX_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 500;

interface WaitMessaging {
	registry: AgentRegistry;
	senderId: string;
}

function takeQueuedMessage(messaging: WaitMessaging | undefined): IrcMessage | undefined {
	if (!messaging) return undefined;
	return drainPendingInbox(messaging.registry, messaging.senderId) ?? IrcBus.global().take(messaging.senderId);
}

interface PendingReplies {
	/** Agents asked that can still answer: running, holding the question for a turn of its own, or that promised a reply, and not blocked on the caller. */
	from: string[];
	/** Agents asked that cannot answer before the caller finishes (see `AgentAwaits.blocksOn`). */
	blocked: string[];
	/** Agents asked whose turn ended without an answer, or that are gone. */
	stopped: string[];
}

/**
 * Agents the caller messaged during its current run that have not answered
 * yet, split by whether a reply can still come. A message back answers, and
 * so does a settled job of the agent the caller owns, which delivers its
 * result. A running agent, or one still holding the question for a turn of
 * its own (a subagent answers a message that reached it as it finished after
 * its result is out), can answer, and so can a live one that sent progress
 * promising a later reply. Any other idle agent has finished the turn it got
 * the question in, and any automatic reply (a woken subagent's relayed
 * output) has arrived by then.
 */
function pendingReplies(messaging: WaitMessaging): PendingReplies {
	const { registry, senderId } = messaging;
	const replies: PendingReplies = { from: [], blocked: [], stopped: [] };
	const since = registry.get(senderId)?.session?.runStartedAt ?? 0;
	for (const { to, sentAt, promised } of IrcBus.global().unansweredSends(senderId, since)) {
		const session = registry.get(to)?.session;
		if (session && registry.awaits.blocksOn(to, senderId, sentAt)) replies.blocked.push(to);
		else if (session && (promised || session.isStreaming || session.hasQueuedIrcFrom(senderId)))
			replies.from.push(to);
		else replies.stopped.push(to);
	}
	return replies;
}

/** Why a reply wait cannot (or can no longer) get its answer. */
function noReplyText(replies: PendingReplies): string {
	const ids = (list: string[]) => list.map(id => `\`${id}\``).join(", ");
	if (replies.blocked.length > 0) {
		return `${ids(replies.blocked)} cannot reply before you finish: it is waiting on your result. Finish without the answer.`;
	}
	if (replies.stopped.length > 0) {
		return `${ids(replies.stopped)} finished its turn without replying. Ask again, or finish without the answer.`;
	}
	return "no background job or service you started is running, and no agent you messaged this run owes a reply. Other agents' results and messages arrive on their own.";
}

/** Whether `session` has the `wait` tool active, so prompts may point blocked callers at it. */
export function hasWaitTool(session: ToolSession): boolean {
	return session.isToolActive?.("wait") ?? true;
}

/**
 * Blocks on background jobs and services the calling agent started, or on
 * the reply to a message it sent this run. Other agents' work never sustains
 * a wait: a peer owes no message. A reply wait ends once no agent asked can
 * still answer: each one finished its turn, or is blocked on the caller
 * itself, the cycle that would park both sides. A message arriving mid-wait
 * ends any wait.
 */
export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next result of a background job or service you started, or a reply you asked for";
	readonly description = prompt.render(waitDescription);
	readonly parameters = waitSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly handlesToolInterrupt = true;
	readonly approval = "read";
	readonly loadMode = "essential";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		_params: typeof waitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CoordinationDetails>,
	): Promise<AgentToolResult<CoordinationDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? undefined;
		const messaging = registry && senderId ? { registry, senderId } : undefined;
		const manager = this.session.asyncJobManager;

		const pending = takeQueuedMessage(messaging);
		if (pending && messaging) return messageResult(messaging.senderId, pending);
		// Refreshes owned-service tracking only; jobs are in-process, so a hung
		// broker must not turn every wait into an error.
		if (cfgLaunchEnabled.get(this.session.settings)) {
			try {
				await listServicesTolerant(this.session, signal);
			} catch (error) {
				// An interrupt landing during the refresh (most often the notice
				// of the job this wait is for) ends the wait as one landing just
				// after it does: the checks below and the aborted wake path.
				if (signal?.reason !== TOOL_INTERRUPT_ABORT_REASON) throw error;
			}
			const queued = takeQueuedMessage(messaging);
			if (queued && messaging) return messageResult(messaging.senderId, queued);
		}
		const jobs = manager?.getRunningJobs({ ownerId: senderId }) ?? [];
		// An accepted completion whose delivery has not reached the transcript
		// yet (queued, parked on the yield queue, or skipped while an earlier
		// wait watched it) is exactly what this wait is for: return it now.
		const undelivered = manager ? undeliveredJobs(manager, senderId) : [];
		if (manager && undelivered.length > 0) {
			return buildJobResult(this.session, manager, "wait", [...undelivered, ...jobs], []);
		}
		const serviceRunning = hasLiveOwnedService(this.session);
		if (jobs.length === 0 && !serviceRunning) {
			const replies = messaging ? pendingReplies(messaging) : { from: [], blocked: [], stopped: [] };
			if (replies.from.length === 0) {
				// An idle poll, not a failure: flagged so the loop guard keeps counting
				// across it, unless an interrupt (news for the model) landed meanwhile
				// or the text names an agent asked that can no longer answer.
				const news = signal?.aborted || replies.blocked.length > 0 || replies.stopped.length > 0;
				return {
					content: [{ type: "text", text: `Nothing to wait for: ${noReplyText(replies)}` }],
					details: { op: "wait", jobs: [] },
					...(news ? {} : { useless: true }),
				};
			}
		}
		return this.#blockUntilWake({ jobs, manager, messaging, serviceRunning, signal, onUpdate });
	}

	/**
	 * Block until an owned job settles, an owned service finishes, a message arrives, the cap elapses, or the call aborts.
	 * With neither jobs nor a service, the block is a reply wait: it also ends once no agent asked can still reply.
	 */
	async #blockUntilWake(args: {
		jobs: AsyncJob[];
		manager: AsyncJobManager | undefined;
		messaging: WaitMessaging | undefined;
		serviceRunning: boolean;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<CoordinationDetails> | undefined;
	}): Promise<AgentToolResult<CoordinationDetails>> {
		const { jobs, manager, messaging, serviceRunning, signal, onUpdate } = args;
		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const busAbort = new AbortController();
		// Only `busAbort` can reject this leg, and it fires once the wait has settled.
		const busLeg = messaging
			? IrcBus.global()
					.wait(messaging.senderId, {}, 0, busAbort.signal)
					.catch(() => null)
			: undefined;
		// A reply wait re-checks whether an agent asked can still answer on
		// every block change, status change, and end of an asked agent's turn
		// (after any automatic reply that turn owes has been sent).
		const replyWait = messaging !== undefined && jobs.length === 0 && !serviceRunning;
		let noReply: PendingReplies | undefined;
		const replyGone = Promise.withResolvers<void>();
		const unsubscribers: Array<() => void> = [];
		if (replyWait) {
			const checkReplies = () => {
				const replies = pendingReplies(messaging);
				if (replies.from.length > 0) return;
				noReply = replies;
				replyGone.resolve();
			};
			unsubscribers.push(messaging.registry.awaits.onChange(checkReplies));
			unsubscribers.push(messaging.registry.onChange(checkReplies));
			for (const id of pendingReplies(messaging).from) {
				const session = messaging.registry.get(id)?.session;
				if (!session) continue;
				unsubscribers.push(
					session.subscribe(event => {
						if (event.type === "agent_end") void session.waitForIrcReplies().then(checkReplies);
					}),
				);
			}
		}
		// A wait that only these subagents' results can end blocks the caller on
		// them, which their own reply waits read. A bash job or service is
		// another way out, so such a wait blocks on no one.
		const watchedAgents = jobs.flatMap(job => (job.agentId ? [job.agentId] : []));
		const releaseHold =
			messaging && !serviceRunning && watchedAgents.length === jobs.length
				? messaging.registry.awaits.hold(messaging.senderId, watchedAgents, { interruptible: true })
				: undefined;
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = setTimeout(timedOut, WAIT_MAX_MS);
		const abort = Promise.withResolvers<void>();
		const onAbort = () => abort.resolve();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const emitProgress = () =>
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobs) },
			});
		const progressTimer = onUpdate && jobs.length > 0 ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		if (jobs.length > 0) emitProgress();
		let wake: "job" | "message" | "service" | "unanswerable" | "timeout" | "abort";
		try {
			wake = await Promise.race([
				...jobs.map(job => job.promise.then(() => "job" as const)),
				...(busLeg ? [busLeg.then(() => "message" as const)] : []),
				...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
				...(replyWait ? [replyGone.promise.then(() => "unanswerable" as const)] : []),
				timeout.then(() => "timeout" as const),
				abort.promise.then(() => "abort" as const),
			]);
		} finally {
			clearTimeout(timer);
			clearInterval(progressTimer);
			busAbort.abort();
			serviceAbort.abort();
			for (const unsubscribe of unsubscribers) unsubscribe();
			releaseHold?.();
			signal?.removeEventListener("abort", onAbort);
		}
		// Unwatch only after the result is built: a job recovered below is
		// consumed first, while one left unreported (message or interrupt won
		// the race) is re-enqueued for its ordinary async delivery.
		try {
			// A dequeued message wins a photo-finish with a job: the job remains
			// deliverable, whereas a lost message cannot be recovered from the bus.
			const message = await busLeg;
			if (message && messaging) return messageResult(messaging.senderId, message);
			if (signal?.aborted) {
				// Steering, a peer IRC, or a completion notice cut the wait short:
				// the designed wake path, so the message injects after a normal
				// result. Any other abort stops the run.
				if (signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
					// Not `useless`: a message woke the agent, which the loop guard
					// must treat as progress rather than an idle poll.
					return {
						content: [{ type: "text", text: "Wait interrupted by message." }],
						details: { op: "wait", jobs: [], interrupted: true },
					};
				}
				throwIfAborted(signal);
			}
			if (manager && jobs.length > 0) {
				const result = buildJobResult(this.session, manager, "wait", jobs, []);
				// A finished service is news even while every watched job still runs.
				if (wake !== "service") return result;
				const { useless: _idle, ...woke } = result;
				return woke;
			}
			return {
				content: [
					{
						type: "text",
						text:
							wake === "service"
								? "A service finished. Read proc:// for its status and output."
								: wake === "unanswerable" && noReply
									? noReplyText(noReply)
									: replyWait
										? "Wait limit reached with no reply. Ask again, or finish without the answer."
										: "Wait limit reached; background work may still be running. Read proc:// for status.",
					},
				],
				details: { op: "wait", jobs: [] },
				// A wait that ran out with nothing to report is an idle poll.
				...(wake === "timeout" ? { useless: true } : {}),
			};
		} finally {
			manager?.unwatchJobs(watchedIds);
		}
	}
}

/** Observed execution phase from real streaming events. "model" never claims the request was sent. */
export type LiveActivityPhase = "working" | "model" | "thinking" | "responding" | "tool";

/** Compact gist shared by the subagent HUD and proc:// job rows. */
export interface LiveActivity {
	tool?: string;
	last?: boolean;
	detail?: string;
	elapsedMs?: number;
	phase?: LiveActivityPhase;
	idleMs?: number;
	retryState?: { attempt: number; maxAttempts: number; delayMs?: number };
	retryFailure?: { attempt?: number; errorMessage?: string };
}

const CURRENT_TOOL_ELAPSED_MS = 5000;
const IDLE_HINT_THRESHOLD_MS = 10_000;

const PHASE_LABELS: Record<Exclude<LiveActivityPhase, "tool">, string> = {
	working: "working",
	model: "waiting on model",
	thinking: "thinking",
	responding: "responding",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	// Progress snapshots are plain objects; individual fields stay unknown until checked.
	return value as Record<string, unknown>;
}

function asPhase(value: unknown): LiveActivityPhase | undefined {
	if (value === "working" || value === "model" || value === "thinking" || value === "responding" || value === "tool") {
		return value;
	}
	return undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function shortenHomePathsInText(text: string): string {
	const home = os.homedir();
	if (!home || text.length === 0 || !text.includes(home)) return text;
	return text.replaceAll(home, () => shortenPath(home, home));
}

/**
 * Compact live gist from an agent progress snapshot. Timestamps are never invented:
 * `idleMs` stays absent until a real `lastActivityAtMs` was observed. Terminal snapshots
 * are not running activity. `currentTool` is in-flight; `recentTools` only surface as `last`.
 */
export function liveActivityFromProgress(record: unknown, now: number): LiveActivity | undefined {
	const progressRecord = asRecord(record);
	if (!progressRecord) return undefined;
	const status = progressRecord.status;
	if (status === "completed" || status === "failed" || status === "aborted") return undefined;

	const phase = asPhase(progressRecord.activityPhase);
	const currentTool = asTrimmedString(progressRecord.currentTool);
	const recentTools = Array.isArray(progressRecord.recentTools) ? progressRecord.recentTools : [];
	const recentRecord = asRecord(recentTools[0]);
	const recentTool = asTrimmedString(recentRecord?.tool);
	const tool = currentTool ?? recentTool;
	const isHistory = currentTool === undefined && recentTool !== undefined;

	let retryState: LiveActivity["retryState"];
	const retry = asRecord(progressRecord.retryState);
	if (retry) {
		const attempt = numberField(retry, "attempt");
		const maxAttempts = numberField(retry, "maxAttempts");
		const delayMs = numberField(retry, "delayMs");
		if (attempt !== undefined && maxAttempts !== undefined) {
			retryState = { attempt, maxAttempts, ...(delayMs !== undefined && delayMs > 0 ? { delayMs } : {}) };
		}
	}
	let retryFailure: LiveActivity["retryFailure"];
	const failure = asRecord(progressRecord.retryFailure);
	if (failure) {
		const attempt = numberField(failure, "attempt");
		const errorMessage = asTrimmedString(failure.errorMessage);
		if (attempt !== undefined || errorMessage !== undefined) {
			retryFailure = { ...(attempt !== undefined ? { attempt } : {}), ...(errorMessage ? { errorMessage } : {}) };
		}
	}

	const lastActivityAtMs = numberField(progressRecord, "lastActivityAtMs");
	if (!phase && !tool && !retryState && !retryFailure && lastActivityAtMs === undefined) return undefined;

	const lastIntent = asTrimmedString(progressRecord.lastIntent);
	const args = currentTool ? asTrimmedString(progressRecord.currentToolArgs) : asTrimmedString(recentRecord?.args);
	const detail = phase && phase !== "tool" && !currentTool ? lastIntent : (lastIntent ?? args);

	let elapsedMs: number | undefined;
	if (currentTool) {
		const startMs = numberField(progressRecord, "currentToolStartMs");
		if (startMs !== undefined) {
			const elapsed = now - startMs;
			if (elapsed > CURRENT_TOOL_ELAPSED_MS) elapsedMs = elapsed;
		}
	}
	let idleMs: number | undefined;
	if (lastActivityAtMs !== undefined && elapsedMs === undefined) {
		const idle = now - lastActivityAtMs;
		if (idle > 0) idleMs = idle;
	}

	return {
		...(phase ? { phase } : {}),
		...(tool ? { tool, ...(isHistory ? { last: true } : {}) } : {}),
		...(detail ? { detail } : {}),
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(idleMs !== undefined ? { idleMs } : {}),
		...(retryState ? { retryState } : {}),
		...(retryFailure ? { retryFailure } : {}),
	};
}

function activityGist(activity: LiveActivity): string {
	if (activity.phase && activity.phase !== "tool") return PHASE_LABELS[activity.phase];
	if (activity.tool) return activity.last ? `last ${activity.tool}` : activity.tool;
	if (activity.phase === "tool") return "running a tool";
	return PHASE_LABELS.working;
}

function activityTiming(activity: LiveActivity): string | undefined {
	if (activity.idleMs !== undefined && activity.idleMs >= IDLE_HINT_THRESHOLD_MS) {
		return `${formatDuration(activity.idleMs)} no new events`;
	}
	if (activity.elapsedMs !== undefined) return formatDuration(activity.elapsedMs);
	return undefined;
}

/** Theme-free roster line for proc:// and other plain-text surfaces. */
export function formatPlainLiveActivity(activity: LiveActivity): string {
	if (activity.retryState) {
		const delay = activity.retryState.delayMs;
		const base = `retry ${activity.retryState.attempt}/${activity.retryState.maxAttempts}`;
		return delay !== undefined ? `${base} · retrying in ${formatDuration(delay)}` : base;
	}
	if (activity.retryFailure) {
		return activity.retryFailure.errorMessage ? `blocked: ${activity.retryFailure.errorMessage}` : "blocked";
	}
	const timing = activityTiming(activity);
	const detail = activity.detail ? shortenHomePathsInText(activity.detail) : undefined;
	return [activityGist(activity), detail, timing].filter(part => part !== undefined && part.length > 0).join(" · ");
}

/** HUD line. Silence is preferred over stale tool args when the row is narrow. */
export function formatCompactLiveActivityLine(activity: LiveActivity, budget: number, uiTheme: Theme): string {
	const hook = `${uiTheme.tree.hook} `;
	if (activity.retryState) {
		let line = `${hook}${uiTheme.fg("warning", `retry ${activity.retryState.attempt}/${activity.retryState.maxAttempts}`)}`;
		const delay = activity.retryState.delayMs;
		if (delay !== undefined) {
			const part = `${uiTheme.sep.dot}${uiTheme.fg("warning", `retrying in ${formatDuration(delay)}`)}`;
			if (visibleWidth(Bun.stripANSI(line)) + visibleWidth(Bun.stripANSI(part)) <= budget) line += part;
		}
		return truncateToWidth(line, budget, Ellipsis.Unicode);
	}
	if (activity.retryFailure) {
		const hint = activity.retryFailure.errorMessage ? `blocked: ${activity.retryFailure.errorMessage}` : "blocked";
		return truncateToWidth(
			`${hook}${uiTheme.fg("warning", shortenHomePathsInText(replaceTabs(sanitizeText(hint)).trim()))}`,
			budget,
			Ellipsis.Unicode,
		);
	}
	const base = `${hook}${uiTheme.fg("muted", sanitizeText(activityGist(activity)))}`;
	const baseWidth = visibleWidth(Bun.stripANSI(base));
	if (baseWidth >= budget) return truncateToWidth(base, budget, Ellipsis.Unicode);
	const timingText = activityTiming(activity);
	const timingPart = timingText ? `${uiTheme.sep.dot}${uiTheme.fg("warning", timingText)}` : undefined;
	const detailRaw = activity.detail
		? shortenHomePathsInText(replaceTabs(sanitizeText(activity.detail)).trim())
		: undefined;
	const detailPart =
		detailRaw !== undefined
			? `: ${uiTheme.fg("dim", previewLine(detailRaw, Math.max(1, budget - baseWidth - 2), Ellipsis.Unicode))}`
			: undefined;
	const width = (value: string): number => visibleWidth(Bun.stripANSI(value));
	const full = `${base}${detailPart ?? ""}${timingPart ?? ""}`;
	if (width(full) <= budget) return full;
	const noDetail = `${base}${timingPart ?? ""}`;
	if (width(noDetail) <= budget) return noDetail;
	return truncateToWidth(`${base}${detailPart ?? ""}`, budget, Ellipsis.Unicode);
}

/** Plain activity line for one task progress payload (record or progress array). */
export function formatJobLiveActivity(progress: unknown, jobId: string, now: number): string | undefined {
	let record: unknown = progress;
	if (Array.isArray(progress)) {
		let fallback: unknown;
		for (const item of progress) {
			const itemRecord = asRecord(item);
			if (!itemRecord) continue;
			if (!fallback) fallback = item;
			if (itemRecord.id === jobId) {
				record = item;
				fallback = undefined;
				break;
			}
		}
		if (fallback) record = fallback;
	}
	const activity = liveActivityFromProgress(record, now);
	return activity ? formatPlainLiveActivity(activity) : undefined;
}
