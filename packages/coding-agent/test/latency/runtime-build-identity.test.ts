/**
 * Batch 1 W0 — runtime build identity associates with receipts offline.
 */
import { describe, expect, it } from "bun:test";
import {
	buildParentFinalVerificationDetails,
	PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
} from "../../src/latency/parent-final-verification";
import {
	buildRuntimeBuildIdentity,
	parseRuntimeBuildIdentity,
	RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE,
	resolveRuntimeBuildIdentity,
	runtimeBuildIdentityRef,
} from "../../src/latency/runtime-build-identity";
import { SessionManager } from "../../src/session/session-manager";

describe("W0 runtime build identity", () => {
	it("resolves a source-mode identity and associates it with a receipt", async () => {
		const identity = await resolveRuntimeBuildIdentity({
			cwd: process.cwd(),
			runMode: "source",
			model: "fixture/model",
			provider: "fixture",
		});
		expect(identity.kind).toBe(RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE);
		expect(identity.runMode).toBe("source");
		expect(identity.packageVersion.length).toBeGreaterThan(0);
		expect(["resolved", "partial", "unverified"]).toContain(identity.verification);
		// Offline representative path: persist identity + acceptance receipt together.
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE, identity);
		const ref = runtimeBuildIdentityRef(identity);
		manager.appendCustomEntry(
			PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
			buildParentFinalVerificationDetails("passed", "fixture", Date.now(), {
				eventId: "w0-smoke",
				authority: "fixture",
				buildIdentityRef: ref,
				acceptanceContract: { items: ["offline identity linked"] },
			}),
		);
		const stored = manager
			.getBranch()
			.filter(e => e.type === "custom" && e.customType === RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE)
			.map(e => (e.type === "custom" ? parseRuntimeBuildIdentity(e.data) : null))[0];
		expect(stored?.sourceSha ?? null).toEqual(identity.sourceSha);
		expect(runtimeBuildIdentityRef(stored!)).toBe(ref);
	});

	it("does not treat package version alone as a resolved source SHA", () => {
		const identity = buildRuntimeBuildIdentity({
			runMode: "binary",
			packageVersion: "18.3.1",
			sourceSha: null,
			dirty: null,
			binarySha256: null,
		});
		expect(identity.verification).toBe("unverified");
		expect(identity.sourceSha).toBeNull();
	});
});
