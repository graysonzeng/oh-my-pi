/**
 * CCE_SEARCH_RESULT wire grammar: render + parse.
 *
 * Provenance is a closed discriminated union that cannot be dropped before
 * render. Semantic and identifier-tag hits never emit `calls` / `called by`.
 */

export const CCE_MARKER = "CCE_SEARCH_RESULT";

export type CodeIntelCoverage = "focused" | "extended";
export type CodeIntelConfidence = "high" | "medium" | "low";
export type CodeIntelKind = "exact" | "reference" | "source-read" | "semantic";

export type CodeIntelProvenance =
	| "grep-exact"
	| "graph-ranked-context"
	| "syntactic-name-reference"
	| "lsp-reference"
	| "lsp-call"
	| "call-expression"
	| "semantic-candidate";

export interface CodeIntelCandidate {
	path: string;
	startLine: number;
	endLine: number;
	symbol: string;
	provenance: CodeIntelProvenance;
	contentHash?: string;
	incoming?: boolean;
	score?: number;
}

export interface CodeIntelEvidenceLine {
	path: string;
	startLine: number;
	endLine: number;
	symbol: string;
	relationship: string;
	kind: CodeIntelKind;
}

export interface CodeIntelEnvelope {
	intent: string;
	coverage: CodeIntelCoverage;
	evidence: CodeIntelEvidenceLine[];
	gaps: string[];
	confidence: CodeIntelConfidence;
	found: boolean;
}

export const CALL_EDGE_PROVENANCE: ReadonlySet<CodeIntelProvenance> = new Set(["lsp-call", "call-expression"]);

const KIND_RANK: Record<CodeIntelKind, number> = {
	exact: 4,
	reference: 3,
	"source-read": 2,
	semantic: 1,
};

const PROVENANCE_KIND: Record<CodeIntelProvenance, CodeIntelKind> = {
	"grep-exact": "exact",
	"graph-ranked-context": "source-read",
	"syntactic-name-reference": "source-read",
	"lsp-reference": "reference",
	"lsp-call": "reference",
	"call-expression": "reference",
	"semantic-candidate": "semantic",
};

const PROVENANCE_RELATIONSHIP: Record<CodeIntelProvenance, string> = {
	"grep-exact": "name matches query token",
	"graph-ranked-context": "ranked by def/ref graph",
	"syntactic-name-reference": "name reference (syntactic)",
	"lsp-reference": "referenced",
	"lsp-call": "calls",
	"call-expression": "calls",
	"semantic-candidate": "similar",
};

export function kindForProvenance(provenance: CodeIntelProvenance): CodeIntelKind {
	return PROVENANCE_KIND[provenance];
}

export function relationshipForProvenance(provenance: CodeIntelProvenance, incoming = false): string {
	if (provenance === "lsp-call" || provenance === "call-expression") {
		return incoming ? "called by" : "calls";
	}
	return PROVENANCE_RELATIONSHIP[provenance];
}

export function canEmitCallEdge(provenance: CodeIntelProvenance): boolean {
	return CALL_EDGE_PROVENANCE.has(provenance);
}

export function strongerKind(a: CodeIntelKind, b: CodeIntelKind): CodeIntelKind {
	return KIND_RANK[a] >= KIND_RANK[b] ? a : b;
}

export function evidenceKey(path: string, startLine: number, endLine: number): string {
	return `${path.replaceAll("\\", "/")}:${startLine}-${endLine}`;
}

export function toEvidenceLine(candidate: CodeIntelCandidate, incoming = false): CodeIntelEvidenceLine | null {
	if (candidate.provenance === "semantic-candidate") return null;
	const relationship = relationshipForProvenance(candidate.provenance, incoming || candidate.incoming === true);
	if ((relationship === "calls" || relationship === "called by") && !canEmitCallEdge(candidate.provenance)) {
		return null;
	}
	return {
		path: candidate.path.replaceAll("\\", "/"),
		startLine: candidate.startLine,
		endLine: candidate.endLine,
		symbol: candidate.symbol,
		relationship,
		kind: kindForProvenance(candidate.provenance),
	};
}

