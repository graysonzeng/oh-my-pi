import { describe, expect, it } from "bun:test";
import {
	buildDefaultBenchmarkSuite,
	buildScorecard,
	createFakeBenchmarkRuntime,
	evaluateBenchmarkQualityGate,
	runBenchmarkSuite,
} from "../../src/workflow/benchmark";
import {
	applyPresentationPolicy,
	assertRestrictedToolDiscovery,
	DEFAULT_PRESENTATION_POLICY,
} from "../../src/workflow/presentation-policy";
import { assemblePrompt, cacheMetricsFromReceipt } from "../../src/workflow/prompt-assembly";
import { buildScopeMetrics, plannedFilesFromPlan } from "../../src/workflow/scope-metrics";
import {
	buildImplementerToReviewerHandoff,
	buildPlannerToImplementerHandoff,
	buildReviewerToRepairHandoff,
	serializeStageHandoff,
} from "../../src/workflow/stage-handoff";
import {
	defaultSchemaValidator,
	extractJsonValue,
	repairStructuredOutput,
	totalSchemaModelAttempts,
} from "../../src/workflow/structured-output-repair";
import {
	ConcurrencyLimiter,
	claimsConflict,
	inferResourceClaim,
	ToolCallBudget,
} from "../../src/workflow/tool-scheduling";
import type {
	ImplementationArtifactV1,
	PlanArtifactV1,
	ReviewArtifactV1,
	VerificationArtifactV1,
} from "../../src/workflow/types";

const baseHeader = {
	schemaVersion: 1 as const,
	workflowId: "wf",
	attemptId: "att",
	stage: "planning" as const,
	createdAt: "2026-07-25T00:00:00.000Z",
};

function samplePlan(): PlanArtifactV1 {
	return {
		...baseHeader,
		kind: "plan",
		summary: "Add feature X",
		assumptions: ["repo builds"],
		nonGoals: ["rewrite"],
		affectedFiles: [{ path: "src/a.ts", action: "modify", reason: "core" }],
		implementationSteps: [{ id: "s1", description: "edit a", dependsOn: [] }],
		acceptanceCriteria: ["tests pass"],
		verificationCommands: ["bun test"],
		risks: ["low"],
		rollback: ["revert"],
	};
}

describe("P0 benchmark suite + fake runtime", () => {
	it("runs paired baseline/optimized with ≥10 cases and ≥3 reps", async () => {
		const suite = buildDefaultBenchmarkSuite();
		expect(suite.cases.length).toBeGreaterThanOrEqual(10);
		expect(suite.cases.every(c => c.repetitions >= 3)).toBe(true);

		const results = await runBenchmarkSuite({
			suite,
			runtime: createFakeBenchmarkRuntime(),
			optimizedProfileId: "grok_implementer",
			optimizedStrategyFingerprint: "smart-v1",
		});
		// 10 cases × 2 variants × 3 reps
		expect(results.length).toBe(10 * 2 * 3);
		const scorecard = buildScorecard(suite, results);
		expect(scorecard.liveQualityUnknown).toBe(true);
		expect(scorecard.summaries.length).toBe(20);
		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(true);

		// Optimized tool results smaller than baseline on average
		const base = scorecard.summaries.find(s => s.caseId === "case_01" && s.variant === "baseline")!;
		const opt = scorecard.summaries.find(s => s.caseId === "case_01" && s.variant === "optimized")!;
		expect(opt.meanEstimatedTokens).not.toBeNull();
		expect(base.meanEstimatedTokens).not.toBeNull();
		expect(opt.meanEstimatedTokens!).toBeLessThan(base.meanEstimatedTokens!);

		// Unknown cache when not observable
		const run = opt.runs[0]!;
		expect(run.tokens.cacheObservable).toBe(false);
		expect(run.tokens.cacheReadTokens.value).toBeNull();
		expect(run.tokens.ttftMs.value).toBeNull();
	});

	it("preserves artifact footer through optimized fake runtime failure dump", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const runtime = createFakeBenchmarkRuntime();
		const oneCase = { ...suite, cases: [suite.cases[0]!] };
		const results = await runBenchmarkSuite({
			suite: oneCase,
			runtime,
			variants: ["optimized"],
		});
		// repetition 2 uses failure dump with footer
		const failRep = results.find(r => r.repetition === 2)!;
		expect(failRep.stage.compressionReceipts.length).toBeGreaterThan(0);
		expect(failRep.stage.compressionReceipts[0]?.recoveryUri).toBe("artifact://fixture-case_01");
	});
});

