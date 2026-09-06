import { describe, expect, it } from "bun:test";
import {
	DEFAULT_MODEL_PROFILES,
	defaultProfilesCoverTargetModels,
	TARGET_MODEL_PATTERNS,
} from "../../src/workflow/default-config";
import { ModelProfileRegistry } from "../../src/workflow/model-profile-registry";
import { ModelRouter } from "../../src/workflow/model-router";
import { tokenSavingsFraction } from "../../src/workflow/quality-gate";
import { prepareWorkflowInvocation } from "../../src/workflow/runtime-invocation";
import { transformToolsForProfile } from "../../src/workflow/schema-enhancer";
import { processToolOutput } from "../../src/workflow/tool-output-manager";
import type { ModelProfile, WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession } from "./helpers";

function requestFor(profile: ModelProfile, role: WorkflowAgentRequest["role"] = "implementer"): WorkflowAgentRequest {
	return {
		workflowId: "wf_opt",
		attemptId: "att_opt",
		role: profile.roles.includes(role) ? role : profile.roles[0]!,
		profile,
		assignment: "Implement feature X carefully",
		context: "repo has src/a.ts",
		outputSchema: {
			type: "object",
			properties: { summary: { type: "string" } },
			required: ["summary"],
		},
		session: fakeSession(),
	};
}

describe("target models + quality-first defaults", () => {
	it("covers all required model patterns in default profiles", () => {
		const coverage = defaultProfilesCoverTargetModels();
		expect(coverage.missing).toEqual([]);
		expect(coverage.ok).toBe(true);
		expect(TARGET_MODEL_PATTERNS).toHaveLength(7);
	});

	it("registers all default profiles including toolAliases without error", () => {
		const registry = new ModelProfileRegistry(Object.values(DEFAULT_MODEL_PROFILES));
		expect(registry.list().length).toBeGreaterThanOrEqual(8);
		const grok = registry.get("grok_implementer");
		expect(grok?.toolAliases?.bash).toBe("run_command");
		expect(grok?.toolStrategy?.outputTruncation?.enabled).toBe(true);
	});

	it("quality-first role matrix: plan/review prefer T0 vendors; implement prefers cost-efficient", () => {
		const router = new ModelRouter(Object.values(DEFAULT_MODEL_PROFILES));
		const plan = router.resolve("planner");
		expect(["anthropic", "openai", "zhipu"]).toContain(plan.vendor);
		// Primary planner is Opus-oriented claude_planner
		expect(plan.profileId).toBe("claude_planner");
		expect(String(plan.profile.modelPattern)).toMatch(/claude-opus-5/);

		const review = router.resolve("code_reviewer", { implementerVendor: "xai" });
		expect(["anthropic", "openai"]).toContain(review.vendor);

		const implement = router.resolve("implementer");
		// Grok 4.6 first for relatively complex implement, Astra for very complex, Flash only for mechanical
		expect(["xai", "openai", "deepseek"]).toContain(implement.vendor);
		expect(implement.profileId).toBe("grok_implementer");
		expect(implement.profile.modelPattern).toEqual(["grok-4.6"]);
	});

	it("default implementer chain: exact patterns, efforts, no wildcards, no GLM/Terra/Luna", () => {
		const implementers = Object.values(DEFAULT_MODEL_PROFILES).filter(p => p.roles.includes("implementer"));
		// Registration order = router preference; main_agent_fallback is a runtime-registered last resort.
		expect(implementers.map(p => p.id)).toEqual([
			"grok_implementer",
			"gpt_astra_implementer",
			"deepseek_implementer",
		]);
		const [grok, astra, deepseek] = implementers.map(p => p.modelPattern);
		expect(grok).toEqual(["grok-4.6"]);
		expect(astra).toEqual(["gpt-6-astra"]);
		expect(deepseek).toEqual(["deepseek-v4-flash"]);
		const efforts = Object.values(DEFAULT_MODEL_PROFILES)
			.filter(p => p.roles.includes("implementer"))
			.map(p => p.thinkingLevel);
		expect(efforts.map(level => String(level))).toEqual(["high", "max", "max"]);
		for (const p of implementers) {
			const patterns = Array.isArray(p.modelPattern) ? p.modelPattern : [p.modelPattern];
			for (const pattern of patterns) expect(pattern).not.toMatch(/[*?[\]{}]/);
		}
		const ids = implementers.map(p => p.id);
		expect(ids).not.toContain("glm_implementer");
		expect(ids).not.toContain("gpt_terra_implementer");
		expect(ids).not.toContain("deepseek_bulk");
		expect(ids).not.toContain("gpt_luna_implementer");
	});
});

