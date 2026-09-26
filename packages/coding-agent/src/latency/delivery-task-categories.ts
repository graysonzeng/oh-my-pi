/**
 * Batch 1 W8 — eight representative task categories for offline L0 / L1.
 *
 * These are mechanism fixtures, not live cost wins. L2/L3 paid pairs are
 * explicitly out of scope for Batch 1 (`paired_evidence_insufficient`).
 */
export const DELIVERY_TASK_CATEGORY_IDS = [
	"small_scope_query",
	"diagnosed_local_fix",
	"two_independent_modules",
	"shared_interface",
	"independent_review_known_defect",
	"long_session_cross_phase",
	"auth_transport_recovery",
	"multi_episode_receipt_metrics",
] as const;

export type DeliveryTaskCategoryId = (typeof DELIVERY_TASK_CATEGORY_IDS)[number];

export interface DeliveryTaskCategorySpec {
	id: DeliveryTaskCategoryId;
	/** What the category exercises. */
	purpose: string;
	/** L0 covers real state transitions offline without provider spend. */
	l0Contract: string;
	/** Whether Batch 1 ships an executable L0 fixture in-repo. */
	l0FixtureReady: boolean;
}

export const DELIVERY_TASK_CATEGORIES: readonly DeliveryTaskCategorySpec[] = [
	{
		id: "small_scope_query",
		purpose: "Direct answer without extra agent fan-out",
		l0Contract: "acceptance without child spawn; stop alone is not accepted",
		l0FixtureReady: true,
	},
	{
		id: "diagnosed_local_fix",
		purpose: "Evidence handoff reduces re-investigation",
		l0Contract: "generate → consume valid → reuse continue; stale forces spawn_fresh",
		l0FixtureReady: true,
	},
	{
		id: "two_independent_modules",
		purpose: "True parallel gain vs integrate cost",
		l0Contract: "two episodes/jobs isolate costs; parallel child walls use union not sum",
		l0FixtureReady: true,
	},
	{
		id: "shared_interface",
		purpose: "Ownership protection and over-split risk",
		l0Contract: "unreleased write ownership cannot integrate; cross_module parent_coordinate",
		l0FixtureReady: true,
	},
	{
		id: "independent_review_known_defect",
		purpose: "Missed defect / false accept — not just green tests",
		l0Contract: "tools green + unmet acceptance ⇒ not accepted; quality outcome receipts",
		l0FixtureReady: true,
	},
	{
		id: "long_session_cross_phase",
		purpose: "Early constraints, artifact recovery, context/cache tradeoffs",
		l0Contract: "fail→repair→pass is one accepted episode retaining all attempt costs",
		l0FixtureReady: true,
	},
	{
		id: "auth_transport_recovery",
		purpose: "Recovery fidelity after auth/transport/thinking-loop + completed writes",
		l0Contract: "fork/dup receipts idempotent by eventId; write failure never mints green",
		l0FixtureReady: true,
	},
	{
		id: "multi_episode_receipt_metrics",
		purpose: "Metric trust: multi-episode, branch, missing price",
		l0Contract: "two tasks same session isolated; missing price keeps partial sum, ratio null",
		l0FixtureReady: true,
	},
] as const;

export function deliveryTaskCategory(id: DeliveryTaskCategoryId): DeliveryTaskCategorySpec {
	const found = DELIVERY_TASK_CATEGORIES.find(category => category.id === id);
	if (!found) throw new Error(`unknown_delivery_task_category:${id}`);
	return found;
}

/** Batch 1 explicitly cannot claim live paired cost wins. */
export const BATCH1_PAIRED_EVIDENCE_READY = false as const;
