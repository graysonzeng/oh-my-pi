import { describe, expect, it } from "bun:test";
import {
	PROVIDER_HEALTH_BREAKER_ERROR_SUMMARY,
	ProviderHealthBreaker,
} from "../../src/latency/provider-health-breaker";
import { runAvailabilityPreflight } from "../../src/workflow/availability-preflight";
import { WorkflowEngine } from "../../src/workflow/engine";
import { ModelRouter } from "../../src/workflow/model-router";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { ModelProfile, WorkflowAvailabilityPort, WorkflowRole } from "../../src/workflow/types";
import { fakeSession } from "./helpers";

function profile(partial: Partial<ModelProfile> & Pick<ModelProfile, "id" | "roles" | "modelPattern">): ModelProfile {
	return {
		vendor: "test",
		promptTemplate: "planner",
		promptVersion: "1.0",
		toolPolicyId: "readonly",
		maxRequests: 1,
		maxRuntimeMs: 1000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 1000,
		},
		...partial,
	};
}

const ALL_ROLES: WorkflowRole[] = ["planner", "plan_reviewer", "implementer", "code_reviewer", "repair"];

function allRoleProfile(id = "all"): ModelProfile {
	return profile({ id, roles: ALL_ROLES, modelPattern: "shared-model" });
}

function transientPort(probes: { count: number }, errorKind = "timeout"): WorkflowAvailabilityPort {
	return {
		async probe() {
			probes.count += 1;
			return { status: "unavailable", latencyMs: 9, errorKind, errorSummary: errorKind };
		},
	};
}

describe("availability preflight provider health breaker", () => {
	it("skips physical probes for open profiles and synthesizes provider_transient", async () => {
		const target = profile({ id: "p1", roles: ["planner"], modelPattern: "m1" });
		const breaker = new ProviderHealthBreaker({ nowMs: () => 0 });
		breaker.recordFailure("p1", "timeout");
		breaker.recordFailure("p1", "timeout");
		const probes = { count: 0 };
		const report = await runAvailabilityPreflight({
			port: transientPort(probes),
			router: new ModelRouter([target]),
			workflowId: "wf-open",
			operation: "start",
			status: "planning",
			singleStep: true,
			session: fakeSession(),
			providerHealthBreaker: breaker,
		});
		expect(probes.count).toBe(0);
		expect(report.profiles).toHaveLength(1);
		expect(report.profiles[0]).toMatchObject({
			profileId: "p1",
			status: "unavailable",
			errorKind: "provider_transient",
			errorSummary: PROVIDER_HEALTH_BREAKER_ERROR_SUMMARY,
		});
		expect(report.profiles[0]?.source).toBeUndefined();
	});

	it("opens after two live transient failures then skips the next call", async () => {
		const target = profile({ id: "p1", roles: ["planner"], modelPattern: "m1" });
		const breaker = new ProviderHealthBreaker({ nowMs: () => 0 });
		const probes = { count: 0 };
		const options = {
			port: transientPort(probes, "provider_transient"),
			router: new ModelRouter([target]),
			workflowId: "wf-trip",
			operation: "start" as const,
			status: "planning" as const,
			singleStep: true,
			session: fakeSession(),
			providerHealthBreaker: breaker,
		};
		await runAvailabilityPreflight(options);
		expect(probes.count).toBe(1);
		expect(breaker.isOpen("p1")).toBe(false);
		await runAvailabilityPreflight(options);
		expect(probes.count).toBe(2);
		expect(breaker.isOpen("p1")).toBe(true);
		const skipped = await runAvailabilityPreflight(options);
		expect(probes.count).toBe(2);
		expect(skipped.profiles[0]?.errorKind).toBe("provider_transient");
		expect(skipped.profiles[0]?.errorSummary).toBe(PROVIDER_HEALTH_BREAKER_ERROR_SUMMARY);
	});

	it("does not open from a single shared physical probe expanded to two roles", async () => {
		const target = profile({
			id: "p1",
			roles: ["planner", "plan_reviewer"],
			modelPattern: "shared",
		});
		const breaker = new ProviderHealthBreaker({ nowMs: () => 0 });
		const probes = { count: 0 };
		const report = await runAvailabilityPreflight({
			port: transientPort(probes, "rate_limit"),
			router: new ModelRouter([target]),
			workflowId: "wf-shared",
			operation: "start",
			status: "created",
			singleStep: false,
			session: fakeSession(),
			providerHealthBreaker: breaker,
		});
		expect(probes.count).toBe(1);
		expect(report.profiles.filter(row => row.profileId === "p1").length).toBeGreaterThan(1);
		expect(breaker.isOpen("p1")).toBe(false);
		expect(breaker.snapshot("p1").consecutiveFailures).toBe(1);
		expect(breaker.snapshot("p1").sampleCount).toBe(1);
	});

	it("resets on live success and ignores hard failures", async () => {
		const target = profile({ id: "p1", roles: ["planner"], modelPattern: "m1" });
		const breaker = new ProviderHealthBreaker({ nowMs: () => 0 });
		let kind: "timeout" | "available" | "authentication" = "timeout";
		const port: WorkflowAvailabilityPort = {
			async probe() {
				if (kind === "available") {
					return { status: "available", actualProvider: "live", actualModel: "ok", latencyMs: 4 };
				}
				return { status: "unavailable", latencyMs: 3, errorKind: kind, errorSummary: kind };
			},
		};
		const run = () =>
			runAvailabilityPreflight({
				port,
				router: new ModelRouter([target]),
				workflowId: "wf-reset",
				operation: "start",
				status: "planning",
				singleStep: true,
				session: fakeSession(),
				providerHealthBreaker: breaker,
			});
		await run();
		kind = "available";
		await run();
		expect(breaker.isOpen("p1")).toBe(false);
		expect(breaker.snapshot("p1").consecutiveFailures).toBe(0);
		kind = "authentication";
		await run();
		await run();
		expect(breaker.isOpen("p1")).toBe(false);
	});
});

