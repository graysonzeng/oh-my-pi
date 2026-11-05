import {
	type CodeIntelCandidate,
	type CodeIntelConfidence,
	type CodeIntelCoverage,
	type CodeIntelEnvelope,
	type CodeIntelEvidenceLine,
	canEmitCallEdge,
	evidenceKey,
	foldWireScalar,
	kindForProvenance,
	strongerKind,
	toEvidenceLine,
} from "./code-intel-envelope";

const STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"of",
	"to",
	"in",
	"on",
	"for",
	"with",
	"from",
	"by",
	"is",
	"are",
	"was",
	"were",
	"be",
	"this",
	"that",
	"it",
	"as",
	"at",
	"if",
	"then",
	"else",
	"when",
	"where",
	"how",
	"what",
	"which",
	"who",
	"why",
	"does",
	"do",
	"did",
	"can",
	"could",
	"should",
	"would",
	"please",
	"find",
	"show",
	"where",
	"default",
	"code",
	"file",
	"function",
	"class",
	"module",
	"的",
	"了",
	"吗",
	"是",
	"在",
	"和",
	"与",
	"或",
	"把",
	"被",
	"对",
	"从",
	"到",
	"里",
	"中",
	"上",
	"下",
	"什么",
	"哪里",
	"如何",
	"怎么",
	"哪个",
	"默认",
	"调用",
	"实现",
	"查找",
	"位置",
]);

const RELATION_WORDS =
	/\b(call(?:s|ed|ing)?|caller|callee|invoke[sd]?|implement(?:s|ed|ation)?|own(?:s|ed|ership)?|data\s*flow|引用|调用|实现|所有权|数据流)\b/iu;

