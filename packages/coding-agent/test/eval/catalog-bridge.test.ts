import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	EVAL_CATALOG_DESCRIBE_BRIDGE_NAME,
	EVAL_CATALOG_SEARCH_BRIDGE_NAME,
	runEvalCatalogDescribe,
	runEvalCatalogSearch,
} from "@oh-my-pi/pi-coding-agent/eval/catalog-bridge";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function tool(name: string, extra: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: type({ q: "string" }),
		execute: async () => ({ content: [] }),
		...extra,
	} as unknown as AgentTool;
}

function session(): ToolSession {
	const read = tool("read");
	const search = tool("mcp__jira_search", { mcpServerName: "jira", mcpToolName: "search" });
	const registry = new Map<string, AgentTool>([
		["eval", tool("eval")],
		["read", read],
		["mcp__jira_search", search],
	]);
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		toolRegistry: registry,
		getEvalBridgeToolNames: () => ["eval", "read", "mcp__jira_search"],
		getCodeModeDirectToolNames: () => ["eval"],
		getToolByName: name => registry.get(name),
	};
}

describe("eval catalog bridge", () => {
	test("searchTools ranks demoted tools and omits the direct keep-set", () => {
		const hits = runEvalCatalogSearch({ query: "jira" }, session());
		expect(hits.map(hit => hit.name)).toEqual(["mcp__jira_search"]);
		expect(hits.some(hit => hit.name === "eval")).toBe(false);
	});

	test("describeTools returns schemas for exact names and null for unknown names", () => {
		const described = runEvalCatalogDescribe({ names: ["read", "missing"] }, session());
		expect(described.read?.name).toBe("read");
		expect(described.read?.schema).toContain("q");
		expect(described.missing).toBeNull();
	});

	test("callSessionTool routes catalog search and describe without hitting the registry", async () => {
		const hits = await callSessionTool(EVAL_CATALOG_SEARCH_BRIDGE_NAME, { query: "jira" }, { session: session() });
		expect(hits).toEqual([expect.objectContaining({ name: "mcp__jira_search" })]);
		const described = await callSessionTool(
			EVAL_CATALOG_DESCRIBE_BRIDGE_NAME,
			{ names: ["read"] },
			{ session: session() },
		);
		expect(described).toEqual(expect.objectContaining({ read: expect.objectContaining({ name: "read" }) }));
	});
});
