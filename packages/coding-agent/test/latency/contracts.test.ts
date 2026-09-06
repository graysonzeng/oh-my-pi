import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import {
	buildLatencyRolloutDecision,
	DSH_QUALITY_STOP,
	declaredDimensionArms,
	deriveLatencyCombination,
	emptyLatencyArms,
	evaluateLatencyQualityStop,
	freezeLatencyArmSnapshot,
	LATENCY_ARM_IDS,
	LATENCY_ARM_SETTINGS,
	LATENCY_QUALITY_STOP,
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
	parseWorkflowMechanicalClass,
} from "../../src/latency/mechanical-class";
import { buildReadViewKeyV1, normalizeReadSelector } from "../../src/latency/read-view-key";

describe("latency arms defaults", () => {
	it("keeps the high-benefit pair and the low-risk bash pair on by default", () => {
		const settings = Settings.isolated();
		expect(settings.get("modelOptimization.enabled")).toBe(true);
		expect(settings.get("latency.arms.readDedupe")).toBe(true);
		expect(settings.get("latency.arms.contextBudgetTuning")).toBe(false);
		expect(settings.get("latency.arms.roleStaticSplit")).toBe(false);
		expect(settings.get("latency.arms.bashAdvisory")).toBe(true);
		expect(settings.get("latency.arms.bashBoundedInjection")).toBe(true);
		expect(settings.get("latency.arms.concurrencyDeclaration")).toBe(false);
		expect(settings.get("latency.arms.concurrencyExecution")).toBe(false);
		expect(settings.get("latency.arms.evalGateMigration")).toBe(false);
		expect(settings.get("latency.arms.providerHealthBreaker")).toBe(false);
		expect(settings.get("latency.arms.adaptiveThinkingContext")).toBe(false);
		expect(LATENCY_ARM_IDS).toContain("context_optimization");
		expect(LATENCY_ARM_SETTINGS.context_optimization).toBe("modelOptimization.enabled");
		expect(LATENCY_ARM_IDS).toContain("provider_health_breaker");
		expect(LATENCY_ARM_SETTINGS.provider_health_breaker).toBe("latency.arms.providerHealthBreaker");
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
			provider_health_breaker: false,
			adaptive_thinking_context: false,
			dsh_session_search: false,
			dsh_omit_goal_time: false,
			dsh_goal_hash_shadow: false,
			dsh_headless_continuation: false,
		});
	});

	it("resolves the default snapshot to the on-by-default set and registers the combination", () => {
		const settings = Settings.isolated();
		const snapshot = freezeLatencyArmSnapshot({
			getSetting: setting => settings.get(setting as Parameters<typeof settings.get>[0]),
		});
		expect(snapshot.arms).toEqual({
			...emptyLatencyArms(),
			context_optimization: true,
			read_dedupe: true,
			bash_advisory: true,
			bash_bounded_injection: true,
		});
		expect(snapshot.combinedArmId).toBeUndefined(); // freeze itself never invents a combination
		expect(deriveLatencyCombination(snapshot.arms)).toEqual({
			combinedArmId: "combined:bash_advisory+bash_bounded_injection+context_optimization+read_dedupe",
			childArms: ["bash_advisory", "bash_bounded_injection", "context_optimization", "read_dedupe"],
		});
	});
});

