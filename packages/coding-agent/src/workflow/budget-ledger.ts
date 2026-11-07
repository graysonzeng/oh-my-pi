import type { Usage } from "@oh-my-pi/pi-ai";
import { BudgetExhaustedError } from "./errors";

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
	/**
	 * Invocation count. This is the unit compared with profile `maxRequests`.
	 * It is not the provider HTTP turn count.
	 */
	requests: number;
	/** Provider HTTP turns. Does not count toward `maxRequests`. */
	providerRequests: number;
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
	/** Persisted idempotency records. Resume uses these; do not drop them after a query. */
	charges?: BudgetChargeRecord[];
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

export type BudgetChargeUnit = "invocation" | "provider";

export interface BudgetCharge {
	/** `${workflowId}:${attemptId}:${invocationId}:${providerRequestId}` or an invocation key. */
	idempotencyKey: string;
	workflowId?: string;
	attemptId?: string;
	invocationId?: string;
	profileId?: string;
	/** invocation counts toward maxRequests. provider does not. */
	unit: BudgetChargeUnit;
	/** False for local prechecks that never launched a provider call. */
	launched: boolean;
	/** When false, count the unit but do not touch cost. */
	settlesCost: boolean;
	usage?: Usage | null;
}

export interface BudgetChargeRecord {
	key: string;
	unit: BudgetChargeUnit;
	workflowId?: string;
	attemptId?: string;
	invocationId?: string;
	profileId?: string;
	unknown: boolean;
	costUsd?: number;
	/** Known spend booked from an invocation aggregate. Not a per-turn cost. */
	aggregateUsd?: number;
	usageApplied: boolean;
}

export interface BudgetInvocationSettlement {
	attemptId: string;
	invocationId: string;
	profileId?: string;
	providerTurns: number;
	settled: boolean;
	costSettledBy: "provider" | "invocation" | "none";
}

export interface BudgetCallScope {
	workflowId: string;
	attemptId: string;
	invocationId: string;
	profileId: string;
	maxRequests?: number;
	maxCostUsd?: number;
}

export interface WorkflowBudgetGuard {
	/**
	 * New invocation (first launch, schema retry, gate retry): request cap and cost.
	 * Already-reserved invocation: cost only, so later turns and reminders are not a new stage.
	 */
	allowsModelCall(): boolean;
	/**
	 * Call from onPayload before the provider HTTP send.
	 * Throws BudgetExhaustedError without recording when the shared limit is already hit.
	 * Returns the idempotency key for settleProviderUsage.
	 */
	beforeProviderRequest(turn: { ordinal: number; providerRequestId?: string }): string;
	/** Idempotent. Upgrades an unknown launch to known cost; never adds the same key twice. */
	settleProviderUsage(input: { idempotencyKey: string; usage?: Usage | null; launched: boolean }): void;
	/**
	 * Settle one assistant response that already happened.
	 * Uses the onPayload ordinal key when present. Does not throw after the response landed.
	 * Missing cost leaves that turn unknown. Does not copy an invocation aggregate.
	 */
	settleProviderTurn(input: { ordinal: number; providerRequestId?: string; usage?: Usage | null }): void;
	/**
	 * Idempotent. First external launch already reserved the invocation.
	 * One provider turn upgrades that turn. Several turns book only the uncovered
	 * aggregate remainder and leave per-turn coverage unknown.
	 */
	finishInvocation(input: { usage?: Usage | null; launched: boolean; providerRequests?: number }): void;
}

export interface WorkflowBudgetPort {
	bind(scope: BudgetCallScope): WorkflowBudgetGuard;
	invocationSettlements(attemptId: string): readonly BudgetInvocationSettlement[];
}

interface ProfileCostState {
	knownLowerBoundUsd: number;
	unknownCount: number;
	/** null once any unknown cost was recorded for this profile. */
	totalUsd: number | null;
}

function usableCost(usage: Usage | null | undefined): number | undefined {
	const total = usage?.cost?.total;
	if (total === undefined || total === null || Number.isNaN(total)) return undefined;
	return total;
}

