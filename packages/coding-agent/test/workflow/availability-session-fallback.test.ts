import { describe, expect, it } from "bun:test";
import { runAvailabilityPreflight } from "../../src/workflow/availability-preflight";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { ModelRouter } from "../../src/workflow/model-router";
import {
	SESSION_FALLBACK_PROFILE_ID,
	sessionFallbackImplementerProfile,
} from "../../src/workflow/session-fallback-profile";
import { fakeSession } from "./helpers";

const SESSION_MODEL = "deepseek/deepseek-v4-flash:max";

describe("availability preflight with session-model fallback", () => {
	it("real-probes the dynamically registered session profile (no synthetic available row)", async () => {
		const fallback = sessionFallbackImplementerProfile(fakeSession({ getActiveModelString: () => SESSION_MODEL }));
		expect(fallback).toBeDefined();
		const router = new ModelRouter([
			DEFAULT_MODEL_PROFILES.deepseek_implementer,
			DEFAULT_MODEL_PROFILES.grok_implementer,
			DEFAULT_MODEL_PROFILES.gpt_astra_implementer,
			fallback!,
		]);
		const probed: string[] = [];
		const port = {
			async probe(req: { profile: { modelPattern: string | string[] }; role: string }) {
				probed.push(String(req.profile.modelPattern));
				return {
					status: "available" as const,
					actualProvider: "deepseek",
					actualModel: "deepseek-v4-flash",
					latencyMs: 1,
				};
			},
		};
		const report = await runAvailabilityPreflight({
			port,
			router,
			workflowId: "wf-session-fallback",
			operation: "start",
			status: "implementing",
			singleStep: true,
			session: fakeSession(),
		});
		// The session profile goes through the same physical probe path as static profiles.
		expect(probed).toContain(SESSION_MODEL);
		const row = report.profiles.find(p => p.profileId === SESSION_FALLBACK_PROFILE_ID);
		expect(row?.status).toBe("available");
		expect(row?.actualModel).toBe("deepseek-v4-flash");
		expect(report.status).toBe("ready");
	});

	it("keeps fail-closed when a quality-style router has no session fallback and all candidates are down", async () => {
		// Quality-route routers are snapshot-only: the session fallback is never registered,
		// so an unavailable implementer route still blocks the scope instead of silently
		// falling through to the calling model.
		const router = new ModelRouter([DEFAULT_MODEL_PROFILES.deepseek_implementer]);
		const port = {
			async probe() {
				return {
					status: "unavailable" as const,
					errorKind: "authentication" as const,
					errorSummary: "no credentials",
				};
			},
		};
		const report = await runAvailabilityPreflight({
			port,
			router,
			workflowId: "wf-quality-failclosed",
			operation: "start",
			status: "implementing",
			singleStep: true,
			session: fakeSession(),
		});
		expect(report.status).toBe("blocked");
		expect(report.profiles.every(p => p.profileId !== SESSION_FALLBACK_PROFILE_ID)).toBe(true);
	});
});
