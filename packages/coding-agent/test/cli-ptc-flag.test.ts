import { describe, expect, test } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --ptc flag", () => {
	test("accepts off, on, and auto", () => {
		expect(parseArgs(["--ptc", "off"]).ptc).toBe("off");
		expect(parseArgs(["--ptc", "on"]).ptc).toBe("on");
		expect(parseArgs(["--ptc=auto"]).ptc).toBe("auto");
	});

	test("ignores invalid values instead of treating them as a prompt", () => {
		const result = parseArgs(["--ptc", "bogus", "hello"]);
		expect(result.ptc).toBeUndefined();
		expect(result.messages).toEqual(["hello"]);
	});
});
