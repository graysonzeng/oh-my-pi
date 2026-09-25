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
	clampSummary,
	STAGE_HANDOFF_KIND,
	STAGE_HANDOFF_SUMMARY_MAX,
	serializeStageHandoff,
	syntheticArtifactRef,
} from "../../src/workflow/stage-handoff";
import {
	boundOutputFragment,
	defaultSchemaValidator,
	extractJsonValue,
	renderSchemaRetryPrompt,
	repairStructuredOutput,
	type SchemaRepairReceiptV1,
	stripInvisibleChars,
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
	it("runs paired baseline/optimized with 30 cases and at least 5 reps", async () => {
		const suite = buildDefaultBenchmarkSuite();
		expect(suite.cases.length).toBe(30);
		expect(suite.cases.every(c => c.repetitions >= 5)).toBe(true);

		const results = await runBenchmarkSuite({
			suite,
			runtime: createFakeBenchmarkRuntime(),
			optimizedProfileId: "grok_implementer",
			optimizedStrategyFingerprint: "smart-v1",
		});
		// N cases × 2 variants × 5 reps
		expect(results.length).toBe(suite.cases.length * 2 * 5);
		const scorecard = buildScorecard(suite, results);
		expect(scorecard.liveQualityUnknown).toBe(true);
		expect(scorecard.summaries.length).toBe(suite.cases.length * 2);
		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(true);

		// Optimized tool results smaller than baseline on average
		const firstId = suite.cases[0]!.id;
		const base = scorecard.summaries.find(s => s.caseId === firstId && s.variant === "baseline")!;
		const opt = scorecard.summaries.find(s => s.caseId === firstId && s.variant === "optimized")!;
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
		const first = suite.cases[0]!;
		const oneCase = { ...suite, cases: [first] };
		const results = await runBenchmarkSuite({
			suite: oneCase,
			runtime,
			variants: ["optimized"],
		});
		// repetition 2 uses failure dump with footer
		const failRep = results.find(r => r.repetition === 2)!;
		expect(failRep.stage.compressionReceipts.length).toBeGreaterThan(0);
		expect(failRep.stage.compressionReceipts[0]?.recoveryUri).toBe(`artifact://fixture-${first.id}`);
	});
});

