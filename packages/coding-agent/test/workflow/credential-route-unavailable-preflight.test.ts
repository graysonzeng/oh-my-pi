import { afterEach, describe, expect, it } from "bun:test";
import {
	CredentialRouteUnavailableRegistry,
	resetSharedCredentialRouteUnavailableRegistryForTests,
} from "../../src/latency/credential-route-unavailable";
import type { ToolSession } from "../../src/tools";
import { availabilityProbeDedupeKey } from "../../src/workflow/availability-candidates";
import { availabilityCredentialRouteScope, runAvailabilityPreflight } from "../../src/workflow/availability-preflight";
import { ModelRouter } from "../../src/workflow/model-router";
import type { ModelProfile, WorkflowAvailabilityPort, WorkflowRole } from "../../src/workflow/types";
import { fakeSession } from "./helpers";

afterEach(() => {
	resetSharedCredentialRouteUnavailableRegistryForTests();
});

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

function routeKey(session: ToolSession, target: ModelProfile): string {
	const scope = availabilityCredentialRouteScope(session, target);
	if (!scope) throw new Error("expected an established credential-route scope");
	return availabilityProbeDedupeKey(target, scope);
}

describe("availability preflight credential-route unavailable (S0)", () => {
	it("notes config auth failure and skips the next physical probe for the same route key", async () => {
		const target = profile({ id: "p1", roles: ["planner"], modelPattern: "dead-model" });
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => 0 });
		const probes = { count: 0 };
		const port: WorkflowAvailabilityPort = {
			async probe() {
				probes.count += 1;
				return {
					status: "unavailable",
					latencyMs: 5,
					errorKind: "authentication",
					errorSummary: "no credentials for test/dead-model",
				};
			},
		};
		const options = {
			port,
			router: new ModelRouter([target]),
			workflowId: "wf-auth",
			operation: "start" as const,
			status: "planning" as const,
			singleStep: true,
			session: fakeSession(),
			credentialRouteUnavailable: registry,
		};
		const first = await runAvailabilityPreflight(options);
		expect(probes.count).toBe(1);
		expect(first.profiles[0]?.errorKind).toBe("authentication");
		expect(first.profiles[0]?.errorSummary).toContain("no credentials");
		expect(registry.isUnavailable(routeKey(options.session, target))).toBe(true);
		expect(registry.isUnavailable(availabilityProbeDedupeKey(target, "default"))).toBe(false);

		const second = await runAvailabilityPreflight(options);
		expect(probes.count).toBe(1);
		expect(second.profiles[0]).toMatchObject({
			profileId: "p1",
			status: "unavailable",
			errorKind: "authentication",
			errorSummary: "no credentials for test/dead-model",
		});
	});

	it("does not mark transport blips and still re-probes", async () => {
		const target = profile({ id: "p1", roles: ["planner"], modelPattern: "flaky" });
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => 0 });
		const session = fakeSession();
		const probes = { count: 0 };
		const port: WorkflowAvailabilityPort = {
			async probe() {
				probes.count += 1;
				return {
					status: "unavailable",
					latencyMs: 3,
					errorKind: "timeout",
					errorSummary: "availability target timeout",
				};
			},
		};
		const options = {
			port,
			router: new ModelRouter([target]),
			workflowId: "wf-timeout",
			operation: "start" as const,
			status: "planning" as const,
			singleStep: true,
			session,
			credentialRouteUnavailable: registry,
		};
		await runAvailabilityPreflight(options);
		await runAvailabilityPreflight(options);
		expect(probes.count).toBe(2);
		expect(registry.isUnavailable(routeKey(session, target))).toBe(false);
	});

	it("shares config-unavailable across sibling profiles with the same probe dedupe key", async () => {
		const roles: WorkflowRole[] = ["planner", "plan_reviewer"];
		const a = profile({ id: "a", roles: ["planner"], modelPattern: "shared-model" });
		const b = profile({ id: "b", roles: ["plan_reviewer"], modelPattern: "shared-model" });
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => 0 });
		const session = fakeSession();
		const probes = { count: 0 };
		const port: WorkflowAvailabilityPort = {
			async probe() {
				probes.count += 1;
				return {
					status: "unavailable",
					latencyMs: 4,
					errorKind: "authentication",
					errorSummary: "503 auth_unavailable: no auth available",
				};
			},
		};
		await runAvailabilityPreflight({
			port,
			router: new ModelRouter([a, b]),
			workflowId: "wf-share",
			operation: "start",
			status: "created",
			singleStep: false,
			session,
			credentialRouteUnavailable: registry,
		});
		// One physical probe; shared_live expands to both roles.
		expect(probes.count).toBe(1);
		expect(registry.isUnavailable(routeKey(session, a))).toBe(true);

		const skipped = await runAvailabilityPreflight({
			port,
			router: new ModelRouter([a, b]),
			workflowId: "wf-share-2",
			operation: "start",
			status: "created",
			singleStep: false,
			session,
			credentialRouteUnavailable: registry,
		});
		expect(probes.count).toBe(1);
		const rows = skipped.profiles.filter(row => roles.includes(row.role));
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(rows.every(row => row.status === "unavailable")).toBe(true);
		expect(rows.every(row => row.errorKind === "authentication")).toBe(true);
		expect(rows.every(row => row.errorSummary?.includes("auth_unavailable"))).toBe(true);
	});

	it("does not reuse a config-unavailable mark for a different session", async () => {
		const target = profile({ id: "p1", roles: ["planner"], modelPattern: "dead-model" });
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => 0 });
		const probes = { count: 0 };
		const port: WorkflowAvailabilityPort = {
			async probe() {
				probes.count += 1;
				return {
					status: "unavailable",
					latencyMs: 5,
					errorKind: "authentication",
					errorSummary: "no credentials for test/dead-model",
				};
			},
		};
		const run = (session: ToolSession) =>
			runAvailabilityPreflight({
				port,
				router: new ModelRouter([target]),
				workflowId: "wf-owner",
				operation: "start",
				status: "planning",
				singleStep: true,
				session,
				credentialRouteUnavailable: registry,
			});
		await run(fakeSession({ getSessionId: () => "owner-a" }));
		const second = await run(fakeSession({ getSessionId: () => "owner-b" }));
		expect(probes.count).toBe(2);
		expect(second.profiles[0]?.source).toBe("live");
		expect(second.profiles[0]?.errorKind).toBe("authentication");
	});

	it("re-probes the same session after the auth override epoch changes", async () => {
		const target = profile({ id: "p1", roles: ["planner"], modelPattern: "dead-model" });
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => 0 });
		let epoch = 1;
		const authStorage = {
			credentials: { generation: 1 },
			keys: {
				get overrideEpoch() {
					return epoch;
				},
				source: () => ({ kind: "runtime" as const, concrete: true }),
			},
		};
		const session = fakeSession({
			getSessionId: () => "same-session",
			modelRegistry: {
				authStorage,
			} as unknown as ToolSession["modelRegistry"],
		});
		const probes = { count: 0 };
		const port: WorkflowAvailabilityPort = {
			async probe() {
				probes.count += 1;
				return {
					status: "unavailable",
					latencyMs: 4,
					errorKind: "authentication",
					errorSummary: "invalid api key",
				};
			},
		};
		const run = () =>
			runAvailabilityPreflight({
				port,
				router: new ModelRouter([target]),
				workflowId: "wf-epoch",
				operation: "start",
				status: "planning",
				singleStep: true,
				session,
				credentialRouteUnavailable: registry,
			});
		await run();
		await run();
		expect(probes.count).toBe(1);
		epoch += 1;
		await run();
		expect(probes.count).toBe(2);
	});

	it("clears the mark after a live success so recovery can resume", async () => {
		const target = profile({ id: "p1", roles: ["planner"], modelPattern: "recover" });
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => 0 });
		const session = fakeSession();
		let mode: "auth" | "ok" = "auth";
		const port: WorkflowAvailabilityPort = {
			async probe() {
				if (mode === "ok") {
					return { status: "available", actualProvider: "live", actualModel: "ok", latencyMs: 2 };
				}
				return {
					status: "unavailable",
					latencyMs: 2,
					errorKind: "authentication",
					errorSummary: "invalid api key",
				};
			},
		};
		const run = () =>
			runAvailabilityPreflight({
				port,
				router: new ModelRouter([target]),
				workflowId: "wf-recover",
				operation: "start",
				status: "planning",
				singleStep: true,
				session,
				credentialRouteUnavailable: registry,
			});
		await run();
		expect(registry.isUnavailable(routeKey(session, target))).toBe(true);
		mode = "ok";
		// Force a probe by clearing — success path clears after live available.
		registry.clear(routeKey(session, target));
		await run();
		expect(registry.isUnavailable(routeKey(session, target))).toBe(false);
	});

	it("does not sticky-mark usage-limit / insufficient balance even when probe kind is authentication", async () => {
		const target = profile({ id: "p1", roles: ["planner"], modelPattern: "balance" });
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => 0 });
		const session = fakeSession();
		const probes = { count: 0 };
		const port: WorkflowAvailabilityPort = {
			async probe() {
				probes.count += 1;
				return {
					status: "unavailable",
					latencyMs: 4,
					// Historical adapter mislabel — message is UsageLimit / short_cooldown.
					errorKind: "authentication",
					errorSummary: "401 Insufficient balance",
				};
			},
		};
		const options = {
			port,
			router: new ModelRouter([target]),
			workflowId: "wf-balance",
			operation: "start" as const,
			status: "planning" as const,
			singleStep: true,
			session,
			credentialRouteUnavailable: registry,
		};
		await runAvailabilityPreflight(options);
		expect(registry.isUnavailable(routeKey(session, target))).toBe(false);
		await runAvailabilityPreflight(options);
		expect(probes.count).toBe(2);
	});
});
