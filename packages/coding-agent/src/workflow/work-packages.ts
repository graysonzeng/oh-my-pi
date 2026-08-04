import * as path from "node:path";
import workPackageAssignmentTemplate from "../prompts/workflow/work-package-assignment.hbs.md" with { type: "text" };
import {
	buildConcurrencyDeclaration,
	shouldAutoParallel,
	type ConcurrencyUnitV1,
	type WorkflowConcurrencyDeclarationV1,
} from "../latency/concurrency-declaration";
import { mapWithConcurrencyLimitAllSettled, Semaphore } from "../task/parallel";
import { parsePatchTouchedFiles } from "../utils/git";
import { sha256Hex } from "./optimization-receipt";
import { renderContextTemplate } from "./context-builder";
import { WorkflowCancelledError, WorkflowError, WorkflowPolicyError } from "./errors";
import type { ImplementStageResult } from "./stages/implement";
import type {
	CapturedChangesMergeResult,
	ImplementationArtifactV1,
	ModelProfile,
	WorkflowErrorKind,
	WorkPackageExecutionV1,
	WorkPackageStateArtifactV1,
	WorkPackageV1,
} from "./types";

export interface WorkPackageExecutionPlan {
	packages: WorkPackageV1[];
	waves: WorkPackageV1[][];
	mergeOrder: string[];
	maxConcurrency: number;
}

export interface ExecuteWorkPackagePlanInput {
	workflowId: string;
	attemptId: string;
	cwd: string;
	plan: WorkPackageExecutionPlan;
	priorState?: WorkPackageStateArtifactV1;
	reuseSucceeded?: boolean;
	signal?: AbortSignal;
	execute: (
		workPackage: WorkPackageV1,
		invocationAttemptId: string,
		signal: AbortSignal,
	) => Promise<ImplementStageResult>;
	persist: (state: WorkPackageStateArtifactV1) => Promise<void>;
	onSuccess?: (workPackage: WorkPackageV1, result: ImplementStageResult) => Promise<void>;
}

export interface WorkPackageFailure {
	packageId: string;
	error: unknown;
	requestLaunched: boolean;
}

/** One parallel-wave failure, preserving the first workflow error classification. */
export class WorkPackageExecutionError extends WorkflowError {
	readonly failures: WorkPackageFailure[];
	readonly failedRequests: number;

	constructor(failures: WorkPackageFailure[]) {
		const primary = failures[0]?.error;
		const kind: WorkflowErrorKind = primary instanceof WorkflowError ? primary.kind : "internal";
		const summary = failures
			.map(failure => `${failure.packageId}: ${errorSummary(failure.error)}`)
			.join("; ")
			.slice(0, 1_000);
		super(`Work-package execution failed: ${summary || "unknown failure"}`, kind, {
			failures: failures.map(failure => ({
				packageId: failure.packageId,
				kind: failure.error instanceof WorkflowError ? failure.error.kind : "internal",
				summary: errorSummary(failure.error),
			})),
		});
		this.name = "WorkPackageExecutionError";
		this.failures = failures;
		this.failedRequests = failures.filter(failure => failure.requestLaunched).length;
	}
}

/**
 * Build flat independent-wave scaffolding for work packages with empty dependsOn.
 * Any non-empty dependsOn returns null so callers keep the whole-plan path: full
 * durable DAG ready-waves / join / quorum / resume / cancel lifecycle is deferred.
 * Invalid ids/dependencies/paths, path ownership overlap, or an effectively serial
 * limit also return null. The final wave guard mirrors `shouldAutoParallel`: at
 * least two independent ready units are required.
 */
