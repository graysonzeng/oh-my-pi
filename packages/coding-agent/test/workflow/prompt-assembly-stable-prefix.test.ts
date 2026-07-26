/**
 * Phase 3 P2: cache-friendly stable prefix contracts.
 * Drives shipped assemblePrompt / prepareWorkflowInvocation / withProviderCacheMetrics —
 * never re-implements hash or section order in the test.
 */
import { describe, expect, it } from "bun:test";
import { type BenchmarkRuntime, buildDefaultBenchmarkSuite, runBenchmarkSuite } from "../../src/workflow/benchmark";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import {
	assemblePrompt,
	cacheMetricsFromReceipt,
	extractProviderCacheMetrics,
	PROMPT_ASSEMBLY_RECEIPT_KIND,
	type PromptSection,
	sectionByteBoundaries,
	withProviderCacheMetrics,
} from "../../src/workflow/prompt-assembly";
import { RuntimeAdapter, type StructuredRunner, type StructuredRunnerResult } from "../../src/workflow/runtime-adapter";
import { prepareWorkflowInvocation, splitDynamicContextSections } from "../../src/workflow/runtime-invocation";
import type { WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession } from "./helpers";

const STABLE_SECTIONS: PromptSection[] = [
	{ id: "system_static", content: "You are omp workflow agent.", stable: true },
	{ id: "role_policy", content: "Implement carefully; follow the plan.", stable: true },
	{ id: "tool_presentation", content: "bash,edit,read", stable: true },
	{ id: "skill_catalog", content: "skills: none", stable: true },
];

function withAssignment(assignment: string, extraDynamic?: PromptSection[]): PromptSection[] {
	return [
		...STABLE_SECTIONS,
		{ id: "assignment", content: assignment, stable: false },
		{ id: "repo_map", content: "src/a.ts\nsrc/b.ts", stable: false },
		{ id: "handoff", content: "Stage handoff body", stable: false },
		{ id: "history", content: "turn:0", stable: false },
		...(extraDynamic ?? []),
	];
}

function prepareBase(overrides: Partial<WorkflowAgentRequest> = {}): WorkflowAgentRequest {
	return {
		workflowId: "wf-stable-1",
		attemptId: "att-1",
		role: "implementer",
		profile: DEFAULT_MODEL_PROFILES.grok_implementer,
		assignment: "implement feature X",
		context: "handoff notes for feature X",
		session: fakeSession(),
		outputSchema: { type: "object" },
		...overrides,
	};
}

describe("P2 stable prefix hash consistency", () => {
	it("same profile/role sections + different assignment → same stableSha256, different dynamicSha256", () => {
		const a = assemblePrompt({ sections: withAssignment("Do task A"), cacheObservable: false });
		const b = assemblePrompt({ sections: withAssignment("Do task B COMPLETELY DIFFERENT"), cacheObservable: false });

		expect(a.receipt.stableSha256).toBe(b.receipt.stableSha256);
		expect(a.receipt.dynamicSha256).not.toBe(b.receipt.dynamicSha256);
		expect(a.receipt.stableBytes).toBeGreaterThan(0);
		expect(a.receipt.dynamicBytes).toBeGreaterThan(0);
		expect(a.receipt.stableBytes).toBe(b.receipt.stableBytes);
		expect(a.receipt.kind).toBe(PROMPT_ASSEMBLY_RECEIPT_KIND);
	});

	it("prepare path: different assignments share stable hash", () => {
		const p1 = prepareWorkflowInvocation(prepareBase({ assignment: "task one alpha" }));
		const p2 = prepareWorkflowInvocation(prepareBase({ assignment: "task two beta DIFFERENT" }));

		expect(p1.promptAssemblyReceipt.stableSha256).toBe(p2.promptAssemblyReceipt.stableSha256);
		expect(p1.promptAssemblyReceipt.dynamicSha256).not.toBe(p2.promptAssemblyReceipt.dynamicSha256);
		expect(p1.promptAssemblyReceipt.stableBytes).toBeGreaterThan(0);
		expect(p1.promptAssemblyReceipt.dynamicBytes).toBeGreaterThan(0);
		// Cache unknown at prepare time
		expect(p1.promptAssemblyReceipt.cacheObservable).toBe(false);
		expect(p1.promptAssemblyReceipt.cacheReadTokens).toBeNull();
		expect(p1.promptAssemblyReceipt.cacheWriteTokens).toBeNull();
		// Assignment text must not leak into the stable prefix (hash already proves it; also check text).
		expect(p1.assembledPromptText).toContain("task one alpha");
		expect(p2.assembledPromptText).toContain("task two beta DIFFERENT");
	});
});

