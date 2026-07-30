import { describe, expect, it } from "bun:test";
import {
	buildContextLedger,
	type ContextArtifactAdapter,
	type ContextEntry,
	optimizeContextEntries,
	withContextProviderUsage,
} from "../../src/workflow/context-ledger";

const entries: ContextEntry[] = [
	{ id: "attachment-1", bucket: "artifacts", kind: "attachment", content: "same attachment" },
	{ id: "attachment-2", bucket: "artifacts", kind: "attachment", content: "same attachment" },
	{ id: "tool-old", bucket: "tool_results", kind: "tool_result", content: "old tool body", replaceable: true },
	{ id: "tool-current", bucket: "tool_results", kind: "tool_result", content: "current tool body" },
];

function artifactAdapter(options: { verify?: boolean; fail?: boolean } = {}): ContextArtifactAdapter {
	return {
		async persist(entry, sha256) {
			if (options.fail) throw new Error("persistence failed");
			return { uri: `artifact://${entry.id}`, sha256 };
		},
		async verify(_uri, _sha256) {
			return options.verify !== false;
		},
	};
}

describe("ContextLedgerV1", () => {
	it("deduplicates only byte-identical eligible entries and replaces old tool results with verified one-hop refs", async () => {
		const result = await optimizeContextEntries(entries, artifactAdapter());

		expect(result.entries.map(entry => ({ id: entry.id, content: entry.content }))).toEqual([
			{ id: "attachment-1", content: "same attachment" },
			{ id: "attachment-2", content: "[context ref: artifact://attachment-2]" },
			{ id: "tool-old", content: "[context ref: artifact://tool-old]" },
			{ id: "tool-current", content: "current tool body" },
		]);
		expect(result.receipts).toHaveLength(2);
		expect(result.receipts[0]).toMatchObject({
			entryId: "attachment-2",
			retainedEntryId: "attachment-1",
			transform: "dedupe_exact",
			artifactRef: "artifact://attachment-2",
			estimateVersion: "estimate:utf8_bytes_div_4_v1",
		});
		expect(result.receipts[1]).toMatchObject({
			entryId: "tool-old",
			transform: "artifact_ref",
			artifactRef: "artifact://tool-old",
		});
		expect(result.receipts.every(receipt => receipt.originalSha256.length === 64)).toBe(true);
	});

	it("keeps inline originals when persistence or integrity verification fails", async () => {
		const failed = await optimizeContextEntries(entries, artifactAdapter({ fail: true }));
		const unverified = await optimizeContextEntries(entries, artifactAdapter({ verify: false }));

		expect(failed.entries).toEqual(entries);
		expect(unverified.entries).toEqual(entries);
		expect(failed.receipts).toEqual([]);
		expect(unverified.receipts).toEqual([]);
	});

	it("does not merge semantically similar content with different byte hashes", async () => {
		const similar: ContextEntry[] = [
			{ id: "a", bucket: "history", kind: "reminder", content: "Run tests now" },
			{ id: "b", bucket: "history", kind: "reminder", content: "Please run the tests now" },
		];
		const result = await optimizeContextEntries(similar, artifactAdapter());
		expect(result.entries).toEqual(similar);
		expect(result.receipts).toEqual([]);
	});

	it("records versioned per-bucket estimates alongside provider facts and unknown cache counters", () => {
		const ledger = buildContextLedger({
			requestId: "req-1",
			provider: "openai",
			model: "gpt-test",
			api: "responses",
			entries,
			output: "done",
			providerUsage: { inputTokens: 23, outputTokens: 4 },
		});

		expect(ledger.schemaVersion).toBe(1);
		expect(ledger.measurementVersion).toBe("estimate:utf8_bytes_div_4_v1");
		expect(ledger.buckets.artifacts).toEqual({
			bytes: 30,
			tokens: 8,
			provenance: "estimate",
			measurement: "estimate:utf8_bytes_div_4_v1",
		});
		expect(ledger.providerUsage.inputTokens).toEqual({ value: 23, provenance: "provider_fact" });
		expect(ledger.providerUsage.outputTokens).toEqual({ value: 4, provenance: "provider_fact" });
		expect(ledger.providerUsage.cacheReadTokens).toEqual({ value: null, provenance: "unknown" });
		expect(ledger.providerUsage.cacheWriteTokens).toEqual({ value: null, provenance: "unknown" });
		expect(ledger.buckets.output.tokens).toBe(1);
	});

	it("merges only observed provider usage while preserving unknown counters", () => {
		const ledger = buildContextLedger({
			requestId: "req-usage",
			provider: "anthropic",
			model: "claude-test",
			api: "messages",
			entries: [],
		});
		const merged = withContextProviderUsage(ledger, { input: 100, output: 20, cacheRead: 40 });

		expect(merged.providerUsage.inputTokens).toEqual({ value: 100, provenance: "provider_fact" });
		expect(merged.providerUsage.outputTokens).toEqual({ value: 20, provenance: "provider_fact" });
		expect(merged.providerUsage.cacheReadTokens).toEqual({ value: 40, provenance: "provider_fact" });
		expect(merged.providerUsage.cacheWriteTokens).toEqual({ value: null, provenance: "unknown" });
		expect(ledger.providerUsage.inputTokens).toEqual({ value: null, provenance: "unknown" });
	});
});
