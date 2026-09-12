import { createHash, type Hash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent } from "@oh-my-pi/pi-utils";

/**
 * SHA-256 receipt for HEAD plus all staged, unstaged, and untracked worktree
 * inputs. `null` means the snapshot could not be read consistently.
 */
export interface GitWorktreeReceipt {
	digest: string;
}

const NO_OPTIONAL_LOCKS = "--no-optional-locks";
const SHORT_LIVED_GIT_CONFIG: readonly (readonly [key: string, value: string])[] = [
	["core.fsmonitor", "false"],
	["core.untrackedCache", "false"],
];
const GIT_SPAWN_ENOENT_EXIT_CODE = 127;
const WORKTREE_RECEIPT_FILE_CHUNK_BYTES = 64 * 1024;
const WORKTREE_RECEIPT_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
type Sha256Hasher = Hash;

function buildGitEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_DIR: undefined,
		GIT_COMMON_DIR: undefined,
		GIT_WORK_TREE: undefined,
		GIT_INDEX_FILE: undefined,
		GIT_OBJECT_DIRECTORY: undefined,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
		GIT_ASKPASS: "true",
		GIT_EDITOR: "true",
		GIT_TERMINAL_PROMPT: "0",
		LC_MESSAGES: "C",
	};
}

function withShortLivedGitConfig(args: readonly string[]): string[] {
	const prefix: string[] = [];
	for (const [key, value] of SHORT_LIVED_GIT_CONFIG) {
		prefix.push("-c", `${key}=${value}`);
	}
	return [...prefix, ...args];
}

function gitSpawnSyncBytes(cwd: string, args: readonly string[]): { exitCode: number; stdout: Uint8Array } {
	const commandArgs = withShortLivedGitConfig(
		args.includes(NO_OPTIONAL_LOCKS) ? [...args] : [NO_OPTIONAL_LOCKS, ...args],
	);
	try {
		const result = Bun.spawnSync(["git", ...commandArgs], {
			cwd,
			env: buildGitEnv(),
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		return { exitCode: result.exitCode ?? 0, stdout: new Uint8Array(result.stdout) };
	} catch (err) {
		if (isEnoent(err)) return { exitCode: GIT_SPAWN_ENOENT_EXIT_CODE, stdout: new Uint8Array() };
		throw err;
	}
}

function updateReceiptPart(hasher: Sha256Hasher, name: string, value: Uint8Array | string): void {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	hasher.update(`${name}:${bytes.byteLength}:`);
	hasher.update(bytes);
	hasher.update("\n");
}

function listUntrackedPaths(output: Uint8Array): Uint8Array[] | null {
	const paths: Uint8Array[] = [];
	let offset = 0;
	while (offset < output.byteLength) {
		const terminator = output.indexOf(0, offset);
		if (terminator === -1 || terminator === offset) return null;
		paths.push(output.slice(offset, terminator));
		offset = terminator + 1;
	}
	return paths.sort((left, right) => Buffer.compare(left, right));
}

function updateFileReceipt(hasher: Sha256Hasher, repoRoot: string, relativePath: Uint8Array): boolean {
	let decodedPath: string;
	try {
		decodedPath = WORKTREE_RECEIPT_TEXT_DECODER.decode(relativePath);
	} catch {
		return false;
	}
	const filePath = path.resolve(repoRoot, decodedPath);
	if (
		path.relative(repoRoot, filePath).startsWith(`..${path.sep}`) ||
		path.isAbsolute(path.relative(repoRoot, filePath))
	) {
		return false;
	}
	let descriptor: number | undefined;
	try {
		const before = fs.lstatSync(filePath);
		updateReceiptPart(hasher, "untracked-path", relativePath);
		if (before.isSymbolicLink()) {
			updateReceiptPart(hasher, "untracked-type", "symlink");
			updateReceiptPart(hasher, "untracked-link-target", fs.readlinkSync(filePath, { encoding: "buffer" }));
			const after = fs.lstatSync(filePath);
			return (
				before.dev === after.dev &&
				before.ino === after.ino &&
				before.size === after.size &&
				before.mtimeMs === after.mtimeMs
			);
		}
		if (!before.isFile()) return false;
		updateReceiptPart(hasher, "untracked-type", "file");
		updateReceiptPart(hasher, "untracked-content-size", String(before.size));
		descriptor = fs.openSync(filePath, "r");
		const chunk = Buffer.allocUnsafe(WORKTREE_RECEIPT_FILE_CHUNK_BYTES);
		let position = 0;
		while (true) {
			const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.byteLength, position);
			if (bytesRead === 0) break;
			hasher.update(chunk.subarray(0, bytesRead));
			position += bytesRead;
		}
		const after = fs.fstatSync(descriptor);
		return (
			before.dev === after.dev &&
			before.ino === after.ino &&
			before.size === after.size &&
			before.mtimeMs === after.mtimeMs
		);
	} catch {
		return false;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function computeWorktreeReceipt(cwd: string): string | null {
	try {
		const repoRoot = vcs.gitInfo(cwd)?.repoRoot;
		if (!repoRoot) return null;
		const headResult = gitSpawnSyncBytes(repoRoot, ["rev-parse", "--verify", "HEAD"]);
		const stagedResult = gitSpawnSyncBytes(repoRoot, [
			"diff",
			"--binary",
			"--cached",
			"--no-ext-diff",
			"--no-textconv",
		]);
		const unstagedResult = gitSpawnSyncBytes(repoRoot, ["diff", "--binary", "--no-ext-diff", "--no-textconv"]);
		const statusResult = gitSpawnSyncBytes(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
		if (
			headResult.exitCode !== 0 ||
			stagedResult.exitCode !== 0 ||
			unstagedResult.exitCode !== 0 ||
			statusResult.exitCode !== 0
		) {
			return null;
		}
		const untrackedPaths = listUntrackedPaths(statusResult.stdout);
		if (!untrackedPaths) return null;
		const hasher = createHash("sha256");
		updateReceiptPart(hasher, "version", "git-worktree-receipt:v1");
		updateReceiptPart(hasher, "head", headResult.stdout);
		updateReceiptPart(hasher, "staged-binary-diff", stagedResult.stdout);
		updateReceiptPart(hasher, "unstaged-binary-diff", unstagedResult.stdout);
		for (const untrackedPath of untrackedPaths) {
			if (!updateFileReceipt(hasher, repoRoot, untrackedPath)) return null;
		}
		return hasher.digest("hex");
	} catch {
		return null;
	}
}

/**
 * Synchronously fingerprint the complete Git worktree state without persisting
 * source content. Two matching snapshots prove this read did not race a change.
 */
export function worktreeReceiptSync(cwd: string): GitWorktreeReceipt | null {
	const first = computeWorktreeReceipt(cwd);
	if (!first) return null;
	const second = computeWorktreeReceipt(cwd);
	if (!second || first !== second) return null;
	return { digest: first };
}
