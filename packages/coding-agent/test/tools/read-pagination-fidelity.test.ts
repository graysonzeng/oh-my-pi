/**
 * History S3 — pagination / continue-read contract fidelity.
 *
 * Failure modes: offset kwargs silently ignored (page 1 again); stale offset
 * with existing selector returns first page; global “don’t re-read” prompts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { composeReadPaginationArgs } from "@oh-my-pi/pi-coding-agent/tools/read-selector";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		allocateOutputArtifact: async (toolType: string) => ({
			id: "a1",
			path: path.join(cwd, "session", `a1.${toolType}.log`),
		}),
		settings: Settings.isolated(),
	};
}

describe("composeReadPaginationArgs", () => {
	it("composes offset onto bare :raw so continue-next-page works", () => {
		expect(composeReadPaginationArgs({ path: "artifact://0:raw", offset: 301 })).toEqual({
			path: "artifact://0:raw:301-",
		});
		expect(composeReadPaginationArgs({ path: "artifact://0", offset: 301, limit: 300 })).toEqual({
			path: "artifact://0:raw:301+300",
		});
	});

	it("rejects stale offset kwargs when a range selector is already present", () => {
		expect(() =>
			composeReadPaginationArgs({ path: "artifact://0:raw:1-300", offset: 301, limit: 300 }),
		).toThrow(ToolError);
		try {
			composeReadPaginationArgs({ path: "artifact://0:raw:1-300", offset: 301 });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ToolError);
			expect(String(error)).toContain("Stale pagination kwargs");
			expect(String(error)).toContain("next-page locator");
			expect(String(error)).toContain("offset=301");
		}
	});
});

describe("read tool pagination fidelity (S3)", () => {
	let testDir: string;
	let artifactDir: string;
	let unregisterArtifactsDir: (() => void) | undefined;
	let tool: ReadTool;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-pagination-"));
		artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		const body = Array.from({ length: 400 }, (_, i) => `line-${String(i + 1).padStart(3, "0")}`).join("\n");
		await Bun.write(path.join(artifactDir, "0.mcp.log"), body);
		resetRegisteredArtifactDirsForTests();
		unregisterArtifactsDir = registerArtifactsDir(artifactDir);
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(async () => {
		unregisterArtifactsDir?.();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("continue-next-page via offset kwargs returns page starting at 301, not page 1", async () => {
		const first = await tool.execute("p1", { path: "artifact://0:raw:1-300" });
		const firstText = getTextOutput(first);
		expect(firstText).toContain("line-001");
		expect(firstText).toContain("line-300");
		expect(firstText).not.toContain("line-301");

		const second = await tool.execute("p2", { path: "artifact://0:raw", offset: 301, limit: 100 });
		const secondText = getTextOutput(second);
		expect(secondText).toContain("line-301");
		expect(secondText).not.toContain("line-001");
	});

	it("continue-next-page via declared locator artifact://0:raw:301- works", async () => {
		const result = await tool.execute("p3", { path: "artifact://0:raw:301-" });
		const text = getTextOutput(result);
		expect(text).toContain("line-301");
		expect(text).toContain("line-400");
		expect(text).not.toContain("line-001");
	});

	it("stale offset with existing selector fails closed with explicit feedback", async () => {
		await expect(tool.execute("stale", { path: "artifact://0:raw:1-300", offset: 301 })).rejects.toThrow(
			/Stale pagination kwargs/,
		);
	});
});
