/**
 * FinalVerifyStage reuse: skip redundant command re-runs when a sealed prior
 * green still matches code state; never reuse stale greens; always re-apply
 * completion gates.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FinalVerifyStage } from "../../src/workflow/stages/final-verify";
import type { ImplementationArtifactV1, VerificationArtifactV1, VerifierPort } from "../../src/workflow/types";
import {
	buildVerificationCodeState,
	invalidateVerificationResult,
	sealWorkflowVerifierResult,
} from "../../src/workflow/verification-validity";

function makeImpl(overrides: Partial<ImplementationArtifactV1> = {}): ImplementationArtifactV1 {
	return {
		kind: "implementation",
		schemaVersion: 1,
		workflowId: "wf1",
		attemptId: "impl-1",
		stage: "implementing",
		createdAt: "2026-09-25T00:00:00.000Z",
		summary: "impl",
		changedFiles: ["src/math.ts"],
		addressedStepIds: [],
		commandsRun: [],
		unresolved: [],
		...overrides,
	};
}

describe("FinalVerifyStage verification reuse", () => {
	let dir: string;
	let patchPath: string;
	let patchContent: string;
	let implementation: ImplementationArtifactV1;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-final-verify-reuse-"));
		patchPath = path.join(dir, "change.patch");
		patchContent = "diff --git a/src/math.ts b/src/math.ts\n+++ b/src/math.ts\n+export const n = 1\n";
		await Bun.write(patchPath, patchContent);
		implementation = makeImpl({
			attemptId: "impl-1",
			patchPath,
			changedFiles: ["src/math.ts"],
			unresolved: [],
		});
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function sealedPrior(commands: string[]): VerificationArtifactV1 {
		const codeState = buildVerificationCodeState({
			implementation,
			patchContent,
			changedFiles: ["src/math.ts"],
		});
		return sealWorkflowVerifierResult(
			{
				kind: "verification",
				passed: true,
				checks: commands.map((command, index) => ({
					id: `command-${index + 1}`,
					command,
					status: "passed" as const,
					summary: "ok",
					exitCode: 0,
				})),
				schemaVersion: 1,
				workflowId: "wf1",
				attemptId: "impl-verify-1",
				stage: "implementation_verify",
				createdAt: "2026-09-25T00:00:00.000Z",
			},
			{
				commands,
				codeState,
				scope: { kind: "paths", paths: ["src/math.ts"] },
			},
		);
	}

	it("reuses a sealed prior green instead of re-spawning verification commands", async () => {
		let verifyCalls = 0;
		const verifier: VerifierPort = {
			async verify() {
				verifyCalls += 1;
				throw new Error("verifier should not run when prior is reusable");
			},
		};
		const stage = new FinalVerifyStage(verifier);
		const result = await stage.execute({
			workflowId: "wf1",
			attemptId: "final-1",
			commands: ["bun check"],
			implementation,
			priorVerification: sealedPrior(["bun check"]),
			cwd: dir,
		});
		expect(verifyCalls).toBe(0);
		expect(result.passed).toBe(true);
		expect(result.checks.some(c => c.command === "bun check")).toBe(true);
		expect(result.validity?.executor).toBe("workflow_verifier");
		expect(result.validity?.codeState.fingerprint).toBe(
			buildVerificationCodeState({
				implementation,
				patchContent,
				changedFiles: ["src/math.ts"],
			}).fingerprint,
		);
	});

	it("re-runs commands when a prior green was invalidated by repair", async () => {
		let verifyCalls = 0;
		const verifier: VerifierPort = {
			async verify(artifact, commands) {
				verifyCalls += 1;
				return {
					kind: "verification",
					passed: true,
					checks: commands.map((command, index) => ({
						id: `command-${index + 1}`,
						command,
						status: "passed" as const,
						summary: "rerun",
						exitCode: 0,
					})),
					schemaVersion: 1,
					workflowId: artifact.workflowId,
					attemptId: artifact.attemptId,
					stage: artifact.stage,
					createdAt: new Date().toISOString(),
				};
			},
		};
		const stale = invalidateVerificationResult(sealedPrior(["bun check"]), "repair_applied", "repair_applied");
		const stage = new FinalVerifyStage(verifier);
		const result = await stage.execute({
			workflowId: "wf1",
			attemptId: "final-2",
			commands: ["bun check"],
			implementation,
			priorVerification: stale,
			cwd: dir,
		});
		expect(verifyCalls).toBe(1);
		expect(result.passed).toBe(true);
		expect(result.checks[0]?.summary).toBe("rerun");
	});

	it("still applies completion gates when commands are reused", async () => {
		const verifier: VerifierPort = {
			async verify() {
				throw new Error("should reuse");
			},
		};
		const stage = new FinalVerifyStage(verifier);
		const result = await stage.execute({
			workflowId: "wf1",
			attemptId: "final-3",
			commands: ["bun check"],
			implementation,
			priorVerification: sealedPrior(["bun check"]),
			openFindings: [
				{
					id: "f1",
					priority: "P0",
					category: "correctness",
					status: "open",
					confidence: 1,
					summary: "blocking leftover",
					explanation: "still open",
					suggestedOwner: "implementer",
					blocking: true,
					file: "src/math.ts",
				},
			],
			cwd: dir,
		});
		expect(result.passed).toBe(false);
		expect(result.checks.some(c => c.id === "unresolved-findings")).toBe(true);
	});

	it("still applies forbidden-path policy when command checks are reused", async () => {
		const verifier: VerifierPort = {
			async verify() {
				throw new Error("should reuse");
			},
		};
		const stage = new FinalVerifyStage(verifier);
		const result = await stage.execute({
			workflowId: "wf1",
			attemptId: "final-4",
			commands: ["bun check"],
			implementation,
			priorVerification: sealedPrior(["bun check"]),
			forbiddenPaths: ["src"],
			cwd: dir,
		});
		expect(result.passed).toBe(false);
		expect(result.checks.some(c => c.id === "forbidden-paths")).toBe(true);
	});
});
