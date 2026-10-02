/**
 * W7: >8MiB in-memory artifacts must still support line-range recover via a
 * spilled file backend (locate returns a path; raw:1-2 must not OOM-reject).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import {
	ArtifactProtocolHandler,
	MAX_INLINE_ARTIFACT_BYTES,
	resetSpilledSessionArtifactsForTests,
} from "../../src/internal-urls/artifact-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import type { ToolSession } from "../../src/tools";
import { ReadTool } from "../../src/tools/read";

afterEach(() => {
	resetSpilledSessionArtifactsForTests();
});

function largeBody(): string {
	const line = `line-content-${"x".repeat(200)}`;
	const lines = Math.ceil((MAX_INLINE_ARTIFACT_BYTES + 64_000) / (line.length + 1));
	return Array.from({ length: lines }, (_, i) => `${line}-${i}`).join("\n");
}

describe("W7 in-memory large artifact range recover", () => {
	it("locates spilled file for oversized in-memory artifact and range-reads first lines", async () => {
		const body = largeBody();
		expect(Buffer.byteLength(body, "utf-8")).toBeGreaterThan(MAX_INLINE_ARTIFACT_BYTES);

		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => "w7-large-mem",
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getArtifactContent: async (id: string) => (id === "0" ? body : null),
		};

		const handler = new ArtifactProtocolHandler();
		const located = await handler.locate(parseInternalUrl("artifact://0"), {
			session,
			sessionId: "w7-large-mem",
		});
		expect(located).toBeTruthy();
		expect(located).toMatch(/\.spill\.txt$/);

		const tool = new ReadTool(session);
		const result = await tool.execute("call-range", { path: "artifact://0:raw:1-2" });
		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain("line-content-");
		expect(text).not.toMatch(/full internal resolution is blocked/i);
	});
});