describe("P2 prepare-path section membership and stable/dynamic boundary", () => {
	it("places system style + role BEFORE assignment; style/role not duplicated in dynamic handoff", () => {
		const assignment = "UNIQUE_ASSIGNMENT_TOKEN_xyz";
		const handoffBody = "UNIQUE_HANDOFF_TOKEN_abc";
		const prepared = prepareWorkflowInvocation(
			prepareBase({
				assignment,
				context: handoffBody,
			}),
		);
		const text = prepared.assembledPromptText;
		const order = prepared.promptAssemblyReceipt.sectionOrder;

		// Membership: stable sections present before dynamic ones.
		expect(order).toContain("system_static");
		expect(order).toContain("role_policy");
		expect(order).toContain("tool_presentation");
		expect(order).toContain("assignment");
		expect(order).toContain("handoff");
		const sysIdx = order.indexOf("system_static");
		const roleIdx = order.indexOf("role_policy");
		const toolIdx = order.indexOf("tool_presentation");
		const assignOrderIdx = order.indexOf("assignment");
		const handoffOrderIdx = order.indexOf("handoff");
		expect(sysIdx).toBeLessThan(assignOrderIdx);
		expect(roleIdx).toBeLessThan(assignOrderIdx);
		expect(toolIdx).toBeLessThan(assignOrderIdx);
		expect(assignOrderIdx).toBeLessThan(handoffOrderIdx);

		// Text order: style/role content appears before assignment (not only receipt metadata).
		const styleIdx = text.search(/Style:\s*explicit-grok|BEGIN NOW|ONLY job/i);
		const roleHeaderIdx = text.indexOf("Workflow Implementer");
		const assignIdx = text.indexOf(assignment);
		const handoffIdx = text.indexOf(handoffBody);
		expect(styleIdx).toBeGreaterThanOrEqual(0);
		expect(roleHeaderIdx).toBeGreaterThanOrEqual(0);
		expect(assignIdx).toBeGreaterThanOrEqual(0);
		expect(handoffIdx).toBeGreaterThanOrEqual(0);
		expect(styleIdx).toBeLessThan(assignIdx);
		expect(roleHeaderIdx).toBeLessThan(assignIdx);
		expect(assignIdx).toBeLessThan(handoffIdx);

		// Role header appears once — not re-injected into dynamic handoff after assignment.
		const roleHeader = "# Workflow Implementer";
		const roleHeaderCount = text.split(roleHeader).length - 1;
		expect(roleHeaderCount).toBe(1);

		// Style marker-only prefix is insufficient; real style body must be substantial.
		expect(prepared.promptAssemblyReceipt.stableBytes).toBeGreaterThan(200);
		// Dynamic suffix is handoff + assignment, not a second copy of the style body.
		const afterAssign = text.slice(assignIdx);
		expect(afterAssign).not.toMatch(/Style:\s*explicit-grok/i);
		expect(afterAssign).not.toContain(roleHeader);
		expect(afterAssign).toContain(handoffBody);

		// system_static is real style body, not a tiny `style:<marker>` tag.
		expect(text).not.toMatch(/^style:explicit-grok/m);
		expect(prepared.styleMarker).toBe("explicit-grok");
	});

	it("stable prefix ignores handoff body while dynamic includes it", () => {
		const p1 = prepareWorkflowInvocation(
			prepareBase({ assignment: "same assignment", context: "handoff version ONE" }),
		);
		const p2 = prepareWorkflowInvocation(
			prepareBase({ assignment: "same assignment", context: "handoff version TWO different" }),
		);
		expect(p1.promptAssemblyReceipt.stableSha256).toBe(p2.promptAssemblyReceipt.stableSha256);
		expect(p1.promptAssemblyReceipt.dynamicSha256).not.toBe(p2.promptAssemblyReceipt.dynamicSha256);
		expect(p1.assembledPromptText).toContain("handoff version ONE");
		expect(p2.assembledPromptText).toContain("handoff version TWO different");
	});
});

