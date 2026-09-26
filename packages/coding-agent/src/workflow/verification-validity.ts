/**
 * Verification ownership and result validity (P1-2), plus P1-4 full-repo
 * verification spawn ownership assessment.
 *
 * Makes worker / parent / workflow_verifier responsibilities explicit on the
 * existing VerificationArtifactV1 path. Records command+scope, code state,
 * executor identity, and the verifier's executed workspace so stale greens
 * cannot be reused as delivery evidence and identical still-valid command
 * sets need not re-run.
 *
 * Not a new verification platform and not a generic anti-loop agent.
 * Workspace identity reuses the native VCS snapshot; it does not spawn git.
 */

import type { VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assessVerificationSpawn, type VerificationSpawnAssessment } from "../latency/parallel-recovery-safety";
import { parsePatchTouchedFiles } from "../utils/parse-patch-touched-files";
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
	VerificationWorkspaceBinding,
	VerifierPort,
} from "./types";

export type { VerificationSpawnAssessment };

/**
 * P1-4: forbid unowned duplicate full-repo verify; keep explicitly assigned local/scoped verify.
 */
export function assessVerificationOwnership(input: {
	scope: "repo" | "paths" | "commands" | "local";
	owner?: string | null;
	explicitlyAssigned: boolean;
	duplicateOfActive?: boolean;
}): VerificationSpawnAssessment {
	return assessVerificationSpawn(input);
}

export type VerificationReuseReason =
	| "reusable"
	| "missing_validity"
	| "invalidated"
	| "failed_result"
	| "no_passed_checks"
	| "executor_not_trusted"
	| "owner_not_delivery"
	| "code_state_mismatch"
	| "workspace_unproven"
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
	/**
	 * P1-4: when sealing a full-repo verification that would duplicate an active
	 * unowned repo verify, fail closed. Local/scoped seals are unaffected.
	 */
	duplicateOfActive?: boolean;
	/** When false, a repo-scope seal is treated as not explicitly assigned. */
	explicitlyAssigned?: boolean;
}

/**
 * Fail closed when a verification spawn/seal violates P1-4 ownership rules.
 * Local and explicitly assigned scoped verifies remain allowed.
 */
export function assertVerificationSpawnAllowed(input: {
	scope: "repo" | "paths" | "commands" | "local";
	owner?: string | null;
	explicitlyAssigned: boolean;
	duplicateOfActive?: boolean;
}): VerificationSpawnAssessment {
	const assessment = assessVerificationOwnership(input);
	if (!assessment.allow) {
		throw new Error(assessment.detail);
	}
	return assessment;
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
	const kind = scope?.kind ?? (pathsFromCode.length > 0 ? "paths" : "repo");
	if (kind === "paths") {
		const paths = normalizePaths(scope?.paths ?? pathsFromCode);
		// Empty path lists are full-repo verification, not a commands-only loophole.
		return paths.length ? { kind: "paths", paths } : { kind: "repo" };
	}
	if (kind === "repo") return { kind: "repo" };
	// Explicit commands scope with no changed files is still full-repo for ownership.
	if (kind === "commands" && pathsFromCode.length === 0) return { kind: "repo" };
	return { kind: "commands" };
}

function scopesEqual(left: VerificationScope, right: VerificationScope): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind !== "paths") return true;
	return commandsEqual(left.paths ?? [], right.paths ?? []);
}

function workspacesEqual(
	left: VerificationWorkspaceBinding | undefined,
	right: VerificationWorkspaceBinding | undefined,
): boolean {
	if (!left || !right) return false;
	return (
		left.cwd === right.cwd &&
		left.vcs === right.vcs &&
		left.root === right.root &&
		left.headId === right.headId &&
		left.contentSha256 === right.contentSha256
	);
}

function codeStatesEqual(left: VerificationCodeState, right: VerificationCodeState): boolean {
	// Compare concrete fields — never trust fingerprint alone (could be copied forward).
	if (left.patchSha256 !== right.patchSha256) return false;
	if ((left.implementationAttemptId ?? null) !== (right.implementationAttemptId ?? null)) return false;
	if (!commandsEqual(left.changedFiles, right.changedFiles)) return false;
	if (!workspacesEqual(left.workspace, right.workspace)) return false;
	if (left.fingerprint !== right.fingerprint) return false;
	// Recompute fingerprint from sealed fields; mismatch means tampered / inconsistent seal.
	const recomputed = fingerprintCodeState(
		left.patchSha256,
		left.changedFiles,
		left.implementationAttemptId,
		left.workspace,
	);
	return left.fingerprint === recomputed && right.fingerprint === recomputed;
}

