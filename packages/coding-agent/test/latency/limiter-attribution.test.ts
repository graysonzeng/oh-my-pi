import { describe, expect, it } from "bun:test";
import { attributeLimiterState, formatLimiterAttribution, isLimiterOwner } from "../../src/latency/limiter-attribution";

describe("limiter attribution (D8)", () => {
	it("does not treat a saturated provider request as task or job capacity", () => {
		const report = attributeLimiterState(
			[
				{ owner: "provider_request", inFlight: 4, capacity: 4, queued: 2 },
				{ owner: "task_concurrency", inFlight: 1, capacity: 8 },
				{ owner: "async_job_capacity", inFlight: 0, capacity: 3 },
			],
			[{ owner: "provider_request", waitMs: 120 }],
		);
		expect(report.unifiedSemaphore).toBe(false);
		expect(report.blockingOwners).toEqual(["provider_request"]);
		expect(report.byOwner.provider_request.blocking).toBe(true);
		expect(report.byOwner.task_concurrency.blocking).toBe(false);
		expect(report.byOwner.async_job_capacity.blocking).toBe(false);
		expect(report.byOwner.provider_request.waitMs).toBe(120);
		expect(report.byOwner.task_concurrency.waitMs).toBe(0);
		expect(report.byOwner.async_job_capacity.waitMs).toBe(0);
	});

	it("keeps mixed waits on their own owners instead of a merged semaphore", () => {
		const report = attributeLimiterState(
			[
				{ owner: "provider_request", inFlight: 2, capacity: 2 },
				{ owner: "task_concurrency", inFlight: 3, capacity: 3, queued: 1 },
				{ owner: "async_job_capacity", inFlight: 1, capacity: 1 },
			],
			[
				{ owner: "provider_request", waitMs: 10 },
				{ owner: "task_concurrency", waitMs: 40 },
				{ owner: "async_job_capacity", waitMs: 7 },
			],
		);
		expect(report.unifiedSemaphore).toBe(false);
		expect(report.blockingOwners).toEqual(["provider_request", "task_concurrency", "async_job_capacity"]);
		expect(report.byOwner.provider_request.waitMs).toBe(10);
		expect(report.byOwner.task_concurrency.waitMs).toBe(40);
		expect(report.byOwner.async_job_capacity.waitMs).toBe(7);
		const formatted = formatLimiterAttribution(report);
		expect(formatted).toContain("unifiedSemaphore=false");
		expect(formatted).toContain("provider_request");
		expect(formatted).toContain("task_concurrency");
		expect(formatted).toContain("async_job_capacity");
		expect(formatted).not.toContain("unifiedSemaphore=true");
	});

	it("treats unlimited capacity as non-blocking even with in-flight work", () => {
		const report = attributeLimiterState([
			{ owner: "provider_request", inFlight: 12, capacity: 0 },
			{ owner: "task_concurrency", inFlight: 5, capacity: Number.POSITIVE_INFINITY },
			{ owner: "async_job_capacity", inFlight: 2, capacity: 0 },
		]);
		expect(report.blockingOwners).toEqual([]);
		expect(report.byOwner.provider_request.blocking).toBe(false);
		expect(report.byOwner.task_concurrency.blocking).toBe(false);
		expect(report.byOwner.async_job_capacity.blocking).toBe(false);
	});

	it("rejects unknown owners so a merged label cannot sneak into the report", () => {
		const report = attributeLimiterState(
			[{ owner: "unified" as never, inFlight: 9, capacity: 1, queued: 9 }],
			[{ owner: "rate_limit" as never, waitMs: 999 }],
		);
		expect(isLimiterOwner("unified")).toBe(false);
		expect(report.unifiedSemaphore).toBe(false);
		expect(report.blockingOwners).toEqual([]);
		expect(report.byOwner.provider_request.waitMs).toBe(0);
		expect(report.byOwner.task_concurrency.waitMs).toBe(0);
		expect(report.byOwner.async_job_capacity.waitMs).toBe(0);
	});
});
