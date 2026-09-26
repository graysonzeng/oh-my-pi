import { describe, expect, it } from "bun:test";
import {
	DEFAULT_MODEL_OPTIMIZATION_PROFILES,
	FALLBACK_TRUNCATION_RULES,
} from "../../src/model-optimization/default-profiles";
import { DEFAULT_MODEL_PROFILES, DEFAULT_TRUNCATION_RULES } from "../../src/workflow/default-config";
import {
	buildConservativeOutputTruncation,
	buildOutputTruncation,
	ORDINARY_TRUNCATION_BYTE_LINE_OPTS,
	DEFAULT_TRUNCATION_RULES as TOOL_DEFAULT_TRUNCATION,
} from "../../src/workflow/tool-output-manager";

describe("shared truncation / defaults source (R6/F1)", () => {
	it("ordinary and workflow truncation both consume the same DEFAULT_TRUNCATION_RULES export", () => {
		expect(DEFAULT_TRUNCATION_RULES).toBe(TOOL_DEFAULT_TRUNCATION);
		expect(FALLBACK_TRUNCATION_RULES).toBe(TOOL_DEFAULT_TRUNCATION);
		expect(DEFAULT_TRUNCATION_RULES.length).toBeGreaterThan(0);
		expect(Object.keys(DEFAULT_MODEL_OPTIMIZATION_PROFILES).length).toBeGreaterThan(0);
	});

	it("shared builders produce identical ordinary matrices for both profile tables", () => {
		const ordinary = buildOutputTruncation(ORDINARY_TRUNCATION_BYTE_LINE_OPTS);
		expect(ordinary.rules).toEqual(TOOL_DEFAULT_TRUNCATION);
		const conservative = buildConservativeOutputTruncation({ maxBytes: 2000, maxLines: 40 });
		expect(conservative.enabled).toBe(true);
		expect(conservative.rules.find(r => r.toolName === "bash")?.maxBytes).toBe(2000);
		expect(conservative.rules.find(r => r.toolName === "read")?.maxBytes).toBe(4000);
	});

	it("keeps workflow verificationCommands and quality defaults stable (no silent default churn)", () => {
		expect(DEFAULT_MODEL_PROFILES.claude_planner?.roles).toContain("planner");
		const anyImpl = Object.values(DEFAULT_MODEL_PROFILES).find(p => p.roles.includes("implementer"));
		expect(anyImpl?.toolStrategy?.outputTruncation?.enabled).toBe(true);
		// Intentional divergence preserved: ordinary summarization off, workflow on.
		const ordinary = Object.values(DEFAULT_MODEL_OPTIMIZATION_PROFILES)[0];
		expect(ordinary?.toolStrategy?.resultSummarization?.enabled).toBe(false);
		expect(anyImpl?.toolStrategy?.resultSummarization?.enabled).toBe(true);
	});
});
