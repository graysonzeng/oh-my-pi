import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$envExact,
	filterChildShellEnv,
	filterProcessEnv,
	getDbBusyTimeoutMs,
	parseEnvFile,
	setInteractiveHost,
} from "@oh-my-pi/pi-utils/env";

const tempDirs: string[] = [];
const runtimeProbePath = path.join(import.meta.dir, "fixtures", "test-runtime-probe.ts");

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

function writeTempEnv(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-"));
	tempDirs.push(dir);
	const filePath = path.join(dir, ".env");
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("getDbBusyTimeoutMs", () => {
	it("defaults to the bounded headless timeout", () => {
		const previous = setInteractiveHost(false);
		try {
			expect(getDbBusyTimeoutMs()).toBe(1000);
		} finally {
			setInteractiveHost(previous);
		}
	});

	it("keeps the interactive timeout for interactive hosts", () => {
		const previous = setInteractiveHost(true);
		try {
			expect(getDbBusyTimeoutMs()).toBe(5000);
		} finally {
			setInteractiveHost(previous);
		}
	});
});
async function runRuntimeProbe(
	env: Record<string, string | undefined>,
	probePath = runtimeProbePath,
): Promise<boolean> {
	const cwd = path.dirname(writeTempEnv(""));
	const proc = Bun.spawn([process.execPath, probePath], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as boolean;
}

describe("parseEnvFile", () => {
	it("ignores malformed names and nul-containing values", () => {
		const filePath = writeTempEnv(
			[
				"GOOD=value",
				"_ALSO_GOOD='quoted value'",
				"1BAD=value",
				"BAD-NAME=value",
				"BAD NAME=value",
				"BAD_VALUE=before\0after",
				"# comment",
				"NO_EQUALS",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			GOOD: "value",
			_ALSO_GOOD: "quoted value",
		});
	});

	it("mirrors valid OMP_ variables to PI_ variables", () => {
		const filePath = writeTempEnv("OMP_FEATURE=enabled\nOMP_BAD=before\0after\n");

		expect(parseEnvFile(filePath)).toEqual({
			OMP_FEATURE: "enabled",
			PI_FEATURE: "enabled",
		});
	});

	it("matches Bun dotenv syntax for export prefixes and inline comments", () => {
		const filePath = writeTempEnv(
			[
				"export EXPORTED=value",
				"COMMENTED=secret # trailing comment",
				'QUOTED_HASH="keep # this"',
				"NO_SPACE=http://host/path#frag",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			EXPORTED: "value",
			COMMENTED: "secret",
			QUOTED_HASH: "keep # this",
			NO_SPACE: "http://host/path#frag",
		});
	});

	it("keeps escaped quotes inside quoted values literal, matching Bun", () => {
		const filePath = writeTempEnv(['JSON="{\\"a\\":1}"', "SINGLE='it\\'s'"].join("\n"));

		expect(parseEnvFile(filePath)).toEqual({
			JSON: '{\\"a\\":1}',
			SINGLE: "it\\'s",
		});
	});
});

describe("filterProcessEnv", () => {
	it("drops entries that cannot be passed to process spawn env", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				EMPTY: "",
				"BAD=NAME": "value",
				BAD_VALUE: "before\0after",
				MISSING: undefined,
			}),
		).toEqual({
			GOOD: "value",
			EMPTY: "",
		});
	});

	it("drops macOS malloc stack logging toggles instead of forwarding disabled values", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				MallocStackLogging: "0",
				MallocStackLoggingNoCompact: "0",
			}),
		).toEqual({
			GOOD: "value",
		});
	});

	it("preserves Windows-style variable names containing parentheses", () => {
		// `ProgramFiles(x86)` and friends are standard on Windows and must
		// survive the scrub so Git Bash discovery in procmgr.ts can resolve
		// 32-bit Program Files installations.
		expect(
			filterProcessEnv({
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
			}),
		).toEqual({
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
		});
	});
});

