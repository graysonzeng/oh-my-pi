import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SymbolKind = "function" | "class" | "interface" | "variable";

export interface RepoSymbol {
	name: string;
	type: SymbolKind;
	line: number;
	signature?: string;
}

export interface RepoMapEntry {
	path: string;
	symbols: RepoSymbol[];
	/** PageRank-like importance 0–1 after ranking. */
	importance: number;
}

export interface RepoMapOptions {
	cwd: string;
	/** Paths the user/task already cares about (boost). */
	relevantFiles?: string[];
	maxFiles?: number;
	strategy?: "full-content" | "symbols-only" | "hybrid";
	/** Optional pre-scanned entries (tests / callers that already walked the tree). */
	entries?: RepoMapEntry[];
	/** Max source files to scan when walking cwd. */
	maxScanFiles?: number;
}

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

/**
 * Build a compressed repo map for context injection.
 * Uses regex symbol extraction (tree-sitter optional future); never throws on parse failure.
 */
export async function buildRepoMap(opts: RepoMapOptions): Promise<string> {
	const maxFiles = opts.maxFiles ?? 12;
	const strategy = opts.strategy ?? "hybrid";
	const relevant = new Set((opts.relevantFiles ?? []).map(p => normalizeRel(opts.cwd, p)));

	let entries = opts.entries;
	if (!entries) {
		entries = await scanWorkspace(opts.cwd, opts.maxScanFiles ?? 80);
	}

	const ranked = rankEntries(entries, relevant).slice(0, maxFiles);
	return renderRepoMap(ranked, strategy);
}

export async function scanWorkspace(cwd: string, maxScanFiles: number): Promise<RepoMapEntry[]> {
	const files: string[] = [];
	await walk(cwd, cwd, files, maxScanFiles);
	const entries: RepoMapEntry[] = [];
	for (const abs of files) {
		const rel = path.relative(cwd, abs).split(path.sep).join("/");
		try {
			const content = await Bun.file(abs).text();
			const symbols = extractSymbolsFromSource(content, path.extname(abs));
			entries.push({ path: rel, symbols, importance: 0 });
		} catch {
			// skip unreadable
		}
	}
	return entries;
}

async function walk(_root: string, dir: string, out: string[], max: number): Promise<void> {
	if (out.length >= max) return;
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (out.length >= max) return;
		if (name === "node_modules" || name === ".git" || name === "dist" || name === "build" || name === "coverage") {
			continue;
		}
		const abs = path.join(dir, name);
		let st: Stats;
		try {
			st = await fs.stat(abs);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			await walk(_root, abs, out, max);
		} else if (st.isFile() && SOURCE_EXT.has(path.extname(name))) {
			out.push(abs);
		}
	}
}

/**
 * Regex-based symbol extraction — honest fallback when tree-sitter is unavailable.
 * Covers common TS/JS/Python declarations.
 */
export function extractSymbolsFromSource(content: string, ext: string): RepoSymbol[] {
	const symbols: RepoSymbol[] = [];
	const lines = content.split("\n");
	const isPy = ext === ".py";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const lineNo = i + 1;

		if (isPy) {
			const fn = line.match(/^\s*def\s+([A-Za-z_][\w]*)\s*(\([^)]*\))?/);
			if (fn) {
				symbols.push({
					name: fn[1]!,
					type: "function",
					line: lineNo,
					signature: fn[2] ? `${fn[1]}${fn[2]}` : undefined,
				});
				continue;
			}
			const cls = line.match(/^\s*class\s+([A-Za-z_][\w]*)/);
			if (cls) {
				symbols.push({ name: cls[1]!, type: "class", line: lineNo });
			}
			continue;
		}

		// TS/JS
		const fn =
			line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/) ||
			line.match(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/);
		if (fn) {
			symbols.push({
				name: fn[1]!,
				type: "function",
				line: lineNo,
				signature: fn[2] ? `${fn[1]}${fn[2]}` : undefined,
			});
			continue;
		}
		const cls = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
		if (cls) {
			symbols.push({ name: cls[1]!, type: "class", line: lineNo });
			continue;
		}
		const iface = line.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/);
		if (iface) {
			symbols.push({ name: iface[1]!, type: "interface", line: lineNo });
			continue;
		}
		const typeAlias = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/);
		if (typeAlias) {
			symbols.push({ name: typeAlias[1]!, type: "interface", line: lineNo });
		}
	}

	return symbols;
}

/**
 * Rank files: relevant paths boost, denser symbol graphs score higher, path depth slightly lower.
 */
export function rankEntries(entries: RepoMapEntry[], relevant: Set<string>): RepoMapEntry[] {
	const maxSymbols = Math.max(1, ...entries.map(e => e.symbols.length));
	return entries
		.map(e => {
			const isRelevant = relevant.has(e.path) || [...relevant].some(r => e.path.endsWith(r) || r.endsWith(e.path));
			// Relevant paths always outrank pure symbol density so task focus wins.
			const relBoost = isRelevant ? 1.0 : 0;
			const symbolScore = (e.symbols.length / maxSymbols) * 0.4;
			const depthPenalty = Math.min(0.15, e.path.split("/").length * 0.02);
			const importance = Math.min(2, Math.max(0, relBoost + symbolScore + 0.1 - depthPenalty));
			return { ...e, importance };
		})
		.sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path));
}

export function renderRepoMap(entries: RepoMapEntry[], strategy: "full-content" | "symbols-only" | "hybrid"): string {
	if (entries.length === 0) return "(repo-map empty)";

	if (strategy === "full-content") {
		return entries.map(e => e.path).join("\n");
	}

	if (strategy === "symbols-only") {
		return entries
			.map(e => {
				const body =
					e.symbols.length === 0
						? "  (no symbols)"
						: e.symbols.map(s => `  ${s.type} ${s.signature ?? s.name} (L${s.line})`).join("\n");
				return `${e.path}:\n${body}`;
			})
			.join("\n\n");
	}

	// hybrid: top 3 as path markers for full read; rest symbols-only
	const top = entries.slice(0, 3).map(e => `${e.path}:\n  [priority — use read tool for full content]`);
	const rest = entries.slice(3).map(e => {
		const body = e.symbols.length === 0 ? "  (no symbols)" : e.symbols.map(s => `  ${s.type} ${s.name}`).join("\n");
		return `${e.path}:\n${body}`;
	});
	return [...top, ...rest].join("\n\n");
}

function normalizeRel(cwd: string, p: string): string {
	if (path.isAbsolute(p)) return path.relative(cwd, p).split(path.sep).join("/");
	return p.split(path.sep).join("/");
}
