import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Effort } from "@oh-my-pi/pi-ai";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter, type StructuredRunner } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { ModelProfile, WorkflowRole } from "../../src/workflow/types";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

function strictProfile(id: string, role: WorkflowRole, base: ModelProfile, modelPattern: string): ModelProfile {
	return {
		...base,
		id,
		modelPattern,
		roles: [role],
		strictIdentity: true,
		promptTemplate: role,
		promptVersion: "repair-no-op-test",
		toolPolicyId: "repair-no-op-test",
		maxRequests: 40,
		maxRuntimeMs: 30_000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 50_000,
		},
	};
}

function strictRepairProfiles(): Record<string, ModelProfile> {
	const profiles = [
		strictProfile("planner", "planner", DEFAULT_MODEL_PROFILES.claude_planner, "anthropic/claude-opus-5"),
		strictProfile(
			"plan_reviewer",
			"plan_reviewer",
			DEFAULT_MODEL_PROFILES.claude_plan_reviewer,
			"anthropic/claude-opus-5",
		),
		strictProfile("implementer", "implementer", DEFAULT_MODEL_PROFILES.grok_implementer, "xai/grok-4.6"),
		strictProfile(
			"code_reviewer",
			"code_reviewer",
			DEFAULT_MODEL_PROFILES.claude_reviewer,
			"anthropic/claude-opus-5",
		),
		strictProfile("repair", "repair", DEFAULT_MODEL_PROFILES.claude_repair, "anthropic/claude-opus-5"),
	];
	return Object.fromEntries(profiles.map(profile => [profile.id, profile]));
}

function strictRepairRunner(
	cwd: string,
	noChangesRequired: boolean,
	reviewerCalls: string[] = [],
	repairAssignments: string[] = [],
): StructuredRunner {
	const repairPath = path.join(cwd, "patches/repair.patch");
	const runner = scriptedRunner({
		plan: planArtifact(),
		planReview: reviewArtifact("approved", "plan"),
		implement: implArtifact({ unresolved: ["completion evidence"] }),
		codeReview: reviewArtifact("approved", "implementation"),
		repair: implArtifact({
			stage: "repairing",
			patchPath: noChangesRequired ? undefined : repairPath,
			branchName: undefined,
			noChangesRequired: noChangesRequired ? true : undefined,
			unresolved: [],
		}),
	});
	return async request => {
		if (/^Repair findings/i.test(request.assignment)) repairAssignments.push(request.assignment);
		if (/^Repair findings/i.test(request.assignment) && !noChangesRequired) {
			await fs.mkdir(path.dirname(repairPath), { recursive: true });
		}
		const result = await runner({
			...request,
			onResponse: (_response, model) => {
				const selector = Array.isArray(request.model) ? request.model[0] : request.model;
				if (typeof selector !== "string" || !selector.includes("/")) {
					throw new Error("strict repair fixture requires provider/model selector");
				}
				const separator = selector.indexOf("/");
				const provider = selector.slice(0, separator);
				const modelId = selector.slice(separator + 1);
				const requestedEffort = request.thinkingLevel;
				const attestedModel =
					model && requestedEffort && requestedEffort !== "auto"
						? { ...model, thinking: { mode: "effort" as const, efforts: [requestedEffort as Effort] } }
						: model;
				if (/Independent code review/i.test(request.assignment)) reviewerCalls.push(selector);
				request.onResponse?.(
					{
						status: 200,
						headers: {
							"x-provider-model": `${provider}/${modelId}`,
							"x-omp-resolved-provider": provider,
						},
					},
					attestedModel,
				);
			},
		});
		if (/^Repair findings/i.test(request.assignment) && !noChangesRequired) {
			await Bun.write(repairPath, "");
		}
		return result;
	};
}

