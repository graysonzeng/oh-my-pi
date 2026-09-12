import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { resetActiveSkillsForTests, setActiveSkills } from "../../src/extensibility/skills";

function createSession(cwd = process.cwd()): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function textFrom(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
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
});
