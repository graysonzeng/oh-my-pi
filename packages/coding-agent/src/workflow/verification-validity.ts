/**
 * Verification ownership and result validity (P1-2).
 *
 * Makes worker / parent / workflow_verifier responsibilities explicit on the
 * existing VerificationArtifactV1 path. Records command+scope, code state,
 * executor identity, and invalidation triggers so stale greens cannot be reused
 * as delivery evidence and identical still-valid command sets need not re-run.
 *
 * Not a new verification platform and not a generic anti-loop agent.
 */

import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { sha256Hex } from "./optimization-receipt";
import type {
	ImplementationArtifactV1,
	VerificationArtifactV1,
	VerificationCodeState,
	VerificationExecutor,
	VerificationInvalidationTrigger,
	VerificationOwnerRole,
	VerificationScope,
	VerificationValidityV1,
} from "./types";

export type VerificationReuseReason =
	| "reusable"
	| "missing_validity"
	| "invalidated"
	| "failed_result"
	| "executor_not_trusted"
	| "owner_not_delivery"
	| "code_state_mismatch"
	| "commands_mismatch"
	| "scope_mismatch";

export interface VerificationReuseDecision {
	reusable: boolean;
	reason: VerificationReuseReason;
}

export interface SealVerificationValidityInput {
	executor: VerificationExecutor;
	owner: VerificationOwnerRole;
	commands: readonly string[];
	scope?: VerificationScope;
	codeState: VerificationCodeState;
	/** Override default invalidation trigger set. */
	invalidatedBy?: readonly VerificationInvalidationTrigger[];
}

const EMPTY_TREE_PATCH_SHA = sha256Hex("");

const DEFAULT_INVALIDATED_BY: readonly VerificationInvalidationTrigger[] = [
	"implementation_changed",
	"commands_changed",
	"scope_changed",
	"repair_applied",
	"owner_transfer",
	"explicit",
];

const EXECUTORS: Record<VerificationExecutor, true> = {
	workflow_verifier: true,
	worker: true,
	parent: true,
};

const OWNERS: Record<VerificationOwnerRole, true> = {
	workflow_verifier: true,
	worker: true,
	parent: true,
};

const TRIGGERS: Record<VerificationInvalidationTrigger, true> = {
	implementation_changed: true,
	commands_changed: true,
	scope_changed: true,
	repair_applied: true,
	owner_transfer: true,
	explicit: true,
};

function isExecutor(value: unknown): value is VerificationExecutor {
	return typeof value === "string" && EXECUTORS[value as VerificationExecutor] === true;
}

function isOwner(value: unknown): value is VerificationOwnerRole {
	return typeof value === "string" && OWNERS[value as VerificationOwnerRole] === true;
}

function isTrigger(value: unknown): value is VerificationInvalidationTrigger {
	return typeof value === "string" && TRIGGERS[value as VerificationInvalidationTrigger] === true;
}

function normalizeCommands(commands: readonly string[]): string[] {
	return [...commands].map(c => c.trim()).filter(Boolean);
}

function commandsEqual(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

function normalizePaths(paths: readonly string[] | undefined): string[] {
	if (!paths || paths.length === 0) return [];
	return [...new Set(paths.map(p => p.replaceAll("\\", "/").trim()).filter(Boolean))].sort();
}

function normalizeScope(scope: VerificationScope | undefined, pathsFromCode: string[]): VerificationScope {
	const kind = scope?.kind ?? (pathsFromCode.length > 0 ? "paths" : "commands");
	if (kind === "paths") {
		const paths = normalizePaths(scope?.paths ?? pathsFromCode);
		return paths.length ? { kind: "paths", paths } : { kind: "commands" };
	}
	if (kind === "repo") return { kind: "repo" };
	return { kind: "commands" };
}

function scopesEqual(left: VerificationScope, right: VerificationScope): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind !== "paths") return true;
	return commandsEqual(left.paths ?? [], right.paths ?? []);
}

function codeStatesEqual(left: VerificationCodeState, right: VerificationCodeState): boolean {
	return left.fingerprint === right.fingerprint;
}

