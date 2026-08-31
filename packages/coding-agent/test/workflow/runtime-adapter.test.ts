import { describe, expect, it, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "../../src/session/artifacts";
import type { ContextEntry } from "../../src/workflow/context-ledger";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import {
	RuntimeAdapter,
	type StructuredRunner,
	type StructuredRunnerRequest,
	type StructuredRunnerResult,
} from "../../src/workflow/runtime-adapter";
import type { CapturedChangesMerger, WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession, implArtifact } from "./helpers";

function baseRequest(signal?: AbortSignal, overrides: Partial<WorkflowAgentRequest> = {}): WorkflowAgentRequest {
	return {
		workflowId: "wf_1",
		attemptId: "att_1",
		role: "implementer",
		profile: {
			id: "grok_implementer",
			vendor: "xai",
			modelPattern: ["grok-4"],
			roles: ["implementer"],
			promptTemplate: "implementer",
			promptVersion: "1.0",
			toolPolicyId: "scoped-implementation",
			maxRequests: 200,
			maxRuntimeMs: 600_000,
			retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
			contextPolicy: {
				includePlan: true,
				includeReviewFindings: false,
				includeVerification: true,
				includeFullTranscript: false,
				maxArtifactBytes: 1024 * 1024,
			},
		},
		assignment: "implement",
		context: "ctx",
		outputSchema: {},
		isolation: { requested: true, merge: "patch", apply: true },
		session: fakeSession(),
		signal,
		...overrides,
	};
}

const LARGE_CONTEXT_ATTACHMENT = "ATTACHMENT_LARGE_PROVIDER_SENTINEL\n".repeat(128);

function contextFailureEntries(): ContextEntry[] {
	return [
		{
			id: "attachment-primary",
			bucket: "artifacts",
			kind: "attachment",
			content: LARGE_CONTEXT_ATTACHMENT,
		},
		{
			id: "attachment-duplicate",
			bucket: "artifacts",
			kind: "attachment",
			content: LARGE_CONTEXT_ATTACHMENT,
		},
		{ id: "history-tail", bucket: "history", kind: "other", content: "HISTORY_TAIL" },
		{ id: "handoff-tail", bucket: "handoff", kind: "other", content: "HANDOFF_TAIL" },
	];
}

function okResult(data: unknown, extra: Partial<StructuredRunnerResult["result"]> = {}): StructuredRunnerResult {
	return {
		result: {
			id: "raw_1",
			structuredOutput: { status: "valid", data },
			patchPath: "patches/a.patch",
			branchName: "wf/branch",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
			...extra,
		},
	};
}

describe("RuntimeAdapter", () => {
	it("accepts schema-valid structured output and propagates isolation + usage", async () => {
		const runner: StructuredRunner = async () =>
			okResult({ kind: "implementation", summary: "ok", changedFiles: ["a.ts"] });
		const adapter = new RuntimeAdapter(runner);
		const result = await adapter.run(baseRequest());
		expect(result.artifact).toMatchObject({ summary: "ok" });
		expect(result.patchPath).toBe("patches/a.patch");
		expect(result.branchName).toBe("wf/branch");
		expect(result.usage?.output).toBe(2);
	});

	it("pins a DevFlow native reviewer agent to the matching model family", async () => {
		let mapped: StructuredRunnerRequest | undefined;
		const adapter = new RuntimeAdapter(async request => {
			mapped = request;
			return okResult({ verdict: "PASS" });
		});
		await adapter.run(
			baseRequest(undefined, {
				role: "code_reviewer",
				agent: "subagent-sol",
				pipelineKind: "devflow",
				profile: {
					...DEFAULT_MODEL_PROFILES.gpt_reviewer,
					strictIdentity: false,
				},
				isolation: { requested: false, merge: "patch", apply: false },
			}),
		);
		expect(mapped?.agent).toBe("subagent-sol");
		expect(mapped?.model).toEqual(["gpt-5.6-sol"]);
	});

	it("exposes an optional captured-change merger seam and preserves the legacy constructor", async () => {
		const merger: CapturedChangesMerger = async request => ({
			patchPath: request.outputPatchPath,
			changesApplied: true,
			summary: "merged",
		});
		const adapter = new RuntimeAdapter(async () => okResult({ ok: true }), merger);
		expect(adapter.mergeCapturedChanges).toBe(merger);
		expect((await adapter.run(baseRequest())).artifact).toEqual({ ok: true });
		expect(new RuntimeAdapter(async () => okResult({})).mergeCapturedChanges).toBeUndefined();
	});

	it("strict schema rejection maps to schema_violation", async () => {
		const runner: StructuredRunner = async () => ({
			result: {
				id: "raw_2",
				structuredOutput: { status: "invalid", error: "missing fields" },
			},
		});
		const adapter = new RuntimeAdapter(runner);
		await expect(adapter.run(baseRequest())).rejects.toMatchObject({ kind: "schema_violation" });
	});

	it("maps timeout and cancel errors", async () => {
		const timeoutRunner: StructuredRunner = async () => {
			throw new Error("request timed out");
		};
		await expect(new RuntimeAdapter(timeoutRunner).run(baseRequest())).rejects.toMatchObject({
			kind: "timeout",
		});

		const cancelRunner: StructuredRunner = async () => {
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		};
		await expect(new RuntimeAdapter(cancelRunner).run(baseRequest())).rejects.toMatchObject({
			kind: "cancelled",
		});

		const controller = new AbortController();
		controller.abort();
		await expect(
			new RuntimeAdapter(async () => okResult({})).run(baseRequest(controller.signal)),
		).rejects.toMatchObject({
			kind: "cancelled",
		});
	});

	it("maps maxRuntimeMs abortReason to retryable timeout, not cancelled", async () => {
		const runtimeLimitRunner: StructuredRunner = async () => ({
			result: {
				id: "raw_rt",
				aborted: true,
				abortReason: "Subagent runtime limit exceeded (task.maxRuntimeMs=180000)",
			},
		});
		await expect(new RuntimeAdapter(runtimeLimitRunner).run(baseRequest())).rejects.toMatchObject({
			kind: "timeout",
			message: expect.stringMatching(/runtime limit exceeded/i),
		});

		const plainAbortRunner: StructuredRunner = async () => ({
			result: {
				id: "raw_cancel",
				aborted: true,
				abortReason: "Cancelled by caller",
			},
		});
		await expect(new RuntimeAdapter(plainAbortRunner).run(baseRequest())).rejects.toMatchObject({
			kind: "cancelled",
		});
	});

	it("maps non-aborted budget_stop completionKind to budget_exhausted", async () => {
		const runner: StructuredRunner = async () =>
			okResult({ kind: "plan", summary: "forced yield" }, { completionKind: "budget_stop" });
		await expect(new RuntimeAdapter(runner).run(baseRequest())).rejects.toMatchObject({
			kind: "budget_exhausted",
			details: { completionKind: "budget_stop" },
		});
	});

	it("does not invent completed provenance when the runner omits completionKind", async () => {
		const result = await new RuntimeAdapter(async () => okResult({ ok: true })).run(baseRequest());
		expect(result.completionKind).toBeUndefined();
	});

	it("forwards an explicit completed completionKind from the runner", async () => {
		const result = await new RuntimeAdapter(async () => okResult({ ok: true }, { completionKind: "completed" })).run(
			baseRequest(),
		);
		expect(result.completionKind).toBe("completed");
	});

	it("preserves request and abort signal on buildRequest", () => {
		const adapter = new RuntimeAdapter(async () => okResult({}));
		const controller = new AbortController();
		const req = baseRequest(controller.signal);
		expect(adapter.buildRequest(req)).toBe(req);
		expect(adapter.buildRequest(req).signal).toBe(controller.signal);
	});

	it("maps workflow roles to registered bundled agent names", () => {
		expect(RuntimeAdapter.agentNameForRole("planner")).toBe("designer");
		expect(RuntimeAdapter.agentNameForRole("plan_reviewer")).toBe("reviewer");
		expect(RuntimeAdapter.agentNameForRole("implementer")).toBe("task");
		expect(RuntimeAdapter.agentNameForRole("code_reviewer")).toBe("reviewer");
		expect(RuntimeAdapter.agentNameForRole("repair")).toBe("task");
	});

	it("forwards mapped agent name to the runner", async () => {
		let seenAgent: string | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seenAgent = req.agent;
			return okResult({ ok: true });
		});
		await adapter.run(baseRequest());
		expect(seenAgent).toBe("task"); // implementer → task
	});

	it("forwards processToolResult/transformTools and session.workflowToolOptimization on real run path", async () => {
		let seen: StructuredRunnerRequest | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seen = req;
			return okResult(implArtifact());
		});
		const profile = DEFAULT_MODEL_PROFILES.grok_implementer;
		await adapter.run(
			baseRequest(undefined, {
				profile,
				role: "implementer",
				outputSchema: {
					type: "object",
					properties: { summary: { type: "string" } },
					required: ["summary"],
				},
			}),
		);

		expect(seen).toBeDefined();
		// schemaMode honors outputStrategy.schemaEnhancement.strictMode === false → permissive
		expect(seen!.schemaMode).toBe("permissive");
		expect(typeof seen!.processToolResult).toBe("function");
		expect(typeof seen!.transformTools).toBe("function");

		const huge = `${"ok line\n".repeat(400)}ERROR: compile failed\n`;
		const processed = seen!.processToolResult!("bash", huge, { exitCode: 1 });
		expect(processed.length).toBeLessThan(huge.length);
		expect(processed).toMatch(/ERROR|Exit code/);

		const tools = seen!.transformTools!([
			{ name: "bash", schema: { type: "object", properties: { command: { type: "string" } } } },
			{ name: "read", schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
		]);
		expect(tools[0]?.customWireName).toBe("run_command");
		expect(tools[1]?.schema?.properties).toHaveProperty("file_path");

		// Live tool path: same processResult installed on the session handed to the runner.
		const sessionOpt = seen!.session.workflowToolOptimization;
		expect(sessionOpt?.processResult).toBeDefined();
		expect(sessionOpt?.toolAliases?.bash).toBe("run_command");
		const viaSession = sessionOpt!.processResult("bash", huge, { exitCode: 1 });
		expect(viaSession.length).toBeLessThan(huge.length);
	});

	it("uses strict schemaMode when profile enables strictMode", async () => {
		let seenMode: string | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seenMode = req.schemaMode;
			return okResult(implArtifact());
		});
		const profile = DEFAULT_MODEL_PROFILES.gpt_planner;
		await adapter.run(
			baseRequest(undefined, {
				profile,
				role: "planner",
				isolation: undefined,
			}),
		);
		expect(seenMode).toBe("strict");
	});

	it("attaches workflow-scoped write and command policy to write stages", async () => {
		let seenSession: WorkflowAgentRequest["session"] | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seenSession = req.session;
			return okResult(implArtifact());
		});
		await adapter.run(baseRequest());
		const policySession = seenSession as WorkflowAgentRequest["session"] & {
			workflowWritePolicy?: { repoRoot: string; forbiddenPaths: string[] };
			workflowCommandPolicy?: { allowedCommands: string[] };
		};
		expect(policySession.workflowWritePolicy).toMatchObject({
			repoRoot: "/tmp",
			forbiddenPaths: expect.arrayContaining(["package.json", "bun.lock"]),
		});
		expect(policySession.workflowCommandPolicy?.allowedCommands).toEqual(
			expect.arrayContaining(["bun test", "bun check", "biome check"]),
		);
	});

	it("reports resolved runtime model and tool-call usage without trusting artifact claims", async () => {
		const adapter = new RuntimeAdapter(async () => ({
			result: {
				id: "resolved",
				structuredOutput: { status: "valid", data: implArtifact({ provider: "fake", model: "fake" }) },
				resolvedModel: "anthropic/claude-sonnet-4",
				toolCalls: 7,
			},
		}));
		const result = await adapter.run(baseRequest());
		expect(result.resolvedProvider).toBe("anthropic");
		expect(result.resolvedModel).toBe("claude-sonnet-4");
		expect(result.toolCalls).toBe(7);
	});

	it("maps supported profile thinking level into the structured request", async () => {
		let thinkingLevel: string | undefined;
		const adapter = new RuntimeAdapter(async request => {
			thinkingLevel = request.thinkingLevel;
			return okResult(implArtifact());
		});
		const request = baseRequest();
		const high = "high" as NonNullable<WorkflowAgentRequest["profile"]["thinkingLevel"]>;
		request.profile = { ...request.profile, thinkingLevel: high };
		await adapter.run(request);
		expect(thinkingLevel).toBe(high);
	});

	it("fails when exitCode is non-zero even if structured output is valid", async () => {
		const runner: StructuredRunner = async () => okResult({ kind: "implementation", summary: "ok" }, { exitCode: 1 });
		await expect(new RuntimeAdapter(runner).run(baseRequest())).rejects.toMatchObject({
			kind: "tool_failure",
		});
	});

	it("fails when aborted or error is present even if structured output is valid", async () => {
		const aborted: StructuredRunner = async () =>
			okResult({ kind: "implementation", summary: "ok" }, { aborted: true, exitCode: 130 });
		await expect(new RuntimeAdapter(aborted).run(baseRequest())).rejects.toMatchObject({
			kind: "cancelled",
		});

		const errored: StructuredRunner = async () =>
			okResult({ kind: "implementation", summary: "ok" }, { error: "provider died", exitCode: 0 });
		await expect(new RuntimeAdapter(errored).run(baseRequest())).rejects.toMatchObject({
			kind: "provider_permanent",
		});
	});

	it("injects versioned workflow prompt template into runner context", async () => {
		let seenContext: string | undefined;
		let seenAssignment: string | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seenContext = req.context;
			seenAssignment = req.assignment;
			return okResult({ ok: true });
		});
		await adapter.run(baseRequest());
		expect(seenAssignment).toBe("implement");
		expect(seenContext).toMatch(/Workflow Implementer/i);
		expect(seenContext).toMatch(/Injection boundary/i);
		expect(seenContext).toContain("ctx");
	});

	it("retries schema violations with each actual remaining profile cap", async () => {
		let calls = 0;
		let now = 10_000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const contexts: string[] = [];
		const requestShapes: Array<{ invocationKind: string; maxRuntimeMs: number | undefined }> = [];
		const adapter = new RuntimeAdapter(async req => {
			calls += 1;
			contexts.push(req.context ?? "");
			requestShapes.push({ invocationKind: req.invocationKind, maxRuntimeMs: req.maxRuntimeMs });
			if (calls === 1) {
				now += 1_234;
				return {
					result: {
						id: "bad",
						structuredOutput: { status: "invalid", error: "missing summary" },
					},
				};
			}
			return okResult(implArtifact());
		});
		const profile = {
			...DEFAULT_MODEL_PROFILES.grok_implementer,
			outputStrategy: {
				...DEFAULT_MODEL_PROFILES.grok_implementer.outputStrategy,
				retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
			},
		};
		try {
			const result = await adapter.run(baseRequest(undefined, { profile, role: "implementer" }));
			expect(result.artifact).toBeDefined();
		} finally {
			nowSpy.mockRestore();
		}
		expect(calls).toBe(2);
		expect(requestShapes).toEqual([
			{ invocationKind: "task", maxRuntimeMs: profile.maxRuntimeMs },
			{ invocationKind: "task", maxRuntimeMs: profile.maxRuntimeMs - 1_234 },
		]);
		expect(contexts[1]).toMatch(/violated the required output schema|Violations/i);
		expect(contexts[1]).toMatch(/missing summary/);
	});

	it("maxRetries=0 means no additional model calls", async () => {
		let calls = 0;
		const adapter = new RuntimeAdapter(async () => {
			calls += 1;
			return {
				result: {
					id: "bad",
					structuredOutput: { status: "invalid", error: "bad" },
				},
			};
		});
		await expect(
			adapter.run(
				baseRequest(undefined, {
					profile: {
						...baseRequest().profile,
						outputStrategy: {
							retryOnSchemaViolation: { enabled: true, maxRetries: 0, includeErrorInRetry: true },
						},
					},
				}),
			),
		).rejects.toMatchObject({ kind: "schema_violation" });
		expect(calls).toBe(1);
	});

	it("maxRetries=1 allows one additional model call (total 2)", async () => {
		let calls = 0;
		const adapter = new RuntimeAdapter(async () => {
			calls += 1;
			if (calls === 1) {
				return {
					result: {
						id: "bad",
						structuredOutput: { status: "invalid", error: "bad" },
					},
				};
			}
			return okResult(implArtifact());
		});
		await adapter.run(
			baseRequest(undefined, {
				profile: {
					...DEFAULT_MODEL_PROFILES.grok_implementer,
					outputStrategy: {
						retryOnSchemaViolation: { enabled: true, maxRetries: 1, includeErrorInRetry: true },
					},
				},
			}),
		);
		expect(calls).toBe(2);
	});

	it("does not retry schema violations when retry is disabled", async () => {
		let calls = 0;
		const adapter = new RuntimeAdapter(async () => {
			calls += 1;
			return {
				result: {
					id: "bad",
					structuredOutput: { status: "invalid", error: "bad json" },
				},
			};
		});
		await expect(
			adapter.run(
				baseRequest(undefined, {
					profile: {
						...baseRequest().profile,
						outputStrategy: {
							retryOnSchemaViolation: { enabled: false, maxRetries: 3, includeErrorInRetry: true },
						},
					},
				}),
			),
		).rejects.toMatchObject({ kind: "schema_violation" });
		expect(calls).toBe(1);
	});

	it("optimizes explicit context entries on the real provider path with verified recovery refs", async () => {
		const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-context-opt-"));
		let seenContext = "";
		try {
			const adapter = new RuntimeAdapter(async request => {
				seenContext = request.context ?? "";
				return okResult(implArtifact());
			});
			const result = await adapter.run(
				baseRequest(undefined, {
					session: fakeSession({ getArtifactsDir: () => artifactDir }),
					contextEntries: [
						{ id: "attachment-1", bucket: "artifacts", kind: "attachment", content: "same attachment" },
						{ id: "attachment-2", bucket: "artifacts", kind: "attachment", content: "same attachment" },
						{
							id: "tool-old",
							bucket: "tool_results",
							kind: "tool_result",
							content: "old tool body",
							replaceable: true,
						},
						{
							id: "tool-current",
							bucket: "tool_results",
							kind: "tool_result",
							content: "current tool body",
						},
					],
				}),
			);

			expect(seenContext).toContain("same attachment");
			expect(seenContext).toContain("[context ref: artifact://");
			expect(seenContext).not.toContain("old tool body");
			expect(seenContext).toContain("current tool body");
			expect(result.contextLedger?.optimizationReceipts).toHaveLength(2);
			expect(result.contextLedger?.artifactRefs).toHaveLength(2);
			expect(result.contextLedger?.buckets.tool_results.bytes).toBeGreaterThan(0);
			for (const receipt of result.contextLedger?.optimizationReceipts ?? []) {
				const id = receipt.artifactRef.replace("artifact://", "");
				const file = (await fs.readdir(artifactDir)).find(name => name.startsWith(`${id}.`));
				expect(file).toBeDefined();
				const recovered = await Bun.file(path.join(artifactDir, file!)).text();
				expect(["same attachment", "old tool body"]).toContain(recovered);
			}
		} finally {
			await fs.rm(artifactDir, { recursive: true, force: true });
		}
	});

	it("keeps oversized attachment, history, and handoff inline after artifact persistence failure", async () => {
		const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-context-persist-fail-"));
		const manager = new ArtifactManager(artifactDir);
		const allocationSpy = vi
			.spyOn(manager, "allocatePath")
			.mockRejectedValue(new Error("injected context artifact persistence failure"));
		let calls = 0;
		let seenContext = "";
		try {
			const adapter = new RuntimeAdapter(async request => {
				calls += 1;
				seenContext = request.context ?? "";
				return okResult(implArtifact());
			});
			const profile = baseRequest().profile;
			const result = await adapter.run(
				baseRequest(undefined, {
					profile: { ...profile, contextPolicy: { ...profile.contextPolicy, maxArtifactBytes: 1 } },
					session: fakeSession({ getArtifactManager: () => manager }),
					contextEntries: contextFailureEntries(),
				}),
			);

			expect(calls).toBe(1);
			expect(allocationSpy).toHaveBeenCalled();
			expect(seenContext).toContain(LARGE_CONTEXT_ATTACHMENT);
			expect(seenContext.split(LARGE_CONTEXT_ATTACHMENT)).toHaveLength(3);
			expect(seenContext).toContain("HISTORY_TAIL");
			expect(seenContext.endsWith("HISTORY_TAIL\n\nHANDOFF_TAIL")).toBe(true);
			expect(result.promptAssemblyReceipt?.totalBytes).toBe(Buffer.byteLength(seenContext, "utf8"));
			expect(result.contextLedger?.buckets.artifacts.bytes).toBe(
				Buffer.byteLength(LARGE_CONTEXT_ATTACHMENT, "utf8") * 2,
			);
			expect(result.contextLedger?.buckets.history.bytes).toBe(Buffer.byteLength("HISTORY_TAIL", "utf8"));
			expect(result.contextLedger?.buckets.handoff.bytes).toBe(
				Buffer.byteLength("## Context\nctx", "utf8") + Buffer.byteLength("HANDOFF_TAIL", "utf8"),
			);
			expect(result.contextLedger?.artifactRefs).toEqual([]);
			expect(result.contextLedger?.optimizationReceipts).toEqual([]);
			expect(await fs.readdir(artifactDir)).toEqual([]);
		} finally {
			allocationSpy.mockRestore();
			await fs.rm(artifactDir, { recursive: true, force: true });
		}
	});

	it("keeps oversized attachment, history, and handoff inline after artifact verification failure", async () => {
		const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-context-verify-fail-"));
		const manager = new ArtifactManager(artifactDir);
		const realReadFile = nodeFs.promises.readFile.bind(nodeFs.promises);
		const artifactReads = new Map<string, number>();
		const readFileSpy = vi.spyOn(nodeFs.promises, "readFile").mockImplementation((async (
			file: string,
			encoding?: BufferEncoding,
		) => {
			const target = String(file);
			if (target.startsWith(artifactDir) && target.endsWith(".log")) {
				const reads = (artifactReads.get(target) ?? 0) + 1;
				artifactReads.set(target, reads);
				if (reads === 2) {
					const error = new Error("injected context artifact verification failure") as NodeJS.ErrnoException;
					error.code = "EIO";
					throw error;
				}
			}
			if (encoding === undefined) return realReadFile(file);
			return realReadFile(file, encoding);
		}) as typeof nodeFs.promises.readFile);
		let calls = 0;
		let seenContext = "";
		try {
			const adapter = new RuntimeAdapter(async request => {
				calls += 1;
				seenContext = request.context ?? "";
				return okResult(implArtifact());
			});
			const profile = baseRequest().profile;
			const result = await adapter.run(
				baseRequest(undefined, {
					profile: { ...profile, contextPolicy: { ...profile.contextPolicy, maxArtifactBytes: 1 } },
					session: fakeSession({ getArtifactManager: () => manager }),
					contextEntries: contextFailureEntries(),
				}),
			);

			expect(calls).toBe(1);
			expect(artifactReads.size).toBe(1);
			expect([...artifactReads.values()]).toEqual([2]);
			expect(seenContext).toContain(LARGE_CONTEXT_ATTACHMENT);
			expect(seenContext.split(LARGE_CONTEXT_ATTACHMENT)).toHaveLength(3);
			expect(seenContext).toContain("HISTORY_TAIL");
			expect(seenContext.endsWith("HISTORY_TAIL\n\nHANDOFF_TAIL")).toBe(true);
			expect(result.promptAssemblyReceipt?.totalBytes).toBe(Buffer.byteLength(seenContext, "utf8"));
			expect(result.contextLedger?.buckets.artifacts.bytes).toBe(
				Buffer.byteLength(LARGE_CONTEXT_ATTACHMENT, "utf8") * 2,
			);
			expect(result.contextLedger?.buckets.history.bytes).toBe(Buffer.byteLength("HISTORY_TAIL", "utf8"));
			expect(result.contextLedger?.buckets.handoff.bytes).toBe(
				Buffer.byteLength("## Context\nctx", "utf8") + Buffer.byteLength("HANDOFF_TAIL", "utf8"),
			);
			expect(result.contextLedger?.artifactRefs).toEqual([]);
			expect(result.contextLedger?.optimizationReceipts).toEqual([]);
			expect(await fs.readdir(artifactDir)).toEqual([]);
		} finally {
			readFileSpy.mockRestore();
			await fs.rm(artifactDir, { recursive: true, force: true });
		}
	});

	it("keeps explicit context inline when no recoverable artifact store is available", async () => {
		let seenContext = "";
		const adapter = new RuntimeAdapter(async request => {
			seenContext = request.context ?? "";
			return okResult(implArtifact());
		});
		const result = await adapter.run(
			baseRequest(undefined, {
				contextEntries: [
					{
						id: "tool-old",
						bucket: "tool_results",
						kind: "tool_result",
						content: "must stay inline",
						replaceable: true,
					},
				],
			}),
		);

		expect(seenContext).toContain("must stay inline");
		expect(result.contextLedger?.optimizationReceipts).toEqual([]);
		expect(result.contextLedger?.artifactRefs).toEqual([]);
	});

	it("Layer1 fence repair returns schemaRepairReceipt without extra model call", async () => {
		const fenced = `\uFEFF\`\`\`json\n{"summary":"from-layer1"}\n\`\`\``;
		let calls = 0;
		const adapter = new RuntimeAdapter(async () => {
			calls += 1;
			return {
				result: {
					id: "raw",
					structuredOutput: { status: "invalid", error: "parse failed", data: fenced },
					rawOutput: fenced,
					exitCode: 1,
				},
			};
		});
		const result = await adapter.run(
			baseRequest(undefined, {
				outputSchema: {
					type: "object",
					required: ["summary"],
					properties: { summary: { type: "string" } },
				},
				profile: {
					...DEFAULT_MODEL_PROFILES.grok_implementer,
					outputStrategy: {
						retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
					},
				},
			}),
		);
		expect(calls).toBe(1);
		expect(result.artifact).toEqual({ summary: "from-layer1" });
		expect(result.schemaRepairReceipt).toMatchObject({
			modelCalls: 0,
			layer1Success: true,
			finalStatus: "repaired_layer1",
		});
	});
});
