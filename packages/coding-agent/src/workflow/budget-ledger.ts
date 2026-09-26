import type { Usage } from "@oh-my-pi/pi-ai";

export interface BudgetSnapshot {
	limitUsd: number;
	/**
	 * Fully known total when every recorded request had cost; `null` when any
	 * coverage gap exists. Never invent a zero total from unknown coverage.
	 */
	costUsd: number | null;
	costKnown: boolean;
	/** Cumulative known cost lower bound — keeps accumulating after unknowns. */
	knownCostLowerBoundUsd: number;
	/** Count of external requests that lacked a usable cost total. */
	unknownCostRequestCount: number;
	requests: number;
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	toolCalls: number;
	stageTimeMs: number;
	repairCycles: number;
	reviewerCycles: number;
	profiles: Array<{
		profileId: string;
		requests: number;
		/** Fully known profile total, or null if this profile has a coverage gap. */
		costUsd: number | null;
		/** Known lower bound for this profile (independent of other profiles). */
		knownCostLowerBoundUsd: number;
		unknownCostRequestCount: number;
	}>;
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
	/** Fully known cost attributed to this profile (null if unknown). */
	profileCostUsd: number | null;
	/** Known lower bound for this profile. */
	profileKnownCostLowerBoundUsd: number;
}

interface ProfileCostState {
	knownLowerBoundUsd: number;
	unknownCount: number;
	/** null once any unknown cost was recorded for this profile. */
	totalUsd: number | null;
}

export class BudgetLedger {
	readonly #limitUsd: number;
	readonly #maxRequests: number;
	readonly #maxRepairCycles: number;
	readonly #maxStageTimeMs: number;
	#costUsd: number | null = 0;
	#costKnown = true;
	#knownCostLowerBoundUsd = 0;
	#unknownCostRequestCount = 0;
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
	readonly #profileCost = new Map<string, ProfileCostState>();

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
		// Known lower bound stops the next external call even when total is unknown.
		if (this.#knownCostLowerBoundUsd >= this.#limitUsd) return false;
		return true;
	}

