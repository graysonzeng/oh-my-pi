/**
 * WorkflowConcurrencyDeclarationV1 — design A §4.4.
 * Versioned, strict, durable work-package DAG / ownership / completion contract.
 * Lowering targets existing task/index.ts + task/parallel.ts or workflow RuntimePort.
 */

import { stableSerialize, sha256Hex } from "./stable-serialize";
import { mapWithConcurrencyLimitAllSettled, Semaphore, type ParallelSettledResult } from "../task/parallel";
export const WORKFLOW_CONCURRENCY_DECLARATION_KIND = "workflow_concurrency_declaration" as const;
export const WORKFLOW_CONCURRENCY_DECLARATION_VERSION = 1 as const;

export type ConcurrencyOwnerKind = "workflow" | "session_task";
export type ConcurrencyUnitMode = "read" | "write";
export type ConcurrencyUnitStatus =
	| "declared"
	| "ready"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "skipped_dependency";
export type ConcurrencyDeclarationStatus =
	| "declared"
	| "running"
	| "converged"
	| "committed"
	| "failed"
	| "blocked"
	| "cancelled";

export interface ConcurrencyCompletionPolicyV1 {
	kind: "all_required" | "quorum";
	minSuccesses: number | null;
}

export interface ConcurrencyUnitV1 {
	id: string;
	assignment: string;
	paths: string[];
	dependsOn: string[];
	independentGroup?: string;
	isolationScope?: string;
	rendezvousId?: string;
	mode: ConcurrencyUnitMode;
	required: boolean;
	idempotencyKey: string;
}

export interface WorkflowConcurrencyDeclarationV1 {
	schemaVersion: typeof WORKFLOW_CONCURRENCY_DECLARATION_VERSION;
	kind: typeof WORKFLOW_CONCURRENCY_DECLARATION_KIND;
	declarationId: string;
	ownerKind: ConcurrencyOwnerKind;
	ownerId: string;
	scopeArtifactRef: string;
	scopeArtifactSha256: string;
	revision: number;
	maxConcurrency: number;
	completionPolicy: ConcurrencyCompletionPolicyV1;
	failurePolicy: "fail_closed" | "continue_independent";
	cancelPolicy: "cascade_dependents" | "stop_new_work";
	units: ConcurrencyUnitV1[];
	fingerprint: string;
}

export interface ConcurrencyUnitStateV1 {
	id: string;
	status: ConcurrencyUnitStatus;
	startedAt?: string;
	endedAt?: string;
	queuedMs?: number;
	resultArtifactSha256?: string;
	errorSummary?: string;
	attemptCount: number;
}

export interface ConcurrencyDeclarationStateV1 {
	schemaVersion: 1;
	kind: "concurrency_declaration_state";
	declarationId: string;
	declarationFingerprint: string;
	status: ConcurrencyDeclarationStatus;
	units: ConcurrencyUnitStateV1[];
	revision: number;
	updatedAt: string;
}

export type ConcurrencyValidationErrorCode =
	| "unknown_field"
	| "missing_required"
	| "duplicate_unit_id"
	| "self_dependency"
	| "missing_dependency"
	| "cycle"
	| "path_overlap"
	| "isolation_overlap"
	| "invalid_rendezvous"
	| "invalid_quorum"
	| "invalid_max_concurrency"
	| "scope_hash_required"
	| "fingerprint_mismatch";

export interface ConcurrencyValidationResult {
	ok: boolean;
	errors: Array<{ code: ConcurrencyValidationErrorCode; message: string; unitId?: string }>;
}


export function fingerprintConcurrencyDeclaration(
	decl: Omit<WorkflowConcurrencyDeclarationV1, "fingerprint" | "kind">,
): string {
	return sha256Hex(stableSerialize(decl));
}

