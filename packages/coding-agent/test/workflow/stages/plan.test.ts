import { beforeEach, describe, expect, it } from "bun:test";
import { PlanStage } from "../../../src/workflow/stages/plan";

describe("PlanStage", () => {
	let stage: PlanStage;

	beforeEach(() => {
		stage = new PlanStage();
	});

	it("executes plan stage with artifact", async () => {
		const result = await stage.execute({ workflowId: "wf1", attemptId: "att1", summary: "test" });
		expect(result.kind).toBe("plan");
		expect(result.summary).toBe("test");
	});
});
