/**
 * P1-1 evidence handoff contracts.
 *
 * Failure modes covered:
 * - child spawn loses goals/acceptance/facts/questions/failures/scope/ownership
 * - stale version markers disappear or cannot be detected
 * - reviewer context still carries author conclusions (including broken fences)
 * - parent claims valid_context / continues when handoff is missing, empty-scope, or stale
 * - malformed facts vanish silently
 */
import { describe, expect, test } from "bun:test";
import {
	buildEvidenceHandoff,
	decideWorkerReuse,
	ensureEvidenceHandoffContext,
	extractEvidenceHandoffFromContext,
	inspectEvidenceHandoffContext,
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

	test("rejects wrong kind/version and malformed facts instead of inventing or dropping silently", () => {
		expect(parseEvidenceHandoff({ kind: "stage_handoff", v: 1 })).toBeNull();
		expect(parseEvidenceHandoff({ kind: "evidence_handoff", v: 2 })).toBeNull();
		expect(extractEvidenceHandoffFromContext("## plain notes\nno fence")).toBeNull();
		expect(() =>
			buildEvidenceHandoff({
				confirmedFacts: [{ id: "x", version: "", statement: "missing version" }],
			}),
		).toThrow(/evidence_handoff_malformed_facts/);
		expect(
			parseEvidenceHandoff({
				kind: "evidence_handoff",
				v: 1,
				confirmedFacts: [{ id: "x", version: "v1" }],
			}),
		).toBeNull();
		expect(() =>
			serializeEvidenceHandoff({
				kind: "evidence_handoff",
				v: 2,
			} as never),
		).toThrow(/evidence_handoff_serialize_invalid/);
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

	test("prepareSubagentContext projects by class, restores worker fields, and strips broken reviewer fences", () => {
		const handoff = sampleHandoff();
		const context = renderEvidenceHandoffContext(handoff, { preamble: "Contract: keep public API" });
		const reviewCtx = prepareSubagentContext(context, "review");
		expect(reviewCtx).toBeDefined();
		const reviewExtracted = extractEvidenceHandoffFromContext(reviewCtx!);
		expect(reviewExtracted?.handoff.authorConclusions).toBeUndefined();
		expect(reviewExtracted?.handoff.acceptance).toEqual(handoff.acceptance);
		expect(reviewExtracted?.preamble).toContain("Contract");

		const workerCtx = prepareSubagentContext(context, "worker");
		const workerExtracted = extractEvidenceHandoffFromContext(workerCtx!);
		expect(workerExtracted?.handoff.goals).toEqual(handoff.goals);
		expect(workerExtracted?.handoff.acceptance).toEqual(handoff.acceptance);
		expect(workerExtracted?.handoff.confirmedFacts).toEqual(handoff.confirmedFacts);
		expect(workerExtracted?.handoff.openQuestions).toEqual(handoff.openQuestions);
		expect(workerExtracted?.handoff.failedAttempts).toEqual(handoff.failedAttempts);
		expect(workerExtracted?.handoff.changeScope).toEqual(handoff.changeScope);
		expect(workerExtracted?.handoff.verificationOwnership).toEqual(handoff.verificationOwnership);
		expect(workerExtracted?.handoff.authorConclusions).toEqual(handoff.authorConclusions);

		expect(prepareSubagentContext("just freeform notes", "review")).toBe("just freeform notes");
		expect(prepareSubagentContext("  ", "worker")).toBeUndefined();

		const broken = [
			"Keep preamble",
			"```evidence-handoff",
			JSON.stringify({
				kind: "evidence_handoff",
				v: 2,
				authorConclusions: ["Author thinks this is perfect"],
				acceptance: ["should not reach reviewer"],
			}),
			"```",
		].join("\n");
		const scrubbed = prepareSubagentContext(broken, "review");
		expect(scrubbed).toBe("Keep preamble");
		expect(scrubbed).not.toContain("Author thinks this is perfect");
		expect(scrubbed).not.toContain("evidence-handoff");
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

		expect(decideWorkerReuse({ candidate: { id: "WorkerA", status: "idle" } })).toEqual({
			action: "continue",
			reason: "resumable_session",
			agentId: "WorkerA",
		});
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

		const emptyScope = buildEvidenceHandoff({
			goals: ["g"],
			acceptance: ["a"],
			changeScope: {},
		});
		expect(
			decideWorkerReuse({
				candidate: { id: "WorkerA", status: "idle" },
				handoff: emptyScope,
				correctionScope: { paths: ["packages/catalog/src/unrelated.ts"] },
			}),
		).toEqual({ action: "spawn_fresh", reason: "scope_mismatch", agentId: "WorkerA" });

		expect(
			decideWorkerReuse({
				candidate: { id: "WorkerA", status: "idle" },
				handoff: { kind: "evidence_handoff", v: 2 } as never,
			}),
		).toEqual({ action: "spawn_fresh", reason: "invalid_handoff", agentId: "WorkerA" });

		expect(
			decideWorkerReuse({
				candidate: { id: "WorkerA", status: "idle" },
				invalidHandoff: true,
			}),
		).toEqual({ action: "spawn_fresh", reason: "invalid_handoff", agentId: "WorkerA" });
	});
});

describe("ensureEvidenceHandoffContext producer", () => {
	test("synthesizes a fence from contract goals/acceptance when context has none", () => {
		const ensured = ensureEvidenceHandoffContext("Shared freeform brief.", {
			target: ["- packages/coding-agent/src/task/evidence-handoff.ts"],
			acceptance: ["- Child restores structured handoff"],
		});
		const extracted = extractEvidenceHandoffFromContext(ensured ?? "");
		expect(extracted).not.toBeNull();
		expect(extracted!.preamble).toContain("Shared freeform brief");
		expect(extracted!.handoff.goals).toEqual(["- packages/coding-agent/src/task/evidence-handoff.ts"]);
		expect(extracted!.handoff.acceptance).toEqual(["- Child restores structured handoff"]);
		expect(extracted!.handoff.verificationOwnership.owner).toBe("parent");
	});

	test("leaves an existing valid fence alone instead of double-wrapping", () => {
		const handoff = sampleHandoff();
		const context = renderEvidenceHandoffContext(handoff, { preamble: "Keep me" });
		const ensured = ensureEvidenceHandoffContext(context, {
			target: ["- should not replace"],
			acceptance: ["- should not replace"],
		});
		expect(ensured).toBe(context.trim());
		expect(extractEvidenceHandoffFromContext(ensured ?? "")?.handoff.contentFingerprint).toBe(
			handoff.contentFingerprint,
		);
	});
});

describe("reviewer fence safety", () => {
	const broken = [
		"Keep preamble",
		"```evidence-handoff",
		JSON.stringify({
			kind: "evidence_handoff",
			v: 2,
			authorConclusions: ["Author thinks this is perfect"],
		}),
		"```",
	].join("\n");

	test("a prior fence check does not let the next reviewer prepare keep author conclusions", () => {
		// Failure: shared /g lastIndex makes the second detection miss, so the reviewer receives the broken fence.
		ensureEvidenceHandoffContext(broken, { acceptance: ["- do not wrap"] });
		const review = prepareSubagentContext(broken, "review");
		expect(review).toBe("Keep preamble");
		expect(review).not.toContain("Author thinks this is perfect");
		expect(review).not.toContain("evidence-handoff");
	});

	test("a second fence in the postamble does not leak author conclusions to reviewers", () => {
		const handoff = buildEvidenceHandoff({
			goals: ["Ship handoff"],
			acceptance: ["Reviewer keeps acceptance"],
			authorConclusions: ["primary conclusion"],
		});
		const extra = [
			"```evidence-handoff",
			JSON.stringify({
				kind: "evidence_handoff",
				v: 1,
				goals: ["extra"],
				acceptance: ["extra"],
				authorConclusions: ["hidden conclusion"],
			}),
			"```",
		].join("\n");
		const review = prepareSubagentContext(renderEvidenceHandoffContext(handoff, { postamble: extra }), "review");
		const extracted = extractEvidenceHandoffFromContext(review ?? "");
		expect(extracted?.handoff.acceptance).toEqual(["Reviewer keeps acceptance"]);
		expect(extracted?.handoff.authorConclusions).toBeUndefined();
		expect(review).not.toContain("hidden conclusion");
		expect(review).not.toContain("primary conclusion");
	});

	test("an unparseable fence is invalid handoff, not a missing one", () => {
		const inspected = inspectEvidenceHandoffContext(broken);
		expect(inspected).toEqual({ handoff: null, invalid: true });
		expect(inspectEvidenceHandoffContext("freeform only")).toEqual({ handoff: null, invalid: false });
	});

	test("an unterminated fence fails closed for reviewers and is not a missing handoff", () => {
		// Failure: a truncated opener used to miss detection, so reviewers kept author text and reuse continued.
		const truncated = 'brief\n```evidence-handoff\n{broken authorConclusions: ["Author thinks this is perfect"]';
		const inspected = inspectEvidenceHandoffContext(truncated);
		expect(inspected).toEqual({ handoff: null, invalid: true });
		expect(
			decideWorkerReuse({
				candidate: { id: "WorkerA", status: "idle" },
				handoff: inspected.handoff,
				invalidHandoff: inspected.invalid,
			}),
		).toEqual({ action: "spawn_fresh", reason: "invalid_handoff", agentId: "WorkerA" });
		const review = prepareSubagentContext(truncated, "review");
		expect(review).toBe("brief");
		expect(review).not.toContain("Author thinks this is perfect");
		expect(review).not.toContain("evidence-handoff");
	});
});
