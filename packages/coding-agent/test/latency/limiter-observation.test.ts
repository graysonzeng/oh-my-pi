import { describe, expect, it } from "bun:test";
import { Semaphore } from "../../src/task/parallel";
import { observeLimiterAttribution } from "../../src/latency/limiter-observation";
import { AsyncJobManager } from "../../src/async/job-manager";

describe("limiter observation (D8)", () => {
	it("marks missing occupancy as unknown and never sets unifiedSemaphore", async () => {
		const result = await observeLimiterAttribution({
			skipProviderSample: true,
			taskSpawnSemaphore: null,
			asyncJobManager: null,
		});
		expect(result.report.unifiedSemaphore).toBe(false);
		expect(result.unknownOwners).toEqual(["provider_request", "task_concurrency", "async_job_capacity"]);
		expect(result.formatted).toContain("unknown_occupancy=");
		expect(result.formatted).toContain("unifiedSemaphore=false");
	});

	it("attributes task and job occupancy on separate owners", async () => {
		const sem = new Semaphore(2);
		await sem.acquire();
		await sem.acquire();
		const wait = sem.acquire(); // queued
		const manager = new AsyncJobManager({ maxRunningJobs: 3, retentionMs: 0, consumedResultEvictionMs: 0 });
		try {
			const result = await observeLimiterAttribution({
				skipProviderSample: true,
				taskSpawnSemaphore: sem,
				asyncJobManager: manager,
			});
			expect(result.report.unifiedSemaphore).toBe(false);
			expect(result.report.byOwner.task_concurrency.inFlight).toBe(2);
			expect(result.report.byOwner.task_concurrency.queued).toBe(1);
			expect(result.report.byOwner.task_concurrency.blocking).toBe(true);
			expect(result.report.byOwner.async_job_capacity.capacity).toBe(3);
			expect(result.unknownOwners).toEqual(["provider_request"]);
		} finally {
			sem.release();
			await wait;
			sem.release();
			sem.release();
			await manager.dispose({ timeoutMs: 0 });
		}
	});
});