describe("P1 stage handoff", () => {
	it("planner→implementer is deterministic and uses OBJECTIVE field shape", () => {
		const plan = samplePlan();
		const planRef = syntheticArtifactRef("art_plan_1", plan);
		const a = buildPlannerToImplementerHandoff({ plan, planRef });
		const b = buildPlannerToImplementerHandoff({ plan, planRef });
		expect(a.kind).toBe(STAGE_HANDOFF_KIND);
		expect(a.fromStage).toBe("planning");
		expect(a.toStage).toBe("implementing");
		expect(a.contentFingerprint).toBe(b.contentFingerprint);
		expect(serializeStageHandoff(a)).toBe(serializeStageHandoff(b));
		expect(a.preservedItems.some(p => p.kind === "plan" && p.summary.startsWith("goal:") && p.blocking)).toBe(true);
		expect(a.preservedItems.some(p => p.summary.startsWith("acceptance:") && p.blocking)).toBe(true);
		expect(a.bytesBeforeHandoff).toBe(planRef.bytes);
		expect(a.bytesAfterHandoff).toBeLessThan(a.bytesBeforeHandoff);
		expect(a.bytesAfterHandoff).toBe(a.preservedItems.reduce((s, p) => s + p.bytes, 0));
		expect(a.omittedArtifactIds).toContain(planRef.artifactId);
		expect(a.recoveryUris).toContain(planRef.recoveryUri);
		expect(a.preservedItems.every(p => p.summary.length <= STAGE_HANDOFF_SUMMARY_MAX)).toBe(true);
	});

	it("reviewer→repair never drops open blocking findings", () => {
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
				{
					id: "f-resolved",
					priority: "P2",
					category: "maintainability",
					status: "resolved",
					confidence: 0.5,
					summary: "style",
					explanation: "fixed",
					suggestedOwner: "implementer",
					blocking: false,
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
		const reviewRef = syntheticArtifactRef("art_review_1", review);
		const vRef = syntheticArtifactRef("art_ver_1", verification);
		const handoff = buildReviewerToRepairHandoff({
			review,
			verification,
			reviewRef,
			verificationRef: vRef,
		});
		const blockingItems = handoff.preservedItems.filter(
			p => p.kind === "finding" && p.blocking && p.summary.includes("f1"),
		);
		expect(blockingItems.length).toBeGreaterThanOrEqual(1);
		expect(blockingItems.every(p => p.blocking)).toBe(true);
		// Resolved findings must not appear as preserved blocking extracts.
		expect(handoff.preservedItems.some(p => p.summary.includes("f-resolved"))).toBe(false);
		expect(
			handoff.preservedItems.some(p => p.kind === "verification" && p.blocking && p.summary.includes("t1")),
		).toBe(true);
		expect(handoff.fromStage).toBe("code_review");
		expect(handoff.toStage).toBe("repairing");
		expect(handoff.bytesBeforeHandoff).toBe(reviewRef.bytes + vRef.bytes);
		expect(handoff.bytesAfterHandoff).toBeLessThanOrEqual(handoff.bytesBeforeHandoff);
		expect(handoff.recoveryUris).toEqual(expect.arrayContaining([reviewRef.recoveryUri, vRef.recoveryUri]));
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
		const patchRef = {
			artifactId: "art_patch_9",
			bytes: 128,
			recoveryUri: "artifact://patch-9",
		};
		const h = buildImplementerToReviewerHandoff({
			implementation: impl,
			plan: samplePlan(),
			patchRef,
			implRef: syntheticArtifactRef("art_impl_1", impl),
			planRef: syntheticArtifactRef("art_plan_1", samplePlan()),
		});
		expect(h.recoveryUris).toContain("artifact://patch-9");
		expect(h.preservedItems.find(p => p.summary.startsWith("changed_files:"))?.blocking).toBe(true);
		const patchItem = h.preservedItems.find(p => p.summary.startsWith("patch:"));
		expect(patchItem?.blocking).toBe(true);
		expect(patchItem?.summary).toContain("patches/x.patch");
		expect(h.fromStage).toBe("implementing");
		expect(h.toStage).toBe("code_review");
		expect(h.bytesBeforeHandoff).toBeGreaterThan(h.bytesAfterHandoff);
	});

	it("clampSummary enforces 500-char cap without model calls", () => {
		const long = "x".repeat(600);
		const clamped = clampSummary(long);
		expect(clamped.length).toBe(STAGE_HANDOFF_SUMMARY_MAX);
		const plan = samplePlan();
		plan.summary = long;
		const handoff = buildPlannerToImplementerHandoff({ plan });
		expect(handoff.preservedItems.every(p => p.summary.length <= STAGE_HANDOFF_SUMMARY_MAX)).toBe(true);
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
		expect(result.receipt.layer1Success).toBe(true);
		expect(result.receipt.finalStatus).toBe("repaired_layer1");
		expect(result.receipt.budgetExhausted).toBe(false);
	});

	it("strips zero-width chars and extracts prose-wrapped JSON with zero model calls", async () => {
		// ZWSP around keys / BOM + surrounding prose
		const raw = `Here is the output:\n\uFEFF{\u200B"summary":\u200C"clean"\u200D}\nDone.`;
		expect(stripInvisibleChars("\u200B\uFEFFhi\u200C")).toBe("hi");
		const result = await repairStructuredOutput(raw, {
			maxRetries: 1,
			schema,
			validate: defaultSchemaValidator,
			retryWithModel: async () => {
				throw new Error("should not call model");
			},
		});
		expect(result.ok).toBe(true);
		expect(result.value).toEqual({ summary: "clean" });
		expect(result.receipt.modelCalls).toBe(0);
		expect(result.receipt.layer1Success).toBe(true);
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
		expect(result.receipt.finalStatus).toBe("schema_error");
		expect(result.receipt.violationHistory.length).toBeGreaterThan(0);
	});

	it("does not guess enum values or coerce types", async () => {
		const enumSchema = {
			type: "object",
			required: ["status", "count"],
			properties: {
				status: { type: "string", enum: ["open", "resolved"] },
				count: { type: "number" },
			},
		};
		const badEnum = await repairStructuredOutput(`{"status":"pending","count":1}`, {
			maxRetries: 0,
			schema: enumSchema,
			validate: defaultSchemaValidator,
		});
		expect(badEnum.ok).toBe(false);
		expect(badEnum.error).toMatch(/enum/i);
		// String "123" must not become number 123
		const badType = await repairStructuredOutput(`{"status":"open","count":"123"}`, {
			maxRetries: 0,
			schema: enumSchema,
			validate: defaultSchemaValidator,
		});
		expect(badType.ok).toBe(false);
		expect(badType.error).toMatch(/expected number/i);
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
			retryWithModel: async prompt => {
				calls += 1;
				expect(prompt).toMatch(/violated the required output schema/i);
				expect(prompt).toMatch(/no JSON value extracted|Violations/i);
				expect(prompt).toMatch(/not json|Previous output/i);
				if (calls < 2) return "still bad";
				return `{"summary":"fixed"}`;
			},
			budget: { remainingModelCalls: 10 },
		});
		expect(result.ok).toBe(true);
		expect(calls).toBe(2);
		expect(result.receipt.modelCalls).toBe(2);
		expect(result.receipt.layer3RetryCount).toBe(2);
		expect(result.receipt.finalStatus).toBe("repaired_layer3");
	});

	it("maxRetries=0 allows no model retry; maxRetries=1 allows one", async () => {
		let calls0 = 0;
		const r0 = await repairStructuredOutput("not json", {
			maxRetries: 0,
			schema,
			validate: defaultSchemaValidator,
			retryWithModel: async () => {
				calls0 += 1;
				return `{"summary":"x"}`;
			},
			budget: { remainingModelCalls: 10 },
		});
		expect(r0.ok).toBe(false);
		expect(calls0).toBe(0);

		let calls1 = 0;
		const r1 = await repairStructuredOutput("not json", {
			maxRetries: 1,
			schema,
			validate: defaultSchemaValidator,
			retryWithModel: async () => {
				calls1 += 1;
				return `{"summary":"x"}`;
			},
			budget: { remainingModelCalls: 10 },
		});
		expect(r1.ok).toBe(true);
		expect(calls1).toBe(1);
	});

	it("checks budget before model retry (requests / cost / runtime)", async () => {
		for (const budget of [{ remainingModelCalls: 0 }, { remainingCostUsd: 0 }, { remainingTimeMs: 0 }] as const) {
			let calls = 0;
			const result = await repairStructuredOutput(`not json`, {
				maxRetries: 3,
				schema,
				validate: defaultSchemaValidator,
				retryWithModel: async () => {
					calls += 1;
					return "nope";
				},
				budget: { remainingModelCalls: 10, ...budget },
			});
			expect(result.ok).toBe(false);
			expect(calls).toBe(0);
			expect(result.receipt.budgetExhausted).toBe(true);
			expect(result.receipt.finalStatus).toBe("budget_exhausted");
			expect(result.receipt.budgetExhaustedReason).toBeDefined();
		}
	});

	it("extractJsonValue pulls object from surrounding prose", () => {
		const got = extractJsonValue(`Here is the output:\n{"summary":"x","n":1}\nDone.`);
		expect(got?.value).toEqual({ summary: "x", n: 1 });
	});

	it("boundOutputFragment keeps head+tail 500 chars", () => {
		const long = `${"A".repeat(600)}MID${"B".repeat(600)}`;
		const frag = boundOutputFragment(long);
		expect(frag.startsWith("A".repeat(500))).toBe(true);
		expect(frag.endsWith("B".repeat(500))).toBe(true);
		expect(frag).toContain("…truncated…");
	});

	it("renderSchemaRetryPrompt fills static template variables", () => {
		const prompt = renderSchemaRetryPrompt({
			violation: "missing required field: summary",
			schemaTypeName: "object",
			schemaFields: "required: summary",
			previousOutputPreview: '{"other":1}',
			attemptNumber: 2,
		});
		expect(prompt).toContain("missing required field: summary");
		expect(prompt).toContain("required: summary");
		expect(prompt).toContain('{"other":1}');
		expect(prompt).toContain("2");
		// Must come from static .hbs.md, not ad-hoc business paragraphs only in TS.
		expect(prompt).toMatch(/violated the required output schema/i);
	});

	it("receipt includes attempt output previews and violation history on failure", async () => {
		const result = await repairStructuredOutput(`{"other":1}`, {
			maxRetries: 1,
			schema,
			validate: defaultSchemaValidator,
			retryWithModel: async () => `{"still":"wrong"}`,
			budget: { remainingModelCalls: 5 },
		});
		expect(result.ok).toBe(false);
		const receipt = result.receipt as SchemaRepairReceiptV1;
		expect(receipt.totalAttempts).toBeGreaterThan(0);
		expect(receipt.violationHistory.length).toBeGreaterThan(0);
		expect(receipt.attempts.some(a => typeof a.outputPreview === "string")).toBe(true);
		expect(receipt.finalStatus).toBe("schema_error");
	});
});

