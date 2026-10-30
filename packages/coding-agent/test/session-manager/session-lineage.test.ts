/**
 * Session-scoped lineage: canonical parent writes, read-only ancestor walk,
 * cycle/missing/unsafe degradation, and two-session isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { normalizeParentSessionRef } from "@oh-my-pi/pi-coding-agent/session/session-lineage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

describe("normalizeParentSessionRef", () => {
	it("treats path-form values as canonical session files after root validation", () => {
		const sessionDir = "/tmp/omp-sessions/project-a";
		const ref = normalizeParentSessionRef("/tmp/omp-sessions/project-a/old.jsonl", sessionDir, "/repo");
		expect(ref).toEqual({ ref: { kind: "session-file", canonicalPath: "/tmp/omp-sessions/project-a/old.jsonl" } });
	});

	it("treats opaque values as legacy session IDs", () => {
		const ref = normalizeParentSessionRef("019fc40c-9abb-7003-95d2-c7bbfbe7c502", "/tmp/s", "/repo");
		expect(ref).toEqual({ ref: { kind: "legacy-session-id", id: "019fc40c-9abb-7003-95d2-c7bbfbe7c502" } });
	});

	it("rejects paths outside the managed root as unsafe", () => {
		const ref = normalizeParentSessionRef("/etc/passwd.jsonl", "/tmp/omp-sessions/project-a", "/repo");
		expect(ref).toEqual({ diagnostic: { kind: "unsafe-root", path: "/etc/passwd.jsonl" } });
	});
});

describe("SessionManager.getLineageContext", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-session-lineage-");
	});

	afterEach(() => {
		tempDir.remove().catch(() => {});
		InternalUrlRouter.resetForTests();
	});

	it("walks the persisted parent chain read-only and orders roots nearest-first", async () => {
		const grandparent = path.join(tempDir.path(), "grandparent.jsonl");
		const parent = path.join(tempDir.path(), "parent.jsonl");
		const child = path.join(tempDir.path(), "child.jsonl");
		writeSessionHeader(grandparent, undefined);
		writeSessionHeader(parent, grandparent);
		writeSessionHeader(child, parent);

		const manager = await SessionManager.open(child, tempDir.path());

		const context = await manager.getLineageContext();
		expect(context.currentSessionFile).toBe(child);
		expect(context.lineageRoots).toEqual([
			{ canonicalPath: parent, depth: 0 },
			{ canonicalPath: grandparent, depth: 1 },
		]);
	});

	it("stops at a missing parent without throwing", async () => {
		const child = path.join(tempDir.path(), "child.jsonl");
		const missingParent = path.join(tempDir.path(), "missing.jsonl");
		writeSessionHeader(child, missingParent);

		const manager = await SessionManager.open(child, tempDir.path());

		const context = await manager.getLineageContext();
		expect(context.currentSessionFile).toBe(child);
		// The missing parent is still a lineage root (its artifacts dir may
		// survive even when the session file is gone); the walk stops there.
		expect(context.lineageRoots).toEqual([{ canonicalPath: missingParent, depth: 0 }]);
	});

	it("stops at a cycle (self-referential parent)", async () => {
		const self = path.join(tempDir.path(), "self.jsonl");
		writeSessionHeader(self, self);

		const manager = await SessionManager.open(self, tempDir.path());

		const context = await manager.getLineageContext();
		expect(context.lineageRoots).toEqual([]);
	});

	it("degrades to an empty context for in-memory sessions without a file", async () => {
		const manager = SessionManager.inMemory(tempDir.path());
		expect(await manager.getLineageContext()).toEqual({ currentSessionFile: null, lineageRoots: [] });
	});

	it("keeps two sessions' lineage isolated (no cross-prioritization)", async () => {
		const aRoot = path.join(tempDir.path(), "a-root.jsonl");
		const aParent = path.join(tempDir.path(), "a-parent.jsonl");
		const aChild = path.join(tempDir.path(), "a-child.jsonl");
		const bRoot = path.join(tempDir.path(), "b-root.jsonl");
		const bChild = path.join(tempDir.path(), "b-child.jsonl");
		writeSessionHeader(aRoot, undefined);
		writeSessionHeader(aParent, aRoot);
		writeSessionHeader(aChild, aParent);
		writeSessionHeader(bRoot, undefined);
		writeSessionHeader(bChild, bRoot);

		const a = await SessionManager.open(aChild, tempDir.path());
		const b = await SessionManager.open(bChild, tempDir.path());

		const aContext = await a.getLineageContext();
		const bContext = await b.getLineageContext();
		expect(aContext.lineageRoots.map(root => root.canonicalPath)).toEqual([aParent, aRoot]);
		expect(bContext.lineageRoots.map(root => root.canonicalPath)).toEqual([bRoot]);
		expect(aContext.lineageRoots.some(root => root.canonicalPath === bRoot)).toBe(false);
	});
});
