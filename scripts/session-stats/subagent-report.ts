#!/usr/bin/env bun
/**
 * Recalculable subagent baseline over local omp session JSONL
 * (~/.omp/agent/sessions/). Offline: no upload, no conversation bodies.
 *
 * Usage:
 *   bun scripts/session-stats/subagent-report.ts
 *   bun scripts/session-stats/subagent-report.ts --since 3d --format json
 *   bun scripts/session-stats/subagent-report.ts --session ~/.omp/agent/sessions/<folder>/<id>.jsonl --format json
 *   bun scripts/session-stats/subagent-report.ts --sessions ~/.omp/agent/sessions --since 1w --json out.json
 *
 * --since filters whole parent+child groups by max file mtime, not per-event timestamps inside JSONL.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
	buildSubagentBaselineReport,
	formatSubagentBaselineReport,
	type ParsedSession,
	parseSessionJsonl,
	type SubagentBaselineReport,
} from "../../packages/coding-agent/src/latency/subagent-report.ts";

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), ".omp", "agent", "sessions");

export interface SubagentReportCliOptions {
	sinceMs: number;
	sessionsRoot: string;
	session?: string;
	folder?: string;
	format: "human" | "json";
	jsonOut?: string;
}

export function parseSince(raw: string): number {
	const m = /^(\d+)?\s*(h|d|w|mo|m)$/.exec(raw.trim());
	if (!m) throw new Error(`invalid --since "${raw}" (use e.g. 12h, 3d, 1w, 1mo)`);
	const n = m[1] ? Number.parseInt(m[1], 10) : 1;
	const HOUR = 3_600_000;
	switch (m[2]) {
		case "h":
			return n * HOUR;
		case "d":
			return n * 24 * HOUR;
		case "w":
			return n * 7 * 24 * HOUR;
		default:
			return n * 30 * 24 * HOUR;
	}
}

export function parseSubagentReportCli(argv: string[]): SubagentReportCliOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			since: { type: "string", default: "1w" },
			sessions: { type: "string" },
			session: { type: "string" },
			folder: { type: "string" },
			format: { type: "string", default: "human" },
			json: { type: "string" },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		console.log(
			`subagent baseline — offline coverage/timing report over ~/.omp/agent/sessions\n\n` +
				`  --since <12h|3d|1w|1mo>  keep parent+child groups whose max file mtime is in the window\n` +
				`                           (default 1w; not an in-file event slice)\n` +
				`  --sessions <dir>         sessions root (default ~/.omp/agent/sessions)\n` +
				`  --session <path>         one parent jsonl (includes nested children; ignores --since)\n` +
				`  --folder <substr>        only folders containing substring\n` +
				`  --format human|json      stdout format (default human)\n` +
				`  --json <file|->          write JSON to file, or stdout when -`,
		);
		process.exit(0);
	}
	if (values.format !== "human" && values.format !== "json") {
		throw new Error(`invalid --format "${values.format}" (use human or json)`);
	}
	const format = values.json === "-" ? "json" : values.format;
	return {
		sinceMs: parseSince(values.since),
		sessionsRoot: values.sessions ?? DEFAULT_SESSIONS_ROOT,
		session: values.session,
		folder: values.folder,
		format,
		jsonOut: values.json && values.json !== "-" ? values.json : undefined,
	};
}

async function collectJsonlFiles(opts: SubagentReportCliOptions): Promise<string[]> {
	if (opts.session) {
		const target = path.resolve(opts.session);
		const stat = await fs.stat(target);
		if (stat.isFile()) {
			const files = [target];
			const siblingDir = target.endsWith(".jsonl") ? target.slice(0, -6) : undefined;
			if (siblingDir) {
				const nested = await listJsonlRecursive(siblingDir).catch(() => [] as string[]);
				files.push(...nested);
			}
			return files;
		}
		return listJsonlRecursive(target);
	}

	const cutoff = Date.now() - opts.sinceMs;
	const files: string[] = [];
	let folders: string[];
	try {
		folders = await fs.readdir(opts.sessionsRoot);
	} catch {
		throw new Error(`sessions root not found: ${opts.sessionsRoot}`);
	}
	for (const folder of folders) {
		if (opts.folder && !folder.includes(opts.folder)) continue;
		const folderPath = path.join(opts.sessionsRoot, folder);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(folderPath, { withFileTypes: true });
		} catch {
			continue;
		}
		const subdirs = new Set<string>();
		const mains = new Map<string, { path: string; mtime: number }>();
		for (const entry of entries) {
			if (entry.isDirectory()) {
				subdirs.add(entry.name);
			} else if (entry.name.endsWith(".jsonl")) {
				const filePath = path.join(folderPath, entry.name);
				const stat = await fs.stat(filePath);
				mains.set(entry.name.slice(0, -6), { path: filePath, mtime: stat.mtimeMs });
			}
		}
		for (const [id, main] of mains) {
			const childPaths: string[] = [];
			let mtime = main.mtime;
			if (subdirs.has(id)) {
				const nested = await listJsonlRecursive(path.join(folderPath, id));
				childPaths.push(...nested);
				for (const childPath of childPaths) {
					const stat = await fs.stat(childPath);
					mtime = Math.max(mtime, stat.mtimeMs);
				}
			}
			if (mtime < cutoff) continue;
			files.push(main.path, ...childPaths);
		}
	}
	return files;
}

async function listJsonlRecursive(dirPath: string): Promise<string[]> {
	const out: string[] = [];
	const nested = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
	for (const entry of nested) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		out.push(path.join(entry.parentPath, entry.name));
	}
	out.sort();
	return out;
}

export async function runSubagentReport(opts: SubagentReportCliOptions): Promise<SubagentBaselineReport> {
	const files = await collectJsonlFiles(opts);
	const sessions: ParsedSession[] = [];
	for (const filePath of files) {
		const text = await Bun.file(filePath).text();
		sessions.push(parseSessionJsonl(text, filePath));
	}
	return buildSubagentBaselineReport(sessions);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const opts = parseSubagentReportCli(argv);
	const report = await runSubagentReport(opts);
	const json = `${JSON.stringify(report, null, 2)}\n`;
	if (opts.jsonOut) await Bun.write(opts.jsonOut, json);
	if (opts.format === "json") process.stdout.write(json);
	else process.stdout.write(`${formatSubagentBaselineReport(report)}\n`);
}

if (import.meta.main) {
	await main();
}
