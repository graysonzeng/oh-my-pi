import { describe, expect, it } from "bun:test";
import {
	SESSION_FALLBACK_PROFILE_ID,
	sessionFallbackImplementerProfile,
} from "../../src/workflow/session-fallback-profile";
import { fakeSession } from "./helpers";

function sessionWithModel(model: string) {
	return fakeSession({ getActiveModelString: () => model });
}

describe("sessionFallbackImplementerProfile", () => {
	it("returns undefined without a session", () => {
		expect(sessionFallbackImplementerProfile(undefined)).toBeUndefined();
	});

	it("returns undefined when the session exposes no model string", () => {
		expect(sessionFallbackImplementerProfile(fakeSession())).toBeUndefined();
		expect(sessionFallbackImplementerProfile(fakeSession({ getActiveModelString: () => undefined }))).toBeUndefined();
	});

	it("routes to the session model with exact pattern and last-resort policy", () => {
		const profile = sessionFallbackImplementerProfile(sessionWithModel("deepseek/deepseek-v4-flash:max"));
		expect(profile).toBeDefined();
		expect(profile?.id).toBe(SESSION_FALLBACK_PROFILE_ID);
		expect(profile?.modelPattern).toEqual(["deepseek/deepseek-v4-flash:max"]);
		expect(profile?.roles).toEqual(["implementer"]);
		expect(profile?.retryPolicy).toEqual({ maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] });
		expect(profile?.vendor).toBe("deepseek");
		expect(profile?.thinkingLevel).toBeUndefined(); // effort rides in the modelPattern suffix
		expect(profile?.maxRequests).toBeGreaterThan(0);
		expect(profile?.maxRuntimeMs).toBeGreaterThan(0);
	});

	it("uses model lineage, not transport provider, for vendor (reviewer independence)", () => {
		// gateway transport folds onto the OpenAI lineage so an OpenAI reviewer is not
		// treated as a different vendor.
		expect(sessionFallbackImplementerProfile(sessionWithModel("gateway/gpt-5.6-sol"))?.vendor).toBe("openai");
		expect(sessionFallbackImplementerProfile(sessionWithModel("xai/grok-4.6"))?.vendor).toBe("xai");
		expect(sessionFallbackImplementerProfile(sessionWithModel("zhipu/glm-5.2"))?.vendor).toBe("glm");
	});

	it("falls back to transport provider for unclassifiable model ids", () => {
		const profile = sessionFallbackImplementerProfile(sessionWithModel("custom-vendor/unknown-model-123"));
		expect(profile?.vendor).toBe("custom-vendor");
	});

	it("passes normalize + assert (complete required fields, no unsupported fields)", () => {
		const profile = sessionFallbackImplementerProfile(sessionWithModel("deepseek/deepseek-v4-flash:max"));
		expect(profile).toBeDefined();
		expect(profile!.promptTemplate).toBe("implementer");
		expect(profile!.promptVersion).toBeTruthy();
		expect(profile!.toolPolicyId).toBeTruthy();
		expect(profile!.contextPolicy.maxArtifactBytes).toBeGreaterThan(0);
	});
});
