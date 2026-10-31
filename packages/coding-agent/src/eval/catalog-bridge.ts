/**
 * Host-side handlers for eval `catalog.searchTools` / `catalog.describeTools`.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import {
	describePtcTools,
	type PtcCatalogDescriptor,
	type PtcCatalogSearchHit,
	type PtcCatalogTool,
	searchPtcTools,
} from "../tools/ptc-catalog";
import { ToolError } from "../tools/tool-errors";

/** Synthetic bridge names reserved for catalog discovery across both runtimes. */
export const EVAL_CATALOG_SEARCH_BRIDGE_NAME = "__catalog_search__";
export const EVAL_CATALOG_DESCRIBE_BRIDGE_NAME = "__catalog_describe__";

export function collectSessionPtcCatalogTools(session: ToolSession): PtcCatalogTool[] {
	const names = session.getEvalBridgeToolNames?.() ?? [...(session.toolRegistry?.keys() ?? [])];
	const direct = new Set(session.getCodeModeDirectToolNames?.() ?? []);
	const tools: PtcCatalogTool[] = [];
	for (const name of names) {
		if (direct.has(name)) continue;
		const tool =
			session.getToolForEvalBridge?.(name) ?? session.getToolByName?.(name) ?? session.toolRegistry?.get(name);
		if (!tool) continue;
		const mcpServerName =
			"mcpServerName" in tool && typeof tool.mcpServerName === "string" ? tool.mcpServerName : undefined;
		const mcpToolName = "mcpToolName" in tool && typeof tool.mcpToolName === "string" ? tool.mcpToolName : undefined;
		const description = typeof tool.description === "string" ? tool.description : undefined;
		tools.push({
			name: tool.name,
			label: tool.label,
			summary: description,
			description,
			parameters: tool.parameters,
			builtIn: mcpServerName === undefined,
			mcpServerName,
			mcpToolName,
		});
	}
	return tools;
}

export function runEvalCatalogSearch(args: unknown, session: ToolSession): PtcCatalogSearchHit[] {
	if (!isRecord(args)) throw new ToolError("catalog.searchTools requires an object argument");
	const query = args.query;
	if (typeof query !== "string" && !(Array.isArray(query) && query.every(part => typeof part === "string"))) {
		throw new ToolError("catalog.searchTools requires query: string | string[]");
	}
	const server = typeof args.server === "string" ? args.server : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	return searchPtcTools(collectSessionPtcCatalogTools(session), query, { server, limit });
}

export function runEvalCatalogDescribe(
	args: unknown,
	session: ToolSession,
): Record<string, PtcCatalogDescriptor | null> {
	if (!isRecord(args) || !Array.isArray(args.names) || !args.names.every(name => typeof name === "string")) {
		throw new ToolError("catalog.describeTools requires names: string[]");
	}
	return describePtcTools(collectSessionPtcCatalogTools(session), args.names);
}