describe("WorkflowEngine repair loop", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-repair-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("enters repair on code-review findings then can complete", async () => {
		let reviews = 0;
		const finding = {
			id: "f1",
			priority: "P1" as const,
			category: "correctness" as const,
			status: "open" as const,
			confidence: 0.95,
			summary: "bug",
			explanation: "fix it",
			suggestedOwner: "implementer" as const,
		};
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: () => {
						reviews += 1;
						if (reviews === 1) {
							return reviewArtifact("changes_requested", "implementation", [finding]);
						}
						return reviewArtifact("approved", "implementation", []);
					},
					repair: implArtifact({ addressedStepIds: ["f1"], summary: "repaired" }),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "repair path" });
		const result = await engine.run(workflowId);
		expect(result.state.status).toBe("completed");
		expect(reviews).toBeGreaterThanOrEqual(1);
	});

	it("verification failure enters repair", async () => {
		let verifyCalls = 0;
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
					repair: implArtifact({ summary: "fixed verify" }),
				}),
			),
			verifier: {
				async verify(a) {
					verifyCalls += 1;
					// first impl verify fails, later ones pass
					const passed = verifyCalls !== 1;
					return {
						kind: "verification",
						passed,
						checks: [{ id: "c", status: passed ? "passed" : "failed", summary: passed ? "ok" : "fail" }],
						schemaVersion: 1,
						workflowId: a.workflowId,
						attemptId: a.attemptId,
						stage: a.stage,
						createdAt: new Date().toISOString(),
					};
				},
			},
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});

		const workflowId = await engine.startWorkflow({ request: "verify fail" });
		// Drive to implementation_verify failure
		for (let i = 0; i < 6; i++) {
			const s = await engine.getState(workflowId);
			if (s && ["repairing", "completed", "blocked", "failed"].includes(s.status)) break;
			await engine.resume(workflowId, { singleStep: true });
		}
		const state = await engine.getState(workflowId);
		expect(state?.status).toBe("repairing");
	});
	it("completes a strict final-verify no-op while preserving the validated patch", async () => {
		const mergeCalls: string[] = [];
		const reviewerCalls: string[] = [];
		const repairAssignments: string[] = [];
		const session = fakeSession({ cwd: artifactDir });
		const adapter = new RuntimeAdapter(
			strictRepairRunner(artifactDir, true, reviewerCalls, repairAssignments),
			async request => {
				mergeCalls.push(request.attemptId);
				const content = await Promise.all(
					request.patches.map(async patch => {
						const source = path.isAbsolute(patch.patchPath)
							? patch.patchPath
							: path.join(request.cwd, patch.patchPath);
						return Bun.file(source).text();
					}),
				);
				await fs.mkdir(path.dirname(request.outputPatchPath), { recursive: true });
				await Bun.write(request.outputPatchPath, content.join(""));
				return { patchPath: request.outputPatchPath, changesApplied: true, summary: "captured" };
			},
		);
		const engine = new WorkflowEngine({
			store,
			config: { profiles: strictRepairProfiles() },
			adapter,
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session,
		});

		const workflowId = await engine.startWorkflow({ request: "strict repair no-op" });
		const result = await engine.run(workflowId, session);

		expect(result.state.status).toBe("completed");
		expect(repairAssignments).toHaveLength(1);
		expect(repairAssignments[0]).toContain("noChangesRequired=true");
		expect(repairAssignments[0]).toContain("unresolved_items_open");
		expect(result.implementation?.noChangesRequired).toBe(true);
		expect(result.implementation?.patchPath).toContain("validated.patch");
		expect(result.implementation?.modelProfileId).toBe("implementer");
		expect(result.implementation?.provider).toBe("xai");
		expect(reviewerCalls).toHaveLength(2);
		expect(reviewerCalls.every(model => model === "anthropic/claude-opus-5")).toBe(true);
		expect(mergeCalls).toHaveLength(1);
	});

	it("fails closed when an empty strict repair patch omits the no-op declaration", async () => {
		const mergeCalls: string[] = [];
		const session = fakeSession({ cwd: artifactDir });
		const adapter = new RuntimeAdapter(strictRepairRunner(artifactDir, false), async request => {
			mergeCalls.push(request.attemptId);
			const content = await Promise.all(
				request.patches.map(async patch => {
					const source = path.isAbsolute(patch.patchPath)
						? patch.patchPath
						: path.join(request.cwd, patch.patchPath);
					return Bun.file(source).text();
				}),
			);
			await fs.mkdir(path.dirname(request.outputPatchPath), { recursive: true });
			await Bun.write(request.outputPatchPath, content.join(""));
			return { patchPath: request.outputPatchPath, changesApplied: true, summary: "captured" };
		});
		const engine = new WorkflowEngine({
			store,
			config: { profiles: strictRepairProfiles() },
			adapter,
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session,
		});

		const workflowId = await engine.startWorkflow({ request: "strict empty patch" });
		let thrownMessage: string | undefined;
		try {
			await engine.run(workflowId, session);
		} catch (error) {
			thrownMessage = error instanceof Error ? error.message : String(error);
		}
		if (thrownMessage !== undefined) {
			expect(thrownMessage).toContain("strict_write_patch_empty");
		} else {
			expect((await engine.getState(workflowId))?.status).toBe("blocked");
			const transitions = await store.listTransitions(workflowId);
			expect(transitions.at(-1)?.reason).toContain("strict_write_patch_empty");
		}
		expect(mergeCalls).toHaveLength(1);
	});
});
