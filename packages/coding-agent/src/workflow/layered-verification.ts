/**
 * Layered verification planner (delivery-first Package 3).
 *
 * Three responsibility layers — not “every worker runs the full suite” and not
 * “auto-run all checks after every edit”:
 * 1. slice_local — related local check after stabilize, or an executable
 *    checklist when the parent owns verify
 * 2. parent_integrate — cross-module contracts + actually changed behavior
 * 3. final_repo — necessary full-repo checks; reuse still-valid sealed results
 *
 * Also records workspace-fingerprint / reuse-decision overhead vs verify cost
 * so callers can see when reuse has no gain (overhead ≈ verify).
 */

import type { ParentIntegrateClass } from "../task/child-delivery-evidence";
import {
	assessVerificationReuse,
	type VerificationReuseDecision,
	type VerificationReuseReason,
} from "./verification-validity";
import type { VerificationArtifactV1, VerificationCodeState, VerificationScope } from "./types";

export type VerificationLayer = "slice_local" | "parent_integrate" | "final_repo";

export type LayeredCheckDisposition = "run" | "reuse" | "skip";

export interface LayeredCheckPlanItem {
	id: string;
	command: string;
	layer: VerificationLayer;
	disposition: LayeredCheckDisposition;
	/** Present when disposition is skip or reuse. */
	reason: string;
}

export interface LayeredVerificationPlan {
	layer: VerificationLayer;
	checks: LayeredCheckPlanItem[];
	/** Commands that must execute at this layer. */
	toRun: string[];
	/** Prior checks projected as reused (ids). */
	toReuse: string[];
	/** Skipped with why (not run). */
	skipped: Array<{ id: string; command: string; reason: string }>;
	reuseDecision: VerificationReuseDecision | null;
}

export interface FingerprintOverheadObservation {
	/** Wall ms spent deciding reuse / capturing fingerprint inputs. */
	reuseDecisionMs: number | null;
	/** Wall ms spent (or estimated) running verification commands. */
	verifyMs: number | null;
	/**
	 * True when reuseDecisionMs is known and ≥ verifyMs — reuse has no gain
	 * until the snapshot path is optimized. Null when either side unknown.
	 */
	overheadDominatesVerify: boolean | null;
	note: string;
}

export interface BuildLayeredVerificationPlanInput {
	layer: VerificationLayer;
	/** Commands proposed for this layer. */
	commands: readonly string[];
	codeState: VerificationCodeState;
	scope?: VerificationScope;
	priorVerification?: VerificationArtifactV1 | null;
	/**
	 * When parent owns verify, slice_local delivers a checklist instead of
	 * running commands (disposition skip with reason parent_owns_verify).
	 */
	parentOwnsVerify?: boolean;
	/** Parent integrate classification from Package 2 (optional). */
	parentClassification?: ParentIntegrateClass;
	/**
	 * Local/scoped command ids that already ran green for this code state
	 * (slice layer). Final/parent layers may skip re-running them when still valid.
	 */
	alreadyGreenLocalCommands?: readonly string[];
}

function commandId(command: string, index: number): string {
	const trimmed = command.trim();
	return trimmed ? `cmd:${trimmed}` : `cmd:#${index}`;
}

/**
 * Plan checks for one verification layer. Never auto-runs every command —
 * dispositions are explicit run / reuse / skip(+why).
 */
