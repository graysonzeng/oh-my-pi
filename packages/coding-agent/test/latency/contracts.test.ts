import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import {
	emptyLatencyArms,
	freezeLatencyArmSnapshot,
	LATENCY_ARM_IDS,
	LATENCY_ARM_SETTINGS,
} from "../../src/latency/arms";
import {
	buildConcurrencyDeclaration,
	readyConcurrencyUnits,
	resolveEffectiveConcurrency,
	shouldAutoParallel,
	validateConcurrencyDeclaration,
} from "../../src/latency/concurrency-declaration";
import {
	buildEvalGateParityReceipt,
	mayMigrateEvalGate,
	mayOverlapEvalWithParent,
} from "../../src/latency/eval-parity";
import {
	buildMechanicalClass,
	isMechanicalFlashEligible,
} from "../../src/latency/mechanical-class";
import {
	buildReadViewKeyV1,
	normalizeReadSelector,
} from "../../src/latency/read-view-key";

describe("latency arms defaults", () => {
	it("keeps every independent arm default-off", () => {
		const settings = Settings.isolated();
		expect(settings.get("modelOptimization.enabled")).toBe(false);
		expect(settings.get("latency.arms.readDedupe")).toBe(false);
		expect(settings.get("latency.arms.contextBudgetTuning")).toBe(false);
		expect(settings.get("latency.arms.roleStaticSplit")).toBe(false);
		expect(settings.get("latency.arms.bashAdvisory")).toBe(false);
		expect(settings.get("latency.arms.bashBoundedInjection")).toBe(false);
		expect(settings.get("latency.arms.concurrencyDeclaration")).toBe(false);
		expect(settings.get("latency.arms.concurrencyExecution")).toBe(false);
		expect(settings.get("latency.arms.evalGateMigration")).toBe(false);
		expect(LATENCY_ARM_IDS).toContain("context_optimization");
		expect(LATENCY_ARM_SETTINGS.context_optimization).toBe("modelOptimization.enabled");
		expect(emptyLatencyArms()).toEqual({
			context_optimization: false,
			read_dedupe: false,
			context_budget_tuning: false,
			role_static_split: false,
			bash_advisory: false,
			bash_bounded_injection: false,
			concurrency_declaration: false,
			concurrency_execution: false,
			eval_gate_migration: false,
		});
	});
});

describe("latency arm snapshots", () => {
	it("freezes independent arms and requires combined child lists", () => {
		const settings = Settings.isolated({
			"modelOptimization.enabled": true,
			"latency.arms.readDedupe": true,
		});
		const snapshot = freezeLatencyArmSnapshot({
			getSetting: path => settings.get(path as Parameters<typeof settings.get>[0]),
			codeRevision: "rev",
			configHash: "cfg",
			frozenAt: "2026-08-04T00:00:00.000Z",
		});
		expect(snapshot.arms.context_optimization).toBe(true);
		expect(snapshot.arms.read_dedupe).toBe(true);
		expect(snapshot.arms.role_static_split).toBe(false);
		expect(snapshot.fingerprint).toHaveLength(64);

		const combined = freezeLatencyArmSnapshot({
			arms: { ...emptyLatencyArms(), context_optimization: true, read_dedupe: true },
			combinedArmId: "context_plus_dedupe",
			childArms: ["context_optimization", "read_dedupe"],
			frozenAt: "2026-08-04T00:00:00.000Z",
		});
		expect(combined.combinedArmId).toBe("context_plus_dedupe");
		expect(combined.childArms).toEqual(["context_optimization", "read_dedupe"]);
		expect(() =>
			freezeLatencyArmSnapshot({
				combinedArmId: "bad",
				childArms: ["context_optimization"],
			}),
		).toThrow(/childArms/);
	});
});

describe("ReadViewKeyV1", () => {
	it("builds eligible keys and fails open when identity is incomplete", () => {
		const eligible = buildReadViewKeyV1({
			canonicalSource: "/repo/src/a.ts",
			normalizedSelector: normalizeReadSelector({ offset: 1, limit: 20 }),
			branchOrWorktreeScope: "main@worktree-1",
			providerViewIdentity: "sha256:abc",
			contentOrRevisionIdentity: "content:def",
			outputMode: "converted",
		});
		expect(eligible.eligible).toBe(true);
		expect(eligible.failOpenReasons).toEqual([]);
		expect(eligible.key).toHaveLength(64);

		const miss = buildReadViewKeyV1({
			canonicalSource: "/repo/src/a.ts",
			normalizedSelector: "full",
			branchOrWorktreeScope: "",
			providerViewIdentity: "",
			contentOrRevisionIdentity: "content:def",
			outputMode: "unknown",
		});
		expect(miss.eligible).toBe(false);
		expect(miss.failOpenReasons).toContain("missing_branch_or_worktree_scope");
		expect(miss.failOpenReasons).toContain("missing_provider_view_identity");
		expect(miss.failOpenReasons).toContain("unknown_output_mode");
	});

	it("changes key when branch, selector, or provider view changes", () => {
		const base = {
			canonicalSource: "/repo/src/a.ts",
			normalizedSelector: "full",
			branchOrWorktreeScope: "main",
			providerViewIdentity: "etag:1",
			contentOrRevisionIdentity: "rev:1",
			outputMode: "converted" as const,
		};
		const a = buildReadViewKeyV1(base);
		const branch = buildReadViewKeyV1({ ...base, branchOrWorktreeScope: "feature" });
		const selector = buildReadViewKeyV1({
			...base,
			normalizedSelector: normalizeReadSelector({ raw: true }),
		});
		const provider = buildReadViewKeyV1({ ...base, providerViewIdentity: "etag:2" });
		expect(a.key).not.toBe(branch.key);
		expect(a.key).not.toBe(selector.key);
		expect(a.key).not.toBe(provider.key);
	});
});

