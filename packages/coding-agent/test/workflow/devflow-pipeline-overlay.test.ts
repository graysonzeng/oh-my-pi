import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runDeliveryPipeline } from "../../src/modes/delivery";
import gateReviewAdapterPrompt from "../../src/prompts/workflow/gate-review-adapter.md" with { type: "text" };
import { lookupBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { AVAILABILITY_ROLE_ORDER } from "../../src/workflow/availability-candidates";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowCancelledError } from "../../src/workflow/errors";
import { gateAdapter } from "../../src/workflow/gate-adapter";
import { derivePlanReviewArtifactV2 } from "../../src/workflow/gate-derive";
import { GateResultJsonSchema } from "../../src/workflow/json-schemas";
import {
	emptyDevflowSidecar,
	parseOverlaySidecar,
	parsePipelineCompletenessResult,
	sidecarWithGrillPause,
} from "../../src/workflow/overlay";
import { buildRequirementsSnapshot } from "../../src/workflow/requirements-snapshot";
import { RuntimeAdapter, resolvePipelineReviewAgent, WORKFLOW_ROLE_TO_AGENT } from "../../src/workflow/runtime-adapter";
import { GateParseError, parseGateResultArtifact } from "../../src/workflow/schemas";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { WorkflowState } from "../../src/workflow/types";
import { WorkflowTool } from "../../src/workflow/workflow-tool";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

type GateFindingFixture = {
	id: string;
	priority: string;
	category: string;
	status: string;
	confidence: number;
	summary: string;
	explanation: string;
	suggestedOwner: string;
	blocking?: boolean;
};

function gateFinding(overrides: Partial<GateFindingFixture> = {}): GateFindingFixture {
	return {
		id: "f1",
		priority: "P3",
		category: "testing",
		status: "open",
		confidence: 0.8,
		summary: "note",
		explanation: "non-blocking note",
		suggestedOwner: "implementer",
		...overrides,
	};
}

function gateRaw(
	verdict: string,
	subject: "plan" | "implementation",
	findings: GateFindingFixture[] = [],
	extra: Record<string, unknown> = {},
) {
	return {
		verdict,
		subject,
		findings,
		notes: "",
		explanation: `verdict=${verdict}`,
		...extra,
	};
}

const completeAuditor = async () => ({ complete: true, missing: [] as string[] });

