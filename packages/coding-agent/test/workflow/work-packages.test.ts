import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { WorkflowError } from "../../src/workflow/errors";
import type { ImplementStageResult } from "../../src/workflow/stages/implement";
import type {
	ImplementationArtifactV1,
	WorkPackageExecutionV1,
	WorkPackageStateArtifactV1,
	WorkPackageV1,
} from "../../src/workflow/types";
import {
	aggregateWorkPackageImplementations,
	buildWorkPackageExecutionPlan,
	executeWorkPackagePlan,
	WorkPackageExecutionError,
	withWorkPackageMerge,
} from "../../src/workflow/work-packages";

const WORKFLOW_ID = "wf-work-packages";

function workPackage(id: string, ownedPath: string, dependsOn: string[] = []): WorkPackageV1 {
	return {
		id,
		assignment: `Implement ${id}`,
		paths: [ownedPath],
		dependsOn,
	};
}

function requiredPlan(packages: WorkPackageV1[], maxConcurrency = 2) {
	const plan = buildWorkPackageExecutionPlan(packages, maxConcurrency);
	if (!plan) throw new Error("test fixture must produce a parallel work-package plan");
	return plan;
}

function implementationArtifact(
	id: string,
	patchPath: string,
	overrides: Partial<ImplementationArtifactV1> = {},
): ImplementationArtifactV1 {
	return {
		schemaVersion: 1,
		workflowId: WORKFLOW_ID,
		attemptId: "attempt-1",
		stage: "implementing",
		createdAt: new Date(0).toISOString(),
		kind: "implementation",
		summary: `Implemented ${id}`,
		changedFiles: [`src/${id}.ts`],
		addressedStepIds: [id],
		commandsRun: [],
		patchPath,
		unresolved: [],
		...overrides,
	};
}

function implementationResult(
	id: string,
	patchPath: string,
	overrides: Partial<ImplementationArtifactV1> = {},
): ImplementStageResult {
	return { artifact: implementationArtifact(id, patchPath, overrides) };
}

async function writePatch(cwd: string, patchPath: string, changedPath: string): Promise<void> {
	const fullPath = path.join(cwd, patchPath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });
	await Bun.write(
		fullPath,
		[
			`diff --git a/${changedPath} b/${changedPath}`,
			`--- a/${changedPath}`,
			`+++ b/${changedPath}`,
			"@@ -0,0 +1 @@",
			`+const ${changedPath.replaceAll(/[^a-zA-Z0-9]/g, "_")} = 1;`,
			"",
		].join("\n"),
	);
}

function stateArtifact(
	packages: WorkPackageExecutionV1[],
	mergeOrder: string[],
	revision = 0,
	attemptId = "prior-attempt",
): WorkPackageStateArtifactV1 {
	return {
		kind: "work-package-state",
		schemaVersion: 1,
		workflowId: WORKFLOW_ID,
		attemptId,
		stage: "implementing",
		createdAt: new Date(0).toISOString(),
		revision,
		mode: "capture_then_apply",
		packages,
		merge: { status: "pending", order: mergeOrder },
	};
}

async function waitFor<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("work-package planning", () => {
	it("falls back to serial execution for missing, degenerate, or unsafe package sets", () => {
		const first = workPackage("first", "src/first");
		const second = workPackage("second", "src/second.ts");

		expect(buildWorkPackageExecutionPlan(undefined, 2)).toBeNull();
		expect(buildWorkPackageExecutionPlan([first], 2)).toBeNull();
		expect(buildWorkPackageExecutionPlan([first, second], 1)).toBeNull();
		expect(buildWorkPackageExecutionPlan([first, { ...second, id: "first" }], 2)).toBeNull();
		expect(buildWorkPackageExecutionPlan([first, { ...second, dependsOn: ["missing"] }], 2)).toBeNull();
		expect(
			buildWorkPackageExecutionPlan(
				[
					workPackage("cycle-a", "src/cycle-a.ts", ["cycle-b"]),
					workPackage("cycle-b", "src/cycle-b.ts", ["cycle-a"]),
				],
				2,
			),
		).toBeNull();
		expect(buildWorkPackageExecutionPlan([first, workPackage("shared", "src/first")], 2)).toBeNull();
		expect(buildWorkPackageExecutionPlan([first, workPackage("nested", "src/first/child.ts")], 2)).toBeNull();
	});

	it("falls back to whole-plan serial execution when one package consumes a predecessor API", () => {
		const plan = buildWorkPackageExecutionPlan(
			[
				workPackage("create-api", "src/api.ts"),
				workPackage("consume-api", "src/consumer.ts", ["create-api"]),
				workPackage("independent", "src/independent.ts"),
			],
			2,
		);

		// A dependent package cannot run from the original isolation baseline; null preserves
		// the existing whole-plan implementation path until predecessor patches seed that baseline.
		expect(plan).toBeNull();
	});
});