describe("P2 sectionOrder determinism + byte boundaries", () => {
	it("repeated builds yield identical sectionOrder and locatable boundaries", () => {
		const sections = withAssignment("stable task");
		const builds = Array.from({ length: 5 }, () => assemblePrompt({ sections, cacheObservable: false }));
		const first = builds[0]!;
		for (const b of builds) {
			expect(b.receipt.sectionOrder).toEqual(first.receipt.sectionOrder);
			expect(b.receipt.stableSha256).toBe(first.receipt.stableSha256);
			expect(b.receipt.dynamicSha256).toBe(first.receipt.dynamicSha256);
		}
		// Fixed order: stable then dynamic; empty optional sections skipped without reordering.
		expect(first.receipt.sectionOrder).toEqual([
			"system_static",
			"role_policy",
			"tool_presentation",
			"skill_catalog",
			"assignment",
			"repo_map",
			"handoff",
			"history",
		]);
		const bounds = sectionByteBoundaries(first, sections);
		expect(bounds.length).toBe(first.receipt.sectionOrder.length);
		let prevEnd = 0;
		for (const b of bounds) {
			expect(b.start).toBeGreaterThanOrEqual(prevEnd);
			expect(b.end).toBe(b.start + b.bytes);
			expect(b.bytes).toBeGreaterThan(0);
			prevEnd = b.end;
		}
		expect(bounds[bounds.length - 1]!.end).toBe(first.receipt.totalBytes);
	});

	it("empty optional sections skip without reordering survivors", () => {
		const r = assemblePrompt({
			sections: [
				{ id: "role_policy", content: "role", stable: true },
				{ id: "tool_presentation", content: "", stable: true }, // empty → skip
				{ id: "assignment", content: "do it", stable: false },
				{ id: "history", content: "", stable: false }, // empty → skip
			],
			cacheObservable: false,
		});
		expect(r.receipt.sectionOrder).toEqual(["role_policy", "assignment"]);
	});
});

describe("P2 unstable element isolation", () => {
	it("workflow ID / attempt ID only differ → same stable hash and not embedded in prompt text", () => {
		const a = prepareWorkflowInvocation(
			prepareBase({ workflowId: "wf-AAA", attemptId: "att-1", assignment: "same task" }),
		);
		const b = prepareWorkflowInvocation(
			prepareBase({ workflowId: "wf-BBB", attemptId: "att-999", assignment: "same task" }),
		);

		expect(a.promptAssemblyReceipt.stableSha256).toBe(b.promptAssemblyReceipt.stableSha256);
		expect(a.promptAssemblyReceipt.dynamicSha256).toBe(b.promptAssemblyReceipt.dynamicSha256);
		expect(a.assembledPromptText).toBe(b.assembledPromptText);
		expect(a.assembledPromptText).not.toContain("wf-AAA");
		expect(a.assembledPromptText).not.toContain("wf-BBB");
		expect(a.assembledPromptText).not.toContain("att-1");
		expect(a.assembledPromptText).not.toContain("att-999");
		expect(a.assembledPromptText).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no ISO timestamps
	});

	it("assemblePrompt pure path: IDs only in caller metadata stay out of text", () => {
		const metadata = { workflowId: "wf-meta-only", attemptId: "att-meta", ts: Date.now() };
		const r = assemblePrompt({
			sections: withAssignment("task"),
			cacheObservable: false,
		});
		expect(r.text).not.toContain(metadata.workflowId);
		expect(r.text).not.toContain(metadata.attemptId);
		expect(r.text).not.toContain(String(metadata.ts));
		// metadata not part of assembly input — receipt has no id fields
		expect(JSON.stringify(r.receipt)).not.toContain("wf-meta-only");
	});
});

