import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "../../src/tools";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowError, WorkflowPolicyError } from "../../src/workflow/errors";
import {
	RuntimeAdapter,
	type StructuredRunner,
	type StructuredRunnerRequest,
	type StructuredRunnerResult,
} from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type {
	CapturedChangesMergeRequest,
	CapturedChangesMerger,
	ImplementationArtifactV1,
	PlanArtifactV1,
	ReviewArtifactV1,
	VerifierPort,
	WorkPackageStateArtifactV1,
	WorkPackageV1,
} from "../../src/workflow/types";
import { executeWorkPackagePlan, type WorkPackageExecutionPlan } from "../../src/workflow/work-packages";

type ScriptValue<T> = T | (() => T);
type ImplementScript = (
	request: StructuredRunnerRequest,
	packageId: string | undefined,
) => ImplementationArtifactV1 | Promise<ImplementationArtifactV1>;

interface RunnerScript {
	plan: ScriptValue<PlanArtifactV1>;
	planReview: ScriptValue<ReviewArtifactV1>;
	implement: ImplementScript;
	codeReview: ScriptValue<ReviewArtifactV1>;
}

const PACKAGE_ASSIGNMENT = /^# Work package `([^`]+)`/;

function resolveScript<T>(value: ScriptValue<T>): T {
	return typeof value === "function" ? (value as () => T)() : value;
}

function packageIdFromAssignment(assignment: string): string | undefined {
	return PACKAGE_ASSIGNMENT.exec(assignment)?.[1];
}

function makePlan(workPackages?: WorkPackageV1[]): PlanArtifactV1 {
	const affectedFiles = [
		...new Set((workPackages?.flatMap(workPackage => workPackage.paths) ?? ["src/a.ts"]).map(file => file.trim())),
	].map(pathname => ({ path: pathname, action: "modify" as const, reason: "test" }));
	const implementationSteps = workPackages?.map(workPackage => ({
		id: `step-${workPackage.id}`,
		description: workPackage.assignment,
		dependsOn: workPackage.dependsOn.map(dependency => `step-${dependency}`),
	})) ?? [{ id: "step-a", description: "edit src/a.ts", dependsOn: [] }];
	const plan: PlanArtifactV1 = {
		schemaVersion: 1,
		workflowId: "wf",
		attemptId: "att",
		stage: "planning",
		createdAt: new Date().toISOString(),
		kind: "plan",
		summary: "Implement the test plan",
		assumptions: [],
		nonGoals: [],
		affectedFiles,
		implementationSteps,
		acceptanceCriteria: ["the workflow completes"],
		verificationCommands: [],
		risks: [],
		rollback: [],
	};
	if (workPackages) {
		plan.workPackages = workPackages.map(workPackage => ({
			...workPackage,
			paths: [...workPackage.paths],
			dependsOn: [...workPackage.dependsOn],
		}));
	}
	return plan;
}

function makeReview(subject: ReviewArtifactV1["subject"]): ReviewArtifactV1 {
	return {
		schemaVersion: 1,
		workflowId: "wf",
		attemptId: "att",
		stage: subject === "plan" ? "plan_review" : "code_review",
		createdAt: new Date().toISOString(),
		kind: "review",
		subject,
		decision: "approved",
		findings: [],
		explanation: "approved by scripted review",
		confidence: 0.99,
	};
}

function makeImplementation(
	patchPath: string,
	changedFiles: string[],
	summary = "implemented",
): ImplementationArtifactV1 {
	return {
		schemaVersion: 1,
		workflowId: "wf",
		attemptId: "att",
		stage: "implementing",
		createdAt: new Date().toISOString(),
		kind: "implementation",
		summary,
		changedFiles: [...changedFiles],
		addressedStepIds: changedFiles.map(file => `step-${file.replaceAll("/", "-")}`),
		commandsRun: [],
		patchPath,
		branchName: "wf/test",
		unresolved: [],
	};
}

function patchText(changedFiles: readonly string[]): string {
	return changedFiles
		.map(file =>
			[
				`diff --git a/${file} b/${file}`,
				`--- a/${file}`,
				`+++ b/${file}`,
				"@@ -1 +1 @@",
				"-before",
				"+after",
				"",
			].join("\n"),
		)
		.join("\n");
}

