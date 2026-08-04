import { describe, expect, it } from "bun:test";
import {
	buildContextLedger,
	buildReadToolContextEntry,
	type ContextArtifactAdapter,
	type ContextEntry,
	optimizeContextEntries,
	withContextProviderUsage,
} from "../../src/workflow/context-ledger";
import { sha256Hex } from "../../src/workflow/optimization-receipt";

const entries: ContextEntry[] = [
	{ id: "attachment-1", bucket: "artifacts", kind: "attachment", content: "same attachment" },
	{ id: "attachment-2", bucket: "artifacts", kind: "attachment", content: "same attachment" },
	{ id: "tool-old", bucket: "tool_results", kind: "tool_result", content: "old tool body", replaceable: true },
	{ id: "tool-current", bucket: "tool_results", kind: "tool_result", content: "current tool body" },
];

function artifactAdapter(options: { verify?: boolean; fail?: boolean } = {}): ContextArtifactAdapter {
	let nextId = 1;
	return {
		async persist(_entry, sha256) {
			if (options.fail) throw new Error("persistence failed");
			const uri = `artifact://${nextId++}`;
			return { uri, sha256 };
		},
		async verify(_uri, _sha256) {
			return options.verify !== false;
		},
	};
}

function contextRef(uri: string, content: string): string {
	return `[context ref: ${uri} sha256:${sha256Hex(content)}]`;
}

const readViewDefaults = {
	canonicalSource: "/repo/src/file.ts",
	normalizedSelector: "full",
	branchOrWorktreeScope: "repo@main",
	providerViewIdentity: "view:1",
	contentOrRevisionIdentity: "rev:1",
	outputMode: "raw" as const,
};

function readEntry(id: string, content: string, overrides: Partial<typeof readViewDefaults> = {}): ContextEntry {
	const entry = buildReadToolContextEntry({
		id,
		content,
		readViewKeyParts: { ...readViewDefaults, ...overrides },
	});
	if (!entry) throw new Error("read fixture must be successful");
	return entry;
}

describe("ContextLedgerV1", () => {
	it("deduplicates only byte-identical eligible entries and replaces old tool results with verified one-hop refs", async () => {
		const result = await optimizeContextEntries(entries, artifactAdapter());

		expect(result.entries.map(entry => ({ id: entry.id, content: entry.content }))).toEqual([
			{ id: "attachment-1", content: "same attachment" },
			{ id: "attachment-2", content: contextRef("artifact://1", "same attachment") },
			{ id: "tool-old", content: contextRef("artifact://2", "old tool body") },
			{ id: "tool-current", content: "current tool body" },
		]);
		expect(result.receipts).toHaveLength(2);
		expect(result.receipts[0]).toMatchObject({
			entryId: "attachment-2",
			retainedEntryId: "attachment-1",
			transform: "dedupe_exact",
			artifactRef: "artifact://1",
			estimateVersion: "estimate:utf8_bytes_div_4_v1",
		});
		expect(result.receipts[1]).toMatchObject({
			entryId: "tool-old",
			transform: "artifact_ref",
			artifactRef: "artifact://2",
		});
		expect(result.receipts.every(receipt => receipt.originalSha256.length === 64)).toBe(true);
		expect(result.receipts.every(receipt => /^artifact:\/\/\d+$/.test(receipt.artifactRef))).toBe(true);
	});

	it("deduplicates successful read results only for the same eligible view and content hash", async () => {
		const first = readEntry("read-1", "same read body");
		const second = readEntry("read-2", "same read body");
		const result = await optimizeContextEntries([first, second], artifactAdapter());

		expect(result.entries[0]?.content).toBe("same read body");
		expect(result.entries[1]?.content).toBe(contextRef("artifact://1", "same read body"));
		expect(result.receipts[0]).toMatchObject({
			entryId: "read-2",
			retainedEntryId: "read-1",
			transform: "dedupe_exact",
		});
	});

	it("keeps full payloads when branch, selector, or provider view changes", async () => {
		const result = await optimizeContextEntries(
			[
				readEntry("branch", "same read body", { branchOrWorktreeScope: "repo@feature" }),
				readEntry("selector", "same read body", { normalizedSelector: "raw" }),
				readEntry("provider", "same read body", { providerViewIdentity: "view:2" }),
			],
			artifactAdapter(),
		);

		expect(result.entries.map(entry => entry.content)).toEqual([
			"same read body",
			"same read body",
			"same read body",
		]);
		expect(result.receipts).toEqual([]);
	});

	it("fails open for ineligible read identities or immutable hash mismatches", async () => {
		const ineligible = [
			readEntry("ineligible-1", "same read body", { branchOrWorktreeScope: "", providerViewIdentity: "" }),
			readEntry("ineligible-2", "same read body", { branchOrWorktreeScope: "", providerViewIdentity: "" }),
		];
		const mismatched = readEntry("mismatch", "same read body");
		mismatched.immutableSha256 = "0".repeat(64);
		const result = await optimizeContextEntries([...ineligible, mismatched], artifactAdapter());

		expect(result.entries.map(entry => entry.content)).toEqual([
			"same read body",
			"same read body",
			"same read body",
		]);
		expect(result.receipts).toEqual([]);
	});

	it("fails open when a retained read artifact cannot be verified", async () => {
		const first = readEntry("verify-1", "same read body");
		const second = readEntry("verify-2", "same read body");
		const result = await optimizeContextEntries([first, second], artifactAdapter({ verify: false }));

		expect(result.entries.map(entry => entry.content)).toEqual(["same read body", "same read body"]);
		expect(result.receipts).toEqual([]);
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
		const withoutCache = withContextProviderUsage(ledger, { input: 100, output: 20, cacheRead: 40 });
		expect(withoutCache.providerUsage.inputTokens).toEqual({ value: 100, provenance: "provider_fact" });
		expect(withoutCache.providerUsage.outputTokens).toEqual({ value: 20, provenance: "provider_fact" });
		expect(withoutCache.providerUsage.cacheReadTokens).toEqual({ value: null, provenance: "unknown" });
		expect(withoutCache.providerUsage.cacheWriteTokens).toEqual({ value: null, provenance: "unknown" });

		const withCache = withContextProviderUsage(
			ledger,
			{ input: 100, output: 20, cacheRead: 40 },
			{ cacheReadObservable: true },
		);
		expect(withCache.providerUsage.cacheReadTokens).toEqual({ value: 40, provenance: "provider_fact" });
		expect(withCache.providerUsage.cacheWriteTokens).toEqual({ value: null, provenance: "unknown" });
		expect(ledger.providerUsage.inputTokens).toEqual({ value: null, provenance: "unknown" });
	});
});