export function buildLayeredVerificationPlan(input: BuildLayeredVerificationPlanInput): LayeredVerificationPlan {
	const commands = input.commands.map(c => c.trim()).filter(Boolean);
	const checks: LayeredCheckPlanItem[] = [];
	const toRun: string[] = [];
	const toReuse: string[] = [];
	const skipped: Array<{ id: string; command: string; reason: string }> = [];

	if (input.layer === "slice_local" && input.parentOwnsVerify === true) {
		for (const [index, command] of commands.entries()) {
			const id = commandId(command, index);
			const item: LayeredCheckPlanItem = {
				id,
				command,
				layer: "slice_local",
				disposition: "skip",
				reason: "parent_owns_verify_checklist_only",
			};
			checks.push(item);
			skipped.push({ id, command, reason: item.reason });
		}
		return {
			layer: input.layer,
			checks,
			toRun,
			toReuse,
			skipped,
			reuseDecision: null,
		};
	}

	if (
		input.layer === "slice_local" &&
		(input.parentClassification === "cross_module" || input.parentClassification === "stale_context")
	) {
		for (const [index, command] of commands.entries()) {
			const id = commandId(command, index);
			const reason =
				input.parentClassification === "stale_context"
					? "stale_context_reread_first"
					: "cross_module_parent_coordinates";
			const item: LayeredCheckPlanItem = {
				id,
				command,
				layer: "slice_local",
				disposition: "skip",
				reason,
			};
			checks.push(item);
			skipped.push({ id, command, reason });
		}
		return {
			layer: input.layer,
			checks,
			toRun,
			toReuse,
			skipped,
			reuseDecision: null,
		};
	}

	let reuseDecision: VerificationReuseDecision | null = null;
	if (input.layer === "final_repo" || input.layer === "parent_integrate") {
		reuseDecision = assessVerificationReuse({
			prior: input.priorVerification,
			codeState: input.codeState,
			commands,
			scope: input.scope,
		});
		if (reuseDecision.reusable) {
			for (const [index, command] of commands.entries()) {
				const id = commandId(command, index);
				const item: LayeredCheckPlanItem = {
					id,
					command,
					layer: input.layer,
					disposition: "reuse",
					reason: "prior_seal_still_valid",
				};
				checks.push(item);
				toReuse.push(id);
			}
			return {
				layer: input.layer,
				checks,
				toRun,
				toReuse,
				skipped,
				reuseDecision,
			};
		}
	}

	const greenLocal = new Set((input.alreadyGreenLocalCommands ?? []).map(c => c.trim()).filter(Boolean));

	for (const [index, command] of commands.entries()) {
		const id = commandId(command, index);
		if (
			(input.layer === "parent_integrate" || input.layer === "final_repo") &&
			greenLocal.has(command) &&
			reuseDecision?.reason !== "code_state_mismatch" &&
			reuseDecision?.reason !== "commands_mismatch" &&
			reuseDecision?.reason !== "scope_mismatch"
		) {
			// Local greens are not delivery evidence; parent/final may still
			// skip re-running the identical local command when code state is
			// unchanged, but never after a mismatch reason above.
			if (
				reuseDecision?.reusable === false &&
				(reuseDecision.reason === "missing_validity" ||
					reuseDecision.reason === "workspace_unproven" ||
					reuseDecision.reason === "owner_not_delivery" ||
					reuseDecision.reason === "executor_not_trusted")
			) {
				// No trusted prior seal — local green alone cannot skip parent/final.
				const item: LayeredCheckPlanItem = {
					id,
					command,
					layer: input.layer,
					disposition: "run",
					reason: "no_trusted_prior_seal",
				};
				checks.push(item);
				toRun.push(command);
				continue;
			}
		}

		if (input.layer === "final_repo" && greenLocal.has(command) && reuseDecision?.reusable === true) {
			const item: LayeredCheckPlanItem = {
				id,
				command,
				layer: input.layer,
				disposition: "reuse",
				reason: "prior_seal_still_valid",
			};
			checks.push(item);
			toReuse.push(id);
			continue;
		}

		const item: LayeredCheckPlanItem = {
			id,
			command,
			layer: input.layer,
			disposition: "run",
			reason:
				reuseDecision && !reuseDecision.reusable ? `cannot_reuse:${reuseDecision.reason}` : "layer_requires_run",
		};
		checks.push(item);
		toRun.push(command);
	}

	return {
		layer: input.layer,
		checks,
		toRun,
		toReuse,
		skipped,
		reuseDecision,
	};
}

/**
 * Compare reuse-decision overhead to verify cost.
 * Missing timings stay null; never invents a latency win.
 */
