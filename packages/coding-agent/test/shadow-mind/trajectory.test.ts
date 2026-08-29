import { describe, expect, it } from "bun:test";
import { serializeTrajectory } from "@oh-my-pi/pi-coding-agent/shadow-mind/trajectory";

describe("serializeTrajectory", () => {
	it("uses the assignment when the parent transcript is still empty", () => {
		const text = serializeTrajectory([], "review the fixture patch");
		expect(text).toContain("USER: review the fixture patch");
	});

	it("keeps live user messages instead of the assignment fallback", () => {
		const text = serializeTrajectory([{ role: "user", content: "already in session" }], "review the fixture patch");
		expect(text).toContain("USER: already in session");
		expect(text).not.toContain("review the fixture patch");
	});
});