/** Build the code-state identity under test from implementation + patch bytes. */
export function buildVerificationCodeState(input: {
	implementation?: Pick<ImplementationArtifactV1, "attemptId" | "changedFiles" | "patchPath"> | null;
	patchContent?: string;
	changedFiles?: readonly string[];
}): VerificationCodeState {
	const changedFiles = normalizePaths(input.changedFiles ?? input.implementation?.changedFiles ?? []);
	const patchSha256 =
		input.patchContent !== undefined ? sha256Hex(input.patchContent) : EMPTY_TREE_PATCH_SHA;
	const implementationAttemptId = input.implementation?.attemptId?.trim() || undefined;
	const fingerprint = sha256Hex(
		JSON.stringify({
			patchSha256,
			changedFiles,
			implementationAttemptId: implementationAttemptId ?? null,
			patchPath: input.implementation?.patchPath ?? null,
		}),
	);
	const state: VerificationCodeState = {
		patchSha256,
		changedFiles,
		fingerprint,
	};
	if (implementationAttemptId) state.implementationAttemptId = implementationAttemptId;
	return state;
}

/** Parse / normalize a validity block; returns null when shape is wrong. */
export function parseVerificationValidity(value: unknown): VerificationValidityV1 | null {
	if (!isRecord(value)) return null;
	if (value.schemaVersion !== 1 || value.kind !== "verification_validity") return null;
	if (!isExecutor(value.executor) || !isOwner(value.owner)) return null;
	if (!Array.isArray(value.commands)) return null;
	const commands = normalizeCommands(value.commands.filter((c): c is string => typeof c === "string"));
	if (!isRecord(value.codeState)) return null;
	const patchSha256 = typeof value.codeState.patchSha256 === "string" ? value.codeState.patchSha256.trim() : "";
	const fingerprint = typeof value.codeState.fingerprint === "string" ? value.codeState.fingerprint.trim() : "";
	if (!patchSha256 || !fingerprint) return null;
	const changedFiles = Array.isArray(value.codeState.changedFiles)
		? normalizePaths(value.codeState.changedFiles.filter((p): p is string => typeof p === "string"))
		: [];
	const codeState: VerificationCodeState = { patchSha256, changedFiles, fingerprint };
	if (
		typeof value.codeState.implementationAttemptId === "string" &&
		value.codeState.implementationAttemptId.trim()
	) {
		codeState.implementationAttemptId = value.codeState.implementationAttemptId.trim();
	}
	if (!isRecord(value.scope)) return null;
	const scopeKind =
		value.scope.kind === "commands" || value.scope.kind === "paths" || value.scope.kind === "repo"
			? value.scope.kind
			: null;
	if (!scopeKind) return null;
	const scope = normalizeScope(
		{
			kind: scopeKind,
			paths: Array.isArray(value.scope.paths)
				? value.scope.paths.filter((p): p is string => typeof p === "string")
				: undefined,
		},
		changedFiles,
	);
	const invalidatedBy = Array.isArray(value.invalidatedBy)
		? value.invalidatedBy.filter(isTrigger)
		: [...DEFAULT_INVALIDATED_BY];
	const validity: VerificationValidityV1 = {
		schemaVersion: 1,
		kind: "verification_validity",
		executor: value.executor,
		owner: value.owner,
		commands,
		scope,
		codeState,
		invalidatedBy: invalidatedBy.length ? invalidatedBy : [...DEFAULT_INVALIDATED_BY],
	};
	if (value.invalid === true) {
		validity.invalid = true;
		if (typeof value.invalidReason === "string" && value.invalidReason.trim()) {
			validity.invalidReason = value.invalidReason.trim();
		}
		if (typeof value.invalidatedAt === "string" && value.invalidatedAt.trim()) {
			validity.invalidatedAt = value.invalidatedAt.trim();
		}
	}
	return validity;
}

/** Attach / replace validity metadata on a verification artifact. */
export function sealVerificationValidity(
	artifact: VerificationArtifactV1,
	input: SealVerificationValidityInput,
): VerificationArtifactV1 {
	const commands = normalizeCommands(input.commands);
	const codeState = input.codeState;
	const scope = normalizeScope(input.scope, codeState.changedFiles);
	const validity: VerificationValidityV1 = {
		schemaVersion: 1,
		kind: "verification_validity",
		executor: input.executor,
		owner: input.owner,
		commands,
		scope,
		codeState,
		invalidatedBy: input.invalidatedBy ? [...input.invalidatedBy] : [...DEFAULT_INVALIDATED_BY],
	};
	return { ...artifact, validity };
}

/** Mark a sealed result invalid (stale). Missing validity is a no-op identity return. */
export function invalidateVerificationResult(
	artifact: VerificationArtifactV1,
	reason: string,
	trigger: VerificationInvalidationTrigger = "explicit",
): VerificationArtifactV1 {
	const prior = parseVerificationValidity(artifact.validity);
	if (!prior) return artifact;
	const invalidatedBy = prior.invalidatedBy.includes(trigger)
		? prior.invalidatedBy
		: [...prior.invalidatedBy, trigger];
	return {
		...artifact,
		validity: {
			...prior,
			invalidatedBy,
			invalid: true,
			invalidReason: reason.trim() || trigger,
			invalidatedAt: new Date().toISOString(),
		},
	};
}

