import { afterEach, describe, expect, it } from "bun:test";
import {
	CREDENTIAL_ROUTE_CONFIG_UNAVAILABLE_TTL_MS,
	CredentialRouteUnavailableRegistry,
	buildCredentialRouteKey,
	classifyCredentialRouteFailure,
	credentialRouteAuthScope,
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
		// Probe adapters historically label this authentication (401 matches first);
		// UsageLimit from the message must still win so we do not sticky-block.
		expect(
			classifyCredentialRouteFailure({
				errorKind: "authentication",
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

	it("bounds stored summaries and redacts sk-/ghp/JWT/home paths", () => {
		const registry = new CredentialRouteUnavailableRegistry({ nowMs: () => 0 });
		const key = buildCredentialRouteKey({ provider: "test", modelId: "m" });
		const long = `invalid api key ${"x".repeat(600)}`;
		const entry = registry.noteFailure(key, { errorMessage: long });
		expect(entry?.errorSummary.length).toBeLessThanOrEqual(500);
		expect(entry?.errorSummary).not.toMatch(/sk-[A-Za-z0-9]{20,}/);

		const secretEntry = registry.noteFailure(key, {
			errorMessage: "401 invalid api key sk-proj-abcdefghijklmnopqrstuvwxyz012345",
		});
		expect(secretEntry?.errorSummary).toContain("sk-[REDACTED]");
		expect(secretEntry?.errorSummary).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz012345");

		const ghpEntry = registry.noteFailure(key, {
			errorKind: "authentication",
			errorMessage: `auth failed ghp_${"a".repeat(36)} under /Users/alice/.config`,
		});
		expect(ghpEntry?.errorSummary).toContain("gh*_[REDACTED]");
		expect(ghpEntry?.errorSummary).not.toMatch(/ghp_a{20,}/);
		expect(ghpEntry?.errorSummary).toContain("[HOME]");
		expect(ghpEntry?.errorSummary).not.toContain("/Users/alice");

		const jwt = `eyJ${"k".repeat(12)}.eyJ${"l".repeat(12)}.${"m".repeat(16)}`;
		const jwtEntry = registry.noteFailure(key, {
			errorKind: "authentication",
			errorMessage: `token rejected ${jwt}`,
		});
		expect(jwtEntry?.errorSummary).toContain("eyJ[REDACTED_JWT]");
		expect(jwtEntry?.errorSummary).not.toContain(jwt);
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

describe("credentialRouteAuthScope", () => {
	it("does not cache an externally resolved key without a credential revision", () => {
		const authStorage = {
			credentials: { generation: 1 },
			keys: { overrideEpoch: 1, source: () => ({ kind: "env", envVar: "TEST_KEY" }) },
		};
		expect(credentialRouteAuthScope({ authStorage, provider: "test", sessionId: "session" })).toBeUndefined();
	});

	it("isolates owners, sessions, and config versions without embedding secrets", () => {
		const secret = "sk-live-secret";
		const baseUrl = `https://gateway.example/v1?api_key=${secret}`;
		let generation = 1;
		let epoch = 1;
		const ownerA = {
			credentials: {
				get generation() {
					return generation;
				},
			},
			keys: {
				get overrideEpoch() {
					return epoch;
				},
				source: () => ({ kind: "runtime" as const }),
			},
		};
		const ownerB = {
			credentials: { generation: 1 },
			keys: { overrideEpoch: 1, source: () => ({ kind: "runtime" as const }) },
		};
		const shared = {
			authStorage: ownerA,
			owner: ownerA,
			sessionId: "session-a",
			provider: "anthropic",
			baseUrl,
			accountIds: ["acct-b", "acct-a"],
		};
		const first = credentialRouteAuthScope(shared);
		const again = credentialRouteAuthScope({ ...shared, accountIds: ["acct-a", "acct-b"] });
		expect(again).toBe(first);
		expect(first).not.toContain(secret);
		expect(first).not.toContain("api_key");
		expect(first).not.toBe("default");
		expect(credentialRouteAuthScope({ ...shared, authStorage: ownerB, owner: ownerB })).not.toBe(first);
		expect(credentialRouteAuthScope({ ...shared, sessionId: "session-b" })).not.toBe(first);
		generation += 1;
		expect(credentialRouteAuthScope(shared)).not.toBe(first);
		generation = 1;
		epoch += 1;
		expect(credentialRouteAuthScope(shared)).not.toBe(first);
		expect(credentialRouteAuthScope({})).toBeUndefined();
	});
});
