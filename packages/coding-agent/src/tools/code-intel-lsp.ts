import { getOrCreateClient, holdLspApplyEditsForConfig, sendRequest } from "../lsp/client";
import { normalizeLocationResult } from "../lsp/diagnostics";
import { getConfig, getLspServers } from "../lsp/servers";
import type {
	CallHierarchyIncomingCall,
	CallHierarchyItem,
	CallHierarchyOutgoingCall,
	Location,
	LocationLink,
	LspClient,
	ServerConfig,
} from "../lsp/types";
import { uriToFile } from "../lsp/utils";
import type { ToolSession } from ".";
import type { CodeIntelCandidate, CodeIntelCoverage } from "./code-intel-envelope";
import { formatPathRelativeToCwd } from "./path-utils";

const ALLOWED_METHODS: Record<string, true> = {
	"workspace/symbol": true,
	"textDocument/references": true,
	"textDocument/implementation": true,
	"textDocument/definition": true,
	"textDocument/prepareCallHierarchy": true,
	"callHierarchy/incomingCalls": true,
	"callHierarchy/outgoingCalls": true,
};

const FORBIDDEN_METHODS: Record<string, true> = {
	"workspace/applyEdit": true,
	"textDocument/rename": true,
	"workspace/executeCommand": true,
	"workspace/willRenameFiles": true,
	"workspace/didRenameFiles": true,
};

export const CODE_INTEL_LSP_INIT_BUDGET_MS = 3000;
const PREPARED_SYMBOL_CAP = 3;
const HOP1_CAP = 8;
const HOP2_CAP = 4;

export function assertCodeIntelLspMethod(method: string): void {
	if (FORBIDDEN_METHODS[method] || !ALLOWED_METHODS[method]) {
		throw new Error(`code_intel LSP facade forbids ${method}`);
	}
}

async function sendReadonly(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	assertCodeIntelLspMethod(method);
	return sendRequest(client, method, params, signal, CODE_INTEL_LSP_INIT_BUDGET_MS);
}

function toCandidate(
	location: Location,
	cwd: string,
	symbol: string,
	provenance: CodeIntelCandidate["provenance"],
	incoming = false,
): CodeIntelCandidate {
	return {
		path: formatPathRelativeToCwd(uriToFile(location.uri), cwd).replaceAll("\\", "/"),
		startLine: location.range.start.line + 1,
		endLine: Math.max(location.range.start.line + 1, location.range.end.line + 1),
		symbol,
		provenance,
		incoming: incoming || undefined,
	};
}

function locationFromItem(item: CallHierarchyItem): Location {
	return { uri: item.uri, range: item.selectionRange ?? item.range };
}

async function collectIncoming(
	client: LspClient,
	item: CallHierarchyItem,
	cwd: string,
	candidates: CodeIntelCandidate[],
	cap: number,
	signal?: AbortSignal,
): Promise<CallHierarchyItem[]> {
	const incoming =
		((await sendReadonly(client, "callHierarchy/incomingCalls", { item }, signal)) as
			| CallHierarchyIncomingCall[]
			| null) ?? [];
	const next: CallHierarchyItem[] = [];
	for (const call of incoming.slice(0, cap)) {
		candidates.push(toCandidate(locationFromItem(call.from), cwd, call.from.name, "lsp-call", true));
		next.push(call.from);
	}
	return next;
}

async function collectOutgoing(
	client: LspClient,
	item: CallHierarchyItem,
	cwd: string,
	candidates: CodeIntelCandidate[],
	cap: number,
	signal?: AbortSignal,
): Promise<CallHierarchyItem[]> {
	const outgoing =
		((await sendReadonly(client, "callHierarchy/outgoingCalls", { item }, signal)) as
			| CallHierarchyOutgoingCall[]
			| null) ?? [];
	const next: CallHierarchyItem[] = [];
	for (const call of outgoing.slice(0, cap)) {
		candidates.push(toCandidate(locationFromItem(call.to), cwd, call.to.name, "lsp-call"));
		next.push(call.to);
	}
	return next;
}

async function traverseVerifiedCalls(
	client: LspClient,
	roots: CallHierarchyItem[],
	cwd: string,
	candidates: CodeIntelCandidate[],
	signal?: AbortSignal,
): Promise<void> {
	for (const item of roots) {
		const incomingHop1 = await collectIncoming(client, item, cwd, candidates, HOP1_CAP, signal);
		for (const nested of incomingHop1) {
			await collectIncoming(client, nested, cwd, candidates, HOP2_CAP, signal);
		}
		const outgoingHop1 = await collectOutgoing(client, item, cwd, candidates, HOP1_CAP, signal);
		for (const nested of outgoingHop1) {
			await collectOutgoing(client, nested, cwd, candidates, HOP2_CAP, signal);
		}
	}
}

