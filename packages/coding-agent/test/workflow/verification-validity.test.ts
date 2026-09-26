/**
 * P1-2: verification ownership + result validity contracts.
 *
 * Failure modes under test:
 * - worker green treated as delivery evidence
 * - stale/invalidated green reused after code change or repair
 * - missing validity coerced into reusable delivery
 * - same code+commands still re-executed when a sealed green exists
 * - command/scope mismatch silently reused
 */
import { isEnoent } from "@oh-my-pi/pi-utils";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VerificationArtifactV1 } from "../../src/workflow/types";
import {
	assessVerificationReuse,
	assertVerificationSpawnAllowed,
	buildVerificationCodeState,
	captureVerificationWorkspace,
	invalidateVerificationResult,
	isValidDeliveryEvidence,
	parseVerificationValidity,
	projectReusedVerificationChecks,
	resolveVerificationPatchEvidence,
	sealVerificationValidity,
	sealWorkflowVerifierResult,
} from "../../src/workflow/verification-validity";
import { VerificationArtifactSchema } from "../../src/workflow/schemas";

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr || stdout);
	return stdout.trimEnd();
}

async function initIsolatedRepo(root: string): Promise<void> {
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await Bun.write(path.join(root, "tracked.txt"), "one\ntwo\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-m", "initial");
}

