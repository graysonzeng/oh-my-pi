import { describe, expect, it } from "bun:test";
import { getNextStage, isValidTransition, VALID_TRANSITIONS } from "../../src/workflow/transitions";
import type { WorkflowStatus } from "../../src/workflow/types";

describe("Workflow Transitions", () => {
	it("all valid transitions succeed", () => {
		const validFromTo: [WorkflowStatus, WorkflowStatus][] = [
			["created", "planning"],
			["planning", "plan_review"],
			["plan_review", "implementing"],
			["implementing", "implementation_verify"],
			["implementation_verify", "code_review"],
			["code_review", "final_verify"],
			["final_verify", "completed"],
			// repair cases
			["implementation_verify", "repairing"],
			["code_review", "repairing"],
			["repairing", "implementation_verify"],
		];
		for (const [from, to] of validFromTo) {
			expect(isValidTransition(from, to)).toBe(true);
			expect(VALID_TRANSITIONS[from].includes(to)).toBe(true);
		}
	});

	it("invalid transitions fail", () => {
		const invalidCases: [WorkflowStatus, WorkflowStatus][] = [
			["planning", "implementing"], // must go through review
			["code_review", "implementing"],
			["completed", "planning"],
		];
		for (const [from, to] of invalidCases) {
			expect(isValidTransition(from, to)).toBe(false);
		}
	});

	it("getNextStage returns correct next stage", () => {
		expect(getNextStage("planning", "approved")).toBe("plan_review");
		expect(getNextStage("plan_review", "approved")).toBe("implementing");
		expect(getNextStage("implementing", null)).toBe("implementation_verify");
		expect(getNextStage("final_verify", "changes_requested")).toBe("completed");
		expect(getNextStage("created", null)).toBeNull();
	});
});