export function buildWorkPackageExecutionPlan(
	input: readonly WorkPackageV1[] | undefined,
	maxConcurrency: number,
): WorkPackageExecutionPlan | null {
	if (!input || input.length < 2) return null;
	// Phase-1 honesty: only flat independent packages. Dependent DAGs fall back.
	if (input.some(candidate => candidate.dependsOn.length > 0)) return null;
	const normalizedMax = Number.isFinite(maxConcurrency) ? Math.trunc(maxConcurrency) : 0;
	if (normalizedMax === 1) return null;

	const packages: WorkPackageV1[] = [];
	const ids = new Set<string>();
	for (const candidate of input) {
		const id = candidate.id.trim();
		const assignment = candidate.assignment.trim();
		if (!id || !assignment || ids.has(id)) return null;
		ids.add(id);
		const paths = uniqueSorted(
			candidate.paths.map(normalizeOwnedPath).filter((value): value is string => value !== null),
		);
		if (paths.length === 0 || paths.length !== new Set(candidate.paths.map(value => value.trim())).size) return null;
		const dependsOn = uniqueSorted(candidate.dependsOn.map(value => value.trim()));
		if (dependsOn.some(dependency => !dependency || dependency === id)) return null;
		packages.push({ id, assignment, paths, dependsOn });
	}

	for (const workPackage of packages) {
		if (workPackage.dependsOn.some(dependency => !ids.has(dependency))) return null;
	}
	for (let left = 0; left < packages.length; left++) {
		for (let right = left + 1; right < packages.length; right++) {
			if (pathSetsOverlap(packages[left]!.paths, packages[right]!.paths)) return null;
		}
	}

	packages.sort(comparePackages);
	const completed = new Set<string>();
	const waves: WorkPackageV1[][] = [];
	while (completed.size < packages.length) {
		const ready = packages
			.filter(workPackage => !completed.has(workPackage.id))
			.filter(workPackage => workPackage.dependsOn.every(dependency => completed.has(dependency)))
			.sort(comparePackages);
		if (ready.length === 0) return null;
		waves.push(ready);
		for (const workPackage of ready) completed.add(workPackage.id);
	}
	const parallelWave = waves.some(wave =>
		shouldAutoParallel(
			wave.map(
				workPackage =>
					({
						id: workPackage.id,
						assignment: workPackage.assignment,
						paths: workPackage.paths,
						dependsOn: workPackage.dependsOn,
						mode: "write",
						required: true,
						idempotencyKey: `work-package:${workPackage.id}`,
					} satisfies ConcurrencyUnitV1),
			),
		),
	);
	if (!parallelWave) return null;
	return {
		packages,
		waves,
		mergeOrder: waves.flatMap(wave => wave.map(workPackage => workPackage.id)),
		maxConcurrency: normalizedMax,
	};
}

export interface WorkPackageConcurrencyDeclarationOptions {
	declarationId?: string;
	ownerId?: string;
	scopeArtifactRef?: string;
	scopeArtifactSha256?: string;
	maxConcurrency?: number;
}

/** Convert plan work packages into the strict declaration contract when its arm is enabled. */
export function workPackagesToConcurrencyDeclaration(
	input: readonly WorkPackageV1[] | undefined,
	options: WorkPackageConcurrencyDeclarationOptions = {},
): WorkflowConcurrencyDeclarationV1 | null {
	if (!input || input.length === 0) return null;
	const packages = input.map(workPackage => ({
		id: workPackage.id.trim(),
		assignment: workPackage.assignment.trim(),
		paths: workPackage.paths.map(value => value.trim()),
		dependsOn: workPackage.dependsOn.map(value => value.trim()),
	}));
	const scopePayload = JSON.stringify(packages);
	return buildConcurrencyDeclaration({
		declarationId: options.declarationId ?? "plan-work-packages",
		ownerKind: "workflow",
		ownerId: options.ownerId ?? "workflow",
		scopeArtifactRef: options.scopeArtifactRef ?? "plan://work-packages",
		scopeArtifactSha256: options.scopeArtifactSha256 ?? sha256Hex(scopePayload),
		revision: 0,
		maxConcurrency: options.maxConcurrency ?? 0,
		completionPolicy: { kind: "all_required", minSuccesses: null },
		failurePolicy: "fail_closed",
		cancelPolicy: "cascade_dependents",
		units: packages.map(workPackage => ({
			...workPackage,
			mode: "write" as const,
			required: true,
			idempotencyKey: `work-package:${workPackage.id}`,
		})),
	});
}

