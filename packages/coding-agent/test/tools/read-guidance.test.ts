import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { resetActiveSkillsForTests, setActiveSkills } from "../../src/extensibility/skills";

function createSession(cwd = process.cwd(), getSessionId?: () => string | null): ToolSession {
	return {
		cwd,
		hasUI: false,
		agentKind: "sub",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getSessionId,
	};
}

function textFrom(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function hasAppendedAdvisory(text: string): boolean {
	return /\n\n\[/.test(text);
}

describe("Read SSH guidance", () => {
	it("advertises grep and current SSH fallbacks instead of retired tool names", () => {
		const description = new ReadTool(createSession()).description;

		expect(description).toContain("searchable with `grep`");
		expect(description).toContain("use `bash` with a remote SSH command");
		expect(description).toContain("`sshfs`");
		expect(description).not.toContain("`search`");
		expect(description).not.toContain("`ssh` tool");
	});
});

describe("repeat-read hint", () => {
	let tmpDir: string;

	afterEach(async () => {
		resetActiveSkillsForTests();
		if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("hints on the second identical identity-less read", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "repeat-read-hint-"));
		const skillDir = path.join(tmpDir, "engineering-flow");
		await fs.mkdir(skillDir);
		await fs.writeFile(
			path.join(skillDir, "SKILL.md"),
			"---\nname: engineering-flow\ndescription: test\n---\n\nline one\nline two\nline three\n",
		);
		setActiveSkills([
			{
				name: "engineering-flow",
				description: "test",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);
		const tool = new ReadTool(createSession(tmpDir));
		const args = { path: "skill://engineering-flow:1-2" };
		const first = await tool.execute("read-1", args);
		const second = await tool.execute("read-2", args);
		expect(first.details?.providerViewIdentity).toBeUndefined();
		expect(textFrom(first)).not.toContain("identical output");
		expect(textFrom(second)).toContain("You have received this identical output 2 times");
	});

	it("does not soft-cap the fifth necessary unread range", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-reread-unread-"));
		await fs.writeFile(path.join(tmpDir, "spec.txt"), "line1\nline2\nline3\nline4\nline5\nline6\n");
		const tool = new ReadTool(createSession(tmpDir));
		for (let i = 1; i <= 5; i++) {
			const text = textFrom(await tool.execute(`read-unread-${i}`, { path: `spec.txt:${i}-${i}` }));
			expect(text).toContain(`line${i}`);
			expect(hasAppendedAdvisory(text)).toBe(false);
		}
	});

	it("soft-caps the fifth unchanged same-view read and stays one-shot", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-reread-same-view-"));
		await fs.writeFile(path.join(tmpDir, "spec.txt"), "line1\nline2\nline3\nline4\nline5\nline6\n");
		const tool = new ReadTool(createSession(tmpDir));
		const args = { path: "spec.txt:1-2" };
		for (let i = 1; i <= 6; i++) {
			const text = textFrom(await tool.execute(`read-same-${i}`, args));
			if (i === 5) expect(hasAppendedAdvisory(text)).toBe(true);
			else expect(hasAppendedAdvisory(text)).toBe(false);
		}
	});

	it("resets the soft-cap when the file version changes", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-reread-version-"));
		const filePath = path.join(tmpDir, "spec.txt");
		await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5\nline6\n");
		const tool = new ReadTool(createSession(tmpDir));
		const args = { path: "spec.txt:1-1" };
		for (let i = 1; i <= 4; i++) {
			expect(hasAppendedAdvisory(textFrom(await tool.execute(`read-ver-${i}`, args)))).toBe(false);
		}
		await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5\nline6\nchanged\n");
		expect(hasAppendedAdvisory(textFrom(await tool.execute("read-ver-after-change", args)))).toBe(false);
	});

	it("treats relative and absolute paths as the same canonical source", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-reread-alias-"));
		const filePath = path.join(tmpDir, "spec.txt");
		await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5\nline6\n");
		const tool = new ReadTool(createSession(tmpDir));
		for (let i = 1; i <= 4; i++) {
			expect(hasAppendedAdvisory(textFrom(await tool.execute(`read-rel-${i}`, { path: "spec.txt:1-1" })))).toBe(
				false,
			);
		}
		const aliased = await tool.execute("read-abs-5", { path: `${filePath}:1-1` });
		expect(aliased.details?.canonicalSource).toBe(filePath);
		expect(hasAppendedAdvisory(textFrom(aliased))).toBe(true);
	});

	it("does not treat overlapping ranges that deliver new evidence as identical reads", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-reread-overlap-"));
		await fs.writeFile(path.join(tmpDir, "spec.txt"), "line1\nline2\nline3\nline4\nline5\nline6\n");
		const tool = new ReadTool(createSession(tmpDir));
		const ranges = ["spec.txt:1-3", "spec.txt:2-4", "spec.txt:1-2", "spec.txt:3-5", "spec.txt:2-3"];
		let last = "";
		for (let i = 0; i < ranges.length; i++) {
			last = textFrom(await tool.execute(`read-overlap-${i}`, { path: ranges[i] }));
			expect(hasAppendedAdvisory(last)).toBe(false);
		}
		expect(last).toContain("line3");
	});

	it("does not apply the subagent soft cap to the parent session", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-reread-parent-"));
		await fs.writeFile(path.join(tmpDir, "spec.txt"), "parent verification evidence\n");
		const tool = new ReadTool({ ...createSession(tmpDir), agentKind: "main" });
		for (let i = 1; i <= 6; i++) {
			const text = textFrom(await tool.execute(`read-parent-${i}`, { path: "spec.txt:1" }));
			expect(text).toContain("parent verification evidence");
			expect(hasAppendedAdvisory(text)).toBe(false);
		}
	});

	it("clears read tracking when the logical session id changes on a reused ToolSession", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-reread-scope-"));
		await fs.writeFile(path.join(tmpDir, "spec.txt"), "line1\nline2\nline3\nline4\nline5\nline6\n");
		let sessionId = "session-a";
		const tool = new ReadTool(createSession(tmpDir, () => sessionId));
		const args = { path: "spec.txt:1-1" };
		for (let i = 1; i <= 4; i++) {
			expect(hasAppendedAdvisory(textFrom(await tool.execute(`read-scope-${i}`, args)))).toBe(false);
		}
		sessionId = "session-b";
		expect(hasAppendedAdvisory(textFrom(await tool.execute("read-scope-after-switch", args)))).toBe(false);
	});
});