describe("P2 provider cache metrics extraction + merge", () => {
	it("mock usage with cache counters populates receipt; without → graceful null", () => {
		const base = assemblePrompt({
			sections: withAssignment("cache task"),
			cacheObservable: false,
		});
		expect(base.receipt.cacheObservable).toBe(false);
		expect(base.receipt.cacheReadTokens).toBeNull();

		const withCache = withProviderCacheMetrics(base.receipt, {
			cacheRead: 1200,
			cacheWrite: 80,
			input: 100,
			output: 50,
		});
		expect(withCache.cacheObservable).toBe(true);
		expect(withCache.cacheReadTokens).toBe(1200);
		expect(withCache.cacheWriteTokens).toBe(80);
		expect(withCache.providerCacheReadTokens).toBe(1200);
		expect(withCache.providerCacheWriteTokens).toBe(80);
		// Hash fields unchanged by metrics merge
		expect(withCache.stableSha256).toBe(base.receipt.stableSha256);
		expect(withCache.dynamicSha256).toBe(base.receipt.dynamicSha256);

		const noUsage = withProviderCacheMetrics(base.receipt, undefined);
		expect(noUsage.cacheObservable).toBe(false);
		expect(noUsage.cacheReadTokens).toBeNull();
		expect(noUsage.cacheWriteTokens).toBeNull();

		const emptyObj = withProviderCacheMetrics(base.receipt, { input: 10, output: 5 });
		expect(emptyObj.cacheObservable).toBe(false);
		expect(emptyObj.cacheReadTokens).toBeNull();

		// Anthropic-style raw field names
		const anthropic = extractProviderCacheMetrics({
			cache_read_input_tokens: 500,
			cache_creation_input_tokens: 40,
		});
		expect(anthropic.cacheObservable).toBe(true);
		expect(anthropic.cacheReadTokens).toBe(500);
		expect(anthropic.cacheWriteTokens).toBe(40);

		// Never invent zeros when unobservable
		const metrics = cacheMetricsFromReceipt(base.receipt);
		expect(metrics.cacheReadTokens).toBeNull();
		expect(metrics.cacheWriteTokens).toBeNull();
	});

	it("RuntimeAdapter merges usage cache counters onto promptAssemblyReceipt", async () => {
		const runner: StructuredRunner = async () =>
			({
				result: {
					id: "raw_cache",
					structuredOutput: {
						status: "valid",
						data: { kind: "implementation", summary: "ok", changedFiles: [] },
					},
					patchPath: "patches/x.patch",
					usage: {
						input: 10,
						output: 20,
						cacheRead: 900,
						cacheWrite: 100,
						totalTokens: 1030,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				changesApplied: true,
			}) satisfies StructuredRunnerResult;

		const adapter = new RuntimeAdapter(runner);
		const result = await adapter.run({
			...prepareBase(),
			isolation: { requested: true, merge: "patch", apply: true },
		});
		expect(result.promptAssemblyReceipt).toBeDefined();
		expect(result.promptAssemblyReceipt!.cacheObservable).toBe(true);
		expect(result.promptAssemblyReceipt!.cacheReadTokens).toBe(900);
		expect(result.promptAssemblyReceipt!.cacheWriteTokens).toBe(100);
		expect(result.promptAssemblyReceipt!.stableSha256.length).toBe(64);
	});

	it("RuntimeAdapter without usage leaves cache unobservable (null, not zero)", async () => {
		const runner: StructuredRunner = async () =>
			({
				result: {
					id: "raw_no_usage",
					structuredOutput: {
						status: "valid",
						data: { kind: "implementation", summary: "ok", changedFiles: [] },
					},
					patchPath: "patches/x.patch",
					// no usage field
				},
				changesApplied: true,
			}) satisfies StructuredRunnerResult;

		const adapter = new RuntimeAdapter(runner);
		const result = await adapter.run({
			...prepareBase(),
			isolation: { requested: true, merge: "patch", apply: true },
		});
		expect(result.promptAssemblyReceipt!.cacheObservable).toBe(false);
		expect(result.promptAssemblyReceipt!.cacheReadTokens).toBeNull();
		expect(result.promptAssemblyReceipt!.cacheWriteTokens).toBeNull();
	});
});

describe("P2 splitDynamicContextSections", () => {
	it("extracts repo-map and history markers into separate sections", () => {
		const split = splitDynamicContextSections(
			["## Context", "body", "## Repo map", "src/a.ts", "## History", "turn 1"].join("\n"),
		);
		expect(split.repoMap).toContain("Repo map");
		expect(split.repoMap).toContain("src/a.ts");
		expect(split.history).toContain("History");
		expect(split.handoff).toContain("## Context");
		expect(split.handoff).not.toContain("src/a.ts");
	});
});

describe("P2 benchmark repeat cache metrics (fake runtime)", () => {
	it("3 repetitions record cold write then warm read without inventing hash-as-hit", async () => {
		const defaultSuite = buildDefaultBenchmarkSuite();
		const case0 = defaultSuite.cases[0]!;
		const suite = {
			...defaultSuite,
			id: "p2-cache-repeat",
			cases: [{ ...case0, id: "cache-repeat-case", repetitions: 3 }],
		};

		const runtime: BenchmarkRuntime = async req => {
			// Rep 1: cold (cache write); rep 2–3: warm (cache read). Hash never asserted as hit.
			const cold = req.repetition === 1;
			return {
				passed: true,
				firstPassed: true,
				qualityScore: 1,
				tokens: {
					inputTokens: { value: cold ? 2000 : 200, provenance: "provider_fact" },
					outputTokens: { value: 100, provenance: "provider_fact" },
					cacheReadTokens: {
						value: cold ? 0 : 1800,
						provenance: "provider_fact",
					},
					cacheWriteTokens: {
						value: cold ? 1800 : 0,
						provenance: "provider_fact",
					},
					systemPromptBytes: { value: 7200, provenance: "exact" },
					estimatedTotalTokens: { value: cold ? 2100 : 300, provenance: "estimate" },
					cacheObservable: true,
				},
			};
		};

		const runs = await runBenchmarkSuite({
			suite,
			runtime,
			variants: ["optimized"],
			liveQualityUnknown: true,
			notes: ["P2 cache-friendly prefix repeat harness — provider metrics SSOT, not hash"],
		});
		expect(runs.length).toBe(3);
		const [r1, r2, r3] = runs;
		expect(r1!.tokens.cacheWriteTokens.value).toBe(1800);
		expect(r1!.tokens.cacheReadTokens.value).toBe(0);
		expect(r2!.tokens.cacheReadTokens.value).toBe(1800);
		expect(r3!.tokens.cacheReadTokens.value).toBe(1800);
		expect(r2!.tokens.cacheObservable).toBe(true);
		// Stable-byte ratio from systemPromptBytes when available (corroboration only)
		const stableBytes = r2!.tokens.systemPromptBytes.value!;
		const cacheRead = r2!.tokens.cacheReadTokens.value!;
		expect(stableBytes).toBeGreaterThan(0);
		expect(cacheRead).toBeGreaterThan(0);
	});
});