export function renderWorkPackageAssignment(workPackage: WorkPackageV1): string {
	return renderContextTemplate(workPackageAssignmentTemplate, {
		id: workPackage.id,
		assignment: workPackage.assignment,
		paths: workPackage.paths.map(value => `- ${value}`).join("\n"),
		dependsOn:
			workPackage.dependsOn.length > 0 ? workPackage.dependsOn.map(value => `- ${value}`).join("\n") : "- (none)",
	});
}

/** Execute stable dependency waves through the existing task semaphore/all-settled pattern. */
export async function executeWorkPackagePlan(input: ExecuteWorkPackagePlanInput): Promise<WorkPackageStateArtifactV1> {
	const reusable = input.reuseSucceeded
		? await reusableExecutions(input.priorState, input.plan.packages, input.cwd)
		: new Map<string, WorkPackageExecutionV1>();
	const state: WorkPackageStateArtifactV1 = {
		kind: "work-package-state",
		schemaVersion: 1,
		workflowId: input.workflowId,
		attemptId: input.attemptId,
		stage: "implementing",
		createdAt: new Date().toISOString(),
		revision: input.priorState?.revision ?? 0,
		mode: "capture_then_apply",
		packages: input.plan.packages.map(workPackage => {
			const prior = reusable.get(workPackage.id);
			return prior
				? structuredClone(prior)
				: {
						...workPackage,
						status: "pending",
					};
		}),
		merge: {
			status: "pending",
			order: [...input.plan.mergeOrder],
		},
	};
	let persistence = Promise.resolve();
	const commit = (mutate?: () => void): Promise<void> => {
		const operation = persistence.then(async () => {
			mutate?.();
			state.revision += 1;
			state.attemptId = input.attemptId;
			state.createdAt = new Date().toISOString();
			await input.persist(structuredClone(state));
		});
		persistence = operation.catch(() => {});
		return operation;
	};
	await commit();

	const semaphore = new Semaphore(input.plan.maxConcurrency);
	const packageIndex = new Map(input.plan.packages.map((workPackage, index) => [workPackage.id, index]));
	for (const wave of input.plan.waves) {
		if (input.signal?.aborted) throw new WorkflowCancelledError("cancelled before work-package wave");
		const pending = wave.filter(workPackage => packageState(state, workPackage.id).status !== "succeeded");
		if (pending.length === 0) continue;
		const { results, aborted } = await mapWithConcurrencyLimitAllSettled(
			pending,
			pending.length,
			async (workPackage, _index, workerSignal) => {
				let acquired = false;
				let requestLaunched = false;
				try {
					await semaphore.acquire(workerSignal);
					acquired = true;
					if (workerSignal.aborted) throw new WorkflowCancelledError("cancelled before work-package launch");
					requestLaunched = true;
					const stableIndex = packageIndex.get(workPackage.id) ?? 0;
					const invocationAttemptId = `${input.attemptId}_wp_${stableIndex + 1}_r${state.revision + 1}`;
					const result = await input.execute(workPackage, invocationAttemptId, workerSignal);
					await assertOwnedPatch(result, workPackage, input.cwd);
					await commit(() => {
						Object.assign(packageState(state, workPackage.id), {
							...workPackage,
							status: "succeeded",
							invocationAttemptId,
							implementation: result.artifact,
							identityReceipt: result.identityReceipt,
							modelFamily: result.modelFamily,
							errorKind: undefined,
							errorSummary: undefined,
						} satisfies WorkPackageExecutionV1);
					});
					await input.onSuccess?.(workPackage, result);
					return result;
				} catch (error) {
					await commit(() => {
						Object.assign(packageState(state, workPackage.id), {
							...workPackage,
							status: "failed",
							implementation: undefined,
							errorKind: error instanceof WorkflowError ? error.kind : "internal",
							errorSummary: errorSummary(error),
						} satisfies WorkPackageExecutionV1);
					});
					throw { packageId: workPackage.id, error, requestLaunched } satisfies WorkPackageFailure;
				} finally {
					if (acquired) semaphore.release();
				}
			},
			input.signal,
		);
		const failures: WorkPackageFailure[] = [];
		for (let index = 0; index < results.length; index++) {
			const settled = results[index];
			if (settled?.status === "rejected") {
				const reason = settled.reason as Partial<WorkPackageFailure>;
				failures.push({
					packageId: typeof reason.packageId === "string" ? reason.packageId : pending[index]!.id,
					error: "error" in reason ? reason.error : settled.reason,
					requestLaunched: reason.requestLaunched === true,
				});
			} else if (!settled) {
				failures.push({
					packageId: pending[index]!.id,
					error: new WorkflowCancelledError("work-package was not launched before cancellation"),
					requestLaunched: false,
				});
			}
		}
		if (failures.length > 0) throw new WorkPackageExecutionError(failures);
		if (aborted) throw new WorkflowCancelledError("cancelled after work-package wave");
	}
	return structuredClone(state);
}

