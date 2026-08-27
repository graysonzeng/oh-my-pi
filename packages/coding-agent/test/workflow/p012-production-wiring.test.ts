/**
 * Integration contracts: production paths consume P0/P1/P2 optimization modules.
 * These tests fail if prepare/engine/runtime stop wiring the libraries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import * as isolationRunner from "../../src/task/isolation-runner";
import { applyWorkflowTransformTools } from "../../src/tools/workflow-alias-wrap";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import {
	buildDefaultBenchmarkSuite,
	buildScorecard,
	createFakeBenchmarkRuntime,
	evaluateBenchmarkQualityGate,
	runBenchmarkSuite,
} from "../../src/workflow/benchmark";
import { CONTEXT_ESTIMATE_VERSION, CONTEXT_LEDGER_KIND } from "../../src/workflow/context-ledger";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { sha256Hex } from "../../src/workflow/optimization-receipt";
import { PROMPT_ASSEMBLY_RECEIPT_KIND } from "../../src/workflow/prompt-assembly";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { createDefaultRuntimeAdapter } from "../../src/workflow/runtime-default";
import { prepareWorkflowInvocation } from "../../src/workflow/runtime-invocation";
import { SCOPE_METRICS_KIND } from "../../src/workflow/scope-metrics";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { STAGE_HANDOFF_KIND } from "../../src/workflow/stage-handoff";
import { defaultSchemaValidator, repairStructuredOutput } from "../../src/workflow/structured-output-repair";
import { processToolOutputDetailed, truncateToolOutput, utf8ByteLength } from "../../src/workflow/tool-output-manager";
import type { ToolStrategy, WorkflowAgentRequest } from "../../src/workflow/types";
import {
	fakeSession,
	implArtifact,
	passVerifier,
	planArtifact,
	reviewArtifact,
	SAMPLE_PATCH,
	scriptedRunner,
} from "./helpers";

async function runGit(cwd: string, ...args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.text();
}

describe("P0 production processToolOutputDetailed + receipts", () => {
	it("prepare installs detailed processResult that surfaces receipt + recovery on session", () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		const huge = `${"test pass case_ok duration=1ms\n".repeat(400)}ERROR: compile failed\n[raw output: artifact://bash-orig-1]\n`;
		const detailed = prepared.processToolResultDetailed("bash", huge, { exitCode: 1 });
		expect(detailed.text.length).toBeLessThan(huge.length);
		expect(detailed.text).toMatch(/ERROR|Exit code/);
		expect(detailed.text).toContain("artifact://bash-orig-1");
		expect(detailed.receipt).toBeDefined();
		expect(detailed.receipt?.recoveryUri).toBe("artifact://bash-orig-1");
		expect(detailed.receipt?.transform).not.toBe("none");

		// Same path as live bash/read/grep via session.processResult
		const viaSession = prepared.session.workflowToolOptimization!.processResult("bash", huge, { exitCode: 1 });
		expect(viaSession).toBe(detailed.text);
		expect(prepared.optimizationReceipts.length).toBeGreaterThanOrEqual(1);
		expect(prepared.session.workflowToolOptimization?.lastOptimizationReceipt?.recoveryUri).toBe(
			"artifact://bash-orig-1",
		);
		expect(prepared.session.workflowToolOptimization?.optimizationReceipts?.length).toBeGreaterThanOrEqual(1);
	});

	it("string-only processToolResult stays backward compatible with detailed path", () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);
		const raw = "plain line without failure markers\n";
		const out = prepared.processToolResult("bash", raw);
		expect(typeof out).toBe("string");
		expect(out).toBe(prepared.processToolResultDetailed("bash", raw).text);
	});
});

describe("P2 presentation + prompt assembly on prepare path", () => {
	it("default presentation is direct / disabled; allowlist still role-scoped", () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);
		expect(prepared.presentationPolicy.enabled).toBe(false);
		expect(prepared.presentationPolicy.mode).toBe("direct");
		expect(prepared.allowedTools).toBeDefined();
		expect(prepared.allowedTools).toContain("bash");
		// Restricted implementer must not see unrestricted tool surface
		expect(prepared.allowedTools).not.toContain("*");
	});

	it("catalog mode prefilters wire tools by role allowlist and drops non-essential schema", () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: {
				...DEFAULT_MODEL_PROFILES.grok_implementer,
				presentationPolicy: {
					enabled: true,
					mode: "catalog",
					essentialTools: ["bash", "read"],
				},
			},
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		const wire = prepared.transformTools([
			{ name: "bash", description: "run", schema: { type: "object", properties: { command: { type: "string" } } } },
			{ name: "read", description: "read", schema: { type: "object", properties: { path: { type: "string" } } } },
			{ name: "edit", description: "edit", schema: { type: "object", properties: { path: { type: "string" } } } },
			// Outside allowlist — must never appear
			{ name: "browser", description: "web", schema: { type: "object" } },
		]);
		const names = wire.map(t => t.name);
		expect(names).toContain("bash");
		expect(names).toContain("edit");
		expect(names).not.toContain("browser");
		const bash = wire.find(t => t.name === "bash")!;
		const edit = wire.find(t => t.name === "edit")!;
		expect(bash.schema).toBeDefined();
		expect(edit.schema).toBeUndefined();
		expect(edit.schemaLocator).toBe("xd://tools/edit");
	});

	it("prompt assembly receipt is produced on real prepare path with cache unknown", () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "do the thing",
			context: "handoff body",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);
		expect(prepared.promptAssemblyReceipt.kind).toBe(PROMPT_ASSEMBLY_RECEIPT_KIND);
		expect(prepared.promptAssemblyReceipt.cacheObservable).toBe(false);
		expect(prepared.promptAssemblyReceipt.cacheReadTokens).toBeNull();
		expect(prepared.promptAssemblyReceipt.sectionOrder).toContain("role_policy");
		expect(prepared.promptAssemblyReceipt.sectionOrder).toContain("assignment");
		expect(prepared.session.workflowAttemptEvidence?.promptAssemblyReceipt?.kind).toBe(PROMPT_ASSEMBLY_RECEIPT_KIND);
	});

	it("builds a versioned context ledger from the real prepared prompt sections", () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf-ledger",
			attemptId: "att-ledger",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "implement ledger wiring",
			context: "handoff body",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		expect(prepared.contextLedger.kind).toBe(CONTEXT_LEDGER_KIND);
		expect(prepared.contextLedger.measurementVersion).toBe(CONTEXT_ESTIMATE_VERSION);
		expect(prepared.contextLedger.requestId).toBe("wf-ledger:att-ledger:implementer");
		expect(prepared.contextLedger.buckets.system_static.bytes).toBeGreaterThan(0);
		expect(prepared.contextLedger.buckets.role_policy.bytes).toBeGreaterThan(0);
		expect(prepared.contextLedger.buckets.assignment.bytes).toBeGreaterThan(0);
		expect(prepared.contextLedger.buckets.handoff.bytes).toBeGreaterThan(0);
		expect(prepared.contextLedger.providerUsage.cacheReadTokens).toEqual({
			value: null,
			provenance: "unknown",
		});
		expect(prepared.session.workflowAttemptEvidence?.contextLedger?.kind).toBe(CONTEXT_LEDGER_KIND);
	});
});

describe("P1 engine stage-handoff + scope-metrics production path", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let engine: WorkflowEngine;
	let patchFile: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-p012-"));
		patchFile = path.join(artifactDir, "impl.patch");
		await Bun.write(patchFile, SAMPLE_PATCH);

		const seenContexts: string[] = [];
		engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(async request => {
				if (request.context) seenContexts.push(request.context);
				// Delegate to scripted path by reusing helper shape
				return scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: {
						...implArtifact(),
						// Real patch evidence path (absolute so scope can read it)
						patchPath: patchFile,
						// Model-reported noise — engine scope must prefer patch paths
						changedFiles: ["model-invented.ts"],
					},
					codeReview: reviewArtifact("approved", "implementation"),
				})(request);
			}),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: artifactDir }),
		});
		// Stash for assertion after run
		(engine as unknown as { __seenContexts: string[] }).__seenContexts = seenContexts;
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("persists stage-handoff + scope-metrics and injects handoff into implementer context", async () => {
		const workflowId = await engine.startWorkflow({ request: "ship feature" });
		const result = await engine.run(workflowId, fakeSession({ cwd: artifactDir }));
		expect(result.state.status).toBe("completed");

		const artifacts = await store.listArtifacts(workflowId);
		const kinds = artifacts.map(a => a.kind);
		expect(kinds).toContain("stage-handoff");
		expect(kinds).toContain("scope-metrics");
		expect(kinds).toContain("prompt-assembly-receipt");

		const handoffs = artifacts.filter(a => a.kind === "stage-handoff");
		expect(handoffs.length).toBeGreaterThanOrEqual(1);
		const storeFs = new ArtifactStore(artifactDir);
		const handoffBodies = await Promise.all(
			handoffs.map(async meta => {
				const loaded = await storeFs.load(meta.relativePath, meta.sha256);
				return loaded?.content ? JSON.parse(loaded.content) : null;
			}),
		);
		const edges = handoffBodies.map(h => (h ? `${h.fromStage}→${h.toStage}` : null)).filter(Boolean);
		expect(edges).toContain("planning→implementing");
		expect(edges).toContain("implementing→code_review");
		for (const body of handoffBodies) {
			if (!body) continue;
			expect(body.kind).toBe(STAGE_HANDOFF_KIND);
			expect(body.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
			expect(Array.isArray(body.preservedItems)).toBe(true);
			expect(Array.isArray(body.omittedArtifactIds)).toBe(true);
			expect(Array.isArray(body.recoveryUris)).toBe(true);
			expect(typeof body.bytesBeforeHandoff).toBe("number");
			expect(typeof body.bytesAfterHandoff).toBe("number");
			expect(body.bytesBeforeHandoff).toBeGreaterThanOrEqual(body.bytesAfterHandoff);
		}

		const scopeMeta = artifacts.find(a => a.kind === "scope-metrics");
		expect(scopeMeta).toBeDefined();
		const scopeLoaded = await storeFs.load(scopeMeta!.relativePath, scopeMeta!.sha256);
		const scope = JSON.parse(scopeLoaded!.content!) as {
			kind: string;
			changedFiles: string[];
			status: string;
		};
		expect(scope.kind).toBe(SCOPE_METRICS_KIND);
		// Patch-derived path preferred over model-invented.ts
		expect(scope.changedFiles).toContain("src/a.ts");
		expect(scope.changedFiles).not.toContain("model-invented.ts");
		// Canonical status vocabulary (adhered | warning | violation | indeterminate)
		expect(["adhered", "warning", "violation", "indeterminate"]).toContain(scope.status);

		const contexts = (engine as unknown as { __seenContexts: string[] }).__seenContexts;
		const implementerCtx = contexts.find(c => c.includes("Stage handoff (planner→implementer)"));
		expect(implementerCtx).toBeDefined();
		expect(implementerCtx).toContain("goal:");
		expect(implementerCtx).toContain("preservedItems");

		const promptReceipt = artifacts.find(a => a.kind === "prompt-assembly-receipt");
		expect(promptReceipt).toBeDefined();
	});
});

describe("P1 reviewer→repair handoff on production path", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let engine: WorkflowEngine;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-p012-repair-"));
		const patchFile = path.join(artifactDir, "impl.patch");
		await Bun.write(patchFile, SAMPLE_PATCH);
		const seenContexts: string[] = [];

		engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(async request => {
				if (request.context) seenContexts.push(request.context);
				return scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: { ...implArtifact(), patchPath: patchFile },
					codeReview: reviewArtifact("changes_requested", "implementation", [
						{
							id: "f1",
							priority: "P0",
							category: "correctness",
							status: "open",
							confidence: 0.9,
							summary: "bug",
							explanation: "fix it",
							suggestedOwner: "implementer",
							blocking: true,
						},
					]),
					repair: { ...implArtifact(), patchPath: patchFile, addressedStepIds: ["f1"] },
				})(request);
			}),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd: artifactDir }),
			config: { maxRepairCycles: 2 },
		});
		(engine as unknown as { __seenContexts: string[] }).__seenContexts = seenContexts;
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("persists reviewer→repair handoff and injects into repair context", async () => {
		const workflowId = await engine.startWorkflow({ request: "fix bugs" });
		// May complete or re-enter verify; either way repair stage should run once with handoff.
		await engine.run(workflowId, fakeSession({ cwd: artifactDir })).catch(() => {
			// budget/repair loops may end blocked — handoff evidence still required
		});

		const artifacts = await store.listArtifacts(workflowId);
		const handoffs = artifacts.filter(a => a.kind === "stage-handoff");
		const storeFs = new ArtifactStore(artifactDir);
		const bodies = await Promise.all(
			handoffs.map(async meta => {
				const loaded = await storeFs.load(meta.relativePath, meta.sha256);
				return loaded?.content ? JSON.parse(loaded.content) : null;
			}),
		);
		const edges = bodies.map(b => (b ? `${b.fromStage}→${b.toStage}` : null));
		expect(edges).toContain("code_review→repairing");

		const repairHandoff = bodies.find(b => b?.fromStage === "code_review" && b?.toStage === "repairing");
		expect(repairHandoff).toBeDefined();
		expect(
			repairHandoff!.preservedItems.some(
				(p: { kind: string; blocking: boolean; summary: string }) =>
					p.kind === "finding" && p.blocking && p.summary.includes("f1"),
			),
		).toBe(true);

		const contexts = (engine as unknown as { __seenContexts: string[] }).__seenContexts;
		expect(contexts.some(c => c.includes("Stage handoff (reviewer→repair)"))).toBe(true);
		expect(contexts.some(c => c.includes("blocking_finding") && c.includes("f1"))).toBe(true);
	});
});

describe("benchmark public entrypoint", () => {
	it("runBenchmarkSuite is importable and runnable without CLI", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const results = await runBenchmarkSuite({
			suite,
			runtime: createFakeBenchmarkRuntime(),
			optimizedProfileId: "test",
			minRepetitions: 1,
		});
		expect(results.length).toBeGreaterThan(0);
		const scorecard = buildScorecard(suite, results);
		expect(scorecard.summaries.length).toBeGreaterThan(0);
	});
});

describe("P0 no-footer artifact persistence + UTF-8 maxBytes", () => {
	const lossyStrategy: ToolStrategy = {
		resultSummarization: { enabled: true, summarizerKeys: ["bash", "grep", "read", "*"] },
		outputTruncation: {
			enabled: true,
			rules: [
				{ toolName: "bash", strategy: "smart", maxBytes: 400, maxLines: 20 },
				{ toolName: "grep", strategy: "head", maxBytes: 200, maxLines: 10 },
				{ toolName: "read", strategy: "head", maxBytes: 300, maxLines: 15 },
			],
		},
	};

	it("lossy bash without footer saves via adapter, sets recovery URI + reversible + hash", () => {
		const saved = new Map<string, string>();
		const huge = `${"noise line ok\n".repeat(80)}ERROR: compile failed\n`;
		const detailed = processToolOutputDetailed(
			huge,
			"bash",
			lossyStrategy,
			{ exitCode: 1 },
			{
				saveRaw: (tool, text) => {
					const id = `saved-${tool}-1`;
					saved.set(id, text);
					return id;
				},
			},
		);
		expect(detailed.text.length).toBeLessThan(huge.length);
		expect(detailed.text).toContain("artifact://saved-bash-1");
		expect(detailed.receipt?.recoveryUri).toBe("artifact://saved-bash-1");
		expect(detailed.receipt?.reversible).toBe(true);
		expect(detailed.receipt?.originalSha256).toBe(sha256Hex(huge));
		expect(saved.get("saved-bash-1")).toBe(huge);
	});

	it("save failure never invents URI and marks non-reversible", () => {
		const huge = `${"x".repeat(500)}\nERROR: boom\n`;
		const detailed = processToolOutputDetailed(
			huge,
			"bash",
			lossyStrategy,
			{ exitCode: 1 },
			{
				saveRaw: () => undefined,
			},
		);
		expect(detailed.text).not.toMatch(/artifact:\/\//);
		expect(detailed.receipt?.recoveryUri).toBeUndefined();
		expect(detailed.receipt?.reversible).toBe(false);
	});

	it("lossy grep/read without footer also invoke saveRaw", () => {
		const calls: string[] = [];
		const grepOut = Array.from({ length: 50 }, (_, i) => `src/a.ts:${i}:match`).join("\n");
		const g = processToolOutputDetailed(
			grepOut,
			"grep",
			lossyStrategy,
			{},
			{
				saveRaw: tool => {
					calls.push(tool);
					return `g-${tool}`;
				},
			},
		);
		expect(calls).toContain("grep");
		expect(g.text).toContain("artifact://g-grep");

		const readOut = Array.from({ length: 80 }, (_, i) => `line ${i} 中文`).join("\n");
		const r = processToolOutputDetailed(
			readOut,
			"read",
			lossyStrategy,
			{ path: "f.ts" },
			{
				saveRaw: tool => {
					calls.push(tool);
					return `r-${tool}`;
				},
			},
		);
		expect(calls).toContain("read");
		expect(r.receipt?.recoveryUri).toBe("artifact://r-read");
	});

	it("maxBytes clamps by UTF-8 bytes for multi-byte Chinese/emoji", () => {
		// Each "你好😀" is 3+3+4 = 10 UTF-8 bytes; 600× → 6000 bytes.
		const text = "你好😀".repeat(600);
		const maxBytes = 4000;
		expect(utf8ByteLength(text)).toBeGreaterThan(maxBytes);
		const out = truncateToolOutput(text, { strategy: "head", maxBytes, maxLines: 10_000 });
		expect(utf8ByteLength(out)).toBeLessThanOrEqual(maxBytes);
		// Code-unit length can exceed byte cap for CJK if clamp used JS length wrongly —
		// after fix, visible bytes stay under the cap even when string.length is larger.
		expect(out.length).toBeGreaterThan(0);
	});
});

describe("P1 schema repair on production RuntimeAdapter path", () => {
	it("BOM/fenced invalid raw repairs with zero model calls and returns artifact", async () => {
		const schema = {
			type: "object",
			required: ["summary"],
			properties: { summary: { type: "string" } },
		};
		const fenced = `\uFEFF\`\`\`json\n{"summary":"ok from fence"}\n\`\`\``;
		// Unit of the shared repair seam used by RuntimeAdapter.#tryRepairStructured
		const unit = await repairStructuredOutput(fenced, {
			maxRetries: 0,
			schema,
			validate: defaultSchemaValidator,
		});
		expect(unit.ok).toBe(true);
		expect(unit.receipt.modelCalls).toBe(0);
		expect((unit.value as { summary: string }).summary).toBe("ok from fence");

		const adapter = new RuntimeAdapter(async () => ({
			result: {
				id: "r1",
				structuredOutput: { status: "invalid", error: "not valid json", data: fenced },
				rawOutput: fenced,
				exitCode: 1,
			},
		}));
		const result = await adapter.run({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: {
				...DEFAULT_MODEL_PROFILES.grok_implementer,
				outputStrategy: {
					...DEFAULT_MODEL_PROFILES.grok_implementer.outputStrategy,
					retryOnSchemaViolation: { enabled: true, maxRetries: 0, includeErrorInRetry: true },
				},
			},
			assignment: "impl",
			session: fakeSession(),
			outputSchema: schema,
		} satisfies WorkflowAgentRequest);
		expect((result.artifact as { summary: string }).summary).toBe("ok from fence");
		expect(result.schemaRepairReceipt).toBeDefined();
		expect((result.schemaRepairReceipt as { modelCalls: number }).modelCalls).toBe(0);
	});

	it("semantic-invalid missing fields are not invented", async () => {
		const schema = {
			type: "object",
			required: ["summary", "steps"],
			properties: {
				summary: { type: "string" },
				steps: { type: "array" },
			},
		};
		const raw = `{"summary":"only summary"}`;
		const adapter = new RuntimeAdapter(async () => ({
			result: {
				id: "r2",
				structuredOutput: { status: "invalid", error: "missing required field: steps", data: JSON.parse(raw) },
				rawOutput: raw,
				exitCode: 1,
			},
		}));
		await expect(
			adapter.run({
				workflowId: "wf",
				attemptId: "att",
				role: "implementer",
				profile: {
					...DEFAULT_MODEL_PROFILES.grok_implementer,
					outputStrategy: {
						retryOnSchemaViolation: { enabled: false, maxRetries: 0, includeErrorInRetry: false },
					},
				},
				assignment: "impl",
				session: fakeSession(),
				outputSchema: schema,
			} satisfies WorkflowAgentRequest),
		).rejects.toThrow(/missing required field|schema|valid structured/i);
	});

	it("grok_implementer maxRetries=3 invalid→valid uses 2 model calls and injects retry prompt", async () => {
		const schema = {
			type: "object",
			required: ["summary"],
			properties: { summary: { type: "string" } },
		};
		let calls = 0;
		const contexts: string[] = [];
		const adapter = new RuntimeAdapter(async req => {
			calls += 1;
			contexts.push(req.context ?? "");
			if (calls === 1) {
				return {
					result: {
						id: "bad",
						structuredOutput: { status: "invalid", error: "missing required field: summary" },
						rawOutput: `{"other":true}`,
						exitCode: 1,
					},
				};
			}
			return {
				result: {
					id: "ok",
					structuredOutput: { status: "valid", data: { summary: "fixed by retry" } },
				},
			};
		});
		const profile = DEFAULT_MODEL_PROFILES.grok_implementer;
		expect(profile.outputStrategy?.retryOnSchemaViolation?.maxRetries).toBe(3);
		const result = await adapter.run({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile,
			assignment: "produce schema-violating then fixed output",
			session: fakeSession(),
			outputSchema: schema,
		} satisfies WorkflowAgentRequest);
		expect((result.artifact as { summary: string }).summary).toBe("fixed by retry");
		expect(calls).toBe(2);
		expect(contexts[1]).toMatch(/violated the required output schema/i);
		expect(contexts[1]).toMatch(/missing required field: summary|summary/i);
		const receipt = result.schemaRepairReceipt as {
			finalStatus: string;
			layer3RetryCount: number;
			repaired: boolean;
			modelCalls: number;
			maxRetries: number;
			totalAttempts: number;
			layer1Success: boolean;
			budgetExhausted: boolean;
			violationHistory: Array<{ attemptIndex: number; error: string; outputPreview?: string }>;
			attempts: Array<{ attemptIndex: number; ok: boolean; outputPreview?: string }>;
		};
		expect(receipt.finalStatus).toBe("repaired_layer3");
		expect(receipt.layer3RetryCount).toBe(1);
		expect(receipt.repaired).toBe(true);
		expect(receipt.modelCalls).toBe(2);
		expect(receipt.maxRetries).toBe(3);
		expect(receipt.layer1Success).toBe(false);
		expect(receipt.budgetExhausted).toBe(false);
		expect(receipt.totalAttempts).toBeGreaterThanOrEqual(1);
		// First model invocation failure is retained (not overwritten by success).
		expect(receipt.violationHistory.length).toBeGreaterThanOrEqual(1);
		expect(receipt.violationHistory.some(v => /missing required field: summary|summary/i.test(v.error))).toBe(true);
		expect(receipt.attempts.some(a => a.attemptIndex === 0 && a.ok === false)).toBe(true);
		expect(receipt.attempts.some(a => typeof a.outputPreview === "string" && a.outputPreview.includes("other"))).toBe(
			true,
		);
	});

	it("invalid then second-call fenced L1 success keeps prior violations in receipt", async () => {
		const schema = {
			type: "object",
			required: ["summary"],
			properties: { summary: { type: "string" } },
		};
		const fenced = `\uFEFF\`\`\`json\n{"summary":"from-second-l1"}\n\`\`\``;
		let calls = 0;
		const adapter = new RuntimeAdapter(async () => {
			calls += 1;
			if (calls === 1) {
				return {
					result: {
						id: "bad-1",
						structuredOutput: { status: "invalid", error: "missing required field: summary" },
						rawOutput: `{"other":true}`,
						exitCode: 1,
					},
				};
			}
			// Second runner call: invalid structured status but raw is L1-repairable fenced JSON.
			return {
				result: {
					id: "fence-2",
					structuredOutput: { status: "invalid", error: "parse failed", data: fenced },
					rawOutput: fenced,
					exitCode: 1,
				},
			};
		});
		const result = await adapter.run({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: {
				...DEFAULT_MODEL_PROFILES.grok_implementer,
				outputStrategy: {
					retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
				},
			},
			assignment: "invalid then fenced",
			session: fakeSession(),
			outputSchema: schema,
		} satisfies WorkflowAgentRequest);
		expect(calls).toBe(2);
		expect((result.artifact as { summary: string }).summary).toBe("from-second-l1");
		const receipt = result.schemaRepairReceipt as {
			finalStatus: string;
			modelCalls: number;
			maxRetries: number;
			layer3RetryCount: number;
			layer1Success: boolean;
			repaired: boolean;
			violationHistory: Array<{ attemptIndex: number; error: string; outputPreview?: string }>;
			attempts: Array<{ attemptIndex: number; ok: boolean; outputPreview?: string }>;
		};
		// Must NOT collapse to pure first-call L1 (modelCalls=0 / only success attempt).
		expect(receipt.finalStatus).toBe("repaired_layer3");
		expect(receipt.modelCalls).toBe(2);
		expect(receipt.maxRetries).toBe(2);
		expect(receipt.layer3RetryCount).toBe(1);
		expect(receipt.layer1Success).toBe(true); // final fix was L1 on second raw
		expect(receipt.repaired).toBe(true);
		// First failure retained.
		expect(receipt.violationHistory.some(v => v.attemptIndex === 0)).toBe(true);
		expect(receipt.violationHistory.some(v => /missing required field: summary/i.test(v.error))).toBe(true);
		expect(receipt.attempts.some(a => a.attemptIndex === 0 && a.ok === false)).toBe(true);
		expect(receipt.attempts.some(a => a.attemptIndex === 0 && a.outputPreview?.includes("other"))).toBe(true);
		// Second L1 success present.
		expect(receipt.attempts.some(a => a.attemptIndex === 1 && a.ok === true)).toBe(true);
	});

	it("multi-attempt schema exhaustion accumulates all attempt outputs in Layer4 receipt", async () => {
		const schema = {
			type: "object",
			required: ["summary"],
			properties: { summary: { type: "string" } },
		};
		let calls = 0;
		const adapter = new RuntimeAdapter(async () => {
			calls += 1;
			return {
				result: {
					id: `bad-${calls}`,
					structuredOutput: {
						status: "invalid",
						error: `missing required field: summary (try ${calls})`,
					},
					rawOutput: `{"other":${calls}}`,
					exitCode: 1,
				},
			};
		});
		let thrown: { kind?: string; details?: { schemaRepairReceipt?: Record<string, unknown> } } | undefined;
		try {
			await adapter.run({
				workflowId: "wf",
				attemptId: "att",
				role: "implementer",
				profile: {
					...DEFAULT_MODEL_PROFILES.grok_implementer,
					outputStrategy: {
						retryOnSchemaViolation: { enabled: true, maxRetries: 1, includeErrorInRetry: true },
					},
				},
				assignment: "always invalid",
				session: fakeSession(),
				outputSchema: schema,
			} satisfies WorkflowAgentRequest);
		} catch (e) {
			thrown = e as typeof thrown;
		}
		expect(calls).toBe(2); // 1 + maxRetries
		expect(thrown?.kind).toBe("schema_violation");
		const receipt = thrown?.details?.schemaRepairReceipt as {
			finalStatus: string;
			modelCalls: number;
			maxRetries: number;
			layer3RetryCount: number;
			totalAttempts: number;
			budgetExhausted: boolean;
			violationHistory: Array<{ attemptIndex: number; error: string; outputPreview?: string }>;
			attempts: Array<{ attemptIndex: number; outputPreview?: string; ok: boolean }>;
		};
		expect(receipt).toBeDefined();
		expect(receipt.finalStatus).toBe("schema_error");
		expect(receipt.modelCalls).toBe(2);
		expect(receipt.maxRetries).toBe(1);
		expect(receipt.layer3RetryCount).toBe(1);
		expect(receipt.budgetExhausted).toBe(false);
		expect(receipt.totalAttempts).toBeGreaterThanOrEqual(2);
		// Both outer attempts present — not only the last L1-only overwrite.
		const idxs = new Set(receipt.attempts.map(a => a.attemptIndex));
		expect(idxs.has(0)).toBe(true);
		expect(idxs.has(1)).toBe(true);
		expect(receipt.violationHistory.length).toBeGreaterThanOrEqual(2);
		expect(receipt.attempts.some(a => a.outputPreview?.includes('"other":1'))).toBe(true);
		expect(receipt.attempts.some(a => a.outputPreview?.includes('"other":2'))).toBe(true);
	});

	it("budget exhausted (maxRequests=1) skips model retry after first schema failure", async () => {
		let calls = 0;
		const adapter = new RuntimeAdapter(async () => {
			calls += 1;
			return {
				result: {
					id: "bad",
					structuredOutput: { status: "invalid", error: "bad schema" },
					rawOutput: "not json at all",
					exitCode: 1,
				},
			};
		});
		let thrown:
			| { kind?: string; details?: { schemaRepairReceipt?: { budgetExhausted?: boolean; modelCalls?: number } } }
			| undefined;
		try {
			await adapter.run({
				workflowId: "wf",
				attemptId: "att",
				role: "implementer",
				profile: {
					...DEFAULT_MODEL_PROFILES.grok_implementer,
					maxRequests: 1,
					outputStrategy: {
						retryOnSchemaViolation: { enabled: true, maxRetries: 3, includeErrorInRetry: true },
					},
				},
				assignment: "impl",
				session: fakeSession(),
				outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
			} satisfies WorkflowAgentRequest);
		} catch (e) {
			thrown = e as typeof thrown;
		}
		expect(calls).toBe(1);
		expect(thrown?.kind).toBe("schema_violation");
		expect(thrown?.details?.schemaRepairReceipt?.budgetExhausted).toBe(true);
		expect(thrown?.details?.schemaRepairReceipt?.modelCalls).toBe(1);
	});
});

describe("P2 assembled prompt + transformTools on production runner path", () => {
	it("assembled prompt text is non-empty and used as prepared.context", () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "do the thing",
			context: "handoff body",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);
		expect(prepared.assembledPromptText.length).toBeGreaterThan(0);
		expect(prepared.assembledPromptText).toContain("do the thing");
		expect(prepared.assembledPromptText).toContain("handoff body");
		// Runner-facing context is the assembled body (not bare handoff only).
		expect(prepared.context).toBe(prepared.assembledPromptText);
	});

	it("RuntimeAdapter maps assembled prompt into runner context and applies transformTools", async () => {
		let seenContext: string | undefined;
		let seenTransform: boolean | undefined;
		let transformedNames: string[] | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seenContext = req.context;
			seenTransform = typeof req.transformTools === "function";
			if (req.transformTools) {
				const out = req.transformTools([
					{
						name: "bash",
						description: "run",
						schema: { type: "object", properties: { command: { type: "string" } } },
					},
					{
						name: "edit",
						description: "edit",
						schema: { type: "object", properties: { path: { type: "string" } } },
					},
					{ name: "browser", description: "web", schema: { type: "object" } },
				]);
				transformedNames = out.map(t => t.name);
				// Catalog mode: non-essential tools drop full schema; browser outside allowlist is dropped.
				const edit = out.find(t => t.name === "edit");
				expect(edit?.schema).toBeUndefined();
				expect(edit?.schemaLocator).toBe("xd://tools/edit");
				expect(out.some(t => t.name === "browser")).toBe(false);
			}
			return {
				result: {
					id: "ok",
					structuredOutput: { status: "valid", data: { summary: "done" } },
					exitCode: 0,
				},
			};
		});
		await adapter.run({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: {
				...DEFAULT_MODEL_PROFILES.grok_implementer,
				presentationPolicy: {
					enabled: true,
					mode: "catalog",
					essentialTools: ["bash", "read"],
				},
			},
			assignment: "ship it",
			context: "stage handoff blob",
			session: fakeSession(),
			outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
		} satisfies WorkflowAgentRequest);
		expect(seenContext).toBeDefined();
		expect(seenContext).toContain("ship it");
		expect(seenContext).toContain("stage handoff blob");
		expect(seenTransform).toBe(true);
		expect(transformedNames).toBeDefined();
		expect(transformedNames).toContain("bash");
	});
});

describe("AC6 default-path budget + multi-runtime + real AgentTool transform", () => {
	it("does not map toolHistory.maxToolCalls into remainingToolCalls hard budget", () => {
		const profile = DEFAULT_MODEL_PROFILES.grok_implementer;
		// Default profiles set toolHistory.maxToolCalls via keepRecentN (5–15 range).
		expect(profile.contextStrategy?.toolHistory?.maxToolCalls).toBeGreaterThan(0);
		expect(profile.contextStrategy?.toolHistory?.maxToolCalls).toBeLessThanOrEqual(20);

		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		// Hard execution budget must stay unlimited on default path (eviction-only semantics).
		expect(prepared.session.workflowToolOptimization?.remainingToolCalls).toBeNull();
		// Concurrency cap from toolStrategy is still allowed.
		expect(prepared.session.workflowToolOptimization?.maxConcurrentTools).toBe(
			profile.toolStrategy?.maxConcurrentTools,
		);
	});

	it("forwards explicit toolStrategy scheduling fields onto session optimization", () => {
		const base = DEFAULT_MODEL_PROFILES.grok_implementer;
		const profile = {
			...base,
			toolStrategy: {
				...base.toolStrategy,
				maxConcurrentTools: 4,
				remainingToolCalls: 12,
				remainingStageTimeMs: 60_000,
				resourceConflictMode: "serialize" as const,
			},
		};
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);
		const opt = prepared.session.workflowToolOptimization;
		expect(opt?.maxConcurrentTools).toBe(4);
		expect(opt?.remainingToolCalls).toBe(12);
		expect(opt?.remainingStageTimeMs).toBe(60_000);
		expect(opt?.resourceConflictMode).toBe("serialize");
	});

	it("createDefaultRuntimeAdapter returns embedded RuntimeAdapter only", () => {
		const adapter = createDefaultRuntimeAdapter();
		expect(adapter).toBeInstanceOf(RuntimeAdapter);
	});

	it("default adapter merges ordered captured patches through one patch merge", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wf-p012-captured-"));
		try {
			await runGit(repoRoot, "init");
			await runGit(repoRoot, "config", "user.email", "workflow@example.com");
			await runGit(repoRoot, "config", "user.name", "Workflow Test");
			await Bun.write(path.join(repoRoot, "first.txt"), "base\n");
			await Bun.write(path.join(repoRoot, "second.txt"), "base\n");
			await runGit(repoRoot, "add", "first.txt", "second.txt");
			await runGit(repoRoot, "commit", "-m", "base");

			const firstPatch = path.join(repoRoot, "first.patch");
			const secondPatch = path.join(repoRoot, "second.patch");
			await Bun.write(
				firstPatch,
				[
					"diff --git a/first.txt b/first.txt",
					"--- a/first.txt",
					"+++ b/first.txt",
					"@@ -1 +1 @@",
					"-base",
					"+first",
				].join("\n"),
			);
			await Bun.write(
				secondPatch,
				[
					"diff --git a/second.txt b/second.txt",
					"--- a/second.txt",
					"+++ b/second.txt",
					"@@ -1 +1 @@",
					"-base",
					"+second",
				].join("\n"),
			);
			const outputPatchPath = path.join(repoRoot, "merged", "captured.patch");
			const originalMerge = isolationRunner.mergeIsolatedChanges;
			const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockImplementation(originalMerge);
			const adapter = createDefaultRuntimeAdapter({
				embeddedRunner: async () => ({ result: { id: "unused" } }),
			});
			const merged = await adapter.mergeCapturedChanges!({
				workflowId: "wf-captured",
				attemptId: "att-captured",
				cwd: repoRoot,
				patches: [
					{ packageId: "first", patchPath: firstPatch },
					{ packageId: "second", patchPath: secondPatch },
				],
				outputPatchPath,
			});

			expect(merged).toMatchObject({ patchPath: outputPatchPath, changesApplied: true });
			expect(await Bun.file(outputPatchPath).text()).toBe(
				`${[
					"diff --git a/first.txt b/first.txt",
					"--- a/first.txt",
					"+++ b/first.txt",
					"@@ -1 +1 @@",
					"-base",
					"+first",
					"diff --git a/second.txt b/second.txt",
					"--- a/second.txt",
					"+++ b/second.txt",
					"@@ -1 +1 @@",
					"-base",
					"+second",
				].join("\n")}\n`,
			);
			expect(await Bun.file(path.join(repoRoot, "first.txt")).text()).toBe("first\n");
			expect(await Bun.file(path.join(repoRoot, "second.txt")).text()).toBe("second\n");
			expect(mergeSpy).toHaveBeenCalledTimes(1);
			expect(mergeSpy).toHaveBeenCalledWith(expect.objectContaining({ repoRoot, mergeMode: "patch" }));
		} finally {
			vi.restoreAllMocks();
			await fs.rm(repoRoot, { recursive: true, force: true });
		}
	});

	it("returns a conflict without partially applying an ordered patch batch", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wf-p012-captured-conflict-"));
		try {
			await runGit(repoRoot, "init");
			await runGit(repoRoot, "config", "user.email", "workflow@example.com");
			await runGit(repoRoot, "config", "user.name", "Workflow Test");
			await Bun.write(path.join(repoRoot, "first.txt"), "base\n");
			await Bun.write(path.join(repoRoot, "second.txt"), "parent\n");
			await runGit(repoRoot, "add", "first.txt", "second.txt");
			await runGit(repoRoot, "commit", "-m", "base");

			const firstPatch = path.join(repoRoot, "first.patch");
			const conflictingPatch = path.join(repoRoot, "conflicting.patch");
			await Bun.write(
				firstPatch,
				[
					"diff --git a/first.txt b/first.txt",
					"--- a/first.txt",
					"+++ b/first.txt",
					"@@ -1 +1 @@",
					"-base",
					"+first",
				].join("\n"),
			);
			await Bun.write(
				conflictingPatch,
				[
					"diff --git a/second.txt b/second.txt",
					"--- a/second.txt",
					"+++ b/second.txt",
					"@@ -1 +1 @@",
					"-old",
					"+second",
				].join("\n"),
			);
			const outputPatchPath = path.join(repoRoot, "merged", "captured.patch");
			const adapter = createDefaultRuntimeAdapter({
				embeddedRunner: async () => ({ result: { id: "unused" } }),
			});
			const merged = await adapter.mergeCapturedChanges!({
				workflowId: "wf-captured-conflict",
				attemptId: "att-captured-conflict",
				cwd: repoRoot,
				patches: [
					{ packageId: "first", patchPath: firstPatch },
					{ packageId: "conflict", patchPath: conflictingPatch },
				],
				outputPatchPath,
			});

			expect(merged.changesApplied).toBe(false);
			expect(merged.summary).toContain("Patches were not applied");
			expect(await Bun.file(path.join(repoRoot, "first.txt")).text()).toBe("base\n");
			expect(await Bun.file(path.join(repoRoot, "second.txt")).text()).toBe("parent\n");
			expect(await runGit(repoRoot, "status", "--porcelain", "--", "first.txt", "second.txt")).toBe("");
		} finally {
			await fs.rm(repoRoot, { recursive: true, force: true });
		}
	});

	it("applyWorkflowTransformTools drops schema on real AgentTool-like objects in catalog mode", () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: {
				...DEFAULT_MODEL_PROFILES.grok_implementer,
				presentationPolicy: {
					enabled: true,
					mode: "catalog",
					essentialTools: ["bash", "read"],
				},
			},
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		const tools = [
			{
				name: "bash",
				description: "run",
				parameters: { type: "object", properties: { command: { type: "string" } } },
				execute: async () => ({ content: [], details: {} }),
			},
			{
				name: "edit",
				description: "edit",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				execute: async () => ({ content: [], details: {} }),
			},
			{
				name: "browser",
				description: "web",
				parameters: { type: "object" },
				execute: async () => ({ content: [], details: {} }),
			},
		];

		const session = {
			workflowToolOptimization: {
				processResult: prepared.processToolResult,
				transformTools: prepared.transformTools,
			},
		};
		const out = applyWorkflowTransformTools(tools, session);
		const names = out.map(t => t.name);
		expect(names).toContain("bash");
		expect(names).toContain("edit");
		expect(names).not.toContain("browser");

		const bash = out.find(t => t.name === "bash")!;
		const edit = out.find(t => t.name === "edit")!;
		// Essential: full schema retained
		expect((bash.parameters as { properties?: unknown }).properties).toBeDefined();
		// Non-essential catalog: stub parameters + schemaLocator surface
		expect((edit.parameters as { properties?: Record<string, unknown> }).properties).toEqual({});
		expect((edit as { schemaLocator?: string }).schemaLocator).toBe("xd://tools/edit");
		expect(String(edit.description)).toContain("xd://tools/edit");
	});
});

describe("benchmark quality gate scope violation", () => {
	it("evaluateBenchmarkQualityGate fails when optimized scopeStatus is violation", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const caseId = suite.cases[0]!.id;
		const results = await runBenchmarkSuite({
			suite: { ...suite, cases: suite.cases.slice(0, 1) },
			runtime: async req => ({
				passed: true,
				qualityScore: 100,
				scopeStatus: req.variant === "optimized" ? "violation" : "adhered",
				durationMs: 1,
			}),
			minRepetitions: 1,
		});
		const scorecard = buildScorecard(suite, results);
		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(false);
		expect(gate.reasons.some(r => r.includes("violation") && r.includes(caseId))).toBe(true);
	});

	it("legacy hard_fail scopeStatus still fails quality gate (dual-read)", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const results = await runBenchmarkSuite({
			suite: { ...suite, cases: suite.cases.slice(0, 1) },
			runtime: async req => ({
				passed: true,
				qualityScore: 100,
				scopeStatus: req.variant === "optimized" ? "hard_fail" : "pass",
				durationMs: 1,
			}),
			minRepetitions: 1,
		});
		const scorecard = buildScorecard(suite, results);
		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(false);
		expect(gate.reasons.some(r => r.includes("violation"))).toBe(true);
	});

	it("scope warning alone does not fail quality gate (tests pass + unplanned distinguishable)", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const results = await runBenchmarkSuite({
			suite: { ...suite, cases: suite.cases.slice(0, 1) },
			runtime: async req => ({
				passed: true,
				qualityScore: 100,
				// optimized has warning scope creep; baseline adhered — gate still passes quality thresholds
				scopeStatus: req.variant === "optimized" ? "warning" : "adhered",
				durationMs: 1,
			}),
			minRepetitions: 1,
		});
		const scorecard = buildScorecard(suite, results);
		const gate = evaluateBenchmarkQualityGate(scorecard);
		// pass rates equal and no hard violation → gate passes; warning visible on run
		expect(gate.passed).toBe(true);
		const warningRuns = results.filter(r => r.scopeStatus === "warning");
		expect(warningRuns.length).toBeGreaterThan(0);
		expect(warningRuns.some(r => r.passed && r.scopeStatus === "warning")).toBe(true);
	});
});

describe("benchmark quality gate completionKind", () => {
	it("fails live acceptance when a run is missing completionKind", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const results = await runBenchmarkSuite({
			suite: { ...suite, cases: suite.cases.slice(0, 1) },
			runtime: async () => ({
				passed: true,
				qualityScore: 100,
				scopeStatus: "adhered",
				durationMs: 1,
				runtimeProvenance: {
					source: "runtime_observed",
					provider: "p",
					model: "m",
					checkpoint: null,
					api: null,
					adapter: null,
					parser: null,
				},
			}),
			minRepetitions: 1,
			liveQualityUnknown: false,
			provider: "p",
			model: "m",
		});
		const scorecard = buildScorecard(suite, results, { liveQualityUnknown: false, acceptanceMinRepetitions: 1 });
		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(false);
		expect(gate.reasons.some(reason => reason.includes("missing completionKind"))).toBe(true);
	});

	it("fails when completionKind is budget_stop even if runtime passed", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const results = await runBenchmarkSuite({
			suite: { ...suite, cases: suite.cases.slice(0, 1) },
			runtime: async () => ({
				passed: true,
				qualityScore: 100,
				scopeStatus: "adhered",
				durationMs: 1,
				completionKind: "budget_stop",
			}),
			minRepetitions: 1,
		});
		expect(results.every(result => result.passed === false)).toBe(true);
		const scorecard = buildScorecard(suite, results);
		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(false);
		expect(gate.reasons.some(reason => reason.includes("completionKind=budget_stop"))).toBe(true);
	});
});
