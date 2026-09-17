import { describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { JsDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";

describe("JsRuntime restricted I/O", () => {
	it("hides fs, stubs fetch, routes read/write through tools, and leaves process intact", async () => {
		const runtime = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "restricted-io",
			restrictedIo: true,
		});
		const calls: Array<{ name: string; args: unknown }> = [];
		const hooks: RuntimeHooks = {
			onText: () => {},
			onDisplay: (_output: JsDisplayOutput) => {},
			callTool: async (name, args) => {
				calls.push({ name, args });
				return name === "read" ? "via-tool" : { ok: true };
			},
		};
		try {
			const result = (await runtime.run(
				`(async () => {
					let fetchMessage = "";
					try {
						await fetch("https://example.invalid");
					} catch (error) {
						fetchMessage = String(error instanceof Error ? error.message : error);
					}
					return {
						fs: typeof fs,
						process: typeof process,
						fetchMessage,
						read: await read("secret.txt"),
						write: await write("out.txt", "hi"),
					};
				})()`,
				undefined,
				hooks,
			)) as {
				fs: string;
				process: string;
				fetchMessage: string;
				read: unknown;
				write: unknown;
			};

			expect(result.fs).toBe("undefined");
			expect(result.process).toBe("object");
			expect(result.fetchMessage).toContain("fetch is disabled");
			expect(result.read).toBe("via-tool");
			expect(calls.map(call => call.name)).toEqual(["read", "write"]);
			expect(calls[1]?.args).toEqual({ path: "out.txt", content: "hi" });
		} finally {
			runtime.dispose();
		}
	});

	it("restores host fetch and fs when restricted I/O is turned off", async () => {
		const runtime = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "restricted-io-toggle",
			restrictedIo: true,
		});
		const hooks: RuntimeHooks = {
			onText: () => {},
			onDisplay: () => {},
			callTool: async () => undefined,
		};
		try {
			runtime.setRestrictedIo(false);
			const result = (await runtime.run(`({ fs: typeof fs, fetchType: typeof fetch })`, undefined, hooks)) as {
				fs: string;
				fetchType: string;
			};
			expect(result.fs).toBe("object");
			expect(result.fetchType).toBe("function");
		} finally {
			runtime.dispose();
		}
	});
});
