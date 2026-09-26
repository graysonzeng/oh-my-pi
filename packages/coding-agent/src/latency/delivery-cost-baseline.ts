/**
 * Offline cost baseline for “correctly finishing a task” (delivery-first P0).
 *
 * Extends existing parent-final receipts + session usage — does not invent a
 * second telemetry platform. Missing signals stay null / "unknown"; never
 * zero-fill. Ordinary vs workflow cohorts stay separated.
 */
import { resolveSubagentPerformanceClass } from "../task/review-performance";
import { unionChildIntervalMs, type ParentFinalVerificationObservation } from "./parent-final-verification";
import type { CoverageCount, ParsedSession, PercentileSummary } from "./subagent-report";

/** Optional producer receipt for quality defects (absent ⇒ unknown, not 0). */
export const DELIVERY_QUALITY_OUTCOME_MESSAGE_TYPE = "delivery_quality_outcome";

export type DeliveryCohort = "ordinary" | "workflow" | "unknown";

export type FirstDeliveryAccepted = boolean | "unknown";

export interface DeliveryUsageSlice {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	costTotal: number | null;
}

export interface DeliveryCycleCounts {
	/** Explore-class re-spawns after first delivery boundary; null when unknown. */
	investigate: number | null;
	/** Worker-class re-spawns after first delivery boundary; null when unknown. */
	fix: number | null;
	/**
	 * Parent-final re-verifications after the first, plus review-class re-spawns
	 * after the boundary. Null when the boundary or any post-boundary child class
	 * is unknown (never zero-fill unclassified kids into "no verify cycles").
	 */
	verify: number | null;
}

/** Cost attributed to spawn completion kinds. Null when no priced usage in that bucket. */
export interface AttemptCostByCompletionKind {
	completed: number | null;
	timeout: number | null;
	cancelled: number | null;
	budget_stop: number | null;
	unknown: number | null;
}

export interface DeliveryCostTaskObservation {
	parentPathHash: string;
	cohort: DeliveryCohort;
	/** Latest parent-final status is passed (accepted task). False when failed/missing. */
	accepted: boolean;
	firstDeliveryAccepted: FirstDeliveryAccepted;
	cyclesAfterFirstDelivery: DeliveryCycleCounts;
	/** Sum of task toolCall→result waits on the parent (not serial child walls). */
	parentWaitMs: number | null;
	/** Last child/task settle → first/last parent-final boundary when known. */
	parentIntegrateMs: number | null;
	/** Union of child file intervals (parallel work counted once). */
	childTaskMs: number | null;
	usage: DeliveryUsageSlice;
	attemptCostByKind: AttemptCostByCompletionKind;
	e2eMs: number | null;
	falseAccept: boolean | "unknown";
	missedDefect: boolean | "unknown";
}

export interface DeliveryCostCohortSummary {
	taskCount: number;
	acceptedTaskCount: number;
	/**
	 * totalAttemptCost ÷ acceptedTaskCount.
	 * Null when acceptedTaskCount is 0, any task lacks priced attempt cost, or
	 * attempt-cost coverage is incomplete — never understate by treating missing
	 * costs as $0 in the numerator.
	 */
	costPerAcceptedTask: number | null;
	/**
	 * Sum of priced attempt costs across tasks in this cohort.
	 * Null when no task has priced usage; partial sums are still reported here
	 * but {@link costPerAcceptedTask} stays null until coverage is complete.
	 */
	totalAttemptCost: number | null;
	/**
	 * Share of tasks whose first parent-final was passed among tasks with a
	 * known first-delivery outcome. Null when no known outcomes.
	 */
	firstPassRate: number | null;
	/** Explicit false-accept receipts; "unknown" when none recorded. */
	falseAccept: number | "unknown";
	/** Explicit missed-defect receipts; "unknown" when none recorded. */
	missedDefects: number | "unknown";
	e2eMs: PercentileSummary | null;
	parentWaitMs: PercentileSummary | null;
	parentIntegrateMs: PercentileSummary | null;
	childTaskMs: PercentileSummary | null;
	usage: DeliveryUsageSlice;
	attemptCostByKind: AttemptCostByCompletionKind;
	cyclesAfterFirstDelivery: {
		investigate: PercentileSummary | null;
		fix: PercentileSummary | null;
		verify: PercentileSummary | null;
	};
	coverage: {
		firstDeliveryAccepted: CoverageCount;
		cycleCounts: CoverageCount;
		parentWaitMs: CoverageCount;
		parentIntegrateMs: CoverageCount;
		childTaskMs: CoverageCount;
		attemptCost: CoverageCount;
	};
}

