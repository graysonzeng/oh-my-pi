import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ContextBuilder } from "../../src/workflow/context-builder";
import {
	buildRepoMap,
	extractSymbolsFromSource,
	type RepoMapEntry,
	rankEntries,
	renderRepoMap,
} from "../../src/workflow/repo-map-builder";

const tmpDirs: string[] = [];

afterEach(async () => {
	for (const d of tmpDirs.splice(0)) {
		await fs.rm(d, { recursive: true, force: true });
	}
});

describe("extractSymbolsFromSource", () => {
	it("extracts TS functions, classes, and interfaces", () => {
		const src = `
export function hello(name: string) {}
export class Foo {}
export interface Bar { x: number }
export type Baz = string;
const helper = (a: number) => a;
`;
		const symbols = extractSymbolsFromSource(src, ".ts");
		const names = symbols.map(s => s.name);
		expect(names).toContain("hello");
		expect(names).toContain("Foo");
		expect(names).toContain("Bar");
		expect(names).toContain("Baz");
	});

	it("extracts Python defs and classes", () => {
		const src = `
def run(x):
    return x

class Worker:
    pass
`;
		const symbols = extractSymbolsFromSource(src, ".py");
		expect(symbols.map(s => s.name)).toEqual(expect.arrayContaining(["run", "Worker"]));
	});
});

describe("renderRepoMap + rankEntries", () => {
	const entries: RepoMapEntry[] = [
		{ path: "src/core.ts", symbols: [{ name: "main", type: "function", line: 1 }], importance: 0 },
		{ path: "src/util.ts", symbols: [], importance: 0 },
		{
			path: "pkg/a.ts",
			symbols: [
				{ name: "A", type: "class", line: 2 },
				{ name: "b", type: "function", line: 5 },
			],
			importance: 0,
		},
		{ path: "pkg/b.ts", symbols: [{ name: "B", type: "class", line: 1 }], importance: 0 },
	];

	it("boosts relevant files in ranking", () => {
		const ranked = rankEntries(entries, new Set(["src/util.ts"]));
		expect(ranked[0]?.path).toBe("src/util.ts");
	});

	it("symbols-only includes signatures", () => {
		const text = renderRepoMap(
			[{ path: "a.ts", symbols: [{ name: "f", type: "function", line: 3, signature: "f()" }], importance: 1 }],
			"symbols-only",
		);
		expect(text).toContain("a.ts");
		expect(text).toContain("function f()");
	});

	it("hybrid marks top files for full read", () => {
		const text = renderRepoMap(
			entries.map((e, i) => ({ ...e, importance: 1 - i * 0.1 })),
			"hybrid",
		);
		expect(text).toContain("priority");
	});
});

describe("buildRepoMap", () => {
	it("scans a fixture tree and returns non-empty map", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-map-"));
		tmpDirs.push(dir);
		await fs.mkdir(path.join(dir, "src"), { recursive: true });
		await Bun.write(path.join(dir, "src", "app.ts"), `export function runApp() {}\nexport class App {}\n`);
		await Bun.write(path.join(dir, "src", "util.ts"), `export function helper() {}\n`);

		const map = await buildRepoMap({
			cwd: dir,
			relevantFiles: ["src/app.ts"],
			maxFiles: 5,
			strategy: "symbols-only",
		});
		expect(map).toContain("app.ts");
		expect(map).toMatch(/runApp|App|function/);
	});

	it("accepts precomputed entries without walking", async () => {
		const map = await buildRepoMap({
			cwd: "/unused",
			entries: [{ path: "x.ts", symbols: [{ name: "z", type: "function", line: 1 }], importance: 0 }],
			strategy: "full-content",
		});
		expect(map.trim()).toBe("x.ts");
	});
});

describe("ContextBuilder.appendRepoMapIfEnabled", () => {
	it("appends repo map when contextStrategy.repoMap.enabled", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-map-ctx-"));
		tmpDirs.push(dir);
		await fs.mkdir(path.join(dir, "src"), { recursive: true });
		await Bun.write(path.join(dir, "src", "main.ts"), `export function main() {}\n`);

		const builder = new ContextBuilder();
		const base = "Plan context body";
		const withMap = await builder.appendRepoMapIfEnabled(base, {
			cwd: dir,
			contextStrategy: {
				targetUtilization: 0.7,
				repoMap: { enabled: true, maxFiles: 5, strategy: "symbols-only" },
			},
			relevantFiles: ["src/main.ts"],
		});
		expect(withMap).toContain("Plan context body");
		expect(withMap).toMatch(/## Repo map/);
		expect(withMap).toContain("main.ts");

		const disabled = await builder.appendRepoMapIfEnabled(base, {
			cwd: dir,
			contextStrategy: {
				targetUtilization: 0.7,
				repoMap: { enabled: false, maxFiles: 5, strategy: "symbols-only" },
			},
		});
		expect(disabled).toBe(base);
	});
});
