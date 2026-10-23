/**
 * D6 — collect real Hub actionHints from question/approval, child delivery, and goal owner.
 * View-only projection for inspector Needs me; does not schedule work.
 */
import type { HubActionQueueHints } from "@oh-my-pi/pi-tui/overlays/agent-hub-action-queue";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { collectPendingToolCalls } from "../session/exit-diagnostics";
import type { AgentSession } from "../session/agent-session";
import type { SessionEntry } from "../session/session-entries";

export interface HubActionHintSource {
	/** Roster rows (Main + children). */
	agents: readonly AgentRecordLike[];
	/**
	 * Resolve a live AgentSession for an agent id when the roster session is
	 * the coding-agent AgentSession (hub overlay types are structural).
	 */
	resolveSession?: (agentId: string) => AgentSession | null | undefined;
	/** Optional live ask-dialog open on the TUI host (Main). */
	askDialogOpenForAgentIds?: ReadonlySet<string> | readonly string[];
	/** Optional explicit approval waiters (tool_approval_requested not yet resolved). */
	pendingApprovalAgentIds?: ReadonlySet<string> | readonly string[];
	/** Optional child ids with integrate-eligible delivery pending parent accept. */
	pendingIntegrateAgentIds?: ReadonlySet<string> | readonly string[];
	now?: number;
}

function asMutableSet(value: ReadonlySet<string> | readonly string[] | undefined): Set<string> {
	if (!value) return new Set();
	if (value instanceof Set) return new Set(value);
	return new Set(value);
}

function sessionFromRef(ref: AgentRecordLike, resolve?: HubActionHintSource["resolveSession"]): AgentSession | null {
	const resolved = resolve?.(ref.id);
	if (resolved) return resolved;
	const session = ref.session;
	if (session && typeof (session as AgentSession).getGoalModeState === "function") {
		return session as AgentSession;
	}
	return null;
}

function readBranch(session: AgentSession): readonly SessionEntry[] {
	try {
		return session.sessionManager.getBranch();
	} catch {
		return [];
	}
}

function pendingAsk(session: AgentSession): boolean {
	const pending = collectPendingToolCalls(readBranch(session));
	return pending.some(call => call.toolName === "ask");
}

function pendingUnstartedTools(_session: AgentSession): boolean {
	// Real order is tool_execution_start THEN approval gate. Missing startedAt
	// means pre-start (schedule/prepare), not approval waiting. Do not treat as
	// need_auth — prefer explicit pendingApprovalAgentIds overlays.
	return false;
}

function goalBlocked(session: AgentSession): { blocked: boolean; summary?: string } {
	const state = session.getGoalModeState?.();
	const goal = state?.goal;
	if (!goal) return { blocked: false };
	const pause = goal.hostGate?.lastPauseReason;
	if (goal.status === "paused" && pause) {
		return {
			blocked: true,
			summary: `Goal paused (${pause}) — review nextStep`,
		};
	}
	if (goal.hostGate?.lastDecision === "blocked") {
		return {
			blocked: true,
			summary: goal.hostGate.lastNextStep?.trim() || "Host gate blocked — review nextStep",
		};
	}
	return { blocked: false };
}

function childLooksIntegrateEligible(ref: AgentRecordLike): boolean {
	// outputPath + idle/parked is NOT integrate-eligible delivery evidence.
	// Prefer explicit pendingIntegrateAgentIds from delivery classification owners.
	void ref;
	return false;
}

/**
 * Build HubActionQueueHints from live sessions + optional host overlays.
 * Cancelled / aborted agents never appear as need_decision or need_auth.
 */
export function collectHubActionHints(source: HubActionHintSource): HubActionQueueHints {
	const decisions = asMutableSet(source.askDialogOpenForAgentIds);
	const auths = asMutableSet(source.pendingApprovalAgentIds);
	const integrates = asMutableSet(source.pendingIntegrateAgentIds);
	const blocked = new Set<string>();
	const summaries: Record<string, string> = {};

	for (const ref of source.agents) {
		if (ref.kind === "advisor") continue;
		if (ref.status === "aborted") {
			// Cancel-then-late: drop any host overlay ids for aborted agents so
			// Needs me cannot revive decision/auth after cancel.
			decisions.delete(ref.id);
			auths.delete(ref.id);
			integrates.delete(ref.id);
			continue;
		}
		const session = sessionFromRef(ref, source.resolveSession);
		if (session) {
			if (pendingAsk(session)) {
				decisions.add(ref.id);
				summaries[ref.id] = "Needs a decision (ask tool pending)";
			}
			if (pendingUnstartedTools(session)) {
				auths.add(ref.id);
				summaries[ref.id] = summaries[ref.id] ?? "Needs authorization (tool approval pending)";
			}
			const gate = goalBlocked(session);
			if (gate.blocked) {
				blocked.add(ref.id);
				if (gate.summary) summaries[ref.id] = gate.summary;
			}
		}
		if (childLooksIntegrateEligible(ref)) {
			integrates.add(ref.id);
			summaries[ref.id] = summaries[ref.id] ?? "Needs integrate / acceptance (done_valid ≠ accepted)";
		}
	}

	return {
		pendingDecisionAgentIds: [...decisions],
		pendingAuthAgentIds: [...auths],
		pendingIntegrateAgentIds: [...integrates],
		blockedAgentIds: [...blocked],
		summaries,
	};
}