export function extractQueryTokens(query: string): string[] {
	const tokens = new Set<string>();
	const codeSpans = query.matchAll(/`([^`]+)`/g);
	for (const match of codeSpans) {
		const value = match[1]?.trim();
		if (value) tokens.add(value);
	}
	const ident = query.matchAll(/[A-Za-z_][A-Za-z0-9_.:-]{1,}|[\u4e00-\u9fff]{2,}/g);
	for (const match of ident) {
		const raw = match[0];
		if (STOPWORDS.has(raw.toLowerCase())) continue;
		if (RELATION_WORDS.test(raw)) continue;
		tokens.add(raw);
	}
	return [...tokens].slice(0, 12);
}

export function queryHasRelationSignal(query: string): boolean {
	return RELATION_WORDS.test(query);
}

export function inferCoverage(query: string, depth: "auto" | "focused" | "extended"): CodeIntelCoverage {
	if (depth === "focused" || depth === "extended") return depth;
	return queryHasRelationSignal(query) ? "extended" : "focused";
}

export function escapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function looksChinese(query: string): boolean {
	return /[\u4e00-\u9fff]/.test(query);
}

function splitIdent(value: string): string[] {
	return value
		.replaceAll("\\", "/")
		.split(/[^A-Za-z0-9\u4e00-\u9fff]+/)
		.flatMap(part => part.split(/(?=[A-Z])/))
		.map(part => part.toLowerCase())
		.filter(part => part.length >= 2);
}

function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a[i] === b[i]) i++;
	return i;
}

export function lexicalScore(text: string, tokens: string[]): number {
	const parts = splitIdent(text);
	let score = 0;
	for (const token of tokens) {
		const t = token.toLowerCase();
		if (t.length < 2) continue;
		if (parts.some(part => part === t)) {
			score += 4;
			continue;
		}
		if (parts.some(part => part.startsWith(t) || (t.startsWith(part) && part.length >= 3))) {
			score += 3;
			continue;
		}
		if (parts.some(part => commonPrefixLength(part, t) >= 5)) score += 2;
	}
	return score;
}

export function candidateScore(path: string, symbol: string, tokens: string[]): number {
	let score = lexicalScore(path, tokens) * 2 + lexicalScore(symbol, tokens);
	if (/^[a-z]/.test(symbol)) score += 6;
	if (/^(ensure|create|is|has|should)/.test(symbol)) score += 4;
	const stems = path
		.replaceAll("\\", "/")
		.replace(/\.[^.]+$/, "")
		.split("/")
		.map(part => part.toLowerCase());
	for (const token of tokens) {
		const t = token.toLowerCase();
		if (t.length >= 2 && stems.includes(t)) score += 10;
	}
	return score;
}

function mergeCandidates(candidates: CodeIntelCandidate[]): CodeIntelCandidate[] {
	const byKey = new Map<string, CodeIntelCandidate>();
	for (const candidate of candidates) {
		const key = evidenceKey(candidate.path, candidate.startLine, candidate.endLine);
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, candidate);
			continue;
		}
		const existingKind = kindForProvenance(existing.provenance);
		const nextKind = kindForProvenance(candidate.provenance);
		const winnerKind = strongerKind(existingKind, nextKind);
		const winner = winnerKind === nextKind ? candidate : existing;
		const other = winner === candidate ? existing : candidate;
		if (winner.provenance === "semantic-candidate" && other.provenance !== "semantic-candidate") {
			byKey.set(key, other);
			continue;
		}
		if (other.provenance === "semantic-candidate") {
			byKey.set(key, winner);
			continue;
		}
		if (canEmitCallEdge(other.provenance) && !canEmitCallEdge(winner.provenance)) {
			byKey.set(key, { ...other, score: Math.max(other.score ?? 0, winner.score ?? 0) });
			continue;
		}
		byKey.set(key, { ...winner, score: Math.max(winner.score ?? 0, other.score ?? 0) });
	}
	return [...byKey.values()];
}

export function buildEnvelope(options: {
	query: string;
	coverage: CodeIntelCoverage;
	candidates: CodeIntelCandidate[];
	gaps: string[];
}): { envelope: CodeIntelEnvelope; semanticOnly: CodeIntelCandidate[] } {
	const tokens = extractQueryTokens(options.query);
	const merged = mergeCandidates(options.candidates).map(candidate => ({
		...candidate,
		score: (candidate.score ?? 0) + candidateScore(candidate.path, candidate.symbol, tokens),
	}));
	merged.sort((a, b) => {
		const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
		if (scoreDelta) return scoreDelta;
		const rank = { exact: 0, reference: 1, "source-read": 2, semantic: 3 } as const;
		const aKind = kindForProvenance(a.provenance);
		const bKind = kindForProvenance(b.provenance);
		return rank[aKind] - rank[bKind] || a.path.localeCompare(b.path) || a.startLine - b.startLine;
	});
	const semanticOnly = merged.filter(candidate => candidate.provenance === "semantic-candidate");
	const evidence: CodeIntelEvidenceLine[] = [];
	for (const candidate of merged) {
		const line = toEvidenceLine(candidate);
		if (line) evidence.push(line);
	}
	const gaps = [...options.gaps];
	for (const candidate of semanticOnly) {
		gaps.push(
			`unverified semantic candidate ${candidate.path}:${candidate.startLine}-${candidate.endLine} ${candidate.symbol}`.trim(),
		);
	}
	const found = evidence.length > 0;
	const confidence: CodeIntelConfidence = !found
		? "low"
		: evidence.some(line => line.kind === "exact" || line.kind === "reference")
			? "high"
			: "medium";
	return {
		envelope: {
			intent: foldWireScalar(options.query.trim()),
			coverage: options.coverage,
			evidence,
			gaps: gaps.map(foldWireScalar),
			confidence,
			found,
		},
		semanticOnly,
	};
}

export const MAX_EVIDENCE_FILES = 8;
export const MAX_EVIDENCE_PER_FILE = 4;

export function capEvidence(lines: CodeIntelEvidenceLine[]): CodeIntelEvidenceLine[] {
	const perFile = new Map<string, number>();
	const out: CodeIntelEvidenceLine[] = [];
	for (const line of lines) {
		const used = perFile.get(line.path) ?? 0;
		if (used >= MAX_EVIDENCE_PER_FILE) continue;
		if (used === 0 && perFile.size >= MAX_EVIDENCE_FILES) continue;
		perFile.set(line.path, used + 1);
		out.push(line);
	}
	return out;
}
