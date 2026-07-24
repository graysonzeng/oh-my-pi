import { describe, expect, it } from "bun:test";
import { runCliProcess } from "../../src/workflow/cli-process";

describe("runCliProcess", () => {
	it("writes stdin and captures stdout without a shell", async () => {
		const result = await runCliProcess({
			command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
			cwd: process.cwd(),
			stdin: "hello",
			timeoutMs: 5_000,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello");
	});

	it("classifies timeout separately from cancellation", async () => {
		await expect(
			runCliProcess({
				command: [process.execPath, "-e", "await Bun.sleep(5000)"],
				cwd: process.cwd(),
				stdin: "",
				timeoutMs: 50,
			}),
		).rejects.toMatchObject({ kind: "timeout" });
	});

	it("maps missing executable to configuration error", async () => {
		await expect(
			runCliProcess({
				command: ["definitely-missing-omp-cli-xyz"],
				cwd: process.cwd(),
				stdin: "",
				timeoutMs: 1_000,
			}),
		).rejects.toMatchObject({ kind: "configuration" });
	});

	it("maps caller abort to cancelled", async () => {
		const controller = new AbortController();
		const pending = runCliProcess({
			command: [process.execPath, "-e", "await Bun.sleep(5000)"],
			cwd: process.cwd(),
			stdin: "",
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		await Bun.sleep(20);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
	});

	it("rejects already-aborted signal before spawn", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runCliProcess({
				command: [process.execPath, "-e", "console.log(1)"],
				cwd: process.cwd(),
				stdin: "",
				timeoutMs: 1_000,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ kind: "cancelled" });
	});
});
