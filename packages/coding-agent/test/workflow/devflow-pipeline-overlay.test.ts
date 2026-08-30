import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runDeliveryPipeline } from "../../src/modes/delivery";
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
	parsePipelineCompletenessResult,
	sidecarWithGrillPause,
} from "../../src/workflow/overlay";
import { buildRequirementsSnapshot } from "../../src/workflow/requirements-snapshot";
import { RuntimeAdapter, resolvePipelineReviewAgent, WORKFLOW_ROLE_TO_AGENT } from "../../src/workflow/runtime-adapter";
import { GateParseError, parseGateResultArtifact } from "../../src/workflow/schemas";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
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

	it("preflight answers are copied onto op=run and no workflow is created before complete", async () => {
		const calls: unknown[] = [];
		let complete = false;
		const runtime = {
			session: { getToolByName: () => undefined, sessionManager: { getEntries: () => [] } },
			output: async () => {},
		} as unknown as SlashCommandRuntime;
		const deps = {
			auditor: async () =>
				complete
					? { complete: true, missing: [] as string[] }
					: { complete: false, missing: ["acceptance"], next: "What is the acceptance test?" },
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
		expect(calls).toEqual([
			{ op: "run", request: "bun test is the bar", pipeline: "devflow", grillAnswers: ["bun test is the bar"] },
		]);
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
				output: async text => {
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
				appendAnswers: async (_id, next) => {
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

	it("coordinator appends answers and replans before resume when redesign grilling is open", async () => {
		const ops: string[] = [];
		const answers: string[][] = [];
		const replans: string[] = [];
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
				appendAnswers: async (_id, next) => {
					answers.push([...next]);
				},
				replanFromRedesign: async id => {
					replans.push(id);
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
		expect(answers).toEqual([["keep the public API"]]);
		expect(replans).toEqual(["wf_grill"]);
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
				if ((request.agent ?? "") === "subagent-sol") {
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