export function budgetChargeKey(parts: {
	workflowId: string;
	attemptId: string;
	invocationId: string;
	providerRequestId: string;
}): string {
	return `${parts.workflowId}:${parts.attemptId}:${parts.invocationId}:${parts.providerRequestId}`;
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
	#providerRequests = 0;
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
	readonly #charges = new Map<string, BudgetChargeRecord>();

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

	/** Drop run counters. Limits stay. Call before a new workflow on the same engine. */
	reset(): void {
		this.#costUsd = 0;
		this.#costKnown = true;
		this.#knownCostLowerBoundUsd = 0;
		this.#unknownCostRequestCount = 0;
		this.#requests = 0;
		this.#providerRequests = 0;
		this.#tokensIn = 0;
		this.#tokensOut = 0;
		this.#cacheRead = 0;
		this.#cacheWrite = 0;
		this.#toolCalls = 0;
		this.#stageTimeMs = 0;
		this.#repairCycles = 0;
		this.#reviewerCycles = 0;
		this.#profileRequests.clear();
		this.#profileCost.clear();
		this.#charges.clear();
	}

	/**
	 * Missing persisted budget is a coverage gap, not known zero.
	 * Does not invent a lower bound and does not clear one already restored.
	 */
	markUnrecordedCoverage(): void {
		this.#costKnown = false;
		this.#costUsd = null;
		if (this.#unknownCostRequestCount < 1) this.#unknownCostRequestCount = 1;
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

	canStartExternalCall(): boolean {
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
		this.#applyUsage(usage, profileId);
	}

	hasCharge(idempotencyKey: string): boolean {
		return this.#charges.has(idempotencyKey);
	}

	providerChargeKeys(invocationId: string, attemptId?: string): string[] {
		const keys: string[] = [];
		for (const charge of this.#charges.values()) {
			if (charge.invocationId !== invocationId || charge.unit !== "provider") continue;
			if (attemptId && charge.attemptId !== attemptId) continue;
			keys.push(charge.key);
		}
		return keys;
	}

	/**
	 * Idempotent charge. A repeated key does not increment counts.
	 * A later usable cost upgrades an unknown launch instead of adding a second request.
	 * `launched: false` records nothing.
	 */
	recordCharge(charge: BudgetCharge): void {
		if (!charge.launched) return;
		const existing = this.#charges.get(charge.idempotencyKey);
		const cost = charge.settlesCost ? usableCost(charge.usage) : undefined;
		if (existing) {
			const aggregateBooked =
				existing.unit === "provider" &&
				existing.invocationId !== undefined &&
				this.invocationHasAggregate(existing.invocationId, existing.attemptId);
			if (charge.settlesCost && cost !== undefined && !aggregateBooked) {
				if (existing.unknown) {
					this.#upgradeUnknown(existing, cost, charge.usage, charge.profileId ?? existing.profileId);
				} else if (existing.costUsd === undefined) {
					this.#addKnownCost(cost, charge.profileId ?? existing.profileId, existing);
				}
			}
			return;
		}
		const record: BudgetChargeRecord = {
			key: charge.idempotencyKey,
			unit: charge.unit,
			workflowId: charge.workflowId,
			attemptId: charge.attemptId,
			invocationId: charge.invocationId,
			profileId: charge.profileId,
			unknown: false,
			usageApplied: false,
		};
		this.#charges.set(charge.idempotencyKey, record);
		if (charge.unit === "invocation") {
			this.#requests += 1;
			if (charge.profileId) {
				this.#profileRequests.set(charge.profileId, (this.#profileRequests.get(charge.profileId) ?? 0) + 1);
			}
		} else {
			this.#providerRequests += 1;
		}
		if (!charge.settlesCost) return;
		this.#applyUsage(charge.usage, charge.profileId, record);
	}

	invocationSettlements(attemptId: string): BudgetInvocationSettlement[] {
		const byInvocation = new Map<string, BudgetInvocationSettlement>();
		for (const charge of this.#charges.values()) {
			if (charge.attemptId !== attemptId || !charge.invocationId) continue;
			const current = byInvocation.get(charge.invocationId) ?? {
				attemptId,
				invocationId: charge.invocationId,
				profileId: charge.profileId,
				providerTurns: 0,
				settled: false,
				costSettledBy: "none" as const,
			};
			if (charge.profileId) current.profileId = charge.profileId;
			if (charge.unit === "provider") current.providerTurns += 1;
			if (charge.unit === "invocation") current.settled = true;
			if (charge.costUsd !== undefined) {
				current.costSettledBy = charge.unit === "provider" ? "provider" : "invocation";
			}
			current.settled = true;
			byInvocation.set(charge.invocationId, current);
		}
		return [...byInvocation.values()];
	}

	#applyUsage(usage: Usage | null | undefined, profileId: string | undefined, record?: BudgetChargeRecord): void {
		if (!usage) {
			this.#markUnknown(profileId, record);
			return;
		}
		if (record) record.usageApplied = true;
		this.#tokensIn += usage.input ?? 0;
		this.#tokensOut += usage.output ?? 0;
		this.#cacheRead += usage.cacheRead ?? 0;
		this.#cacheWrite += usage.cacheWrite ?? 0;
		const total = usableCost(usage);
		if (total === undefined) {
			this.#markUnknown(profileId, record);
			return;
		}
		this.#addKnownCost(total, profileId, record);
	}

	#markUnknown(profileId: string | undefined, record?: BudgetChargeRecord): void {
		this.#costKnown = false;
		this.#costUsd = null;
		this.#unknownCostRequestCount += 1;
		if (record) record.unknown = true;
		if (profileId) {
			const state = this.#profileState(profileId);
			state.unknownCount += 1;
			state.totalUsd = null;
		}
	}

	#addKnownCost(total: number, profileId: string | undefined, record?: BudgetChargeRecord): void {
		this.#knownCostLowerBoundUsd += total;
		if (this.#costKnown) this.#costUsd = this.#knownCostLowerBoundUsd;
		else this.#costUsd = null;
		if (record) {
			record.unknown = false;
			record.costUsd = total;
		}
		if (profileId) {
			const state = this.#profileState(profileId);
			state.knownLowerBoundUsd += total;
			if (state.totalUsd !== null) state.totalUsd = state.knownLowerBoundUsd;
		}
	}

	#upgradeUnknown(
		record: BudgetChargeRecord,
		total: number,
		usage: Usage | null | undefined,
		profileId: string | undefined,
	): void {
		if (!record.usageApplied && usage) {
			record.usageApplied = true;
			this.#tokensIn += usage.input ?? 0;
			this.#tokensOut += usage.output ?? 0;
			this.#cacheRead += usage.cacheRead ?? 0;
			this.#cacheWrite += usage.cacheWrite ?? 0;
		}
		this.#unknownCostRequestCount = Math.max(0, this.#unknownCostRequestCount - 1);
		if (profileId) {
			const state = this.#profileState(profileId);
			state.unknownCount = Math.max(0, state.unknownCount - 1);
		}
		record.unknown = false;
		const stillUnknown =
			this.#unknownCostRequestCount > 0 ||
			[...this.#charges.values()].some(charge => charge.unknown && charge.key !== record.key);
		if (!stillUnknown) this.#costKnown = true;
		this.#addKnownCost(total, profileId, record);
	}

	/** Hard-stop gate for a specific model profile before an external call. */
	checkProfileBudget(profileId: string, limits: { maxRequests?: number; maxCostUsd?: number }): boolean {
		const reqs = this.#profileRequests.get(profileId) ?? 0;
		if (limits.maxRequests !== undefined && reqs >= limits.maxRequests) return false;
		const state = this.#profileCost.get(profileId);
		const knownLower = state?.knownLowerBoundUsd ?? 0;
		if (limits.maxCostUsd !== undefined && knownLower >= limits.maxCostUsd) return false;
		return true;
	}

	assertCanInvoke(profileId: string, limits?: { maxRequests?: number; maxCostUsd?: number }): void {
		if (!this.canStartExternalCall()) {
			const snap = this.snapshot();
			throw new BudgetExhaustedError(snap.requests, snap.costUsd ?? "unknown", snap.limitUsd);
		}
		if (limits && !this.checkProfileBudget(profileId, limits)) {
			const profile = this.profileSnapshot(profileId);
			throw new BudgetExhaustedError(
				profile.profileRequests,
				profile.profileCostUsd ?? "unknown",
				limits.maxCostUsd ?? limits.maxRequests ?? 0,
			);
		}
	}

	assertCanSpendProvider(profileId: string, limits?: { maxCostUsd?: number }): void {
		if (!this.canSpendProvider(profileId, limits)) {
			const snap = this.snapshot();
			const limit = limits?.maxCostUsd ?? snap.limitUsd;
			throw new BudgetExhaustedError(snap.providerRequests, snap.costUsd ?? "unknown", limit);
		}
	}

	/** Cost and profile cap only. Does not apply maxRequests. */
	canSpendProvider(profileId: string, limits?: { maxCostUsd?: number }): boolean {
		if (this.#knownCostLowerBoundUsd >= this.#limitUsd) return false;
		if (limits?.maxCostUsd !== undefined && !this.checkProfileBudget(profileId, { maxCostUsd: limits.maxCostUsd })) {
			return false;
		}
		return true;
	}

	providerSettledCost(invocationId: string, attemptId?: string): number {
		let sum = 0;
		for (const charge of this.#charges.values()) {
			if (charge.unit !== "provider" || charge.invocationId !== invocationId) continue;
			if (attemptId && charge.attemptId !== attemptId) continue;
			if (charge.costUsd !== undefined) sum += charge.costUsd;
		}
		return sum;
	}

	invocationHasAggregate(invocationId: string, attemptId?: string): boolean {
		for (const charge of this.#charges.values()) {
			if (charge.unit !== "invocation" || charge.invocationId !== invocationId) continue;
			if (attemptId && charge.attemptId !== attemptId) continue;
			if (charge.aggregateUsd !== undefined) return true;
		}
		return false;
	}

	/** Add only the new aggregate dollars. Does not clear per-turn unknown coverage. */
	bookInvocationAggregate(invocationKey: string, amount: number): void {
		const record = this.#charges.get(invocationKey);
		if (!record || !(amount > 0)) return;
		const previous = record.aggregateUsd ?? 0;
		if (amount <= previous) return;
		record.aggregateUsd = amount;
		this.#addKnownCost(amount - previous, record.profileId);
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

	/** Restore counters from persisted snapshot (resume). Does not clear fields the caller omitted except charges when provided. */
	restore(snapshot: Partial<BudgetSnapshot>): void {
		if (snapshot.costKnown === false) {
			this.#costKnown = false;
			this.#costUsd = null;
		} else {
			if (snapshot.costUsd !== undefined) this.#costUsd = snapshot.costUsd;
			if (snapshot.costKnown !== undefined) this.#costKnown = snapshot.costKnown;
		}
		if (snapshot.knownCostLowerBoundUsd !== undefined) {
			this.#knownCostLowerBoundUsd = snapshot.knownCostLowerBoundUsd;
		} else if (snapshot.costKnown === true && typeof snapshot.costUsd === "number") {
			this.#knownCostLowerBoundUsd = snapshot.costUsd;
		} else if (snapshot.costKnown === false) {
			this.#knownCostLowerBoundUsd = 0;
		}
		if (snapshot.unknownCostRequestCount !== undefined) {
			this.#unknownCostRequestCount = snapshot.unknownCostRequestCount;
		} else if (snapshot.costKnown === false) {
			this.#unknownCostRequestCount = Math.max(1, this.#unknownCostRequestCount);
		}
		if (snapshot.requests !== undefined) this.#requests = snapshot.requests;
		if (snapshot.providerRequests !== undefined) this.#providerRequests = snapshot.providerRequests;
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
				const totalUsd = snapshot.costKnown === false && profile.costUsd === 0 ? null : profile.costUsd;
				this.#profileCost.set(profile.profileId, {
					knownLowerBoundUsd: knownLower,
					unknownCount,
					totalUsd: profile.costUsd === null ? null : totalUsd,
				});
			}
		}
		if (snapshot.charges) {
			this.#charges.clear();
			for (const charge of snapshot.charges) {
				this.#charges.set(charge.key, { ...charge });
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
			providerRequests: this.#providerRequests,
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
			charges: [...this.#charges.values()].map(charge => ({ ...charge })),
		};
	}
}

