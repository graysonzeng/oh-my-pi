/**
 * Runtime build identity for delivery receipts (Batch 1 W0).
 *
 * Distinguishes "code exists at SHA X" from "this process is running that
 * build". Reuses VERSION / isCompiledBinary / VCS owners — not a second
 * provenance platform. Missing fields stay unknown/unverified; never invent a
 * source SHA from the package version alone.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isCompiledBinary, VERSION } from "@oh-my-pi/pi-utils";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { createHash } from "node:crypto";
import { fingerprintStable } from "./stable-serialize";

function sha256Bytes(bytes: ArrayBuffer | Uint8Array): string {
	return createHash("sha256")
		.update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes)
		.digest("hex");
}

/** `custom` entry type — never enters model context. */
export const RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE = "runtime_build_identity";

export const RUNTIME_BUILD_IDENTITY_VERSION = 1 as const;

export type RuntimeRunMode = "source" | "binary";

export type RuntimeIdentityVerification = "resolved" | "partial" | "unverified";

export interface RuntimeBuildIdentityV1 {
	kind: typeof RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE;
	v: typeof RUNTIME_BUILD_IDENTITY_VERSION;
	/** Package VERSION string (not a commit proof). */
	packageVersion: string;
	runMode: RuntimeRunMode;
	/** Source commit SHA when observed from the checkout; null when unknown. */
	sourceSha: string | null;
	/**
	 * Fingerprint of dirty tree state when dirty; null when clean or unknown.
	 * Presence means dirty — never treat null as "clean" without dirty===false.
	 */
	dirtyFingerprint: string | null;
	/** Explicit dirty flag when observed; null when VCS unavailable. */
	dirty: boolean | null;
	/** SHA-256 of the running binary when runMode is binary and hashable; else null. */
	binarySha256: string | null;
	/** Config / tool / schema fingerprints when supplied by the caller. */
	configFingerprint: string | null;
	toolFingerprint: string | null;
	schemaFingerprint: string | null;
	/** Actual model/provider/api when known at record time. */
	model: string | null;
	provider: string | null;
	api: string | null;
	verification: RuntimeIdentityVerification;
	recordedAtMs: number;
}

export interface ResolveRuntimeBuildIdentityInput {
	cwd?: string;
	configFingerprint?: string | null;
	toolFingerprint?: string | null;
	schemaFingerprint?: string | null;
	model?: string | null;
	provider?: string | null;
	api?: string | null;
	/** Optional precomputed binary hash (caller may hash process.execPath). */
	binarySha256?: string | null;
	/** Test/injection override for run mode. */
	runMode?: RuntimeRunMode;
	/** Test/injection override for source SHA. */
	sourceSha?: string | null;
	dirty?: boolean | null;
	dirtyFingerprint?: string | null;
	recordedAtMs?: number;
}

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function verificationOf(identity: Omit<RuntimeBuildIdentityV1, "verification">): RuntimeIdentityVerification {
	if (identity.sourceSha && identity.dirty !== null) {
		if (identity.runMode === "binary" && !identity.binarySha256) return "partial";
		return "resolved";
	}
	if (identity.sourceSha || identity.binarySha256) return "partial";
	return "unverified";
}

/**
 * Resolve the running process's build identity from local sources.
 * Fail-open: VCS/binary errors leave fields null rather than throwing.
 */
export async function resolveRuntimeBuildIdentity(
	input: ResolveRuntimeBuildIdentityInput = {},
): Promise<RuntimeBuildIdentityV1> {
	const runMode: RuntimeRunMode = input.runMode ?? (isCompiledBinary() ? "binary" : "source");
	let sourceSha = input.sourceSha !== undefined ? nonEmpty(input.sourceSha) : null;
	let dirty: boolean | null = input.dirty !== undefined ? input.dirty : null;
	let dirtyFingerprint = input.dirtyFingerprint !== undefined ? nonEmpty(input.dirtyFingerprint) : null;

	if (input.sourceSha === undefined || input.dirty === undefined) {
		const cwd = input.cwd ?? process.cwd();
		try {
			const repo = vcs.repo(cwd);
			if (repo) {
				if (input.sourceSha === undefined) {
					const headId = await repo.headId();
					sourceSha = nonEmpty(headId ?? undefined);
				}
				if (input.dirty === undefined) {
					try {
						const git = repo.asGit();
						if (git) {
							dirty = await git.isDirty();
						} else {
							const summary = await repo.statusSummary();
							dirty = summary.staged + summary.unstaged + summary.untracked > 0;
						}
						if (dirty === true && input.dirtyFingerprint === undefined) {
							dirtyFingerprint = fingerprintStable({
								head: sourceSha,
								dirty: true,
							});
						} else if (dirty === false) {
							dirtyFingerprint = null;
						}
					} catch {
						dirty = null;
					}
				}
			}
		} catch {
			// VCS unavailable — leave source fields null.
		}
	}

	let binarySha256 = input.binarySha256 !== undefined ? nonEmpty(input.binarySha256) : null;
	if (binarySha256 === null && runMode === "binary" && input.binarySha256 === undefined) {
		try {
			binarySha256 = sha256Bytes(await Bun.file(process.execPath).arrayBuffer());
		} catch {
			binarySha256 = null;
		}
	}

	const base: Omit<RuntimeBuildIdentityV1, "verification"> = {
		kind: RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE,
		v: RUNTIME_BUILD_IDENTITY_VERSION,
		packageVersion: VERSION,
		runMode,
		sourceSha,
		dirtyFingerprint,
		dirty,
		binarySha256,
		configFingerprint: nonEmpty(input.configFingerprint ?? null),
		toolFingerprint: nonEmpty(input.toolFingerprint ?? null),
		schemaFingerprint: nonEmpty(input.schemaFingerprint ?? null),
		model: nonEmpty(input.model ?? null),
		provider: nonEmpty(input.provider ?? null),
		api: nonEmpty(input.api ?? null),
		recordedAtMs: input.recordedAtMs ?? Date.now(),
	};
	return { ...base, verification: verificationOf(base) };
}