export function withWorkPackageMergePrepared(
	state: WorkPackageStateArtifactV1,
	attemptId: string,
	options: {
		patchPath: string;
		patchSha256: string;
		scopeStatus: NonNullable<WorkPackageStateArtifactV1["scopeStatus"]>;
	},
): WorkPackageStateArtifactV1 {
	return {
		...structuredClone(state),
		attemptId,
		createdAt: new Date().toISOString(),
		revision: state.revision + 1,
		scopeStatus: options.scopeStatus,
		merge: {
			...state.merge,
			status: "prepared",
			patchPath: options.patchPath,
			changesApplied: false,
			patchSha256: options.patchSha256,
			summary: "validated patch prepared before merge",
		},
	};
}

export function withWorkPackageMerge(
	state: WorkPackageStateArtifactV1,
	attemptId: string,
	merge: CapturedChangesMergeResult,
): WorkPackageStateArtifactV1 {
	return {
		...structuredClone(state),
		attemptId,
		createdAt: new Date().toISOString(),
		revision: state.revision + 1,
		merge: {
			...state.merge,
			status: merge.changesApplied ? "applied" : "failed",
			patchPath: merge.patchPath,
			changesApplied: merge.changesApplied,
			summary: merge.summary,
		},
	};
}

export function aggregateWorkPackageImplementations(input: {
	workflowId: string;
	attemptId: string;
	profile: ModelProfile;
	state: WorkPackageStateArtifactV1;
	merge: CapturedChangesMergeResult;
}): ImplementationArtifactV1 {
	const byId = new Map(input.state.packages.map(workPackage => [workPackage.id, workPackage]));
	const implementations = input.state.merge.order.map(id => {
		const execution = byId.get(id);
		if (execution?.status !== "succeeded" || !execution.implementation) {
			throw new WorkflowPolicyError("work_package_aggregate_incomplete", { packageId: id });
		}
		return execution.implementation;
	});
	const first = implementations[0];
	return {
		kind: "implementation",
		schemaVersion: 1,
		workflowId: input.workflowId,
		attemptId: input.attemptId,
		stage: "implementing",
		createdAt: new Date().toISOString(),
		modelProfileId: input.profile.id,
		provider: first?.provider ?? input.profile.vendor,
		model: first?.model,
		promptVersion: input.profile.promptVersion,
		summary: input.state.merge.order.map((id, index) => `${id}: ${implementations[index]!.summary}`).join("; "),
		changedFiles: uniqueInOrder(implementations.flatMap(implementation => implementation.changedFiles)),
		addressedStepIds: uniqueInOrder(implementations.flatMap(implementation => implementation.addressedStepIds)),
		commandsRun: implementations.flatMap(implementation => implementation.commandsRun),
		patchPath: input.merge.patchPath,
		unresolved: uniqueInOrder(implementations.flatMap(implementation => implementation.unresolved)),
	};
}

