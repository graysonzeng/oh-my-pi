import { describe, expect, it } from "bun:test";
import { getNextStage, isValidTransition, VALID_TRANSITIONS } from "../../src/workflow/transitions";
import type { WorkflowStatus } from "../../src/workflow/types";

const ALL_STATUSES = Object.keys(VALID_TRANSITIONS) as WorkflowStatus[];

describe("Workflow Transitions", () => {
	it("every listed transition succeeds", () => {
		for (const from of ALL_STATUSES) {
			for (const to of VALID_TRANSITIONS[from]) {
				expect(isValidTransition(from, to)).toBe(true);
			}
		}
	});

	it("every unlisted from×to fails closed", () => {
		for (const from of ALL_STATUSES) {
			const allowed = new Set(VALID_TRANSITIONS[from]);
			for (const to of ALL_STATUSES) {
				if (!allowed.has(to)) {
					expect(isValidTransition(from, to)).toBe(false);
				}
			}
		}
	});

	it("getNextStage handles review and verify decisions", () => {
		expect(getNextStage("created", null)).toBe("planning");
		expect(getNextStage("planning", null)).toBe("plan_review");
		expect(getNextStage("plan_review", "approved")).toBe("implementing");
		expect(getNextStage("plan_review", "changes_requested")).toBe("planning");
		expect(getNextStage("plan_review", "blocked")).toBe("blocked");
		expect(getNextStage("implementing", null)).toBe("implementation_verify");
		expect(getNextStage("implementation_verify", "passed")).toBe("code_review");
		expect(getNextStage("implementation_verify", "failed")).toBe("repairing");
		expect(getNextStage("code_review", "approved")).toBe("final_verify");
		expect(getNextStage("code_review", "changes_requested")).toBe("repairing");
		expect(getNextStage("code_review", "blocked")).toBe("blocked");
		expect(getNextStage("repairing", null)).toBe("implementation_verify");
		expect(getNextStage("final_verify", "passed")).toBe("completed");
		expect(getNextStage("final_verify", "failed")).toBe("repairing");
		expect(getNextStage("completed", null)).toBeNull();
	});
});
