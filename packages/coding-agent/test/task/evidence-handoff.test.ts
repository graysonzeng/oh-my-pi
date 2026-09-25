/**
 * P1-1 evidence handoff contracts.
 *
 * Failure modes covered:
 * - child spawn loses goals/acceptance/facts/questions/failures/scope/ownership
 * - stale version markers disappear or cannot be detected
 * - reviewer context still carries author conclusions
 * - parent keeps spawning fresh when an idle worker still has valid context
 */
import { describe, expect, test } from "bun:test";
import {
	buildEvidenceHandoff,
	decideWorkerReuse,
	extractEvidenceHandoffFromContext,
	invalidateFactIfVersionMismatch,
	listStaleEvidence,
	markEvidenceStale,
	parseEvidenceHandoff,
	prepareSubagentContext,
	projectEvidenceHandoff,
	renderEvidenceHandoffContext,
	serializeEvidenceHandoff,
} from "../../src/task/evidence-handoff";

function sampleHandoff() {
	return buildEvidenceHandoff({
		goals: ["Reduce start-over on related corrections"],
		acceptance: ["Child restores acceptance + versioned facts", "Reviewer omits author conclusions"],
		confirmedFacts: [
			{
				id: "fact-stage-handoff",
				version: "sha256:abc123",
				statement: "stage-handoff already persists plan acceptance summaries",
				evidence: "packages/coding-agent/src/workflow/stage-handoff.ts",
				recoveryUri: "artifact://42",
			},
			{
				id: "fact-prompt-reuse",
				version: "rev:9",
				statement: "subagent prompt already asks workers to reuse versioned evidence",
			},
		],
		openQuestions: ["Does live corpus show fewer re-reads after handoff?"],
		failedAttempts: [{ attempt: "Full parent-history fork", reason: "inherits stale judgments" }],
		changeScope: {
			paths: ["packages/coding-agent/src/task/evidence-handoff.ts"],
			symbols: ["prepareSubagentContext"],
			nonGoals: ["Track E prompt edits", "new memory platform"],
		},
		verificationOwnership: {
			owner: "parent",
			commands: ["bun test packages/coding-agent/test/task/evidence-handoff.test.ts"],
			notes: "Mechanism tests only; no live 返工 claim",
		},
		authorConclusions: ["This approach will cut exploration by 30%"],
	});
}

describe("evidence handoff build/parse/serialize", () => {
	test("round-trips required fields through context fence and restores them", () => {
		const handoff = sampleHandoff();
		const context = renderEvidenceHandoffContext(handoff, {
			preamble: "# Shared brief\nKeep interfaces stable.",
		});
		const extracted = extractEvidenceHandoffFromContext(context);
		expect(extracted).not.toBeNull();
		expect(extracted!.preamble).toContain("Shared brief");
		expect(extracted!.handoff.goals).toEqual(handoff.goals);
		expect(extracted!.handoff.acceptance).toEqual(handoff.acceptance);
		expect(extracted!.handoff.confirmedFacts).toEqual(handoff.confirmedFacts);
		expect(extracted!.handoff.openQuestions).toEqual(handoff.openQuestions);
		expect(extracted!.handoff.failedAttempts).toEqual(handoff.failedAttempts);
		expect(extracted!.handoff.changeScope).toEqual(handoff.changeScope);
		expect(extracted!.handoff.verificationOwnership).toEqual(handoff.verificationOwnership);
		expect(extracted!.handoff.authorConclusions).toEqual(handoff.authorConclusions);
		expect(extracted!.handoff.contentFingerprint).toBe(handoff.contentFingerprint);

		const again = parseEvidenceHandoff(
			JSON.parse(serializeEvidenceHandoff(handoff).split("\n").slice(1, -1).join("\n")),
		);
		expect(again?.contentFingerprint).toBe(handoff.contentFingerprint);
	});

	test("rejects wrong kind/version instead of inventing a handoff", () => {
		expect(parseEvidenceHandoff({ kind: "stage_handoff", v: 1 })).toBeNull();
		expect(parseEvidenceHandoff({ kind: "evidence_handoff", v: 2 })).toBeNull();
		expect(extractEvidenceHandoffFromContext("## plain notes\nno fence")).toBeNull();
	});
});