export function observeFingerprintOverhead(input: {
	reuseDecisionMs: number | null | undefined;
	verifyMs: number | null | undefined;
}): FingerprintOverheadObservation {
	const reuseDecisionMs =
		typeof input.reuseDecisionMs === "number" && Number.isFinite(input.reuseDecisionMs) && input.reuseDecisionMs >= 0
			? input.reuseDecisionMs
			: null;
	const verifyMs =
		typeof input.verifyMs === "number" && Number.isFinite(input.verifyMs) && input.verifyMs >= 0
			? input.verifyMs
			: null;
	if (reuseDecisionMs === null || verifyMs === null) {
		return {
			reuseDecisionMs,
			verifyMs,
			overheadDominatesVerify: null,
			note: "unknown_overhead_or_verify_ms",
		};
	}
	const dominates = reuseDecisionMs >= verifyMs;
	return {
		reuseDecisionMs,
		verifyMs,
		overheadDominatesVerify: dominates,
		note: dominates
			? "reuse_decision_overhead_dominates_verify_optimize_snapshot_path_before_claiming_reuse_gain"
			: "reuse_decision_cheaper_than_verify",
	};
}

/**
 * Aggregate how many full-repo command runs a layered plan avoided via reuse.
 * Used by fixtures — not a live latency claim.
 *
 * Only counts reuse when disposition is reuse (prior terminal green + matching
 * command/scope/codeState). Never counts async.running.
 */
export function countFullRepoRunsAvoided(plans: readonly LayeredVerificationPlan[]): number {
	let avoided = 0;
	for (const plan of plans) {
		if (plan.layer !== "final_repo") continue;
		avoided += plan.toReuse.length;
	}
	return avoided;
}

/**
 * Observable plan/start + reuse/reject reasons for durable observe (Batch 1 W3).
 * `toRun` emits disposition `plan` (start) — never `verify_run` before commands
 * execute. Callers emit run/end via {@link layeredVerificationRunEndObserveEvents}
 * after verify completes. Does not invent acceptance.
 */
export function layeredVerificationObserveEvents(
	plan: LayeredVerificationPlan,
	meta: { eventIdPrefix: string; episodeKey?: string; jobId?: string; overheadMs?: number },
): Array<{
	disposition: "plan" | "reuse" | "reject";
	reason: string;
	eventId: string;
	episodeKey?: string;
	jobId?: string;
	overheadMs?: number;
}> {
	const events: Array<{
		disposition: "plan" | "reuse" | "reject";
		reason: string;
		eventId: string;
		episodeKey?: string;
		jobId?: string;
		overheadMs?: number;
	}> = [];
	const prefix = meta.eventIdPrefix.trim() || "layered";
	if (plan.reuseDecision && !plan.reuseDecision.reusable) {
		events.push({
			disposition: "reject",
			reason: plan.reuseDecision.reason,
			eventId: `${prefix}:reject:${plan.reuseDecision.reason}`,
			episodeKey: meta.episodeKey,
			jobId: meta.jobId,
			overheadMs: meta.overheadMs,
		});
	}
	for (const id of plan.toReuse) {
		events.push({
			disposition: "reuse",
			reason: "prior_seal_still_valid",
			eventId: `${prefix}:reuse:${id}`,
			episodeKey: meta.episodeKey,
			jobId: meta.jobId,
		});
	}
	for (const command of plan.toRun) {
		events.push({
			disposition: "plan",
			reason: "start",
			eventId: `${prefix}:plan:${command}`,
			episodeKey: meta.episodeKey,
			jobId: meta.jobId,
		});
	}
	return events;
}

/**
 * Run/end observe events after verify completes for commands that were planned.
 * Distinct from plan/start so `verify_run` is never minted before execution.
 */
export function layeredVerificationRunEndObserveEvents(
	plan: LayeredVerificationPlan,
	meta: { eventIdPrefix: string; episodeKey?: string; jobId?: string; overheadMs?: number },
): Array<{
	disposition: "run";
	reason: string;
	eventId: string;
	episodeKey?: string;
	jobId?: string;
	overheadMs?: number;
}> {
	const prefix = meta.eventIdPrefix.trim() || "layered";
	return plan.toRun.map(command => ({
		disposition: "run" as const,
		reason: "end",
		eventId: `${prefix}:run:${command}`,
		episodeKey: meta.episodeKey,
		jobId: meta.jobId,
		overheadMs: meta.overheadMs,
	}));
}

export type { VerificationReuseReason };