export function buildConcurrencyDeclaration(
	input: Omit<WorkflowConcurrencyDeclarationV1, "fingerprint" | "kind" | "schemaVersion"> & {
		schemaVersion?: 1;
	},
): WorkflowConcurrencyDeclarationV1 {
	const base = {
		schemaVersion: 1 as const,
		declarationId: input.declarationId,
		ownerKind: input.ownerKind,
		ownerId: input.ownerId,
		scopeArtifactRef: input.scopeArtifactRef,
		scopeArtifactSha256: input.scopeArtifactSha256,
		revision: input.revision,
		maxConcurrency: input.maxConcurrency,
		completionPolicy: input.completionPolicy,
		failurePolicy: input.failurePolicy,
		cancelPolicy: input.cancelPolicy,
		units: input.units,
	};
	return {
		...base,
		kind: WORKFLOW_CONCURRENCY_DECLARATION_KIND,
		fingerprint: fingerprintConcurrencyDeclaration(base),
	};
}

export function validateConcurrencyDeclaration(
	decl: WorkflowConcurrencyDeclarationV1,
	options?: { knownFieldsOnly?: boolean; raw?: Record<string, unknown> },
): ConcurrencyValidationResult {
	const errors: ConcurrencyValidationResult["errors"] = [];

	const raw = options?.raw ?? (options?.knownFieldsOnly ? (decl as unknown as Record<string, unknown>) : undefined);
	if (raw) {
		const allowed = new Set([
			"schemaVersion",
			"kind",
			"declarationId",
			"ownerKind",
			"ownerId",
			"scopeArtifactRef",
			"scopeArtifactSha256",
			"revision",
			"maxConcurrency",
			"completionPolicy",
			"failurePolicy",
			"cancelPolicy",
			"units",
			"fingerprint",
		]);
		for (const key of Object.keys(raw)) {
			if (!allowed.has(key)) errors.push({ code: "unknown_field", message: `unknown field: ${key}` });
		}
		const completion = raw.completionPolicy;
		if (completion && typeof completion === "object" && !Array.isArray(completion)) {
			for (const key of Object.keys(completion as Record<string, unknown>)) {
				if (key !== "kind" && key !== "minSuccesses") {
					errors.push({ code: "unknown_field", message: `unknown completionPolicy field: ${key}` });
				}
			}
		}
		if (Array.isArray(raw.units)) {
			const unitFields = new Set([
				"id",
				"assignment",
				"paths",
				"dependsOn",
				"independentGroup",
				"isolationScope",
				"rendezvousId",
				"mode",
				"required",
				"idempotencyKey",
			]);
			for (const candidate of raw.units) {
				if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
				for (const key of Object.keys(candidate as Record<string, unknown>)) {
					if (!unitFields.has(key)) errors.push({ code: "unknown_field", message: `unknown unit field: ${key}` });
				}
			}
		}
	}

	if (decl.schemaVersion !== WORKFLOW_CONCURRENCY_DECLARATION_VERSION) {
		errors.push({ code: "missing_required", message: "unsupported schemaVersion" });
	}
	if (decl.kind !== WORKFLOW_CONCURRENCY_DECLARATION_KIND) {
		errors.push({ code: "missing_required", message: "invalid declaration kind" });
	}
	if (!decl.declarationId?.trim()) errors.push({ code: "missing_required", message: "declarationId required" });
	if (decl.ownerKind !== "workflow" && decl.ownerKind !== "session_task") {
		errors.push({ code: "missing_required", message: "ownerKind required" });
	}
	if (!decl.ownerId?.trim()) errors.push({ code: "missing_required", message: "ownerId required" });
	if (!decl.scopeArtifactSha256?.trim()) {
		errors.push({ code: "scope_hash_required", message: "scopeArtifactSha256 required" });
	}
	// Fail closed on stale/tampered fingerprints: recompute the canonical digest.
	if (decl.schemaVersion === WORKFLOW_CONCURRENCY_DECLARATION_VERSION && Array.isArray(decl.units)) {
		const expectedFingerprint = fingerprintConcurrencyDeclaration({
			schemaVersion: decl.schemaVersion,
			declarationId: decl.declarationId,
			ownerKind: decl.ownerKind,
			ownerId: decl.ownerId,
			scopeArtifactRef: decl.scopeArtifactRef,
			scopeArtifactSha256: decl.scopeArtifactSha256,
			revision: decl.revision,
			maxConcurrency: decl.maxConcurrency,
			completionPolicy: decl.completionPolicy,
			failurePolicy: decl.failurePolicy,
			cancelPolicy: decl.cancelPolicy,
			units: decl.units,
		});
		if (decl.fingerprint !== expectedFingerprint) {
			errors.push({
				code: "fingerprint_mismatch",
				message: "declaration fingerprint does not match canonical content",
			});
		}
	}
	if (!Number.isFinite(decl.revision) || decl.revision < 0) {
		errors.push({ code: "missing_required", message: "revision must be >= 0" });
	}
	if (!Number.isFinite(decl.maxConcurrency) || decl.maxConcurrency < 0) {
		errors.push({ code: "invalid_max_concurrency", message: "maxConcurrency must be >= 0" });
	}
	if (decl.failurePolicy !== "fail_closed" && decl.failurePolicy !== "continue_independent") {
		errors.push({ code: "missing_required", message: "invalid failurePolicy" });
	}
	if (decl.cancelPolicy !== "cascade_dependents" && decl.cancelPolicy !== "stop_new_work") {
		errors.push({ code: "missing_required", message: "invalid cancelPolicy" });
	}
	if (!decl.completionPolicy || typeof decl.completionPolicy !== "object") {
		errors.push({ code: "missing_required", message: "completionPolicy required" });
	}
	if (!Array.isArray(decl.units) || decl.units.length === 0) {
		errors.push({ code: "missing_required", message: "units required" });
	}

	const ids = new Set<string>();
	for (const unit of decl.units ?? []) {
		if (!unit || typeof unit !== "object") {
			errors.push({ code: "missing_required", message: "unit required" });
			continue;
		}
		if (!unit.id?.trim()) {
			errors.push({ code: "missing_required", message: "unit.id required", unitId: unit.id });
			continue;
		}
		if (ids.has(unit.id)) errors.push({ code: "duplicate_unit_id", message: `duplicate unit id ${unit.id}`, unitId: unit.id });
		ids.add(unit.id);
		if (!unit.assignment?.trim()) errors.push({ code: "missing_required", message: "assignment required", unitId: unit.id });
		if (!unit.idempotencyKey?.trim()) {
			errors.push({ code: "missing_required", message: "idempotencyKey required", unitId: unit.id });
		}
		if (!Array.isArray(unit.paths) || unit.paths.length === 0 || !unit.paths.every(path => typeof path === "string" && path.trim())) {
			errors.push({ code: "missing_required", message: "paths required", unitId: unit.id });
		}
		if (!Array.isArray(unit.dependsOn) || !unit.dependsOn.every(dep => typeof dep === "string" && dep.trim())) {
			errors.push({ code: "missing_required", message: "dependsOn required", unitId: unit.id });
		}
		if (unit.mode !== "read" && unit.mode !== "write") {
			errors.push({ code: "missing_required", message: "mode required", unitId: unit.id });
		}
		if (typeof unit.required !== "boolean") {
			errors.push({ code: "missing_required", message: "required flag required", unitId: unit.id });
		}
		for (const dep of unit.dependsOn ?? []) {
			if (dep === unit.id) errors.push({ code: "self_dependency", message: "self dependency", unitId: unit.id });
		}
	}

	for (const unit of decl.units ?? []) {
		if (!unit || typeof unit !== "object") continue;
		for (const dep of unit.dependsOn ?? []) {
			if (!ids.has(dep)) {
				errors.push({ code: "missing_dependency", message: `missing dependency ${dep}`, unitId: unit.id });
			}
		}
	}

	// Cycle detection (Kahn).
	const indegree = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const id of ids) {
		indegree.set(id, 0);
		adj.set(id, []);
	}
	for (const unit of decl.units ?? []) {
		if (!unit || typeof unit !== "object") continue;
		for (const dep of unit.dependsOn ?? []) {
			if (!ids.has(dep)) continue;
			adj.get(dep)!.push(unit.id);
			indegree.set(unit.id, (indegree.get(unit.id) ?? 0) + 1);
		}
	}
	const queue = [...ids].filter(id => (indegree.get(id) ?? 0) === 0);
	let seen = 0;
	while (queue.length > 0) {
		const id = queue.shift()!;
		seen++;
		for (const next of adj.get(id) ?? []) {
			const degree = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, degree);
			if (degree === 0) queue.push(next);
		}
	}
	if (ids.size > 0 && seen !== ids.size) errors.push({ code: "cycle", message: "dependency graph has a cycle" });

	// Independent write ownership and same-isolation conflicts are unsafe even with disjoint paths.
	for (let left = 0; left < (decl.units ?? []).length; left++) {
		for (let right = left + 1; right < (decl.units ?? []).length; right++) {
			const a = decl.units[left]!;
			const b = decl.units[right]!;
			if (!a || !b || typeof a !== "object" || typeof b !== "object") continue;
			const ordered = a.dependsOn.includes(b.id) || b.dependsOn.includes(a.id);
			const overlap = pathSetsOverlap(a.paths ?? [], b.paths ?? []);
			const sameIsolation = Boolean(
				a.isolationScope && a.isolationScope.trim() && a.isolationScope === b.isolationScope,
			);
			if (!ordered && overlap && (a.mode === "write" || b.mode === "write")) {
				errors.push({
					code: "path_overlap",
					message: `write path overlap between ${a.id} and ${b.id}`,
					unitId: a.id,
				});
			}
			// Isolation scope conflicts are independent of path overlap.
			if (sameIsolation) {
				errors.push({
					code: "isolation_overlap",
					message: `isolationScope overlap between ${a.id} and ${b.id}`,
					unitId: a.id,
				});
			}
		}
	}

	const rendezvousCounts = new Map<string, number>();
	for (const unit of decl.units ?? []) {
		if (!unit || typeof unit !== "object") continue;
		const rendezvousId = typeof unit.rendezvousId === "string" ? unit.rendezvousId.trim() : "";
		if (rendezvousId) rendezvousCounts.set(rendezvousId, (rendezvousCounts.get(rendezvousId) ?? 0) + 1);
	}
	for (const unit of decl.units ?? []) {
		if (!unit || typeof unit !== "object") continue;
		const rendezvousId = typeof unit.rendezvousId === "string" ? unit.rendezvousId.trim() : "";
		if (rendezvousId && (rendezvousCounts.get(rendezvousId) ?? 0) < 2) {
			errors.push({
				code: "invalid_rendezvous",
				message: `rendezvous ${rendezvousId} must group at least two units`,
				unitId: unit.id,
			});
		}
	}

	if (decl.completionPolicy?.kind === "quorum") {
		const min = decl.completionPolicy.minSuccesses;
		const count = decl.units?.length ?? 0;
		if (min == null || !Number.isFinite(min) || min < 1 || min > count) {
			errors.push({ code: "invalid_quorum", message: "quorum requires minSuccesses within unit count" });
		}
	}
	return { ok: errors.length === 0, errors };
}

