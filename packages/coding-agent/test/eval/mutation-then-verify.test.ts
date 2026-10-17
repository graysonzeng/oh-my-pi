import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs, type JsResult } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/**
 * Same control flow as docs/tools/eval.md "Couple a file mutation to its verifier".
 * A consumer-visible regression is: mutation failure still runs bash, a
 * successful write skips or repeats the predetermined verifier, or a failed
 * verifier deletes the write.
 */
const MUTATION_THEN_VERIFY_CELL = `
function bridgedFailed(value) {
	return Boolean(value) && typeof value === "object" && value.hasError === true;
}

async function mutationThenVerify(writeArgs, bashArgs) {
	let written;
	try {
		written = await tool.write(writeArgs);
	} catch (error) {
		return { stage: "write-threw", error: String(error) };
	}
	if (bridgedFailed(written)) {
		return { stage: "write-error", written };
	}
	let verified;
	try {
		verified = await tool.bash(bashArgs);
	} catch (error) {
		return { stage: "verify-threw", written, error: String(error) };
	}
	if (verified?.details?.async?.state === "running") {
		return { stage: "verify-background", written, verified };
	}
	return { stage: "verify", written, verified };
}

display(await mutationThenVerify(globalThis.writeArgs, globalThis.bashArgs));
`;

function createSession(cwd: string): ToolSession {
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionDir = path.join(cwd, "session");
	const registry = new Map<string, AgentTool>();
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			await fs.mkdir(sessionDir, { recursive: true });
			return { id: toolType, path: path.join(sessionDir, `${toolType}.log`) };
		},
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
		}),
		getToolByName: name => registry.get(name),
	};
	registry.set("write", new WriteTool(session) as unknown as AgentTool);
	registry.set("bash", new BashTool(session) as unknown as AgentTool);
	return session;
}

function displayedRecord(result: JsResult): Record<string, unknown> {
	const json = result.displayOutputs.find(output => output.type === "json");
	if (!json || json.type !== "json" || typeof json.data !== "object" || json.data === null) {
		throw new Error(`expected json display, got ${JSON.stringify(result.displayOutputs)}; output=${result.output}`);
	}
	return json.data as Record<string, unknown>;
}

describe("eval mutation-then-verify recipe", () => {
	let tmpDir: string;
	let sessionId = 0;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mutation-then-verify-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	afterAll(async () => {
		await disposeAllVmContexts();
	});

	async function runRecipe(writeArgs: Record<string, unknown>, bashArgs: Record<string, unknown>) {
		const session = createSession(tmpDir);
		return await executeJs(
			`globalThis.writeArgs = ${JSON.stringify(writeArgs)};\nglobalThis.bashArgs = ${JSON.stringify(bashArgs)};${MUTATION_THEN_VERIFY_CELL}`,
			{
				sessionId: `mutation-then-verify-${++sessionId}`,
				session,
				cwd: tmpDir,
				timeoutMs: 30_000,
			},
		);
	}

	it("does not start the verifier when write fails", async () => {
		const blocked = path.join(tmpDir, "blocked");
		await fs.mkdir(blocked);
		const stamp = path.join(tmpDir, "verified.stamp");
		const result = await runRecipe(
			{ path: blocked, content: "should not replace a directory\n", i: "write onto directory" },
			{ command: "printf ran >> verified.stamp", i: "must not run" },
		);

		const stage = displayedRecord(result).stage;
		expect(stage === "write-threw" || stage === "write-error").toBe(true);
		await expect(fs.access(stamp)).rejects.toThrow();
	});

	it("runs the verifier once against the new file after a successful write", async () => {
		const target = path.join(tmpDir, "fixture.js");
		const stamp = path.join(tmpDir, "verified.stamp");
		const result = await runRecipe(
			{ path: "fixture.js", content: "module.exports = 1;\n", i: "write fixture" },
			{
				command: "test -s fixture.js && cat fixture.js >> verified.stamp",
				i: "verify fixture exists",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(await fs.readFile(target, "utf8")).toBe("module.exports = 1;\n");
		expect(await fs.readFile(stamp, "utf8")).toBe("module.exports = 1;\n");
		expect(displayedRecord(result).stage).toBe("verify");
	});

	it("keeps the write and reports failure when the verifier exits nonzero", async () => {
		const target = path.join(tmpDir, "fixture.js");
		const result = await runRecipe(
			{ path: "fixture.js", content: "module.exports = 1;\n", i: "write fixture" },
			{ command: "exit 3", i: "predetermined failing check" },
		);

		expect(await fs.readFile(target, "utf8")).toBe("module.exports = 1;\n");
		const displayed = displayedRecord(result);
		expect(displayed.stage).toBe("verify");
		expect(displayed.verified).toEqual(expect.objectContaining({ hasError: true }));
	});
});
