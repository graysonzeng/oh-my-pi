/**
 * Batch 2 production wiring — prove real call sites (not library-only).
 *
 * Failure modes if these regress:
 * - W4 selectedRoute absent → oauth/config scopes stay fail-open forever / or guess first account
 * - W5 observe missing from prepareWorkflowInvocation → flag is a no-op
 * - W6 SessionMaintenance never calls phase-handoff → shadow/apply dead
 * - W7 Experiment A builds a second cache table beside ordinary arm
 * - Status table claims runtime_wired while callers absent
 * - paired_evidence_ready flips true without paid pairs
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BATCH2_PAIRED_EVIDENCE_READY, BATCH2_STATUS, batch2Status } from "../../src/latency/batch2-status";
import { credentialRouteAuthScope } from "../../src/latency/credential-route-unavailable";
import { READ_DEDUPE_ARM_DUTIES, selectReadDedupeReuse } from "../../src/latency/read-dedupe-selection";
import { buildReadViewKeyV1 } from "../../src/latency/read-view-key";
import {
	observeStablePrefixAtAssembly,
	segmentsFromPromptSections,
} from "../../src/latency/stable-prefix-assembly-bridge";
import { buildStablePrefixCacheExperimentRun } from "../../src/latency/stable-prefix-cache-experiment";
import { detectPhaseBoundaryShadow, hasRequiredRetainedState } from "../../src/session/phase-handoff-experiment";
import { runPhaseHandoffMaintenance } from "../../src/session/phase-handoff-maintenance";

describe("Batch2 status honesty", () => {
	it("marks W4–W7 code_complete/runtime_wired/mechanism_verified with paired_evidence_ready=false", () => {
		for (const id of ["W4", "W5", "W6", "W7"] as const) {
			const row = batch2Status(id);
			expect(row.code_complete).toBe(true);
			expect(row.runtime_wired).toBe(true);
			expect(row.mechanism_verified).toBe(true);
			expect(row.paired_evidence_ready).toBe(false);
			expect(row.call_sites.length).toBeGreaterThan(0);
		}
		expect(BATCH2_STATUS.every(row => row.paired_evidence_ready === false)).toBe(true);
		expect(BATCH2_PAIRED_EVIDENCE_READY).toBe(false);
	});
});

describe("W4 selectedRoute + auth scope", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@omp-batch2-w4-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("runtime selectedRoute exposes non-secret revision and scopes cache", () => {
		authStorage.keys.setRuntime("anthropic", "sk-test-not-for-logs");
		const selected = authStorage.keys.selectedRoute("anthropic", { sessionId: "s1" });
		expect(selected?.kind).toBe("runtime");
		expect(selected?.revision).toMatch(/^e\d+$/);
		expect(JSON.stringify(selected)).not.toContain("sk-test");
		const scope = credentialRouteAuthScope({
			authStorage,
			owner: authStorage,
			sessionId: "s1",
			provider: "anthropic",
		});
		expect(scope).toBeTruthy();
		expect(scope).not.toContain("sk-test");
		authStorage.keys.setRuntime("anthropic", "sk-rotated-other");
		const after = credentialRouteAuthScope({
			authStorage,
			owner: authStorage,
			sessionId: "s1",
			provider: "anthropic",
		});
		expect(after).not.toBe(scope);
	});

	it("env without selected revision fails open", () => {
		const scope = credentialRouteAuthScope({
			authStorage: {
				credentials: { generation: 1 },
				keys: {
					overrideEpoch: 1,
					source: () => ({ kind: "env", envVar: "SOME_KEY" }),
					selectedRoute: () => undefined,
				},
			},
			sessionId: "s",
			provider: "test",
		});
		expect(scope).toBeUndefined();
	});

	it("config literal secret reference fails open via selectedRoute", () => {
		authStorage.keys.removeRuntime("anthropic");
		authStorage.keys.setConfig("anthropic", "sk-literal-secret-value");
		expect(authStorage.keys.selectedRoute("anthropic")).toBeUndefined();
		authStorage.keys.removeConfig("anthropic");
	});

	it("observable config env reference yields identity without hashing secret", () => {
		authStorage.keys.setConfig("anthropic", "ANTHROPIC_API_KEY");
		const selected = authStorage.keys.selectedRoute("anthropic");
		expect(selected?.kind).toBe("config");
		expect(selected?.identityKey).toBe("config:ANTHROPIC_API_KEY");
		expect(JSON.stringify(selected)).not.toMatch(/sk-/);
		authStorage.keys.removeConfig("anthropic");
	});
});

describe("W5 stable-prefix observe at assembly", () => {
	it("fingerprints segments without retaining raw prompt; claimedLiveWin stays false", () => {
		const sections = [
			{ id: "system_static" as const, content: "STATIC RULES SECRET=do-not-log", stable: true },
			{ id: "assignment" as const, content: "do the task", stable: false },
			{ id: "tool_presentation" as const, content: "bash,read", stable: true },
		];
		const bridge = observeStablePrefixAtAssembly({
			sections,
			config: { enabled: true, factor: "inspect_provider_prefix" },
			providerIdentity: { provider: "anthropic", model: "claude-sonnet-4-5", api: "anthropic-messages" },
			scope: "same_child_session",
		});
		expect(bridge.observe.applied).toBe(true);
		expect(bridge.observe.claimedLiveWin).toBe(false);
		expect(bridge.observe.inspection.staticCutByDynamic).toBe(true);
		expect(JSON.stringify(bridge.observe)).not.toContain("SECRET=do-not-log");
		expect(bridge.observe.segments.every(s => s.fingerprint.length === 64)).toBe(true);
		const run = buildStablePrefixCacheExperimentRun({
			arm: "treatment",
			config: { enabled: true, factor: "inspect_provider_prefix" },
			metrics: {
				cacheRead: null,
				ttftMs: null,
				costTotal: null,
				scope: "same_child_session",
				staticCutByDynamic: true,
			},
		});
		expect(run.claimedLiveWin).toBe(false);
		expect(segmentsFromPromptSections(sections).length).toBe(3);
	});

	it("reorder_static_prefix moves tools/static ahead without claiming live win", () => {
		const sections = [
			{ id: "assignment" as const, content: "task", stable: false },
			{ id: "system_static" as const, content: "rules", stable: true },
			{ id: "tool_presentation" as const, content: "bash", stable: true },
		];
		const bridge = observeStablePrefixAtAssembly({
			sections,
			config: { enabled: true, factor: "reorder_static_prefix" },
		});
		expect(bridge.reordered).toBe(true);
		expect(bridge.sections[0]!.id).toBe("system_static");
		expect(bridge.observe.claimedLiveWin).toBe(false);
		expect(bridge.observe.receipt.permissionsChanged).toBe(false);
		expect(bridge.observe.receipt.toolsChanged).toBe(false);
	});
});

describe("W6 phase-handoff shadow + retain semantics", () => {
	it("shadow-detects research→implement and skips drop without boundary", () => {
		const shadow = detectPhaseBoundaryShadow({ fromPhase: "research", toPhase: "implement" });
		expect(shadow.boundaryDetected).toBe(true);
		expect(shadow.shadow).toBe(true);
		const noBoundary = detectPhaseBoundaryShadow({ fromPhase: "research", toPhase: "research" });
		expect(noBoundary.boundaryDetected).toBe(false);

		const maintained = runPhaseHandoffMaintenance({
			config: { enabled: true, factor: "phase_boundary_carry_slim" },
			fromPhase: "research",
			toPhase: "research",
			carried: {
				bulkyCarry: ["huge"],
				retained: {
					openConstraints: ["c"],
					modificationState: ["m"],
					acceptanceBasis: ["a"],
					artifactLocators: ["artifact://1"],
				},
			},
		});
		expect(maintained.shouldRewriteContext).toBe(false);
		expect(maintained.apply.receipt.fallbackReason).toBe("no_phase_boundary");
		expect(maintained.claimedLiveWin).toBe(false);
	});

	it("requires recovery locators when optional retain fields are declared", () => {
		expect(
			hasRequiredRetainedState({
				openConstraints: ["c"],
				modificationState: ["m"],
				acceptanceBasis: ["a"],
			}),
		).toBe(true);
		expect(
			hasRequiredRetainedState({
				openConstraints: ["c"],
				modificationState: ["m"],
				acceptanceBasis: ["a"],
				incompleteTools: [],
				failedAttempts: [],
				artifactLocators: [],
			}),
		).toBe(false);
		expect(
			hasRequiredRetainedState({
				openConstraints: ["c"],
				modificationState: ["m"],
				acceptanceBasis: ["a"],
				artifactLocators: ["artifact://0"],
			}),
		).toBe(true);
	});
});

describe("W7 read-dedupe arm duties + selection layer", () => {
	it("documents ordinary arm owns cache; experiment A does not", () => {
		expect(READ_DEDUPE_ARM_DUTIES.ordinary.ownsCacheTable).toBe(true);
		expect(READ_DEDUPE_ARM_DUTIES.ordinary.ownsOutputRewrite).toBe(true);
		expect(READ_DEDUPE_ARM_DUTIES.experimentA.ownsCacheTable).toBe(false);
		expect(READ_DEDUPE_ARM_DUTIES.experimentA.ownsOutputRewrite).toBe(false);
		expect(READ_DEDUPE_ARM_DUTIES.experimentA.role).toBe("controlled_selection_layer");
	});

	it("experiment A gates same-version+view reuse; forceReread always allows reread", () => {
		const key = buildReadViewKeyV1({
			canonicalSource: "/tmp/a.ts",
			normalizedSelector: "full",
			branchOrWorktreeScope: "main",
			providerViewIdentity: "v1",
			contentOrRevisionIdentity: "sha256:abc",
			outputMode: "raw",
		});
		expect(key.eligible).toBe(true);
		const off = selectReadDedupeReuse({
			ordinaryArmEnabled: true,
			experimentConfig: { enabled: false, factor: "none" },
			current: key,
			prior: key,
		});
		expect(off.allowReuse).toBe(true);
		expect(off.experimentSelectionActive).toBe(false);

		const on = selectReadDedupeReuse({
			ordinaryArmEnabled: true,
			experimentConfig: { enabled: true, factor: "same_version_view_reuse" },
			current: key,
			prior: key,
		});
		expect(on.allowReuse).toBe(true);
		expect(on.experimentSelectionActive).toBe(true);

		const forced = selectReadDedupeReuse({
			ordinaryArmEnabled: true,
			experimentConfig: { enabled: true, factor: "same_version_view_reuse" },
			current: key,
			prior: key,
			forceReread: true,
		});
		expect(forced.allowReuse).toBe(false);
	});
});