function codeStateIsConsistent(state: VerificationCodeState): boolean {
	return (
		state.fingerprint ===
		fingerprintCodeState(state.patchSha256, state.changedFiles, state.implementationAttemptId, state.workspace)
	);
}

function fingerprintCodeState(
	patchSha256: string,
	changedFiles: readonly string[],
	implementationAttemptId: string | undefined,
	workspace?: VerificationWorkspaceBinding,
): string {
	// Omit workspace when unproven so legacy patch-only seals stay consistent.
	// A proven binding is part of the fingerprint, so copying an old hash over a
	// new tree does not validate.
	const payload: {
		patchSha256: string;
		changedFiles: readonly string[];
		implementationAttemptId: string | null;
		workspace?: VerificationWorkspaceBinding;
	} = {
		patchSha256,
		changedFiles,
		implementationAttemptId: implementationAttemptId ?? null,
	};
	if (workspace) {
		payload.workspace = {
			cwd: workspace.cwd,
			vcs: workspace.vcs,
			root: workspace.root,
			headId: workspace.headId,
			contentSha256: workspace.contentSha256,
		};
	}
	return sha256Hex(JSON.stringify(payload));
}

function abortCapture(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("verification workspace capture aborted");
}

function diffOmitsCompleteIdentity(diff: string): boolean {
	for (const line of diff.split("\n")) {
		if (line.startsWith("Binary files ") && line.endsWith(" differ")) return true;
		if (line.startsWith("Subproject commit ")) return true;
		if (
			line === "new file mode 160000" ||
			line === "deleted file mode 160000" ||
			line === "old mode 160000" ||
			line === "new mode 160000"
		) {
			return true;
		}
		if (/^index [0-9a-f.]+\.\.[0-9a-f.]+ 160000$/.test(line)) return true;
	}
	return false;
}

async function hashFileIdentity(root: string, rel: string): Promise<{ path: string; sha256: string } | null> {
	if (!rel || path.isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) return null;
	const abs = path.join(root, rel);
	let listed: Stats;
	try {
		listed = await fs.lstat(abs);
	} catch {
		return null;
	}
	if (listed.isSymbolicLink()) {
		let target: string;
		try {
			target = await fs.readlink(abs);
		} catch {
			return null;
		}
		let followed = "dangling";
		try {
			const bytes = new Uint8Array(await Bun.file(abs).arrayBuffer());
			followed = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		} catch (err) {
			if (!isEnoent(err)) return null;
		}
		return {
			path: rel.replaceAll("\\", "/"),
			sha256: sha256Hex(JSON.stringify({ link: target, followed })),
		};
	}
	if (!listed.isFile()) return null;
	try {
		const bytes = new Uint8Array(await Bun.file(abs).arrayBuffer());
		return {
			path: rel.replaceAll("\\", "/"),
			sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
		};
	} catch {
		return null;
	}
}