export interface DeliveryCostBaselineReport {
	ordinary: DeliveryCostCohortSummary;
	workflow: DeliveryCostCohortSummary;
	unknownCohort: DeliveryCostCohortSummary;
	tasks: DeliveryCostTaskObservation[];
}

export interface DeliveryQualityOutcomeObservation {
	falseAccept: boolean | "unknown";
	missedDefect: boolean | "unknown";
	ts: number | null;
}

export function parseDeliveryQualityOutcomeDetails(details: unknown): {
	falseAccept: boolean | "unknown";
	missedDefect: boolean | "unknown";
} | null {
	if (!details || typeof details !== "object" || Array.isArray(details)) return null;
	const raw = details as Record<string, unknown>;
	const hasFalse = typeof raw.falseAccept === "boolean";
	const hasMiss = typeof raw.missedDefect === "boolean";
	if (!hasFalse && !hasMiss) return null;
	return {
		falseAccept: hasFalse ? (raw.falseAccept as boolean) : "unknown",
		missedDefect: hasMiss ? (raw.missedDefect as boolean) : "unknown",
	};
}

function emptyCoverage(): CoverageCount {
	return { present: 0, unknown: 0 };
}

function cover(count: CoverageCount, present: boolean): void {
	if (present) count.present++;
	else count.unknown++;
}

function addPresent(sum: number | null, value: number | null): number | null {
	if (value === null) return sum;
	return (sum ?? 0) + value;
}

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function summarizeMs(values: number[]): PercentileSummary | null {
	if (values.length === 0) return null;
	const sorted = values.slice().sort((a, b) => a - b);
	return { n: sorted.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) };
}

function emptyUsage(): DeliveryUsageSlice {
	return { input: null, output: null, cacheRead: null, costTotal: null };
}

function emptyAttemptCost(): AttemptCostByCompletionKind {
	return {
		completed: null,
		timeout: null,
		cancelled: null,
		budget_stop: null,
		unknown: null,
	};
}

function sumUsage(into: DeliveryUsageSlice, session: ParsedSession): void {
	for (const request of session.usageRequests) {
		into.input = addPresent(into.input, request.input);
		into.output = addPresent(into.output, request.output);
		into.cacheRead = addPresent(into.cacheRead, request.cacheRead);
		into.costTotal = addPresent(into.costTotal, request.costTotal);
	}
}

function sessionCost(session: ParsedSession): number | null {
	let cost: number | null = null;
	for (const request of session.usageRequests) {
		cost = addPresent(cost, request.costTotal);
	}
	return cost;
}

function fileWallMs(session: ParsedSession): number | null {
	if (session.timestampCount < 2 || session.firstTs === null || session.lastTs === null) return null;
	if (session.lastTs < session.firstTs) return null;
	return session.lastTs - session.firstTs;
}

function parentOf(
	child: ParsedSession,
	byPath: Map<string, ParsedSession>,
	byId: Map<string, ParsedSession>,
): ParsedSession | undefined {
	if (child.parentPathFromLayout) {
		const fromLayout = byPath.get(child.parentPathFromLayout);
		if (fromLayout) return fromLayout;
	}
	if (child.parentSessionHeader) {
		return byPath.get(child.parentSessionHeader) ?? byId.get(child.parentSessionHeader);
	}
	return undefined;
}

function classifyCohort(verifications: readonly ParentFinalVerificationObservation[]): DeliveryCohort {
	if (verifications.length === 0) return "unknown";
	let sawWorkflow = false;
	let sawOrdinary = false;
	for (const v of verifications) {
		if (v.source === "workflow") sawWorkflow = true;
		else if (v.source === "session_stop" || v.source === "extension") sawOrdinary = true;
	}
	// Mixed ordinary+workflow receipts are not collapsed into workflow — that
	// would violate ordinary ≠ workflow. Prefer unknown over absorption.
	if (sawWorkflow && sawOrdinary) return "unknown";
	if (sawWorkflow) return "workflow";
	if (sawOrdinary) return "ordinary";
	return "unknown";
}

