import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultWorkflowArtifactDir } from "./artifact-store";
import { containsSecret, redactSecretsInText } from "./secret-redact";
import type { ArtifactHeader, VerificationArtifactV1, VerifierPort } from "./types";

/**
 * Exact/prefix allowlist for deterministic verification.
 * Prefer exact commands; do NOT allow open-ended `bun run ` / `npm run ` (release scripts, etc.).
 */
const DEFAULT_ALLOWED_COMMAND_PREFIXES = [
	"./test.sh",
	"biome check",
	"bun test",
	"bun check",
	"echo ok",
	"echo ",
	"git diff --check",
	"git status --short",
	"git status",
] as const;

const UNSAFE_SHELL_SYNTAX = /[;&|<>`\n]|\$\(/;
const MAX_LOG_CHARS = 50_000;
const MAX_SUMMARY_CHARS = 2_000;

type VerificationSubject = Pick<ArtifactHeader, "workflowId" | "attemptId" | "stage"> &
	Partial<Pick<ArtifactHeader, "modelProfileId" | "provider" | "model" | "promptVersion">> & {
		changedFiles?: string[];
		patchContent?: string;
	};

export interface VerifierSpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface VerifierOptions {
	cwd?: string;
	artifactDir?: string;
	allowedCommandPrefixes?: readonly string[];
	/** Injected spawn for tests. Must honor `signal` abort (kill child). */
	spawn?: (argv: string[], opts: { cwd: string; signal?: AbortSignal }) => Promise<VerifierSpawnResult>;
}

export class Verifier implements VerifierPort {
	readonly #cwd: string;
	readonly #artifactDir: string;
	readonly #allowedCommandPrefixes: readonly string[];
	readonly #spawn: NonNullable<VerifierOptions["spawn"]>;

	constructor(
		cwdOrOptions: string | VerifierOptions = process.cwd(),
		artifactDir?: string,
		allowedCommandPrefixes: readonly string[] = DEFAULT_ALLOWED_COMMAND_PREFIXES,
	) {
		if (typeof cwdOrOptions === "string") {
			this.#cwd = cwdOrOptions;
			this.#artifactDir = artifactDir ?? defaultWorkflowArtifactDir();
			this.#allowedCommandPrefixes = allowedCommandPrefixes;
			this.#spawn = defaultSpawn;
		} else {
			this.#cwd = cwdOrOptions.cwd ?? process.cwd();
			this.#artifactDir = cwdOrOptions.artifactDir ?? defaultWorkflowArtifactDir();
			this.#allowedCommandPrefixes = cwdOrOptions.allowedCommandPrefixes ?? DEFAULT_ALLOWED_COMMAND_PREFIXES;
			this.#spawn = cwdOrOptions.spawn ?? defaultSpawn;
		}
	}

	async verify(
		artifact: VerificationSubject,
		commands: string[],
		forbiddenPaths: string[] = [],
		options: { signal?: AbortSignal; timeoutMs?: number; expectDirtyTree?: boolean } = {},
	): Promise<VerificationArtifactV1> {
		const logPath = path.join(this.#artifactDir, `verify-${artifact.attemptId}-${Date.now()}.json`);
		const checks: VerificationArtifactV1["checks"] = [];

		// Secret-like patch rejection — never log the secret itself
		if (artifact.patchContent && containsSecret(artifact.patchContent)) {
			checks.push({
				id: "secret-scan",
				status: "failed",
				summary: "Patch contains secret-like content and was rejected",
				logPath,
			});
		}

		// Forbidden paths
		const forbiddenFile = artifact.changedFiles?.find(file =>
			forbiddenPaths.some(forbidden => {
				const normalizedFile = path.normalize(file);
				const normalizedForbidden = path.normalize(forbidden);
				return (
					normalizedFile === normalizedForbidden || normalizedFile.startsWith(`${normalizedForbidden}${path.sep}`)
				);
			}),
		);
		if (forbiddenFile) {
			checks.push({
				id: "forbidden-paths",
				status: "failed",
				summary: `Changed file is inside a forbidden path: ${forbiddenFile}`,
				logPath,
			});
		}

		// Unchanged tree check when implementation claims changes
		if (options.expectDirtyTree === false && (artifact.changedFiles?.length ?? 0) === 0) {
			// ok — explicitly empty tree expected
		} else if (options.expectDirtyTree && (artifact.changedFiles?.length ?? 0) === 0) {
			checks.push({
				id: "unchanged-tree",
				status: "failed",
				summary: "Implementation claimed isolation write but reported no changed files",
				logPath,
			});
		}

		for (const [index, command] of commands.entries()) {
			if (options.signal?.aborted) {
				checks.push({
					id: `command-${index + 1}`,
					command,
					status: "failed",
					summary: "Verification cancelled",
					logPath,
				});
				break;
			}
			const check = await this.#runCommand(command, index, logPath, options);
			checks.push(check);
		}

		const final: VerificationArtifactV1 = {
			kind: "verification",
			passed: checks.length > 0 ? checks.every(check => check.status !== "failed") : true,
			checks,
			schemaVersion: 1,
			workflowId: artifact.workflowId,
			attemptId: artifact.attemptId,
			stage: artifact.stage,
			createdAt: new Date().toISOString(),
			modelProfileId: artifact.modelProfileId,
			provider: artifact.provider,
			model: artifact.model,
			promptVersion: artifact.promptVersion,
		};

		await fs.mkdir(this.#artifactDir, { recursive: true });
		const fullLog = JSON.stringify(final, null, 2);
		const truncated =
			fullLog.length > MAX_LOG_CHARS ? `${fullLog.slice(0, MAX_LOG_CHARS)}\n/* truncated */` : fullLog;
		await fs.writeFile(logPath, truncated, "utf8");
		return final;
	}

	async #runCommand(
		command: string,
		index: number,
		logPath: string,
		options: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<VerificationArtifactV1["checks"][number]> {
		const allowed = this.#allowedCommandPrefixes.some(
			prefix => command === prefix.trimEnd() || command.startsWith(prefix),
		);
		if (!allowed || UNSAFE_SHELL_SYNTAX.test(command)) {
			return {
				id: `command-${index + 1}`,
				command,
				status: "failed",
				summary: "Command rejected by verification policy",
				logPath,
			};
		}

		// Prefer argv without shell when command is a simple space-split; fall back to sh -lc for quoted args.
		const argv = tokenizeCommand(command);
		const useShell = argv === null;

		// Combined abort: parent signal OR wall-clock timeout — both kill the child via spawn signal.
		// Also race the timeout so injectors that ignore signal still surface timeout promptly.
		const controller = new AbortController();
		const onParentAbort = () => controller.abort(options.signal?.reason ?? new Error("cancelled"));
		if (options.signal) {
			if (options.signal.aborted) onParentAbort();
			else options.signal.addEventListener("abort", onParentAbort, { once: true });
		}
		const timeoutMs = options.timeoutMs;
		let timer: Timer | undefined;
		let timedOut = false;

		const spawnPromise = this.#spawn(useShell ? ["/bin/sh", "-lc", command] : argv!, {
			cwd: this.#cwd,
			signal: controller.signal,
		});

		try {
			let result: VerifierSpawnResult;
			if (timeoutMs && timeoutMs > 0) {
				const { promise: timeoutPromise, reject: rejectTimeout } = Promise.withResolvers<never>();
				timer = setTimeout(() => {
					timedOut = true;
					controller.abort(new Error("timeout"));
					rejectTimeout(new Error("timeout"));
				}, timeoutMs);
				result = await Promise.race([spawnPromise, timeoutPromise]);
			} else {
				result = await spawnPromise;
			}
			const { exitCode, stdout, stderr } = result;
			const output = `${stdout}${stderr}`.trim();
			const redacted = redactSecretsInText(output);
			return {
				id: `command-${index + 1}`,
				command,
				status: exitCode === 0 ? "passed" : "failed",
				exitCode,
				summary: (redacted.slice(0, MAX_SUMMARY_CHARS) || `Command exited with code ${exitCode}`).slice(
					0,
					MAX_SUMMARY_CHARS,
				),
				logPath,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (timedOut || /timeout/i.test(message)) {
				return {
					id: `command-${index + 1}`,
					command,
					status: "failed",
					summary: "Verification timed out",
					logPath,
				};
			}
			if (controller.signal.aborted || /abort|cancel/i.test(message)) {
				return {
					id: `command-${index + 1}`,
					command,
					status: "failed",
					summary: "Verification cancelled",
					logPath,
				};
			}
			return {
				id: `command-${index + 1}`,
				command,
				status: "failed",
				summary: redactSecretsInText(message).slice(0, MAX_SUMMARY_CHARS),
				logPath,
			};
		} finally {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onParentAbort);
		}
	}
}

/** Return argv tokens when safe; null when shell quoting is required. */
function tokenizeCommand(command: string): string[] | null {
	if (/['"$\\]/.test(command)) return null;
	const parts = command.trim().split(/\s+/).filter(Boolean);
	return parts.length > 0 ? parts : null;
}

async function defaultSpawn(argv: string[], opts: { cwd: string; signal?: AbortSignal }): Promise<VerifierSpawnResult> {
	const proc = Bun.spawn(argv, {
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
		// Bun kills the child when this signal aborts (timeout / cancel).
		signal: opts.signal,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	} catch (error) {
		// Ensure process is dead if race left it running
		try {
			proc.kill();
		} catch {
			// ignore
		}
		throw error;
	}
}