describe("work-package execution", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-work-packages-"));
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("runs one wave concurrently while the semaphore keeps the observed peak at two and persists succeeded revisions", async () => {
		const packages = [
			workPackage("alpha", "src/alpha.ts"),
			workPackage("beta", "src/beta.ts"),
			workPackage("gamma", "src/gamma.ts"),
		];
		const plan = requiredPlan(packages, 2);
		for (const candidate of packages) await writePatch(cwd, `patches/${candidate.id}.patch`, candidate.paths[0]!);

		const waveRelease = Promise.withResolvers<void>();
		const firstTwoStarted = Promise.withResolvers<void>();
		const started: string[] = [];
		const snapshots: WorkPackageStateArtifactV1[] = [];
		let active = 0;
		let peak = 0;

		const run = executeWorkPackagePlan({
			workflowId: WORKFLOW_ID,
			attemptId: "parallel-attempt",
			cwd,
			plan,
			execute: async candidate => {
				active += 1;
				peak = Math.max(peak, active);
				started.push(candidate.id);
				if (started.length === 2) firstTwoStarted.resolve();
				await waveRelease.promise;
				active -= 1;
				return implementationResult(candidate.id, `patches/${candidate.id}.patch`);
			},
			persist: async state => {
				snapshots.push(state);
			},
		});

		try {
			await waitFor(firstTwoStarted.promise, "two same-wave implementations");
			expect(new Set(started).size).toBe(2);
			expect(active).toBe(2);
		} finally {
			waveRelease.resolve();
		}

		const final = await run;
		const revisions = snapshots.map(snapshot => snapshot.revision);
		expect(revisions.length).toBeGreaterThan(1);
		expect(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!)).toBe(true);
		expect(final.revision).toBe(revisions.at(-1)!);
		expect(peak).toBeLessThanOrEqual(2);
		expect(final.kind).toBe("work-package-state");
		expect(final.packages.every(candidate => candidate.status === "succeeded")).toBe(true);
		expect(final.merge.status).toBe("pending");
	});

	it("records runtime failures with package id and kind without applying a merge", async () => {
		const packages = [workPackage("bad", "src/bad.ts"), workPackage("good", "src/good.ts")];
		const plan = requiredPlan(packages, 2);
		await writePatch(cwd, "patches/good.patch", "src/good.ts");
		const snapshots: WorkPackageStateArtifactV1[] = [];
		const successes: string[] = [];
		let thrown: unknown;

		try {
			await executeWorkPackagePlan({
				workflowId: WORKFLOW_ID,
				attemptId: "failure-attempt",
				cwd,
				plan,
				execute: async candidate => {
					if (candidate.id === "bad") throw new WorkflowError("provider stopped", "provider_transient");
					return implementationResult(candidate.id, "patches/good.patch");
				},
				persist: async state => {
					snapshots.push(state);
				},
				onSuccess: async candidate => {
					successes.push(candidate.id);
				},
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(WorkPackageExecutionError);
		const executionError = thrown as WorkPackageExecutionError;
		expect(executionError.kind).toBe("provider_transient");
		expect(executionError.failures).toEqual(
			expect.arrayContaining([expect.objectContaining({ packageId: "bad", requestLaunched: true })]),
		);
		expect(executionError.details).toEqual(
			expect.objectContaining({
				failures: expect.arrayContaining([
					expect.objectContaining({ packageId: "bad", kind: "provider_transient" }),
				]),
			}),
		);
		expect(successes).not.toContain("bad");
		const final = snapshots.at(-1)!;
		expect(final.packages.find(candidate => candidate.id === "bad")).toMatchObject({
			status: "failed",
			errorKind: "provider_transient",
		});
		expect(final.merge).toMatchObject({ status: "pending", order: plan.mergeOrder });
		expect(final.merge.patchPath).toBeUndefined();
	});

	it("rejects a patch outside ownership and persists a policy failure without merge behavior", async () => {
		const packages = [workPackage("owned", "src/owned.ts"), workPackage("other", "src/other.ts")];
		const plan = requiredPlan(packages, 2);
		await writePatch(cwd, "patches/owned.patch", "src/outside.ts");
		await writePatch(cwd, "patches/other.patch", "src/other.ts");
		const snapshots: WorkPackageStateArtifactV1[] = [];
		const successes: string[] = [];
		let thrown: unknown;

		try {
			await executeWorkPackagePlan({
				workflowId: WORKFLOW_ID,
				attemptId: "ownership-attempt",
				cwd,
				plan,
				execute: async candidate => implementationResult(candidate.id, `patches/${candidate.id}.patch`),
				persist: async state => {
					snapshots.push(state);
				},
				onSuccess: async candidate => {
					successes.push(candidate.id);
				},
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(WorkPackageExecutionError);
		const executionError = thrown as WorkPackageExecutionError;
		expect(executionError.kind).toBe("policy_violation");
		expect(executionError.failures).toEqual(
			expect.arrayContaining([expect.objectContaining({ packageId: "owned", requestLaunched: true })]),
		);
		expect(executionError.details).toEqual(
			expect.objectContaining({
				failures: expect.arrayContaining([
					expect.objectContaining({ packageId: "owned", kind: "policy_violation" }),
				]),
			}),
		);
		expect(successes).not.toContain("owned");
		const final = snapshots.at(-1)!;
		expect(final.packages.find(candidate => candidate.id === "owned")).toMatchObject({
			status: "failed",
			errorKind: "policy_violation",
		});
		expect(final.merge.status).toBe("pending");
		expect(final.merge.patchPath).toBeUndefined();
	});
});

describe("work-package aggregation", () => {
	it("applies one combined patch while preserving merge order and deterministic unions", () => {
		const first = workPackage("first", "src/first.ts");
		const second = workPackage("second", "src/second.ts");
		const beforeMerge = stateArtifact(
			[
				{
					...first,
					status: "succeeded",
					implementation: implementationArtifact("first", "patches/first.patch", {
						summary: "first summary",
						changedFiles: ["shared.ts", "first.ts"],
						addressedStepIds: ["step-first", "shared-step"],
						commandsRun: [{ command: "first command", exitCode: 0, summary: "first" }],
						unresolved: ["first unresolved", "shared unresolved"],
					}),
				},
				{
					...second,
					status: "succeeded",
					implementation: implementationArtifact("second", "patches/second.patch", {
						summary: "second summary",
						changedFiles: ["second.ts", "shared.ts"],
						addressedStepIds: ["step-second", "shared-step"],
						commandsRun: [{ command: "second command", exitCode: 0, summary: "second" }],
						unresolved: ["shared unresolved", "second unresolved"],
					}),
				},
			],
			["second", "first"],
			4,
			"before-merge",
		);
		const merge = {
			patchPath: "patches/combined.patch",
			changesApplied: true,
			summary: "combined changes applied",
		};
		const mergedState = withWorkPackageMerge(beforeMerge, "merged-attempt", merge);

		expect(mergedState.revision).toBe(5);
		expect(mergedState.attemptId).toBe("merged-attempt");
		expect(mergedState.merge).toMatchObject({
			status: "applied",
			order: ["second", "first"],
			patchPath: "patches/combined.patch",
			changesApplied: true,
			summary: "combined changes applied",
		});

		const aggregate = aggregateWorkPackageImplementations({
			workflowId: WORKFLOW_ID,
			attemptId: "merged-attempt",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			state: mergedState,
			merge,
		});

		expect(aggregate.summary).toBe("second: second summary; first: first summary");
		expect(aggregate.changedFiles).toEqual(["second.ts", "shared.ts", "first.ts"]);
		expect(aggregate.addressedStepIds).toEqual(["step-second", "shared-step", "step-first"]);
		expect(aggregate.unresolved).toEqual(["shared unresolved", "second unresolved", "first unresolved"]);
		expect(aggregate.commandsRun.map(command => command.command)).toEqual(["second command", "first command"]);
		expect(aggregate.patchPath).toBe("patches/combined.patch");
	});
});