describe("latency arm snapshots", () => {
	it("freezes independent arms and requires combined child lists", () => {
		const settings = Settings.isolated({
			"modelOptimization.enabled": true,
			"latency.arms.readDedupe": true,
			"latency.arms.roleStaticSplit": false,
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

describe("latency quality stop", () => {
	it("treats attributed P0/P1 escapes as zero-tolerance stop", () => {
		expect(LATENCY_QUALITY_STOP.p0p1ZeroTolerance).toBe(true);
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
			}),
		).toEqual({ stop: false, reason: null });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 1,
				attributionKnown: true,
			}),
		).toEqual({ stop: true, reason: "p0p1_escape" });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: false,
			}),
		).toEqual({ stop: true, reason: "missing_attribution" });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				completionDropPp: 3,
			}),
		).toEqual({ stop: true, reason: "completion_drop" });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				reworkRisePct: 11,
			}),
		).toEqual({ stop: true, reason: "rework_rise" });
	});

	it("covers cost P50/P95, latency improvement, and spawned-agent thresholds", () => {
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				costP50Multiple: 1.6,
			}),
		).toEqual({ stop: true, reason: "cost_breach" });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				costP95Multiple: 2.1,
			}),
		).toEqual({ stop: true, reason: "cost_breach" });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				costP50Multiple: 1.4,
				costP95Multiple: 1.9,
			}),
		).toEqual({ stop: false, reason: null });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				latencyImprovePct: 9,
			}),
		).toEqual({ stop: true, reason: "latency_miss" });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				latencyImprovePct: 12,
			}),
		).toEqual({ stop: false, reason: null });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				spawnedAgentsP95Multiple: 2.5,
			}),
		).toEqual({ stop: true, reason: "spawned_agents_breach" });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				spawnedAgentsP95Multiple: 1.5,
			}),
		).toEqual({ stop: false, reason: null });
	});

	it("applies DSH dimension stops only after min sample except A4 cap", () => {
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				dshA1GetBranchErrorRate: 0.2,
				dshMinSampleMet: false,
			}),
		).toEqual({ stop: false, reason: null });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				dshA4CapViolations: 1,
				dshMinSampleMet: false,
			}),
		).toEqual({ stop: true, reason: "dsh_a4_cap" });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				dshA1GetBranchErrorRate: DSH_QUALITY_STOP.a1GetBranchErrorRate + 0.01,
				dshMinSampleMet: true,
			}),
		).toEqual({ stop: true, reason: "dsh_a1_get_branch" });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				dshA23ZeroInjectionRate: DSH_QUALITY_STOP.a23ZeroInjectionRate + 0.01,
				dshMinSampleMet: true,
			}),
		).toEqual({ stop: true, reason: "dsh_a23_zero_injection" });
		expect(
			evaluateLatencyQualityStop({
				treatmentAttributedP0P1Escapes: 0,
				attributionKnown: true,
				dshNonInferiorityDropPp: DSH_QUALITY_STOP.nonInferiorityPp + 1,
				dshMinSampleMet: true,
			}),
		).toEqual({ stop: true, reason: "dsh_non_inferiority" });
	});

	it("disables only the target DSH dimension on stop", () => {
		const snapshot = freezeLatencyArmSnapshot({
			arms: {
				...emptyLatencyArms(),
				dsh_session_search: true,
				dsh_headless_continuation: true,
			},
			dimensions: [
				{
					id: "dim.a1",
					childArms: declaredDimensionArms("dim.a1"),
					assignedTreatment: true,
					treatment: true,
					stopApplied: false,
					role: "treatment",
					cohortKey: "dsh:dim.a1:t|bg:none",
					controlKey: "dsh:dim.a1:c|bg:none",
				},
				{
					id: "dim.a4",
					childArms: declaredDimensionArms("dim.a4"),
					assignedTreatment: true,
					treatment: true,
					stopApplied: false,
					role: "treatment",
					cohortKey: "dsh:dim.a4:t|bg:none",
					controlKey: "dsh:dim.a4:c|bg:none",
				},
			],
		});
		const decision = buildLatencyRolloutDecision({
			workflowId: "wf-dsh",
			status: "completed",
			snapshot,
			observed: {
				completion: true,
				repairCycles: 0,
				treatmentAttributedP0P1Escapes: 0,
				costUsd: null,
				stageTimeMs: 0,
				spawnedAgents: null,
			},
			firedArms: ["dsh_session_search"],
			targetDimensionId: "dim.a1",
			dsh: { a1GetBranchErrorRate: 0.2, minSampleMet: true },
		});
		expect(decision.decision).toEqual({ stop: true, reason: "dsh_a1_get_branch" });
		expect(decision.disabledArms).toEqual(["dsh_session_search"]);
	});

	it("builds a persisted rollout decision with attribution and disables arms on stop", () => {
		const snapshot = freezeLatencyArmSnapshot({
			arms: { ...emptyLatencyArms(), bash_advisory: true, bash_bounded_injection: true },
			combinedArmId: "combined:bash_advisory+bash_bounded_injection",
			childArms: ["bash_advisory", "bash_bounded_injection"],
			codeRevision: "rev-1",
			configHash: "cfg-1",
			frozenAt: "2026-08-07T00:00:00.000Z",
		});
		const clean = buildLatencyRolloutDecision({
			workflowId: "wf-1",
			status: "completed",
			snapshot,
			observed: {
				completion: true,
				repairCycles: 0,
				treatmentAttributedP0P1Escapes: 0,
				costUsd: 0.1,
				stageTimeMs: 1000,
				spawnedAgents: null,
			},
		});
		expect(clean.attributionKnown).toBe(true);
		expect(clean.decision).toEqual({ stop: false, reason: null });
		expect(clean.disabledArms).toEqual([]);

		const escaping = buildLatencyRolloutDecision({
			workflowId: "wf-2",
			status: "completed",
			snapshot,
			observed: {
				completion: true,
				repairCycles: 0,
				treatmentAttributedP0P1Escapes: 1,
				costUsd: 0.1,
				stageTimeMs: 1000,
				spawnedAgents: null,
			},
		});
		expect(escaping.decision).toEqual({ stop: true, reason: "p0p1_escape" });
		expect(escaping.disabledArms).toEqual(["bash_advisory", "bash_bounded_injection"]);

		const cohortBreach = buildLatencyRolloutDecision({
			workflowId: "wf-3",
			status: "completed",
			snapshot,
			observed: {
				completion: true,
				repairCycles: 0,
				treatmentAttributedP0P1Escapes: 0,
				costUsd: 0.1,
				stageTimeMs: 1000,
				spawnedAgents: null,
			},
			cohort: { completionDropPp: 3 },
		});
		expect(cohortBreach.decision).toEqual({ stop: true, reason: "completion_drop" });
	});

	it("fails closed on an unregistered multi-arm snapshot", () => {
		const unregistered = freezeLatencyArmSnapshot({
			arms: { ...emptyLatencyArms(), context_optimization: true, read_dedupe: true },
			frozenAt: "2026-08-07T00:00:00.000Z",
		});
		const decision = buildLatencyRolloutDecision({
			workflowId: "wf-4",
			status: "completed",
			snapshot: unregistered,
			observed: {
				completion: true,
				repairCycles: 0,
				treatmentAttributedP0P1Escapes: 0,
				costUsd: 0.1,
				stageTimeMs: 1000,
				spawnedAgents: null,
			},
		});
		expect(decision.attributionKnown).toBe(false);
		expect(decision.decision).toEqual({ stop: true, reason: "missing_attribution" });
		expect(decision.disabledArms).toEqual(["context_optimization", "read_dedupe"]);
	});

	it("disables only fired arms when a stop fires and fails closed when none fired", () => {
		const snapshot = freezeLatencyArmSnapshot({
			arms: { ...emptyLatencyArms(), bash_advisory: true, bash_bounded_injection: true },
			combinedArmId: "combined:bash_advisory+bash_bounded_injection",
			childArms: ["bash_advisory", "bash_bounded_injection"],
			frozenAt: "2026-08-07T00:00:00.000Z",
		});
		const observed = {
			completion: true,
			repairCycles: 0,
			treatmentAttributedP0P1Escapes: 1,
			costUsd: 0.1,
			stageTimeMs: 1000,
			spawnedAgents: null,
		};
		// Only the fired arm is causally rollbackable.
		const fired = buildLatencyRolloutDecision({
			workflowId: "wf-5",
			status: "completed",
			snapshot,
			observed,
			firedArms: ["bash_advisory"],
		});
		expect(fired.decision).toEqual({ stop: true, reason: "p0p1_escape" });
		expect(fired.disabledArms).toEqual(["bash_advisory"]);
		// No fired arm + a stop → fail closed on the whole active set.
		const noneFired = buildLatencyRolloutDecision({
			workflowId: "wf-6",
			status: "completed",
			snapshot,
			observed,
			firedArms: [],
		});
		expect(noneFired.disabledArms).toEqual(["bash_advisory", "bash_bounded_injection"]);
		// Unknown fired arm ids are ignored.
		const bogus = buildLatencyRolloutDecision({
			workflowId: "wf-7",
			status: "completed",
			snapshot,
			observed,
			firedArms: ["not_an_arm" as never],
		});
		expect(bogus.disabledArms).toEqual(["bash_advisory", "bash_bounded_injection"]);
	});

	it("passes cohort thresholds into the stop decision", () => {
		const snapshot = freezeLatencyArmSnapshot({
			arms: { ...emptyLatencyArms(), read_dedupe: true },
			frozenAt: "2026-08-07T00:00:00.000Z",
		});
		const base = {
			workflowId: "wf-8",
			status: "completed",
			snapshot,
			observed: {
				completion: true,
				repairCycles: 0,
				treatmentAttributedP0P1Escapes: 0,
				costUsd: 0.1,
				stageTimeMs: 1000,
				spawnedAgents: null,
			},
		};
		expect(buildLatencyRolloutDecision({ ...base, cohort: { reworkRisePct: 15 } }).decision).toEqual({
			stop: true,
			reason: "rework_rise",
		});
		expect(buildLatencyRolloutDecision({ ...base, cohort: { costP50Multiple: 1.6 } }).decision).toEqual({
			stop: true,
			reason: "cost_breach",
		});
		expect(buildLatencyRolloutDecision({ ...base, cohort: { costP95Multiple: 2.1 } }).decision).toEqual({
			stop: true,
			reason: "cost_breach",
		});
		expect(buildLatencyRolloutDecision({ ...base, cohort: { latencyImprovePct: 8 } }).decision).toEqual({
			stop: true,
			reason: "latency_miss",
		});
		expect(buildLatencyRolloutDecision({ ...base, cohort: { spawnedAgentsP95Multiple: 3 } }).decision).toEqual({
			stop: true,
			reason: "spawned_agents_breach",
		});
		expect(buildLatencyRolloutDecision({ ...base, cohort: { completionDropPp: 1 } }).decision).toEqual({
			stop: false,
			reason: null,
		});
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
		expect(validateConcurrencyDeclaration(overlap).errors.some(e => e.code === "path_overlap")).toBe(true);

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

	it("rejects tampered fingerprints and same isolationScope with disjoint paths", () => {
		const valid = buildConcurrencyDeclaration({
			declarationId: "d-iso",
			ownerKind: "workflow",
			ownerId: "wf-1",
			scopeArtifactRef: "artifact://plan",
			scopeArtifactSha256: "b".repeat(64),
			revision: 0,
			maxConcurrency: 2,
			completionPolicy: { kind: "all_required", minSuccesses: null },
			failurePolicy: "fail_closed",
			cancelPolicy: "cascade_dependents",
			units: [
				{
					id: "w1",
					assignment: "write a",
					paths: ["src/a.ts"],
					dependsOn: [],
					mode: "write",
					required: true,
					idempotencyKey: "w1",
					isolationScope: "workspace",
				},
				{
					id: "w2",
					assignment: "write b",
					paths: ["src/b.ts"],
					dependsOn: [],
					mode: "write",
					required: true,
					idempotencyKey: "w2",
					isolationScope: "workspace",
				},
			],
		});
		const isolation = validateConcurrencyDeclaration(valid);
		expect(isolation.ok).toBe(false);
		expect(isolation.errors.some(e => e.code === "isolation_overlap")).toBe(true);
		expect(shouldAutoParallel(valid.units)).toBe(false);

		const clean = buildConcurrencyDeclaration({
			...valid,
			declarationId: "d-fp",
			units: [
				{ ...valid.units[0]!, isolationScope: undefined },
				{ ...valid.units[1]!, isolationScope: undefined },
			],
		});
		expect(validateConcurrencyDeclaration(clean).ok).toBe(true);
		const tampered = { ...clean, fingerprint: "0".repeat(64) };
		const fp = validateConcurrencyDeclaration(tampered);
		expect(fp.ok).toBe(false);
		expect(fp.errors.some(e => e.code === "fingerprint_mismatch")).toBe(true);
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

	it("treats mechanical implementer class as Flash-eligible when the arm is on", () => {
		const mech = buildMechanicalClass({
			class: "mechanical_implement",
			source: "deterministic_rule",
			ref: "plan_scope:single_file_single_step",
			targetRole: "implementer",
		});
		expect(isMechanicalFlashEligible(mech, true)).toBe(true);
		expect(isMechanicalFlashEligible(mech, false)).toBe(false);
		expect(parseWorkflowMechanicalClass(mech)).toEqual(mech);
	});

	it("rejects incomplete mechanical evidence before Flash routing", () => {
		const missingRef = {
			schemaVersion: 1,
			class: "mechanical_repair",
			evidence: { source: "accepted_finding" },
			targetRole: "repair",
			requestedModelClass: "flash",
		};
		expect(parseWorkflowMechanicalClass(missingRef)).toBeNull();
		expect(isMechanicalFlashEligible(missingRef as never, true)).toBe(false);

		const badSchema = {
			schemaVersion: 2,
			class: "mechanical_repair",
			evidence: { source: "caller_declaration" },
			targetRole: "repair",
			requestedModelClass: "flash",
		};
		expect(parseWorkflowMechanicalClass(badSchema)).toBeNull();
		expect(isMechanicalFlashEligible(badSchema as never, true)).toBe(false);

		const validCaller = buildMechanicalClass({
			class: "mechanical_repair",
			source: "caller_declaration",
			targetRole: "repair",
		});
		expect(parseWorkflowMechanicalClass(validCaller)).toEqual(validCaller);
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
