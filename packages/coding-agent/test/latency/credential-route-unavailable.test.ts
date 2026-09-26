import { afterEach, describe, expect, it } from "bun:test";
import {
	CREDENTIAL_ROUTE_CONFIG_UNAVAILABLE_TTL_MS,
	CredentialRouteUnavailableRegistry,
	buildCredentialRouteKey,
	classifyCredentialRouteFailure,
	isConfigCredentialRouteUnavailable,
	resetSharedCredentialRouteUnavailableRegistryForTests,
	sharedCredentialRouteUnavailableRegistry,
} from "../../src/latency/credential-route-unavailable";

afterEach(() => {
	resetSharedCredentialRouteUnavailableRegistryForTests();
});

describe("classifyCredentialRouteFailure", () => {
	it("maps structured workflow kinds without guessing permissions", () => {
		expect(classifyCredentialRouteFailure({ errorKind: "authentication" })).toBe("config_unavailable");
		expect(classifyCredentialRouteFailure({ errorKind: "configuration" })).toBe("config_unavailable");
		expect(classifyCredentialRouteFailure({ errorKind: "rate_limit" })).toBe("short_cooldown");
		expect(classifyCredentialRouteFailure({ errorKind: "quota" })).toBe("short_cooldown");
		expect(classifyCredentialRouteFailure({ errorKind: "timeout" })).toBe("transport_blip");
		expect(classifyCredentialRouteFailure({ errorKind: "provider_transient" })).toBe("transport_blip");
		expect(classifyCredentialRouteFailure({ errorKind: "internal" })).toBe("unknown");
	});

	it("treats bare auth_unavailable and invalid API key as config, usage-limit as cooldown", () => {
		expect(
			classifyCredentialRouteFailure({
				errorMessage: "503 auth_unavailable: no auth available",
			}),
		).toBe("config_unavailable");
		expect(
			classifyCredentialRouteFailure({
				errorMessage: "401 invalid api key",
				errorStatus: 401,
			}),
		).toBe("config_unavailable");
		expect(
			classifyCredentialRouteFailure({
				errorMessage: "401 Insufficient balance",
				errorStatus: 401,
			}),
		).toBe("short_cooldown");
		expect(
			classifyCredentialRouteFailure({
				errorMessage:
					"503 auth_unavailable: no auth available (providers=xai, model=grok-4.6; last upstream error: You have run out of credits or need a Grok subscription. Add credits at https://accounts.x.ai)",
			}),
		).toBe("config_unavailable");
		expect(
			isConfigCredentialRouteUnavailable({
				errorMessage: "stream stall: idle timeout",
			}),
		).toBe(false);
	});

	it("keeps unknown conservative (no config mark)", () => {
		expect(classifyCredentialRouteFailure({ errorMessage: "something went sideways" })).toBe("unknown");
		expect(isConfigCredentialRouteUnavailable({ errorMessage: "something went sideways" })).toBe(false);
	});
});

describe("CredentialRouteUnavailableRegistry", () => {
	it("records only config failures and expires after TTL", () => {
		let now = 1_000;
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => now });
		const key = buildCredentialRouteKey({ provider: "xai", modelId: "grok-4.6" });
		expect(
			registry.noteFailure(key, {
				errorKind: "timeout",
				errorMessage: "timeout",
			}),
		).toBeUndefined();
		expect(registry.isUnavailable(key)).toBe(false);

		const entry = registry.noteFailure(key, {
			errorKind: "authentication",
			errorMessage: "503 auth_unavailable: no auth available",
		});
		expect(entry?.failureClass).toBe("config_unavailable");
		expect(entry?.errorSummary).toContain("auth_unavailable");
		expect(registry.isUnavailable(key)).toBe(true);

		now += CREDENTIAL_ROUTE_CONFIG_UNAVAILABLE_TTL_MS - 1;
		expect(registry.isUnavailable(key)).toBe(true);
		now += 1;
		expect(registry.isUnavailable(key)).toBe(false);
	});

	it("clears on success so brief faults can resume", () => {
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => 0 });
		const key = buildCredentialRouteKey({ provider: "openai", providerScoped: true });
		registry.noteFailure(key, { errorKind: "authentication", errorMessage: "invalid api key" });
		expect(registry.isUnavailable(key)).toBe(true);
		registry.clear(key);
		expect(registry.isUnavailable(key)).toBe(false);
	});

	it("bounds stored summaries and does not embed raw sk- keys as credentials", () => {
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => 0 });
		const key = buildCredentialRouteKey({ provider: "test", modelId: "m" });
		const long = `invalid api key ${"x".repeat(600)}`;
		const entry = registry.noteFailure(key, { errorMessage: long });
		expect(entry?.errorSummary.length).toBeLessThanOrEqual(500);
		expect(entry?.errorSummary).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
	});

	it("shares the process-local singleton across callers", () => {
		const a = sharedCredentialRouteUnavailableRegistry();
		const b = sharedCredentialRouteUnavailableRegistry();
		expect(a).toBe(b);
		const key = buildCredentialRouteKey({ provider: "shared", providerScoped: true });
		a.noteFailure(key, { errorKind: "authentication", errorMessage: "no credentials" });
		expect(b.isUnavailable(key)).toBe(true);
	});
});
