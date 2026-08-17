import { logger } from "@oh-my-pi/pi-utils";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { BUILTIN_SHADOWS } from "./definitions";
import { recordShadowReviewObservation, tripShadowReviewStop } from "./observation";
import { buildShadowRequest, buildShadowSystemPrompt } from "./protocol";
import { createReportToMainTool, type ReportToMainState } from "./report-tool";
import { serializeTrajectory } from "./trajectory";
import {
	SHADOW_COHORT_DRAIN_TIMEOUT_SECONDS,
	SHADOW_DIMENSION_IDS,
	SHADOW_PER_CHILD_TIMEOUT_SECONDS,
	SHADOW_REVIEW_JOB_LABEL,
	type ShadowDimensionId,
	type ShadowDimensionResult,
	type ShadowDimensionStatus,
	type ShadowReviewDetails,
} from "./types";

export type CreateShadowSession = typeof createAgentSession;

export interface RunShadowCohortOptions {
	parent: AgentSession;
	cwd: string;
	reviewerAgentId: string;
	signal: AbortSignal;
	reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
	markRunning: () => void;
	createSession?: CreateShadowSession;
	perChildTimeoutSeconds?: number;
	drainTimeoutSeconds?: number;
}

export async function runShadowCohort(options: RunShadowCohortOptions): Promise<string> {
	options.markRunning();
	const startedAt = new Date().toISOString();
	const startedMs = Date.now();
	const createSession = options.createSession ?? createAgentSession;
	const perChildMs = (options.perChildTimeoutSeconds ?? SHADOW_PER_CHILD_TIMEOUT_SECONDS) * 1000;
	const drainMs = (options.drainTimeoutSeconds ?? SHADOW_COHORT_DRAIN_TIMEOUT_SECONDS) * 1000;
	const trajectory = serializeTrajectory(options.parent.messages);
	const systemPrompt = buildShadowSystemPrompt(options.parent.systemPrompt.join("\n\n"));
	if (!options.parent.model) {
		throw new Error("shadow-review skipped: parent session has no model");
	}

	const childAborts: AbortController[] = [];
	const drainAbort = new AbortController();
	const onParentAbort = () => {
		drainAbort.abort();
		for (const child of childAborts) child.abort();
	};
	if (options.signal.aborted) onParentAbort();
	else options.signal.addEventListener("abort", onParentAbort, { once: true });
	const drainTimer = setTimeout(() => onParentAbort(), drainMs);

	try {
		const runs = BUILTIN_SHADOWS.map(shadow => {
			const childAbort = new AbortController();
			childAborts.push(childAbort);
			if (drainAbort.signal.aborted) childAbort.abort();
			drainAbort.signal.addEventListener("abort", () => childAbort.abort(), { once: true });
			return runOneShadow({
				parent: options.parent,
				cwd: options.cwd,
				reviewerAgentId: options.reviewerAgentId,
				shadowId: shadow.id,
				shadow,
				trajectory,
				systemPrompt,
				createSession,
				signal: childAbort.signal,
				timeoutMs: perChildMs,
			});
		});
		const settled = await Promise.allSettled(runs);
		const dimensions: ShadowDimensionResult[] = SHADOW_DIMENSION_IDS.map((id, index) => {
			const result = settled[index];
			if (result.status === "fulfilled") return result.value;
			return {
				id,
				status: "error",
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				durationMs: 0,
			};
		});
		const details: ShadowReviewDetails = { dimensions };
		const text = formatShadowReport(dimensions);
		await options.reportProgress(text, { shadowReview: details });
		const observation = {
			sessionId: options.parent.sessionManager.getSessionId(),
			arm: "treatment" as const,
			agent: options.reviewerAgentId,
			dimensionStatuses: dimensions.map(d => d.status),
			wallMs: Date.now() - startedMs,
			findingFingerprints: dimensions.filter(d => d.status === "reported").map(d => d.id),
			startedAt,
			endedAt: new Date().toISOString(),
		};
		recordShadowReviewObservation(observation);
		try {
			options.parent.sessionManager.appendCustomEntry("shadow-review-observation", observation);
		} catch (error) {
			logger.warn("shadow-review observation entry failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return text;
	} finally {
		clearTimeout(drainTimer);
		options.signal.removeEventListener("abort", onParentAbort);
	}
}

async function runOneShadow(options: {
	parent: AgentSession;
	cwd: string;
	reviewerAgentId: string;
	shadowId: ShadowDimensionId;
	shadow: (typeof BUILTIN_SHADOWS)[number];
	trajectory: string;
	systemPrompt: string;
	createSession: CreateShadowSession;
	signal: AbortSignal;
	timeoutMs: number;
}): Promise<ShadowDimensionResult> {
	const started = Date.now();
	const reportState: ReportToMainState = { reported: false };
	let session: AgentSession | undefined;
	const timeoutAbort = new AbortController();
	const timeoutHandle = setTimeout(() => timeoutAbort.abort(), options.timeoutMs);
	const abortSession = () => {
		void session?.abort({ reason: timeoutAbort.signal.aborted ? "shadow-timeout" : "shadow-abort" });
	};
	timeoutAbort.signal.addEventListener("abort", abortSession, { once: true });
	options.signal.addEventListener("abort", abortSession, { once: true });

	try {
		const reportTool = createReportToMainTool(reportState);
		const agentId = `${options.reviewerAgentId}:shadow:${options.shadowId}`;
		if (agentId === MAIN_AGENT_ID) {
			tripShadowReviewStop("registry agentId collision");
			return { id: options.shadowId, status: "error", error: "agentId collision", durationMs: Date.now() - started };
		}
		const created = await options.createSession({
			cwd: options.cwd,
			isolatedChild: true,
			model: options.parent.model,
			thinkingLevel: options.parent.configuredThinkingLevel() ?? options.parent.thinkingLevel,
			sessionManager: SessionManager.inMemory(options.cwd),
			agentId,
			parentAgentId: options.reviewerAgentId,
			parentTaskPrefix: options.reviewerAgentId,
			agentDisplayName: `shadow:${options.shadowId}`,
			taskDepth: 1,
			customTools: [reportTool],
			toolNames: ["read", "grep", "glob", "report_to_main"],
			requireYieldTool: false,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			skills: [],
			slashCommands: [],
			promptTemplates: [],
			contextFiles: [],
			extensions: [],
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
			disableExtensionDiscovery: true,
			modelRegistry: options.parent.modelRegistry,
			authStorage: options.parent.modelRegistry.authStorage,
			settings: options.parent.settings,
			systemPrompt: [options.systemPrompt],
			hasUI: false,
		});
		session = created.session;
		reportState.abort = () => {
			void session?.abort({ reason: "shadow-report" });
		};
		const active = session.getActiveToolNames();
		if (active.includes("bash") || active.includes("write")) {
			tripShadowReviewStop("child write/bash");
		}
		if (timeoutAbort.signal.aborted) {
			return { id: options.shadowId, status: "timeout", durationMs: Date.now() - started };
		}
		if (options.signal.aborted) {
			return { id: options.shadowId, status: "aborted", durationMs: Date.now() - started };
		}
		await Promise.race([
			session.prompt(buildShadowRequest(options.trajectory, options.shadow)).then(() => session?.waitForIdle()),
			waitForAbort(timeoutAbort.signal, options.signal),
		]);
		if (timeoutAbort.signal.aborted) {
			return { id: options.shadowId, status: "timeout", durationMs: Date.now() - started };
		}
		if (options.signal.aborted && !reportState.reported) {
			return { id: options.shadowId, status: "aborted", durationMs: Date.now() - started };
		}
		return {
			id: options.shadowId,
			status: resolveStatus(reportState, timeoutAbort.signal.aborted, options.signal.aborted),
			content: reportState.content,
			durationMs: Date.now() - started,
		};
	} catch (error) {
		if (timeoutAbort.signal.aborted) {
			return { id: options.shadowId, status: "timeout", durationMs: Date.now() - started };
		}
		if (options.signal.aborted) {
			return { id: options.shadowId, status: "aborted", durationMs: Date.now() - started };
		}
		return {
			id: options.shadowId,
			status: "error",
			error: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - started,
		};
	} finally {
		clearTimeout(timeoutHandle);
		timeoutAbort.signal.removeEventListener("abort", abortSession);
		options.signal.removeEventListener("abort", abortSession);
		if (session) {
			try {
				await session.dispose();
			} catch (error) {
				logger.warn("shadow child dispose failed", {
					shadowId: options.shadowId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}

function waitForAbort(...signals: AbortSignal[]): Promise<void> {
	return new Promise(resolve => {
		const onAbort = () => resolve();
		for (const signal of signals) {
			if (signal.aborted) {
				resolve();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function resolveStatus(state: ReportToMainState, timedOut: boolean, aborted: boolean): ShadowDimensionStatus {
	if (state.reported) return "reported";
	if (timedOut) return "timeout";
	if (aborted) return "aborted";
	return "completed_no_finding";
}

export function formatShadowReport(dimensions: ShadowDimensionResult[]): string {
	const lines = [
		"Shadow review evidence (label: shadow-review). Treat as evidence only; do not copy into findings without existing criteria.",
		"",
	];
	for (const dimension of dimensions) {
		lines.push(`- ${dimension.id}: ${dimension.status}${dimension.error ? ` (${dimension.error})` : ""}`);
		if (dimension.content) lines.push(dimension.content);
	}
	return lines.join("\n");
}

export { SHADOW_REVIEW_JOB_LABEL };