describe("WorkflowConcurrencyDeclarationV1", () => {
	it("rejects cycles, path overlap, and unknown fields; auto-parallel only for ≥2 ready units", () => {
		const valid = buildConcurrencyDeclaration({
			declarationId: "d1",
			ownerKind: "session_task",
			ownerId: "session-1",
			scopeArtifactRef: "artifact://1",
			scopeArtifactSha256: "a".repeat(64),
			revision: 1,
			maxConcurrency: 4,
			completionPolicy: { kind: "all_required", minSuccesses: null },
			failurePolicy: "fail_closed",
			cancelPolicy: "stop_new_work",
			units: [
				{
					id: "u1",
					assignment: "slice A",
					paths: ["packages/a"],
					dependsOn: [],
					mode: "write",
					required: true,
					idempotencyKey: "k1",
				},
				{
					id: "u2",
					assignment: "slice B",
					paths: ["packages/b"],
					dependsOn: [],
					mode: "write",
					required: true,
					idempotencyKey: "k2",
				},
			],
		});
		expect(validateConcurrencyDeclaration(valid).ok).toBe(true);
		expect(shouldAutoParallel(valid.units)).toBe(true);
		expect(shouldAutoParallel(valid.units.slice(0, 1))).toBe(false);

		const cycle = buildConcurrencyDeclaration({
			...valid,
			declarationId: "d2",
			units: [
				{ ...valid.units[0]!, dependsOn: ["u2"] },
				{ ...valid.units[1]!, dependsOn: ["u1"] },
			],
		});
		expect(validateConcurrencyDeclaration(cycle).errors.some(e => e.code === "cycle")).toBe(true);

		const overlap = buildConcurrencyDeclaration({
			...valid,
			declarationId: "d3",
			units: [valid.units[0]!, { ...valid.units[1]!, paths: ["packages/a/src"] }],
		});
		expect(validateConcurrencyDeclaration(overlap).errors.some(e => e.code === "path_overlap")).toBe(
			true,
		);

		const unknown = validateConcurrencyDeclaration(valid, {
			raw: { ...valid, extraField: true } as unknown as Record<string, unknown>,
		});
		expect(unknown.errors.some(e => e.code === "unknown_field")).toBe(true);

		const states = valid.units.map(u => ({
			id: u.id,
			status: "declared" as const,
			attemptCount: 0,
		}));
		expect(readyConcurrencyUnits(valid, states)).toHaveLength(2);
		expect(resolveEffectiveConcurrency({ declarationMax: 8, sessionMax: 2, providerMax: 4 })).toBe(2);
		expect(resolveEffectiveConcurrency({ declarationMax: 0, sessionMax: 0 })).toBe(0);
	});
});

describe("WorkflowMechanicalClassV1 + eval parity", () => {
	it("routes only eligible mechanical work to Flash when arm is on", () => {
		const mech = buildMechanicalClass({
			class: "mechanical_repair",
			source: "accepted_finding",
			ref: "finding-1",
			targetRole: "repair",
		});
		expect(isMechanicalFlashEligible(mech, true)).toBe(true);
		expect(isMechanicalFlashEligible(mech, false)).toBe(false);
		expect(
			isMechanicalFlashEligible(
				buildMechanicalClass({
					class: "none",
					source: "caller_declaration",
					targetRole: "repair",
				}),
				true,
			),
		).toBe(false);
	});

	it("blocks eval migration until parity is proven", () => {
		const proven = buildEvalGateParityReceipt({
			sourceBridge: "__agent__",
			sourceRequestSha256: "b".repeat(64),
			sourceDecisionContract: "approved|changes_requested|blocked",
			sourceInlineIsolationContract: "inline+isolation",
			targetOwner: "workflow",
			parity: "proven",
		});
		const failed = buildEvalGateParityReceipt({
			...proven,
			parity: "failed",
		});
		expect(mayMigrateEvalGate(proven, true)).toBe(true);
		expect(mayMigrateEvalGate(proven, false)).toBe(false);
		expect(mayMigrateEvalGate(failed, true)).toBe(false);
		expect(
			mayOverlapEvalWithParent({
				parityProven: true,
				parentHasIndependentReadyWork: true,
				ownershipDisjoint: true,
			}),
		).toBe(true);
		expect(
			mayOverlapEvalWithParent({
				parityProven: true,
				parentHasIndependentReadyWork: false,
				ownershipDisjoint: true,
			}),
		).toBe(false);
	});
});