function pathSetsOverlap(a: readonly string[], b: readonly string[]): boolean {
	const setB = new Set(b.map(normalizePath));
	for (const path of a) {
		const normalized = normalizePath(path);
		if (!normalized) continue;
		if (setB.has(normalized)) return true;
		for (const other of setB) {
			if (normalized.startsWith(`${other}/`) || other.startsWith(`${normalized}/`)) return true;
		}
	}
	return false;
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Ready units: dependencies satisfied, not terminal. */
export function readyConcurrencyUnits(
	decl: WorkflowConcurrencyDeclarationV1,
	states: readonly ConcurrencyUnitStateV1[],
): ConcurrencyUnitV1[] {
	const status = new Map(states.map(state => [state.id, state.status]));
	const succeeded = new Set(states.filter(state => state.status === "succeeded").map(state => state.id));
	return decl.units.filter(unit => {
		const state = status.get(unit.id) ?? "declared";
		if (state !== "declared" && state !== "ready") return false;
		return unit.dependsOn.every(dep => succeeded.has(dep));
	});
}

export function initialDeclarationState(
	decl: WorkflowConcurrencyDeclarationV1,
): ConcurrencyDeclarationStateV1 {
	return {
		schemaVersion: 1,
		kind: "concurrency_declaration_state",
		declarationId: decl.declarationId,
		declarationFingerprint: decl.fingerprint,
		status: "declared",
		units: decl.units.map(unit => ({ id: unit.id, status: "declared", attemptCount: 0 })),
		revision: 0,
		updatedAt: new Date().toISOString(),
	};
}

/** Effective concurrency: min of declaration, session task.maxConcurrency, and provider limit. */
export function resolveEffectiveConcurrency(limits: {
	declarationMax: number;
	sessionMax?: number;
	providerMax?: number;
}): number {
	const positives = [limits.declarationMax, limits.sessionMax, limits.providerMax].filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
	);
	return positives.length === 0 ? 0 : Math.min(...positives);
}