function sortedVerifications(
	verifications: readonly ParentFinalVerificationObservation[],
): ParentFinalVerificationObservation[] {
	return verifications.slice().sort((a, b) => {
		const at = a.ts ?? Number.POSITIVE_INFINITY;
		const bt = b.ts ?? Number.POSITIVE_INFINITY;
		return at - bt;
	});
}

function firstDeliveryAccepted(
	verifications: readonly ParentFinalVerificationObservation[],
): FirstDeliveryAccepted {
	const sorted = sortedVerifications(verifications);
	const first = sorted[0];
	if (!first) return "unknown";
	return first.status === "passed";
}

function firstDeliveryBoundaryTs(
	parent: ParsedSession,
	kids: readonly ParsedSession[],
): number | null {
	const sorted = sortedVerifications(parent.parentFinalVerifications);
	for (const v of sorted) {
		if (v.ts !== null) return v.ts;
	}
	let earliestChildEnd: number | null = null;
	for (const child of kids) {
		if (child.lastTs === null) continue;
		if (earliestChildEnd === null || child.lastTs < earliestChildEnd) earliestChildEnd = child.lastTs;
	}
	for (const result of parent.toolResults) {
		if (result.name !== "task" || result.ts === null) continue;
		if (earliestChildEnd === null || result.ts < earliestChildEnd) earliestChildEnd = result.ts;
	}
	return earliestChildEnd;
}

function parentWaitMs(parent: ParsedSession): number | null {
	const byCall = new Map<string, { callTs: number | null; isSpawn: boolean }>();
	for (const call of parent.toolCalls) {
		if (!call.spawn) continue;
		byCall.set(call.callId, { callTs: call.ts, isSpawn: true });
	}
	let wait: number | null = null;
	for (const result of parent.toolResults) {
		const call = byCall.get(result.callId);
		if (!call || call.callTs === null || result.ts === null || result.ts < call.callTs) continue;
		wait = addPresent(wait, result.ts - call.callTs);
	}
	return wait;
}

function parentIntegrateMs(parent: ParsedSession, kids: readonly ParsedSession[]): number | null {
	const sorted = sortedVerifications(parent.parentFinalVerifications);
	const verifyTs = sorted.find(v => v.ts !== null)?.ts ?? null;
	if (verifyTs === null) return null;
	let settle: number | null = null;
	for (const child of kids) {
		if (child.lastTs === null) continue;
		if (settle === null || child.lastTs > settle) settle = child.lastTs;
	}
	for (const result of parent.toolResults) {
		if (result.name !== "task" || result.ts === null) continue;
		if (settle === null || result.ts > settle) settle = result.ts;
	}
	if (settle === null || verifyTs < settle) return null;
	return verifyTs - settle;
}

function childTaskUnionMs(kids: readonly ParsedSession[]): number | null {
	const intervals: Array<{ start: number; end: number }> = [];
	for (const child of kids) {
		if (child.firstTs === null || child.lastTs === null || child.lastTs < child.firstTs) continue;
		if (fileWallMs(child) === null) continue;
		intervals.push({ start: child.firstTs, end: child.lastTs });
	}
	if (intervals.length === 0) return null;
	return unionChildIntervalMs(intervals);
}

function spawnIdentityFromParent(
	parent: ParsedSession,
	child: ParsedSession,
): { agent: string | null; shadowReview: "code" | "off" | null } | undefined {
	const keys = [child.id, child.stem].filter((value): value is string => Boolean(value));
	if (keys.length === 0) return undefined;
	const matches: Array<{ agent: string | null; shadowReview: "code" | "off" | null }> = [];
	for (const call of parent.toolCalls) {
		if (!call.spawn) continue;
		for (const member of call.spawn.members) {
			if (!member.id || !keys.includes(member.id)) continue;
			matches.push({
				agent: member.agent ?? call.spawn.agent,
				shadowReview: member.shadowReview ?? call.spawn.shadowReview,
			});
		}
	}
	const first = matches[0];
	if (!first) return undefined;
	for (const match of matches) {
		if (match.agent !== first.agent || match.shadowReview !== first.shadowReview) return undefined;
	}
	return first;
}

