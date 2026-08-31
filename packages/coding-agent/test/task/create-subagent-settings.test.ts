import { describe, expect, it } from "bun:test";
import { serviceTierForAllFamilies } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

describe("serviceTierForAllFamilies", () => {
	it("broadcasts priority onto xai and omits xai for flex", () => {
		expect(serviceTierForAllFamilies("priority").xai).toBe("priority");
		expect(serviceTierForAllFamilies("flex").xai).toBeUndefined();
	});
});

describe("createSubagentSettings stamps tier.xai", () => {
	it("broadcasts subagent priority onto tier.xai", () => {
		const parent = Settings.isolated({
			"tier.xai": "none",
			"tier.subagent": "priority",
		});
		const child = createSubagentSettings(parent);
		expect(child.get("tier.xai")).toBe("priority");
	});

	it("does not leak parent tier.xai when subagent broadcasts flex", () => {
		const parent = Settings.isolated({
			"tier.xai": "priority",
			"tier.subagent": "flex",
		});
		const child = createSubagentSettings(parent);
		expect(child.get("tier.xai")).toBe("none");
	});

	it("inherits parent tier.xai when subagent is inherit and no live map is supplied", () => {
		const parent = Settings.isolated({
			"tier.xai": "priority",
			"tier.subagent": "inherit",
		});
		const child = createSubagentSettings(parent);
		expect(child.get("tier.xai")).toBe("priority");
	});
});

describe("createSubagentSettings read summary precedence", () => {
	it("preserves a parent disable when the agent does not force false", () => {
		const parent = Settings.isolated({ "read.summarize.enabled": false });
		const child = createSubagentSettings(parent);
		expect(child.get("read.summarize.enabled")).toBe(false);
	});

	it("lets an explicit false-only agent override disable a parent default", () => {
		const parent = Settings.isolated({ "read.summarize.enabled": true });
		const child = createSubagentSettings(parent, { "read.summarize.enabled": false });
		expect(child.get("read.summarize.enabled")).toBe(false);
	});
});
