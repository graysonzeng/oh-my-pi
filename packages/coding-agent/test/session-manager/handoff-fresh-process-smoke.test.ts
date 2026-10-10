/**
 * Fresh-process handoff smoke: a child process (no AgentRegistry populated)
 * opens a forked session file and resolves its lineage through the session
 * manager alone — the canonical-store ancestor is optional read-only evidence,
 * never registry-dependent.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

function writeSessionHeader(file: string, parentSession: string | undefined): void {
	const header = {
		type: "session",
		version: 3,
		id: `id-${path.basename(file)}`,
		timestamp: new Date().toISOString(),
		cwd: path.dirname(file),
		parentSession,
	};
	fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
}

describe("fresh-process handoff lineage smoke", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-handoff-smoke-");
	});

	afterEach(() => {
		tempDir.remove().catch(() => {});
	});

	it("resolves the canonical ancestor from a fresh process with no registry state", async () => {
		const grandparent = path.join(tempDir.path(), "grandparent.jsonl");
		const parent = path.join(tempDir.path(), "parent.jsonl");
		const child = path.join(tempDir.path(), "child.jsonl");
		writeSessionHeader(grandparent, undefined);
		writeSessionHeader(parent, grandparent);
		writeSessionHeader(child, parent);

		// The probe runs in a child `bun` process that never registers anything
		// in AgentRegistry: lineage must come from the persisted canonical path
		// chain read off disk, exactly as a fresh handoff process would.
		const probe = path.join(tempDir.path(), "lineage-probe.ts");
		const probeCode = `
import { SessionManager } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/session/session-manager.ts"))};
const manager = await SessionManager.open(${JSON.stringify(child)});
const context = await manager.getLineageContext();
console.log(JSON.stringify({ current: context.currentSessionFile, roots: context.lineageRoots.map(r => r.canonicalPath) }));
`;
		fs.writeFileSync(probe, probeCode);

		const proc = Bun.spawn([process.execPath, probe], {
			cwd: path.dirname(probe),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const parsed = JSON.parse(stdout) as { current: string; roots: string[] };
		expect(parsed.current).toBe(child);
		expect(parsed.roots).toEqual([parent, grandparent]);
	});
});
