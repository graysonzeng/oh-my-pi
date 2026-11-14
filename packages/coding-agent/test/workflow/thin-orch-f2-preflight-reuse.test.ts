/**
 * Batch 1 thin-orchestration — F2 same-run preflight reuse.
 *
 * Failure mode: start() then run() on the same engine must not probe twice.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { WorkflowAvailabilityPort, WorkflowAvailabilityProbeRequest } from "../../src/workflow/types";
import {
	fakeSession,
	implArtifact,
	passVerifier,
	planArtifact,
	realTempWorkspace,
	reviewArtifact,
	scriptedRunner,
} from "./helpers";

describe("F2 same-run preflight reuse", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let workspace: { cwd: string; cleanup: () => Promise<void> };

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-f2-"));
		workspace = await realTempWorkspace();
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
		await workspace.cleanup();
	});

	it("reuses start() availability report inside the same run() without a second probe", async () => {
		let probeCount = 0;
		const availability: WorkflowAvailabilityPort = {
			async probe(_request: WorkflowAvailabilityProbeRequest) {
				probeCount += 1;
				return {
					status: "available" as const,
					runtime: "embedded" as const,
					usageKind: "diagnostic" as const,
					actualProvider: "xai",
					actualModel: "grok",
					exactIdentityMatch: true,
				};
			},
		};
		const session = fakeSession({ cwd: workspace.cwd });
		const engine = new WorkflowEngine({
			store,
			session,
			availability,
			verifier: passVerifier(workspace.cwd),
			artifactStore: new ArtifactStore(artifactDir),
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
		});

		const started = await engine.start({ request: "f2 reuse" });
		const probesAfterStart = probeCount;
		expect(probesAfterStart).toBeGreaterThan(0);
		expect(started.availability.operation).toBe("start");
		expect(started.availability.workflowId).toBe(started.workflowId);

		const result = await engine.run(started.workflowId, session);
		expect(result.state.status).toBe("completed");
		// No additional probes: run reused start's report.
		expect(probeCount).toBe(probesAfterStart);
		expect(engine.getLastAvailabilityReport()?.operation).toBe("start");
		expect(engine.getLastAvailabilityReport()?.workflowId).toBe(started.workflowId);
	});
});
