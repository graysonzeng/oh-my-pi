import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	buildEvidenceHandoff,
	decideWorkerReuse,
	ensureEvidenceHandoffContext,
	markEvidenceStale,
	renderEvidenceHandoffContext,
} from "../../src/task/evidence-handoff";
import {
	getEvidenceHandoffObserveSnapshot,
	noteEvidenceHandoffInspect,
	noteEvidenceHandoffReuseDecision,
	observeImpliesFewerUnnecessaryRereads,
	resetEvidenceHandoffObserveForTests,
} from "../../src/task/evidence-handoff-observe";

beforeEach(() => {
	resetEvidenceHandoffObserveForTests();
});

afterEach(() => {
	resetEvidenceHandoffObserveForTests();
});

describe("evidence-handoff observe (S1)", () => {
	it("covers generate → consume valid → reuse continue without schema expansion", () => {
		const context = ensureEvidenceHandoffContext(undefined, {
			target: ["- packages/coding-agent/src/task/evidence-handoff.ts"],
			acceptance: ["- observe path covered"],
		});
		expect(context).toContain("```evidence-handoff");
		expect(getEvidenceHandoffObserveSnapshot().generate).toBe(1);

		noteEvidenceHandoffInspect("valid");
		const decision = decideWorkerReuse({
			candidate: { id: "WorkerA", status: "idle" },
			handoff: buildEvidenceHandoff({
				goals: ["g"],
				acceptance: ["a"],
				changeScope: { paths: ["packages/coding-agent/src/task/evidence-handoff.ts"] },
			}),
			correctionScope: { paths: ["packages/coding-agent/src/task/evidence-handoff.ts"] },
		});
		noteEvidenceHandoffReuseDecision(decision, { agentId: "WorkerA" });

		const snap = getEvidenceHandoffObserveSnapshot();
		expect(snap.consumeValid).toBe(1);
		expect(snap.reuseContinue).toBe(1);
		expect(snap.rejectStale).toBe(0);
		expect(observeImpliesFewerUnnecessaryRereads(snap)).toBe(true);
	});

	it("records reject-stale so parents must re-read rather than reuse", () => {
		const handoff = markEvidenceStale(
			buildEvidenceHandoff({
				goals: ["g"],
				acceptance: ["a"],
				confirmedFacts: [{ id: "f1", version: "v1", statement: "tree at abc" }],
			}),
			"f1",
			"tree moved",
		);
		const context = renderEvidenceHandoffContext(handoff);
		expect(context).toContain("evidence-handoff");

		noteEvidenceHandoffInspect("valid");
		const decision = decideWorkerReuse({
			candidate: { id: "WorkerA", status: "parked" },
			handoff,
		});
		noteEvidenceHandoffReuseDecision(decision, { agentId: "WorkerA" });

		const snap = getEvidenceHandoffObserveSnapshot();
		expect(decision).toEqual({ action: "spawn_fresh", reason: "stale_evidence", agentId: "WorkerA" });
		expect(snap.rejectStale).toBe(1);
		expect(snap.reuseSpawnFresh).toBe(1);
		expect(observeImpliesFewerUnnecessaryRereads(snap)).toBe(false);
	});

	it("does not invent acceptance metrics from observe counters alone", () => {
		ensureEvidenceHandoffContext("brief", {
			target: ["- x"],
			acceptance: ["- y"],
		});
		const snap = getEvidenceHandoffObserveSnapshot();
		// Observe path is live; cost-per-accepted remains a Package 1 future until
		// parent_final_verification receipts exist (asserted in delivery-cost tests).
		expect(snap.generate).toBeGreaterThan(0);
		expect("costPerAcceptedTask" in snap).toBe(false);
	});
});