/**
 * Align with live {@link resolveSubagentPerformanceClass} — do not use
 * includes()-heuristics that diverge (e.g. sonic → explore live, unknown here).
 */
function resolveChildClass(
	parent: ParsedSession,
	child: ParsedSession,
): "review" | "explore" | "worker" | "unknown" {
	if (child.performanceClass) return child.performanceClass;
	if (child.agent) return resolveSubagentPerformanceClass({ agentName: child.agent });
	const ident = spawnIdentityFromParent(parent, child);
	if (!ident?.agent) return "unknown";
	return resolveSubagentPerformanceClass({
		agentName: ident.agent,
		spawnShadowReview: ident.shadowReview === "code" || ident.shadowReview === "off" ? ident.shadowReview : undefined,
	});
}

function cyclesAfterFirstDelivery(
	parent: ParsedSession,
	kids: readonly ParsedSession[],
	boundaryTs: number | null,
): DeliveryCycleCounts {
	if (boundaryTs === null) {
		return { investigate: null, fix: null, verify: null };
	}
	const sorted = sortedVerifications(parent.parentFinalVerifications);
	let verify = 0;
	let sawFirst = false;
	for (const v of sorted) {
		if (!sawFirst) {
			sawFirst = true;
			continue;
		}
		if (v.ts === null || v.ts >= boundaryTs) verify++;
	}
	let investigate = 0;
	let fix = 0;
	for (const child of kids) {
		const start = child.firstTs;
		if (start === null || start <= boundaryTs) continue;
		const cls = resolveChildClass(parent, child);
		// Unclassified post-boundary kids must not look like "zero cycles known".
		if (cls === "unknown") {
			return { investigate: null, fix: null, verify: null };
		}
		if (cls === "explore") investigate++;
		else if (cls === "worker") fix++;
		else if (cls === "review") verify++;
	}
	return { investigate, fix, verify };
}

