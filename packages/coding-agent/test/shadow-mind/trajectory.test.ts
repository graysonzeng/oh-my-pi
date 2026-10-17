import { describe, expect, it } from "bun:test";
import { serializeTrajectory } from "@oh-my-pi/pi-coding-agent/shadow-mind/trajectory";

describe("serializeTrajectory", () => {
	it("keeps live user messages instead of the assignment fallback", () => {
		const text = serializeTrajectory([{ role: "user", content: "already in session" }], "review the fixture patch");
		expect(text).toContain("USER: already in session");
		expect(text).not.toContain("review the fixture patch");
	});
});
