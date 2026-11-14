/**
 * Restored workflow locators.
 *
 * Failure modes:
 * - xd://skills/{name} ignores presentationSkillBodies and reports no skills loaded
 * - xd://tools/{name} is parsed as a topic of a device named tools instead of the captured schema
 * - a prepared skill body larger than the read cap is truncated, so the advertised full body is incomplete
 */
import { describe, expect, it } from "bun:test";
import { XdProtocolHandler } from "../../src/internal-urls/xd-protocol";
import { ReadTool } from "../../src/tools/read";
import type { ToolSession } from "../../src/tools";
import { fakeSession } from "../workflow/helpers";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("workflow locator restore", () => {
	it("serves a skill locator from the prepared body when the child has no skill list", async () => {
		const handler = new XdProtocolHandler();
		const bodies = new Map<string, string>([["repo", "# prepared body\n\nfrom catalog map"]]);
		const resource = await handler.resolve(
			new URL("xd://skills/repo") as never,
			{
				skills: [],
				session: {
					workflowToolOptimization: {
						processResult: (_tool: string, output: string) => output,
						presentationSkillBodies: bodies,
					},
				},
			} as never,
		);
		expect(resource.content).toContain("# prepared body");
		expect(resource.content).toContain("from catalog map");

		await expect(handler.resolve(new URL("xd://skills/repo") as never, { skills: [] } as never)).rejects.toThrow(
			/no skills loaded/,
		);
	});

	it("serves a tool locator from the captured schema instead of a tools-device topic", async () => {
		const handler = new XdProtocolHandler();
		const schemas = new Map<string, unknown>([
			["bash", { type: "object", properties: { command: { type: "string" } } }],
		]);
		const resource = await handler.resolve(
			new URL("xd://tools/bash") as never,
			{
				session: {
					workflowToolOptimization: {
						processResult: (_tool: string, output: string) => output,
						presentationToolSchemas: schemas,
						presentationAllowedTools: ["bash", "read", "yield"],
					},
				},
			} as never,
		);
		expect(resource.content).toContain("# Tool: bash");
		expect(resource.content).toContain('"command"');

		const refused = new Map<string, unknown>([["bash", { type: "object" }]]);
		await expect(
			handler.resolve(
				new URL("xd://tools/task") as never,
				{
					session: {
						workflowToolOptimization: {
							processResult: (_tool: string, output: string) => output,
							presentationToolSchemas: refused,
							presentationAllowedTools: ["bash", "read", "yield"],
						},
					},
				} as never,
			),
		).rejects.toThrow(/outside the role allowlist/);
	});

	it("read of a prepared skill locator returns the full body past the ordinary read cap", async () => {
		const marker = "LOCATOR_TAIL_MARKER";
		const body = `${"x".repeat(60_000)}\n${marker}`;
		const bodies = new Map<string, string>([["repo", body]]);
		const session = fakeSession({
			skills: [] as ToolSession["skills"],
			workflowToolOptimization: {
				processResult: (_tool: string, output: string) => output,
				presentationSkillBodies: bodies,
			},
		});
		const tool = new ReadTool(session);
		const result = await tool.execute("locator-skill-full", { path: "xd://skills/repo" });
		expect(textOf(result)).toContain(marker);
	});
});