function unitsConflict(a: ConcurrencyUnitV1, b: ConcurrencyUnitV1): boolean {
	if (a.dependsOn.includes(b.id) || b.dependsOn.includes(a.id)) return true;
	const sameIsolation = Boolean(a.isolationScope && a.isolationScope.trim() && a.isolationScope === b.isolationScope);
	if (sameIsolation) return true;
	if (!pathSetsOverlap(a.paths, b.paths)) return false;
	return a.mode === "write" || b.mode === "write";
}

/** Whether auto-parallel should fire: at least two independent ready units with no ownership conflict. */
export function shouldAutoParallel(ready: readonly ConcurrencyUnitV1[]): boolean {
	if (ready.length < 2) return false;
	for (let left = 0; left < ready.length; left++) {
		for (let right = left + 1; right < ready.length; right++) {
			if (unitsConflict(ready[left]!, ready[right]!)) return false;
		}
	}
	return true;
}

export interface ConcurrencyExecutionPlanOptions<T> {
	states: readonly ConcurrencyUnitStateV1[];
	/** Session `task.maxConcurrency`; zero or omitted means unbounded. */
	sessionMaxConcurrency?: number;
	providerMaxConcurrency?: number;
	raw?: Record<string, unknown>;
	execute: (unit: ConcurrencyUnitV1, index: number, signal: AbortSignal) => Promise<T>;
}

