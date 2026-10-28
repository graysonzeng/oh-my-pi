import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { leaseOwnedApp, releaseOwnedApps } from "@oh-my-pi/pi-coding-agent/tools/browser/owned-app";
import type { Subprocess } from "bun";

const children: Subprocess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function profilesRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-owned-app-"));
	tempDirs.push(root);
	return root;
}

/** A stand-in browser: a process of a known executable carrying `--user-data-dir=<profile>`. */
async function spawnBrowser(profileDir: string): Promise<Subprocess<"ignore", "pipe", "ignore">> {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			'process.stdout.write("ready\\n"); await Bun.sleep(60_000)',
			`--user-data-dir=${profileDir}`,
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	children.push(child);
	const reader = child.stdout.getReader();
	await reader.read();
	reader.releaseLock();
	return child;
}

async function exitsWithin(child: Subprocess, ms: number): Promise<boolean> {
	return await Promise.race([child.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

async function deadPid(): Promise<number> {
	const child = Bun.spawn([process.execPath, "--eval", ""], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
	return child.pid;
}

describe("omp-owned app browsers", () => {
	it("terminates the browser once this process drops the last lease", async () => {
		const profile = path.join(await profilesRoot(), "google-chrome-a");
		const browser = await spawnBrowser(profile);
		await leaseOwnedApp(process.execPath, profile);

		releaseOwnedApps();

		expect(await exitsWithin(browser, 5_000)).toBe(true);
		expect(await Bun.file(path.join(`${profile}.leases`, String(process.pid))).exists()).toBe(false);
	});

	it("keeps the browser while another live omp process still leases it", async () => {
		const profile = path.join(await profilesRoot(), "google-chrome-b");
		const browser = await spawnBrowser(profile);
		const otherOmp = await spawnBrowser(path.join(os.tmpdir(), "unrelated-profile"));
		await Bun.write(path.join(`${profile}.leases`, String(otherOmp.pid)), process.execPath);
		await leaseOwnedApp(process.execPath, profile);

		releaseOwnedApps();

		expect(await exitsWithin(browser, 500)).toBe(false);
	});

	it("reaps a browser left behind by an omp process that died without cleanup", async () => {
		const root = await profilesRoot();
		const orphanProfile = path.join(root, "google-chrome-orphan");
		const orphan = await spawnBrowser(orphanProfile);
		await Bun.write(path.join(`${orphanProfile}.leases`, String(await deadPid())), process.execPath);
		await leaseOwnedApp(process.execPath, path.join(root, "google-chrome-mine"));

		releaseOwnedApps();

		expect(await exitsWithin(orphan, 5_000)).toBe(true);
		expect(await fs.readdir(root)).not.toContain("google-chrome-orphan.leases");
	});
});