export function createWorkflowBudgetPort(ledger: BudgetLedger): WorkflowBudgetPort {
	return {
		bind(scope: BudgetCallScope): WorkflowBudgetGuard {
			const ordinalKeys = new Map<number, string>();
			return {
				allowsModelCall(): boolean {
					const invocationKey = budgetChargeKey({
						workflowId: scope.workflowId,
						attemptId: scope.attemptId,
						invocationId: scope.invocationId,
						providerRequestId: "invocation",
					});
					if (ledger.hasCharge(invocationKey)) {
						return ledger.canSpendProvider(scope.profileId, { maxCostUsd: scope.maxCostUsd });
					}
					if (!ledger.canStartExternalCall()) return false;
					return ledger.checkProfileBudget(scope.profileId, {
						maxRequests: scope.maxRequests,
						maxCostUsd: scope.maxCostUsd,
					});
				},
				beforeProviderRequest(turn): string {
					const invocationKey = budgetChargeKey({
						workflowId: scope.workflowId,
						attemptId: scope.attemptId,
						invocationId: scope.invocationId,
						providerRequestId: "invocation",
					});
					if (!ledger.hasCharge(invocationKey)) {
						ledger.assertCanInvoke(scope.profileId, {
							maxRequests: scope.maxRequests,
							maxCostUsd: scope.maxCostUsd,
						});
						ledger.recordCharge({
							idempotencyKey: invocationKey,
							workflowId: scope.workflowId,
							attemptId: scope.attemptId,
							invocationId: scope.invocationId,
							profileId: scope.profileId,
							unit: "invocation",
							launched: true,
							settlesCost: false,
						});
					} else {
						ledger.assertCanSpendProvider(scope.profileId, { maxCostUsd: scope.maxCostUsd });
					}
					const providerRequestId = turn.providerRequestId?.trim() || `ord:${turn.ordinal}`;
					const key = budgetChargeKey({
						workflowId: scope.workflowId,
						attemptId: scope.attemptId,
						invocationId: scope.invocationId,
						providerRequestId,
					});
					if (ledger.hasCharge(key)) return key;
					ledger.recordCharge({
						idempotencyKey: key,
						workflowId: scope.workflowId,
						attemptId: scope.attemptId,
						invocationId: scope.invocationId,
						profileId: scope.profileId,
						unit: "provider",
						// Handed to the provider hook. Not a network acknowledgement.
						launched: true,
						settlesCost: true,
						usage: null,
					});
					return key;
				},
				settleProviderUsage(input): void {
					ledger.recordCharge({
						idempotencyKey: input.idempotencyKey,
						workflowId: scope.workflowId,
						attemptId: scope.attemptId,
						invocationId: scope.invocationId,
						profileId: scope.profileId,
						unit: "provider",
						launched: input.launched,
						settlesCost: true,
						usage: input.usage,
					});
				},
				settleProviderTurn(input): void {
					const invocationKey = budgetChargeKey({
						workflowId: scope.workflowId,
						attemptId: scope.attemptId,
						invocationId: scope.invocationId,
						providerRequestId: "invocation",
					});
					if (!ledger.hasCharge(invocationKey)) {
						ledger.recordCharge({
							idempotencyKey: invocationKey,
							workflowId: scope.workflowId,
							attemptId: scope.attemptId,
							invocationId: scope.invocationId,
							profileId: scope.profileId,
							unit: "invocation",
							launched: true,
							settlesCost: false,
						});
					}
					const providerRequestId = input.providerRequestId?.trim() || `ord:${input.ordinal}`;
					const key = budgetChargeKey({
						workflowId: scope.workflowId,
						attemptId: scope.attemptId,
						invocationId: scope.invocationId,
						providerRequestId,
					});
					ordinalKeys.set(input.ordinal, key);
					ledger.recordCharge({
						idempotencyKey: key,
						workflowId: scope.workflowId,
						attemptId: scope.attemptId,
						invocationId: scope.invocationId,
						profileId: scope.profileId,
						unit: "provider",
						launched: true,
						settlesCost: true,
						usage: input.usage ?? null,
					});
				},
				finishInvocation(input): void {
					const invocationKey = budgetChargeKey({
						workflowId: scope.workflowId,
						attemptId: scope.attemptId,
						invocationId: scope.invocationId,
						providerRequestId: "invocation",
					});
					const providerKeys = ledger.providerChargeKeys(scope.invocationId, scope.attemptId);
					const handedOff = ledger.hasCharge(invocationKey) || providerKeys.length > 0;
					const observed = input.launched || handedOff || (input.providerRequests ?? 0) > 0;
					if (!observed) return;
					const observedCost = usableCost(input.usage);
					if (!ledger.hasCharge(invocationKey)) {
						const settleOnInvocation = providerKeys.length === 0 && observedCost !== undefined;
						ledger.recordCharge({
							idempotencyKey: invocationKey,
							workflowId: scope.workflowId,
							attemptId: scope.attemptId,
							invocationId: scope.invocationId,
							profileId: scope.profileId,
							unit: "invocation",
							launched: true,
							settlesCost: settleOnInvocation || providerKeys.length === 0,
							usage: settleOnInvocation ? input.usage : null,
						});
					}
					const soleProviderKey = providerKeys.length === 1 ? providerKeys[0] : undefined;
					if (soleProviderKey && observedCost !== undefined) {
						ledger.recordCharge({
							idempotencyKey: soleProviderKey,
							workflowId: scope.workflowId,
							attemptId: scope.attemptId,
							invocationId: scope.invocationId,
							profileId: scope.profileId,
							unit: "provider",
							launched: true,
							settlesCost: true,
							usage: input.usage,
						});
					} else if (providerKeys.length > 1 && observedCost !== undefined) {
						const residual = observedCost - ledger.providerSettledCost(scope.invocationId, scope.attemptId);
						if (residual > 0) ledger.bookInvocationAggregate(invocationKey, residual);
					} else if (!soleProviderKey && providerKeys.length === 0 && observedCost !== undefined) {
						ledger.recordCharge({
							idempotencyKey: invocationKey,
							workflowId: scope.workflowId,
							attemptId: scope.attemptId,
							invocationId: scope.invocationId,
							profileId: scope.profileId,
							unit: "invocation",
							launched: true,
							settlesCost: true,
							usage: input.usage,
						});
					}
				},
			};
		},
		invocationSettlements(attemptId: string): readonly BudgetInvocationSettlement[] {
			return ledger.invocationSettlements(attemptId);
		},
	};
}

/** Alias a provisional ordinal key onto the provider request id without a second charge. */
export function aliasBudgetCharge(ledger: BudgetLedger, fromKey: string, toKey: string): void {
	if (fromKey === toKey || ledger.hasCharge(toKey) || !ledger.hasCharge(fromKey)) return;
	const snapshot = ledger.snapshot();
	const charges = snapshot.charges ?? [];
	const from = charges.find(charge => charge.key === fromKey);
	if (!from) return;
	ledger.restore({
		...snapshot,
		charges: charges.map(charge => (charge.key === fromKey ? { ...charge, key: toKey } : charge)),
	});
}