describe("filterChildShellEnv", () => {
	// filterChildShellEnv resolves the mode-local dotenv name from the *launch*
	// NODE_ENV (on Linux, /proc/self/environ — e.g. `test` inside a parallel
	// bun-test worker), so the fixture must target that same mode instead of
	// assuming `development`.
	function launchDotenvMode(): string {
		if (process.platform === "linux") {
			const procEnv = fs.readFileSync("/proc/self/environ", "utf8");
			const match = procEnv.match(/(?:^|\0)NODE_ENV=([^\0]*)/);
			if (match?.[1]) return match[1];
		}
		return process.env.NODE_ENV || "development";
	}

	it("removes secrets loaded from .env.${NODE_ENV}.local mode-local files", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-mode-local-"));
		tempDirs.push(dir);
		const mode = launchDotenvMode();
		fs.writeFileSync(path.join(dir, `.env.${mode}.local`), "MODE_LOCAL_SECRET=super-secret-value\n");
		const filtered = filterChildShellEnv(
			{
				NODE_ENV: mode,
				MODE_LOCAL_SECRET: "super-secret-value",
				KEEP_ME: "yes",
			},
			dir,
		);
		expect(filtered.MODE_LOCAL_SECRET).toBeUndefined();
		expect(filtered.KEEP_ME).toBe("yes");
	});

	it("removes secrets from dotenv mode files selected at launch", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-mode-"));
		tempDirs.push(dir);
		const mode = launchDotenvMode();
		fs.writeFileSync(path.join(dir, `.env.${mode}`), "MODE_SECRET=super-secret-value\n");
		const filtered = filterChildShellEnv(
			{ NODE_ENV: mode, MODE_SECRET: "super-secret-value", KEEP_ME: "yes" },
			dir,
		);
		expect(filtered.MODE_SECRET).toBeUndefined();
		expect(filtered.KEEP_ME).toBe("yes");
	});

	describe("getDbBusyTimeoutMs", () => {
		it("uses default when environment value is invalid", () => {
			expect(getDbBusyTimeoutMs({ PI_DB_BUSY_TIMEOUT_MS: "invalid" })).toBe(5_000);
		});

		it("uses valid positive millisecond value", () => {
			expect(getDbBusyTimeoutMs({ PI_DB_BUSY_TIMEOUT_MS: "250" })).toBe(250);
		});
	});

	describe("setInteractiveHost", () => {
		it("makes worker runtime probe report interactive host", () => {
			setInteractiveHost(true);
			const result = Bun.spawnSync([process.execPath, runtimeProbePath]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString().trim()).toBe("interactive");
		});
	});

	describe("$envExact", () => {
		function windowsLikeEnv(values: Record<string, string>): Record<string, string> {
			return new Proxy(values, {
				get(target, property) {
					if (typeof property !== "string") return Reflect.get(target, property);
					const key = Object.keys(target).find((candidate) => candidate.toLowerCase() === property.toLowerCase());
					return key === undefined ? undefined : target[key];
				},
				has(target, property) {
					if (typeof property !== "string") return Reflect.has(target, property);
					return Object.keys(target).some((candidate) => candidate.toLowerCase() === property.toLowerCase());
				},
			});
		}

		it("does not resolve wrong-case references on a case-insensitive env", () => {
			const env = windowsLikeEnv({ PUBLIC: "C:\\Users\\Public" });
			expect(env.public).toBe("C:\\Users\\Public");
			expect($envExact("public", env)).toBeUndefined();
		});

		it("still resolves a genuine exact-case reference on a case-insensitive env", () => {
			const env = windowsLikeEnv({ MY_KEY: "secret" });
			expect($envExact("MY_KEY", env)).toBe("secret");
			expect($envExact("my_key", env)).toBeUndefined();
		});

		it("reads process.env by default", () => {
			const name = `PI_ENVEXACT_TEST_${Date.now()}`;
			process.env[name] = "value";
			try {
				expect($envExact(name)).toBe("value");
			} finally {
				delete process.env[name];
			}
			expect($envExact(name)).toBeUndefined();
		});
	});
});