function pathHash(parentPath: string): string {
	// Short stable id for reports — avoid leaking absolute paths into samples.
	let h = 2166136261;
	for (let i = 0; i < parentPath.length; i++) {
		h ^= parentPath.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return `p${(h >>> 0).toString(16)}`;
}

function mapCompletionBucket(kind: string | null): keyof AttemptCostByCompletionKind {
	if (kind === "completed") return "completed";
	if (kind === "timeout") return "timeout";
	if (kind === "hard_abort") return "cancelled";
	if (kind === "budget_stop") return "budget_stop";
	return "unknown";
}

/**
 * Prefer the first non-success completion for a stem so a later repair
 * "completed" does not erase timed-out / cancelled attempt cost.
 */
function pickAttemptKind(kinds: readonly (string | null)[]): string | null {
	const failure = kinds.find(
		kind => kind === "timeout" || kind === "hard_abort" || kind === "budget_stop",
	);
	if (failure !== undefined) return failure;
	const completed = kinds.find(kind => kind === "completed");
	if (completed !== undefined) return completed;
	return kinds.find(kind => kind !== null) ?? null;
}

function attributeAttemptCosts(
	parent: ParsedSession,
	kids: readonly ParsedSession[],
): AttemptCostByCompletionKind {
	const costs = emptyAttemptCost();
	const kindsByStem = new Map<string, Array<string | null>>();
	const pushKind = (id: string, kind: string | null): void => {
		const list = kindsByStem.get(id);
		if (list) list.push(kind);
		else kindsByStem.set(id, [kind]);
	};
	for (const row of parent.spawnObservations) {
		if (!row.id) continue;
		pushKind(row.id, row.completionKind);
	}
	for (const result of parent.toolResults) {
		if (!result.spawnRows) continue;
		for (const row of result.spawnRows) {
			if (!row.id) continue;
			pushKind(row.id, row.completionKind);
		}
	}
	for (const child of kids) {
		const kinds =
			kindsByStem.get(child.stem) ??
			(child.agent ? kindsByStem.get(child.agent) : undefined) ??
			[];
		const kind = pickAttemptKind(kinds);
		const bucket = mapCompletionBucket(kind);
		costs[bucket] = addPresent(costs[bucket], sessionCost(child));
	}
	// Parent usage is part of the attempt but not a spawn completion kind —
	// fold into unknown only when there are no child attributions at all.
	const parentCost = sessionCost(parent);
	const anyChild = Object.values(costs).some(v => v !== null);
	if (!anyChild) {
		costs.unknown = addPresent(costs.unknown, parentCost);
	}
	return costs;
}

function mergeAttemptCost(into: AttemptCostByCompletionKind, from: AttemptCostByCompletionKind): void {
	into.completed = addPresent(into.completed, from.completed);
	into.timeout = addPresent(into.timeout, from.timeout);
	into.cancelled = addPresent(into.cancelled, from.cancelled);
	into.budget_stop = addPresent(into.budget_stop, from.budget_stop);
	into.unknown = addPresent(into.unknown, from.unknown);
}

function qualityFromSession(parent: ParsedSession): {
	falseAccept: boolean | "unknown";
	missedDefect: boolean | "unknown";
} {
	const outcomes = parent.qualityOutcomes ?? [];
	if (outcomes.length === 0) return { falseAccept: "unknown", missedDefect: "unknown" };
	let falseAccept: boolean | "unknown" = "unknown";
	let missedDefect: boolean | "unknown" = "unknown";
	for (const outcome of outcomes) {
		if (outcome.falseAccept !== "unknown") falseAccept = outcome.falseAccept;
		if (outcome.missedDefect !== "unknown") missedDefect = outcome.missedDefect;
	}
	return { falseAccept, missedDefect };
}

function emptyCohortSummary(): DeliveryCostCohortSummary {
	return {
		taskCount: 0,
		acceptedTaskCount: 0,
		costPerAcceptedTask: null,
		totalAttemptCost: null,
		firstPassRate: null,
		falseAccept: "unknown",
		missedDefects: "unknown",
		e2eMs: null,
		parentWaitMs: null,
		parentIntegrateMs: null,
		childTaskMs: null,
		usage: emptyUsage(),
		attemptCostByKind: emptyAttemptCost(),
		cyclesAfterFirstDelivery: {
			investigate: null,
			fix: null,
			verify: null,
		},
		coverage: {
			firstDeliveryAccepted: emptyCoverage(),
			cycleCounts: emptyCoverage(),
			parentWaitMs: emptyCoverage(),
			parentIntegrateMs: emptyCoverage(),
			childTaskMs: emptyCoverage(),
			attemptCost: emptyCoverage(),
		},
	};
}

function summarizeCohort(tasks: readonly DeliveryCostTaskObservation[]): DeliveryCostCohortSummary {
	const summary = emptyCohortSummary();
	summary.taskCount = tasks.length;
	const e2e: number[] = [];
	const waits: number[] = [];
	const integrates: number[] = [];
	const childTasks: number[] = [];
	const investigate: number[] = [];
	const fix: number[] = [];
	const verify: number[] = [];
	let knownFirst = 0;
	let firstPass = 0;
	let falseAcceptCount = 0;
	let missedDefectCount = 0;
	let sawFalseAccept = false;
	let sawMissedDefect = false;

	for (const task of tasks) {
		if (task.firstDeliveryAccepted === "unknown") cover(summary.coverage.firstDeliveryAccepted, false);
		else {
			cover(summary.coverage.firstDeliveryAccepted, true);
			knownFirst++;
			if (task.firstDeliveryAccepted) firstPass++;
		}
		const cyclesKnown =
			task.cyclesAfterFirstDelivery.investigate !== null &&
			task.cyclesAfterFirstDelivery.fix !== null &&
			task.cyclesAfterFirstDelivery.verify !== null;
		cover(summary.coverage.cycleCounts, cyclesKnown);
		if (task.cyclesAfterFirstDelivery.investigate !== null) {
			investigate.push(task.cyclesAfterFirstDelivery.investigate);
		}
		if (task.cyclesAfterFirstDelivery.fix !== null) fix.push(task.cyclesAfterFirstDelivery.fix);
		if (task.cyclesAfterFirstDelivery.verify !== null) verify.push(task.cyclesAfterFirstDelivery.verify);

		cover(summary.coverage.parentWaitMs, task.parentWaitMs !== null);
		if (task.parentWaitMs !== null) waits.push(task.parentWaitMs);
		cover(summary.coverage.parentIntegrateMs, task.parentIntegrateMs !== null);
		if (task.parentIntegrateMs !== null) integrates.push(task.parentIntegrateMs);
		cover(summary.coverage.childTaskMs, task.childTaskMs !== null);
		if (task.childTaskMs !== null) childTasks.push(task.childTaskMs);

		cover(summary.coverage.attemptCost, task.usage.costTotal !== null);
		summary.usage.input = addPresent(summary.usage.input, task.usage.input);
		summary.usage.output = addPresent(summary.usage.output, task.usage.output);
		summary.usage.cacheRead = addPresent(summary.usage.cacheRead, task.usage.cacheRead);
		summary.usage.costTotal = addPresent(summary.usage.costTotal, task.usage.costTotal);
		summary.totalAttemptCost = addPresent(summary.totalAttemptCost, task.usage.costTotal);
		mergeAttemptCost(summary.attemptCostByKind, task.attemptCostByKind);

		if (task.e2eMs !== null) e2e.push(task.e2eMs);
		if (task.accepted) summary.acceptedTaskCount++;
		if (task.falseAccept !== "unknown") {
			sawFalseAccept = true;
			if (task.falseAccept) falseAcceptCount++;
		}
		if (task.missedDefect !== "unknown") {
			sawMissedDefect = true;
			if (task.missedDefect) missedDefectCount++;
		}
	}

	summary.firstPassRate = knownFirst > 0 ? firstPass / knownFirst : null;
	summary.falseAccept = sawFalseAccept ? falseAcceptCount : "unknown";
	summary.missedDefects = sawMissedDefect ? missedDefectCount : "unknown";
	summary.e2eMs = summarizeMs(e2e);
	summary.parentWaitMs = summarizeMs(waits);
	summary.parentIntegrateMs = summarizeMs(integrates);
	summary.childTaskMs = summarizeMs(childTasks);
	summary.cyclesAfterFirstDelivery = {
		investigate: summarizeMs(investigate),
		fix: summarizeMs(fix),
		verify: summarizeMs(verify),
	};
	// Gate the headline ratio on complete attempt-cost coverage. A partial sum
	// over acceptedTaskCount would understate cost by treating missing prices as $0.
	const attemptCostComplete =
		summary.taskCount > 0 && summary.coverage.attemptCost.unknown === 0 && summary.totalAttemptCost !== null;
	if (summary.acceptedTaskCount > 0 && attemptCostComplete) {
		summary.costPerAcceptedTask = summary.totalAttemptCost! / summary.acceptedTaskCount;
	} else {
		summary.costPerAcceptedTask = null;
	}
	return summary;
}

export function observeDeliveryCostTask(args: {
	parent: ParsedSession;
	children: readonly ParsedSession[];
}): DeliveryCostTaskObservation {
	const { parent, children } = args;
	const verifications = parent.parentFinalVerifications;
	const cohort = classifyCohort(verifications);
	const boundaryTs = firstDeliveryBoundaryTs(parent, children);
	const usage = emptyUsage();
	sumUsage(usage, parent);
	for (const child of children) sumUsage(usage, child);
	const quality = qualityFromSession(parent);
	const sorted = sortedVerifications(verifications);
	const last = sorted.length > 0 ? sorted[sorted.length - 1]! : undefined;
	const accepted = last?.status === "passed";
	const verifyTs = last?.ts ?? null;
	const e2eMs =
		parent.firstTs !== null && verifyTs !== null && verifyTs >= parent.firstTs ? verifyTs - parent.firstTs : null;

	return {
		parentPathHash: pathHash(parent.path),
		cohort,
		accepted,
		firstDeliveryAccepted: firstDeliveryAccepted(verifications),
		cyclesAfterFirstDelivery: cyclesAfterFirstDelivery(parent, children, boundaryTs),
		parentWaitMs: parentWaitMs(parent),
		parentIntegrateMs: parentIntegrateMs(parent, children),
		childTaskMs: childTaskUnionMs(children),
		usage,
		attemptCostByKind: attributeAttemptCosts(parent, children),
		e2eMs,
		falseAccept: quality.falseAccept,
		missedDefect: quality.missedDefect,
	};
}

export function buildDeliveryCostBaselineReport(sessions: readonly ParsedSession[]): DeliveryCostBaselineReport {
	const byPath = new Map<string, ParsedSession>();
	const byId = new Map<string, ParsedSession>();
	const parents: ParsedSession[] = [];
	const children: ParsedSession[] = [];
	for (const session of sessions) {
		byPath.set(session.path, session);
		if (session.id) byId.set(session.id, session);
		if (session.isSubagent) children.push(session);
		else parents.push(session);
	}

	const childrenByParent = new Map<string, ParsedSession[]>();
	for (const child of children) {
		const parent = parentOf(child, byPath, byId);
		if (!parent) continue;
		const list = childrenByParent.get(parent.path);
		if (list) list.push(child);
		else childrenByParent.set(parent.path, [child]);
	}

	const tasks: DeliveryCostTaskObservation[] = [];
	for (const parent of parents) {
		const kids = childrenByParent.get(parent.path) ?? [];
		tasks.push(observeDeliveryCostTask({ parent, children: kids }));
	}

	const ordinary = tasks.filter(t => t.cohort === "ordinary");
	const workflow = tasks.filter(t => t.cohort === "workflow");
	const unknown = tasks.filter(t => t.cohort === "unknown");

	return {
		ordinary: summarizeCohort(ordinary),
		workflow: summarizeCohort(workflow),
		unknownCohort: summarizeCohort(unknown),
		tasks,
	};
}

export function formatDeliveryCostBaselineReport(report: DeliveryCostBaselineReport): string {
	const fmtPct = (summary: PercentileSummary | null): string => {
		if (!summary || summary.n === 0) return "null";
		return `n=${summary.n} p50=${summary.p50} p90=${summary.p90}`;
	};
	const fmtUsage = (u: DeliveryUsageSlice): string =>
		`input=${u.input} output=${u.output} cacheRead=${u.cacheRead} costTotal=${u.costTotal}`;
	const fmtCohort = (name: string, c: DeliveryCostCohortSummary): string[] => [
		`${name}: tasks=${c.taskCount} accepted=${c.acceptedTaskCount} costPerAccepted=${c.costPerAcceptedTask} totalAttemptCost=${c.totalAttemptCost}`,
		`  firstPassRate=${c.firstPassRate} falseAccept=${c.falseAccept} missedDefects=${c.missedDefects}`,
		`  e2eMs=${fmtPct(c.e2eMs)} parentWaitMs=${fmtPct(c.parentWaitMs)} parentIntegrateMs=${fmtPct(c.parentIntegrateMs)} childTaskMs=${fmtPct(c.childTaskMs)}`,
		`  cycles investigate=${fmtPct(c.cyclesAfterFirstDelivery.investigate)} fix=${fmtPct(c.cyclesAfterFirstDelivery.fix)} verify=${fmtPct(c.cyclesAfterFirstDelivery.verify)}`,
		`  usage ${fmtUsage(c.usage)}`,
		`  attemptCostByKind ${JSON.stringify(c.attemptCostByKind)}`,
		`  coverage firstDelivery=${JSON.stringify(c.coverage.firstDeliveryAccepted)} cycles=${JSON.stringify(c.coverage.cycleCounts)} attemptCost=${JSON.stringify(c.coverage.attemptCost)}`,
	];
	return [
		"delivery cost baseline (offline; unknown stays unknown; ordinary ≠ workflow)",
		...fmtCohort("ordinary", report.ordinary),
		...fmtCohort("workflow", report.workflow),
		...fmtCohort("unknownCohort", report.unknownCohort),
	].join("\n");
}