function normalizeOwnedPath(value: string): string | null {
	const normalizedSeparators = value.trim().replaceAll("\\", "/");
	if (!normalizedSeparators || normalizedSeparators.includes("\0") || path.posix.isAbsolute(normalizedSeparators)) {
		return null;
	}
	const normalized = path.posix.normalize(normalizedSeparators).replace(/^\.\//, "").replace(/\/$/, "");
	if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
	return normalized;
}

function pathSetsOverlap(left: readonly string[], right: readonly string[]): boolean {
	return left.some(leftPath =>
		right.some(
			rightPath =>
				leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`),
		),
	);
}

function comparePackages(left: WorkPackageV1, right: WorkPackageV1): number {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function uniqueInOrder(values: string[]): string[] {
	return [...new Set(values)];
}

function packageState(state: WorkPackageStateArtifactV1, packageId: string): WorkPackageExecutionV1 {
	const execution = state.packages.find(candidate => candidate.id === packageId);
	if (!execution) throw new WorkflowPolicyError("work_package_state_missing", { packageId });
	return execution;
}

async function reusableExecutions(
	priorState: WorkPackageStateArtifactV1 | undefined,
	packages: readonly WorkPackageV1[],
	cwd: string,
): Promise<Map<string, WorkPackageExecutionV1>> {
	const reusable = new Map<string, WorkPackageExecutionV1>();
	if (priorState?.mode !== "capture_then_apply" || priorState.merge.status === "failed") return reusable;
	const priorById = new Map(priorState.packages.map(workPackage => [workPackage.id, workPackage]));
	for (const workPackage of packages) {
		const prior = priorById.get(workPackage.id);
		if (
			prior?.status !== "succeeded" ||
			!prior.implementation?.patchPath ||
			prior.assignment !== workPackage.assignment ||
			!sameStrings(prior.paths, workPackage.paths) ||
			!sameStrings(prior.dependsOn, workPackage.dependsOn)
		) {
			continue;
		}
		try {
			await assertOwnedPatch({ artifact: prior.implementation }, workPackage, cwd);
			reusable.set(workPackage.id, prior);
		} catch {
			// Missing, corrupt, or out-of-scope captures are rerun; never trust stale metadata.
		}
	}
	return reusable;
}

async function assertOwnedPatch(
	result: Pick<ImplementStageResult, "artifact">,
	workPackage: WorkPackageV1,
	cwd: string,
): Promise<void> {
	const patchPath = result.artifact.patchPath;
	if (!patchPath) {
		throw new WorkflowPolicyError("work_package_patch_required", { packageId: workPackage.id });
	}
	const resolved = path.isAbsolute(patchPath) ? patchPath : path.join(cwd, patchPath);
	const patchText = await Bun.file(resolved).text();
	if (!patchText.trim()) {
		throw new WorkflowPolicyError("work_package_empty_patch", { packageId: workPackage.id, patchPath });
	}
	const changedPaths = uniqueSorted(
		parsePatchTouchedFiles(patchText)
			.map(normalizeOwnedPath)
			.filter((value): value is string => value !== null),
	);
	if (changedPaths.length === 0) {
		throw new WorkflowPolicyError("work_package_patch_paths_unreadable", { packageId: workPackage.id, patchPath });
	}
	const outside = changedPaths.filter(
		changedPath => !workPackage.paths.some(owned => changedPath === owned || changedPath.startsWith(`${owned}/`)),
	);
	if (outside.length > 0) {
		throw new WorkflowPolicyError("work_package_path_ownership_violation", {
			packageId: workPackage.id,
			ownedPaths: workPackage.paths,
			changedPaths: outside,
		});
	}
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorSummary(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
