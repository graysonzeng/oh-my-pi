import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ArtifactHeader, VerificationArtifactV1 } from "./types";

const DEFAULT_ALLOWED_COMMAND_PREFIXES = [
	"./test.sh",
	"biome check ",
	"bun run ",
	"bun test",
	"echo ",
	"git diff --check",
	"node ",
	"npm run ",
	"rg ",
] as const;
const UNSAFE_SHELL_SYNTAX = /[;&|<>`\n]|\$\(/;

type VerificationSubject = Pick<ArtifactHeader, "workflowId" | "attemptId" | "stage"> &
	Partial<Pick<ArtifactHeader, "modelProfileId" | "provider" | "model" | "promptVersion">> & {
		changedFiles?: string[];
	};

export class Verifier {
	readonly #cwd: string;
	readonly #artifactDir: string;
	readonly #allowedCommandPrefixes: readonly string[];

	constructor(
		cwd = process.cwd(),
		artifactDir = path.join(cwd, ".workflow-artifacts"),
		allowedCommandPrefixes: readonly string[] = DEFAULT_ALLOWED_COMMAND_PREFIXES,
	) {
		this.#cwd = cwd;
		this.#artifactDir = artifactDir;
		this.#allowedCommandPrefixes = allowedCommandPrefixes;
	}

	async verify(
		artifact: VerificationSubject,
		commands: string[],
		forbiddenPaths: string[] = [],
	): Promise<VerificationArtifactV1> {
		const logPath = path.join(this.#artifactDir, `verify-${Date.now()}.json`);
		const checks: VerificationArtifactV1["checks"] = [];

		for (const [index, command] of commands.entries()) {
			const check = await this.#runCommand(command, index, logPath);
			checks.push(check);
		}

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
			});
		}

		const final: VerificationArtifactV1 = {
			kind: "verification",
			passed: checks.every(check => check.status !== "failed"),
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
		await fs.writeFile(logPath, JSON.stringify(final, null, 2));
		return final;
	}

	async #runCommand(
		command: string,
		index: number,
		logPath: string,
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

		const process = Bun.spawn(["/bin/sh", "-lc", command], {
			cwd: this.#cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		const output = `${stdout}${stderr}`.trim();
		return {
			id: `command-${index + 1}`,
			command,
			status: exitCode === 0 ? "passed" : "failed",
			exitCode,
			summary: output.slice(0, 2000) || `Command exited with code ${exitCode}`,
			logPath,
		};
	}
}
