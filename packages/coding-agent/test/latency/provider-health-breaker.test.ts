import { describe, expect, it } from "bun:test";
import { PROVIDER_HEALTH_BREAKER_OPEN_TTL_MS, ProviderHealthBreaker } from "../../src/latency/provider-health-breaker";

describe("ProviderHealthBreaker", () => {
	it("opens after two consecutive retryable failures and skips until TTL", () => {
		let now = 1_000;
		const breaker = new ProviderHealthBreaker({ nowMs: () => now });
		breaker.recordFailure("p1", "timeout");
		expect(breaker.isOpen("p1")).toBe(false);
		breaker.recordFailure("p1", "rate_limit");
		expect(breaker.isOpen("p1")).toBe(true);
		now += PROVIDER_HEALTH_BREAKER_OPEN_TTL_MS - 1;
		expect(breaker.isOpen("p1")).toBe(true);
		now += 1;
		expect(breaker.isOpen("p1")).toBe(false);
	});

	it("closes on success and ignores non-retryable failures", () => {
		const breaker = new ProviderHealthBreaker({ nowMs: () => 0 });
		breaker.recordFailure("p1", "timeout");
		breaker.recordSuccess("p1");
		breaker.recordFailure("p1", "timeout");
		expect(breaker.isOpen("p1")).toBe(false);
		breaker.recordFailure("p1", "authentication");
		breaker.recordFailure("p1", "configuration");
		breaker.recordFailure("p1", "provider_permanent");
		expect(breaker.isOpen("p1")).toBe(false);
		breaker.recordFailure("p1", "provider_transient");
		expect(breaker.isOpen("p1")).toBe(true);
	});

	it("does not double-count shared_live of the same profile", () => {
		const breaker = new ProviderHealthBreaker({ nowMs: () => 0 });
		breaker.observeProfiles([
			{ profileId: "p1", status: "unavailable", source: "live", errorKind: "timeout", latencyMs: 12 },
			{ profileId: "p1", status: "unavailable", source: "shared_live", errorKind: "timeout", latencyMs: 12 },
		]);
		expect(breaker.isOpen("p1")).toBe(false);
		expect(breaker.snapshot("p1").consecutiveFailures).toBe(1);
	});

	it("records live-only snapshot samples, successRate, and p95 latency", () => {
		const breaker = new ProviderHealthBreaker({ nowMs: () => 0 });
		for (let i = 1; i <= 19; i++) {
			breaker.observeProfiles([
				{ profileId: "p1", status: "available", source: "live", latencyMs: i },
				{ profileId: "p2", status: "available", source: "shared_live", latencyMs: i },
			]);
		}
		breaker.observeProfiles([
			{ profileId: "p1", status: "unavailable", source: "live", errorKind: "timeout", latencyMs: 20 },
			{ profileId: "p2", status: "unavailable", source: "shared_live", errorKind: "timeout", latencyMs: 20 },
		]);
		const live = breaker.snapshot("p1");
		expect(live.sampleCount).toBe(20);
		expect(live.availableCount).toBe(19);
		expect(live.unavailableCount).toBe(1);
		expect(live.successRate).toBe(19 / 20);
		expect(live.p95LatencyMs).toBe(19);
		expect(live.open).toBe(false);
		const shared = breaker.snapshot("p2");
		expect(shared.sampleCount).toBe(0);
		expect(shared.successRate).toBeNull();
		expect(shared.p95LatencyMs).toBeNull();
		expect(shared.consecutiveFailures).toBe(1);
	});
});
