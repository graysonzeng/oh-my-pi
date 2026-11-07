import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	formatWorkspaceContentVersion,
	isLegacyOpaqueWorkspaceVersion,
	resolveCurrentWorkspaceCodeVersion,
	resolveParentFinalCodeStateRef,
} from "../../src/task/workspace-code-version";

describe("workspace content identity (R1)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-code-ver-"));
		await $`git init`.cwd(dir).quiet();
		await $`git config user.email test@example.com`.cwd(dir).quiet();
		await $`git config user.name test`.cwd(dir).quiet();
		await Bun.write(path.join(dir, "a.txt"), "one\n");
		await $`git add a.txt`.cwd(dir).quiet();
		await $`git commit -m init`.cwd(dir).quiet();
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("uses content: prefix rather than HEAD:dirty", async () => {
		const version = await resolveCurrentWorkspaceCodeVersion(dir);
		expect(version.startsWith("content:")).toBe(true);
		expect(version.includes(":dirty")).toBe(false);
		expect(isLegacyOpaqueWorkspaceVersion(version)).toBe(false);
		expect(isLegacyOpaqueWorkspaceVersion("abc123:dirty")).toBe(true);
	});

	it("changes identity when dirty content changes under the same HEAD", async () => {
		const before = await resolveCurrentWorkspaceCodeVersion(dir);
		await Bun.write(path.join(dir, "a.txt"), "two\n");
		const afterA = await resolveCurrentWorkspaceCodeVersion(dir);
		await Bun.write(path.join(dir, "a.txt"), "three\n");
		const afterB = await resolveCurrentWorkspaceCodeVersion(dir);
		expect(afterA).not.toBe(before);
		expect(afterB).not.toBe(afterA);
		expect(afterA.startsWith("content:")).toBe(true);
		expect(afterB.startsWith("content:")).toBe(true);
	});

	it("parent-final ref carries content fingerprint and headId", async () => {
		const ref = await resolveParentFinalCodeStateRef(dir);
		expect(ref?.fingerprint.startsWith("content:")).toBe(true);
		expect(ref?.headId?.length).toBeGreaterThan(0);
		expect(formatWorkspaceContentVersion("abc")).toBe("content:abc");
	});
});
