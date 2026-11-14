/**
 * `omp workflow-bench --help` must dispatch to the workflow-bench command and
 * render its own flags. Unregistered, the argv was rewritten to `launch` and the
 * documented `--case/--variant/--repetitions` flags were rejected (#47).
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { commands, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { run } from "@oh-my-pi/pi-utils/cli";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("workflow-bench is a registered top-level command", () => {
	test("`workflow-bench --help` renders the command's own flags instead of launch help", async () => {
		const resolved = resolveCliArgv(["workflow-bench", "--help"]);
		if ("error" in resolved) throw new Error(resolved.error);

		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			chunks.push(String(chunk));
			return true;
		});
		await run({ bin: "omp", version: "test", argv: resolved.argv, commands });
		const help = chunks.join("");

		expect(resolved.argv[0]).toBe("workflow-bench");
		for (const flag of ["--case", "--variant", "--repetitions", "--mode", "--json"]) {
			expect(help).toContain(flag);
		}
	});
});
