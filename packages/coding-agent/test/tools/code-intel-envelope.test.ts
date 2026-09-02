import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { applyEmbedInstructionPrefix } from "../../src/mnemopi/embed-protocol";
import { resolveCodeIntelEmbedModel } from "../../src/tools/code-intel-embed";
import {
	assertWireGrammar,
	type CodeIntelCandidate,
	type CodeIntelEnvelope,
	canEmitCallEdge,
	parseCodeIntelEnvelope,
	renderCodeIntelEnvelope,
	toEvidenceLine,
} from "../../src/tools/code-intel-envelope";
import { buildEnvelope, candidateScore, extractQueryTokens, looksChinese } from "../../src/tools/code-intel-merge";

function envelope(overrides: Partial<CodeIntelEnvelope> = {}): CodeIntelEnvelope {
	return {
		intent: "where is isolated task worktree created",
		coverage: "focused",
		evidence: [
			{
				path: "packages/coding-agent/src/task/worktree.ts",
				startLine: 449,
				endLine: 460,
				symbol: "ensureIsolation",
				relationship: "name matches query token",
				kind: "exact",
			},
		],
		gaps: [],
		confidence: "high",
		found: true,
		...overrides,
	};
}

describe("code_intel wire grammar", () => {
	it("renders marker, field order, and evidence rows a consumer can parse", () => {
		const text = renderCodeIntelEnvelope(envelope());
		const parsed = assertWireGrammar(text);
		expect(parsed.marker).toBe("CCE_SEARCH_RESULT");
		expect(parsed.fieldOrder).toEqual(["intent", "coverage", "evidence", "gaps", "confidence"]);
		expect(parsed.found).toBe(true);
		expect(parsed.evidence[0]).toContain("ensureIsolation");
		expect(parsed.evidence[0]).toMatch(/\| exact$/);
	});

	it("renders NOT_FOUND when evidence is empty", () => {
		const text = renderCodeIntelEnvelope(
			envelope({ evidence: [], found: false, confidence: "low", gaps: ["searched grep, graph, lsp, semantic"] }),
		);
		const parsed = parseCodeIntelEnvelope(text);
		expect(parsed.found).toBe(false);
		expect(parsed.evidence).toContain("NOT_FOUND");
		expect(parsed.gaps.some(gap => gap.includes("searched"))).toBe(true);
	});

	it("refuses to emit calls from semantic or identifier-tag provenance", () => {
		const semantic: CodeIntelCandidate = {
			path: "src/a.ts",
			startLine: 1,
			endLine: 1,
			symbol: "beta",
			provenance: "semantic-candidate",
		};
		const tags: CodeIntelCandidate = {
			path: "src/a.ts",
			startLine: 2,
			endLine: 2,
			symbol: "beta",
			provenance: "syntactic-name-reference",
		};
		expect(canEmitCallEdge("semantic-candidate")).toBe(false);
		expect(canEmitCallEdge("syntactic-name-reference")).toBe(false);
		expect(canEmitCallEdge("graph-ranked-context")).toBe(false);
		expect(canEmitCallEdge("lsp-call")).toBe(true);
		expect(canEmitCallEdge("call-expression")).toBe(true);
		expect(toEvidenceLine(semantic)).toBeNull();
		expect(toEvidenceLine(tags)?.relationship).not.toMatch(/calls|called by/);
	});

	it("keeps incoming LSP call edges as called by", () => {
		const line = toEvidenceLine({
			path: "src/a.ts",
			startLine: 10,
			endLine: 10,
			symbol: "alpha",
			provenance: "lsp-call",
			incoming: true,
		});
		expect(line?.relationship).toBe("called by");
		expect(line?.kind).toBe("reference");
	});

	it("merges semantic onto a stronger layer instead of emitting a call edge", () => {
		const { envelope: built, semanticOnly } = buildEnvelope({
			query: "who calls beta",
			coverage: "extended",
			candidates: [
				{
					path: "src/a.ts",
					startLine: 4,
					endLine: 4,
					symbol: "beta",
					provenance: "semantic-candidate",
				},
				{
					path: "src/a.ts",
					startLine: 4,
					endLine: 4,
					symbol: "beta",
					provenance: "call-expression",
				},
			],
			gaps: [],
		});
		expect(semanticOnly).toEqual([]);
		expect(built.evidence).toHaveLength(1);
		expect(built.evidence[0]?.relationship).toBe("calls");
		expect(built.evidence[0]?.kind).toBe("reference");
	});
});

