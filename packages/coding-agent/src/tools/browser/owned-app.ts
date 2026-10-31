/**
 * Lifetime of `app.path` browsers running on an omp-owned profile
 * (`--user-data-dir` directly under `getBrowserProfilesDir()`).
 *
 * Such a browser belongs to omp, yet no single omp process owns it: the
 * spawner unrefs it, `close` keeps it running for reuse, a later process adopts
 * it as a borrowed CDP endpoint, and Chromium can relaunch itself under a new
 * PID. Left alone it outlives every omp process and piles up.
 *
 * Every omp process that uses one holds a lease file `<profile>.leases/<pid>`
 * (content: the executable path) from before it spawns or adopts the browser
 * until it exits. On exit a process drops its leases and terminates every
 * omp-owned browser in the same profiles root that no live omp process still
 * leases — its own, and those left by omp processes that died without cleanup.
 * A live or recycled PID keeps a lease alive, so the worst case leaves a
 * browser running rather than killing one in use.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { getBrowserProfilesDir, logger, postmortem } from "@oh-my-pi/pi-utils";
import { findUserDataDirInArgs } from "./attach";
import { isPidAlive } from "./orphan-registry";

const LEASES_SUFFIX = ".leases";

/** Profiles this process leases, mapped to the executable running them. */
const leases = new Map<string, string>();
/** Profile roots swept on release; kept after release so later sweeps still cover them. */
const roots = new Set<string>();
let exitHookArmed = false;

function leaseFile(profileDir: string, pid: number): string {
	return path.join(`${profileDir}${LEASES_SUFFIX}`, String(pid));
}

/** The omp-owned profile `args` launch, or null for user-chosen profiles and non-Chromium apps. */
export function ownedProfileDir(args: readonly string[] | undefined): string | null {
	const dir = findUserDataDirInArgs(args);
	if (!dir) return null;
	const resolved = path.resolve(dir);
	return path.dirname(resolved) === path.resolve(getBrowserProfilesDir()) ? resolved : null;
}

/** Lease the browser `exe` runs on `profileDir` for this process; call before spawning or adopting it. */
export async function leaseOwnedApp(exe: string, profileDir: string): Promise<void> {
	await Bun.write(leaseFile(profileDir, process.pid), exe);
	leases.set(profileDir, exe);
	roots.add(path.dirname(profileDir));
	if (exitHookArmed) return;
	exitHookArmed = true;
	postmortem.register("browser-owned-apps", releaseOwnedApps, { exitOnly: true });
}

/**
 * Drop this process's leases, then terminate every leased-profile browser in
 * the known roots that no live omp process leases. Synchronous: it runs from
 * the process `exit` hook, where async work never completes.
 */
export function releaseOwnedApps(): void {
	const known = new Map(leases);
	for (const profileDir of leases.keys()) fs.rmSync(leaseFile(profileDir, process.pid), { force: true });
	leases.clear();
	for (const root of roots) {
		let entries: string[];
		try {
			entries = fs.readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(LEASES_SUFFIX)) continue;
			const profileDir = path.join(root, entry.slice(0, -LEASES_SUFFIX.length));
			try {
				reapIfUnleased(profileDir, known.get(profileDir));
			} catch (error) {
				logger.debug("Failed to reap omp-owned browser", { profileDir, error: String(error) });
			}
		}
	}
}

function reapIfUnleased(profileDir: string, exe: string | undefined): void {
	const dir = `${profileDir}${LEASES_SUFFIX}`;
	for (const name of fs.readdirSync(dir)) {
		const pid = Number(name);
		if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid)) return;
		if (!exe) {
			try {
				exe = fs.readFileSync(path.join(dir, name), "utf8") || undefined;
			} catch {}
		}
	}
	if (exe) terminateProfileBrowser(exe, profileDir);
	fs.rmSync(dir, { recursive: true, force: true });
}

function terminateProfileBrowser(exe: string, profileDir: string): void {
	let executablePath = exe;
	try {
		executablePath = fs.realpathSync(exe);
	} catch {}
	for (const candidate of Process.fromPath(executablePath)) {
		let args: string[];
		try {
			args = candidate.args();
		} catch {
			continue;
		}
		const dir = findUserDataDirInArgs(args);
		if (dir === null || path.resolve(dir) !== profileDir) continue;
		candidate.killTree(os.constants.signals.SIGTERM);
		logger.debug("Terminated omp-owned browser no omp process leases", { pid: candidate.pid, profileDir });
	}
}
