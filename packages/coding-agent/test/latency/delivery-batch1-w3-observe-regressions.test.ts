/**
 * Batch 1 W3 — plan/start vs run/end + multi-round unique eventIds.
 *
 * Failure modes if these regress:
 * - plan observe mints verify_run / run before commands execute
 * - run/end eventIds collide with plan/start for the same command
 * - multi-round workpool observe keys merge across rounds
 */
import { describe, expect, it } from "bun:test";
import {
	buildLayeredVerificationPlan,
	layeredVerificationObserveEvents,
	layeredVerificationRunEndObserveEvents,
} from "../../src/workflow/layered-verification";
import type { VerificationWorkspaceBinding } from "../../src/workflow/types";
import { buildVerificationCodeState } from "../../src/workflow/verification-validity";

const provenWorkspace: VerificationWorkspaceBinding = {
	cwd: "/tmp/ws",
	vcs: "git",
	root: "/tmp/ws",
	headId: "a".repeat(40),
	contentSha256: "b".repeat(64),
};

describe("W3 plan/start vs run/end observe contracts", () => {
	it("plan emits plan/start; run/end is distinct and never minted by plan helper", () => {
		const codeState = buildVerificationCodeState({
			implementation: { attemptId: "impl-1" },
			patchContent: "diff --git a/a.ts b/a.ts\n+x\n",
			changedFiles: ["a.ts"],
			workspace: provenWorkspace,
		});
		const plan = buildLayeredVerificationPlan({
			layer: "slice_local",
			commands: ["bun check", "bun test"],
			codeState,
			scope: { kind: "paths", paths: ["a.ts"] },
		});
		const planEvents = layeredVerificationObserveEvents(plan, { eventIdPrefix: "iv:round1" });
		expect(planEvents.every(e => e.disposition === "plan")).toBe(true);
		expect(planEvents.every(e => e.reason === "start")).toBe(true);
		expect(planEvents.map(e => e.eventId)).toEqual(["iv:round1:plan:bun check", "iv:round1:plan:bun test"]);
		expect(planEvents.every(e => !e.eventId.includes(":run:"))).toBe(true);

		const runEvents = layeredVerificationRunEndObserveEvents(plan, { eventIdPrefix: "iv:round1" });
		expect(runEvents.every(e => e.disposition === "run")).toBe(true);
		expect(runEvents.every(e => e.reason === "end")).toBe(true);
		expect(runEvents.map(e => e.eventId)).toEqual(["iv:round1:run:bun check", "iv:round1:run:bun test"]);

		const planIds = new Set(planEvents.map(e => e.eventId));
		for (const run of runEvents) {
			expect(planIds.has(run.eventId)).toBe(false);
		}
	});

	it("multi-round eventId prefixes stay unique across rounds for the same command", () => {
		const codeState = buildVerificationCodeState({
			implementation: { attemptId: "impl-2" },
			patchContent: "diff --git a/b.ts b/b.ts\n+y\n",
			changedFiles: ["b.ts"],
			workspace: provenWorkspace,
		});
		const plan = buildLayeredVerificationPlan({
			layer: "slice_local",
			commands: ["bun check"],
			codeState,
			scope: { kind: "paths", paths: ["b.ts"] },
		});
		// Mirrors workpool scope keys: item + round so multi-round reuse does not merge.
		const r0 = layeredVerificationObserveEvents(plan, { eventIdPrefix: "wp:pool:agent:item:r0" });
		const r1 = layeredVerificationObserveEvents(plan, { eventIdPrefix: "wp:pool:agent:item:r1" });
		expect(r0[0]?.eventId).toBe("wp:pool:agent:item:r0:plan:bun check");
		expect(r1[0]?.eventId).toBe("wp:pool:agent:item:r1:plan:bun check");
		expect(r0[0]?.eventId).not.toBe(r1[0]?.eventId);

		const run0 = layeredVerificationRunEndObserveEvents(plan, { eventIdPrefix: "wp:pool:agent:item:r0" });
		const run1 = layeredVerificationRunEndObserveEvents(plan, { eventIdPrefix: "wp:pool:agent:item:r1" });
		expect(run0[0]?.eventId).not.toBe(run1[0]?.eventId);
		expect(run0[0]?.eventId).toContain(":r0:run:");
		expect(run1[0]?.eventId).toContain(":r1:run:");
	});
});