describe("engine provider health breaker arm gate", () => {
	it("does not skip probes when the arm is off and skips when enabled after two transients", async () => {
		const target = allRoleProfile();
		const store = new WorkflowStore(":memory:");
		const enabledBreaker = new ProviderHealthBreaker({ nowMs: () => 0 });
		const probes = { count: 0 };
		const availability = transientPort(probes);
		try {
			const off = new WorkflowEngine({
				store,
				router: new ModelRouter([target]),
				config: { profiles: { [target.id]: target } },
				session: fakeSession(),
				availability,
				ownsStore: false,
			});
			await off.start({ request: "arm off" });
			await off.start({ request: "arm off again" });
			const probedWhileOff = probes.count;
			expect(probedWhileOff).toBeGreaterThan(0);
			await off.start({ request: "arm still off" });
			expect(probes.count).toBeGreaterThan(probedWhileOff);

			const on = new WorkflowEngine({
				store,
				router: new ModelRouter([target]),
				config: { profiles: { [target.id]: target } },
				session: fakeSession({
					isLatencyArmEnabled: arm => arm === "provider_health_breaker",
				}),
				availability,
				providerHealthBreaker: enabledBreaker,
				ownsStore: false,
			});
			const before = probes.count;
			await on.start({ request: "arm on 1" });
			await on.start({ request: "arm on 2" });
			expect(enabledBreaker.isOpen("all")).toBe(true);
			const afterTrip = probes.count;
			expect(afterTrip).toBe(before + 2);
			const skipped = await on.start({ request: "arm on skip" });
			expect(probes.count).toBe(afterTrip);
			expect(
				skipped.availability.profiles.every(row => row.profileId !== "all" || row.status === "unavailable"),
			).toBe(true);
			expect(
				skipped.availability.profiles
					.filter(row => row.profileId === "all")
					.every(row => row.errorKind === "provider_transient"),
			).toBe(true);
		} finally {
			store.close();
		}
	});
});