/**
 * Delivery evidence requires a sealed, non-invalid, passed result whose owner
 * and executor are workflow_verifier or parent — never worker alone.
 */
export function isValidDeliveryEvidence(artifact: VerificationArtifactV1 | null | undefined): boolean {
	if (!artifact || artifact.passed !== true) return false;
	const validity = parseVerificationValidity(artifact.validity);
	if (!validity || validity.invalid === true) return false;
	if (validity.owner === "worker" || validity.executor === "worker") return false;
	if (validity.owner !== "workflow_verifier" && validity.owner !== "parent") return false;
	if (validity.executor !== "workflow_verifier" && validity.executor !== "parent") return false;
	return Boolean(validity.codeState.fingerprint);
}

/**
 * Decide whether prior command checks can be reused instead of re-running.
 * Failed, worker-owned, invalidated, or code/command/scope-mismatched results
 * are never reusable.
 */
export function assessVerificationReuse(input: {
	prior: VerificationArtifactV1 | null | undefined;
	codeState: VerificationCodeState;
	commands: readonly string[];
	scope?: VerificationScope;
}): VerificationReuseDecision {
	const prior = input.prior;
	if (!prior) return { reusable: false, reason: "missing_validity" };
	const validity = parseVerificationValidity(prior.validity);
	if (!validity) return { reusable: false, reason: "missing_validity" };
	if (validity.invalid === true) return { reusable: false, reason: "invalidated" };
	if (prior.passed !== true) return { reusable: false, reason: "failed_result" };
	if (validity.owner === "worker") return { reusable: false, reason: "owner_not_delivery" };
	if (validity.executor !== "workflow_verifier" && validity.executor !== "parent") {
		return { reusable: false, reason: "executor_not_trusted" };
	}
	if (!codeStatesEqual(validity.codeState, input.codeState)) {
		return { reusable: false, reason: "code_state_mismatch" };
	}
	if (!commandsEqual(validity.commands, normalizeCommands(input.commands))) {
		return { reusable: false, reason: "commands_mismatch" };
	}
	const desiredScope = normalizeScope(input.scope, input.codeState.changedFiles);
	if (!scopesEqual(validity.scope, desiredScope)) {
		return { reusable: false, reason: "scope_mismatch" };
	}
	return { reusable: true, reason: "reusable" };
}

/**
 * When reuse is allowed, project prior command checks into a new artifact shell
 * for the current attempt/stage. Caller still applies stage-specific gates.
 */
export function projectReusedVerificationChecks(
	prior: VerificationArtifactV1,
	shell: Pick<VerificationArtifactV1, "workflowId" | "attemptId" | "stage"> &
		Partial<Pick<VerificationArtifactV1, "modelProfileId" | "provider" | "model" | "promptVersion">>,
): VerificationArtifactV1 {
	const validity = parseVerificationValidity(prior.validity);
	const projected: VerificationArtifactV1 = {
		kind: "verification",
		passed: prior.checks.every(check => check.status !== "failed"),
		checks: prior.checks.map(check => ({ ...check })),
		schemaVersion: 1,
		workflowId: shell.workflowId,
		attemptId: shell.attemptId,
		stage: shell.stage,
		createdAt: new Date().toISOString(),
		modelProfileId: shell.modelProfileId ?? prior.modelProfileId,
		provider: shell.provider ?? prior.provider,
		model: shell.model ?? prior.model,
		promptVersion: shell.promptVersion ?? prior.promptVersion,
	};
	if (validity) {
		return sealVerificationValidity(projected, {
			executor: validity.executor,
			owner: validity.owner,
			commands: validity.commands,
			scope: validity.scope,
			codeState: validity.codeState,
			invalidatedBy: validity.invalidatedBy,
		});
	}
	return projected;
}

/** Default seal for engine-owned workflow verifier stages. */
export function sealWorkflowVerifierResult(
	artifact: VerificationArtifactV1,
	input: {
		commands: readonly string[];
		codeState: VerificationCodeState;
		scope?: VerificationScope;
	},
): VerificationArtifactV1 {
	return sealVerificationValidity(artifact, {
		executor: "workflow_verifier",
		owner: "workflow_verifier",
		commands: input.commands,
		scope: input.scope,
		codeState: input.codeState,
	});
}
