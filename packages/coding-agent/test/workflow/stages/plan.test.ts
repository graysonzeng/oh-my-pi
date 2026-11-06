import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PROFILES } from "../../../src/workflow/default-config";
import { RuntimeAdapter } from "../../../src/workflow/runtime-adapter";
import { PlanStage } from "../../../src/workflow/stages/plan";
import { fakeSession, planArtifact, scriptedRunner } from "../helpers";

describe("PlanStage", () => {
	it("returns schema-validated plan from runtime port only", async () => {
		const stage = new PlanStage(new RuntimeAdapter(scriptedRunner({ plan: planArtifact({ summary: "from-port" }) })));
		const { artifact: plan, usage } = await stage.execute({
			workflowId: "wf1",
			attemptId: "a1",
			profile: DEFAULT_MODEL_PROFILES.claude_planner,
			assignment: "plan",
			context: "ctx",
			session: fakeSession(),
		});
		expect(plan.summary).toBe("from-port");
		expect(plan.kind).toBe("plan");
		expect(usage?.cost?.total).toBe(0.03);
	});
});
