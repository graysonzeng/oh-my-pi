/**
 * P1-4: parallelism & recovery safety gap contracts.
 *
 * Failure modes covered: shared-write overwrite allowed, read-only blocked,
 * isolated same-path treated as shared overwrite, spawn refused for missing
 * Acceptance heading alone, unowned duplicate full-repo verify allowed,
 * cancel/merge outcomes unexplained / treated as transactions.
 */
import { describe, expect, it } from "bun:test";
import {
	buildConcurrencyDeclaration,
	shouldAutoParallel,
	validateConcurrencyDeclaration,
} from "../../src/latency/concurrency-declaration";
import {
	assessVerificationSpawn,
	completeTaskContract,
	explainCancelOutcome,
	explainMergeRecoveryOutcome,
	resolveSharedWriteConflict,
} from "../../src/latency/parallel-recovery-safety";

function unit(
	id: string,
	paths: string[],
	mode: "read" | "write",
	isolationScope?: string,
): {
	id: string;
	assignment: string;
	paths: string[];
	dependsOn: string[];
	mode: "read" | "write";
	required: boolean;
	idempotencyKey: string;
	isolationScope?: string;
} {
	return {
		id,
		assignment: id,
		paths,
		dependsOn: [],
		mode,
		required: true,
		idempotencyKey: id,
		...(isolationScope !== undefined ? { isolationScope } : {}),
	};
}

describe("P1-4 shared-write / read / isolation decisions", () => {
	it("blocks shared-workspace concurrent writes to the same path", () => {
		const decision = resolveSharedWriteConflict(unit("a", ["src/a.ts"], "write"), unit("b", ["src/a.ts"], "write"));
		expect(decision.action).toBe("block");
		expect(decision.code).toBe("shared_write_overlap");
	});

	it("transfers shared-write ownership when requested instead of only blocking", () => {
		const decision = resolveSharedWriteConflict(
			unit("a", ["src/a.ts"], "write"),
			unit("b", ["src/a.ts"], "write"),
			{ transferOwnership: true, preferOwnerId: "b" },
		);
		expect(decision.action).toBe("transfer_ownership");
		expect(decision.ownership).toEqual({ from: "a", to: "b" });
		expect(decision.code).toBe("ownership_transferred");
	});

	it("does not block read-only agents reading the same path", () => {
		const decision = resolveSharedWriteConflict(unit("r1", ["src/a.ts"], "read"), unit("r2", ["src/a.ts"], "read"));
		expect(decision.action).toBe("allow");
		expect(decision.code).toBe("read_only_ok");
	});

	it("treats isolated worktree same-path as merge risk, not shared-write overwrite", () => {
		const decision = resolveSharedWriteConflict(
			unit("w1", ["src/a.ts"], "write", "wt-alpha"),
			unit("w2", ["src/a.ts"], "write", "wt-beta"),
		);
		expect(decision.action).toBe("merge_risk");
		expect(decision.code).toBe("isolated_merge_risk");
		expect(decision.detail).toContain("merge/conflict");
		expect(decision.detail).not.toContain("shared-write overwrite between");
	});

	it("validateConcurrencyDeclaration rejects shared write overlap but allows isolated same-path", () => {
		const shared = buildConcurrencyDeclaration({
			declarationId: "shared-overlap",
			ownerKind: "session_task",
			ownerId: "s1",
			scopeArtifactRef: "artifact://1",
			scopeArtifactSha256: "a".repeat(64),
			revision: 0,
			maxConcurrency: 2,
			completionPolicy: { kind: "all_required", minSuccesses: null },
			failurePolicy: "fail_closed",
			cancelPolicy: "stop_new_work",
			units: [unit("a", ["pkg/a"], "write"), unit("b", ["pkg/a/src"], "write")],
		});
		expect(validateConcurrencyDeclaration(shared).errors.some(e => e.code === "path_overlap")).toBe(true);

		const isolated = buildConcurrencyDeclaration({
			declarationId: "isolated-overlap",
			ownerKind: "session_task",
			ownerId: "s1",
			scopeArtifactRef: "artifact://1",
			scopeArtifactSha256: "a".repeat(64),
			revision: 0,
			maxConcurrency: 2,
			completionPolicy: { kind: "all_required", minSuccesses: null },
			failurePolicy: "fail_closed",
			cancelPolicy: "stop_new_work",
			units: [
				unit("a", ["pkg/a"], "write", "wt-1"),
				unit("b", ["pkg/a"], "write", "wt-2"),
			],
		});
		const isolatedValidation = validateConcurrencyDeclaration(isolated);
		expect(isolatedValidation.ok).toBe(true);
		expect(isolatedValidation.errors.some(e => e.code === "path_overlap")).toBe(false);
		expect(shouldAutoParallel(isolated.units)).toBe(true);
	});

	it("allows read-only same-path units in a declaration", () => {
		const reads = buildConcurrencyDeclaration({
			declarationId: "reads",
			ownerKind: "session_task",
			ownerId: "s1",
			scopeArtifactRef: "artifact://1",
			scopeArtifactSha256: "a".repeat(64),
			revision: 0,
			maxConcurrency: 2,
			completionPolicy: { kind: "all_required", minSuccesses: null },
			failurePolicy: "fail_closed",
			cancelPolicy: "stop_new_work",
			units: [unit("r1", ["src/a.ts"], "read"), unit("r2", ["src/a.ts"], "read")],
		});
		expect(validateConcurrencyDeclaration(reads).ok).toBe(true);
		expect(shouldAutoParallel(reads.units)).toBe(true);
	});

	it("still rejects two write units in the same isolated worktree even with disjoint paths", () => {
		const sameWt = buildConcurrencyDeclaration({
			declarationId: "same-wt",
			ownerKind: "workflow",
			ownerId: "wf",
			scopeArtifactRef: "artifact://plan",
			scopeArtifactSha256: "b".repeat(64),
			revision: 0,
			maxConcurrency: 2,
			completionPolicy: { kind: "all_required", minSuccesses: null },
			failurePolicy: "fail_closed",
			cancelPolicy: "cascade_dependents",
			units: [
				unit("w1", ["src/a.ts"], "write", "wt-shared"),
				unit("w2", ["src/b.ts"], "write", "wt-shared"),
			],
		});
		const validation = validateConcurrencyDeclaration(sameWt);
		expect(validation.ok).toBe(false);
		expect(validation.errors.some(e => e.code === "isolation_overlap")).toBe(true);
	});
});