describe("DevFlow overlay slash + coordinator", () => {
	it("lookupBuiltinSlashCommand(delivery) resolves and handle dispatches op=run pipeline=devflow", async () => {
		const spec = lookupBuiltinSlashCommand("delivery");
		expect(spec?.name).toBe("delivery");
		expect(spec?.handle).toBeTypeOf("function");

		const calls: unknown[] = [];
		const runtime = {
			session: {
				getToolByName: () => ({
					execute: async (_id: string, input: unknown) => {
						calls.push(input);
						return {
							content: [{ type: "text", text: "ran" }],
							details: { op: "run", workflowId: "wf_1", status: "completed", maxStepsReached: false },
						};
					},
				}),
				sessionManager: { getEntries: () => [] },
			},
			output: async () => {},
		} as unknown as SlashCommandRuntime;

		await spec!.handle!({ name: "delivery", args: "ship the overlay", text: "/delivery ship the overlay" }, runtime);
		expect(calls).toEqual([{ op: "run", request: "ship the overlay", pipeline: "devflow" }]);
		expect(JSON.stringify(calls)).not.toContain("workflowz");
	});

	it("production handle uses tool auditor and does not INSERT when preflight is incomplete", async () => {
		const spec = lookupBuiltinSlashCommand("delivery");
		const calls: unknown[] = [];
		const runtime = {
			session: {
				getToolByName: () => ({
					auditDeliveryCompleteness: async () => ({
						complete: false,
						missing: ["acceptance criteria"],
						next: "What is the acceptance test?",
					}),
					execute: async (_id: string, input: unknown) => {
						calls.push(input);
						return { content: [{ type: "text", text: "should not run" }] };
					},
				}),
				sessionManager: { getEntries: () => [] },
			},
			output: async () => {},
		} as unknown as SlashCommandRuntime;
		await spec!.handle!({ name: "delivery", args: "ship incomplete", text: "/delivery ship incomplete" }, runtime);
		expect(calls).toEqual([]);
	});

	it("queries the workflow tool with the persistent session owner before deciding resume versus run", async () => {
		const queriedOwners: string[] = [];
		const calls: unknown[] = [];
		const workflow = {
			findActiveDeliveryWorkflow: async (ownerSessionId: string) => {
				queriedOwners.push(ownerSessionId);
				return { id: "wf_owned", runnerOwner: undefined, overlaySidecar: emptyDevflowSidecar() };
			},
			execute: async (_id: string, input: unknown) => {
				calls.push(input);
				return {
					content: [{ type: "text", text: "resumed" }],
					details: {
						op: "resume" as const,
						workflowId: "wf_owned",
						status: "completed" as const,
						approvalTier: "write" as const,
					},
				};
			},
		};
		const runtime = {
			session: {
				getToolByName: () => workflow,
				sessionManager: { getEntries: () => [] },
			},
			sessionManager: { getSessionId: () => "session-owner" },
			settings: { get: () => ":memory:" },
			output: async () => {},
		} as unknown as SlashCommandRuntime;

		await runDeliveryPipeline(runtime, "must not start another workflow");
		expect(queriedOwners).toEqual(["session-owner"]);
		expect(calls).toEqual([{ op: "resume", workflowId: "wf_owned" }]);
	});

	it("keeps two production /delivery sessions on their own locked workflows", async () => {
		const store = new WorkflowStore(":memory:");
		try {
			const firstId = await store.createWorkflow(
				{ request: "first" },
				{},
				{ pipelineKind: "devflow", overlaySidecar: emptyDevflowSidecar(), ownerSessionId: "session-a" },
			);
			const secondId = await store.createWorkflow(
				{ request: "second" },
				{},
				{ pipelineKind: "devflow", overlaySidecar: emptyDevflowSidecar(), ownerSessionId: "session-b" },
			);
			const first = await store.getCurrentState(firstId);
			const second = await store.getCurrentState(secondId);
			await store.claimRunner(firstId, "runner-a", first!.version);
			await store.claimRunner(secondId, "runner-b", second!.version);

			const runSession = async (sessionId: string) => {
				const outputs: string[] = [];
				const toolSession = fakeSession({ getSessionId: () => sessionId });
				const workflow = new WorkflowTool(
					toolSession,
					session => new WorkflowEngine({ store, session, verifier: passVerifier() }),
				);
				await runDeliveryPipeline(
					{
						session: {
							getToolByName: () => workflow,
							sessionManager: { getEntries: () => [] },
						},
						sessionManager: { getSessionId: () => sessionId },
						output: async (text: string) => {
							outputs.push(text);
						},
					} as unknown as SlashCommandRuntime,
					"must not start",
				);
				return outputs.at(-1);
			};

			expect(await runSession("session-a")).toContain(firstId);
			expect(await runSession("session-b")).toContain(secondId);
		} finally {
			store.close();
		}
	});

	it("clears persisted non-redesign grill pauses before the coordinator resumes", async () => {
		for (const reason of ["incomplete_plan", "gate_parse_failed", "max_grill_questions"] as const) {
			const store = new WorkflowStore(":memory:");
			try {
				const workflowId = await store.createWorkflow(
					{ request: reason },
					{},
					{
						pipelineKind: "devflow",
						ownerSessionId: `session-${reason}`,
						overlaySidecar: sidecarWithGrillPause(
							emptyDevflowSidecar(),
							reason,
							["missing detail"],
							"What is missing?",
						),
					},
				);
				const toolSession = fakeSession({ getSessionId: () => `session-${reason}` });
				const realTool = new WorkflowTool(
					toolSession,
					session => new WorkflowEngine({ store, session, verifier: passVerifier() }),
				);
				let stateAtResume: WorkflowState | null | undefined;
				const workflow = {
					findActiveDeliveryWorkflow: (ownerSessionId: string) =>
						realTool.findActiveDeliveryWorkflow(ownerSessionId),
					recoverDeliveryGrill: (id: string, answers: readonly string[]) =>
						realTool.recoverDeliveryGrill(id, answers),
					execute: async (_id: string, input: { op: string; workflowId?: string }) => {
						stateAtResume = await store.getCurrentState(workflowId);
						return {
							content: [{ type: "text", text: "resumed" }],
							details: {
								op: input.op as "resume",
								workflowId: input.workflowId,
								status: "completed" as const,
								approvalTier: "write" as const,
							},
						};
					},
				};
				await runDeliveryPipeline(
					{
						session: {
							getToolByName: () => workflow,
							sessionManager: { getEntries: () => [] },
						},
						sessionManager: { getSessionId: () => `session-${reason}` },
						output: async () => {},
					} as unknown as SlashCommandRuntime,
					"the missing answer",
				);

				expect(stateAtResume?.overlaySidecar?.phase).toBe("idle");
				expect(stateAtResume?.overlaySidecar?.grill.reason).toBeUndefined();
				expect(stateAtResume?.overlaySidecar?.grill.lastQuestion).toBe("");
				expect(stateAtResume?.overlaySidecar?.grill.answers).toEqual(["the missing answer"]);
			} finally {
				store.close();
			}
		}
	});
	it("preserves the first request while collecting preflight answers", async () => {
		const calls: unknown[] = [];
		const auditedRequests: string[] = [];
		let complete = false;
		const runtime = {
			session: { getToolByName: () => undefined, sessionManager: { getEntries: () => [] } },
			output: async () => {},
		} as unknown as SlashCommandRuntime;
		const deps = {
			auditor: async (input: { request: string }) => {
				auditedRequests.push(input.request);
				return complete
					? { complete: true, missing: [] as string[] }
					: { complete: false, missing: ["acceptance"], next: "What is the acceptance test?" };
			},
			executeWorkflow: async (input: { op: string; grillAnswers?: string[] }) => {
				calls.push(input);
				return {
					content: [{ type: "text", text: "ran" }],
					details: {
						op: "run" as const,
						workflowId: "wf_pre",
						status: "planning" as const,
						approvalTier: "write" as const,
					},
				};
			},
		};
		await runDeliveryPipeline(runtime, "ship it", deps);
		expect(calls).toEqual([]);
		complete = true;
		await runDeliveryPipeline(runtime, "bun test is the bar", deps);
		expect(auditedRequests).toEqual(["ship it", "ship it"]);
		expect(calls).toEqual([
			{ op: "run", request: "ship it", pipeline: "devflow", grillAnswers: ["bun test is the bar"] },
		]);
	});

	it("asks all eight preflight questions before reporting unresolved detail", async () => {
		const outputs: string[] = [];
		const calls: unknown[] = [];
		let audits = 0;
		const runtime = {
			session: { getToolByName: () => undefined, sessionManager: { getEntries: () => [] } },
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as SlashCommandRuntime;
		const deps = {
			auditor: async () => {
				audits += 1;
				return { complete: false, missing: ["still missing"], next: `Question ${audits}?` };
			},
			executeWorkflow: async (input: unknown) => {
				calls.push(input);
				return { content: [{ type: "text", text: "should not run" }] };
			},
		};

		await runDeliveryPipeline(runtime, "original request", deps);
		for (let answer = 1; answer <= 8; answer += 1) {
			await runDeliveryPipeline(runtime, `answer ${answer}`, deps);
		}

		expect(outputs.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, index) => `Question ${index + 1}?`));
		expect(outputs.at(-1)).toBe("still missing");
		expect(calls).toEqual([]);
	});

	it("reports an owned active workflow lock without resuming or starting another workflow", async () => {
		const outputs: string[] = [];
		const ops: string[] = [];
		await runDeliveryPipeline(
			{
				session: { getToolByName: () => undefined, sessionManager: { getEntries: () => [] } },
				output: async (text: string) => {
					outputs.push(text);
				},
			} as unknown as SlashCommandRuntime,
			"new request must not start",
			{
				loadActiveDevflow: async () => ({ workflowId: "wf_locked", runnerOwner: "runner-1" }),
				executeWorkflow: async input => {
					ops.push(input.op);
					return { content: [{ type: "text", text: "unexpected" }] };
				},
			},
		);
		expect(ops).toEqual([]);
		expect(outputs.at(-1)).toContain("wf_locked");
		expect(outputs.at(-1)).toContain("runner-1");
	});

	it("resumes an unlocked owned active workflow instead of starting another workflow", async () => {
		const ops: string[] = [];
		await runDeliveryPipeline(
			{
				session: { getToolByName: () => undefined, sessionManager: { getEntries: () => [] } },
				output: async () => {},
			} as unknown as SlashCommandRuntime,
			"new request must not start",
			{
				loadActiveDevflow: async () => ({ workflowId: "wf_active", sidecar: emptyDevflowSidecar() }),
				executeWorkflow: async input => {
					ops.push(input.op);
					return {
						content: [{ type: "text", text: "resumed" }],
						details: {
							op: "resume",
							workflowId: "wf_active",
							status: "completed",
							approvalTier: "write",
						},
					};
				},
			},
		);
		expect(ops).toEqual(["resume"]);
	});

	it("grilling recovery without an explicit answer re-asks and does not append transcript tail", async () => {
		const answers: string[][] = [];
		const ops: string[] = [];
		const outputs: string[] = [];
		await runDeliveryPipeline(
			{
				session: {
					getToolByName: () => undefined,
					sessionManager: {
						getEntries: () => [{ type: "message", message: { role: "user", content: "original request" } }],
					},
				},
				output: async (text: string) => {
					outputs.push(text);
				},
			} as unknown as SlashCommandRuntime,
			"",
			{
				loadActiveDevflow: async () => ({
					workflowId: "wf_grill",
					sidecar: sidecarWithGrillPause(
						emptyDevflowSidecar(),
						"incomplete_plan",
						["scope"],
						"What is the scope?",
					),
				}),
				recoverGrill: async (_id, next) => {
					answers.push([...next]);
				},
				executeWorkflow: async input => {
					ops.push(input.op);
					return { content: [{ type: "text", text: "should not resume" }] };
				},
			},
		);
		expect(answers).toEqual([]);
		expect(ops).toEqual([]);
		expect(outputs.at(-1)).toBe("What is the scope?");
	});

	it("coordinator resumes when maxStepsReached and does not couple to workflowz", async () => {
		const ops: string[] = [];
		await runDeliveryPipeline(
			{
				session: { getToolByName: () => undefined, sessionManager: { getEntries: () => [] } },
				output: async () => {},
			} as unknown as SlashCommandRuntime,
			"continue shipping",
			{
				collectRequest: args => args,
				executeWorkflow: async input => {
					ops.push(input.op);
					if (input.op === "run") {
						return {
							content: [{ type: "text", text: "capped" }],
							details: {
								op: "run",
								workflowId: "wf_cap",
								status: "implementing",
								approvalTier: "write",
								maxStepsReached: true,
								awaitingGrill: false,
							},
						};
					}
					return {
						content: [{ type: "text", text: "resumed" }],
						details: {
							op: "resume",
							workflowId: "wf_cap",
							status: "completed",
							approvalTier: "write",
							maxStepsReached: false,
						},
					};
				},
			},
		);
		expect(ops).toEqual(["run", "resume"]);
	});

	it("coordinator recovers redesign answers before resume", async () => {
		const ops: string[] = [];
		const recoveries: Array<{ workflowId: string; answers: readonly string[] }> = [];
		await runDeliveryPipeline(
			{
				session: { getToolByName: () => undefined, sessionManager: { getEntries: () => [] } },
				output: async () => {},
			} as unknown as SlashCommandRuntime,
			"keep the public API",
			{
				loadActiveDevflow: async () => ({
					workflowId: "wf_grill",
					sidecar: sidecarWithGrillPause(emptyDevflowSidecar(), "needs_redesign", ["scope"], "What is the API?"),
				}),
				recoverGrill: async (workflowId, answers) => {
					recoveries.push({ workflowId, answers });
				},
				executeWorkflow: async input => {
					ops.push(input.op);
					return {
						content: [{ type: "text", text: "resumed" }],
						details: {
							op: "resume",
							workflowId: "wf_grill",
							status: "planning",
							approvalTier: "write",
						},
					};
				},
			},
		);
		expect(recoveries).toEqual([{ workflowId: "wf_grill", answers: ["keep the public API"] }]);
		expect(ops).toEqual(["resume"]);
		expect(ops).not.toContain("run");
	});
});