async function writePatchFile(cwd: string, patchPath: string, changedFiles: readonly string[]): Promise<void> {
	const fullPath = path.isAbsolute(patchPath) ? patchPath : path.join(cwd, patchPath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });
	await Bun.write(fullPath, patchText(changedFiles.length > 0 ? changedFiles : ["src/a.ts"]));
}

function scriptedRunner(script: RunnerScript): StructuredRunner {
	return async request => {
		const agent = request.agent ?? "";
		let label: string;
		let data: unknown;
		let patchPath: string | undefined;
		let branchName: string | undefined;
		if (agent === "designer" || agent === "planner") {
			label = "plan";
			data = resolveScript(script.plan);
		} else if (agent === "reviewer" || agent === "plan_reviewer" || agent === "code_reviewer") {
			if (
				/Independent code review/i.test(request.assignment) ||
				/code review|implementation/i.test(request.assignment)
			) {
				label = "code-review";
				data = resolveScript(script.codeReview);
			} else {
				label = "plan-review";
				data = resolveScript(script.planReview);
			}
		} else if (agent === "task" || agent === "implementer") {
			label = "implement";
			const packageId = packageIdFromAssignment(request.assignment);
			const artifact = await script.implement(request, packageId);
			data = artifact;
			patchPath = artifact.patchPath;
			branchName = artifact.branchName;
			if (patchPath) await writePatchFile(request.session.cwd, patchPath, artifact.changedFiles);
		} else {
			throw new Error(`unexpected scripted agent ${agent}`);
		}
		const result: StructuredRunnerResult["result"] = {
			id: `scripted-${label}`,
			structuredOutput: { status: "valid", data },
			patchPath,
			branchName,
			resolvedModel: "test/model",
		};
		return { result };
	};
}

function fakeSession(cwd: string, maxConcurrency = 1): ToolSession {
	const settings = {
		get: (key: string) => (key === "task.maxConcurrency" ? maxConcurrency : undefined),
		set: () => {},
	};
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: settings as unknown as ToolSession["settings"],
	};
}

function passVerifier(): VerifierPort {
	return {
		async verify(artifact) {
			return {
				kind: "verification",
				schemaVersion: 1,
				workflowId: artifact.workflowId,
				attemptId: artifact.attemptId,
				stage: artifact.stage,
				createdAt: new Date().toISOString(),
				passed: true,
				checks: [{ id: "pass", status: "passed", summary: "scripted verifier passed" }],
			};
		},
	};
}

