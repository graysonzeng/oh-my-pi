import type { Usage } from "@oh-my-pi/pi-ai";

export interface BudgetSnapshot {
	limitUsd: number;
	/** Provider-reported total when known; `null` means unknown (never invent). */
	costUsd: number | null;
	costKnown: boolean;
	requests: number;
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	toolCalls: number;
	stageTimeMs: number;
	repairCycles: number;
	reviewerCycles: number;
}

export interface BudgetLimits {
	limitUsd?: number;
	maxRequests?: number;
	maxRepairCycles?: number;
	maxStageTimeMs?: number;
}

export interface ProfileBudgetGate {
	maxRequests?: number;
	maxCostUsd?: number;
	/** Requests already counted for this profile in the current workflow. */
	profileRequests: number;
	/** Known cost attributed to this profile (null if unknown). */
	profileCostUsd: number | null;
}

export class BudgetLedger {
	readonly #limitUsd: number;
	readonly #maxRequests: number;
	readonly #maxRepairCycles: number;
	readonly #maxStageTimeMs: number;
	#costUsd: number | null = 0;
	#costKnown = true;
	#requests = 0;
	#tokensIn = 0;
	#tokensOut = 0;
	#cacheRead = 0;
	#cacheWrite = 0;
	#toolCalls = 0;
	#stageTimeMs = 0;
	#repairCycles = 0;
	#reviewerCycles = 0;
	readonly #profileRequests = new Map<string, number>();
	readonly #profileCost = new Map<string, number | null>();

	constructor(limits: BudgetLimits | number = {}) {
		if (typeof limits === "number") {
			this.#limitUsd = limits;
			this.#maxRequests = Number.POSITIVE_INFINITY;
			this.#maxRepairCycles = Number.POSITIVE_INFINITY;
			this.#maxStageTimeMs = Number.POSITIVE_INFINITY;
		} else {
			this.#limitUsd = limits.limitUsd ?? 10;
			this.#maxRequests = limits.maxRequests ?? Number.POSITIVE_INFINITY;
			this.#maxRepairCycles = limits.maxRepairCycles ?? Number.POSITIVE_INFINITY;
			this.#maxStageTimeMs = limits.maxStageTimeMs ?? Number.POSITIVE_INFINITY;
		}
	}

	/** Pre-stage budget (requests/cost/time). Does not apply repair-cycle cap — repair has its own gate. */
	async checkPreStage(): Promise<boolean> {
		return this.#withinLimits({ includeRepairCap: false });
	}

	/** Before a repair attempt: includes maxRepairCycles. */
	async checkPreRepair(): Promise<boolean> {
		return this.#withinLimits({ includeRepairCap: true });
	}

	async checkPreRetry(): Promise<boolean> {
		return this.#withinLimits({ includeRepairCap: false });
	}

	#withinLimits(options: { includeRepairCap: boolean }): boolean {
		if (this.#requests >= this.#maxRequests) return false;
		if (options.includeRepairCap && this.#repairCycles >= this.#maxRepairCycles) return false;
		if (this.#stageTimeMs >= this.#maxStageTimeMs) return false;
		if (this.#costKnown && this.#costUsd !== null && this.#costUsd >= this.#limitUsd) return false;
		return true;
	}

	recordRequest(usage?: Usage | null, profileId?: string): void {
		this.#requests += 1;
		if (profileId) {
			this.#profileRequests.set(profileId, (this.#profileRequests.get(profileId) ?? 0) + 1);
		}
		if (!usage) return;
		this.#tokensIn += usage.input ?? 0;
		this.#tokensOut += usage.output ?? 0;
		this.#cacheRead += usage.cacheRead ?? 0;
		this.#cacheWrite += usage.cacheWrite ?? 0;
		const total = usage.cost?.total;
		if (total === undefined || total === null || Number.isNaN(total)) {
			// Never invent cost — mark unknown once any response lacks cost
			this.#costKnown = false;
			this.#costUsd = null;
			if (profileId) this.#profileCost.set(profileId, null);
		} else if (this.#costKnown && this.#costUsd !== null) {
			this.#costUsd += total;
			if (profileId) {
				const prev = this.#profileCost.get(profileId);
				if (prev === null) {
					// stay unknown
				} else {
					this.#profileCost.set(profileId, (prev ?? 0) + total);
				}
			}
		}
	}

	/** Hard-stop gate for a specific model profile before an external call. */
	checkProfileBudget(profileId: string, limits: { maxRequests?: number; maxCostUsd?: number }): boolean {
		const reqs = this.#profileRequests.get(profileId) ?? 0;
		if (limits.maxRequests !== undefined && reqs >= limits.maxRequests) return false;
		const cost = this.#profileCost.get(profileId);
		if (limits.maxCostUsd !== undefined && cost !== null && cost !== undefined && cost >= limits.maxCostUsd) {
			return false;
		}
		return true;
	}

	profileSnapshot(profileId: string): ProfileBudgetGate {
		return {
			profileRequests: this.#profileRequests.get(profileId) ?? 0,
			profileCostUsd: this.#profileCost.has(profileId) ? (this.#profileCost.get(profileId) ?? null) : 0,
		};
	}

	recordToolCalls(count = 1): void {
		this.#toolCalls += count;
	}

	recordStageTime(ms: number): void {
		this.#stageTimeMs += Math.max(0, ms);
	}

	recordRepairCycle(): void {
		this.#repairCycles += 1;
	}

	recordReviewerCycle(): void {
		this.#reviewerCycles += 1;
	}

	/** Restore counters from persisted snapshot (resume). */
	restore(snapshot: Partial<BudgetSnapshot>): void {
		if (snapshot.costUsd !== undefined) this.#costUsd = snapshot.costUsd;
		if (snapshot.costKnown !== undefined) this.#costKnown = snapshot.costKnown;
		if (snapshot.requests !== undefined) this.#requests = snapshot.requests;
		if (snapshot.tokensIn !== undefined) this.#tokensIn = snapshot.tokensIn;
		if (snapshot.tokensOut !== undefined) this.#tokensOut = snapshot.tokensOut;
		if (snapshot.cacheRead !== undefined) this.#cacheRead = snapshot.cacheRead;
		if (snapshot.cacheWrite !== undefined) this.#cacheWrite = snapshot.cacheWrite;
		if (snapshot.toolCalls !== undefined) this.#toolCalls = snapshot.toolCalls;
		if (snapshot.stageTimeMs !== undefined) this.#stageTimeMs = snapshot.stageTimeMs;
		if (snapshot.repairCycles !== undefined) this.#repairCycles = snapshot.repairCycles;
		if (snapshot.reviewerCycles !== undefined) this.#reviewerCycles = snapshot.reviewerCycles;
	}

	snapshot(): BudgetSnapshot {
		return {
			limitUsd: this.#limitUsd,
			costUsd: this.#costUsd,
			costKnown: this.#costKnown,
			requests: this.#requests,
			tokensIn: this.#tokensIn,
			tokensOut: this.#tokensOut,
			cacheRead: this.#cacheRead,
			cacheWrite: this.#cacheWrite,
			toolCalls: this.#toolCalls,
			stageTimeMs: this.#stageTimeMs,
			repairCycles: this.#repairCycles,
			reviewerCycles: this.#reviewerCycles,
		};
	}
}
