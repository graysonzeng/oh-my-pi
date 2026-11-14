/**
 * C5: after a write capture is prepared/applied, recovery must not re-apply the
 * patch via model/schema retry — reuse captured state or fail closed.
 */
import { describe, expect, it } from "bun:test";
import type { ImplementationArtifactV1, WorkPackageStateArtifactV1 } from "../../src/workflow/types";
import { withWorkPackageMerge, withWorkPackageMergePrepared } from "../../src/workflow/work-packages";

function implementation(): ImplementationArtifactV1 {
	return {
		kind: "implementation",
		schemaVersion: 1,
		workflowId: "wf-c5",
		attemptId: "att-0",
		stage: "implementing",
		createdAt: new Date(0).toISOString(),
		modelProfileId: "strict_implementer",
		provider: "test",
		promptVersion: "v1",
		summary: "captured",
		changedFiles: ["src/a.ts"],
		addressedStepIds: [],
		commandsRun: [],
		patchPath: "patches/a.patch",
		unresolved: [],
	};
}

function baseState(overrides: Partial<WorkPackageStateArtifactV1> = {}): WorkPackageStateArtifactV1 {
	return {
		kind: "work-package-state",
		schemaVersion: 1,
		workflowId: "wf-c5",
		attemptId: "att-0",
		stage: "implementing",
		createdAt: new Date(0).toISOString(),
		revision: 1,
		mode: "capture_then_apply",
		packages: [
			{
				id: "pkg-a",
				assignment: "implement a",
				paths: ["src/a.ts"],
				dependsOn: [],
				status: "succeeded",
				implementation: implementation(),
			},
		],
		merge: {
			status: "pending",
			order: ["pkg-a"],
		},
		...overrides,
	};
}

describe("C5 write capture does not re-apply via schema/model retry", () => {
	it("marks prepared captures with patch hash before apply", () => {
		const prepared = withWorkPackageMergePrepared(baseState(), "att-1", {
			patchPath: "patches/canonical.patch",
			patchSha256: "a".repeat(64),
			scopeStatus: "adhered",
		});
		expect(prepared.merge.status).toBe("prepared");
		expect(prepared.merge.changesApplied).toBe(false);
		expect(prepared.merge.patchSha256).toBe("a".repeat(64));
		expect(prepared.merge.patchPath).toBe("patches/canonical.patch");
	});

	it("settles prepared→applied without inventing a second patch path", () => {
		const prepared = withWorkPackageMergePrepared(baseState(), "att-1", {
			patchPath: "patches/canonical.patch",
			patchSha256: "b".repeat(64),
			scopeStatus: "adhered",
		});
		const applied = withWorkPackageMerge(
			prepared,
			"att-2",
			{
				patchPath: "patches/canonical.patch",
				changesApplied: true,
				summary: "Recovered applied patch from prepared write-commit state",
			},
			{ recoveryKind: "recovered_applied" },
		);
		expect(applied.merge.status).toBe("applied");
		expect(applied.merge.changesApplied).toBe(true);
		expect(applied.merge.patchPath).toBe("patches/canonical.patch");
		expect(applied.merge.recovery?.kind).toBe("recovered_applied");

		const again = withWorkPackageMerge(
			applied,
			"att-3",
			{
				patchPath: "patches/canonical.patch",
				changesApplied: true,
				summary: "already applied — do not re-merge",
			},
			{ recoveryKind: "recovered_applied" },
		);
		expect(again.merge.patchPath).toBe("patches/canonical.patch");
		expect(again.merge.status).toBe("applied");
		expect(again.merge.recovery?.kind).toBe("recovered_applied");
	});

	it("failed merge stays non-reusable for capture_then_apply (no silent re-write)", () => {
		const prepared = withWorkPackageMergePrepared(baseState(), "att-1", {
			patchPath: "patches/canonical.patch",
			patchSha256: "c".repeat(64),
			scopeStatus: "adhered",
		});
		const failed = withWorkPackageMerge(prepared, "att-2", {
			patchPath: "patches/canonical.patch",
			changesApplied: false,
			summary: "merge conflict",
		});
		expect(failed.merge.status).toBe("failed");
		expect(failed.merge.changesApplied).toBe(false);
		expect(failed.merge.recovery?.kind).toBe("merge_conflict");
	});
});