export async function codeIntelLspLookup(options: {
	session: ToolSession;
	tokens: string[];
	relation: boolean;
	coverage: CodeIntelCoverage;
	signal?: AbortSignal;
}): Promise<{ candidates: CodeIntelCandidate[]; gaps: string[] }> {
	if (options.session.settings.get("lsp.enabled") === false) {
		return { candidates: [], gaps: ["lsp unavailable"] };
	}
	const cwd = options.session.cwd;
	const config = getConfig(cwd);
	const servers = getLspServers(config);
	if (servers.length === 0) {
		return { candidates: [], gaps: ["lsp unavailable"] };
	}
	const candidates: CodeIntelCandidate[] = [];
	const gaps: string[] = [];
	const started: Array<[string, ServerConfig, LspClient]> = [];
	const releases: Array<() => void> = [];
	const traverse = options.coverage === "extended" && options.relation;
	try {
		for (const [name, server] of servers.slice(0, 3)) {
			releases.push(holdLspApplyEditsForConfig(server, cwd));
			try {
				const client = await getOrCreateClient(server, cwd, CODE_INTEL_LSP_INIT_BUDGET_MS, options.signal);
				started.push([name, server, client]);
			} catch {
				gaps.push(`lsp ${name} skipped (init budget ${CODE_INTEL_LSP_INIT_BUDGET_MS}ms)`);
			}
		}
		if (started.length === 0) {
			return { candidates: [], gaps: gaps.length > 0 ? gaps : ["lsp unavailable"] };
		}

		const preparedRoots: Array<{ client: LspClient; item: CallHierarchyItem }> = [];
		for (const token of options.tokens.slice(0, 4)) {
			for (const [, , client] of started) {
				try {
					const symbols = (await sendReadonly(
						client,
						"workspace/symbol",
						{ query: token },
						options.signal,
					)) as Array<{ name?: string; location?: Location }> | null;
					for (const symbol of (symbols ?? []).slice(0, 8)) {
						if (!symbol.location) continue;
						const name = symbol.name ?? token;
						candidates.push(toCandidate(symbol.location, cwd, name, "lsp-reference"));
						const refs = (await sendReadonly(
							client,
							"textDocument/references",
							{
								textDocument: { uri: symbol.location.uri },
								position: symbol.location.range.start,
								context: { includeDeclaration: true },
							},
							options.signal,
						)) as Location[] | null;
						for (const loc of (refs ?? []).slice(0, 20)) {
							candidates.push(toCandidate(loc, cwd, name, "lsp-reference"));
						}
						const implementations = normalizeLocationResult(
							(await sendReadonly(
								client,
								"textDocument/implementation",
								{
									textDocument: { uri: symbol.location.uri },
									position: symbol.location.range.start,
								},
								options.signal,
							)) as Location | Location[] | LocationLink | LocationLink[] | null,
						);
						for (const loc of implementations.slice(0, 20)) {
							candidates.push(toCandidate(loc, cwd, name, "lsp-reference"));
						}
						if (!traverse || preparedRoots.length >= PREPARED_SYMBOL_CAP) continue;
						const prepared = (await sendReadonly(
							client,
							"textDocument/prepareCallHierarchy",
							{ textDocument: { uri: symbol.location.uri }, position: symbol.location.range.start },
							options.signal,
						)) as CallHierarchyItem[] | null;
						for (const item of prepared ?? []) {
							if (preparedRoots.length >= PREPARED_SYMBOL_CAP) break;
							preparedRoots.push({ client, item });
						}
					}
				} catch {
					// Skip this token/server; remaining layers still fill the envelope.
				}
			}
		}

		if (traverse) {
			const byClient = new Map<LspClient, CallHierarchyItem[]>();
			for (const root of preparedRoots) {
				const items = byClient.get(root.client) ?? [];
				items.push(root.item);
				byClient.set(root.client, items);
			}
			for (const [client, items] of byClient) {
				try {
					await traverseVerifiedCalls(client, items, cwd, candidates, options.signal);
				} catch {
					// Skip this server's hierarchy; locate results already recorded.
				}
			}
		}

		return { candidates, gaps };
	} finally {
		for (const release of releases) release();
	}
}