describe("P1 scope metrics", () => {
	it("hard-violates forbidden writes and warns on unplanned", () => {
		const plan = samplePlan();
		const metrics = buildScopeMetrics({
			plannedFiles: plannedFilesFromPlan(plan),
			forbiddenFiles: ["package.json", ".env"],
			changedFiles: ["src/a.ts", "src/extra.ts", "package.json"],
			deletedFiles: [],
			diffLines: { insertions: 10, deletions: 2 },
			interactive: false,
		});
		expect(metrics.status).toBe("violation");
		expect(metrics.diffLines).toBe(12);
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
	it("serializes same-path writes and mutating bash; allows read-only bash concurrent with reads", () => {
		const w1 = inferResourceClaim("write", { path: "src/a.ts" });
		const w2 = inferResourceClaim("edit", { path: "src/a.ts" });
		const r1 = inferResourceClaim("read", { path: "src/a.ts" });
		const bashRm = inferResourceClaim("bash", { command: "rm -rf ." });
		const bashEcho = inferResourceClaim("bash", { command: "echo hello" });
		expect(claimsConflict(w1, w2, "serialize")).toBe(true);
		expect(claimsConflict(r1, r1, "serialize")).toBe(false);
		expect(claimsConflict(bashRm, w1, "serialize")).toBe(true);
		expect(bashRm.exclusive).toBe(true);
		expect(bashEcho.exclusive).toBe(false);
		expect(bashEcho.access).toBe("read");
		// Non-mutating bash may concurrent with pure reads.
		expect(claimsConflict(bashEcho, r1, "serialize")).toBe(false);
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
