import { describe, expect, it } from "bun:test";
import {
	BudgetExhaustedError,
	WorkflowCancelledError,
	WorkflowError,
	WorkflowIdentityError,
	WorkflowPolicyError,
	WorkflowSchemaError,
} from "../../src/workflow/errors";
import { isGateParseRetryCandidate, isNonRetryableGateError } from "../../src/workflow/gate-retry";

describe("gate retry classification (R3/C4)", () => {
	it("does not treat budget, identity, policy, or cancel as gate_parse retry fuel", () => {
		expect(isNonRetryableGateError(new BudgetExhaustedError(1, 1, 1))).toBe(true);
		expect(isNonRetryableGateError(new WorkflowIdentityError("mismatch"))).toBe(true);
		expect(isNonRetryableGateError(new WorkflowPolicyError("forbidden"))).toBe(true);
		expect(isNonRetryableGateError(new WorkflowCancelledError())).toBe(true);
		expect(isNonRetryableGateError(new WorkflowError("cfg", "configuration"))).toBe(true);
		expect(isGateParseRetryCandidate(new BudgetExhaustedError(1, 1, 1))).toBe(false);
		expect(isGateParseRetryCandidate(new WorkflowIdentityError("x"))).toBe(false);
	});

	it("allows schema/parse-style failures to retry once", () => {
		expect(isNonRetryableGateError(new WorkflowSchemaError("bad json"))).toBe(false);
		expect(isGateParseRetryCandidate(new WorkflowSchemaError("bad json"))).toBe(true);
		expect(isGateParseRetryCandidate(new Error("unexpected token"))).toBe(true);
	});
});