/** Synchronous builder for fixtures / tests (no VCS I/O). */
export function buildRuntimeBuildIdentity(
	input: ResolveRuntimeBuildIdentityInput & { packageVersion?: string },
): RuntimeBuildIdentityV1 {
	const runMode: RuntimeRunMode = input.runMode ?? (isCompiledBinary() ? "binary" : "source");
	const base: Omit<RuntimeBuildIdentityV1, "verification"> = {
		kind: RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE,
		v: RUNTIME_BUILD_IDENTITY_VERSION,
		packageVersion: input.packageVersion ?? VERSION,
		runMode,
		sourceSha: input.sourceSha !== undefined ? nonEmpty(input.sourceSha) : null,
		dirtyFingerprint: input.dirtyFingerprint !== undefined ? nonEmpty(input.dirtyFingerprint) : null,
		dirty: input.dirty !== undefined ? input.dirty : null,
		binarySha256: input.binarySha256 !== undefined ? nonEmpty(input.binarySha256) : null,
		configFingerprint: nonEmpty(input.configFingerprint ?? null),
		toolFingerprint: nonEmpty(input.toolFingerprint ?? null),
		schemaFingerprint: nonEmpty(input.schemaFingerprint ?? null),
		model: nonEmpty(input.model ?? null),
		provider: nonEmpty(input.provider ?? null),
		api: nonEmpty(input.api ?? null),
		recordedAtMs: input.recordedAtMs ?? Date.now(),
	};
	return { ...base, verification: verificationOf(base) };
}

export function parseRuntimeBuildIdentity(value: unknown): RuntimeBuildIdentityV1 | null {
	if (!isRecord(value)) return null;
	if (value.kind !== RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE || value.v !== RUNTIME_BUILD_IDENTITY_VERSION) {
		return null;
	}
	if (typeof value.packageVersion !== "string" || !value.packageVersion.trim()) return null;
	if (value.runMode !== "source" && value.runMode !== "binary") return null;
	if (value.verification !== "resolved" && value.verification !== "partial" && value.verification !== "unverified") {
		return null;
	}
	if (typeof value.recordedAtMs !== "number" || !Number.isFinite(value.recordedAtMs)) return null;
	return buildRuntimeBuildIdentity({
		packageVersion: value.packageVersion,
		runMode: value.runMode,
		sourceSha: typeof value.sourceSha === "string" ? value.sourceSha : null,
		dirtyFingerprint: typeof value.dirtyFingerprint === "string" ? value.dirtyFingerprint : null,
		dirty: typeof value.dirty === "boolean" ? value.dirty : null,
		binarySha256: typeof value.binarySha256 === "string" ? value.binarySha256 : null,
		configFingerprint: typeof value.configFingerprint === "string" ? value.configFingerprint : null,
		toolFingerprint: typeof value.toolFingerprint === "string" ? value.toolFingerprint : null,
		schemaFingerprint: typeof value.schemaFingerprint === "string" ? value.schemaFingerprint : null,
		model: typeof value.model === "string" ? value.model : null,
		provider: typeof value.provider === "string" ? value.provider : null,
		api: typeof value.api === "string" ? value.api : null,
		recordedAtMs: value.recordedAtMs,
	});
}

/** Compact ref stored on acceptance receipts (avoids duplicating full identity). */
export function runtimeBuildIdentityRef(identity: RuntimeBuildIdentityV1): string {
	return fingerprintStable({
		v: identity.v,
		packageVersion: identity.packageVersion,
		runMode: identity.runMode,
		sourceSha: identity.sourceSha,
		dirty: identity.dirty,
		dirtyFingerprint: identity.dirtyFingerprint,
		binarySha256: identity.binarySha256,
		verification: identity.verification,
	});
}
