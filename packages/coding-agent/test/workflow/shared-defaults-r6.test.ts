import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_OPTIMIZATION_PROFILES } from "../../src/model-optimization/default-profiles";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { processToolOutputDetailed } from "../../src/workflow/tool-output-manager";

describe("shared truncation behavior (R6)", () => {
	it("keeps the same ERROR line when ordinary and workflow deepseek rules truncate bash", () => {
		const ordinary = DEFAULT_MODEL_OPTIMIZATION_PROFILES.deepseek?.toolStrategy;
		const workflow = DEFAULT_MODEL_PROFILES.deepseek_implementer?.toolStrategy;
		const output = `${"noise\n".repeat(200)}ERROR: shared-sentinel\n${"tail\n".repeat(200)}`;
		const left = processToolOutputDetailed(output, "bash", ordinary);
		const right = processToolOutputDetailed(output, "bash", workflow);
		expect(left.text).toContain("ERROR: shared-sentinel");
		expect(right.text).toContain("ERROR: shared-sentinel");
		expect(left.text.length).toBeLessThan(output.length);
		expect(right.text.length).toBeLessThan(output.length);
	});

	it("applies the configured Sol read clamp without losing the beginning of the file", () => {
		const output = Array.from({ length: 100 }, (_, i) => `${i}: ${String(i).padStart(4, "0").repeat(300)}`).join(
			"\n",
		);
		const sol = processToolOutputDetailed(output, "read", DEFAULT_MODEL_OPTIMIZATION_PROFILES.sol?.toolStrategy);
		const ordinary = processToolOutputDetailed(
			output,
			"read",
			DEFAULT_MODEL_OPTIMIZATION_PROFILES.claude?.toolStrategy,
		);
		expect(sol.text).toContain("0: 0000");
		expect(ordinary.text).toContain("0: 0000");
		expect(Buffer.byteLength(sol.text)).toBeLessThan(Buffer.byteLength(ordinary.text));
	});
});
