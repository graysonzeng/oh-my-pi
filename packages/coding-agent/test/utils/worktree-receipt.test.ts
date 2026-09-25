import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { worktreeReceiptSync } from "../../src/utils/worktree-receipt";

const repos: string[] = [];

async function createRepo(options?: { commit?: boolean }): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-receipt-"));
	repos.push(repo);
	await $`git init --initial-branch=main`.cwd(repo).quiet();
	await $`git config user.name "Test User"`.cwd(repo).quiet();
	await $`git config user.email "test@example.com"`.cwd(repo).quiet();
	if (options?.commit === false) return repo;
	await Bun.write(path.join(repo, "tracked.txt"), "base\n");
	await $`git add tracked.txt`.cwd(repo).quiet();
	await $`git commit -m baseline`.cwd(repo).quiet();
	return repo;
}

afterEach(async () => {
	await Promise.all(repos.splice(0).map(repo => fs.rm(repo, { recursive: true, force: true })));
});

describe("worktreeReceiptSync", () => {
	test("returns null outside a git checkout and for an unborn HEAD", async () => {
		const missing = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-receipt-none-"));
		repos.push(missing);
		expect(worktreeReceiptSync(missing)).toBeNull();
		expect(worktreeReceiptSync(await createRepo({ commit: false }))).toBeNull();
	});

	test("stable digest on a quiet tree; HEAD, staged, unstaged, and untracked each change it", async () => {
		const repo = await createRepo();
		const clean = worktreeReceiptSync(repo);
		expect(clean?.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(worktreeReceiptSync(repo)?.digest).toBe(clean?.digest);

		await Bun.write(path.join(repo, "tracked.txt"), "unstaged\n");
		const unstaged = worktreeReceiptSync(repo)?.digest;
		expect(unstaged).not.toBe(clean?.digest);

		await $`git add tracked.txt`.cwd(repo).quiet();
		const staged = worktreeReceiptSync(repo)?.digest;
		expect(staged).not.toBe(unstaged);

		await $`git commit -m next`.cwd(repo).quiet();
		const committed = worktreeReceiptSync(repo)?.digest;
		expect(committed).not.toBe(staged);

		await Bun.write(path.join(repo, "extra.txt"), "untracked\n");
		expect(worktreeReceiptSync(repo)?.digest).not.toBe(committed);
	});

	test("returns null rather than hashing a diff truncated by the native output cap", async () => {
		const repo = await createRepo();
		await Bun.write(path.join(repo, "tracked.txt"), "x".repeat(9 * 1024 * 1024));
		expect(worktreeReceiptSync(repo)).toBeNull();
	});

	test("hashes untracked file bytes and ignores exclude-standard paths", async () => {
		const repo = await createRepo();
		await Bun.write(path.join(repo, ".gitignore"), "secret.bin\n");
		await $`git add .gitignore`.cwd(repo).quiet();
		await $`git commit -m ignore`.cwd(repo).quiet();
		const ignoredBase = worktreeReceiptSync(repo)?.digest;
		expect(ignoredBase).toMatch(/^[0-9a-f]{64}$/);

		await Bun.write(path.join(repo, "secret.bin"), "secret\n");
		expect(worktreeReceiptSync(repo)?.digest).toBe(ignoredBase);

		await Bun.write(path.join(repo, "blob.bin"), Buffer.from([0, 1, 255, 10]));
		const withBlob = worktreeReceiptSync(repo)?.digest;
		expect(withBlob).not.toBe(ignoredBase);
		await Bun.write(path.join(repo, "blob.bin"), Buffer.from([0, 1, 254, 10]));
		expect(worktreeReceiptSync(repo)?.digest).not.toBe(withBlob);
	});
});