async function hashUntrackedContent(
	root: string,
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<string | null> {
	const entries: Array<{ path: string; sha256: string }> = [];
	for (const rel of [...paths].sort()) {
		abortCapture(signal);
		const identity = await hashFileIdentity(root, rel);
		if (!identity) return null;
		entries.push(identity);
	}
	return sha256Hex(JSON.stringify(entries));
}

async function hashTrackedSymlinks(
	root: string,
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<string | null> {
	const entries: Array<{ path: string; sha256: string }> = [];
	for (const rel of [...paths].sort()) {
		abortCapture(signal);
		if (!rel || path.isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) return null;
		let listed: Stats;
		try {
			listed = await fs.lstat(path.join(root, rel));
		} catch (err) {
			if (isEnoent(err)) continue;
			return null;
		}
		if (!listed.isSymbolicLink()) continue;
		const identity = await hashFileIdentity(root, rel);
		if (!identity) return null;
		entries.push(identity);
	}
	return sha256Hex(JSON.stringify(entries));
}

/**
 * Execution directory exposed by the verifier. Absent means the executed tree
 * is unproven — do not substitute a caller cwd.
 */
export function verificationExecutionCwd(verifier: Pick<VerifierPort, "workspaceCwd">): string | undefined {
	const fromVerifier = verifier.workspaceCwd?.();
	if (typeof fromVerifier !== "string") return undefined;
	const trimmed = fromVerifier.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Proven identity of the tree commands will run against.
 * Returns null when cwd, HEAD, index, dirty content, symlink targets, or
 * submodule state cannot be read completely. Null is not an empty tree.
 */
export async function captureVerificationWorkspace(
	cwd: string,
	signal?: AbortSignal,
): Promise<VerificationWorkspaceBinding | null> {
	abortCapture(signal);
	let resolved: string;
	try {
		resolved = await fs.realpath(cwd);
	} catch {
		return null;
	}
	let repository: VcsRepo | null;
	try {
		repository = vcs.repo(resolved);
	} catch {
		return null;
	}
	if (!repository) return null;
	let root: string;
	try {
		root = await fs.realpath(repository.root());
	} catch {
		return null;
	}
	const git = repository.asGit();
	if (git) {
		try {
			const submodules = await git.submodulePaths(signal);
			if (submodules.length > 0) return null;
		} catch (err) {
			if (signal?.aborted) throw err;
			return null;
		}
	}
	let headId: string | undefined | null;
	let worktreeDiff: string;
	let stagedDiff: string | null;
	let untracked: string[];
	let tracked: string[];
	try {
		headId = await repository.headId(signal);
		if (repository.supports("stagedDiff")) {
			worktreeDiff = await repository.diffText({ binary: true }, signal);
			stagedDiff = await repository.diffText({ cached: true, binary: true }, signal);
		} else {
			worktreeDiff = await repository.diffText({}, signal);
			stagedDiff = null;
		}
		untracked = await repository.lsFiles(true, true, signal);
		tracked = await repository.lsFiles(false, false, signal);
	} catch (err) {
		if (signal?.aborted) throw err;
		return null;
	}
	const provenHead = headId?.trim();
	if (!provenHead) return null;
	if (diffOmitsCompleteIdentity(worktreeDiff)) return null;
	if (stagedDiff !== null && diffOmitsCompleteIdentity(stagedDiff)) return null;
	const untrackedSha256 = await hashUntrackedContent(root, untracked, signal);
	if (!untrackedSha256) return null;
	const symlinkSha256 = await hashTrackedSymlinks(root, tracked, signal);
	if (!symlinkSha256) return null;
	return {
		cwd: resolved,
		vcs: repository.kind(),
		root,
		headId: provenHead,
		contentSha256: sha256Hex(
			JSON.stringify({
				headId: provenHead,
				worktreeDiffSha256: sha256Hex(worktreeDiff),
				stagedDiffSha256: stagedDiff === null ? null : sha256Hex(stagedDiff),
				untrackedSha256,
				symlinkSha256,
			}),
		),
	};
}

/**
 * Shared patch evidence for both implementation_verify and final_verify.
 * Every declared patch path is hashed. A missing path errors — it is not
 * skipped, and must not become an empty-tree seal or a reusable green.
 * Model-reported changedFiles are not validity evidence. No declared path
 * returns no content; that is not a hash of a missing file.
 */
export async function resolveVerificationPatchEvidence(
	implementation: Pick<ImplementationArtifactV1, "patchPath" | "unresolved"> | null | undefined,
	cwd: string,
): Promise<{ patchContent?: string; changedFiles: string[] }> {
	if (!implementation) return { changedFiles: [] };
	const patchPaths = [
		implementation.patchPath,
		...(implementation.unresolved ?? [])
			.filter(u => u.startsWith("priorPatch:"))
			.map(u => u.slice("priorPatch:".length)),
	].filter((p): p is string => Boolean(p));
	if (patchPaths.length === 0) return { changedFiles: [] };

	const chunks: string[] = [];
	const changedFiles: string[] = [];
	for (const patchPath of patchPaths) {
		const resolved = path.isAbsolute(patchPath) ? patchPath : path.join(cwd, patchPath);
		let text: string;
		try {
			text = await Bun.file(resolved).text();
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(`verification patch evidence missing: ${patchPath}`, { cause: err });
			}
			throw err;
		}
		chunks.push(text);
		for (const file of parsePatchTouchedFiles(text)) {
			if (!changedFiles.includes(file)) changedFiles.push(file);
		}
	}
	return {
		patchContent: chunks.join("\n"),
		changedFiles,
	};
}

/** Build the code-state identity under test from patch bytes plus a proven workspace. */
export function buildVerificationCodeState(input: {
	implementation?: Pick<ImplementationArtifactV1, "attemptId"> | null;
	patchContent?: string;
	changedFiles?: readonly string[];
	/** Omit when the execution tree could not be proven. That seal is not reusable. */
	workspace?: VerificationWorkspaceBinding;
}): VerificationCodeState {
	const changedFiles = normalizePaths(input.changedFiles ?? []);
	const patchSha256 = input.patchContent !== undefined ? sha256Hex(input.patchContent) : EMPTY_TREE_PATCH_SHA;
	const implementationAttemptId = input.implementation?.attemptId?.trim() || undefined;
	const fingerprint = fingerprintCodeState(patchSha256, changedFiles, implementationAttemptId, input.workspace);
	const state: VerificationCodeState = {
		patchSha256,
		changedFiles,
		fingerprint,
	};
	if (implementationAttemptId) state.implementationAttemptId = implementationAttemptId;
	if (input.workspace) state.workspace = input.workspace;
	return state;
}

/**
 * undefined: legacy seal, no proof. null: a workspace key was present but not proven.
 */
function parseWorkspaceBinding(value: unknown): VerificationWorkspaceBinding | undefined | null {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return null;
	const cwd = typeof value.cwd === "string" ? value.cwd.trim() : "";
	const vcsKind = typeof value.vcs === "string" ? value.vcs.trim() : "";
	const root = typeof value.root === "string" ? value.root.trim() : "";
	const headId = typeof value.headId === "string" ? value.headId.trim() : "";
	const contentSha256 = typeof value.contentSha256 === "string" ? value.contentSha256.trim() : "";
	if (!cwd || !vcsKind || !root || !headId || !contentSha256) return null;
	return { cwd, vcs: vcsKind, root, headId, contentSha256 };
}

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
	const workspace = parseWorkspaceBinding(value.codeState.workspace);
	if (workspace === null) return null;
	const codeState: VerificationCodeState = { patchSha256, changedFiles, fingerprint };
	if (workspace) codeState.workspace = workspace;
	if (typeof value.codeState.implementationAttemptId === "string" && value.codeState.implementationAttemptId.trim()) {
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
	// P1-4: full-repo (including empty-path / commands remapped to repo) must pass ownership.
	if (scope.kind === "repo") {
		assertVerificationSpawnAllowed({
			scope: "repo",
			owner: input.owner,
			explicitlyAssigned: input.explicitlyAssigned !== false,
			duplicateOfActive: input.duplicateOfActive,
		});
	}
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
 * Skipped-only / empty checklists are never delivery greens (Package 3
 * parent-owns-verify checklists must not false-accept).
 */
export function isValidDeliveryEvidence(artifact: VerificationArtifactV1 | null | undefined): boolean {
	if (!artifact || artifact.passed !== true) return false;
	if (artifact.checks.some(check => check.status === "failed")) return false;
	// At least one executed check must have passed — all-skipped is checklist-only.
	if (!artifact.checks.some(check => check.status === "passed")) return false;
	const validity = parseVerificationValidity(artifact.validity);
	if (!validity || validity.invalid === true) return false;
	if (validity.owner === "worker" || validity.executor === "worker") return false;
	if (validity.owner !== "workflow_verifier" && validity.owner !== "parent") return false;
	if (validity.executor !== "workflow_verifier" && validity.executor !== "parent") return false;
	// A copied fingerprint over rewritten patch identity is not a seal.
	if (!codeStateIsConsistent(validity.codeState)) return false;
	return true;
}

/**
 * Decide whether prior command checks can be reused instead of re-running.
 * Failed, worker-owned, invalidated, unproven-workspace, or
 * code/command/scope-mismatched results are never reusable.
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
	if (prior.passed !== true || prior.checks.some(check => check.status === "failed")) {
		return { reusable: false, reason: "failed_result" };
	}
	// Skipped-only checklists (parent-owns-verify) must not suppress re-runs.
	if (!prior.checks.some(check => check.status === "passed")) {
		return { reusable: false, reason: "no_passed_checks" };
	}
	if (validity.owner === "worker") return { reusable: false, reason: "owner_not_delivery" };
	if (validity.executor !== "workflow_verifier" && validity.executor !== "parent") {
		return { reusable: false, reason: "executor_not_trusted" };
	}
	if (!validity.codeState.workspace || !input.codeState.workspace) {
		return { reusable: false, reason: "workspace_unproven" };
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
