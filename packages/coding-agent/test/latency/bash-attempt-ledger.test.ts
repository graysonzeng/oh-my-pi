import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import {
	appendBashAttempt,
	buildBashCommandFingerprint,
	buildBashFailureFingerprint,
	buildBashStateFingerprint,
	clearBashAttemptLedgerStore,
	createBashAttemptLedger,
	getBashAttemptLedgerStore,
	lookupRepeatedBashFailure,
	resolveBashStateIdentity,
} from "../../src/latency/bash-attempt-ledger";
import type { ClientBridge, ClientBridgeTerminalHandle } from "../../src/session/client-bridge";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";

function runGit(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
}

describe("BashAttemptLedgerV1 identity", () => {
	it("keeps command identity conservative while normalizing whitespace", () => {
		const normalized = buildBashCommandFingerprint({ command: "  printf   ok  ", cwd: "/repo" });
		const equivalentWhitespace = buildBashCommandFingerprint({ command: "printf ok", cwd: "/repo" });
		const differentQuote = buildBashCommandFingerprint({ command: 'printf "ok"', cwd: "/repo" });
		const differentQuotedSpacing = buildBashCommandFingerprint({ command: 'printf "o k"', cwd: "/repo" });
		const differentCwd = buildBashCommandFingerprint({ command: "printf ok", cwd: "/tmp" });

		expect(normalized).toBe(equivalentWhitespace);
		expect(normalized).not.toBe(differentQuote);
		expect(normalized).not.toBe(differentQuotedSpacing);
		expect(normalized).not.toBe(differentCwd);
	});

	it("uses cwd and sorted environment names without env values", () => {
		const first = buildBashStateFingerprint({
			cwd: "/repo",
			envNames: ["SECRET_TOKEN", "PATH"],
			codeRevision: "abc",
			worktreeDigest: "wt",
		});
		const reordered = buildBashStateFingerprint({
			cwd: "/repo",
			envNames: ["PATH", "SECRET_TOKEN"],
			codeRevision: "abc",
			worktreeDigest: "wt",
		});
		const changedName = buildBashStateFingerprint({
			cwd: "/repo",
			envNames: ["PATH", "OTHER_TOKEN"],
			codeRevision: "abc",
			worktreeDigest: "wt",
		});
		const changedCwd = buildBashStateFingerprint({
			cwd: "/tmp",
			envNames: ["PATH", "SECRET_TOKEN"],
			codeRevision: "abc",
			worktreeDigest: "wt",
		});
		const changedRevision = buildBashStateFingerprint({
			cwd: "/repo",
			envNames: ["PATH", "SECRET_TOKEN"],
			codeRevision: "def",
			worktreeDigest: "wt",
		});
		const changedWorktree = buildBashStateFingerprint({
			cwd: "/repo",
			envNames: ["PATH", "SECRET_TOKEN"],
			codeRevision: "abc",
			worktreeDigest: "dirty",
		});

		expect(first).toBe(reordered);
		expect(first).not.toBe(changedName);
		expect(first).not.toBe(changedCwd);
		expect(first).not.toBe(changedRevision);
		expect(first).not.toBe(changedWorktree);
	});

	it("includes dirty worktree content in authoritative state identity", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bash-state-id-"));
		const run = (args: string[]): void => {
			const result = Bun.spawnSync(["git", ...args], {
				cwd: root,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "test",
					GIT_AUTHOR_EMAIL: "test@example.com",
					GIT_COMMITTER_NAME: "test",
					GIT_COMMITTER_EMAIL: "test@example.com",
				},
			});
			expect(result.exitCode).toBe(0);
		};
		try {
			run(["init"]);
			fs.writeFileSync(path.join(root, "probe.ts"), "export const value = 1;\n");
			fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "probe" }));
			run(["add", "probe.ts", "package.json"]);
			run(["commit", "-m", "init"]);

			const clean = resolveBashStateIdentity({ cwd: root, envNames: ["PATH"] });
			expect(clean.stateAuthoritative).toBe(true);
			expect(clean.changedInputReceipt).toBeTruthy();
			expect(clean.worktreeDigest).toBeTruthy();

			fs.writeFileSync(path.join(root, "probe.ts"), "export const value = 2;\n");
			const dirty = resolveBashStateIdentity({ cwd: root, envNames: ["PATH"] });
			expect(dirty.stateAuthoritative).toBe(true);
			expect(dirty.stateFingerprint).not.toBe(clean.stateFingerprint);
			expect(dirty.worktreeDigest).not.toBe(clean.worktreeDigest);

			fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "probe", version: "2" }));
			const configChanged = resolveBashStateIdentity({ cwd: root, envNames: ["PATH"] });
			expect(configChanged.stateFingerprint).not.toBe(dirty.stateFingerprint);
			expect(configChanged.configHash).not.toBe(clean.configHash);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails open without authoritative state outside a git repo", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bash-state-nongit-"));
		try {
			const identity = resolveBashStateIdentity({ cwd: root, envNames: ["PATH"] });
			expect(identity.stateAuthoritative).toBe(false);
			expect(identity.changedInputReceipt).toBeNull();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("BashAttemptLedgerV1 repetition", () => {
	it("advises on a repeated failure but does not count cancellation", () => {
		const commandFingerprint = buildBashCommandFingerprint({ command: "false", cwd: "/repo" });
		const stateFingerprint = buildBashStateFingerprint({ cwd: "/repo", envNames: ["PATH"] });
		const failureFingerprint = buildBashFailureFingerprint({
			terminal: { kind: "exit", exitCode: 1 },
			stderrExcerpt: "same failure",
		});
		expect(failureFingerprint).toHaveLength(64);

		let ledger = createBashAttemptLedger({
			sessionId: "session-1",
			commandFingerprint,
			stateFingerprint,
			mode: "advisory",
		});
		ledger = appendBashAttempt(ledger, {
			attemptId: "attempt-1",
			startedAt: "2026-08-04T00:00:00Z",
			endedAt: "2026-08-04T00:00:01Z",
			terminal: { kind: "exit", exitCode: 1 },
			failureFingerprint,
			stdoutDigest: "stdout",
			stderrDigest: "stderr",
			cwdIdentity: "/repo",
			changedInputReceipt: null,
		});

		const repeated = lookupRepeatedBashFailure([ledger], {
			commandFingerprint,
			stateFingerprint,
			failureFingerprint,
		});
		expect(repeated.repeatedFailure).toBe(true);
		expect(repeated.priorAttempts).toBe(1);
		expect(repeated.advisoryText).toContain("execution not blocked");

		const cancelledFailure = buildBashFailureFingerprint({
			terminal: { kind: "cancelled" },
			stderrExcerpt: "same failure",
		});
		expect(cancelledFailure).toBeNull();
		const cancelledOnly = appendBashAttempt(
			createBashAttemptLedger({
				sessionId: "session-2",
				commandFingerprint,
				stateFingerprint,
				mode: "advisory",
			}),
			{
				attemptId: "attempt-cancelled",
				startedAt: "2026-08-04T00:00:00Z",
				endedAt: "2026-08-04T00:00:01Z",
				terminal: { kind: "cancelled" },
				failureFingerprint: null,
				stdoutDigest: "stdout",
				stderrDigest: "stderr",
				cwdIdentity: "/repo",
				changedInputReceipt: null,
			},
		);
		const cancelledLookup = lookupRepeatedBashFailure([cancelledOnly], {
			commandFingerprint,
			stateFingerprint,
			failureFingerprint,
		});
		expect(cancelledLookup.repeatedFailure).toBe(false);
		expect(buildBashFailureFingerprint({ terminal: { kind: "exit", exitCode: 0 } })).toBeNull();
	});

	it("strips wall-time noise so identical false exits share a fingerprint", () => {
		const terminal = { kind: "exit" as const, exitCode: 1 };
		const a = buildBashFailureFingerprint({
			terminal,
			stdoutExcerpt: "(no output)\n\nWall time: 0.03 seconds\n\nCommand exited with code 1",
		});
		const b = buildBashFailureFingerprint({
			terminal,
			stdoutExcerpt: "(no output)\n\nWall time: 0.00 seconds\n\nCommand exited with code 1",
		});
		expect(a).not.toBeNull();
		expect(a).toBe(b);

		const commandFingerprint = buildBashCommandFingerprint({ command: "false", cwd: "/repo" });
		const stateFingerprint = buildBashStateFingerprint({ cwd: "/repo", envNames: [] });
		let ledger = createBashAttemptLedger({
			sessionId: "session-wall-time",
			commandFingerprint,
			stateFingerprint,
			mode: "advisory",
		});
		ledger = appendBashAttempt(ledger, {
			attemptId: "attempt-1",
			startedAt: "2026-08-04T00:00:00Z",
			endedAt: "2026-08-04T00:00:01Z",
			terminal,
			failureFingerprint: a,
			stdoutDigest: "stdout-a",
			stderrDigest: "stderr",
			cwdIdentity: "/repo",
			changedInputReceipt: null,
		});

		const repeated = lookupRepeatedBashFailure([ledger], {
			commandFingerprint,
			stateFingerprint,
			failureFingerprint: b,
		});
		expect(repeated.repeatedFailure).toBe(true);
		expect(repeated.advisoryText).toBeTruthy();
		expect(repeated.advisoryText).toContain("execution not blocked");
	});
});

describe("BashAttemptLedgerStore session ownership", () => {
	it("returns one store per session object", () => {
		const session = {};
		const sameSessionStore = getBashAttemptLedgerStore(session);
		const sameSessionStoreAgain = getBashAttemptLedgerStore(session);
		const otherSessionStore = getBashAttemptLedgerStore({});

		expect(sameSessionStore).toBeDefined();
		expect(sameSessionStoreAgain).toBe(sameSessionStore);
		expect(otherSessionStore).not.toBe(sameSessionStore);
	});

	it("shares stores by session id and clears the id owner", () => {
		const firstSession = { getSessionId: () => "bash-ledger-session-id" };
		const secondSession = { getSessionId: () => "bash-ledger-session-id" };
		const firstStore = getBashAttemptLedgerStore(firstSession);
		expect(getBashAttemptLedgerStore(secondSession)).toBe(firstStore);

		clearBashAttemptLedgerStore("bash-ledger-session-id");
		expect(getBashAttemptLedgerStore(secondSession)).not.toBe(firstStore);
	});
});

describe("BashTool ledger completion integration", () => {
	it("prepends advisory and bounded summary without blocking rerun", async () => {
		const settings = Settings.isolated({
			"latency.arms.bashAdvisory": true,
			"latency.arms.bashBoundedInjection": true,
		});
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings,
			skills: [],
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => "bash-ledger-test",
			getArtifactsDir: () => null,
		} as unknown as ToolSession;
		const tool = new BashTool(session);

		const first = await tool.execute("first", { command: "printf ledger && exit 9", timeout: 30 });
		const second = await tool.execute("second", { command: "printf ledger && exit 9", timeout: 30 });
		const firstText = first.content.find(block => block.type === "text")?.text ?? "";
		const secondText = second.content.find(block => block.type === "text")?.text ?? "";

		expect(firstText).toContain("Command exited with code 9");
		expect(secondText.startsWith("[bash-attempt-ledger] repeated identical failure")).toBe(true);
		expect(secondText).toContain("bounded summary");
		expect(secondText).toContain("Command exited with code 9");
	});
	it("injects only the bounded summary when advisory is disabled and invalidates it after state changes", async () => {
		const repo = TempDir.createSync("@pi-bash-ledger-bounded-");
		const sessionId = "bash-ledger-bounded-only-test";
		try {
			runGit(repo.path(), ["init", "--initial-branch=main"]);
			runGit(repo.path(), ["config", "user.email", "tester@example.com"]);
			runGit(repo.path(), ["config", "user.name", "Tester"]);
			const trackedPath = path.join(repo.path(), "probe.ts");
			await Bun.write(trackedPath, "export const value = 1;\n");
			runGit(repo.path(), ["add", "probe.ts"]);
			runGit(repo.path(), ["commit", "-m", "baseline"]);

			const settings = Settings.isolated({ "latency.arms.bashBoundedInjection": true });
			const session = {
				cwd: repo.path(),
				hasUI: false,
				settings,
				skills: [],
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				getSessionId: () => sessionId,
				getArtifactsDir: () => null,
			} as unknown as ToolSession;
			const tool = new BashTool(session);
			const runFailure = async (callId: string): Promise<string> => {
				const result = await tool.execute(callId, {
					command: "printf ledger && exit 9",
					env: { BASH_LEDGER_SECRET: "must-not-appear-in-receipt" },
					timeout: 30,
				});
				return result.content.find(block => block.type === "text")?.text ?? "";
			};

			const first = await runFailure("bounded-first");
			expect(first).toContain("Command exited with code 9");
			expect(first).not.toContain("[bash-attempt-ledger] bounded summary");
			expect(first).not.toContain("repeated identical failure");

			const second = await runFailure("bounded-second");
			expect(second.startsWith("[bash-attempt-ledger] bounded summary")).toBe(true);
			expect(second).not.toContain("repeated identical failure");
			expect(second).toContain("Command exited with code 9");

			await Bun.write(trackedPath, "export const value = 2;\n");
			const changed = await runFailure("bounded-state-change");
			expect(changed).not.toContain("[bash-attempt-ledger] bounded summary");
			expect(changed).not.toContain("repeated identical failure");

			const changedRepeat = await runFailure("bounded-state-repeat");
			expect(changedRepeat.startsWith("[bash-attempt-ledger] bounded summary")).toBe(true);
			expect(changedRepeat).not.toContain("repeated identical failure");
			expect(changedRepeat).toContain("Command exited with code 9");

			const ledgers = getBashAttemptLedgerStore(session)?.list() ?? [];
			expect(ledgers).toHaveLength(2);
			expect(ledgers.every(ledger => ledger.mode === "bounded_injection")).toBe(true);
			expect(ledgers.every(ledger => !JSON.stringify(ledger).includes("must-not-appear-in-receipt"))).toBe(true);
		} finally {
			clearBashAttemptLedgerStore(sessionId);
			repo.removeSync();
		}
	});

	it("invalidates repeated-failure advice across tracked, staged, and untracked changes", async () => {
		const repo = TempDir.createSync("@pi-bash-ledger-state-");
		try {
			runGit(repo.path(), ["init", "--initial-branch=main"]);
			runGit(repo.path(), ["config", "user.email", "tester@example.com"]);
			runGit(repo.path(), ["config", "user.name", "Tester"]);
			const trackedPath = path.join(repo.path(), "probe.ts");
			await Bun.write(trackedPath, "export const value = 1;\n");
			runGit(repo.path(), ["add", "probe.ts"]);
			runGit(repo.path(), ["commit", "-m", "baseline"]);

			const settings = Settings.isolated({ "latency.arms.bashAdvisory": true });
			const session = {
				cwd: repo.path(),
				hasUI: false,
				settings,
				skills: [],
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				getSessionId: () => "bash-ledger-state-change-test",
				getArtifactsDir: () => null,
			} as unknown as ToolSession;
			const tool = new BashTool(session);
			const runFailure = async (callId: string): Promise<string> => {
				const result = await tool.execute(callId, { command: "printf ledger && exit 9", timeout: 30 });
				return result.content.find(block => block.type === "text")?.text ?? "";
			};
			const isAdvisory = (text: string): boolean =>
				text.startsWith("[bash-attempt-ledger] repeated identical failure");

			expect(isAdvisory(await runFailure("baseline-first"))).toBe(false);
			expect(isAdvisory(await runFailure("baseline-repeat"))).toBe(true);

			await Bun.write(trackedPath, "export const value = 2;\n");
			expect(isAdvisory(await runFailure("unstaged-change"))).toBe(false);
			expect(isAdvisory(await runFailure("unstaged-repeat"))).toBe(true);

			runGit(repo.path(), ["add", "probe.ts"]);
			expect(isAdvisory(await runFailure("staged-change"))).toBe(false);
			expect(isAdvisory(await runFailure("staged-repeat"))).toBe(true);

			const untrackedPath = path.join(repo.path(), "scratch.ts");
			await Bun.write(untrackedPath, "export const scratch = 1;\n");
			expect(isAdvisory(await runFailure("untracked-add"))).toBe(false);
			expect(isAdvisory(await runFailure("untracked-repeat"))).toBe(true);

			await Bun.write(untrackedPath, "export const scratch = 2;\n");
			expect(isAdvisory(await runFailure("untracked-content-change"))).toBe(false);
		} finally {
			clearBashAttemptLedgerStore("bash-ledger-state-change-test");
			repo.removeSync();
		}
	});

	it("records failures but suppresses advice when worktree state is not authoritative", async () => {
		const directory = TempDir.createSync("@pi-bash-ledger-no-git-");
		const sessionId = "bash-ledger-no-git-test";
		try {
			const session = {
				cwd: directory.path(),
				hasUI: false,
				settings: Settings.isolated({ "latency.arms.bashAdvisory": true }),
				skills: [],
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				getSessionId: () => sessionId,
				getArtifactsDir: () => null,
			} as unknown as ToolSession;
			const tool = new BashTool(session);
			const first = await tool.execute("no-git-first", { command: "printf ledger && exit 9", timeout: 30 });
			const second = await tool.execute("no-git-second", { command: "printf ledger && exit 9", timeout: 30 });
			const firstText = first.content.find(block => block.type === "text")?.text ?? "";
			const secondText = second.content.find(block => block.type === "text")?.text ?? "";

			expect(firstText).not.toContain("repeated identical failure");
			expect(secondText).not.toContain("repeated identical failure");
			const [ledger] = getBashAttemptLedgerStore(session)?.list() ?? [];
			expect(ledger?.attempts).toHaveLength(2);
			expect(ledger?.attempts.every(attempt => attempt.changedInputReceipt === null)).toBe(true);
		} finally {
			clearBashAttemptLedgerStore(sessionId);
			directory.removeSync();
		}
	});

	it("records repeated failures from the ACP terminal path", async () => {
		const settings = Settings.isolated({
			"bash.direnv": "off",
			"latency.arms.bashAdvisory": true,
		});
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-ledger",
			waitForExit: async () => ({ exitCode: 9, signal: null }),
			currentOutput: async () => ({ output: "acp failure\n", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings,
			skills: [],
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => "bash-ledger-acp-test",
			getArtifactsDir: () => null,
			getClientBridge: () => bridge,
		} as unknown as ToolSession;
		const tool = new BashTool(session);

		await tool.execute("acp-first", { command: "false" });
		const repeated = await tool.execute("acp-second", { command: "false" });
		const text = repeated.content.find(block => block.type === "text")?.text ?? "";

		expect(text.startsWith("[bash-attempt-ledger] repeated identical failure")).toBe(true);
		expect(text).toContain("Command exited with code 9");
	});

	it("records timeout terminals from ACP create and poll paths", async () => {
		const makeSession = (sessionId: string, bridge: ClientBridge): ToolSession =>
			({
				cwd: process.cwd(),
				hasUI: false,
				settings: Settings.isolated({
					"bash.direnv": "off",
					"latency.arms.bashAdvisory": true,
				}),
				skills: [],
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				getSessionId: () => sessionId,
				getArtifactsDir: () => null,
				getClientBridge: () => bridge,
			}) as unknown as ToolSession;
		const expectTimeoutAttempt = (session: ToolSession, command: string): void => {
			const cwd = process.cwd();
			const commandFingerprint = buildBashCommandFingerprint({ command, cwd });
			const authoritative = getBashAttemptLedgerStore(session)
				?.list()
				.find(entry => entry.commandFingerprint === commandFingerprint);
			expect(authoritative?.attempts.at(-1)?.terminal).toEqual({ kind: "timeout" });
		};

		const createCommand = "printf create-timeout";
		const createBridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: () => new Promise<ClientBridgeTerminalHandle>(() => {}),
		};
		const createSession = makeSession("bash-ledger-acp-create-timeout-test", createBridge);
		await expect(
			new BashTool(createSession).execute("acp-create-timeout", { command: createCommand, timeout: 1 }),
		).rejects.toThrow(/Command timed out after 1 seconds/);
		expectTimeoutAttempt(createSession, createCommand);

		const pollCommand = "printf poll-timeout";
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const pollHandle: ClientBridgeTerminalHandle = {
			terminalId: "term-ledger-poll-timeout",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => ({ output: "poll timeout output\n", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const pollBridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => pollHandle,
		};
		const pollSession = makeSession("bash-ledger-acp-poll-timeout-test", pollBridge);
		await expect(
			new BashTool(pollSession).execute("acp-poll-timeout", { command: pollCommand, timeout: 1 }),
		).rejects.toThrow(/Command timed out after 1 seconds/);
		expectTimeoutAttempt(pollSession, pollCommand);
	});
});
