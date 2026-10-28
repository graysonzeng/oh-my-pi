import { describe, expect, it } from "bun:test";
import {
	enhanceSchemaForProfile,
	remapSchemaProperties,
	reverseArgumentAliases,
	transformToolsForProfile,
} from "../../src/workflow/schema-enhancer";
import type { ModelProfile } from "../../src/workflow/types";

const baseProfile = {
	id: "t",
	vendor: "xai",
	modelPattern: "grok-4.6",
	roles: ["implementer"] as const,
	promptTemplate: "implementer",
	promptVersion: "1.0",
	toolPolicyId: "scoped-implementation",
	maxRequests: 1,
	maxRuntimeMs: 1000,
	retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
	contextPolicy: {
		includePlan: true,
		includeReviewFindings: false,
		includeVerification: true,
		includeFullTranscript: false,
		maxArtifactBytes: 1000,
	},
} satisfies Partial<ModelProfile> as ModelProfile;

describe("enhanceSchemaForProfile", () => {
	const schema = {
		type: "object",
		properties: {
			summary: { type: "string" },
			count: { type: "integer" },
		},
		required: ["summary"],
	};

	it("adds descriptions when configured", () => {
		const enhanced = enhanceSchemaForProfile(schema, {
			outputStrategy: {
				schemaEnhancement: { addDescriptions: true, addExamples: false, strictMode: false },
			},
		}) as { properties: Record<string, { description?: string }> };
		expect(enhanced.properties.summary?.description).toMatch(/summary/);
		expect(enhanced.properties.count?.description).toMatch(/count/);
	});

	it("adds examples and strict mode for GPT-style profiles", () => {
		const enhanced = enhanceSchemaForProfile(schema, {
			outputStrategy: {
				schemaEnhancement: { addDescriptions: false, addExamples: true, strictMode: true },
			},
		}) as { examples?: unknown[]; strict?: boolean; additionalProperties?: boolean };
		expect(enhanced.examples?.length).toBe(1);
		expect(enhanced.strict).toBe(true);
		expect(enhanced.additionalProperties).toBe(false);
	});

	it("returns original when no outputStrategy", () => {
		expect(enhanceSchemaForProfile(schema, {})).toEqual(schema);
	});
});

describe("transformToolsForProfile", () => {
	it("applies toolAliases to customWireName and remaps argument schema", () => {
		const tools = transformToolsForProfile(
			[
				{
					name: "bash",
					schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
				},
				{
					name: "read",
					schema: {
						type: "object",
						properties: { path: { type: "string" }, offset: { type: "integer" } },
						required: ["path"],
					},
				},
			],
			{
				...baseProfile,
				toolAliases: { bash: "run_command" },
				argumentAliases: { read: { path: "file_path" } },
			},
		);
		expect(tools[0]?.customWireName).toBe("run_command");
		expect(tools[0]?.name).toBe("bash");
		expect(tools[1]?.schema?.properties).toHaveProperty("file_path");
		expect(tools[1]?.schema?.properties).not.toHaveProperty("path");
		expect(tools[1]?.schema?.required).toContain("file_path");
	});

	it("reverseArgumentAliases maps wire keys back to internal", () => {
		const reversed = reverseArgumentAliases(
			"read",
			{ file_path: "a.ts", offset: 1 },
			{ argumentAliases: { read: { path: "file_path" } } },
		);
		expect(reversed).toEqual({ path: "a.ts", offset: 1 });
	});
});

describe("remapSchemaProperties", () => {
	it("leaves non-object schemas alone", () => {
		expect(remapSchemaProperties({ type: "string" }, { a: "b" })).toEqual({ type: "string" });
	});
});
