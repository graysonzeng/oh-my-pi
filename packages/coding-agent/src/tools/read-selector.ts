import type { LineRange } from "@oh-my-pi/pi-tui/tools/line-ranges";
import { parseTailCount } from "./path-utils";
import { mergeLineRanges, parseLineRanges } from "@oh-my-pi/pi-tui/tools/line-ranges";
import { splitInternalUrlSel, splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
/** Parsed representation of a path-embedded selector. */
export type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "conflicts" }
	| { kind: "image" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean }
	/**
	 * `:-N` — the last N lines. Needs the source's line count before it can be sliced.
	 * `ranges` holds the other chunks of a comma list that mixes them in (`:1-12,-15`).
	 */
	| { kind: "tail"; count: number; ranges?: [LineRange, ...LineRange[]]; raw?: boolean };

/**
 * A selector whose bounds are absolute — every kind except `tail`. Slicing
 * helpers take this type so a tail selector cannot silently read from the head;
 * callers convert with {@link resolveTailSelector} once the line count is known.
 */
export type ResolvedSelector = Exclude<ParsedSelector, { kind: "tail" }>;

/** Returns true when the selector requested verbatim/raw output (alone or combined with a range). */
export function isRawSelector(parsed: ParsedSelector): boolean {
	return parsed.kind === "raw" || ((parsed.kind === "lines" || parsed.kind === "tail") && parsed.raw === true);
}

/** Returns true when the selector requested multiple line ranges. */
export function isMultiRange(parsed: ParsedSelector): boolean {
	return (
		(parsed.kind === "lines" && parsed.ranges.length > 1) || (parsed.kind === "tail" && parsed.ranges !== undefined)
	);
}

/**
 * Pin a `:-N` tail selector to absolute lines against a source of `totalLines`
 * lines; every other selector passes through unchanged. The last N lines become
 * one inclusive range clamped to the source (`totalLines - N + 1` .. `totalLines`),
 * so downstream slicing, context expansion, and out-of-bounds reporting behave
 * exactly as for an explicit `:N-M`. Ranges listed with the tail join it in
 * ascending order, merged where they overlap or touch.
 */
export function resolveTailSelector(parsed: ParsedSelector, totalLines: number): ResolvedSelector {
	if (parsed.kind !== "tail") return parsed;
	const startLine = Math.max(1, totalLines - parsed.count + 1);
	const endLine = Math.max(startLine, totalLines);
	if (!parsed.ranges) return { kind: "lines", ranges: [{ startLine, endLine }], raw: parsed.raw };
	return { kind: "lines", ranges: mergeLineRanges([...parsed.ranges, { startLine, endLine }]), raw: parsed.raw };
}

function selectorChunkLooksReadLike(chunk: string): boolean {
	const lower = chunk.toLowerCase();
	return (
		lower === "raw" ||
		lower === "conflicts" ||
		lower === "img" ||
		/^-\d+(?:[-+]\d+)?$/.test(chunk) ||
		parseLineRanges(chunk) !== null
	);
}

function invalidSelector(sel: string): ToolError {
	return new ToolError(
		`Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), :-N (last N lines), a comma-separated list of ranges, :raw, :img for SVG rendering, or a range combined with raw (e.g. :raw:50-100).`,
	);
}

/** Parse a bare (non-compound) chunk as a line-range list, a tail count, or a list mixing both. */
function parseRangeOrTail(chunk: string, raw: boolean): ParsedSelector | null {
	const ranges = parseLineRanges(chunk, raw ? "single" : "onward");
	if (ranges) return raw ? { kind: "lines", ranges, raw } : { kind: "lines", ranges };
	// A list with tails (`1-12,-15`, `-15`) keeps the longest tail; in a list of
	// several chunks a bare `N` stays that one line, as in a plain range list.
	const parts = chunk.split(",");
	let count = 0;
	const listed: string[] = [];
	for (const part of parts) {
		const partCount = parseTailCount(part);
		if (partCount !== null) count = Math.max(count, partCount);
		else listed.push(part);
	}
	if (count === 0) return null;
	// Beside a tail the list has several chunks, so a lone listed `N` is still one line.
	const listedRanges = listed.length > 0 ? parseLineRanges(listed.join(","), "single") : undefined;
	if (listedRanges === null) return null;
	return { kind: "tail", count, ...(listedRanges && { ranges: listedRanges }), ...(raw && { raw }) };
}

