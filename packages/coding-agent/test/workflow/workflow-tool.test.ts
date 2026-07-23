import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "../../src/tools";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import { approvalTierForOp, WorkflowTool } from "../../src/workflow/workflow-tool";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

describe("WorkflowTool", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let session: ToolSession;
	let tool: WorkflowTool;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-tool-"));
		session = fakeSession();
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
					artifactStore: new ArtifactStore(artifactDir),
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
		// Tool.approval must be wired so resolveToolTier does not default to exec
		expect(typeof tool.approval).toBe("function");
		expect((tool.approval as (a: unknown) => string)({ op: "status" })).toBe("read");
		expect((tool.approval as (a: unknown) => string)({ op: "start" })).toBe("write");
		expect((tool.approval as (a: unknown) => string)({ op: "resume" })).toBe("write");
		expect((tool.approval as (a: unknown) => string)({ op: "cancel" })).toBe("write");
	});

	it("start creates workflow without bypassing gates (stays created)", async () => {
		const result = await tool.execute("t1", { op: "start", request: "build it" });
		const details = result.details!;
		expect(details.op).toBe("start");
		expect(details.workflowId).toBeTruthy();
		expect(details.status).toBe("created");
		expect(details.approvalTier).toBe("write");
	});

	it("status is read-only", async () => {
		const started = await tool.execute("t1", { op: "start", request: "x" });
		const status = await tool.execute("t2", { op: "status", workflowId: started.details!.workflowId });
		expect(status.details!.approvalTier).toBe("read");
		expect(status.content[0]).toMatchObject({ type: "text" });
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