export function renderCodeIntelEnvelope(envelope: CodeIntelEnvelope): string {
	const evidenceBlock =
		envelope.evidence.length === 0
			? "  NOT_FOUND"
			: envelope.evidence
					.map(
						line =>
							`  - ${line.path}:${line.startLine}-${line.endLine} | ${line.symbol} | ${line.relationship} | ${line.kind}`,
					)
					.join("\n");
	const gapsBlock = envelope.gaps.length === 0 ? "" : `\n${envelope.gaps.map(gap => `  - ${gap}`).join("\n")}`;
	return [
		CCE_MARKER,
		`intent: ${envelope.intent}`,
		`coverage: ${envelope.coverage}`,
		`evidence:`,
		evidenceBlock,
		`gaps:${gapsBlock}`,
		`confidence: ${envelope.confidence}`,
	].join("\n");
}

export interface ParsedCodeIntelEnvelope {
	marker: string;
	fieldOrder: string[];
	intent: string;
	coverage: string;
	evidence: string[];
	gaps: string[];
	confidence: string;
	found: boolean;
}

const FIELD_ORDER = ["intent", "coverage", "evidence", "gaps", "confidence"] as const;

export function parseCodeIntelEnvelope(text: string): ParsedCodeIntelEnvelope {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	if (lines[0] !== CCE_MARKER) {
		throw new Error(`envelope must start with ${CCE_MARKER}`);
	}
	const fieldOrder: string[] = [];
	let intent = "";
	let coverage = "";
	let confidence = "";
	const evidence: string[] = [];
	const gaps: string[] = [];
	let section: "evidence" | "gaps" | null = null;
	for (const line of lines.slice(1)) {
		if (line.startsWith("intent:")) {
			fieldOrder.push("intent");
			intent = line.slice("intent:".length).trim();
			section = null;
			continue;
		}
		if (line.startsWith("coverage:")) {
			fieldOrder.push("coverage");
			coverage = line.slice("coverage:".length).trim();
			section = null;
			continue;
		}
		if (line === "evidence:" || line.startsWith("evidence:")) {
			fieldOrder.push("evidence");
			section = "evidence";
			const rest = line.slice("evidence:".length).trim();
			if (rest) evidence.push(rest);
			continue;
		}
		if (line === "gaps:" || line.startsWith("gaps:")) {
			fieldOrder.push("gaps");
			section = "gaps";
			const rest = line.slice("gaps:".length).trim();
			if (rest) gaps.push(rest.replace(/^- /, ""));
			continue;
		}
		if (line.startsWith("confidence:")) {
			fieldOrder.push("confidence");
			confidence = line.slice("confidence:".length).trim();
			section = null;
			continue;
		}
		if (section === "evidence") {
			evidence.push(line.trim());
		} else if (section === "gaps") {
			gaps.push(line.trim().replace(/^- /, ""));
		}
	}
	const found = !evidence.some(row => row === "NOT_FOUND") && evidence.some(row => row.startsWith("- "));
	return {
		marker: CCE_MARKER,
		fieldOrder,
		intent,
		coverage,
		evidence,
		gaps,
		confidence,
		found,
	};
}

export function assertWireGrammar(text: string): ParsedCodeIntelEnvelope {
	const parsed = parseCodeIntelEnvelope(text);
	if (parsed.fieldOrder.join(",") !== FIELD_ORDER.join(",")) {
		throw new Error(`field order must be ${FIELD_ORDER.join(" / ")}; got ${parsed.fieldOrder.join(" / ")}`);
	}
	if (!["focused", "extended"].includes(parsed.coverage)) {
		throw new Error(`coverage must be focused|extended, got ${parsed.coverage}`);
	}
	if (!["high", "medium", "low"].includes(parsed.confidence)) {
		throw new Error(`confidence must be high|medium|low, got ${parsed.confidence}`);
	}
	for (const row of parsed.evidence) {
		if (row === "NOT_FOUND") continue;
		const match = row.match(/^- .+?:\d+-\d+ \| .+ \| .+ \| (exact|reference|source-read|semantic)$/);
		if (!match) throw new Error(`invalid evidence row: ${row}`);
		if (/\b(calls|called by)\b/.test(row) && /\| semantic$/.test(row)) {
			throw new Error(`semantic row must not claim a call edge: ${row}`);
		}
	}
	return parsed;
}
