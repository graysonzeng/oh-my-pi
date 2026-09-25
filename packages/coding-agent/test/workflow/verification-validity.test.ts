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
import { describe, expect, it } from "bun:test";
import type { VerificationArtifactV1 } from "../../src/workflow/types";
import {
	assessVerificationReuse,
	assertVerificationSpawnAllowed,
	buildVerificationCodeState,
	invalidateVerificationResult,
	isValidDeliveryEvidence,
	parseVerificationValidity,
	projectReusedVerificationChecks,
	sealVerificationValidity,
	sealWorkflowVerifierResult,
} from "../../src/workflow/verification-validity";
import { VerificationArtifactSchema } from "../../src/workflow/schemas";

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
	const codeState = buildVerificationCodeState({
		implementation: {
			attemptId: "impl-1",
		},
		patchContent: "diff --git a/src/a.ts b/src/a.ts\n+hi\n",
		changedFiles: ["src/a.ts"],
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
		expect(
			assessVerificationReuse({
				prior: tampered,
				codeState,
				commands: ["bun check"],
				scope: { kind: "paths", paths: ["src/a.ts"] },
			}).reason,
		).toBe("code_state_mismatch");
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
		expect(assertVerificationSpawnAllowed({
			scope: "local",
			owner: "worker",
			explicitlyAssigned: true,
		}).allow).toBe(true);
	});
});
