import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { buildReadToolContextEntry } from "../../src/workflow/context-ledger";
import { sha256Hex } from "../../src/workflow/optimization-receipt";

describe("read dedupe arm", () => {
	it("keeps the read dedupe arm default-on with the wired quality stop", () => {
		expect(Settings.isolated().get("latency.arms.readDedupe")).toBe(true);
	});

	it("builds an eligible context entry from a successful read result", () => {
		const entry = buildReadToolContextEntry({
			id: "read-1",
			content: "read body",
			readViewKeyParts: {
				canonicalSource: "/repo/file.ts",
				normalizedSelector: "full",
				branchOrWorktreeScope: "repo@main",
				providerViewIdentity: "etag:1",
				contentOrRevisionIdentity: "rev:1",
				outputMode: "raw",
			},
		});

		expect(entry).toMatchObject({
			id: "read-1",
			kind: "tool_result",
			bucket: "tool_results",
			content: "read body",
			immutableSha256: sha256Hex("read body"),
		});
		expect(entry?.readViewKey?.eligible).toBe(true);
		expect(entry?.readViewKey?.parts.canonicalSource).toBe("/repo/file.ts");
	});

	it("does not create a dedupe entry for an unsuccessful read", () => {
		const entry = buildReadToolContextEntry({
			id: "read-error",
			content: "permission denied",
			isError: true,
			readViewKeyParts: {
				canonicalSource: "/repo/file.ts",
				normalizedSelector: "full",
				branchOrWorktreeScope: "repo@main",
				providerViewIdentity: "etag:1",
				contentOrRevisionIdentity: "rev:1",
				outputMode: "raw",
			},
		});

		expect(entry).toBeUndefined();
	});
});
