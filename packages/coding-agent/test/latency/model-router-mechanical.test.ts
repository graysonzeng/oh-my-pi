import { describe, expect, it } from "bun:test";
import { buildMechanicalClass } from "../../src/latency/mechanical-class";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { ModelRouter } from "../../src/workflow/model-router";
import type { ModelProfile } from "../../src/workflow/types";

describe("mechanical role split routing", () => {
	it("prefers Flash before xAI mechanical narrowing but never applies the class to plan review", () => {
		const flashRepair: ModelProfile = {
			...DEFAULT_MODEL_PROFILES.deepseek_implementer,
			id: "flash_repair",
			roles: ["repair"],
		};
		const competingXaiRepair: ModelProfile = {
			...DEFAULT_MODEL_PROFILES.grok_repair,
			id: "competing_xai_repair",
			roles: ["repair"],
		};
		const router = new ModelRouter([
			competingXaiRepair,
			flashRepair,
			DEFAULT_MODEL_PROFILES.claude_plan_reviewer,
			DEFAULT_MODEL_PROFILES.gpt_plan_reviewer,
		]);
		const mechanicalClass = buildMechanicalClass({
			class: "mechanical_repair",
			source: "caller_declaration",
			targetRole: "repair",
		});

		const repair = router.resolve("repair", { mechanicalClass, roleStaticSplitEnabled: true });
		expect(repair.profileId).toBe("flash_repair");

		const planReviewer = router.resolve("plan_reviewer", { mechanicalClass, roleStaticSplitEnabled: true });
		expect(planReviewer.profileId).toBe("claude_plan_reviewer");
	});
});
