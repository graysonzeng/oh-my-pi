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

	it("defers cross-runtime setRestrictedIo until this runtime can own the realm", async () => {
		const first = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "restricted-io-first",
		});
		const second = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "restricted-io-second",
		});
		const hooks: RuntimeHooks = {
			onText: () => {},
			onDisplay: () => {},
			callTool: async () => undefined,
		};
		const gate = Promise.withResolvers<void>();
		let hold: Promise<unknown> | undefined;
		try {
			second.setRunScope({ gate: gate.promise });
			hold = second.run("await gate;", undefined, hooks);
			expect(() => first.setRestrictedIo(true)).not.toThrow();
			expect((globalThis as Record<string, unknown>).__omp_helpers__).toBe(second.helpers);
			await first.run("1", undefined, hooks).then(
				() => {
					throw new Error("expected active runtime rejection");
				},
				error =>
					expect(error).toHaveProperty(
						"message",
						"Cannot run code while another same-realm JS runtime is running",
					),
			);
			gate.resolve();
			await hold;
			const result = (await first.run(`typeof fs`, undefined, hooks)) as string;
			expect(result).toBe("undefined");
		} finally {
			gate.resolve();
			if (hold) await hold.catch(() => undefined);
			first.dispose();
			second.dispose();
		}
	});

	it("does not leave a later unrestricted runtime on the previous restricted fetch", async () => {
		const restricted = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "restricted-first",
			restrictedIo: true,
		});
		const hooks: RuntimeHooks = {
			onText: () => {},
			onDisplay: () => {},
			callTool: async () => undefined,
		};
		try {
			await restricted.run(`typeof fs`, undefined, hooks);
			restricted.dispose();
			const open = new JsRuntime({
				initialCwd: process.cwd(),
				sessionId: "unrestricted-second",
				restrictedIo: false,
			});
			try {
				const result = (await open.run(
					`(async () => {
						let fetchType = typeof fetch;
						let fetchOk = false;
						try { await fetch("http://127.0.0.1"); fetchOk = true; } catch (error) {
							fetchOk = !(error instanceof Error && error.message.includes("fetch is disabled"));
						}
						return { fs: typeof fs, fetchType, fetchOk };
					})()`,
					undefined,
					hooks,
				)) as { fs: string; fetchType: string; fetchOk: boolean };
				expect(result.fs).toBe("object");
				expect(result.fetchType).toBe("function");
				expect(result.fetchOk).toBe(true);
			} finally {
				open.dispose();
			}
		} finally {
			restricted.dispose();
		}
	});

	it("keeps overlapping cells on the I/O policy snapshotted at run start", async () => {
		const runtime = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "overlap-io",
			restrictedIo: true,
		});
		const hooks: RuntimeHooks = {
			onText: () => {},
			onDisplay: () => {},
			callTool: async () => undefined,
		};
		const gate = Promise.withResolvers<void>();
		try {
			runtime.setRunScope({ gate: gate.promise });
			const first = runtime.run(`(async () => { await gate; return { fs: typeof fs }; })()`, undefined, hooks);
			runtime.setRestrictedIo(false);
			const second = (await runtime.run(`({ fs: typeof fs })`, undefined, hooks)) as { fs: string };
			expect(second.fs).toBe("object");
			gate.resolve();
			const firstResult = (await first) as { fs: string };
			expect(firstResult.fs).toBe("undefined");
		} finally {
			gate.resolve();
			runtime.dispose();
		}
	});
});
