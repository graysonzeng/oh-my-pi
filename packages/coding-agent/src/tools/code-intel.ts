/**
 * Native code intelligence tool. One query in, one CCE_SEARCH_RESULT envelope
 * out. Layers: grep → tags PageRank → read-only LSP → optional local semantic.
 * Semantic and identifier tags never emit call edges.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { FileType, glob, grep } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { pathIsWithin, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import codeIntelDescription from "../prompts/tools/code-intel.md" with { type: "text" };
import { isScoutSpawnable } from "../task/spawn-policy";
import { renderStatusLine, truncateToWidth } from "../tui";
import { workflowToolWireName } from "../workflow/tool-optimization";
import type { ToolSession } from ".";
import { isEnglishOnlyEmbedModel, resolveCodeIntelEmbedModel } from "./code-intel-embed";
import type { CodeIntelCandidate, CodeIntelConfidence, CodeIntelCoverage } from "./code-intel-envelope";
import { renderCodeIntelEnvelope } from "./code-intel-envelope";
import { type CodeIntelIndexStatus, codeIntelContentHash, getCodeIntelIndex } from "./code-intel-index";
import { codeIntelLspLookup } from "./code-intel-lsp";
import {
	buildEnvelope,
	candidateScore,
	capEvidence,
	escapeRegexLiteral,
	extractQueryTokens,
	inferCoverage,
	looksChinese,
	queryHasRelationSignal,
} from "./code-intel-merge";
import {
	codeIntelExtractCalls,
	codeIntelExtractTags,
	hasCodeIntelNatives,
	NATIVE_CODE_INTEL_MISSING,
} from "./code-intel-natives";
import type { OutputMeta } from "./output-meta";
import { formatPathRelativeToCwd } from "./path-utils";
import {
	createCachedComponent,
	Ellipsis,
	formatCount,
	formatErrorMessage,
	replaceTabs,
	shortenPath,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const codeIntelSchema = type({
	query: type.string
		.atLeastLength(1)
		.atMostLength(20000)
		.describe(
			"Describe the behavior, symbol relationship, or ownership boundary. State intent; do not guess a directory.",
		),
	"depth?": type
		.enumerated("auto", "focused", "extended")
		.describe(
			"auto infers from relationship words. focused = locate and stop. extended = at most two verified hops.",
		),
	"path?": type.string.describe("Optional workspace-relative clue, not a hard boundary."),
});

export interface CodeIntelToolDetails {
	coverage: CodeIntelCoverage;
	confidence: CodeIntelConfidence;
	evidenceCount: number;
	found: boolean;
	layers: {
		grep: boolean;
		graph: boolean;
		lsp: boolean;
		semantic: boolean;
	};
	index: {
		state: CodeIntelIndexStatus["state"];
		filesIndexed: number;
		embeddingsReady: boolean;
	};
	error?: string;
	meta?: OutputMeta;
}

function seedPathsFromSession(session: ToolSession): string[] {
	const store = session.fileSnapshotStore;
	if (!store) return [];
	const out: string[] = [];
	for (const absolute of store.paths()) {
		out.push(formatPathRelativeToCwd(absolute, session.cwd).replaceAll("\\", "/"));
		if (out.length >= 32) break;
	}
	return out;
}
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|rs|py|go|java|c|h|cc|cpp)$/;
const TEST_OR_DOCS = /(?:^|\/)(?:test|tests|docs|bench)(?:\/|$)|(?:\.test|\.spec)\./i;
const JS_DECL =
	/^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const RUST_DECL = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/;

function isSourcePath(filePath: string): boolean {
	return SOURCE_EXT.test(filePath) && !TEST_OR_DOCS.test(filePath.replaceAll("\\", "/"));
}

function declarationOnLine(line: string | undefined): { name: string; exported: boolean; fn: boolean } | undefined {
	if (!line) return undefined;
	const trimmed = line.trim();
	if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) return undefined;
	const match = JS_DECL.exec(trimmed) ?? RUST_DECL.exec(trimmed);
	const name = match?.[1];
	if (!name) return undefined;
	return {
		name,
		exported: /^(?:export|pub)\b/.test(trimmed),
		fn: /\b(?:async\s+)?(?:function|fn)\b/.test(trimmed),
	};
}

function workspacePath(cwd: string, filePath: string): string {
	return formatPathRelativeToCwd(path.resolve(cwd, filePath), cwd).replaceAll("\\", "/");
}

async function canonicalPath(filePath: string, signal?: AbortSignal): Promise<string> {
	return untilAborted(
		signal,
		fs.realpath(filePath).catch(() => path.resolve(filePath)),
	);
}
const GREP_TOKEN = /^(?:[A-Za-z_][A-Za-z0-9_-]*|[\u4e00-\u9fff]{2,})$/;

async function authorizedRoots(cwd: string, extraRoots: string[] = [], signal?: AbortSignal): Promise<string[]> {
	return Promise.all(
		[path.resolve(cwd), ...extraRoots.map(root => path.resolve(cwd, root))].map(root => canonicalPath(root, signal)),
	);
}

function isAuthorizedAbsolute(absolute: string, roots: string[]): boolean {
	return roots.some(root => pathIsWithin(root, absolute));
}

async function normalizePathClue(
	raw: string | undefined,
	cwd: string,
	roots: string[],
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const absolute = await canonicalPath(path.resolve(cwd, trimmed), signal);
	if (!isAuthorizedAbsolute(absolute, roots)) {
		throw new ToolError(`path clue escapes authorized workspace roots: ${trimmed}`);
	}
	return workspacePath(cwd, absolute);
}

export async function revalidateCandidates(options: {
	cwd: string;
	roots: string[];
	candidates: CodeIntelCandidate[];
	gaps: string[];
	signal?: AbortSignal;
	onStalePath?: (path: string) => void;
}): Promise<CodeIntelCandidate[]> {
	const files = new Map<string, { lines: string[]; hash: string } | null>();
	const kept: CodeIntelCandidate[] = [];
	let dropped = 0;
	let interrupted = false;
	const stalePaths = new Set<string>();

	async function loadFile(relative: string): Promise<{ lines: string[]; hash: string } | null> {
		const cached = files.get(relative);
		if (cached !== undefined) return cached;
		try {
			const absolute = await canonicalPath(path.resolve(options.cwd, relative), options.signal);
			if (!isAuthorizedAbsolute(absolute, options.roots)) {
				files.set(relative, null);
				return null;
			}
			const text = await untilAborted(options.signal, Bun.file(absolute).text());
			const entry = { lines: text.split("\n"), hash: codeIntelContentHash(text) };
			files.set(relative, entry);
			return entry;
		} catch {
			if (options.signal?.aborted) return null;
			files.set(relative, null);
			return null;
		}
	}

	for (const candidate of options.candidates) {
		if (options.signal?.aborted) {
			interrupted = true;
			break;
		}
		const relative = candidate.path.replaceAll("\\", "/");
		const file = await loadFile(relative);
		if (options.signal?.aborted) {
			interrupted = true;
			break;
		}
		if (!file) {
			dropped++;
			continue;
		}
		if (candidate.startLine < 1 || candidate.endLine < candidate.startLine || candidate.endLine > file.lines.length) {
			dropped++;
			continue;
		}
		const slice = file.lines.slice(candidate.startLine - 1, candidate.endLine).join("\n");
		if (!slice.includes(candidate.symbol)) {
			dropped++;
			continue;
		}
		if (candidate.contentHash !== undefined && candidate.contentHash !== file.hash) {
			stalePaths.add(relative);
			dropped++;
			continue;
		}
		kept.push(candidate);
	}
	if (dropped > 0) {
		options.gaps.push(`dropped ${dropped} stale or unauthorized candidate${dropped === 1 ? "" : "s"}`);
	}
	if (interrupted) options.gaps.push("live evidence revalidation interrupted by timeout");
	for (const stalePath of stalePaths) options.onStalePath?.(stalePath);
	return kept;
}

function pathQuality(filePath: string, tokens: string[] = []): number {
	const relative = filePath.replaceAll("\\", "/");
	if (!isSourcePath(relative)) return -8;
	let score = relative.includes("/src/") ? 6 : 2;
	const parts = relative.split("/");
	const base = parts.at(-1) ?? "";
	const parent = (parts.at(-2) ?? "").toLowerCase();
	if (tokens.some(token => token.toLowerCase() === parent) && /^(tool|index|mod)\./i.test(base)) {
		score += 20;
	}
	return score;
}

async function globClueFiles(options: {
	cwd: string;
	tokens: string[];
	pathClue?: string;
	signal?: AbortSignal;
}): Promise<string[]> {
	const scored = new Map<string, number>();
	const byToken = new Map<string, Map<string, number>>();
	if (options.pathClue) {
		const relative = options.pathClue.replaceAll("\\", "/");
		scored.set(
			relative,
			candidateScore(relative, path.basename(relative), options.tokens) + pathQuality(relative, options.tokens) + 8,
		);
	}
	for (const token of options.tokens.slice(0, 6)) {
		if (!/^[A-Za-z0-9_-]{3,}$/.test(token)) continue;
		const globToken = token.toLowerCase();
		const tokenHits = byToken.get(globToken) ?? new Map<string, number>();
		byToken.set(globToken, tokenHits);
		for (const pattern of [`**/*${globToken}*`, `**/${globToken}/**`]) {
			try {
				const result = await glob({
					pattern,
					path: options.cwd,
					fileType: FileType.File,
					maxResults: 48,
					gitignore: true,
					signal: options.signal,
				});
				for (const match of result.matches) {
					const relative = match.path.replaceAll("\\", "/");
					if (!SOURCE_EXT.test(relative)) continue;
					const score =
						candidateScore(relative, path.basename(relative), options.tokens) +
						pathQuality(relative, options.tokens);
					scored.set(relative, Math.max(scored.get(relative) ?? Number.NEGATIVE_INFINITY, score));
					tokenHits.set(relative, Math.max(tokenHits.get(relative) ?? Number.NEGATIVE_INFINITY, score));
				}
			} catch {
				// glob is a hint; grep still runs.
			}
		}
	}
	const picked: string[] = [];
	const seen = new Set<string>();
	const byDepth = (a: string, b: string) => a.split("/").length - b.split("/").length || a.localeCompare(b);
	for (const hits of byToken.values()) {
		const ranked = [...hits.entries()]
			.filter(([file]) => isSourcePath(file))
			.sort((a, b) => b[1] - a[1] || byDepth(a[0], b[0]));
		for (const [file] of ranked.slice(0, 6)) {
			if (seen.has(file)) continue;
			seen.add(file);
			picked.push(file);
		}
	}
	const remaining = [...scored.entries()]
		.filter(([file]) => isSourcePath(file) && !seen.has(file))
		.sort((a, b) => b[1] - a[1] || byDepth(a[0], b[0]));
	for (const [file] of remaining) {
		if (picked.length >= 16) break;
		picked.push(file);
	}
	return picked.slice(0, 16);
}

async function grepLayer(options: {
	cwd: string;
	tokens: string[];
	pathClue?: string;
	extraRoots?: string[];
	signal?: AbortSignal;
}): Promise<{ candidates: CodeIntelCandidate[]; used: boolean; files: string[] }> {
	const candidates: CodeIntelCandidate[] = [];
	const globFiles = await globClueFiles(options);
	const workspaceRoots = [
		path.resolve(options.cwd),
		...(options.extraRoots ?? []).map(root => path.resolve(options.cwd, root)),
	];
	const searchRoots = [...new Set([...workspaceRoots, ...globFiles.map(file => path.resolve(options.cwd, file))])];
	const seen = new Set<string>();
	for (const token of options.tokens.slice(0, 8)) {
		if (!GREP_TOKEN.test(token)) continue;
		for (const searchRoot of searchRoots) {
			try {
				const result = await grep({
					pattern: escapeRegexLiteral(token),
					path: searchRoot,
					maxCount: 40,
					maxCountPerFile: 8,
					ignoreCase: true,
					gitignore: true,
					signal: options.signal,
				});
				for (const match of result.matches) {
					if (!match.lineNumber) continue;
					const relative = workspacePath(options.cwd, match.path);
					if (!isSourcePath(relative)) continue;
					const decl = declarationOnLine(match.line);
					const symbol = decl?.name ?? new RegExp(escapeRegexLiteral(token), "i").exec(match.line)?.[0] ?? token;
					const key = `${relative}:${match.lineNumber}:${symbol}`;
					if (seen.has(key)) continue;
					seen.add(key);
					let score = candidateScore(relative, symbol, options.tokens) + pathQuality(relative, options.tokens);
					if (decl?.exported && decl.fn) score += 12;
					else if (decl?.exported) score += 4;
					if (globFiles.includes(relative)) score += 6;
					candidates.push({
						path: relative,
						startLine: match.lineNumber,
						endLine: match.lineNumber,
						symbol,
						provenance: "grep-exact",
						score,
					});
				}
			} catch {
				// Remaining layers still fill the envelope.
			}
		}
	}
	return { candidates, used: candidates.length > 0, files: globFiles };
}

async function tagsFromFiles(options: {
	cwd: string;
	files: string[];
	tokens: string[];
	relation: boolean;
	signal?: AbortSignal;
}): Promise<CodeIntelCandidate[]> {
	const candidates: CodeIntelCandidate[] = [];
	const seen = new Set<string>();
	const rankedFiles = [...options.files].sort(
		(a, b) =>
			candidateScore(b, path.basename(b), options.tokens) +
				pathQuality(b, options.tokens) -
				(candidateScore(a, path.basename(a), options.tokens) + pathQuality(a, options.tokens)) ||
			a.localeCompare(b),
	);
	for (const file of rankedFiles.slice(0, 8)) {
		options.signal?.throwIfAborted();
		const absolute = path.resolve(options.cwd, file);
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		const relative = workspacePath(options.cwd, absolute);
		try {
			const content = await untilAborted(options.signal, Bun.file(absolute).text());
			const lines = content.split("\n");
			const defs: CodeIntelCandidate[] = [];
			const seenDefs = new Set<string>();
			for (let i = 0; i < lines.length; i++) {
				const decl = declarationOnLine(lines[i]);
				if (!decl) continue;
				let score = candidateScore(relative, decl.name, options.tokens) + pathQuality(relative, options.tokens);
				if (decl.exported && decl.fn) score += 12;
				else if (decl.exported) score += 4;
				if (score <= 0) continue;
				const key = `${relative}:${i + 1}:${decl.name}`;
				if (seenDefs.has(key)) continue;
				seenDefs.add(key);
				defs.push({
					path: relative,
					startLine: i + 1,
					endLine: i + 1,
					symbol: decl.name,
					provenance: "syntactic-name-reference",
					score,
				});
			}
			try {
				const extracted = await codeIntelExtractTags({ root: absolute, maxFiles: 1, signal: options.signal });
				for (const tag of extracted.tags) {
					if (tag.kind !== "def") continue;
					const score = candidateScore(relative, tag.name, options.tokens) + pathQuality(relative, options.tokens);
					if (score <= 0) continue;
					defs.push({
						path: relative,
						startLine: tag.startLine,
						endLine: tag.endLine,
						symbol: tag.name,
						provenance: "syntactic-name-reference",
						score,
					});
				}
				if (options.relation) {
					for (const call of extracted.calls) {
						if (!options.tokens.some(token => token.toLowerCase() === call.callee.toLowerCase())) continue;
						candidates.push({
							path: relative,
							startLine: call.startLine,
							endLine: call.endLine,
							symbol: call.callee,
							provenance: "call-expression",
							score: candidateScore(relative, call.callee, options.tokens),
						});
					}
				}
			} catch {
				// Natives extract is optional; line-scan still ranks exported defs.
			}
			defs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.startLine - b.startLine);
			candidates.push(...defs.slice(0, 4));
		} catch {
			// File vanished between glob and read.
		}
	}
	return candidates;
}

async function graphLayer(options: {
	session: ToolSession;
	tokens: string[];
	pathClue?: string;
	relation: boolean;
	grepHits: CodeIntelCandidate[];
	globFiles: string[];
	signal?: AbortSignal;
}): Promise<{ candidates: CodeIntelCandidate[]; used: boolean; gap?: string }> {
	const files = [
		...new Set([
			...options.globFiles,
			...options.grepHits.map(hit => hit.path),
			...(options.pathClue ? [options.pathClue.replaceAll("\\", "/")] : []),
		]),
	];
	const tagHits = await tagsFromFiles({
		cwd: options.session.cwd,
		files,
		tokens: options.tokens,
		relation: options.relation,
		signal: options.signal,
	});
	if (!hasCodeIntelNatives()) {
		return { candidates: tagHits, used: tagHits.length > 0, gap: NATIVE_CODE_INTEL_MISSING };
	}
	const index = getCodeIntelIndex(options.session.cwd, options.session.settings);
	const status = await index.ensureReady(options.signal);
	const seeds = seedPathsFromSession(options.session);
	if (options.pathClue) seeds.unshift(options.pathClue.replaceAll("\\", "/"));
	seeds.unshift(...files);
	const ranked = await index.rank({
		seedPaths: seeds,
		seedSymbols: options.tokens,
		topFiles: 8,
		topSymbols: 16,
		signal: options.signal,
	});
	const candidates: CodeIntelCandidate[] = [...tagHits];
	for (const node of ranked) {
		const relative = node.path.replaceAll("\\", "/");
		const score = candidateScore(relative, node.symbol, options.tokens);
		if (score <= 0) continue;
		candidates.push({
			path: relative,
			startLine: node.startLine,
			endLine: node.endLine,
			symbol: node.symbol,
			provenance: "graph-ranked-context",
			score,
			contentHash: node.contentHash,
		});
	}
	if (options.relation) {
		for (const node of ranked.slice(0, 8)) {
			const absolute = path.resolve(options.session.cwd, node.path);
			try {
				const content = await Bun.file(absolute).text();
				for (const call of codeIntelExtractCalls({ path: node.path, content })) {
					if (!options.tokens.some(token => token.toLowerCase() === call.callee.toLowerCase())) continue;
					candidates.push({
						path: call.path.replaceAll("\\", "/"),
						startLine: call.startLine,
						endLine: call.endLine,
						symbol: call.callee,
						provenance: "call-expression",
						score: candidateScore(call.path, call.callee, options.tokens),
					});
				}
			} catch {
				// File vanished between rank and read.
			}
			if (options.signal?.aborted) break;
		}
	}
	return {
		candidates,
		used: candidates.length > 0,
		gap: status.gap,
	};
}

async function semanticLayer(options: {
	session: ToolSession;
	query: string;
	chinese: boolean;
	signal?: AbortSignal;
}): Promise<{ candidates: CodeIntelCandidate[]; used: boolean; gap?: string }> {
	if (options.session.settings.get("codeIntel.semantic") === false) {
		return { candidates: [], used: false };
	}
	const resolution = resolveCodeIntelEmbedModel(options.session.settings);
	if (!resolution.ok) {
		return { candidates: [], used: false, gap: resolution.reason };
	}
	if (options.chinese && (resolution.englishOnly || isEnglishOnlyEmbedModel(resolution.model))) {
		return {
			candidates: [],
			used: false,
			gap: "semantic model is English-only; identifier/graph/LSP used",
		};
	}
	const index = getCodeIntelIndex(options.session.cwd, options.session.settings);
	index.warm();
	const status = index.status();
	if (!status.embeddingsReady) {
		return { candidates: [], used: false, gap: status.gap ?? "semantic index warming" };
	}
	const hits = await index.semanticHits({ query: options.query, limit: 8, signal: options.signal });
	return {
		candidates: hits.map(hit => ({
			path: hit.path.replaceAll("\\", "/"),
			startLine: hit.startLine,
			endLine: hit.endLine,
			symbol: hit.symbol,
			provenance: "semantic-candidate" as const,
		})),
		used: hits.length > 0,
	};
}

export class CodeIntelTool implements AgentTool<typeof codeIntelSchema, CodeIntelToolDetails> {
	readonly name = "code_intel";
	readonly approval = "read" as const;
	readonly label = "Code Intel";
	readonly summary = "Locate symbols, call edges, and ownership with a verified evidence envelope";
	get customWireName(): string | undefined {
		return workflowToolWireName(this.session, this.name);
	}
	get description(): string {
		return prompt.render(codeIntelDescription, {
			scoutAvailable: isScoutSpawnable(
				this.session.settings.get("task.disabledAgents") as string[] | undefined,
				this.session.getSessionSpawns?.() ?? "*",
			),
		});
	}
	readonly parameters = codeIntelSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): CodeIntelTool | null {
		return session.settings.get("codeIntel.enabled") === false ? null : new CodeIntelTool(session);
	}

	async execute(
		_toolCallId: string,
		params: typeof codeIntelSchema.infer,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CodeIntelToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CodeIntelToolDetails>> {
		return untilAborted(signal, async () => {
			const query = params.query.trim();
			if (!query) throw new ToolError("query must not be empty");
			const timeoutSec = clampTimeout(
				"code_intel",
				this.session.settings.get("codeIntel.timeoutSec"),
				this.session.settings.get("tools.maxTimeout"),
			);
			const timeout = AbortSignal.timeout(timeoutSec * 1000);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const extraRoots = this.session.additionalDirectories ?? [];
			let roots: string[] = [];
			let pathClue: string | undefined;
			const depthDefault = this.session.settings.get("codeIntel.depthDefault") ?? "auto";
			const depth =
				params.depth ?? (depthDefault === "focused" || depthDefault === "extended" ? depthDefault : "auto");
			const coverage = inferCoverage(query, depth);
			const tokens = extractQueryTokens(query);
			const relation = queryHasRelationSignal(query);
			const traverseRelations = relation && coverage === "extended";
			const gaps: string[] = [];
			const candidates: CodeIntelCandidate[] = [];
			const layers = { grep: false, graph: false, lsp: false, semantic: false };
			let timedOut = false;
			const index = getCodeIntelIndex(this.session.cwd, this.session.settings);
			const validate = (layerCandidates: CodeIntelCandidate[]) =>
				revalidateCandidates({
					cwd: this.session.cwd,
					roots,
					candidates: layerCandidates,
					gaps,
					signal: combined,
					onStalePath: stalePath => index.invalidate(path.resolve(this.session.cwd, stalePath)),
				});

			try {
				roots = await authorizedRoots(this.session.cwd, extraRoots, combined);
				pathClue = await normalizePathClue(params.path, this.session.cwd, roots, combined);
				combined.throwIfAborted();
				const grepResult = await grepLayer({
					cwd: this.session.cwd,
					tokens,
					pathClue,
					extraRoots,
					signal: combined,
				});
				layers.grep = grepResult.used;
				const grepLive = await validate(grepResult.candidates);
				candidates.push(...grepLive);
				combined.throwIfAborted();

				const graphResult = await graphLayer({
					session: this.session,
					tokens,
					pathClue,
					relation: traverseRelations,
					grepHits: grepLive,
					globFiles: grepResult.files,
					signal: combined,
				});
				layers.graph = graphResult.used;
				candidates.push(...(await validate(graphResult.candidates)));
				if (graphResult.gap) gaps.push(graphResult.gap);
				combined.throwIfAborted();

				const lspResult = await codeIntelLspLookup({
					session: this.session,
					tokens,
					relation: traverseRelations,
					coverage,
					signal: combined,
				});
				layers.lsp = lspResult.candidates.length > 0;
				candidates.push(...(await validate(lspResult.candidates)));
				gaps.push(...lspResult.gaps);
				combined.throwIfAborted();

				const semanticResult = await semanticLayer({
					session: this.session,
					query,
					chinese: looksChinese(query),
					signal: combined,
				});
				layers.semantic = semanticResult.used;
				candidates.push(...(await validate(semanticResult.candidates)));
				if (semanticResult.gap) gaps.push(semanticResult.gap);
				combined.throwIfAborted();
			} catch (error) {
				if (combined.aborted && timeout.aborted) {
					timedOut = true;
				} else {
					throw error;
				}
			}

			if (timedOut || timeout.aborted) {
				const searched = Object.entries(layers)
					.filter(([, used]) => used)
					.map(([name]) => name);
				gaps.push(`timed out after ${timeoutSec}s; searched ${searched.join(",") || "none"}`);
			}

			const indexStatus = index.status();
			if (indexStatus.state === "warming") gaps.push("semantic index warming");
			if (!layers.grep && !layers.graph && !layers.lsp && !layers.semantic) {
				gaps.push("searched grep, graph, lsp, semantic");
			}

			const built = buildEnvelope({ query, coverage, candidates, gaps });
			built.envelope.evidence = capEvidence(built.envelope.evidence);
			built.envelope.found = built.envelope.evidence.length > 0;
			const text = renderCodeIntelEnvelope(built.envelope);
			const details: CodeIntelToolDetails = {
				coverage: built.envelope.coverage,
				confidence: built.envelope.confidence,
				evidenceCount: built.envelope.evidence.length,
				found: built.envelope.found,
				layers,
				index: {
					state: indexStatus.state,
					filesIndexed: indexStatus.filesIndexed,
					embeddingsReady: indexStatus.embeddingsReady,
				},
			};
			const result = toolResult(details).text(text);
			if (!built.envelope.found && built.semanticOnly.length === 0 && built.envelope.gaps.length === 0) {
				result.useless();
			}
			return result.done();
		});
	}
}

export const codeIntelToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(
		args: { query?: string; depth?: string; path?: string },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const meta: string[] = [];
		if (args.depth) meta.push(`depth:${args.depth}`);
		if (args.path) meta.push(replaceTabs(shortenPath(args.path)));
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Code Intel",
				titleColor: "toolTitle",
				description: replaceTabs(args.query || "?"),
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: CodeIntelToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: { query?: string; path?: string },
	): Component {
		if (result.isError || result.details?.error) {
			return new Text(formatErrorMessage(result.details?.error, uiTheme), 1, 0);
		}
		const details = result.details;
		const body = replaceTabs(result.content?.find(block => block.type === "text")?.text ?? "");
		const meta = [
			details?.coverage ?? "focused",
			formatCount("evidence", details?.evidenceCount ?? 0),
			details?.confidence ?? "low",
		];
		if (args?.path) meta.push(replaceTabs(shortenPath(args.path)));
		const header = renderStatusLine(
			{
				icon: details?.found ? "success" : "warning",
				title: "Code Intel",
				titleColor: "toolTitle",
				description: args?.query ? replaceTabs(args.query) : undefined,
				meta,
			},
			uiTheme,
		);
		return createCachedComponent(
			() => options.expanded,
			width => {
				const lines = options.expanded ? body.split("\n") : body.split("\n").slice(0, 6);
				return [header, ...lines.map(line => uiTheme.fg("toolOutput", line))].map(line =>
					truncateToWidth(line, width, Ellipsis.Omit),
				);
			},
			{ paddingX: 1 },
		);
	},
};