describe("code_intel query tokens", () => {
	it("extracts identifier tokens from English and Chinese queries", () => {
		expect(extractQueryTokens("where is isolated task worktree created")).toContain("worktree");
		expect(extractQueryTokens("task 子代理 isolation 是在哪创建 worktree 的")).toContain("worktree");
		expect(looksChinese("task 子代理 isolation 是在哪创建 worktree 的")).toBe(true);
	});

	it("ranks corpus anchors above unrelated files for English and Chinese queries", () => {
		const isolation = extractQueryTokens("where is isolated task worktree created");
		expect(
			candidateScore("packages/coding-agent/src/task/worktree.ts", "ensureIsolation", isolation),
		).toBeGreaterThan(candidateScore("packages/coding-agent/src/tools/grep.ts", "grep", isolation));
		const chineseIsolation = extractQueryTokens("task 子代理 isolation 是在哪创建 worktree 的");
		expect(
			candidateScore("packages/coding-agent/src/task/worktree.ts", "ensureIsolation", chineseIsolation),
		).toBeGreaterThan(0);
		const wait = extractQueryTokens("does hub wait timeout mark a still-running job useless");
		expect(
			candidateScore("packages/coding-agent/src/tools/hub/jobs.ts", "isWaitingPollDetails", wait),
		).toBeGreaterThan(candidateScore("packages/coding-agent/src/tools/grep.ts", "grep", wait));
		const rename = extractQueryTokens("does LSP rename apply by default");
		expect(candidateScore("packages/coding-agent/src/lsp/tool.ts", "shouldApply", rename)).toBeGreaterThan(
			candidateScore("packages/coding-agent/src/edit/modes/apply-patch.ts", "expandApplyPatchToEntries", rename),
		);
		expect(candidateScore("packages/coding-agent/src/lsp/tool.ts", "shouldApply", rename)).toBeGreaterThan(
			candidateScore("packages/coding-agent/src/tools/grep.ts", "grep", rename),
		);
	});
});

describe("code_intel embed contract", () => {
	it("prefixes E5 query/passage texts and leaves BGE unchanged", () => {
		expect(applyEmbedInstructionPrefix("fast-multilingual-e5-large", ["alpha"], "query")).toEqual(["query: alpha"]);
		expect(applyEmbedInstructionPrefix("fast-multilingual-e5-large", ["alpha"], "passage")).toEqual([
			"passage: alpha",
		]);
		expect(applyEmbedInstructionPrefix("fast-bge-base-en-v1.5", ["alpha"], "query")).toEqual(["alpha"]);
		expect(applyEmbedInstructionPrefix("fast-multilingual-e5-large", ["alpha"], undefined)).toEqual(["alpha"]);
	});

	it("rejects remote embedding models and URLs", () => {
		const remoteUrl = Settings.isolated({ "mnemopi.embeddingApiUrl": "https://api.openai.com/v1" });
		expect(resolveCodeIntelEmbedModel(remoteUrl).ok).toBe(false);
		const openai = Settings.isolated({ "mnemopi.embeddingModel": "text-embedding-3-large" });
		expect(resolveCodeIntelEmbedModel(openai).ok).toBe(false);
		const local = Settings.isolated({ "mnemopi.embeddingVariant": "en" });
		const resolved = resolveCodeIntelEmbedModel(local);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.model).toBe("fast-bge-base-en-v1.5");
			expect(resolved.englishOnly).toBe(true);
		}
	});
});
