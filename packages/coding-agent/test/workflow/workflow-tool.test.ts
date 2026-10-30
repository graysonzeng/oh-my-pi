import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Effort } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../src/tools";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { compileQualityRouteSnapshot } from "../../src/workflow/quality-route-snapshot";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { ModelProfile, WorkflowQualityRoutes, WorkflowRole } from "../../src/workflow/types";
import { approvalTierForOp, WorkflowTool } from "../../src/workflow/workflow-tool";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

function statusProfile(id: string, role: WorkflowRole, vendor: string, modelPattern: string): ModelProfile {
	return {
		id,
		vendor,
		modelPattern,
		roles: [role],
		thinkingLevel: Effort.High,
		strictIdentity: true,
		promptTemplate: role,
		promptVersion: "status-test-1",
		toolPolicyId: "status-test",
		maxRequests: 1,
		maxRuntimeMs: 1_000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 1_000,
		},
	};
}

describe("WorkflowTool", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let artifactStore: ArtifactStore;
	let session: ToolSession;
	let tool: WorkflowTool;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-tool-"));
		artifactStore = new ArtifactStore(artifactDir);
		session = fakeSession({ getSessionId: () => "session-owner" });
		tool = new WorkflowTool(
			session,
			s =>
				new WorkflowEngine({
					store,
					session: s,
					adapter: new RuntimeAdapter(
						scriptedRunner({
							plan: planArtifact(),
							planReview: reviewArtifact("approved", "plan"),
							implement: implArtifact(),
							codeReview: reviewArtifact("approved", "implementation"),
						}),
					),
					verifier: passVerifier(),
					artifactStore,
				}),
		);
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("operation schema and approval tiers", () => {
		expect(approvalTierForOp("status")).toBe("read");
		expect(approvalTierForOp("start")).toBe("write");
		expect(approvalTierForOp("resume")).toBe("write");
		expect(approvalTierForOp("cancel")).toBe("write");
		expect(tool.parameters).toBeTruthy();
		expect(tool.name).toBe("workflow");
		expect(tool.loadMode).toBe("discoverable");
		// Tool.approval must be wired so resolveToolTier does not default to exec
		expect(typeof tool.approval).toBe("function");
		expect((tool.approval as (a: unknown) => string)({ op: "status" })).toBe("read");
		expect((tool.approval as (a: unknown) => string)({ op: "start" })).toBe("write");
		expect((tool.approval as (a: unknown) => string)({ op: "resume" })).toBe("write");
		expect((tool.approval as (a: unknown) => string)({ op: "cancel" })).toBe("write");
		expect((tool.approval as (a: unknown) => string)({ op: "run" })).toBe("write");
	});

	it("schema accepts only the supported quality tiers", () => {
		const valid = tool.parameters({ op: "start", request: "ship", qualityTier: "critical" });
		expect(valid instanceof type.errors).toBe(false);

		const invalid = tool.parameters({
			op: "start",
			request: "ship",
			qualityTier: "emergency",
		} as never);
		expect(invalid instanceof type.errors).toBe(true);
	});

	it("start creates workflow without bypassing gates (stays created)", async () => {
		const result = await tool.execute("t1", { op: "start", request: "build it" });
		const details = result.details!;
		expect(details.op).toBe("start");
		expect(details.workflowId).toBeTruthy();
		expect(details.status).toBe("created");
		expect(details.approvalTier).toBe("write");
	});

	it("persists the session owner for devflow discovery", async () => {
		const started = await tool.execute("t-owner", { op: "start", request: "build it", pipeline: "devflow" });
		const active = await store.findLatestActiveDevflow("session-owner");
		expect(active?.id).toBe(started.details?.workflowId);
		expect(active?.ownerSessionId).toBe("session-owner");
	});

	it("status is read-only", async () => {
		const started = await tool.execute("t1", { op: "start", request: "x" });
		const status = await tool.execute("t2", { op: "status", workflowId: started.details!.workflowId });
		expect(status.details!.approvalTier).toBe("read");
		expect(status.content[0]).toMatchObject({ type: "text" });
	});

	it("status displays persisted configured routes and execution identity receipt", async () => {
		const profiles = [
			statusProfile("status_planner", "planner", "openai", "openai/gpt-5.6-sol"),
			statusProfile("status_plan_reviewer", "plan_reviewer", "anthropic", "anthropic/claude-fable-5"),
			statusProfile("status_implementer", "implementer", "xai", "xai/grok-4.6"),
			statusProfile("status_code_reviewer", "code_reviewer", "openai", "openai/gpt-5.6-sol"),
			statusProfile("status_repair", "repair", "anthropic", "anthropic/claude-fable-5"),
		];
		const route: Readonly<Record<WorkflowRole, readonly string[]>> = {
			planner: ["status_planner"],
			plan_reviewer: ["status_plan_reviewer"],
			plan_arbitrator: [],
			implementer: ["status_implementer"],
			code_reviewer: ["status_code_reviewer"],
			repair: ["status_repair"],
		};
		const qualityRoutes: WorkflowQualityRoutes = { balanced: route };
		const routeSnapshot = compileQualityRouteSnapshot(
			{ profiles: Object.fromEntries(profiles.map(profile => [profile.id, profile])), qualityRoutes },
			"balanced",
		);
		const workflowId = await store.createWorkflow(
			{ request: "persisted status evidence", qualityTier: "balanced" },
			{ degradedMode: false, qualityRouteSnapshot: routeSnapshot },
		);
		const created = await store.getCurrentState(workflowId);
		await store.transitionWorkflow(workflowId, "created", "planning", "status fixture", undefined, created!.version);
		const planning = await store.getCurrentState(workflowId);
		const attemptId = await store.beginAttempt(workflowId, "planning", "status_planner", planning!.version);
		const runtimeEvidence = {
			kind: "runtime-evidence",
			schemaVersion: 1,
			workflowId,
			attemptId,
			profileId: "status_planner",
			configuredIdentity: routeSnapshot.profiles.find(entry => entry.profile.id === "status_planner")!
				.configuredIdentity,
			localResolution: {
				provider: "openai",
				model: "gpt-5.6-sol",
				checkpoint: null,
				provenance: "local_resolution",
			},
			attestedIdentity: {
				provider: "openai",
				model: "gpt-5.6-sol",
				checkpoint: "checkpoint-1",
				provenance: "provider_echo",
			},
			exactIdentityMatch: true,
			effortSupported: true,
			modelFamily: "openai",
		};
		const stored = await artifactStore.store({
			workflowId,
			attemptId,
			kind: "runtime-evidence",
			schemaVersion: 1,
			relativePath: "",
			content: JSON.stringify(runtimeEvidence),
		});
		await store.addArtifact(stored);

		const status = await tool.execute("t-status", { op: "status", workflowId });
		const content = status.content[0];
		if (content?.type !== "text") throw new Error("status must return text content");

		expect(status.details?.status).toBe("planning");
		expect(status.details?.statusReport).toMatchObject({ workflowId, qualityRoute: { status: "verified" } });
		expect(content.text).toContain("Configured routes: planner=[status_planner]");
		expect(content.text).toContain("Model attempt: stage=planning role=planner");
		expect(content.text).toContain("profile=status_planner configured=openai/gpt-5.6-sol:high");
		expect(content.text).toContain(
			"local=openai/gpt-5.6-sol attested=openai/gpt-5.6-sol@checkpoint-1 provenance=provider_echo exact=true effortSupported=true lineage=openai",
		);
	});

	it("resume refuses terminal workflows", async () => {
		const started = await tool.execute("t1", { op: "start", request: "x" });
		const id = started.details!.workflowId!;
		await tool.execute("t2", { op: "cancel", workflowId: id });
		await expect(tool.execute("t3", { op: "resume", workflowId: id })).rejects.toThrow(/terminal|cancel/i);
	});

	it("cancel persists cancelled", async () => {
		const started = await tool.execute("t1", { op: "start", request: "x" });
		const cancelled = await tool.execute("t2", { op: "cancel", workflowId: started.details!.workflowId });
		expect(cancelled.details!.status).toBe("cancelled");
	});

	it("createIf respects workflow.enabled", () => {
		const s = fakeSession({
			settings: {
				get: (key: string) => (key === "workflow.enabled" ? false : undefined),
				set: () => {},
			} as unknown as ToolSession["settings"],
		});
		expect(WorkflowTool.createIf(s)).toBeNull();
	});
});
