/**
 * Compact PTC skeleton catalog: per-tool admission into a byte budget, with
 * leftover tools indexed by MCP server (or canonical name). Search/describe
 * recover full schemas without resurrecting the removed BM25 discovery system.
 */

import { jsonSchemaToTypeScript } from "@oh-my-pi/pi-ai";
import { arkToWireSchema, isArkSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import { generateCodeModeDeclarations } from "@oh-my-pi/pi-tui/tools/eval-format/code-mode-declarations";

/** Experimental UTF-8 byte budget for the eval-description catalog (~20 KiB). */
export const DEFAULT_PTC_CATALOG_BUDGET_BYTES = 20_000;
const SEARCH_LIMIT = 20;
const DESCRIBE_NAME_LIMIT = 10;
const SUMMARY_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

export interface PtcCatalogTool {
	name: string;
	label?: string;
	summary?: string;
	description?: string;
	parameters: unknown;
	builtIn?: boolean;
	mcpServerName?: string;
	mcpToolName?: string;
}

export interface PtcCatalogSearchHit {
	name: string;
	label: string;
	summary: string;
	server?: string;
}

export interface PtcCatalogDescriptor {
	name: string;
	label: string;
	summary: string;
	server?: string;
	schema: string;
}

export interface PtcCatalogRenderOptions {
	budgetBytes?: number;
}

export function renderPtcSkeletonCatalog(
	tools: readonly PtcCatalogTool[],
	options: PtcCatalogRenderOptions = {},
): string {
	const budget = options.budgetBytes ?? DEFAULT_PTC_CATALOG_BUDGET_BYTES;
	const sorted = sortCatalogTools(tools);
	const signatures = new Map<string, string>();
	let admittedCount = 0;
	for (let count = 0; count <= sorted.length; count++) {
		const admitted = sorted.slice(0, count);
		const remainder = sorted.slice(count);
		const text = formatCatalog(admitted, remainder, signatures, false);
		if (byteLength(text) > budget) break;
		admittedCount = count;
	}
	const admitted = sorted.slice(0, admittedCount);
	const remainder = sorted.slice(admittedCount);
	const fitted = formatCatalog(admitted, remainder, signatures, false);
	if (byteLength(fitted) <= budget) return fitted;
	const compact = formatCatalog(admitted, remainder, signatures, true);
	if (byteLength(compact) <= budget) return compact;
	let groups = groupByServer(remainder);
	while (groups.length > 0) {
		groups = groups.slice(0, -1);
		const trimmed = groups.flatMap(([, group]) => group);
		const text = formatCatalog(admitted, trimmed, signatures, true);
		if (byteLength(text) <= budget) return text;
	}
	return formatCatalog(admitted, [], signatures, true);
}

export function searchPtcTools(
	tools: readonly PtcCatalogTool[],
	query: string | readonly string[],
	opts?: { server?: string; limit?: number },
): PtcCatalogSearchHit[] {
	const needles = (Array.isArray(query) ? query : [query])
		.flatMap(part => tokenize(part))
		.filter(token => token.length > 0);
	const serverFilter = opts?.server?.trim().toLowerCase();
	const ranked = tools
		.filter(tool => (serverFilter ? (tool.mcpServerName ?? "").toLowerCase() === serverFilter : true))
		.map(tool => ({ tool, score: scoreTool(tool, needles) }))
		.filter(entry => needles.length === 0 || entry.score > 0)
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
	const limit = Math.min(Math.max(opts?.limit ?? SEARCH_LIMIT, 1), SEARCH_LIMIT);
	return ranked.slice(0, limit).map(({ tool }) => toHit(tool));
}

export function describePtcTools(
	tools: readonly PtcCatalogTool[],
	names: readonly string[],
): Record<string, PtcCatalogDescriptor | null> {
	if (names.length > DESCRIBE_NAME_LIMIT) {
		throw new Error(`describeTools accepts at most ${DESCRIBE_NAME_LIMIT} names`);
	}
	const byName = new Map(tools.map(tool => [tool.name, tool]));
	const out: Record<string, PtcCatalogDescriptor | null> = {};
	for (const name of names) {
		const tool = byName.get(name);
		out[name] = tool ? toDescriptor(tool) : null;
	}
	return out;
}

function sortCatalogTools(tools: readonly PtcCatalogTool[]): PtcCatalogTool[] {
	return [...tools].sort((left, right) => {
		if (Boolean(left.builtIn) !== Boolean(right.builtIn)) return left.builtIn ? -1 : 1;
		const server = (left.mcpServerName ?? "").localeCompare(right.mcpServerName ?? "");
		if (server !== 0) return server;
		return left.name.localeCompare(right.name);
	});
}

function formatCatalog(
	admitted: readonly PtcCatalogTool[],
	remainder: readonly PtcCatalogTool[],
	signatures: Map<string, string>,
	compactRemainder: boolean,
): string {
	const lines: string[] = [];
	const builtins = admitted.filter(tool => tool.builtIn);
	if (builtins.length > 0) {
		lines.push("builtin:");
		for (const tool of builtins) lines.push(`  ${formatSkeletonLine(tool, signatures)}`);
	}
	const servers = groupByServer(admitted.filter(tool => !tool.builtIn));
	for (const [server, group] of servers) {
		lines.push(`${formatServerHeader(server, group[0])}:`);
		for (const tool of group) lines.push(`  ${formatSkeletonLine(tool, signatures)}`);
	}
	if (remainder.length > 0) {
		const grouped = groupByServer(remainder);
		lines.push("");
		lines.push(`[${remainder.length} tools not listed. Use catalog.searchTools(query, { server }) to discover them:`);
		for (const [server, group] of grouped) {
			const label = server === "" ? group.map(tool => tool.name).join(", ") : server;
			if (compactRemainder) {
				lines.push(`  ${label} (${group.length})`);
				continue;
			}
			const summary = sanitizeSummary(group[0]?.summary ?? server);
			lines.push(`  ${label} (${group.length} tools) — ${summary}`);
		}
		lines.push("]");
	}
	return lines.join("\n");
}

function groupByServer(tools: readonly PtcCatalogTool[]): Array<[string, PtcCatalogTool[]]> {
	const map = new Map<string, PtcCatalogTool[]>();
	for (const tool of tools) {
		const key = tool.mcpServerName ?? "";
		const list = map.get(key) ?? [];
		list.push(tool);
		map.set(key, list);
	}
	return [...map.entries()];
}

function formatServerHeader(server: string, sample: PtcCatalogTool | undefined): string {
	if (server) return server;
	return sample?.name ?? "tools";
}

function formatSkeletonLine(tool: PtcCatalogTool, signatures: Map<string, string>): string {
	let signature = signatures.get(tool.name);
	if (!signature) {
		signature = generateCodeModeDeclarations([{ name: tool.name, parameters: tool.parameters }]).trim();
		signatures.set(tool.name, signature);
	}
	return `${signature} — ${sanitizeSummary(tool.summary || tool.description || tool.label || tool.name)}`;
}

function toHit(tool: PtcCatalogTool): PtcCatalogSearchHit {
	return {
		name: tool.name,
		label: tool.label || tool.name,
		summary: sanitizeSummary(tool.summary || tool.description || tool.label || tool.name),
		server: tool.mcpServerName,
	};
}

function toDescriptor(tool: PtcCatalogTool): PtcCatalogDescriptor {
	let schema: string;
	try {
		schema = jsonSchemaToTypeScript(toJsonSchema(tool.parameters));
	} catch {
		schema = "unknown";
	}
	return {
		name: tool.name,
		label: tool.label || tool.name,
		summary: sanitizeSummary(tool.summary || tool.description || tool.label || tool.name),
		server: tool.mcpServerName,
		schema,
	};
}

function scoreTool(tool: PtcCatalogTool, needles: readonly string[]): number {
	if (needles.length === 0) return 1;
	const haystack = tokenize(
		[tool.name, tool.label, tool.summary, tool.description, tool.mcpServerName, tool.mcpToolName]
			.filter((value): value is string => typeof value === "string")
			.join(" "),
	);
	let score = 0;
	for (const needle of needles) {
		if (haystack.includes(needle)) score += needle.length;
	}
	return score;
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9_\u4e00-\u9fff]+/i)
		.filter(Boolean);
}

function sanitizeSummary(summary: string): string {
	return summary.replace(SUMMARY_CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

function toJsonSchema(parameters: unknown): unknown {
	return isArkSchema(parameters) ? arkToWireSchema(parameters) : parameters;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}