describe("prepareWorkflowInvocation applies strategies", () => {
	it("uses concise-claude style for anthropic planner vs explicit-grok for implementer", () => {
		const claudePrep = prepareWorkflowInvocation(requestFor(DEFAULT_MODEL_PROFILES.claude_planner, "planner"));
		const grokPrep = prepareWorkflowInvocation(requestFor(DEFAULT_MODEL_PROFILES.grok_implementer, "implementer"));

		expect(claudePrep.styleMarker).toBe("concise-claude");
		expect(claudePrep.context).toMatch(/concise-claude|expert planner/i);

		expect(grokPrep.styleMarker).toBe("explicit-grok");
		expect(grokPrep.context).toMatch(/explicit-grok|BEGIN NOW|ONLY job/i);
		expect(grokPrep.context).toMatch(/INSTRUCTION FORMAT: Prefer numbered steps/);
		expect(grokPrep.context).toMatch(/Output valid JSON/);

		// Distinct markers
		expect(claudePrep.context).not.toEqual(grokPrep.context);
	});

	it("enhances schema for profiles with addDescriptions", () => {
		const prep = prepareWorkflowInvocation(requestFor(DEFAULT_MODEL_PROFILES.claude_planner, "planner"));
		const schema = prep.outputSchema as { properties?: Record<string, { description?: string }> };
		expect(schema.properties?.summary?.description).toBeTruthy();
	});

	it("processToolResult shortens oversized bash while keeping ERROR", () => {
		const prep = prepareWorkflowInvocation(requestFor(DEFAULT_MODEL_PROFILES.grok_implementer));
		const huge = `${"ok line\n".repeat(300)}ERROR: compile failed\n`;
		const processed = prep.processToolResult("bash", huge, { exitCode: 1 });
		expect(processed.length).toBeLessThan(huge.length);
		expect(processed).toMatch(/ERROR|Exit code/);
	});

	it("transformTools applies aliases from profile", () => {
		const prep = prepareWorkflowInvocation(requestFor(DEFAULT_MODEL_PROFILES.grok_implementer));
		const tools = prep.transformTools([
			{ name: "bash", schema: { type: "object", properties: { command: { type: "string" } } } },
			{ name: "read", schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
		]);
		expect(tools[0]?.customWireName).toBe("run_command");
		expect(tools[1]?.schema?.properties).toHaveProperty("file_path");
	});
});

describe("fake-provider token comparison", () => {
	it("optimized tool outputs use materially fewer tokens than full dumps", () => {
		const full = Array.from({ length: 500 }, (_, i) => `test pass case_${i} duration=1ms`).join("\n");
		const strategy = DEFAULT_MODEL_PROFILES.grok_implementer.toolStrategy;
		const optimized = processToolOutput(full, "bash", strategy, { exitCode: 0 });
		const baselineTokens = Math.ceil(full.length / 4);
		const optimizedTokens = Math.ceil(optimized.length / 4);
		const savings = tokenSavingsFraction(baselineTokens, optimizedTokens);
		// Design targets 40–60% tool/context savings on aggressive strategies
		expect(savings).toBeGreaterThanOrEqual(0.4);
		expect(optimizedTokens).toBeLessThan(baselineTokens);
	});

	it("alias transform is applied on the real transformToolsForProfile entry point", () => {
		const out = transformToolsForProfile(
			[{ name: "bash", customWireName: undefined }],
			DEFAULT_MODEL_PROFILES.grok_implementer,
		);
		expect(out[0]?.customWireName).toBe("run_command");
	});
});

describe("prepare attaches session.workflowToolOptimization for live tools", () => {
	it("installs processResult + toolAliases on session so tools can apply them", () => {
		const prep = prepareWorkflowInvocation(requestFor(DEFAULT_MODEL_PROFILES.grok_implementer));
		const opt = prep.session.workflowToolOptimization;
		expect(opt).toBeDefined();
		expect(opt?.toolAliases?.bash).toBe("run_command");
		const huge = `${"line\n".repeat(300)}ERROR: boom\n`;
		const out = opt!.processResult("bash", huge, { exitCode: 1 });
		expect(out.length).toBeLessThan(huge.length);
		// Same function as prepared.processToolResult
		expect(prep.processToolResult("bash", huge, { exitCode: 1 })).toBe(out);
	});
});