export function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };

	// Compound selector: `1-50:raw`, `raw:1-50`, or `raw:-60`. Split into chunks
	// and accept exactly one line range (possibly multi) or tail plus the literal
	// `raw`. Selector-like compounds that are not in that accepted set are invalid
	// rather than "none"; otherwise `read` can silently widen a malformed selector
	// like `artifact://5:conflicts:1-1` while `grep` rejects it.
	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length === 2) {
			const [a, b] = chunks as [string, string];
			const aIsRaw = a.toLowerCase() === "raw";
			const bIsRaw = b.toLowerCase() === "raw";
			const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
			const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
			if (rangeChunk !== null && rawChunk !== null) {
				const parsed = parseRangeOrTail(rangeChunk, true);
				if (parsed) return parsed;
			}
		}
		if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel);
		// Unrecognized compound — fall through (sqlite/archive/url consume their own colon syntax).
		return { kind: "none" };
	}

	if (sel.toLowerCase() === "raw") return { kind: "raw" };
	if (sel.toLowerCase() === "conflicts") return { kind: "conflicts" };
	if (sel.toLowerCase() === "img") return { kind: "image" };
	const parsed = parseRangeOrTail(sel, false);
	if (parsed) return parsed;
	// Unrecognized selectors fall through; sqlite/archive/url readers consume their own colon syntax.
	return { kind: "none" };
}

/**
 * Convert a single-range selector to the offset/limit pair used by internal pagination.
 * Returns the FIRST range only — multi-range callers MUST branch on `isMultiRange` before
 * calling this helper.
 */
export function parseReadPathSelector(path: unknown): ParsedSelector {
	if (typeof path !== "string" || path.length === 0) return { kind: "none" };
	const split = /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? splitInternalUrlSel(path) : splitPathAndSel(path);
	return parseSel(split.sel);
}

/** Explicit bounded ranges and `:raw` must survive ordinary-session tool-output clamps. */
export function shouldPreserveExplicitReadRange(path: unknown): boolean {
	const parsed = parseReadPathSelector(path);
	return parsed.kind === "raw" || parsed.kind === "lines";
}

/** Read tool args historically use `path`; some call sites still pass `file_path`. */
export function readPathFromToolArgs(args: unknown): unknown {
	if (!args || typeof args !== "object") return undefined;
	if (Object.hasOwn(args, "path")) return Reflect.get(args, "path");
	if (Object.hasOwn(args, "file_path")) return Reflect.get(args, "file_path");
	return undefined;
}

export function selToOffsetLimit(parsed: ResolvedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const first = parsed.ranges[0];
		const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined;
		return { offset: first.startLine, limit };
	}
	return {};
}

/**
 * Compose optional Claude-style `offset`/`limit` kwargs onto the path-inline
 * selector contract (history supplement S3). Prefer embedding `:N` / `:raw:N-`
 * in `path`. When a range selector is already present, kwargs are rejected
 * with an explicit message instead of silently re-reading page 1.
 *
 * `0` is treated as omitted so providers that must send every JSON field
 * (strict required+nullable) can pass `offset: 0` / `limit: 0` without a
 * validation round-trip. Non-zero kwargs with an existing range selector
 * still fail closed.
 *
 * Artifact URLs without an existing `:raw` get `:raw` injected so continue-read
 * pages the verbatim body (history E2/E3). Plain filesystem paths compose as
 * `path:301` / `path:301+K` — never force `:raw` onto hashline/preview reads.
 */
export function composeReadPaginationArgs(input: { path: string; offset?: number; limit?: number }): { path: string } {
	const offset = omitZeroPaginationKwarg(input.offset);
	const limit = omitZeroPaginationKwarg(input.limit);
	if (offset === undefined && limit === undefined) return { path: input.path };

	if (offset !== undefined && !(offset >= 1)) {
		throw new ToolError(`Invalid offset ${input.offset}: must be a 1-indexed positive line number.`);
	}
	if (limit !== undefined && !(limit >= 1)) {
		throw new ToolError(`Invalid limit ${input.limit}: must be a positive line count.`);
	}

	const parsed = parseReadPathSelector(input.path);
	if (parsed.kind === "lines" || parsed.kind === "tail") {
		const next = offset !== undefined ? (limit !== undefined ? `:${offset}+${limit}` : `:${offset}-`) : `:1+${limit}`;
		const example = input.path.includes("artifact://") ? "artifact://…:raw:301-" : "path:301";
		throw new ToolError(
			`Stale pagination kwargs: path already declares a line selector (${input.path}). ` +
				`Do not pass separate offset/limit — use the next-page locator from the previous read ` +
				`(for example ${example} or compose onto the path as ${next}). ` +
				`Received offset=${offset ?? "unset"} limit=${limit ?? "unset"}.`,
		);
	}

	const rangeSuffix =
		offset === undefined ? `:1+${limit}` : limit === undefined ? `:${offset}-` : `:${offset}+${limit}`;
	const hasRaw = parsed.kind === "raw" || input.path.split(":").some(chunk => chunk.toLowerCase() === "raw");
	if (hasRaw) return { path: `${input.path}${rangeSuffix}` };
	// Verbatim artifact continue-read needs :raw; ordinary files keep hashline selectors.
	if (/^artifact:\/\//i.test(input.path)) return { path: `${input.path}:raw${rangeSuffix}` };
	return { path: `${input.path}${rangeSuffix}` };
}

/** Strict JSON schemas require every property; models send `0` for “unspecified”. */
function omitZeroPaginationKwarg(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Math.floor(value);
	return n === 0 ? undefined : n;
}
