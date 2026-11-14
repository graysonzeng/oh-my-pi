/**
 * Package 3 — layered verification planner.
 *
 * Failure modes covered:
 * - every worker forced into full-repo suite
 * - false reuse after code / command / verify-input change
 * - parent-owned verify still auto-runs local commands
 * - overhead vs verify unknown zero-filled into a fake win
 */
import { describe, expect, it } from "bun:test";
import {
	buildLayeredVerificationPlan,
	countFullRepoRunsAvoided,
	observeFingerprintOverhead,
} from "../../src/workflow/layered-verification";
import { buildVerificationCodeState, sealWorkflowVerifierResult } from "../../src/workflow/verification-validity";
import type { VerificationArtifactV1 } from "../../src/workflow/types";

const provenWorkspace = {
	cwd: "/repo",
	vcs: "git" as const,
	root: "/repo",
	headId: "abc123",
	contentSha256: "a".repeat(64),
};

function codeState(changedFiles: string[] = ["src/a.ts"], patch = "diff --git a/src/a.ts\n+hi\n") {
	return buildVerificationCodeState({
		implementation: { attemptId: "impl-1" },
		patchContent: patch,
		changedFiles,
		workspace: provenWorkspace,
	});
}

function sealedPrior(commands: string[], state = codeState()): VerificationArtifactV1 {
	return sealWorkflowVerifierResult(
		{
			kind: "verification",
			passed: true,
			checks: commands.map(command => ({
				id: command,
				command,
				status: "passed" as const,
				summary: "ok",
				exitCode: 0,
			})),
			schemaVersion: 1,
			workflowId: "wf1",
			attemptId: "att1",
			stage: "implementation_verify",
			createdAt: "2026-09-25T00:00:00.000Z",
		},
		{ commands, codeState: state, scope: { kind: "paths", paths: state.changedFiles } },
	);
}

describe("layered verification planner", () => {
	it("slice_local runs related checks when the worker owns verify", () => {
		const plan = buildLayeredVerificationPlan({
			layer: "slice_local",
			commands: ["bun test test/a.test.ts"],
			codeState: codeState(),
			scope: { kind: "paths", paths: ["src/a.ts"] },
		});
		expect(plan.toRun).toEqual(["bun test test/a.test.ts"]);
		expect(plan.skipped).toEqual([]);
		expect(plan.checks[0]?.disposition).toBe("run");
	});

	it("slice_local delivers checklist only when parent owns verify", () => {
		const plan = buildLayeredVerificationPlan({
			layer: "slice_local",
			commands: ["bun test test/a.test.ts", "bun check"],
			codeState: codeState(),
			parentOwnsVerify: true,
		});
		expect(plan.toRun).toEqual([]);
		expect(plan.skipped).toHaveLength(2);
		expect(plan.skipped.every(s => s.reason === "parent_owns_verify_checklist_only")).toBe(true);
	});

	it("final_repo reuses a still-valid seal instead of re-running full suite", () => {
		const state = codeState();
		const commands = ["bun check", "bun test"];
		const prior = sealedPrior(commands, state);
		const plan = buildLayeredVerificationPlan({
			layer: "final_repo",
			commands,
			codeState: state,
			scope: { kind: "paths", paths: ["src/a.ts"] },
			priorVerification: prior,
		});
		expect(plan.toRun).toEqual([]);
		expect(plan.toReuse).toHaveLength(2);
		expect(plan.reuseDecision?.reusable).toBe(true);
		expect(countFullRepoRunsAvoided([plan])).toBe(2);
	});

	it("refuses false reuse after code state change", () => {
		const prior = sealedPrior(["bun check"], codeState(["src/a.ts"], "diff a\n+old\n"));
		const plan = buildLayeredVerificationPlan({
			layer: "final_repo",
			commands: ["bun check"],
			codeState: codeState(["src/a.ts"], "diff a\n+new\n"),
			scope: { kind: "paths", paths: ["src/a.ts"] },
			priorVerification: prior,
		});
		expect(plan.reuseDecision?.reusable).toBe(false);
		expect(plan.reuseDecision?.reason).toBe("code_state_mismatch");
		expect(plan.toRun).toEqual(["bun check"]);
		expect(plan.toReuse).toEqual([]);
	});

	it("refuses false reuse after command set change", () => {
		const state = codeState();
		const prior = sealedPrior(["bun check"], state);
		const plan = buildLayeredVerificationPlan({
			layer: "final_repo",
			commands: ["bun check", "bun test"],
			codeState: state,
			scope: { kind: "paths", paths: ["src/a.ts"] },
			priorVerification: prior,
		});
		expect(plan.reuseDecision?.reason).toBe("commands_mismatch");
		expect(plan.toRun).toEqual(["bun check", "bun test"]);
	});

	it("parent_integrate skips slice work when classification is cross_module at slice layer", () => {
		const plan = buildLayeredVerificationPlan({
			layer: "slice_local",
			commands: ["bun test test/a.test.ts"],
			codeState: codeState(),
			parentClassification: "cross_module",
		});
		expect(plan.toRun).toEqual([]);
		expect(plan.skipped[0]?.reason).toBe("cross_module_parent_coordinates");
	});

	it("layered fixture runs fewer full-repo commands than a naive always-rerun plan", () => {
		const state = codeState();
		const commands = ["bun check", "bun test packages/coding-agent"];
		const prior = sealedPrior(commands, state);
		const layered = [
			buildLayeredVerificationPlan({
				layer: "slice_local",
				commands: ["bun test test/a.test.ts"],
				codeState: state,
			}),
			buildLayeredVerificationPlan({
				layer: "parent_integrate",
				commands,
				codeState: state,
				scope: { kind: "paths", paths: ["src/a.ts"] },
				priorVerification: prior,
			}),
			buildLayeredVerificationPlan({
				layer: "final_repo",
				commands,
				codeState: state,
				scope: { kind: "paths", paths: ["src/a.ts"] },
				priorVerification: prior,
			}),
		];
		const naiveFullRepoRuns = commands.length; // would re-run at final every time
		const layeredFullRepoRuns = layered.find(p => p.layer === "final_repo")!.toRun.length;
		expect(layeredFullRepoRuns).toBe(0);
		expect(layeredFullRepoRuns).toBeLessThan(naiveFullRepoRuns);
		expect(countFullRepoRunsAvoided(layered)).toBe(2);
	});
});

describe("fingerprint overhead observation", () => {
	it("keeps unknown timings null and never claims a win", () => {
		expect(observeFingerprintOverhead({ reuseDecisionMs: null, verifyMs: 100 })).toEqual({
			reuseDecisionMs: null,
			verifyMs: 100,
			overheadDominatesVerify: null,
			note: "unknown_overhead_or_verify_ms",
		});
	});

	it("flags when reuse-decision overhead dominates verify cost", () => {
		const obs = observeFingerprintOverhead({ reuseDecisionMs: 500, verifyMs: 200 });
		expect(obs.overheadDominatesVerify).toBe(true);
		expect(obs.note).toContain("optimize_snapshot_path");
	});

	it("records when reuse decision is cheaper than verify", () => {
		const obs = observeFingerprintOverhead({ reuseDecisionMs: 20, verifyMs: 2000 });
		expect(obs.overheadDominatesVerify).toBe(false);
		expect(obs.note).toBe("reuse_decision_cheaper_than_verify");
	});
});
