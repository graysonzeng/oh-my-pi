import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { normalizeReadSelector } from "../../src/latency/read-view-key";
import { buildReadToolContextEntry } from "../../src/workflow/context-ledger";
import { sha256Hex } from "../../src/workflow/optimization-receipt";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function makeSession(cwd: string, overrides: Record<string, unknown> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings: Settings.isolated(overrides),
	};
}

/** Mirror agent-session.ts #dedupeOrdinaryReadResult selector wiring. */
function readViewKeyFromProductionConsumer(
	result: AgentToolResult<ReadToolDetails>,
	rawPath: string,
	originalText: string,
) {
	const details = result.details ?? {};
	const entry = buildReadToolContextEntry({
		id: "read-identity-test",
		content: originalText,
		readViewKeyParts: {
			canonicalSource: details.canonicalSource ?? details.resolvedPath ?? details.finalUrl ?? rawPath,
			normalizedSelector: normalizeReadSelector({}),
			branchOrWorktreeScope: details.branchOrWorktreeScope ?? "",
			providerViewIdentity: details.providerViewIdentity ?? "",
			contentOrRevisionIdentity: details.contentOrRevisionIdentity ?? "",
			outputMode:
				details.outputMode === "raw" ||
				details.outputMode === "converted" ||
				details.outputMode === "decoded" ||
				details.outputMode === "summary"
					? details.outputMode
					: details.contentType === "text/markdown"
						? "converted"
						: "raw",
		},
	});
	return entry?.readViewKey;
}

describe("read identity production", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-identity-production-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("F7: eligible ReadViewKey via real consumer selector=rawPath wiring", async () => {
		const filePath = path.join(tmpDir, "notes.txt");
		await fs.writeFile(filePath, "hello\nworld\n");

		const result = await new ReadTool(makeSession(tmpDir)).execute("read-identity", { path: filePath });
		const details = result.details;
		const output = textOutput(result);

		expect(details?.resolvedPath).toBe(filePath);
		expect(details?.branchOrWorktreeScope).toBe(`worktree:${tmpDir}`);
		expect(details?.providerViewIdentity).toMatch(/^fs:\d+(?:\.\d+)?:\d+$/);
		expect(details?.contentOrRevisionIdentity).toBe(sha256Hex(output));
		expect(details?.outputMode).toBe("raw");

		const readViewKey = readViewKeyFromProductionConsumer(result, filePath, output);
		expect(readViewKey?.eligible).toBe(true);
		expect(readViewKey?.failOpenReasons).toEqual([]);
		expect(readViewKey?.parts.normalizedSelector).toBe("full");
	});

	it("F7: git worktree stamps git: scope for ReadViewKey eligibility", async () => {
		execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "ignore" });
		const filePath = path.join(tmpDir, "tracked.txt");
		await fs.writeFile(filePath, "tracked content\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir, stdio: "ignore" });

		const result = await new ReadTool(makeSession(tmpDir)).execute("read-git", { path: filePath });
		const output = textOutput(result);
		expect(result.details?.branchOrWorktreeScope).toMatch(/^git:/);

		const readViewKey = readViewKeyFromProductionConsumer(result, filePath, output);
		expect(readViewKey?.eligible).toBe(true);
		expect(readViewKey?.parts.branchOrWorktreeScope.startsWith("git:")).toBe(true);
	});

	it("F4: URL read path stamps identity and yields eligible ReadViewKey", async () => {
		const body = "url identity body\nline2\n";
		vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => ({
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "text/plain",
			content: body,
		}));

		const url = "https://example.test/identity.txt";
		const result = await new ReadTool(makeSession(tmpDir, { "fetch.enabled": true })).execute("read-url", {
			path: url,
		});
		const details = result.details;
		const output = textOutput(result);

		expect(details?.finalUrl).toBe(url);
		expect(details?.canonicalSource).toBe(url);
		expect(details?.providerViewIdentity).toMatch(/^url-content:[0-9a-f]{64}$/);
		expect(details?.contentOrRevisionIdentity).toBe(sha256Hex(output));
		expect(details?.branchOrWorktreeScope).toBe(`worktree:${tmpDir}`);

		const readViewKey = readViewKeyFromProductionConsumer(result, url, output);
		expect(readViewKey?.eligible).toBe(true);
		expect(readViewKey?.failOpenReasons).toEqual([]);
	});
});