	#profileState(profileId: string): ProfileCostState {
		const existing = this.#profileCost.get(profileId);
		if (existing) return existing;
		const created: ProfileCostState = { knownLowerBoundUsd: 0, unknownCount: 0, totalUsd: 0 };
		this.#profileCost.set(profileId, created);
		return created;
	}

	recordRequest(usage?: Usage | null, profileId?: string): void {
		this.#requests += 1;
		if (profileId) {
			this.#profileRequests.set(profileId, (this.#profileRequests.get(profileId) ?? 0) + 1);
		}
		if (!usage) {
			// Missing usage on a counted external request is a coverage gap.
			this.#costKnown = false;
			this.#costUsd = null;
			this.#unknownCostRequestCount += 1;
			if (profileId) {
				const state = this.#profileState(profileId);
				state.unknownCount += 1;
				state.totalUsd = null;
			}
			return;
		}
		this.#tokensIn += usage.input ?? 0;
		this.#tokensOut += usage.output ?? 0;
		this.#cacheRead += usage.cacheRead ?? 0;
		this.#cacheWrite += usage.cacheWrite ?? 0;
		const total = usage.cost?.total;
		if (total === undefined || total === null || Number.isNaN(total)) {
			// Never invent cost — mark unknown, keep known lower bound.
			this.#costKnown = false;
			this.#costUsd = null;
			this.#unknownCostRequestCount += 1;
			if (profileId) {
				const state = this.#profileState(profileId);
				state.unknownCount += 1;
				state.totalUsd = null;
			}
			return;
		}
		// Always accumulate the known lower bound, including after prior unknowns.
		this.#knownCostLowerBoundUsd += total;
		if (this.#costKnown) {
			this.#costUsd = this.#knownCostLowerBoundUsd;
		} else {
			this.#costUsd = null;
		}
		if (profileId) {
			const state = this.#profileState(profileId);
			state.knownLowerBoundUsd += total;
			if (state.totalUsd !== null) {
				state.totalUsd = state.knownLowerBoundUsd;
			}
		}
	}

	/** Hard-stop gate for a specific model profile before an external call. */
	checkProfileBudget(profileId: string, limits: { maxRequests?: number; maxCostUsd?: number }): boolean {
		const reqs = this.#profileRequests.get(profileId) ?? 0;
		if (limits.maxRequests !== undefined && reqs >= limits.maxRequests) return false;
		const state = this.#profileCost.get(profileId);
		const knownLower = state?.knownLowerBoundUsd ?? 0;
		if (limits.maxCostUsd !== undefined && knownLower >= limits.maxCostUsd) {
			return false;
		}
		return true;
	}

	profileSnapshot(profileId: string): ProfileBudgetGate {
		const state = this.#profileCost.get(profileId);
		return {
			profileRequests: this.#profileRequests.get(profileId) ?? 0,
			profileCostUsd: state ? state.totalUsd : 0,
			profileKnownCostLowerBoundUsd: state?.knownLowerBoundUsd ?? 0,
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
		if (snapshot.knownCostLowerBoundUsd !== undefined) {
			this.#knownCostLowerBoundUsd = snapshot.knownCostLowerBoundUsd;
		} else if (snapshot.costKnown === true && typeof snapshot.costUsd === "number") {
			// Legacy snapshot without lower-bound field: known total is the bound.
			this.#knownCostLowerBoundUsd = snapshot.costUsd;
		} else if (snapshot.costKnown === false) {
			// Unknown total cannot be reconstructed — keep bound at 0 unless provided.
			this.#knownCostLowerBoundUsd = 0;
		}
		if (snapshot.unknownCostRequestCount !== undefined) {
			this.#unknownCostRequestCount = snapshot.unknownCostRequestCount;
		} else if (snapshot.costKnown === false) {
			this.#unknownCostRequestCount = Math.max(1, this.#unknownCostRequestCount);
		}
		if (snapshot.requests !== undefined) this.#requests = snapshot.requests;
		if (snapshot.tokensIn !== undefined) this.#tokensIn = snapshot.tokensIn;
		if (snapshot.tokensOut !== undefined) this.#tokensOut = snapshot.tokensOut;
		if (snapshot.cacheRead !== undefined) this.#cacheRead = snapshot.cacheRead;
		if (snapshot.cacheWrite !== undefined) this.#cacheWrite = snapshot.cacheWrite;
		if (snapshot.toolCalls !== undefined) this.#toolCalls = snapshot.toolCalls;
		if (snapshot.stageTimeMs !== undefined) this.#stageTimeMs = snapshot.stageTimeMs;
		if (snapshot.repairCycles !== undefined) this.#repairCycles = snapshot.repairCycles;
		if (snapshot.reviewerCycles !== undefined) this.#reviewerCycles = snapshot.reviewerCycles;
		if (snapshot.profiles) {
			this.#profileRequests.clear();
			this.#profileCost.clear();
			for (const profile of snapshot.profiles) {
				this.#profileRequests.set(profile.profileId, profile.requests);
				const knownLower =
					profile.knownCostLowerBoundUsd !== undefined
						? profile.knownCostLowerBoundUsd
						: profile.costUsd !== null && profile.costUsd !== undefined
							? profile.costUsd
							: 0;
				const unknownCount =
					profile.unknownCostRequestCount !== undefined
						? profile.unknownCostRequestCount
						: profile.costUsd === null
							? 1
							: 0;
				this.#profileCost.set(profile.profileId, {
					knownLowerBoundUsd: knownLower,
					unknownCount,
					totalUsd: profile.costUsd,
				});
			}
		}
	}

	snapshot(): BudgetSnapshot {
		return {
			limitUsd: this.#limitUsd,
			costUsd: this.#costUsd,
			costKnown: this.#costKnown,
			knownCostLowerBoundUsd: this.#knownCostLowerBoundUsd,
			unknownCostRequestCount: this.#unknownCostRequestCount,
			requests: this.#requests,
			tokensIn: this.#tokensIn,
			tokensOut: this.#tokensOut,
			cacheRead: this.#cacheRead,
			cacheWrite: this.#cacheWrite,
			toolCalls: this.#toolCalls,
			stageTimeMs: this.#stageTimeMs,
			repairCycles: this.#repairCycles,
			reviewerCycles: this.#reviewerCycles,
			profiles: [...this.#profileRequests.entries()].map(([profileId, requests]) => {
				const state = this.#profileCost.get(profileId);
				return {
					profileId,
					requests,
					costUsd: state ? state.totalUsd : 0,
					knownCostLowerBoundUsd: state?.knownLowerBoundUsd ?? 0,
					unknownCostRequestCount: state?.unknownCount ?? 0,
				};
			}),
		};
	}
}