describe("pipeline completeness parse", () => {
	it("accepts complete JSON and rejects invalid shapes fail-closed", () => {
		expect(parsePipelineCompletenessResult({ complete: true, missing: [] })).toEqual({
			complete: true,
			missing: [],
			next: undefined,
		});
		expect(
			parsePipelineCompletenessResult({ complete: false, missing: ["scope"], next: "What is the scope?" }),
		).toEqual({
			complete: false,
			missing: ["scope"],
			next: "What is the scope?",
		});
		expect(parsePipelineCompletenessResult({ complete: "yes" })).toBeUndefined();
		expect(parsePipelineCompletenessResult(null)).toBeUndefined();
	});
});

describe("DevFlow overlay create + hydrate", () => {
	it("INSERT writes pipeline_kind and pre-stage grill.answers; crash reopen still hydrates; no opts stays legacy", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-devflow-create-"));
		const dbPath = path.join(dir, "workflow.db");
		const answers = ["need acceptance tests", "do not shrink scope"];
		const store = new WorkflowStore(dbPath);
		const workflowId = await store.createWorkflow(
			{ request: "ship overlay" },
			{},
			{ pipelineKind: "devflow", overlaySidecar: emptyDevflowSidecar(answers) },
		);
		const created = await store.getCurrentState(workflowId);
		expect(created?.pipelineKind).toBe("devflow");
		expect(created?.overlaySidecar?.grill.answers).toEqual(answers);
		store.close();

		const reopened = new WorkflowStore(dbPath);
		const hydrated = await reopened.getCurrentState(workflowId);
		expect(hydrated?.pipelineKind).toBe("devflow");
		expect(hydrated?.overlaySidecar?.grill.answers).toEqual(answers);
		reopened.close();

		const legacyStore = new WorkflowStore(":memory:");
		const legacyId = await legacyStore.createWorkflow({ request: "legacy" }, {});
		const legacy = await legacyStore.getCurrentState(legacyId);
		expect(legacy?.pipelineKind).toBeUndefined();
		expect(legacy?.overlaySidecar).toBeUndefined();
		legacyStore.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("uses a versioned strict sidecar schema", () => {
		const sidecar = emptyDevflowSidecar(["keep scope"]);
		expect(sidecar.schemaVersion).toBe(1);
		expect(parseOverlaySidecar(JSON.stringify(sidecar))).toEqual(sidecar);
		expect(
			parseOverlaySidecar(
				JSON.stringify({
					...sidecar,
					unexpected: true,
				}),
			),
		).toBeUndefined();
		expect(
			parseOverlaySidecar(JSON.stringify({ schemaVersion: 1, phase: "running", grill: { answers: [] } })),
		).toBeUndefined();
	});

	it("fails closed when a persisted devflow sidecar is corrupt", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-devflow-corrupt-"));
		const dbPath = path.join(dir, "workflow.db");
		try {
			const store = new WorkflowStore(dbPath);
			const workflowId = await store.createWorkflow(
				{ request: "ship overlay" },
				{},
				{ pipelineKind: "devflow", overlaySidecar: emptyDevflowSidecar() },
			);
			store.close();
			const db = new Database(dbPath);
			db.prepare("UPDATE workflows SET overlay_sidecar_json = ? WHERE id = ?").run(
				'{"schemaVersion":1}',
				workflowId,
			);
			db.close();

			const reopened = new WorkflowStore(dbPath);
			try {
				await expect(reopened.getCurrentState(workflowId)).rejects.toThrow(/invalid_devflow_sidecar/);
			} finally {
				reopened.close();
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("finds active devflow only for its persisted owner session", async () => {
		const store = new WorkflowStore(":memory:");
		try {
			const firstId = await store.createWorkflow(
				{ request: "session A" },
				{},
				{
					pipelineKind: "devflow",
					overlaySidecar: emptyDevflowSidecar(),
					ownerSessionId: "session-a",
				},
			);
			await store.createWorkflow(
				{ request: "session B" },
				{},
				{
					pipelineKind: "devflow",
					overlaySidecar: emptyDevflowSidecar(),
					ownerSessionId: "session-b",
				},
			);

			const owned = await store.findLatestActiveDevflow("session-a");
			expect(owned?.id).toBe(firstId);
			expect(owned?.ownerSessionId).toBe("session-a");
			expect(await store.findLatestActiveDevflow("session-c")).toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("parseGateResultArtifact + PASS* blockers", () => {
	it("fails closed on wrong subject, stale id, family mismatch, and empty NEEDS_REVISION findings", () => {
		const expected = {
			subject: "plan" as const,
			workflowId: "wf_1",
			attemptId: "att_1",
			identity: { modelFamily: "sol" },
		};
		expect(() => parseGateResultArtifact(gateRaw("PASS", "implementation"), expected)).toThrow(GateParseError);
		expect(() => parseGateResultArtifact(gateRaw("PASS", "plan", [], { workflowId: "wf_stale" }), expected)).toThrow(
			GateParseError,
		);
		expect(() =>
			parseGateResultArtifact(gateRaw("PASS", "plan", [], { identity: { modelFamily: "grok" } }), expected),
		).toThrow(GateParseError);
		expect(() => parseGateResultArtifact(gateRaw("NEEDS_REVISION", "plan", []), expected)).toThrow(GateParseError);
	});

	it("stamps success when model omits id/identity", () => {
		const parsed = parseGateResultArtifact(gateRaw("PASS", "plan"), { subject: "plan" });
		expect(parsed.verdict).toBe("PASS");
		expect(parsed.workflowId).toBeUndefined();
	});

	it("PASS_WITH_NOTES + open P0 fails closed for plan and implementation and does not become NEEDS_REVISION", () => {
		const p0 = [gateFinding({ priority: "P0", summary: "blocker" })];
		for (const subject of ["plan", "implementation"] as const) {
			try {
				parseGateResultArtifact(gateRaw("PASS_WITH_NOTES", subject, p0), { subject });
				expect(true).toBe(false);
			} catch (error) {
				expect(error).toBeInstanceOf(GateParseError);
				expect((error as GateParseError).code).toBe("pass_open_blockers");
				expect((error as Error).message).not.toContain("NEEDS_REVISION");
			}
		}
	});

	it("PASS_WITH_NOTES + open non-blocking P3 is allowed", () => {
		const parsed = parseGateResultArtifact(
			gateRaw("PASS_WITH_NOTES", "implementation", [gateFinding({ priority: "P3", blocking: false })]),
			{ subject: "implementation" },
		);
		expect(parsed.verdict).toBe("PASS_WITH_NOTES");
		expect(gateAdapter(parsed.verdict, parsed.subject)).toBe("approve");
	});

	it("model-facing Gate schema keeps finding.blocking so Continuity P2 can reach parse", () => {
		const findingSchema = GateResultJsonSchema.properties.findings.items;
		expect(findingSchema.additionalProperties).toBe(false);
		expect(findingSchema.properties.blocking).toEqual({ type: "boolean" });
		expect(findingSchema.required).not.toContain("blocking");
	});

	it("Continuity P2: open P2/P3 with blocking true cannot stay on PASS*", () => {
		for (const priority of ["P2", "P3"] as const) {
			for (const subject of ["plan", "implementation"] as const) {
				try {
					parseGateResultArtifact(
						gateRaw("PASS_WITH_NOTES", subject, [gateFinding({ priority, blocking: true })]),
						{ subject },
					);
					expect(true).toBe(false);
				} catch (error) {
					expect(error).toBeInstanceOf(GateParseError);
					expect((error as GateParseError).code).toBe("pass_open_blockers");
					expect((error as Error).message).not.toContain("NEEDS_REVISION");
				}
			}
		}
	});
});

describe("Gate derive", () => {
	it("NEEDS_REVISION+plan derives V2 changes_requested with ≥1 finding and no model V2 extras required", () => {
		const snapshot = buildRequirementsSnapshot({ workflowId: "wf", request: { request: "ship" } });
		const derived = derivePlanReviewArtifactV2({
			gate: parseGateResultArtifact(
				gateRaw("NEEDS_REVISION", "plan", [gateFinding({ priority: "P1", summary: "missing tests" })]),
				{ subject: "plan" },
			),
			workflowId: "wf",
			attemptId: "att",
			stage: "plan_review",
			requirementsSnapshot: snapshot,
		});
		expect(derived.decision).toBe("changes_requested");
		expect(derived.findings.length).toBeGreaterThanOrEqual(1);
		expect(derived.antiAnchoringRationale.length).toBeGreaterThan(0);
	});

	it("NEEDS_REDESIGN+plan is replan_exempt and does not derive changes_requested", () => {
		const parsed = parseGateResultArtifact(gateRaw("NEEDS_REDESIGN", "plan"), { subject: "plan" });
		expect(gateAdapter(parsed.verdict, parsed.subject)).toBe("replan_exempt");
	});
});

describe("replanFromRedesign CAS", () => {
	let store: WorkflowStore;
	let engine: WorkflowEngine;

	beforeEach(() => {
		store = new WorkflowStore(":memory:");
		engine = new WorkflowEngine({ store, session: fakeSession(), verifier: passVerifier() });
	});

	afterEach(() => {
		store.close();
	});

	async function seedNeedsRedesign() {
		const workflowId = await store.createWorkflow(
			{ request: "redesign" },
			{},
			{
				pipelineKind: "devflow",
				overlaySidecar: sidecarWithGrillPause(emptyDevflowSidecar(["keep the original scope"]), "needs_redesign"),
			},
		);
		const created = await store.getCurrentState(workflowId);
		await store.transitionWorkflow(workflowId, "created", "planning", "fixture", undefined, created!.version);
		const planning = await store.getCurrentState(workflowId);
		await store.transitionWorkflow(workflowId, "planning", "plan_review", "fixture", undefined, planning!.version);
		return workflowId;
	}

	it("another owner holding the lock yields runner_lock_held with zero transition and unchanged owner", async () => {
		const workflowId = await seedNeedsRedesign();
		const before = await store.getCurrentState(workflowId);
		await store.claimRunner(workflowId, "other-owner", before!.version);
		const held = await store.getCurrentState(workflowId);
		const transitionsBefore = await store.listTransitions(workflowId);
		await expect(engine.replanFromRedesign(workflowId)).rejects.toThrow(/runner_lock_held/);
		const after = await store.getCurrentState(workflowId);
		expect(after?.runnerOwner).toBe("other-owner");
		expect(after?.status).toBe("plan_review");
		expect((await store.listTransitions(workflowId)).length).toBe(transitionsBefore.length);
		expect(held?.runnerOwner).toBe("other-owner");
	});

	it("success path is one workflow UPDATE with runner_owner=NULL, no releaseRunner, then idempotent no-op", async () => {
		const workflowId = await seedNeedsRedesign();
		const before = await store.getCurrentState(workflowId);
		const release = spyOn(store, "releaseRunner");
		const updated = await engine.replanFromRedesign(workflowId);
		expect(updated.status).toBe("planning");
		expect(updated.runnerOwner).toBeUndefined();
		expect(updated.overlaySidecar?.phase).toBe("idle");
		expect(updated.overlaySidecar?.grill.answers).toEqual(["keep the original scope"]);
		expect(updated.version).toBe(before!.version + 1);
		expect(release).not.toHaveBeenCalled();
		const transitions = await store.listTransitions(workflowId);
		expect(transitions.at(-1)?.reason).toBe("plan_review:needs_redesign");

		const second = await engine.replanFromRedesign(workflowId);
		expect(second.version).toBe(updated.version);
		expect(second.runnerOwner).toBeUndefined();
		expect(release).not.toHaveBeenCalled();
		release.mockRestore();
	});

	it("N>=3 redesigns stay non-terminal and legacy calls fail closed", async () => {
		const workflowId = await seedNeedsRedesign();
		for (let i = 0; i < 3; i++) {
			if (i > 0) {
				const planning = await store.getCurrentState(workflowId);
				await store.transitionWorkflow(
					workflowId,
					"planning",
					"plan_review",
					"fixture-back",
					undefined,
					planning!.version,
				);
				const review = await store.getCurrentState(workflowId);
				await store.updateOverlaySidecar(
					workflowId,
					sidecarWithGrillPause(review!.overlaySidecar ?? emptyDevflowSidecar(), "needs_redesign"),
					review!.version,
				);
			}
			const state = await engine.replanFromRedesign(workflowId);
			expect(state.status).toBe("planning");
			expect(state.status).not.toBe("blocked");
		}

		const legacyId = await store.createWorkflow({ request: "legacy" }, {});
		await expect(engine.replanFromRedesign(legacyId)).rejects.toThrow(/overlay_requires_devflow/);
	});
});

describe("DevFlow overlay engine contracts", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-devflow-engine-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	function engineWith(script: Parameters<typeof scriptedRunner>[0], auditor = completeAuditor) {
		return new WorkflowEngine({
			store,
			session: fakeSession(),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			pipelineAuditor: auditor,
			adapter: new RuntimeAdapter(scriptedRunner(script)),
		});
	}

	it("injects grill.answers into planner context", async () => {
		let planContext = "";
		const engine = new WorkflowEngine({
			store,
			session: fakeSession(),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			pipelineAuditor: completeAuditor,
			adapter: new RuntimeAdapter(async request => {
				if ((request.agent ?? "") === "designer") {
					planContext = request.context ?? "";
				}
				return scriptedRunner({
					plan: planArtifact(),
					gatePlanReview: gateRaw("PASS", "plan"),
					implement: implArtifact(),
					gateCodeReview: gateRaw("PASS", "implementation"),
				})(request);
			}),
		});
		const started = await engine.start(
			{ request: "ship with answers" },
			{},
			{ pipelineKind: "devflow", overlaySidecar: emptyDevflowSidecar(["must keep the public API"]) },
		);
		await engine.run(started.workflowId);
		expect(planContext).toContain("must keep the public API");
	});

	it("gate abort cancels instead of retrying into grill", async () => {
		let gateCalls = 0;
		const engine = new WorkflowEngine({
			store,
			session: fakeSession(),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			pipelineAuditor: completeAuditor,
			adapter: new RuntimeAdapter(async request => {
				if (request.workflowRole === "plan_reviewer") {
					gateCalls += 1;
					throw new WorkflowCancelledError("user abort");
				}
				return scriptedRunner({ plan: planArtifact() })(request);
			}),
		});
		const started = await engine.start({ request: "abort gate" }, {}, { pipelineKind: "devflow" });
		const result = await engine.run(started.workflowId);
		expect(gateCalls).toBe(1);
		expect(result.state.status).toBe("cancelled");
		expect(result.awaitingGrill).toBe(false);
		expect(result.overlayReason).not.toBe("gate_parse_failed");
	});

	it("completeness auditor abort cancels instead of grilling incomplete_plan", async () => {
		const engine = engineWith({ plan: planArtifact() }, async () => {
			throw new WorkflowCancelledError("auditor aborted");
		});
		const started = await engine.start({ request: "abort audit" }, {}, { pipelineKind: "devflow" });
		const result = await engine.run(started.workflowId);
		expect(result.state.status).toBe("cancelled");
		expect(result.awaitingGrill).toBe(false);
		expect(result.overlayReason).not.toBe("incomplete_plan");
	});

	it("planning completeness failure stays in planning and does not consume maxPlanCycles", async () => {
		const engine = engineWith({ plan: planArtifact() }, async () => ({
			complete: false,
			missing: ["acceptance criteria"],
			next: "What is the acceptance test?",
		}));
		const started = await engine.start({ request: "incomplete" }, {}, { pipelineKind: "devflow" });
		const result = await engine.run(started.workflowId);
		expect(result.state.status).toBe("planning");
		expect(result.awaitingGrill).toBe(true);
		expect(result.overlayReason).toBe("incomplete_plan");
		expect(result.state.status).not.toBe("plan_review");
		expect(result.state.status).not.toBe("blocked");
	});

	it("plan PASS_WITH_NOTES + open P0 does not approve or advance to implementing", async () => {
		const engine = engineWith({
			plan: planArtifact(),
			gatePlanReview: gateRaw("PASS_WITH_NOTES", "plan", [gateFinding({ priority: "P0", summary: "plan hole" })]),
		});
		const started = await engine.start({ request: "plan p0" }, {}, { pipelineKind: "devflow" });
		const result = await engine.run(started.workflowId);
		expect(result.state.status).not.toBe("implementing");
		expect(result.state.status).not.toBe("completed");
		expect(result.planReview?.decision).not.toBe("approved");
		expect(result.awaitingGrill).toBe(true);
	});

	it("implementation PASS_WITH_NOTES + open P0 does not approve or advance to final_verify", async () => {
		const engine = engineWith({
			plan: planArtifact(),
			gatePlanReview: gateRaw("PASS", "plan"),
			implement: implArtifact(),
			gateCodeReview: gateRaw("PASS_WITH_NOTES", "implementation", [
				gateFinding({ priority: "P0", summary: "ship bug" }),
			]),
		});
		const started = await engine.start({ request: "p0 review" }, {}, { pipelineKind: "devflow" });
		const result = await engine.run(started.workflowId);
		expect(result.state.status).not.toBe("final_verify");
		expect(result.state.status).not.toBe("completed");
		expect(result.codeReview?.decision).not.toBe("approved");
		expect(result.awaitingGrill).toBe(true);
	});

	it("plan PASS_WITH_NOTES + open P3 non-blocking can approve into implementing", async () => {
		const engine = engineWith({
			plan: planArtifact(),
			gatePlanReview: gateRaw("PASS_WITH_NOTES", "plan", [gateFinding({ priority: "P3", blocking: false })]),
			implement: implArtifact(),
			gateCodeReview: gateRaw("PASS", "implementation"),
		});
		const started = await engine.start({ request: "notes ok" }, {}, { pipelineKind: "devflow" });
		const result = await engine.run(started.workflowId);
		expect(result.state.status).toBe("completed");
	});

	it("NEEDS_REVISION that exhausts maxPlanCycles is terminal blocked and cannot resume", async () => {
		const engine = new WorkflowEngine({
			store,
			session: fakeSession(),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			pipelineAuditor: completeAuditor,
			config: { maxPlanCycles: 1 },
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					gatePlanReview: gateRaw("NEEDS_REVISION", "plan", [gateFinding({ priority: "P1", summary: "rework" })]),
				}),
			),
		});
		const started = await engine.start({ request: "cycle out" }, {}, { pipelineKind: "devflow" });
		const result = await engine.run(started.workflowId);
		expect(result.state.status).toBe("blocked");
		await expect(engine.resume(started.workflowId)).rejects.toThrow(/cannot_resume_terminal/);
	});

	it("implementation_verify and final_verify stay deterministic (no extra LLM agent)", async () => {
		const agents: string[] = [];
		const engine = new WorkflowEngine({
			store,
			session: fakeSession(),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			pipelineAuditor: completeAuditor,
			adapter: new RuntimeAdapter(async request => {
				agents.push(request.agent ?? request.assignment);
				return scriptedRunner({
					plan: planArtifact(),
					gatePlanReview: gateRaw("PASS", "plan"),
					implement: implArtifact(),
					gateCodeReview: gateRaw("PASS", "implementation"),
				})(request);
			}),
		});
		const started = await engine.start({ request: "verify" }, {}, { pipelineKind: "devflow" });
		const result = await engine.run(started.workflowId);
		expect(result.state.status).toBe("completed");
		expect(result.verification?.kind).toBe("verification");
		expect(result.finalVerification?.kind).toBe("verification");
		expect(agents.some(agent => /verif/i.test(agent))).toBe(false);
	});
	it("keeps Gate agent, model, and runtime identity aligned and records every parse retry", async () => {
		let planGateCalls = 0;
		const gateRequests: Array<{ agent?: string; model?: string | string[]; assignment: string }> = [];
		const baseRunner = scriptedRunner({
			plan: planArtifact(),
			implement: implArtifact(),
			gateCodeReview: gateRaw("PASS", "implementation"),
		});
		const engine = new WorkflowEngine({
			store,
			session: fakeSession(),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			pipelineAuditor: completeAuditor,
			adapter: new RuntimeAdapter(async request => {
				if (
					request.agent === "subagent-sol" ||
					request.agent === "subagent-grok" ||
					request.agent?.includes("claude")
				) {
					gateRequests.push({ agent: request.agent, model: request.model, assignment: request.assignment });
					if (request.workflowRole === "plan_reviewer") {
						planGateCalls += 1;
						const planRunner = scriptedRunner({
							gatePlanReview: planGateCalls === 1 ? gateRaw("PASS", "implementation") : gateRaw("PASS", "plan"),
						});
						return planRunner(request);
					}
				}
				return baseRunner(request);
			}),
		});
		const started = await engine.start({ request: "gate retry evidence" }, {}, { pipelineKind: "devflow" });
		const result = await engine.run(started.workflowId);
		expect(result.state.status).toBe("completed");
		expect(planGateCalls).toBe(2);
		for (const request of gateRequests) {
			const models = Array.isArray(request.model) ? request.model : [request.model ?? ""];
			const model = models.join(" ").toLowerCase();
			if (request.agent === "subagent-sol") expect(model).toContain("sol");
			if (request.agent === "subagent-grok") expect(model).toContain("grok");
			if (request.agent?.includes("claude")) expect(model).toContain("claude");
			expect(request.assignment).toBe(gateReviewAdapterPrompt.trim());
		}
		const artifacts = await new ArtifactStore(artifactDir).listByWorkflow(started.workflowId);
		const planAttemptId = (await store.listAttempts(started.workflowId)).find(
			attempt => attempt.stage === "plan_review",
		)?.id;
		const planUsage = artifacts.filter(artifact => artifact.kind === "usage" && artifact.attemptId === planAttemptId);
		const planRuntime = artifacts.filter(
			artifact => artifact.kind === "runtime-evidence" && artifact.attemptId === planAttemptId,
		);
		expect(planUsage).toHaveLength(2);
		expect(planRuntime).toHaveLength(2);
	});

	it("legacy NULL kind keeps bundled reviewer mapping and the existing graph", async () => {
		const engine = new WorkflowEngine({
			store,
			session: fakeSession(),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
		});
		const started = await engine.start({ request: "legacy graph" });
		const created = await engine.getState(started.workflowId);
		expect(created?.pipelineKind).toBeUndefined();
		const result = await engine.run(started.workflowId);
		expect(result.state.status).toBe("completed");
	});
});

describe("32-step cap + role closed set + agent map", () => {
	it("op=run / engine.run reports maxStepsReached after 32 non-terminal steps", async () => {
		class StickyCreatedStore extends WorkflowStore {
			override async transitionWorkflow(): Promise<void> {}
		}
		const store = new StickyCreatedStore(":memory:");
		const engine = new WorkflowEngine({ store, session: fakeSession() });
		const started = await engine.start({ request: "cap" }, {}, { pipelineKind: "devflow" });
		const result = await engine.run(started.workflowId);
		expect(result.stepsExecuted).toBe(32);
		expect(result.maxStepsReached).toBe(true);
		expect(result.state.status).toBe("created");
		expect(result.state.status).not.toBe("failed");
		store.close();
	});

	it("WorkflowRole closed set is unchanged and pipeline review maps to sol without a new role", () => {
		expect([...AVAILABILITY_ROLE_ORDER]).toEqual([
			"planner",
			"plan_reviewer",
			"plan_arbitrator",
			"implementer",
			"code_reviewer",
			"repair",
		]);
		expect(WORKFLOW_ROLE_TO_AGENT.plan_reviewer).toBe("reviewer");
		expect(resolvePipelineReviewAgent("plan_reviewer")).toBe("reviewer");
		expect(resolvePipelineReviewAgent("plan_reviewer", { pipelineKind: "devflow" })).toBe("subagent-sol");
		expect(
			resolvePipelineReviewAgent("code_reviewer", {
				pipelineKind: "devflow",
				authorModelFamily: "grok",
				preferredReviewer: "subagent-grok",
			}),
		).toBe("subagent-sol");
	});

	it("workflow tool treats op=run as write", () => {
		const tool = new WorkflowTool(fakeSession());
		expect((tool.approval as (a: unknown) => string)({ op: "run" })).toBe("write");
	});
});