describe("P1 stage handoff", () => {
	it("planner→implementer is deterministic by content fingerprint (not envelope ids)", () => {
		const plan = samplePlan();
		const a = buildPlannerToImplementerHandoff({ plan, planRecoveryUri: "artifact://dynamic-1" });
		const b = buildPlannerToImplementerHandoff({ plan, planRecoveryUri: "artifact://dynamic-1" });
		expect(a.contentFingerprint).toBe(b.contentFingerprint);
		expect(serializeStageHandoff(a)).toBe(serializeStageHandoff(b));
		expect(a.preserved.some(p => p.key === "goal.summary" && p.blocking)).toBe(true);
		expect(a.preserved.some(p => p.key === "acceptance" && p.blocking)).toBe(true);
	});

	it("reviewer→repair never drops blocking findings", () => {
		const review: ReviewArtifactV1 = {
			...baseHeader,
			stage: "code_review",
			kind: "review",
			subject: "implementation",
			decision: "changes_requested",
			findings: [
				{
					id: "f1",
					priority: "P0",
					category: "correctness",
					status: "open",
					confidence: 0.9,
					summary: "bug",
					explanation: "null deref",
					file: "src/a.ts",
					line: 10,
					suggestedOwner: "implementer",
					blocking: true,
				},
			],
			explanation: "needs fix",
			confidence: 0.8,
		};
		const verification: VerificationArtifactV1 = {
			...baseHeader,
			stage: "implementation_verify",
			kind: "verification",
			passed: false,
			checks: [{ id: "t1", status: "failed", summary: "assert failed", exitCode: 1 }],
		};
		const handoff = buildReviewerToRepairHandoff({ review, verification });
		const blocking = handoff.preserved.find(p => p.key === "review.blocking_findings")!;
		expect(blocking.blocking).toBe(true);
		expect(blocking.content).toContain("f1");
		expect(handoff.preserved.find(p => p.key === "verification.failed")?.blocking).toBe(true);
	});

	it("implementer→reviewer keeps patch + changed files as blocking", () => {
		const impl: ImplementationArtifactV1 = {
			...baseHeader,
			stage: "implementing",
			kind: "implementation",
			summary: "done",
			changedFiles: ["src/a.ts"],
			addressedStepIds: ["s1"],
			commandsRun: [{ command: "bun test", exitCode: 0, summary: "ok" }],
			patchPath: "patches/x.patch",
			unresolved: [],
		};
		const h = buildImplementerToReviewerHandoff({
			implementation: impl,
			plan: samplePlan(),
			patchRecoveryUri: "artifact://patch-9",
		});
		expect(h.preserved.find(p => p.key === "patch")?.recoveryUri).toBe("artifact://patch-9");
		expect(h.preserved.find(p => p.key === "changed_files")?.blocking).toBe(true);
	});
});