describe("stale / version invalidation", () => {
	test("marks and lists stale facts; version mismatch invalidates", () => {
		const handoff = sampleHandoff();
		const stale = markEvidenceStale(handoff, "fact-prompt-reuse", "file edited after capture");
		expect(listStaleEvidence(stale).map(f => f.id)).toEqual(["fact-prompt-reuse"]);
		expect(listStaleEvidence(stale)[0]?.staleReason).toBe("file edited after capture");

		const mismatched = invalidateFactIfVersionMismatch(handoff, "fact-stage-handoff", "sha256:other");
		expect(listStaleEvidence(mismatched).map(f => f.id)).toEqual(["fact-stage-handoff"]);
		expect(listStaleEvidence(mismatched)[0]?.staleReason).toBe("version_mismatch");

		const same = invalidateFactIfVersionMismatch(handoff, "fact-stage-handoff", "sha256:abc123");
		expect(listStaleEvidence(same)).toEqual([]);
	});
});

describe("role projection", () => {
	test("reviewer projection drops author conclusions but keeps raw evidence fields", () => {
		const handoff = sampleHandoff();
		const forReviewer = projectEvidenceHandoff(handoff, "reviewer");
		expect(forReviewer.authorConclusions).toBeUndefined();
		expect(forReviewer.goals).toEqual(handoff.goals);
		expect(forReviewer.acceptance).toEqual(handoff.acceptance);
		expect(forReviewer.confirmedFacts).toEqual(handoff.confirmedFacts);
		expect(forReviewer.failedAttempts).toEqual(handoff.failedAttempts);
		expect(forReviewer.verificationOwnership).toEqual(handoff.verificationOwnership);

		const forWorker = projectEvidenceHandoff(handoff, "worker");
		expect(forWorker.authorConclusions).toEqual(handoff.authorConclusions);
	});

	test("prepareSubagentContext projects by performance class and leaves freeform alone", () => {
		const context = renderEvidenceHandoffContext(sampleHandoff(), { preamble: "Contract: keep public API" });
		const reviewCtx = prepareSubagentContext(context, "review");
		expect(reviewCtx).toBeDefined();
		const reviewExtracted = extractEvidenceHandoffFromContext(reviewCtx!);
		expect(reviewExtracted?.handoff.authorConclusions).toBeUndefined();
		expect(reviewExtracted?.handoff.acceptance.length).toBeGreaterThan(0);
		expect(reviewExtracted?.preamble).toContain("Contract");

		const workerCtx = prepareSubagentContext(context, "worker");
		const workerExtracted = extractEvidenceHandoffFromContext(workerCtx!);
		expect(workerExtracted?.handoff.authorConclusions).toEqual(sampleHandoff().authorConclusions);

		expect(prepareSubagentContext("just freeform notes", "review")).toBe("just freeform notes");
		expect(prepareSubagentContext("  ", "worker")).toBeUndefined();
	});
});

describe("worker reuse decision", () => {
	test("continues idle worker with valid overlapping context; otherwise spawns fresh", () => {
		const handoff = sampleHandoff();
		expect(
			decideWorkerReuse({
				candidate: { id: "WorkerA", status: "idle" },
				handoff,
				correctionScope: { paths: ["packages/coding-agent/src/task/evidence-handoff.ts"] },
			}),
		).toEqual({ action: "continue", reason: "valid_context", agentId: "WorkerA" });

		expect(decideWorkerReuse({ candidate: null, handoff })).toEqual({
			action: "spawn_fresh",
			reason: "no_candidate",
		});
		expect(decideWorkerReuse({ candidate: { id: "WorkerA", status: "running" }, handoff })).toEqual({
			action: "spawn_fresh",
			reason: "not_resumable",
			agentId: "WorkerA",
		});
		expect(decideWorkerReuse({ candidate: { id: "WorkerA", status: "idle", isolated: true }, handoff })).toEqual({
			action: "spawn_fresh",
			reason: "isolated",
			agentId: "WorkerA",
		});

		const stale = markEvidenceStale(handoff, "fact-stage-handoff", "tree moved");
		expect(decideWorkerReuse({ candidate: { id: "WorkerA", status: "parked" }, handoff: stale })).toEqual({
			action: "spawn_fresh",
			reason: "stale_evidence",
			agentId: "WorkerA",
		});

		expect(
			decideWorkerReuse({
				candidate: { id: "WorkerA", status: "idle" },
				handoff,
				correctionScope: { paths: ["packages/catalog/src/unrelated.ts"] },
			}),
		).toEqual({ action: "spawn_fresh", reason: "scope_mismatch", agentId: "WorkerA" });
	});
});
