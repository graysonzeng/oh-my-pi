import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSubagentReportCli, runSubagentReport } from "./subagent-report";

const SECRET = "LEAK_TOKEN_cli_9f3a";
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-report-cli-"));
afterAll(() => fs.rm(tmpDir, { recursive: true, force: true }));

function jsonl(lines: unknown[]): string {
	return `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
}

describe("subagent-report CLI", () => {
	it("rejects illegal --format so a typo cannot silently fall back to human", () => {
		expect(() => parseSubagentReportCli(["--format", "xml"])).toThrow(/invalid --format/);
	});

	it("drops whole parent+child groups older than --since by max file mtime, not in-file events", async () => {
		const root = path.join(tmpDir, "sessions");
		const folder = path.join(root, "proj");
		await fs.mkdir(folder, { recursive: true });
		const fresh = path.join(folder, "fresh.jsonl");
		const stale = path.join(folder, "stale.jsonl");
		await Bun.write(
			fresh,
			jsonl([
				{ type: "session", version: 3, id: "fresh", timestamp: "2026-09-09T10:00:00.000Z", cwd: "/tmp" },
				{
					type: "message",
					id: "a1",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "fresh" }],
						timestamp: Date.now(),
						model: "fresh-model",
						ttft: 11,
						duration: 21,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					},
				},
			]),
		);
		await Bun.write(
			stale,
			jsonl([
				{ type: "session", version: 3, id: "stale", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
				{
					type: "message",
					id: "a2",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "stale" }],
						timestamp: 1,
						model: "stale-model",
						ttft: 99,
						duration: 199,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					},
				},
			]),
		);
		const old = new Date(Date.now() - 3 * 24 * 3600_000);
		await fs.utimes(stale, old, old);

		const report = await runSubagentReport({
			sinceMs: 3600_000,
			sessionsRoot: root,
			format: "json",
		});
		expect(report.models["fresh-model"]).toBe(1);
		expect(report.models["stale-model"]).toBeUndefined();
		expect(report.sessions.parentCount).toBe(1);
	});

	it("keeps secret task/user text out of --format json so local sampling cannot leak bodies", async () => {
		const root = path.join(tmpDir, "secret-sessions", "sessions");
		const folder = path.join(root, "demo");
		await fs.mkdir(folder, { recursive: true });
		const file = path.join(folder, "sess.jsonl");
		await Bun.write(
			file,
			jsonl([
				{ type: "session", version: 3, id: "sess", timestamp: "2026-09-09T10:00:00.000Z", cwd: "/tmp" },
				{
					type: "session_init",
					id: "init",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					systemPrompt: SECRET,
					task: SECRET,
					tools: ["read"],
				},
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-09-09T10:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: SECRET }], timestamp: 1000 },
				},
			]),
		);
		const opts = parseSubagentReportCli(["--sessions", root, "--since", "1d", "--format", "json"]);
		expect(opts.format).toBe("json");
		const report = await runSubagentReport(opts);
		expect(JSON.stringify(report)).not.toContain(SECRET);
	});
});