function baseArtifact(overrides: Partial<VerificationArtifactV1> = {}): VerificationArtifactV1 {
	return {
		kind: "verification",
		passed: true,
		checks: [{ id: "command-1", command: "bun check", status: "passed", summary: "ok", exitCode: 0 }],
		schemaVersion: 1,
		workflowId: "wf1",
		attemptId: "att1",
		stage: "implementation_verify",
		createdAt: "2026-09-25T00:00:00.000Z",
		...overrides,
	};
}
describe("verification ownership & result validity", () => {
	const provenWorkspace = {
		cwd: "/repo",
		vcs: "git",
		root: "/repo",
		headId: "abc123",
		contentSha256: "a".repeat(64),
	};
	const codeState = buildVerificationCodeState({
		implementation: {
			attemptId: "impl-1",
		},
		patchContent: "diff --git a/src/a.ts b/src/a.ts\n+hi\n",
		changedFiles: ["src/a.ts"],
		workspace: provenWorkspace,
	});

	it("records command+scope, code state, executor, and invalidation triggers on seal", () => {
		const sealed = sealWorkflowVerifierResult(baseArtifact(), {
			commands: ["bun check", "git diff --check"],
			codeState,
			scope: { kind: "paths", paths: ["src/a.ts"] },
		});
		const validity = parseVerificationValidity(sealed.validity);
		expect(validity).not.toBeNull();
		expect(validity!.executor).toBe("workflow_verifier");
		expect(validity!.owner).toBe("workflow_verifier");
		expect(validity!.commands).toEqual(["bun check", "git diff --check"]);
		expect(validity!.scope).toEqual({ kind: "paths", paths: ["src/a.ts"] });
		expect(validity!.codeState.fingerprint).toBe(codeState.fingerprint);
		expect(validity!.codeState.patchSha256).toBe(codeState.patchSha256);
		expect(validity!.invalidatedBy).toContain("implementation_changed");
		expect(validity!.invalidatedBy).toContain("repair_applied");
		expect(VerificationArtifactSchema.parse(sealed).validity?.owner).toBe("workflow_verifier");
	});

	it("rejects worker-owned greens as delivery evidence even when passed", () => {
		const workerGreen = sealVerificationValidity(baseArtifact(), {
			executor: "worker",
			owner: "worker",
			commands: ["bun test packages/coding-agent/test/foo.test.ts"],
			codeState,
		});
		expect(workerGreen.passed).toBe(true);
		expect(isValidDeliveryEvidence(workerGreen)).toBe(false);

		const reuse = assessVerificationReuse({
			prior: workerGreen,
			codeState,
			commands: ["bun test packages/coding-agent/test/foo.test.ts"],
		});
		expect(reuse).toEqual({ reusable: false, reason: "owner_not_delivery" });
	});

	it("accepts workflow_verifier and parent sealed greens as delivery evidence", () => {
		const workflowGreen = sealWorkflowVerifierResult(baseArtifact(), {
			commands: ["bun check"],
			codeState,
		});
		expect(isValidDeliveryEvidence(workflowGreen)).toBe(true);

		const parentGreen = sealVerificationValidity(baseArtifact(), {
			executor: "parent",
			owner: "parent",
			commands: ["bun check"],
			codeState,
		});
		expect(isValidDeliveryEvidence(parentGreen)).toBe(true);
	});

	it("does not treat unsealed or invalidated greens as delivery evidence", () => {
		expect(isValidDeliveryEvidence(baseArtifact())).toBe(false);
		expect(isValidDeliveryEvidence(baseArtifact({ passed: false }))).toBe(false);

		const sealed = sealWorkflowVerifierResult(baseArtifact(), {
			commands: ["bun check"],
			codeState,
		});
		const stale = invalidateVerificationResult(sealed, "code edited after green", "implementation_changed");
		expect(stale.validity?.invalid).toBe(true);
		expect(stale.validity?.invalidReason).toBe("code edited after green");
		expect(isValidDeliveryEvidence(stale)).toBe(false);
		expect(assessVerificationReuse({ prior: stale, codeState, commands: ["bun check"] })).toEqual({
			reusable: false,
			reason: "invalidated",
		});
	});

	it("rejects skipped-only checklists as delivery evidence and reuse (parent-owns-verify)", () => {
		const checklist = sealWorkflowVerifierResult(
			baseArtifact({
				checks: [
					{
						id: "command-1",
						command: "bun check",
						status: "skipped",
						summary: "parent_owns_verify_checklist_only",
					},
					{
						id: "command-2",
						command: "bun test",
						status: "skipped",
						summary: "parent_owns_verify_checklist_only",
					},
				],
			}),
			{ commands: ["bun check", "bun test"], codeState },
		);
		expect(checklist.passed).toBe(true);
		expect(isValidDeliveryEvidence(checklist)).toBe(false);
		expect(
			assessVerificationReuse({
				prior: checklist,
				codeState,
				commands: ["bun check", "bun test"],
			}),
		).toEqual({ reusable: false, reason: "no_passed_checks" });
	});

	it("reuses sealed workflow greens only when code state, commands, and scope still match", () => {
		const sealed = sealWorkflowVerifierResult(baseArtifact(), {
			commands: ["bun check"],
			codeState,
			scope: { kind: "paths", paths: ["src/a.ts"] },
		});
		expect(
			assessVerificationReuse({
				prior: sealed,
				codeState,
				commands: ["bun check"],
				scope: { kind: "paths", paths: ["src/a.ts"] },
			}),
		).toEqual({ reusable: true, reason: "reusable" });

		const edited = buildVerificationCodeState({
			implementation: {
				attemptId: "impl-1",
			},
			patchContent: "diff --git a/src/a.ts b/src/a.ts\n+changed\n",
			changedFiles: ["src/a.ts"],
			workspace: provenWorkspace,
		});
		expect(
			assessVerificationReuse({
				prior: sealed,
				codeState: edited,
				commands: ["bun check"],
				scope: { kind: "paths", paths: ["src/a.ts"] },
			}).reason,
		).toBe("code_state_mismatch");

		expect(
			assessVerificationReuse({
				prior: sealed,
				codeState,
				commands: ["bun test"],
				scope: { kind: "paths", paths: ["src/a.ts"] },
			}).reason,
		).toBe("commands_mismatch");

		expect(
			assessVerificationReuse({
				prior: sealed,
				codeState,
				commands: ["bun check"],
				scope: { kind: "repo" },
			}).reason,
		).toBe("scope_mismatch");
	});

	it("projects reused checks into a new attempt shell without dropping the validity seal", () => {
		const sealed = sealWorkflowVerifierResult(
			baseArtifact({
				checks: [
					{ id: "command-1", command: "bun check", status: "passed", summary: "ok", exitCode: 0 },
					{ id: "secret-scan", status: "passed", summary: "clean" },
				],
			}),
			{ commands: ["bun check"], codeState },
		);
		const projected = projectReusedVerificationChecks(sealed, {
			workflowId: "wf1",
			attemptId: "att-final",
			stage: "final_verify",
		});
		expect(projected.attemptId).toBe("att-final");
		expect(projected.stage).toBe("final_verify");
		expect(projected.checks).toHaveLength(2);
		expect(projected.passed).toBe(true);
		expect(isValidDeliveryEvidence(projected)).toBe(true);
		expect(projected.validity?.codeState.fingerprint).toBe(codeState.fingerprint);
	});

	it("code-state fingerprints change when patch bytes change and stay stable for identical inputs", () => {
		const a = buildVerificationCodeState({
			implementation: { attemptId: "a1" },
			patchContent: "one",
			changedFiles: ["x.ts"],
		});
		const b = buildVerificationCodeState({
			implementation: { attemptId: "a1" },
			patchContent: "one",
			changedFiles: ["x.ts"],
		});
		const c = buildVerificationCodeState({
			implementation: { attemptId: "a1" },
			patchContent: "two",
			changedFiles: ["x.ts"],
		});
		expect(a.fingerprint).toBe(b.fingerprint);
		expect(a.fingerprint).not.toBe(c.fingerprint);
	});

	it("rejects reuse when fingerprint is copied but patch sha disagrees", () => {
		const sealed = sealWorkflowVerifierResult(baseArtifact(), {
			commands: ["bun check"],
			codeState,
		});
		const tampered = {
			...sealed,
			validity: {
				...sealed.validity!,
				codeState: {
					...sealed.validity!.codeState,
					// Keep fingerprint, change underlying patch identity.
					patchSha256: "0".repeat(64),
				},
			},
		};
		expect(isValidDeliveryEvidence(tampered)).toBe(false);
		expect(
			assessVerificationReuse({
				prior: tampered,
				codeState,
				commands: ["bun check"],
				scope: { kind: "paths", paths: ["src/a.ts"] },
			}).reason,
		).toBe("code_state_mismatch");
	});

	it("does not reuse or accept a passed artifact that still contains a failed check", () => {
		const contradictory = sealWorkflowVerifierResult(
			baseArtifact({
				passed: true,
				checks: [{ id: "command-1", command: "bun check", status: "failed", summary: "failed", exitCode: 1 }],
			}),
			{ commands: ["bun check"], codeState, scope: { kind: "paths", paths: ["src/a.ts"] } },
		);
		expect(isValidDeliveryEvidence(contradictory)).toBe(false);
		expect(
			assessVerificationReuse({
				prior: contradictory,
				codeState,
				commands: ["bun check"],
				scope: { kind: "paths", paths: ["src/a.ts"] },
			}),
		).toEqual({ reusable: false, reason: "failed_result" });
	});

	it("fails closed on unowned/unassigned full-repo seals but keeps assigned local/path seals", () => {
		expect(() =>
			sealVerificationValidity(baseArtifact(), {
				executor: "worker",
				owner: "worker",
				commands: ["bun test"],
				codeState,
				scope: { kind: "repo" },
				explicitlyAssigned: false,
				duplicateOfActive: true,
			}),
		).toThrow(/full-repo verification/);

		const local = sealVerificationValidity(baseArtifact(), {
			executor: "worker",
			owner: "worker",
			commands: ["bun test packages/coding-agent/test/latency/parallel-recovery-safety.test.ts"],
			codeState,
			scope: { kind: "paths", paths: ["src/a.ts"] },
			explicitlyAssigned: true,
		});
		expect(local.validity?.scope.kind).toBe("paths");
		expect(
			assertVerificationSpawnAllowed({
				scope: "local",
				owner: "worker",
				explicitlyAssigned: true,
			}).allow,
		).toBe(true);
	});

	it("treats empty-path / commands seals as full-repo for the ownership gate", () => {
		const emptyTree = buildVerificationCodeState({ changedFiles: [] });
		expect(() =>
			sealVerificationValidity(baseArtifact(), {
				executor: "worker",
				owner: "worker",
				commands: ["bun test"],
				codeState: emptyTree,
				scope: { kind: "commands" },
				explicitlyAssigned: false,
				duplicateOfActive: true,
			}),
		).toThrow(/full-repo verification/);

		const owned = sealWorkflowVerifierResult(baseArtifact(), {
			commands: ["bun check"],
			codeState: emptyTree,
		});
		expect(owned.validity?.scope.kind).toBe("repo");
		expect(owned.validity?.owner).toBe("workflow_verifier");
	});

	it("does not reuse a green that never proved the executed workspace", () => {
		const unproven = buildVerificationCodeState({
			implementation: { attemptId: "impl-1" },
			patchContent: "diff --git a/src/a.ts b/src/a.ts\n+hi\n",
			changedFiles: ["src/a.ts"],
		});
		const sealed = sealWorkflowVerifierResult(baseArtifact(), {
			commands: ["bun check"],
			codeState: unproven,
		});
		expect(isValidDeliveryEvidence(sealed)).toBe(true);
		expect(
			assessVerificationReuse({
				prior: sealed,
				codeState: unproven,
				commands: ["bun check"],
			}),
		).toEqual({ reusable: false, reason: "workspace_unproven" });
	});

	it("does not reuse when proven workspace content changes under an identical patch", () => {
		const sealed = sealWorkflowVerifierResult(baseArtifact(), {
			commands: ["bun check"],
			codeState,
			scope: { kind: "paths", paths: ["src/a.ts"] },
		});
		const moved = buildVerificationCodeState({
			implementation: { attemptId: "impl-1" },
			patchContent: "diff --git a/src/a.ts b/src/a.ts\n+hi\n",
			changedFiles: ["src/a.ts"],
			workspace: { ...provenWorkspace, contentSha256: "b".repeat(64) },
		});
		expect(
			assessVerificationReuse({
				prior: sealed,
				codeState: moved,
				commands: ["bun check"],
				scope: { kind: "paths", paths: ["src/a.ts"] },
			}).reason,
		).toBe("code_state_mismatch");
	});

	it("rejects a copied fingerprint over a rewritten workspace", () => {
		const sealed = sealWorkflowVerifierResult(baseArtifact(), {
			commands: ["bun check"],
			codeState,
		});
		const tampered = {
			...sealed,
			validity: {
				...sealed.validity!,
				codeState: {
					...sealed.validity!.codeState,
					workspace: { ...provenWorkspace, cwd: "/other" },
				},
			},
		};
		expect(isValidDeliveryEvidence(tampered)).toBe(false);
		expect(
			assessVerificationReuse({
				prior: tampered,
				codeState,
				commands: ["bun check"],
			}).reason,
		).toBe("code_state_mismatch");
	});
});

