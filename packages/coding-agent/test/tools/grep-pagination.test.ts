import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { DEFAULT_FILE_LIMIT, GrepTool, MULTI_FILE_PER_FILE_MATCHES } from "../../src/tools/grep";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe("grep file pagination", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-pagination-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("pages files DEFAULT_FILE_LIMIT at a time and caps an overflowing file's matches", async () => {
		const names = Array.from(
			{ length: DEFAULT_FILE_LIMIT + 5 },
			(_, index) => `f${String(index).padStart(2, "0")}.txt`,
		);
		for (const name of names) await Bun.write(path.join(cwd, name), "needle\n");
		await Bun.write(
			path.join(cwd, "hot.txt"),
			Array.from({ length: MULTI_FILE_PER_FILE_MATCHES + 10 }, (_, index) => `needle ${index}`).join("\n"),
		);
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tool = new GrepTool(session);

		const first = await tool.execute("page-1", { pattern: "needle", path: "." });
		expect(first.details?.files).toEqual(names.slice(0, DEFAULT_FILE_LIMIT));
		expect(textOf(first)).toContain(
			`Showing files 1-${DEFAULT_FILE_LIMIT} of ${DEFAULT_FILE_LIMIT + 6}+. Use skip=${DEFAULT_FILE_LIMIT} for the next page`,
		);

		const second = await tool.execute("page-2", { pattern: "needle", path: ".", skip: DEFAULT_FILE_LIMIT });
		expect(second.details?.files).toEqual([...names.slice(DEFAULT_FILE_LIMIT), "hot.txt"]);
		const text = textOf(second);
		// The hot file keeps its first MULTI_FILE_PER_FILE_MATCHES matches (workflow default 8).
		expect(text).toContain(`needle ${MULTI_FILE_PER_FILE_MATCHES - 1}`);
		expect(text).not.toContain(`needle ${MULTI_FILE_PER_FILE_MATCHES}`);
		expect(text).not.toContain("skip=");
	});
});
