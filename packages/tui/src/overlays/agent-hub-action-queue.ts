/**
 * D6 Agent Hub action-queue projection.
 *
 * View-only: does not change task scheduling. Dedupes by stable action id.
 * Reuses roster records; buckets map to “what needs me now”.
 */
import type { AgentRecordLike, AgentStatus } from "./agent-hub-types";

export type HubActionKind =
	| "need_decision"
	| "need_auth"
	| "need_integrate"
	| "blocked_or_no_progress"
	| "running_or_handled";

export interface HubActionItem {
	/** Stable id for dedupe across updates (agentId + kind + optional token). */
	id: string;
	kind: HubActionKind;
	agentId: string;
	displayName: string;
	summary: string;
	/** Optional pointer back to session / goal / delivery source. */
	sourceRef?: string;
	updatedAt: number;
}

export interface HubActionQueueHints {
	/** Agents waiting on an ask / clarification. */
	pendingDecisionAgentIds?: ReadonlySet<string> | readonly string[];
	/** Agents blocked on approval / permission. */
	pendingAuthAgentIds?: ReadonlySet<string> | readonly string[];
	/** Children with integrate-eligible delivery pending parent accept. */
	pendingIntegrateAgentIds?: ReadonlySet<string> | readonly string[];
	/** Explicit blocked / no-progress markers from goal host gate. */
	blockedAgentIds?: ReadonlySet<string> | readonly string[];
	/** Optional per-agent summary overrides. */
	summaries?: ReadonlyMap<string, string> | Record<string, string>;
}

function asSet(value: ReadonlySet<string> | readonly string[] | undefined): Set<string> {
	if (!value) return new Set();
	if (value instanceof Set) return value;
	return new Set(value);
}

function summaryFor(summaries: HubActionQueueHints["summaries"], agentId: string, fallback: string): string {
	if (!summaries) return fallback;
	if (summaries instanceof Map) return summaries.get(agentId) ?? fallback;
	const record = summaries as Record<string, string>;
	return Object.hasOwn(record, agentId) ? record[agentId]! : fallback;
}

const KIND_ORDER: Record<HubActionKind, number> = {
	need_decision: 0,
	need_auth: 1,
	need_integrate: 2,
	blocked_or_no_progress: 3,
	running_or_handled: 4,
};

/**
 * Project roster + optional host hints into an action queue.
 * Same (agentId, kind) collapses to one row; later updates replace summary/time.
 */
export function projectHubActionQueue(
	refs: readonly AgentRecordLike[],
	hints: HubActionQueueHints = {},
	now: number = Date.now(),
): HubActionItem[] {
	const decisions = asSet(hints.pendingDecisionAgentIds);
	const auths = asSet(hints.pendingAuthAgentIds);
	const integrates = asSet(hints.pendingIntegrateAgentIds);
	const blocked = asSet(hints.blockedAgentIds);
	const byId = new Map(refs.map(r => [r.id, r]));
	const items = new Map<string, HubActionItem>();

	const push = (kind: HubActionKind, agentId: string, summary: string, sourceRef?: string) => {
		const ref = byId.get(agentId);
		const id = `${agentId}::${kind}`;
		items.set(id, {
			id,
			kind,
			agentId,
			displayName: ref?.displayName ?? agentId,
			summary,
			sourceRef,
			updatedAt: ref?.lastActivity ?? now,
		});
	};

	for (const agentId of decisions) {
		push(
			"need_decision",
			agentId,
			summaryFor(hints.summaries, agentId, "Needs a decision (options / impact)"),
			byId.get(agentId)?.sessionFile ?? undefined,
		);
	}
	for (const agentId of auths) {
		push(
			"need_auth",
			agentId,
			summaryFor(hints.summaries, agentId, "Needs authorization (scope / expiry)"),
			byId.get(agentId)?.sessionFile ?? undefined,
		);
	}
	for (const agentId of integrates) {
		push(
			"need_integrate",
			agentId,
			summaryFor(hints.summaries, agentId, "Needs integrate / acceptance (done_valid ≠ accepted)"),
			byId.get(agentId)?.sessionFile ?? undefined,
		);
	}
	for (const agentId of blocked) {
		push(
			"blocked_or_no_progress",
			agentId,
			summaryFor(hints.summaries, agentId, "Blocked or no-progress — review nextStep"),
			byId.get(agentId)?.sessionFile ?? undefined,
		);
	}

	for (const ref of refs) {
		const already = decisions.has(ref.id) || auths.has(ref.id) || integrates.has(ref.id) || blocked.has(ref.id);
		if (already) continue;
		const status: AgentStatus = ref.status;
		if (status === "aborted") {
			push(
				"blocked_or_no_progress",
				ref.id,
				summaryFor(hints.summaries, ref.id, "Aborted"),
				ref.sessionFile ?? undefined,
			);
			continue;
		}
		if (status === "running" || status === "idle" || status === "parked") {
			push(
				"running_or_handled",
				ref.id,
				summaryFor(hints.summaries, ref.id, status === "running" ? "Running" : status),
				ref.sessionFile ?? undefined,
			);
		}
	}

	return [...items.values()].sort((a, b) => {
		const ko = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
		if (ko !== 0) return ko;
		return b.updatedAt - a.updatedAt || a.agentId.localeCompare(b.agentId);
	});
}

/** Actionable subset — default collapsed “running_or_handled” excluded. */
export function actionableHubItems(items: readonly HubActionItem[]): HubActionItem[] {
	return items.filter(item => item.kind !== "running_or_handled");
}

export function formatHubActionQueue(items: readonly HubActionItem[]): string {
	const actionable = actionableHubItems(items);
	const lines = [
		"agent hub action queue (D6)",
		`actionable=${actionable.length} total=${items.length}`,
		...actionable.map(item => `  [${item.kind}] ${item.displayName} (${item.agentId}): ${item.summary}`),
	];
	return lines.join("\n");
}
