import { expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

it("suggests a working line selector when an xd topic is read repeatedly", async () => {
	const evalTool = { docTopics: () => ({ browser: "line 1\nline 2\nline 3" }) } as unknown as Tool;
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getToolByName: name => (name === "eval" ? evalTool : undefined),
	};
	const tool = new ReadTool(session);
	await tool.execute("first", { path: "xd://eval/browser" });
	await tool.execute("second", { path: "xd://eval/browser" });
	const result = await tool.execute("third", { path: "xd://eval/browser" });
	const text = result.content.map(entry => (entry.type === "text" ? entry.text : "")).join("\n");
	expect(text).toContain("identical output 3 times");
	expect(text).toContain("path:A-B");
	const selected = await tool.execute("selected", { path: "xd://eval/browser:2-2:raw" });
	expect(selected.content.map(entry => (entry.type === "text" ? entry.text : "")).join("\n")).toBe("line 2");
});