export interface ConcurrencyExecutionPlan<T> {
	declaration: WorkflowConcurrencyDeclarationV1;
	ready: readonly ConcurrencyUnitV1[];
	maxConcurrency: number;
	semaphore: Semaphore;
	run(signal?: AbortSignal): Promise<ParallelSettledResult<T>>;
}

/**
 * Lower a strictly valid declaration's current ready wave onto the canonical
 * all-settled worker pool plus semaphore. Null means serial/no-parallel.
 */
export function buildConcurrencyExecutionPlan<T>(
	decl: WorkflowConcurrencyDeclarationV1,
	options: ConcurrencyExecutionPlanOptions<T>,
): ConcurrencyExecutionPlan<T> | null {
	const validation = validateConcurrencyDeclaration(decl, { knownFieldsOnly: true, raw: options.raw });
	if (!validation.ok) return null;
	const ready = readyConcurrencyUnits(decl, options.states);
	if (!shouldAutoParallel(ready)) return null;
	const maxConcurrency = resolveEffectiveConcurrency({
		declarationMax: decl.maxConcurrency,
		sessionMax: options.sessionMaxConcurrency,
		providerMax: options.providerMaxConcurrency,
	});
	if (maxConcurrency === 1) return null;
	const semaphore = new Semaphore(maxConcurrency);
	return {
		declaration: decl,
		ready: [...ready],
		maxConcurrency,
		semaphore,
		run: (signal?: AbortSignal) =>
			mapWithConcurrencyLimitAllSettled(
				[...ready],
				ready.length,
				async (unit, index, workerSignal) => {
					await semaphore.acquire(workerSignal);
					try {
						return await options.execute(unit, index, workerSignal);
					} finally {
						semaphore.release();
					}
				},
				signal,
			),
	};
}

