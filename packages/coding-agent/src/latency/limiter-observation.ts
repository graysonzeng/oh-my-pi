/**
 * D8 — collect limiter occupancy from the three existing owners.
 * Missing occupancy ⇒ that owner is listed in `unknownOwners` (never invent 0
 * as “idle” when the sample is absent). Never merges into one semaphore.
 */
import { snapshotConfiguredProviderInFlightOccupancy } from "@oh-my-pi/pi-ai/stream";
import { AsyncJobManager } from "../async/job-manager";
import {
	attributeLimiterState,
	formatLimiterAttribution,
	type LimiterAttributionReport,
	type LimiterOccupancySnapshot,
} from "./limiter-attribution";
import type { Semaphore } from "../task/parallel";

export interface LimiterObservationInput {
	/** Optional task spawn semaphore when a TaskTool instance is reachable. */
	taskSpawnSemaphore?: Semaphore | null;
	/** Optional async job manager; defaults to process singleton when present. */
	asyncJobManager?: AsyncJobManager | null;
	/**
	 * Optional provider request occupancy when the caller already counted leases.
	 * When omitted, this helper samples configured provider in-flight roots.
	 */
	providerOccupancy?: LimiterOccupancySnapshot | null;
	/** Skip async filesystem provider sampling (tests / sync diagnose). */
	skipProviderSample?: boolean;
}

export interface LimiterObservationResult {
	report: LimiterAttributionReport;
	/** Owners with no occupancy sample this round. */
	unknownOwners: Array<"provider_request" | "task_concurrency" | "async_job_capacity">;
	formatted: string;
}

/**
 * Observe existing limiters without merging them (`unifiedSemaphore` stays false).
 */
export async function observeLimiterAttribution(
	input: LimiterObservationInput = {},
): Promise<LimiterObservationResult> {
	const occupancies: LimiterOccupancySnapshot[] = [];
	const unknownOwners: LimiterObservationResult["unknownOwners"] = [];

	if (input.providerOccupancy && input.providerOccupancy.owner === "provider_request") {
		occupancies.push(input.providerOccupancy);
	} else if (!input.skipProviderSample) {
		try {
			const sample = await snapshotConfiguredProviderInFlightOccupancy();
			if (sample) {
				occupancies.push({
					owner: "provider_request",
					inFlight: sample.inFlight,
					capacity: sample.capacity,
				});
			} else {
				unknownOwners.push("provider_request");
			}
		} catch {
			unknownOwners.push("provider_request");
		}
	} else {
		unknownOwners.push("provider_request");
	}

	if (input.taskSpawnSemaphore) {
		const snap = input.taskSpawnSemaphore.snapshot();
		occupancies.push({
			owner: "task_concurrency",
			inFlight: snap.inFlight,
			capacity: snap.capacity,
			queued: snap.queued,
		});
	} else {
		unknownOwners.push("task_concurrency");
	}

	const manager = input.asyncJobManager === undefined ? AsyncJobManager.instance() : input.asyncJobManager;
	if (manager) {
		const snap = manager.getOccupancySnapshot();
		occupancies.push({
			owner: "async_job_capacity",
			inFlight: snap.inFlight,
			capacity: snap.capacity,
			queued: snap.queued,
		});
	} else {
		unknownOwners.push("async_job_capacity");
	}

	const report = attributeLimiterState(occupancies);
	const lines = [formatLimiterAttribution(report)];
	if (unknownOwners.length > 0) {
		lines.push(`unknown_occupancy=${unknownOwners.join(",")}`);
	}
	return { report, unknownOwners, formatted: lines.join("\n") };
}
