/**
 * Process-local provider-health circuit breaker (latency arm `provider_health_breaker`).
 * Engine-scoped, keyed by workflow profile id. Fail-open when the arm is off
 * (callers simply omit this object from availability preflight).
 *
 * Trip is conservative: two consecutive retryable failures (`rate_limit`,
 * `timeout`, `provider_transient`) open the profile for 60s. Observational
 * snapshot (success rate, p95 latency) is a separate 20-sample live-probe
 * window and never invents TTFT.
 */

export const PROVIDER_HEALTH_BREAKER_ARM = "provider_health_breaker" as const;
export const PROVIDER_HEALTH_BREAKER_FAILURE_THRESHOLD = 2;
export const PROVIDER_HEALTH_BREAKER_OPEN_TTL_MS = 60_000;
export const PROVIDER_HEALTH_SAMPLE_WINDOW = 20;
export const PROVIDER_HEALTH_BREAKER_ERROR_SUMMARY = "provider health breaker open";

export const PROVIDER_HEALTH_RETRYABLE_ERROR_KINDS = ["rate_limit", "timeout", "provider_transient"] as const;
export type ProviderHealthRetryableErrorKind = (typeof PROVIDER_HEALTH_RETRYABLE_ERROR_KINDS)[number];

const RETRYABLE_KINDS: ReadonlySet<string> = new Set(PROVIDER_HEALTH_RETRYABLE_ERROR_KINDS);

export interface ProviderHealthObservation {
	profileId: string;
	status: string;
	source?: string;
	errorKind?: string;
	latencyMs?: number;
}

export interface ProviderHealthSample {
	status: string;
	errorKind?: string;
	latencyMs?: number;
}

export interface ProviderHealthSnapshot {
	profileId: string;
	open: boolean;
	consecutiveFailures: number;
	sampleCount: number;
	availableCount: number;
	unavailableCount: number;
	indeterminateCount: number;
	successRate: number | null;
	p95LatencyMs: number | null;
}

interface BreakerEntry {
	consecutiveFailures: number;
	openUntilMs: number | null;
}

export function isProviderHealthRetryableErrorKind(kind: string | undefined): kind is ProviderHealthRetryableErrorKind {
	return kind !== undefined && RETRYABLE_KINDS.has(kind);
}

function percentile95(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil(0.95 * sorted.length);
	return sorted[Math.max(0, rank - 1)]!;
}

export class ProviderHealthBreaker {
	readonly #nowMs: () => number;
	readonly #threshold: number;
	readonly #ttlMs: number;
	readonly #window: number;
	readonly #entries = new Map<string, BreakerEntry>();
	readonly #samples = new Map<string, ProviderHealthSample[]>();

	constructor(
		options: {
			nowMs?: () => number;
			failureThreshold?: number;
			openTtlMs?: number;
			sampleWindow?: number;
		} = {},
	) {
		this.#nowMs = options.nowMs ?? Date.now;
		this.#threshold = options.failureThreshold ?? PROVIDER_HEALTH_BREAKER_FAILURE_THRESHOLD;
		this.#ttlMs = options.openTtlMs ?? PROVIDER_HEALTH_BREAKER_OPEN_TTL_MS;
		this.#window = options.sampleWindow ?? PROVIDER_HEALTH_SAMPLE_WINDOW;
	}

	/** True while the profile is inside the open TTL. Expired entries are dropped. */
	isOpen(profileId: string): boolean {
		const entry = this.#expireIfNeeded(profileId);
		return entry?.openUntilMs !== null && entry?.openUntilMs !== undefined;
	}

	recordSuccess(profileId: string): void {
		this.#entries.delete(profileId);
	}

	recordFailure(profileId: string, errorKind: string): void {
		if (!isProviderHealthRetryableErrorKind(errorKind)) return;
		if (this.isOpen(profileId)) return;
		const entry = this.#entries.get(profileId) ?? { consecutiveFailures: 0, openUntilMs: null };
		entry.consecutiveFailures += 1;
		if (entry.consecutiveFailures >= this.#threshold) {
			entry.openUntilMs = this.#nowMs() + this.#ttlMs;
		}
		this.#entries.set(profileId, entry);
	}

	/**
	 * Record at most one outcome per profile id from a preflight report.
	 * Consecutive trips use live + shared_live rows (deduped by profile).
	 * Snapshot samples use physical `live` rows only so shared expansion cannot
	 * double-count a single probe.
	 */
	observeProfiles(rows: readonly ProviderHealthObservation[]): void {
		const seen = new Set<string>();
		for (const row of rows) {
			if (seen.has(row.profileId)) continue;
			if (row.source !== "live" && row.source !== "shared_live") continue;
			seen.add(row.profileId);
			if (row.source === "live") this.#pushSample(row.profileId, row);
			if (row.status === "available") {
				this.recordSuccess(row.profileId);
				continue;
			}
			if (row.errorKind) this.recordFailure(row.profileId, row.errorKind);
		}
	}

	snapshot(profileId: string): ProviderHealthSnapshot {
		this.#expireIfNeeded(profileId);
		const entry = this.#entries.get(profileId);
		const samples = this.#samples.get(profileId) ?? [];
		const availableCount = samples.filter(sample => sample.status === "available").length;
		const unavailableCount = samples.filter(sample => sample.status === "unavailable").length;
		const indeterminateCount = samples.filter(sample => sample.status === "indeterminate").length;
		const latencies = samples
			.map(sample => sample.latencyMs)
			.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
		return {
			profileId,
			open: entry?.openUntilMs !== null && entry?.openUntilMs !== undefined,
			consecutiveFailures: entry?.consecutiveFailures ?? 0,
			sampleCount: samples.length,
			availableCount,
			unavailableCount,
			indeterminateCount,
			successRate: samples.length === 0 ? null : availableCount / samples.length,
			p95LatencyMs: percentile95(latencies),
		};
	}

	#pushSample(profileId: string, row: ProviderHealthObservation): void {
		const sample: ProviderHealthSample = { status: row.status };
		if (row.errorKind) sample.errorKind = row.errorKind;
		if (row.latencyMs !== undefined) sample.latencyMs = row.latencyMs;
		const list = this.#samples.get(profileId) ?? [];
		list.push(sample);
		if (list.length > this.#window) list.shift();
		this.#samples.set(profileId, list);
	}

	#expireIfNeeded(profileId: string): BreakerEntry | undefined {
		const entry = this.#entries.get(profileId);
		if (!entry) return undefined;
		if (entry.openUntilMs !== null && this.#nowMs() >= entry.openUntilMs) {
			this.#entries.delete(profileId);
			return undefined;
		}
		return entry;
	}
}
