import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { sha256Hex } from "../../src/latency/stable-serialize";
import type { PairedExperiment } from "./product-latency-paired";

export const PAIRED_FIXTURE_PATH = "packages/coding-agent/test/task/product-latency-fixture.ts";
const SOURCE_DELTAS: Record<PairedExperiment, readonly string[]> = {
	advisories: ["packages/coding-agent/src/tools/read.ts", "packages/coding-agent/src/session/agent-session.ts"],
	"sonic-effort": ["packages/coding-agent/src/task/agents.ts"],
};

export interface QualificationSourceSnapshot {
	root: string;
	fingerprint: string;
	files: Record<string, string>;
}

/** Hash runtime sources/assets and the shared harness, not credentials or local evidence. */
export async function captureQualificationSource(root: string): Promise<QualificationSourceSnapshot> {
	root = await fs.realpath(root);
	const entries: Array<[string, string]> = [];
	const addFile = async (relative: string) => {
		const file = path.join(root, relative);
		if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`source symlink is not isolated: ${relative}`);
		entries.push([relative, new Bun.CryptoHasher("sha256").update(await Bun.file(file).bytes()).digest("hex")]);
	};
	const addOptionalConfig = async (relative: string) => {
		try {
			await addFile(relative);
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
	};
	const walk = async (relative: string): Promise<void> => {
		for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const child = `${relative}/${entry.name}`;
			if (entry.isSymbolicLink()) throw new Error(`source symlink is not isolated: ${child}`);
			if (entry.isDirectory()) await walk(child);
			else if (entry.isFile()) await addFile(child);
		}
	};
	await addFile("package.json");
	await addFile("bun.lock");
	for (const config of ["tsconfig.json", "tsconfig.base.json", "bunfig.toml"]) await addOptionalConfig(config);
	for (const entry of await fs.readdir(path.join(root, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const base = `packages/${entry.name}`;
		await addFile(`${base}/package.json`);
		for (const config of ["tsconfig.json", "bunfig.toml"]) await addOptionalConfig(`${base}/${config}`);
		for (const directory of ["src", "native"]) {
			const stat = await fs.lstat(path.join(root, base, directory)).catch(error => {
				if (isEnoent(error)) return undefined;
				throw error;
			});
			if (!stat) continue;
			if (!stat.isDirectory()) throw new Error(`runtime directory is not isolated: ${base}/${directory}`);
			await walk(`${base}/${directory}`);
		}
	}
	const fixtureDir = "packages/coding-agent/test/task";
	for (const entry of await fs.readdir(path.join(root, fixtureDir))) {
		if (entry.startsWith("product-latency-") && /\.(?:ts|md)$/.test(entry)) await addFile(`${fixtureDir}/${entry}`);
	}
	for (const required of [PAIRED_FIXTURE_PATH, ...Object.values(SOURCE_DELTAS).flat()]) {
		if (!entries.some(([file]) => file === required)) throw new Error(`missing required source: ${required}`);
	}
	entries.sort(([left], [right]) => left.localeCompare(right));
	return { root, fingerprint: sha256Hex(JSON.stringify(entries)), files: Object.fromEntries(entries) };
}

export function assertQualificationSourcePair(
	control: QualificationSourceSnapshot,
	treatment: QualificationSourceSnapshot,
	experiment: PairedExperiment,
): string[] {
	if (control.root === treatment.root) throw new Error("paired arms require distinct source roots");
	const allowed = SOURCE_DELTAS[experiment];
	const differences: string[] = [];
	for (const file of new Set([...Object.keys(control.files), ...Object.keys(treatment.files)])) {
		if (control.files[file] === treatment.files[file]) continue;
		if (!control.files[file] || !treatment.files[file] || !allowed.includes(file)) {
			throw new Error(`undeclared ${experiment} source difference: ${file}`);
		}
		differences.push(file);
	}
	if (differences.length === 0) throw new Error("paired sources contain no experiment difference");
	return differences.sort();
}
