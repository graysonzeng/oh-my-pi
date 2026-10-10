import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — consult flags", () => {
	it("parses --consult as a boolean flag", () => {
		const result = parseArgs(["--consult"]);
		expect(result.consult).toBe(true);
	});

	it("parses --consult-model and implies --consult", () => {
		const result = parseArgs(["--consult-model", "openai/o3"]);
		expect(result.consultModel).toBe("openai/o3");
		expect(result.consult).toBe(true);
	});

	it("does not consume a value after --consult", () => {
		const result = parseArgs(["--consult", "--model", "opus"]);
		expect(result.consult).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual([]);
	});
});
