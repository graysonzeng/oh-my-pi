import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MODEL_PROFILES } from "../../../src/workflow/default-config";
import { RuntimeAdapter } from "../../../src/workflow/runtime-adapter";
import { RepairStage, type RepairStageResult } from "../../../src/workflow/stages/repair";
import type { ImplementationArtifactV1 } from "../../../src/workflow/types";
import { fakeSession, implArtifact, scriptedRunner } from "../helpers";

describe("RepairStage no-op artifacts", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-repair-stage-"));
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	async function execute(repair: ImplementationArtifactV1): Promise<RepairStageResult> {
		return new RepairStage(new RuntimeAdapter(scriptedRunner({ repair }))).execute({
			workflowId: "wf",
			attemptId: "attempt",
			profile: DEFAULT_MODEL_PROFILES.grok_repair,
			findingIds: [],
			findings: [],
			assignment: "Repair findings: none",
			context: "context",
			session: fakeSession({ cwd }),
		});
	}

	it("accepts an explicit no-op with no runtime patch", async () => {
		const result = await execute(
			implArtifact({
				stage: "repairing",
				patchPath: undefined,
				branchName: undefined,
				noChangesRequired: true,
				unresolved: [],
			}),
		);

		expect(result.artifact.noChangesRequired).toBe(true);
		expect(result.artifact.patchPath).toBeUndefined();
	});

	it("rejects an explicit no-op when runtime emits a non-empty patch", async () => {
		await expect(
			execute(
				implArtifact({
					stage: "repairing",
					patchPath: "patches/non-empty.patch",
					branchName: undefined,
					noChangesRequired: true,
					unresolved: [],
				}),
			),
		).rejects.toThrow("repair_noop_patch_non_empty");
	});
});
