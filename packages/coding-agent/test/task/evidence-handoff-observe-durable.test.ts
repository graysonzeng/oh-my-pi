/**
 * Batch 1 W3 — durable observe persist, dedupe, restart recompute.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionManager } from "../../src/session/session-manager";
import {
	buildEvidenceHandoffObserveRecord,
	EVIDENCE_HANDOFF_OBSERVE_CUSTOM_TYPE,
	getEvidenceHandoffObserveSnapshot,
	noteVerificationObserve,
	parseEvidenceHandoffObserveRecord,
	persistEvidenceHandoffObserve,
	recomputeEvidenceHandoffObserveSnapshot,
	resetEvidenceHandoffObserveForTests,
} from "../../src/task/evidence-handoff-observe";
import {
	buildLayeredVerificationPlan,
	countFullRepoRunsAvoided,
	layeredVerificationObserveEvents,
} from "../../src/workflow/layered-verification";
import type { VerificationArtifactV1, VerificationWorkspaceBinding } from "../../src/workflow/types";
import { buildVerificationCodeState, sealWorkflowVerifierResult } from "../../src/workflow/verification-validity";

beforeEach(() => {
	resetEvidenceHandoffObserveForTests();
});

afterEach(() => {
	resetEvidenceHandoffObserveForTests();
});

const provenWorkspace: VerificationWorkspaceBinding = {
	cwd: "/tmp/ws",
	vcs: "git",
	root: "/tmp/ws",
	headId: "a".repeat(40),
	contentSha256: "b".repeat(64),
};

function baseArtifact(): VerificationArtifactV1 {
	return {
		schemaVersion: 1,
		kind: "verification",
		workflowId: "wf",
		attemptId: "a1",
		stage: "final_verify",
		createdAt: new Date(0).toISOString(),
		passed: true,
		checks: [{ id: "cmd:bun check", status: "passed", summary: "ok", command: "bun check" }],
	};
}

describe("W3 durable evidence-handoff observe", () => {
	it("persists lifecycle summaries, dedupes duplicates, and recomputes after restart", () => {
		const manager = SessionManager.inMemory();
		const generate = buildEvidenceHandoffObserveRecord({
			eventId: "gen-1",
			phase: "generate",
			ts: 1_000,
			episodeKey: "s::u1",
			jobId: "job-1",
		});
		const consume = buildEvidenceHandoffObserveRecord({
			eventId: "inspect-1",
			phase: "inspect",
			ts: 1_100,
			reason: "valid",
			episodeKey: "s::u1",
			jobId: "job-1",
		});
		const reuse = buildEvidenceHandoffObserveRecord({
			eventId: "reuse-1",
			phase: "reuse",
			ts: 1_200,
			reason: "continue",
			episodeKey: "s::u1",
			agentId: "WorkerA",
		});
		expect(persistEvidenceHandoffObserve(manager, generate).persisted).toBe(true);
		expect(persistEvidenceHandoffObserve(manager, consume).persisted).toBe(true);
		expect(persistEvidenceHandoffObserve(manager, reuse).persisted).toBe(true);
		expect(persistEvidenceHandoffObserve(manager, generate).persisted).toBe(false);

		const live = getEvidenceHandoffObserveSnapshot();
		expect(live.generate).toBe(1);
		expect(live.consumeValid).toBe(1);
		expect(live.reuseContinue).toBe(1);

		const records = manager
			.getBranch()
			.filter(e => e.type === "custom" && e.customType === EVIDENCE_HANDOFF_OBSERVE_CUSTOM_TYPE)
			.map(e => (e.type === "custom" ? parseEvidenceHandoffObserveRecord(e.data) : null))
			.filter((r): r is NonNullable<typeof r> => r !== null);

		resetEvidenceHandoffObserveForTests();
		expect(getEvidenceHandoffObserveSnapshot().generate).toBe(0);
		const recomputed = recomputeEvidenceHandoffObserveSnapshot(records);
		expect(recomputed.generate).toBe(1);
		expect(recomputed.consumeValid).toBe(1);
		expect(recomputed.reuseContinue).toBe(1);
	});

	it("persist observe is fail-open on sink write errors (does not throw)", () => {
		const manager = SessionManager.inMemory();
		const original = manager.appendCustomEntry.bind(manager);
		manager.appendCustomEntry = (() => {
			throw new Error("disk full");
		}) as SessionManager["appendCustomEntry"];
		const result = persistEvidenceHandoffObserve(
			manager,
			buildEvidenceHandoffObserveRecord({
				eventId: "fail-open-1",
				phase: "verify_plan",
				ts: 1,
				reason: "start",
			}),
		);
		expect(result.persisted).toBe(false);
		expect(result.error).toMatch(/disk full/);
		// In-process snapshot still advanced; durable restart would miss this boundary.
		expect(getEvidenceHandoffObserveSnapshot().verifyPlan).toBe(1);
		manager.appendCustomEntry = original;
	});

	it("never treats async.running as verify reuse/pass and exposes reject reasons", () => {
		const manager = SessionManager.inMemory();
		noteVerificationObserve({
			disposition: "reuse",
			asyncRunning: true,
			eventId: "async-1",
			reason: "still_running",
			sink: manager,
		});
		expect(getEvidenceHandoffObserveSnapshot().verifyReuse).toBe(0);
		expect(getEvidenceHandoffObserveSnapshot().verifyReject).toBe(1);

		const codeState = buildVerificationCodeState({
			implementation: { attemptId: "impl-1" },
			patchContent: "diff --git a/a.ts b/a.ts\n+x\n",
			changedFiles: ["a.ts"],
			workspace: provenWorkspace,
		});
		const prior = sealWorkflowVerifierResult(
			{
				...baseArtifact(),
				checks: [{ id: "bun check", command: "bun check", status: "passed", summary: "ok", exitCode: 0 }],
			},
			{
				commands: ["bun check"],
				codeState,
				scope: { kind: "paths", paths: ["a.ts"] },
			},
		);
		const reused = buildLayeredVerificationPlan({
			layer: "final_repo",
			commands: ["bun check"],
			codeState,
			scope: { kind: "paths", paths: ["a.ts"] },
			priorVerification: prior,
		});
		expect(countFullRepoRunsAvoided([reused])).toBe(1);
		const reuseEvents = layeredVerificationObserveEvents(reused, { eventIdPrefix: "fv" });
		expect(reuseEvents.some(e => e.disposition === "reuse")).toBe(true);

		const edited = buildVerificationCodeState({
			implementation: { attemptId: "impl-1" },
			patchContent: "diff --git a/a.ts b/a.ts\n+y\n",
			changedFiles: ["a.ts", "b.ts"],
			workspace: { ...provenWorkspace, contentSha256: "c".repeat(64) },
		});
		const rejected = buildLayeredVerificationPlan({
			layer: "final_repo",
			commands: ["bun check"],
			codeState: edited,
			scope: { kind: "paths", paths: ["a.ts", "b.ts"] },
			priorVerification: prior,
		});
		expect(countFullRepoRunsAvoided([rejected])).toBe(0);
		const rejectEvents = layeredVerificationObserveEvents(rejected, { eventIdPrefix: "fv2" });
		expect(rejectEvents.some(e => e.disposition === "reject")).toBe(true);
		expect(rejectEvents.find(e => e.disposition === "reject")?.reason).toBeTruthy();
	});

	it("plan observe emits plan/start not verify_run before execute", () => {
		const codeState = buildVerificationCodeState({
			implementation: { attemptId: "impl-1" },
			patchContent: "diff --git a/a.ts b/a.ts\n+x\n",
			changedFiles: ["a.ts"],
			workspace: provenWorkspace,
		});
		const plan = buildLayeredVerificationPlan({
			layer: "slice_local",
			commands: ["bun check"],
			codeState,
			scope: { kind: "paths", paths: ["a.ts"] },
		});
		expect(plan.toRun).toContain("bun check");
		const events = layeredVerificationObserveEvents(plan, { eventIdPrefix: "iv" });
		expect(events.map(e => e.disposition)).toEqual(["plan"]);
		expect(events[0]?.reason).toBe("start");
		expect(events[0]?.eventId).toContain(":plan:");
	});
});