describe("P1 structured-output repair", () => {
	const schema = {
		type: "object",
		properties: { summary: { type: "string" } },
		required: ["summary"],
	};

	it("extracts fenced JSON and BOM without model calls", async () => {
		const raw = `\uFEFF\`\`\`json\n{"summary":"ok"}\n\`\`\``;
		const result = await repairStructuredOutput(raw, {
			maxRetries: 2,
			schema,
			validate: defaultSchemaValidator,
			retryWithModel: async () => {
				throw new Error("should not call model");
			},
		});
		expect(result.ok).toBe(true);
		expect(result.value).toEqual({ summary: "ok" });
		expect(result.receipt.modelCalls).toBe(0);
	});

	it("does not invent missing fields", async () => {
		const raw = `{"other":1}`;
		const result = await repairStructuredOutput(raw, {
			maxRetries: 0,
			schema,
			validate: defaultSchemaValidator,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/missing required field: summary/);
	});

	it("maxRetries bounds additional model calls (0/1/2 → 0/1/2 retries)", async () => {
		expect(totalSchemaModelAttempts(0)).toBe(1);
		expect(totalSchemaModelAttempts(1)).toBe(2);
		expect(totalSchemaModelAttempts(2)).toBe(3);

		let calls = 0;
		const result = await repairStructuredOutput(`not json`, {
			maxRetries: 2,
			schema,
			validate: defaultSchemaValidator,
			retryWithModel: async () => {
				calls += 1;
				if (calls < 2) return "still bad";
				return `{"summary":"fixed"}`;
			},
			budget: { remainingModelCalls: 10 },
		});
		expect(result.ok).toBe(true);
		expect(calls).toBe(2);
		expect(result.receipt.modelCalls).toBe(2);
	});

	it("checks budget before model retry", async () => {
		let calls = 0;
		const result = await repairStructuredOutput(`not json`, {
			maxRetries: 3,
			schema,
			validate: defaultSchemaValidator,
			retryWithModel: async () => {
				calls += 1;
				return "nope";
			},
			budget: { remainingModelCalls: 0 },
		});
		expect(result.ok).toBe(false);
		expect(calls).toBe(0);
	});

	it("extractJsonValue pulls object from surrounding prose", () => {
		const got = extractJsonValue(`Here you go:\n{"summary":"x","n":1}\nThanks`);
		expect(got?.value).toEqual({ summary: "x", n: 1 });
	});
});

describe("P1 scope metrics", () => {
	it("hard-fails forbidden writes and warns on unplanned", () => {
		const plan = samplePlan();
		const metrics = buildScopeMetrics({
			plannedFiles: plannedFilesFromPlan(plan),
			forbiddenFiles: ["package.json", ".env"],
			changedFiles: ["src/a.ts", "src/extra.ts", "package.json"],
			deletedFiles: [],
			diffLines: { insertions: 10, deletions: 2 },
			interactive: false,
		});
		expect(metrics.status).toBe("hard_fail");
		expect(metrics.forbiddenFiles).toContain("package.json");
		expect(metrics.unplannedFiles).toContain("src/extra.ts");
		expect(metrics.userCorrections).toBeNull();
		expect(metrics.userRollbacks).toBeNull();
	});

	it("same inputs yield same fingerprint", () => {
		const input = {
			plannedFiles: ["src/a.ts"],
			changedFiles: ["src/a.ts"],
			forbiddenFiles: ["package.json"],
		};
		expect(buildScopeMetrics(input).contentFingerprint).toBe(buildScopeMetrics(input).contentFingerprint);
	});
});

describe("P2 presentation policy", () => {
	it("defaults to direct and never leaks tools outside allowlist", () => {
		const presented = applyPresentationPolicy({
			policy: DEFAULT_PRESENTATION_POLICY,
			allowedToolNames: ["read", "bash"],
			tools: [
				{ name: "read", summary: "read files" },
				{ name: "bash", summary: "run shell" },
				{ name: "write", summary: "write files" },
				{ name: "browser", summary: "browse" },
			],
		});
		expect(presented.mode).toBe("direct");
		expect(presented.toolOrder).toEqual(["bash", "read"]);
		expect(assertRestrictedToolDiscovery(presented, ["read", "bash"]).ok).toBe(true);
		expect(presented.tools.every(t => t.schemaAttached)).toBe(true);
	});

	it("catalog mode attaches schema only for essential tools", () => {
		const presented = applyPresentationPolicy({
			policy: { ...DEFAULT_PRESENTATION_POLICY, enabled: true, mode: "catalog" },
			allowedToolNames: ["read", "bash", "browser"],
			tools: [
				{ name: "read", summary: "read" },
				{ name: "bash", summary: "bash" },
				{ name: "browser", summary: "browser" },
			],
		});
		const browser = presented.tools.find(t => t.name === "browser")!;
		expect(browser.schemaAttached).toBe(false);
		expect(browser.schemaLocator).toBe("xd://tools/browser");
		const read = presented.tools.find(t => t.name === "read")!;
		expect(read.schemaAttached).toBe(true);
	});
});

describe("P2 prompt assembly receipt", () => {
	it("stable hash ignores dynamic sections; cache null when not observable", () => {
		const a = assemblePrompt({
			sections: [
				{ id: "system_static", content: "You are omp.", stable: true },
				{ id: "role_policy", content: "Implement carefully.", stable: true },
				{ id: "tool_presentation", content: "tools: bash,read", stable: true },
				{ id: "assignment", content: "Do task A", stable: false },
				{ id: "history", content: "turn 1", stable: false },
			],
			cacheObservable: false,
		});
		const b = assemblePrompt({
			sections: [
				{ id: "system_static", content: "You are omp.", stable: true },
				{ id: "role_policy", content: "Implement carefully.", stable: true },
				{ id: "tool_presentation", content: "tools: bash,read", stable: true },
				{ id: "assignment", content: "Do task B DIFFERENT", stable: false },
				{ id: "history", content: "turn 99", stable: false },
			],
			cacheObservable: false,
		});
		expect(a.receipt.stableSha256).toBe(b.receipt.stableSha256);
		expect(a.receipt.dynamicSha256).not.toBe(b.receipt.dynamicSha256);
		const metrics = cacheMetricsFromReceipt(a.receipt);
		expect(metrics.cacheObservable).toBe(false);
		expect(metrics.cacheReadTokens).toBeNull();
	});

	it("records cache tokens only when cacheObservable", () => {
		const r = assemblePrompt({
			sections: [{ id: "system_static", content: "sys", stable: true }],
			cacheObservable: true,
			cacheReadTokens: 12,
			cacheWriteTokens: 3,
		});
		expect(r.receipt.cacheReadTokens).toBe(12);
		expect(r.receipt.cacheWriteTokens).toBe(3);
	});
});

describe("P2 tool scheduling helpers", () => {
	it("serializes same-path writes and unknown bash conservatively", () => {
		const w1 = inferResourceClaim("write", { path: "src/a.ts" });
		const w2 = inferResourceClaim("edit", { path: "src/a.ts" });
		const r1 = inferResourceClaim("read", { path: "src/a.ts" });
		const bash = inferResourceClaim("bash", { command: "rm -rf ." });
		expect(claimsConflict(w1, w2)).toBe(true);
		expect(claimsConflict(r1, r1)).toBe(false);
		expect(claimsConflict(bash, w1)).toBe(true);
	});

	it("budget reserve/release and concurrency limiter work", async () => {
		const budget = new ToolCallBudget(1);
		expect(budget.tryReserve(1)).toBe(true);
		expect(budget.tryReserve(1)).toBe(false);
		budget.release(1);
		expect(budget.tryReserve(1)).toBe(true);
		budget.commit(1);
		expect(budget.tryReserve(1)).toBe(false);

		const lim = new ConcurrencyLimiter(1);
		const order: number[] = [];
		const t1 = (async () => {
			const rel = await lim.acquire();
			order.push(1);
			await Bun.sleep(20);
			rel();
		})();
		const t2 = (async () => {
			const rel = await lim.acquire();
			order.push(2);
			rel();
		})();
		await Promise.all([t1, t2]);
		expect(order).toEqual([1, 2]);
	});
});
