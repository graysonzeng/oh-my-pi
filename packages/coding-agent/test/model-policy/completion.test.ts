import { describe, expect, it } from "bun:test";
import {
	evaluateCompletion,
	evaluateOrdinaryContinuation,
	evaluateWorkflowFinalCompletion,
	formatCompletionDiagnostic,
	normalizeOrdinaryObligations,
} from "../../src/model-policy";

describe("evaluateCompletion", () => {
	it("returns inactive success for plain Q&A without obligations", () => {
		const result = evaluateCompletion({
			completionRequirements: {
				requiredArtifacts: [],
				verificationRequired: false,
				scopeRequired: false,
			},
			session: {
				unresolvedItems: [],
				requiredArtifactStatus: [],
				verificationEvidence: [],
				scopeStatus: "adhered",
			},
		});
		expect(result.active).toBe(false);
		expect(result.decision).toBe("success");
		expect(result.failedGuards).toEqual([]);
	});

	it("continues when open unresolved items remain", () => {
		const result = evaluateCompletion({
			completionRequirements: {
				requiredArtifacts: [],
				verificationRequired: false,
				scopeRequired: false,
			},
			session: {
				unresolvedItems: [{ id: "todo-1", kind: "todo", status: "open" }],
				requiredArtifactStatus: [],
				verificationEvidence: [],
				scopeStatus: "adhered",
			},
		});
		expect(result.active).toBe(true);
		expect(result.decision).toBe("continue");
		expect(result.failedGuards).toContain("unresolved_items_must_close");
		expect(result.openUnresolvedIds).toEqual(["todo-1"]);
	});

	it("blocks on verification failure, scope violation, missing artifacts, and unpaired tools", () => {
		const result = evaluateCompletion({
			completionRequirements: {
				requiredArtifacts: ["implementation", "verification"],
				verificationRequired: true,
				scopeRequired: true,
			},
			session: {
				unresolvedItems: [{ id: "f1", kind: "finding", status: "blocked" }],
				requiredArtifactStatus: [
					{ kind: "implementation", present: false },
					{ kind: "verification", present: true },
				],
				verificationEvidence: [{ commandOrCheck: "bun test", status: "failed" }],
				scopeStatus: "violation",
			},
			unpairedToolState: true,
			schemaValid: false,
		});
		expect(result.decision).toBe("blocked");
		expect(result.failedGuards).toEqual(
			expect.arrayContaining([
				"unpaired_tool_call_result",
				"schema_output_validator",
				"unresolved_items_must_close",
				"required_artifacts_must_present",
				"verification_must_pass",
				"scope_must_not_violate",
			]),
		);
		expect(result.missingArtifacts).toEqual(["implementation"]);
	});
});

describe("ordinary explicit obligations", () => {
	it("normalizes Todo/Goal/required-yield/session_stop without NLP", () => {
		const normalized = normalizeOrdinaryObligations({
			todoPhases: [
				{
					name: "Build",
					tasks: [
						{ content: "write code", status: "pending" },
						{ content: "done item", status: "completed" },
					],
				},
			],
			goal: { id: "g1", status: "active", objective: "Ship feature", enabled: true },
			requiredYield: { required: true, satisfied: false },
			sessionStop: { continuationCount: 1, cap: 8, wantsContinuation: true },
		});
		expect(normalized.hasExplicitObligations).toBe(true);
		expect(normalized.obligations.map(o => o.source).sort()).toEqual([
			"goal",
			"required_yield",
			"session_stop",
			"todo",
		]);
		expect(normalized.unresolvedItems.every(i => i.status === "open" || i.status === "blocked")).toBe(true);
	});

	it("does not invent obligations for ordinary chat", () => {
		const result = evaluateOrdinaryContinuation({
			todoPhases: [],
			goal: null,
			requiredYield: null,
			sessionStop: null,
		});
		expect(result.active).toBe(false);
		expect(result.decision).toBe("success");
		expect(result.obligations).toEqual([]);
	});

	it("bounds continuation when todo reminders max is reached", () => {
		const result = evaluateOrdinaryContinuation({
			todoPhases: [{ name: "P", tasks: [{ content: "open", status: "in_progress" }] }],
			todoReminderCapped: true,
		});
		expect(result.active).toBe(true);
		expect(result.decision).toBe("blocked");
		expect(result.continuationCapped).toBe(true);
		expect(result.diagnostics).toContain("todo_reminders_max_reached");
		expect(formatCompletionDiagnostic(result)).toContain("blocked");
	});

	it("bounds session_stop when cap is exhausted", () => {
		const result = evaluateOrdinaryContinuation({
			sessionStop: { continuationCount: 8, cap: 8, wantsContinuation: true },
		});
		expect(result.decision).toBe("blocked");
		expect(result.continuationCapped).toBe(true);
		expect(result.diagnostics.some(d => d.startsWith("session_stop_continuation_cap:"))).toBe(true);
	});
});

describe("evaluateWorkflowFinalCompletion", () => {
	it("cannot complete with missing implementation, open findings, failed checks, or scope violation", () => {
		const missingImpl = evaluateWorkflowFinalCompletion({
			implementation: null,
			openBlockingFindings: [],
			verification: { passed: true, checks: [{ id: "noop", status: "passed" }] },
			scopeStatus: "adhered",
		});
		expect(missingImpl.passed).toBe(false);

		const openFinding = evaluateWorkflowFinalCompletion({
			implementation: { unresolved: [] },
			openBlockingFindings: [{ id: "p0-1" }],
			verification: { passed: true, checks: [{ id: "noop", status: "passed" }] },
			scopeStatus: "adhered",
		});
		expect(openFinding.passed).toBe(false);
		expect(openFinding.openUnresolvedIds).toContain("finding:p0-1");

		const failedVerify = evaluateWorkflowFinalCompletion({
			implementation: { unresolved: [] },
			openBlockingFindings: [],
			verification: {
				passed: false,
				checks: [{ id: "unit", status: "failed", command: "bun test" }],
			},
			scopeStatus: "adhered",
		});
		expect(failedVerify.passed).toBe(false);
		expect(failedVerify.failedGuards).toContain("verification_must_pass");

		const scopeFail = evaluateWorkflowFinalCompletion({
			implementation: { unresolved: [] },
			openBlockingFindings: [],
			verification: { passed: true, checks: [{ id: "noop", status: "passed" }] },
			scopeStatus: "violation",
		});
		expect(scopeFail.passed).toBe(false);
		expect(scopeFail.failedGuards).toContain("scope_must_not_violate");
	});

	it("passes only when implementation, verification, findings, and scope are clean", () => {
		const ok = evaluateWorkflowFinalCompletion({
			implementation: { unresolved: [] },
			openBlockingFindings: [],
			verification: {
				passed: true,
				checks: [{ id: "unit", status: "passed", command: "bun test" }],
			},
			scopeStatus: "adhered",
		});
		expect(ok.passed).toBe(true);
		expect(ok.decision).toBe("success");
	});

	it("treats implementation unresolved list as open work", () => {
		const result = evaluateWorkflowFinalCompletion({
			implementation: { unresolved: ["wire receipts"] },
			openBlockingFindings: [],
			verification: { passed: true, checks: [{ id: "noop", status: "passed" }] },
			scopeStatus: "adhered",
		});
		expect(result.passed).toBe(false);
		expect(result.failedGuards).toContain("unresolved_items_must_close");
	});
});
