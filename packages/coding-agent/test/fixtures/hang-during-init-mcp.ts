#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server that accepts the connection but never
 * answers `initialize`. Models a remote endpoint that's reachable at the
 * transport layer but unresponsive at the protocol layer (e.g. the
 * `sbox-superdocs` timeout described in issue #2100) — exactly the shape
 * that used to gate `omp` startup on a 30 s per-server MCP timeout.
 *
 * Reads stdin to keep the pipe open and ignores every message. The process
 * stays alive until the parent closes stdin or kills it.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

const spawnLog = Bun.env.OMP_TEST_SPAWN_LOG;
const releaseOnSignal = Bun.env.OMP_TEST_RELEASE_ON_SIGNAL === "1";
let released = false;
const pendingLines: string[] = [];

function respond(line: string): void {
	if (!releaseOnSignal) return;
	let message: { id?: number | string; method?: string };
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.id === undefined) return;
	const result =
		message.method === "initialize"
			? {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "released-hang-fixture", version: "1.0.0" },
				}
			: message.method === "tools/list"
				? { tools: [] }
				: {};
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}

process.on("SIGUSR1", () => {
	released = true;
	for (const line of pendingLines.splice(0)) respond(line);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
	if (released) respond(line);
	else pendingLines.push(line);
});
rl.on("close", () => process.exit(0));

if (spawnLog) {
	fs.appendFileSync(spawnLog, `${process.pid} ${Date.now()}\n`);
}
