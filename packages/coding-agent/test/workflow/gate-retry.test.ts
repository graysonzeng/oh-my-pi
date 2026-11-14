import { describe, expect, it } from "bun:test";
import {
	BudgetExhaustedError,
	WorkflowCancelledError,
	WorkflowError,
	WorkflowIdentityError,
	WorkflowPolicyError,
	WorkflowSchemaError,
	WorkflowTimeoutError,
} from "../../src/workflow/errors";
import { classifyGateError, isGateParseRetryCandidate, isNonRetryableGateError } from "../../src/workflow/gate-retry";
import { GateParseError } from "../../src/workflow/schemas";

describe("gate retry classification (R3/C4)", () => {
	it("does not treat budget, identity, policy, cancel, auth, or timeout as gate_parse retry fuel", () => {
		expect(isNonRetryableGateError(new BudgetExhaustedError(1, 1, 1))).toBe(true);
		expect(isNonRetryableGateError(new WorkflowIdentityError("mismatch"))).toBe(true);
		expect(isNonRetryableGateError(new WorkflowPolicyError("forbidden"))).toBe(true);
		expect(isNonRetryableGateError(new WorkflowCancelledError())).toBe(true);
		expect(isNonRetryableGateError(new WorkflowError("cfg", "configuration"))).toBe(true);
		expect(isNonRetryableGateError(new WorkflowError("denied", "authentication"))).toBe(true);
		expect(isNonRetryableGateError(new WorkflowTimeoutError("slow"))).toBe(true);
		expect(isGateParseRetryCandidate(new BudgetExhaustedError(1, 1, 1))).toBe(false);
		expect(isGateParseRetryCandidate(new WorkflowIdentityError("x"))).toBe(false);
		expect(classifyGateError(new WorkflowError("denied", "authentication"))).toBe("abort_original");
		expect(classifyGateError(new WorkflowTimeoutError("slow"))).toBe("abort_original");
		expect(classifyGateError(new WorkflowError("quota", "quota"))).toBe("abort_original");
		expect(classifyGateError(new Error("unexpected token"))).toBe("abort_original");
	});

	it("retries schema, JSON, and recoverable gate output defects", () => {
		expect(isGateParseRetryCandidate(new WorkflowSchemaError("bad json"))).toBe(true);
		expect(classifyGateError(new SyntaxError("Unexpected token"))).toBe("retry_parse");
		const zod = new Error("invalid");
		zod.name = "ZodError";
		expect(classifyGateError(zod)).toBe("retry_parse");
		expect(classifyGateError(new GateParseError("subject_mismatch", "subject"))).toBe("retry_parse");
		expect(classifyGateError(new GateParseError("revision_requires_finding", "finding"))).toBe("retry_parse");
		expect(classifyGateError(new GateParseError("pass_open_blockers", "blockers"))).toBe("retry_parse");
	});

	it("does not retry identity, stale id, or missing snapshot gate failures", () => {
		expect(classifyGateError(new GateParseError("identity_mismatch", "family"))).toBe("abort_original");
		expect(classifyGateError(new GateParseError("stale_workflow_id", "stale"))).toBe("abort_original");
		expect(classifyGateError(new GateParseError("stale_attempt_id", "stale"))).toBe("abort_original");
		expect(classifyGateError(new GateParseError("missing_requirements_snapshot", "missing"))).toBe("abort_original");
	});
});
