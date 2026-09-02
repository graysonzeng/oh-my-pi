import { getOrCreateClient, holdLspApplyEdits, sendRequest } from "../lsp/client";
import { getConfig, getLspServers } from "../lsp/servers";
import type { Location, LspClient, ServerConfig } from "../lsp/types";
import { uriToFile } from "../lsp/utils";
import type { ToolSession } from ".";
import type { CodeIntelCandidate } from "./code-intel-envelope";
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

export async function codeIntelLspLookup(options: {
	session: ToolSession;
	tokens: string[];
	relation: boolean;
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
	for (const [name, server] of servers.slice(0, 3)) {
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

	const releases = started.map(([, , client]) => holdLspApplyEdits(client));
	try {
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
						if (!options.relation) continue;
						const prepared = (await sendReadonly(
							client,
							"textDocument/prepareCallHierarchy",
							{ textDocument: { uri: symbol.location.uri }, position: symbol.location.range.start },
							options.signal,
						)) as Array<{ name: string; uri: string; selectionRange: Location["range"] }> | null;
						for (const item of (prepared ?? []).slice(0, 3)) {
							const incoming =
								((await sendReadonly(
									client,
									"callHierarchy/incomingCalls",
									{ item },
									options.signal,
								)) as Array<{
									from: { name: string; uri: string; selectionRange: Location["range"] };
								}> | null) ?? [];
							for (const call of incoming.slice(0, 12)) {
								candidates.push(
									toCandidate(
										{ uri: call.from.uri, range: call.from.selectionRange },
										cwd,
										call.from.name,
										"lsp-call",
										true,
									),
								);
							}
							const outgoing =
								((await sendReadonly(
									client,
									"callHierarchy/outgoingCalls",
									{ item },
									options.signal,
								)) as Array<{
									to: { name: string; uri: string; selectionRange: Location["range"] };
								}> | null) ?? [];
							for (const call of outgoing.slice(0, 12)) {
								candidates.push(
									toCandidate(
										{ uri: call.to.uri, range: call.to.selectionRange },
										cwd,
										call.to.name,
										"lsp-call",
									),
								);
							}
						}
					}
				} catch {
					// Skip this token/server; remaining layers still fill the envelope.
				}
			}
		}
		return { candidates, gaps };
	} finally {
		for (const release of releases) release();
	}
}