function combinedMerger(calls: CapturedChangesMergeRequest[]): CapturedChangesMerger {
	return async request => {
		calls.push({ ...request, patches: request.patches.map(patch => ({ ...patch })) });
		const contents = await Promise.all(
			request.patches.map(async patch => {
				const fullPath = path.isAbsolute(patch.patchPath)
					? patch.patchPath
					: path.join(request.cwd, patch.patchPath);
				return Bun.file(fullPath).text();
			}),
		);
		await fs.mkdir(path.dirname(request.outputPatchPath), { recursive: true });
		await Bun.write(request.outputPatchPath, contents.join("\n"));
		return {
			patchPath: request.outputPatchPath,
			changesApplied: true,
			summary: `merged ${request.patches.map(patch => patch.packageId).join(",")}`,
		};
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(value => {
		resolve = value;
	});
	return { promise, resolve };
}

describe("WorkflowEngine work-package execution", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let cwd: string;
	let artifactStore: ArtifactStore;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-package-engine-arts-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-package-engine-cwd-"));
		artifactStore = new ArtifactStore(artifactDir);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await Bun.write(path.join(cwd, "src/a.ts"), "before-a\n");
		await Bun.write(path.join(cwd, "src/b.ts"), "before-b\n");
		await Bun.write(path.join(cwd, "src/c.ts"), "before-c\n");
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
		await fs.rm(cwd, { recursive: true, force: true });
	});

	function makeEngine(
		runner: StructuredRunner,
		merger: CapturedChangesMerger | undefined,
		maxConcurrency = 1,
	): WorkflowEngine {
		return new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(runner, merger),
			verifier: passVerifier(),
			artifactStore,
			session: fakeSession(cwd, maxConcurrency),
		});
	}

	async function latestPackageState(workflowId: string): Promise<WorkPackageStateArtifactV1> {
		const candidates = (await artifactStore.listByWorkflow(workflowId))
			.filter(artifact => artifact.kind === "work-package-state" && typeof artifact.content === "string")
			.map(artifact => JSON.parse(artifact.content!) as WorkPackageStateArtifactV1)
			.sort((left, right) => left.revision - right.revision);
		const latest = candidates.at(-1);
		if (!latest) throw new Error("missing persisted work-package state");
		return latest;
	}

	async function persistPackageState(workflowId: string, attemptId: string, state: WorkPackageStateArtifactV1) {
		const stored = await artifactStore.store({
			workflowId,
			attemptId,
			kind: "work-package-state",
			schemaVersion: 1,
			relativePath: "",
			content: JSON.stringify(state),
		});
		await store.addArtifact(stored);
	}

	it("runs a package-less plan through exactly one whole-plan implementer call without merging", async () => {
		const wholePlanRequests: StructuredRunnerRequest[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const runner = scriptedRunner({
			plan: makePlan(),
			planReview: makeReview("plan"),
			implement: async (request, packageId) => {
				expect(packageId).toBeUndefined();
				wholePlanRequests.push(request);
				return makeImplementation("patches/whole-plan.patch", ["src/a.ts"], "whole-plan");
			},
			codeReview: makeReview("implementation"),
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls));
		const workflowId = await engine.startWorkflow({ request: "run package-less plan" });

		const result = await engine.run(workflowId, fakeSession(cwd));

		expect(result.state.status).toBe("completed");
		expect(wholePlanRequests).toHaveLength(1);
		expect(wholePlanRequests[0]?.isolation).toMatchObject({
			requested: true,
			merge: "patch",
			apply: true,
		});
		expect(mergeCalls).toHaveLength(0);
		expect(result.workPackageState).toBeUndefined();
	});

	it("runs independent packages concurrently, captures patches, and applies one deterministic merge", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Implement A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "b", assignment: "Implement B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const firstStarted = deferred<void>();
		const secondStarted = deferred<void>();
		const releaseFirst = deferred<void>();
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		let active = 0;
		let peakActive = 0;
		const isolationByPackage = new Map<string, StructuredRunnerRequest["isolation"]>();
		const runner = scriptedRunner({
			plan: makePlan(packages),
			planReview: makeReview("plan"),
			implement: async (request, packageId) => {
				if (!packageId) return makeImplementation("patches/whole-plan.patch", ["src/a.ts"]);
				isolationByPackage.set(packageId, request.isolation);
				active += 1;
				peakActive = Math.max(peakActive, active);
				if (packageId === "a") {
					firstStarted.resolve();
					await releaseFirst.promise;
				} else {
					secondStarted.resolve();
				}
				active -= 1;
				return makeImplementation(`patches/${packageId}.patch`, [`src/${packageId}.ts`], packageId);
			},
			codeReview: makeReview("implementation"),
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls), 2);
		const workflowId = await engine.startWorkflow({ request: "run independent packages" });
		const run = engine.run(workflowId, fakeSession(cwd, 2));

		await firstStarted.promise;
		await secondStarted.promise;
		expect(peakActive).toBe(2);
		releaseFirst.resolve();
		const result = await run;

		expect(result.state.status).toBe("completed");
		expect(result.implementation?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
		expect(result.implementation?.patchPath).toBeDefined();
		const aggregatePatch = await Bun.file(result.implementation!.patchPath!).text();
		expect(aggregatePatch).toContain("src/a.ts");
		expect(aggregatePatch).toContain("src/b.ts");
		expect(mergeCalls).toHaveLength(1);
		expect(mergeCalls[0]?.patches.map(patch => patch.packageId)).toEqual(["a", "b"]);
		expect(isolationByPackage.get("a")).toMatchObject({
			requested: true,
			merge: "patch",
			apply: false,
		});
		expect(isolationByPackage.get("b")).toMatchObject({
			requested: true,
			merge: "patch",
			apply: false,
		});
		expect(result.workPackageState?.kind).toBe("work-package-state");
		expect(result.workPackageState?.revision).toBeGreaterThan(0);
		expect(result.workPackageState?.merge).toMatchObject({
			status: "applied",
			changesApplied: true,
			order: ["a", "b"],
		});
		expect(result.workPackageState?.packages.map(workPackage => [workPackage.id, workPackage.status])).toEqual([
			["a", "succeeded"],
			["b", "succeeded"],
		]);
	});

	it("waits for every dependency wave and keeps merge order deterministic", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "b", assignment: "Implement B after A", paths: ["src/b.ts"], dependsOn: ["a"] },
			{ id: "c", assignment: "Implement C", paths: ["src/c.ts"], dependsOn: [] },
			{ id: "a", assignment: "Implement A", paths: ["src/a.ts"], dependsOn: [] },
		];
		const events: string[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const runner = scriptedRunner({
			plan: makePlan(packages),
			planReview: makeReview("plan"),
			implement: async (_request, packageId) => {
				if (!packageId) return makeImplementation("patches/whole-plan.patch", ["src/a.ts"]);
				events.push(`${packageId}:start`);
				events.push(`${packageId}:done`);
				return makeImplementation(`patches/${packageId}.patch`, [`src/${packageId}.ts`], packageId);
			},
			codeReview: makeReview("implementation"),
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls), 2);
		const workflowId = await engine.startWorkflow({ request: "run dependency waves" });

		const result = await engine.run(workflowId, fakeSession(cwd, 2));

		expect(result.state.status).toBe("completed");
		expect(events.indexOf("b:start")).toBeGreaterThan(events.indexOf("a:done"));
		expect(mergeCalls).toHaveLength(1);
		expect(mergeCalls[0]?.patches.map(patch => patch.packageId)).toEqual(["a", "c", "b"]);
		expect(result.workPackageState?.merge.order).toEqual(["a", "c", "b"]);
	});

	it("falls back to one serial whole-plan call for overlap, cycles, and an effectively serial limit", async () => {
		const cases: Array<{ label: string; packages: WorkPackageV1[]; maxConcurrency: number }> = [
			{
				label: "shared path",
				maxConcurrency: 2,
				packages: [
					{ id: "a", assignment: "Own shared directory", paths: ["src/shared"], dependsOn: [] },
					{ id: "b", assignment: "Own nested file", paths: ["src/shared/b.ts"], dependsOn: [] },
				],
			},
			{
				label: "dependency cycle",
				maxConcurrency: 2,
				packages: [
					{ id: "a", assignment: "Cycle A", paths: ["src/a.ts"], dependsOn: ["b"] },
					{ id: "b", assignment: "Cycle B", paths: ["src/b.ts"], dependsOn: ["a"] },
				],
			},
			{
				label: "maxConcurrency one",
				maxConcurrency: 1,
				packages: [
					{ id: "a", assignment: "Serial A", paths: ["src/a.ts"], dependsOn: [] },
					{ id: "b", assignment: "Serial B", paths: ["src/b.ts"], dependsOn: [] },
				],
			},
		];

		for (const testCase of cases) {
			const wholePlanRequests: StructuredRunnerRequest[] = [];
			const packageRequests: StructuredRunnerRequest[] = [];
			const mergeCalls: CapturedChangesMergeRequest[] = [];
			const runner = scriptedRunner({
				plan: makePlan(testCase.packages),
				planReview: makeReview("plan"),
				implement: async (request, packageId) => {
					if (packageId) packageRequests.push(request);
					else wholePlanRequests.push(request);
					return makeImplementation("patches/whole-plan-fallback.patch", ["src/a.ts", "src/b.ts"], testCase.label);
				},
				codeReview: makeReview("implementation"),
			});
			const engine = makeEngine(runner, combinedMerger(mergeCalls), testCase.maxConcurrency);
			const workflowId = await engine.startWorkflow({ request: testCase.label });

			const result = await engine.run(workflowId, fakeSession(cwd, testCase.maxConcurrency));

			expect(result.state.status).toBe("completed");
			expect(wholePlanRequests).toHaveLength(1);
			expect(packageRequests).toHaveLength(0);
			expect(wholePlanRequests[0]?.isolation).toMatchObject({
				requested: true,
				merge: "patch",
				apply: true,
			});
			expect(mergeCalls).toHaveLength(0);
		}
	});

	it("does not merge a partial capture and classifies package failures into failed or blocked workflows", async () => {
		const failureKinds = ["provider_permanent", "merge_conflict"] as const;
		for (const failureKind of failureKinds) {
			const packages: WorkPackageV1[] = [
				{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
				{ id: "b", assignment: "Fail B", paths: ["src/b.ts"], dependsOn: [] },
			];
			const mergeCalls: CapturedChangesMergeRequest[] = [];
			const runner = scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async (_request, packageId) => {
					if (packageId === "b") {
						throw new WorkflowError(`package ${packageId} failed`, failureKind);
					}
					return makeImplementation(`patches/${packageId ?? "whole-plan"}.patch`, [`src/${packageId ?? "a"}.ts`]);
				},
				codeReview: makeReview("implementation"),
			});
			const engine = makeEngine(runner, combinedMerger(mergeCalls), 2);
			const workflowId = await engine.startWorkflow({ request: `failure ${failureKind}` });
			let runResult: Awaited<ReturnType<WorkflowEngine["run"]>> | undefined;
			let runError: unknown;
			try {
				runResult = await engine.run(workflowId, fakeSession(cwd, 2));
			} catch (error) {
				runError = error;
			}

			const state = await engine.getState(workflowId);
			const packageState = await latestPackageState(workflowId);
			const failedPackage = packageState.packages.find(workPackage => workPackage.id === "b");
			const attempts = await store.listAttempts(workflowId);
			const transitions = await store.listTransitions(workflowId);
			const implementingAttempt = attempts.find(attempt => attempt.stage === "implementing");
			const expectedStatus = failureKind === "merge_conflict" ? "blocked" : "failed";

			expect(state?.status).toBe(expectedStatus);
			expect(runResult?.state.status ?? state?.status).toBe(expectedStatus);
			if (failureKind === "provider_permanent") {
				expect(runError).toBeInstanceOf(WorkflowError);
				expect((runError as WorkflowError).kind).toBe(failureKind);
			} else {
				expect(runError).toBeUndefined();
			}
			expect(mergeCalls).toHaveLength(0);
			expect(packageState.kind).toBe("work-package-state");
			expect(packageState.revision).toBeGreaterThan(0);
			expect(failedPackage?.status).toBe("failed");
			expect(failedPackage?.errorKind).toBe(failureKind);
			expect(failedPackage?.errorSummary).toContain("package b failed");
			expect(implementingAttempt?.status).toBe("failed");
			expect(implementingAttempt?.errorSummary).toContain("package b failed");
			expect(transitions.at(-1)?.reason).toContain("package b failed");
			expect(await Bun.file(path.join(cwd, "src/a.ts")).text()).toBe("before-a\n");
			expect(await Bun.file(path.join(cwd, "src/b.ts")).text()).toBe("before-b\n");
		}
	});

	it("resumes a stale capture attempt without rerunning a succeeded package, then merges and transitions", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "b", assignment: "Capture B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const captureEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async () => makeImplementation("patches/unexpected.patch", ["src/a.ts"]),
				codeReview: makeReview("implementation"),
			}),
			undefined,
			2,
		);
		const workflowId = await captureEngine.startWorkflow({ request: "resume package capture" });
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		expect((await captureEngine.getState(workflowId))?.status).toBe("implementing");
		const implementingState = await captureEngine.getState(workflowId);
		const staleAttemptId = await store.beginAttempt(
			workflowId,
			"implementing",
			undefined,
			implementingState!.version,
		);

		const capturePlan: WorkPackageExecutionPlan = {
			packages: [packages[0]!],
			waves: [[packages[0]!]],
			mergeOrder: ["a"],
			maxConcurrency: 2,
		};
		const captured = await executeWorkPackagePlan({
			workflowId,
			attemptId: staleAttemptId,
			cwd,
			plan: capturePlan,
			execute: async workPackage => {
				const patchPath = "patches/captured-a.patch";
				await writePatchFile(cwd, patchPath, workPackage.paths);
				return { artifact: makeImplementation(patchPath, workPackage.paths, "captured A") };
			},
			persist: state => persistPackageState(workflowId, staleAttemptId, state),
		});
		const captureState: WorkPackageStateArtifactV1 = {
			...captured,
			attemptId: staleAttemptId,
			revision: captured.revision + 1,
			createdAt: new Date().toISOString(),
			packages: [...captured.packages, { ...packages[1]!, status: "pending" }],
			merge: { status: "pending", order: ["a", "b"] },
		};
		await persistPackageState(workflowId, staleAttemptId, captureState);
		expect(captureState.packages.find(workPackage => workPackage.id === "a")?.status).toBe("succeeded");
		expect((await store.listAttempts(workflowId)).find(attempt => attempt.id === staleAttemptId)?.status).toBe(
			"in_progress",
		);

		const resumedPackageCalls: string[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const resumeEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async (_request, packageId) => {
					if (!packageId) return makeImplementation("patches/whole-plan.patch", ["src/a.ts"]);
					resumedPackageCalls.push(packageId);
					return makeImplementation(
						`patches/resumed-${packageId}.patch`,
						[`src/${packageId}.ts`],
						`resumed ${packageId}`,
					);
				},
				codeReview: makeReview("implementation"),
			}),
			combinedMerger(mergeCalls),
			2,
		);

		const result = await resumeEngine.resume(workflowId, { forceUnlock: true });
		const attempts = await store.listAttempts(workflowId);
		const stale = attempts.find(attempt => attempt.id === staleAttemptId);

		expect(result.state.status).toBe("completed");
		expect(resumedPackageCalls).toEqual(["b"]);
		expect(stale?.status).toBe("failed");
		expect(stale?.errorSummary).toBe("work_package_capture_interrupted_resumable");
		expect(mergeCalls).toHaveLength(1);
		expect(mergeCalls[0]?.patches.map(patch => patch.packageId)).toEqual(["a", "b"]);
		expect(result.workPackageState?.kind).toBe("work-package-state");
		expect(result.workPackageState?.revision).toBeGreaterThan(captureState.revision);
		expect(result.workPackageState?.merge).toMatchObject({
			status: "applied",
			changesApplied: true,
			order: ["a", "b"],
		});
		expect(result.workPackageState?.packages.every(workPackage => workPackage.status === "succeeded")).toBe(true);
	});

	it("keeps the existing blocked semantics for a stale serial write-stage attempt", async () => {
		let implementCalls = 0;
		const runner = scriptedRunner({
			plan: makePlan(),
			planReview: makeReview("plan"),
			implement: async () => {
				implementCalls += 1;
				return makeImplementation("patches/should-not-run.patch", ["src/a.ts"]);
			},
			codeReview: makeReview("implementation"),
		});
		const engine = makeEngine(runner, async () => {
			throw new Error("merge seam must not run");
		});
		const workflowId = await engine.startWorkflow({ request: "stale serial write" });
		await engine.resume(workflowId, { singleStep: true });
		await engine.resume(workflowId, { singleStep: true });
		await engine.resume(workflowId, { singleStep: true });
		const beforeStale = await engine.getState(workflowId);
		const staleAttemptId = await store.beginAttempt(workflowId, "implementing", undefined, beforeStale!.version);

		let error: unknown;
		try {
			await engine.resume(workflowId, { forceUnlock: true });
		} catch (caught) {
			error = caught;
		}
		const after = await engine.getState(workflowId);
		const stale = (await store.listAttempts(workflowId)).find(attempt => attempt.id === staleAttemptId);

		expect(error).toBeInstanceOf(WorkflowPolicyError);
		expect((error as WorkflowPolicyError).message).toContain("write_stage_interrupted_no_rerun");
		expect(after?.status).toBe("blocked");
		expect(stale?.status).toBe("failed");
		expect(stale?.errorSummary).toBe("write_stage_interrupted_no_rerun");
		expect(implementCalls).toBe(0);
	});
});
