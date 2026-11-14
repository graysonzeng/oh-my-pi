import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PTC_CATALOG_BUDGET_BYTES,
	describePtcTools,
	renderPtcSkeletonCatalog,
	searchPtcTools,
	type PtcCatalogTool,
} from "../src/tools/ptc-catalog";

function tool(partial: Partial<PtcCatalogTool> & Pick<PtcCatalogTool, "name">): PtcCatalogTool {
	return {
		label: partial.label ?? partial.name,
		summary: partial.summary ?? `${partial.name} summary`,
		description: partial.description ?? `${partial.name} description`,
		parameters: partial.parameters ?? {
			type: "object",
			properties: { q: { type: "string" } },
			required: ["q"],
		},
		builtIn: partial.builtIn ?? false,
		mcpServerName: partial.mcpServerName,
		mcpToolName: partial.mcpToolName,
		...partial,
	};
}

describe("renderPtcSkeletonCatalog", () => {
	test("keeps per-tool skeletons that fit and lists remaining tools under their server", () => {
		const tools: PtcCatalogTool[] = [
			tool({
				name: "read",
				builtIn: true,
				summary: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			}),
			tool({
				name: "mcp__github_list_prs",
				mcpServerName: "github",
				mcpToolName: "list_prs",
				summary: "List pull requests",
				parameters: {
					type: "object",
					properties: { owner: { type: "string" }, repo: { type: "string" } },
					required: ["owner", "repo"],
				},
			}),
			tool({
				name: "mcp__jira_search",
				mcpServerName: "jira",
				mcpToolName: "search",
				summary: "Search Jira issues",
			}),
			tool({
				name: "mcp__jira_create",
				mcpServerName: "jira",
				mcpToolName: "create",
				summary: "Create a Jira issue",
			}),
		];
		const rendered = renderPtcSkeletonCatalog(tools, { budgetBytes: 360 });
		expect(rendered).toContain("read(args:");
		expect(rendered).toContain("mcp__github_list_prs(args:");
		expect(rendered).toMatch(/jira \(\d+ tools\)/);
		expect(rendered).toContain("searchTools");
		expect(Buffer.byteLength(rendered, "utf-8")).toBeLessThanOrEqual(360);
	});

	test("does not slice a declaration in the middle of a tool line", () => {
		const tools = [
			tool({ name: "alpha", builtIn: true, summary: "A".repeat(80) }),
			tool({ name: "beta", builtIn: true, summary: "B".repeat(80) }),
		];
		const rendered = renderPtcSkeletonCatalog(tools, { budgetBytes: 120 });
		expect(rendered.includes("alpha(") !== rendered.includes("beta(") || rendered.includes("tools not listed")).toBe(
			true,
		);
		expect(rendered).not.toMatch(/alpha\(args:[^)]*$/m);
	});

	test("uses the default experimental budget as a byte cap, not a character slice", () => {
		expect(DEFAULT_PTC_CATALOG_BUDGET_BYTES).toBe(20_000);
		const tools = Array.from({ length: 8 }, (_, index) =>
			tool({
				name: `tool_${index}`,
				builtIn: true,
				summary: "中文摘要".repeat(40),
			}),
		);
		const rendered = renderPtcSkeletonCatalog(tools);
		expect(Buffer.byteLength(rendered, "utf-8")).toBeLessThanOrEqual(DEFAULT_PTC_CATALOG_BUDGET_BYTES);
	});

	test("keeps the remainder index inside the total byte budget", () => {
		const tools = Array.from({ length: 40 }, (_, index) =>
			tool({
				name: `mcp__overflow_${index}`,
				mcpServerName: `server_${index}`,
				summary: "余项索引".repeat(30),
			}),
		);
		const rendered = renderPtcSkeletonCatalog(tools, { budgetBytes: 400 });
		expect(Buffer.byteLength(rendered, "utf-8")).toBeLessThanOrEqual(400);
		expect(rendered).toContain("searchTools");
	});
});

describe("searchPtcTools / describePtcTools", () => {
	const tools = [
		tool({ name: "read", builtIn: true, summary: "Read a file from disk", description: "Reads file contents" }),
		tool({
			name: "mcp__github_list_prs",
			mcpServerName: "github",
			mcpToolName: "list_prs",
			summary: "List pull requests",
			description: "GitHub pull request listing",
		}),
		tool({
			name: "mcp__jira_search",
			mcpServerName: "jira",
			mcpToolName: "search",
			summary: "Search Jira issues",
		}),
	];

	test("searchTools ranks by name and summary and can filter by server", () => {
		const hits = searchPtcTools(tools, "pull request");
		expect(hits[0]?.name).toBe("mcp__github_list_prs");
		const jira = searchPtcTools(tools, "search", { server: "jira" });
		expect(jira.map(hit => hit.name)).toEqual(["mcp__jira_search"]);
	});

	test("describeTools returns full schema for exact names and null for unknown names", () => {
		const described = describePtcTools(tools, ["read", "missing"]);
		expect(described.read?.name).toBe("read");
		expect(described.read?.schema).toContain("q");
		expect(described.missing).toBeNull();
	});

	test("describeTools keeps a large schema fully recoverable instead of byte-slicing characters", () => {
		const huge = "中".repeat(6_000);
		const described = describePtcTools(
			[
				tool({
					name: "huge",
					builtIn: true,
					parameters: { type: "object", properties: { note: { type: "string", description: huge } } },
				}),
			],
			["huge"],
		);
		expect(described.huge?.schema).toContain(huge);
		expect(described.huge?.schema).not.toContain("schema truncated");
	});

	test("describeTools rejects more than 10 names", () => {
		expect(() =>
			describePtcTools(
				tools,
				Array.from({ length: 11 }, (_, i) => `t${i}`),
			),
		).toThrow(/10/);
	});
});
