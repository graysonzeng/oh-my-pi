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
		// The walk saw every file; only hot.txt's own cap bit, so the total is exact.
		// Keep workflow DEFAULT_FILE_LIMIT/MULTI_FILE_PER_FILE_MATCHES (=8); adopt main's
		// exact-total + named per-file cap notice (no spurious "+" from per-file caps).
		expect(textOf(first)).toContain(
			`Showing files 1-${DEFAULT_FILE_LIMIT} of ${DEFAULT_FILE_LIMIT + 6}. Use skip=${DEFAULT_FILE_LIMIT} for the next page`,
		);
		expect(textOf(first)).not.toContain("More than");

		const second = await tool.execute("page-2", { pattern: "needle", path: ".", skip: DEFAULT_FILE_LIMIT });
		expect(second.details?.files).toEqual([...names.slice(DEFAULT_FILE_LIMIT), "hot.txt"]);
		const text = textOf(second);
		// The hot file keeps its first MULTI_FILE_PER_FILE_MATCHES matches (workflow default 8).
		expect(text).toContain(`needle ${MULTI_FILE_PER_FILE_MATCHES - 1}`);
		expect(text).not.toContain(`needle ${MULTI_FILE_PER_FILE_MATCHES}`);
		expect(text).toContain(
			`More than ${MULTI_FILE_PER_FILE_MATCHES} matches in hot.txt; grep keeps the first ${MULTI_FILE_PER_FILE_MATCHES} per file`,
		);
		expect(text).toContain("Search one file alone for up to 200.");
		expect(text).not.toContain("skip=");

		const alone = textOf(await tool.execute("hot-alone", { pattern: "needle", path: "hot.txt" }));
		expect(alone).toContain(`needle ${MULTI_FILE_PER_FILE_MATCHES + 9}`);
		expect(alone).not.toContain("More than");
	});

	function newTool(options?: ConstructorParameters<typeof GrepTool>[1]): GrepTool {
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		return new GrepTool(session, options);
	}

	it("tells the model when the single-file cap trims a file", async () => {
		await Bun.write(
			path.join(cwd, "big.txt"),
			Array.from({ length: 250 }, (_, index) => `needle ${index}`).join("\n"),
		);
		const tool = newTool();

		const text = textOf(await tool.execute("single", { pattern: "needle", path: "big.txt" }));
		expect(text).toContain("needle 199");
		expect(text).not.toContain("needle 200");
		expect(text).toContain("More than 200 matches; grep keeps the first 200 in a file.");
		expect(text).toContain("Add a line range (`path:N-M`)");

		const ranged = textOf(await tool.execute("single-range", { pattern: "needle", path: "big.txt:201-250" }));
		expect(ranged).toContain("needle 249");
		expect(ranged).not.toContain("More than");
	});

	it("keeps the cap notice when the byte cap cuts the matches", async () => {
		const filler = "x".repeat(500);
		await Bun.write(
			path.join(cwd, "wide.txt"),
			Array.from({ length: 250 }, (_, index) => `needle ${index} ${filler}`).join("\n"),
		);
		const tool = newTool({ context: 0 });

		const result = await tool.execute("wide", { pattern: "needle", path: "wide.txt" });
		const text = textOf(result);
		expect(result.details?.truncation?.truncated).toBe(true);
		expect(text).not.toContain("needle 199 ");
		expect(text).toContain("More than 200 matches; grep keeps the first 200 in a file.");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
	});

	it("keeps the page line and names every fully-rendered capped file on the page", async () => {
		// With workflow DEFAULT_FILE_LIMIT×MULTI_FILE_PER_FILE_MATCHES (=8×8) and the 512-byte
		// column cap, a single page cannot reach DEFAULT_MAX_BYTES (50KB), so the multi-file
		// byte-cap interaction main covered at 20×20 is unreachable here. Trailer survival
		// past the byte cap is covered by the single-file test above; this case keeps the
		// pagination line + named per-file cap notice contract under workflow caps.
		const totalFiles = DEFAULT_FILE_LIMIT + 5;
		const names = Array.from({ length: totalFiles }, (_, index) => `f${String(index).padStart(2, "0")}`);
		for (const name of names) {
			await Bun.write(
				path.join(cwd, `${name}.txt`),
				Array.from({ length: MULTI_FILE_PER_FILE_MATCHES + 1 }, (_, index) => `needle ${name} ${index}`).join("\n"),
			);
		}
		const result = await newTool({ context: 0 }).execute("wide-many", { pattern: "needle", path: "." });
		const text = textOf(result);
		expect(text).toContain(
			`Showing files 1-${DEFAULT_FILE_LIMIT} of ${totalFiles}. Use skip=${DEFAULT_FILE_LIMIT} for the next page`,
		);
		// formatCappedFiles lists the first 5 then "and N more files".
		expect(text).toContain(
			`More than ${MULTI_FILE_PER_FILE_MATCHES} matches in f00.txt, f01.txt, f02.txt, f03.txt, f04.txt and ${DEFAULT_FILE_LIMIT - 5} more files;`,
		);
	});

	it("names only capped files the result renders in full", async () => {
		for (const name of ["a.txt", "b.txt"]) {
			await Bun.write(path.join(cwd, name), Array.from({ length: 30 }, (_, index) => `needle ${index}`).join("\n"));
		}
		// A caller's total limit (the Cursor `pi_grep` bridge) leaves the capped files short.
		const limited = textOf(
			await newTool({ totalMatchLimit: 1 }).execute("limited", { pattern: "needle", path: "." }),
		);
		expect(limited).not.toContain("More than");

		const both = textOf(await newTool().execute("both", { pattern: "needle", path: "." }));
		expect(both).toContain(`More than ${MULTI_FILE_PER_FILE_MATCHES} matches in a.txt, b.txt;`);
	});

	it("counts capped files past the fifth", async () => {
		for (let index = 0; index < 6; index++) {
			await Bun.write(path.join(cwd, `h${index}.txt`), Array.from({ length: 21 }, () => "needle").join("\n"));
		}
		const text = textOf(await newTool().execute("six", { pattern: "needle", path: "." }));
		expect(text).toContain(
			`More than ${MULTI_FILE_PER_FILE_MATCHES} matches in h0.txt, h1.txt, h2.txt, h3.txt, h4.txt and 1 more file;`,
		);
	});
});
