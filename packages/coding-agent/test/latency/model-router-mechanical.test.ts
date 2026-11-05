import { describe, expect, it } from "bun:test";
import {
	buildMechanicalClass,
	classifyImplementerComplexity,
	classifyPlanMechanicalImplementer,
} from "../../src/latency/mechanical-class";
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

	it("keeps complex implementer on Grok and only Flash-routes declared mechanical implementer work", () => {
		const router = new ModelRouter(Object.values(DEFAULT_MODEL_PROFILES));
		expect(router.resolve("implementer").profileId).toBe("grok_implementer");

		const mechanicalClass = buildMechanicalClass({
			class: "mechanical_implement",
			source: "deterministic_rule",
			ref: "plan_scope:single_file_single_step",
			targetRole: "implementer",
		});
		const mechanical = router.resolve("implementer", { mechanicalClass });
		expect(mechanical.profileId).toBe("deepseek_implementer");

		const repairClass = buildMechanicalClass({
			class: "mechanical_repair",
			source: "caller_declaration",
			targetRole: "repair",
		});
		expect(router.resolve("implementer", { mechanicalClass: repairClass }).profileId).toBe("grok_implementer");
	});

	it("classifies single-file single-step plans as mechanical implementer work", () => {
		expect(
			classifyPlanMechanicalImplementer({
				affectedFiles: [{ path: "src/a.ts" }],
				implementationSteps: [{ id: "s1" }],
			})?.class,
		).toBe("mechanical_implement");
		expect(
			classifyPlanMechanicalImplementer({
				affectedFiles: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
				implementationSteps: [{ id: "s1" }, { id: "s2" }],
			}),
		).toBeNull();
		expect(classifyPlanMechanicalImplementer({ affectedFiles: [], implementationSteps: [] })).toBeNull();
	});

	it("routes very-complex implementer work to Astra and falls back to Grok 4.6", () => {
		const router = new ModelRouter(Object.values(DEFAULT_MODEL_PROFILES));
		expect(router.resolve("implementer", { preferVeryComplexImplementer: true }).profileId).toBe(
			"gpt_astra_implementer",
		);
		expect(router.resolve("implementer", { preferVeryComplexImplementer: true }).profile.modelPattern).toEqual([
			"gpt-6-astra",
		]);

		const withoutAstra = new ModelRouter(
			Object.values(DEFAULT_MODEL_PROFILES).filter(profile => profile.id !== "gpt_astra_implementer"),
		);
		const fallback = withoutAstra.resolve("implementer", { preferVeryComplexImplementer: true });
		expect(fallback.profileId).toBe("grok_implementer");
		expect(fallback.profile.modelPattern).toEqual(["grok-4.6"]);
	});

	it("classifies four-file or four-step plans as very complex", () => {
		expect(
			classifyImplementerComplexity({
				affectedFiles: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }, { path: "d.ts" }],
				implementationSteps: [{ id: "s1" }],
			}),
		).toBe("very_complex");
		expect(
			classifyImplementerComplexity({
				affectedFiles: [{ path: "a.ts" }],
				implementationSteps: [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }],
			}),
		).toBe("very_complex");
		expect(
			classifyImplementerComplexity({
				affectedFiles: [{ path: "a.ts" }, { path: "b.ts" }],
				implementationSteps: [{ id: "s1" }, { id: "s2" }],
			}),
		).toBe("complex");
	});
});
