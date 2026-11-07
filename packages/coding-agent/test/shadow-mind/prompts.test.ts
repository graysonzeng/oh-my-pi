import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";

describe("shadow-review prompts", () => {
	it("bundled reviewer tells the model to consume evidence without waiting", () => {
		const reviewer = getBundledAgent("reviewer");
		expect(reviewer?.shadowReview).toBe("code");
		expect(reviewer?.systemPrompt).toMatch(/shadow-review/i);
		expect(reviewer?.systemPrompt).toMatch(/Never wait for a shadow-review report/);
		expect(reviewer?.systemPrompt).toMatch(/If no such message arrives, finish the review on your own/);
	});

	it("sol-xhigh-reviewer keeps the four-value design schema and does not wait", () => {
		const text = fs.readFileSync(path.join(import.meta.dir, "../../../../.omp/agents/sol-xhigh-reviewer.md"), "utf8");
		expect(text).toMatch(/PASS \/ PASS_WITH_NOTES \/ NEEDS_REVISION \/ NEEDS_REDESIGN/);
		expect(text).toMatch(/shadowReview: "code"/);
		expect(text).toMatch(/Never wait for it/);
		expect(text).not.toMatch(/^shadow-review:/m);
	});
});
