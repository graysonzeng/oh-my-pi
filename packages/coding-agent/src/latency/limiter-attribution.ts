/**
 * D8 rate-limit ownership attribution.
 *
 * Observes existing limiter occupancy. Does not create a unified semaphore
 * and must not collapse provider / task / job waits into one lock.
 */
export const LIMITER_OWNERS = ["provider_request", "task_concurrency", "async_job_capacity"] as const;
export type LimiterOwner = (typeof LIMITER_OWNERS)[number];

export interface LimiterOccupancySnapshot {
	owner: LimiterOwner;
	inFlight: number;
	/** `<= 0` or `Infinity` means unlimited (never blocking). */
	capacity: number;
	queued?: number;
}

export interface LimiterWaitRecord {
	owner: LimiterOwner;
	waitMs: number;
}

export interface LimiterOwnerAttribution {
	waitMs: number;
	waitCount: number;
	blocking: boolean;
	inFlight: number;
	capacity: number;
	queued: number;
}

export interface LimiterAttributionReport {
	v: 1;
	/** Always false — this helper never merges the three locks. */
	unifiedSemaphore: false;
	byOwner: Record<LimiterOwner, LimiterOwnerAttribution>;
	blockingOwners: LimiterOwner[];
}

const EMPTY_OWNER: LimiterOwnerAttribution = {
	waitMs: 0,
	waitCount: 0,
	blocking: false,
	inFlight: 0,
	capacity: 0,
	queued: 0,
};

export function isLimiterOwner(value: string): value is LimiterOwner {
	return (LIMITER_OWNERS as readonly string[]).includes(value);
}

function emptyByOwner(): Record<LimiterOwner, LimiterOwnerAttribution> {
	return {
		provider_request: { ...EMPTY_OWNER },
		task_concurrency: { ...EMPTY_OWNER },
		async_job_capacity: { ...EMPTY_OWNER },
	};
}

function isUnlimited(capacity: number): boolean {
	return !Number.isFinite(capacity) || capacity <= 0;
}

function occupancyBlocking(snapshot: LimiterOccupancySnapshot): boolean {
	if (isUnlimited(snapshot.capacity)) return false;
	const inFlight = Math.max(0, snapshot.inFlight);
	const queued = Math.max(0, snapshot.queued ?? 0);
	return inFlight >= snapshot.capacity || queued > 0;
}

/**
 * Attribute occupancy + wait samples to the three existing limiter owners.
 * Duplicate occupancy for the same owner is last-write (not summed) so a
 * caller cannot smuggle a merged counter through repeated rows.
 */
export function attributeLimiterState(
	occupancies: readonly LimiterOccupancySnapshot[],
	waits: readonly LimiterWaitRecord[] = [],
): LimiterAttributionReport {
	const byOwner = emptyByOwner();
	for (const snapshot of occupancies) {
		if (!isLimiterOwner(snapshot.owner)) continue;
		byOwner[snapshot.owner] = {
			...byOwner[snapshot.owner],
			inFlight: Math.max(0, snapshot.inFlight),
			capacity: snapshot.capacity,
			queued: Math.max(0, snapshot.queued ?? 0),
			blocking: occupancyBlocking(snapshot),
		};
	}
	for (const wait of waits) {
		if (!isLimiterOwner(wait.owner)) continue;
		const current = byOwner[wait.owner];
		byOwner[wait.owner] = {
			...current,
			waitMs: current.waitMs + Math.max(0, wait.waitMs),
			waitCount: current.waitCount + 1,
		};
	}
	const blockingOwners = LIMITER_OWNERS.filter(owner => byOwner[owner].blocking);
	return {
		v: 1,
		unifiedSemaphore: false,
		byOwner,
		blockingOwners,
	};
}

export function formatLimiterAttribution(
	report: LimiterAttributionReport,
	options?: { unknownOwners?: readonly LimiterOwner[] },
): string {
	const unknown = new Set(options?.unknownOwners ?? []);
	const lines = [
		"limiter attribution (D8)",
		`unifiedSemaphore=${report.unifiedSemaphore}`,
		`blocking=${report.blockingOwners.filter(o => !unknown.has(o)).join(",") || "none"}`,
	];
	for (const owner of LIMITER_OWNERS) {
		if (unknown.has(owner)) {
			lines.push(`  ${owner}: unknown_occupancy (no sample — not idle)`);
			continue;
		}
		const row = report.byOwner[owner];
		lines.push(
			`  ${owner}: blocking=${row.blocking} inFlight=${row.inFlight} capacity=${row.capacity} queued=${row.queued} waitMs=${row.waitMs} waitCount=${row.waitCount}`,
		);
	}
	return lines.join("\n");
}