describe("P1-4 task contract completion", () => {
	it("completes acceptance from free text and does not refuse for missing Acceptance heading", () => {
		const result = completeTaskContract(
			["# Target", "- packages/coding-agent/src/latency/x.ts", "# Change", "- Add safety guard"].join("\n"),
		);
		expect(result.refused).toBe(false);
		expect(result.hadAcceptanceHeading).toBe(false);
		expect(result.acceptanceCompleted).toBe(true);
		expect(result.acceptance.length).toBeGreaterThan(0);
		expect(result.assignment).toContain("# Acceptance");
	});

	it("keeps an existing Acceptance section without inventing refusal", () => {
		const result = completeTaskContract(
			["# Target", "- a.ts", "# Acceptance", "- tests pass for a.ts"].join("\n"),
		);
		expect(result.refused).toBe(false);
		expect(result.acceptanceCompleted).toBe(false);
		expect(result.acceptance).toEqual(["- tests pass for a.ts"]);
	});

	it("refuses only empty assignment bodies, not missing Acceptance headings", () => {
		const empty = completeTaskContract("   ");
		expect(empty.refused).toBe(true);
		expect(empty.refusalCode).toBe("empty_assignment");
		expect(empty.detail).toContain("not because Acceptance heading is missing");
	});
});

describe("P1-4 verification ownership gate", () => {
	it("forbids unowned duplicate full-repo verify", () => {
		const forbidden = assessVerificationSpawn({
			scope: "repo",
			owner: null,
			explicitlyAssigned: false,
			duplicateOfActive: true,
		});
		expect(forbidden.allow).toBe(false);
		expect(forbidden.code).toBe("forbidden_unowned_duplicate_repo");
	});

	it("keeps explicitly assigned local verify", () => {
		const local = assessVerificationSpawn({
			scope: "local",
			owner: "worker",
			explicitlyAssigned: true,
		});
		expect(local.allow).toBe(true);
		expect(local.code).toBe("allowed_local");
	});

	it("allows explicitly assigned owned full-repo verify", () => {
		const repo = assessVerificationSpawn({
			scope: "repo",
			owner: "parent",
			explicitlyAssigned: true,
		});
		expect(repo.allow).toBe(true);
		expect(repo.code).toBe("allowed_assigned_repo");
	});
});

describe("P1-4 cancel / merge recovery explainability", () => {
	it("cancel outcomes are explainable and do not claim verify re-run or transactional isolation", () => {
		const cancelled = explainCancelOutcome({
			phase: "in_flight",
			unitIds: ["u1"],
			reason: "caller cancelled",
		});
		expect(cancelled.explainable).toBe(true);
		expect(cancelled.verifyRerunGuaranteed).toBe(false);
		expect(cancelled.isolationIsTransaction).toBe(false);
		expect(cancelled.detail).toContain("verify re-run is not guaranteed");
		expect(cancelled.detail).toContain("isolation is not a transaction");
	});

	it("merge/recovery outcomes stay explainable without treating isolation as a transaction", () => {
		const conflict = explainMergeRecoveryOutcome({
			kind: "merge_conflict",
			detail: "patch conflict on src/a.ts",
			unitIds: ["wt-1", "wt-2"],
		});
		expect(conflict.explainable).toBe(true);
		expect(conflict.isolationIsTransaction).toBe(false);
		expect(conflict.detail).toContain("isolation is not a transaction");
	});
});