describe("verification patch evidence", () => {
	it("errors when a declared patch is missing instead of returning empty-tree evidence", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-patch-evidence-"));
		try {
			let thrown: unknown;
			try {
				await resolveVerificationPatchEvidence({ patchPath: "missing.patch", unresolved: [] }, cwd);
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(Error);
			const error = thrown as Error;
			expect(error.message).toContain("verification patch evidence missing: missing.patch");
			expect(isEnoent(error.cause)).toBe(true);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("errors when a prior patch is missing instead of sealing the remaining bytes", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-patch-evidence-"));
		try {
			await Bun.write(path.join(cwd, "current.patch"), "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+x\n");
			await expect(
				resolveVerificationPatchEvidence(
					{ patchPath: "current.patch", unresolved: ["priorPatch:gone.patch"] },
					cwd,
				),
			).rejects.toThrow(/verification patch evidence missing: gone.patch/);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("does not invent patch bytes when no patch path was declared", async () => {
		const evidence = await resolveVerificationPatchEvidence({ unresolved: ["needs human check"] }, "/tmp");
		expect(evidence.patchContent).toBeUndefined();
		expect(evidence.changedFiles).toEqual([]);
	});
});

describe("verification workspace capture", () => {
	it("does not invent an empty workspace outside a repository", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-workspace-unproven-"));
		try {
			expect(await captureVerificationWorkspace(cwd)).toBeNull();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("repeats the same identity for an unchanged isolated checkout", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-workspace-stable-"));
		try {
			await initIsolatedRepo(cwd);
			const first = await captureVerificationWorkspace(cwd);
			const second = await captureVerificationWorkspace(cwd);
			expect(first).not.toBeNull();
			expect(second).toEqual(first);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("changes identity when tracked text changes", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-workspace-text-"));
		try {
			await initIsolatedRepo(cwd);
			const before = await captureVerificationWorkspace(cwd);
			await Bun.write(path.join(cwd, "tracked.txt"), "one\nchanged\n");
			const after = await captureVerificationWorkspace(cwd);
			expect(after?.headId).toBe(before?.headId);
			expect(after?.contentSha256).not.toBe(before?.contentSha256);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("changes identity when only the index changes", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-workspace-index-"));
		try {
			await initIsolatedRepo(cwd);
			await Bun.write(path.join(cwd, "index.txt"), "v1\n");
			await git(cwd, "add", "index.txt");
			await git(cwd, "commit", "-m", "index base");
			const before = await captureVerificationWorkspace(cwd);
			await Bun.write(path.join(cwd, "index.txt"), "v2\n");
			await git(cwd, "add", "index.txt");
			await git(cwd, "restore", "--worktree", "--source=HEAD", "index.txt");
			expect(await Bun.file(path.join(cwd, "index.txt")).text()).toBe("v1\n");
			const after = await captureVerificationWorkspace(cwd);
			expect(after?.headId).toBe(before?.headId);
			expect(after?.contentSha256).not.toBe(before?.contentSha256);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("changes identity when binary bytes change", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-workspace-binary-"));
		try {
			await initIsolatedRepo(cwd);
			await Bun.write(path.join(cwd, "binary.dat"), new Uint8Array([0, 1, 2, 255]));
			await git(cwd, "add", "binary.dat");
			await git(cwd, "commit", "-m", "binary");
			const before = await captureVerificationWorkspace(cwd);
			await Bun.write(path.join(cwd, "binary.dat"), new Uint8Array([0, 1, 2, 254]));
			const after = await captureVerificationWorkspace(cwd);
			expect(after).not.toBeNull();
			expect(after?.contentSha256).not.toBe(before?.contentSha256);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("changes identity when an untracked file appears", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-workspace-untracked-"));
		try {
			await initIsolatedRepo(cwd);
			const before = await captureVerificationWorkspace(cwd);
			await Bun.write(path.join(cwd, "extra.txt"), "new\n");
			const after = await captureVerificationWorkspace(cwd);
			expect(after?.headId).toBe(before?.headId);
			expect(after?.contentSha256).not.toBe(before?.contentSha256);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
