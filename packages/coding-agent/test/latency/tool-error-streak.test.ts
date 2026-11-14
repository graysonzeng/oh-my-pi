import { describe, expect, it } from "bun:test";
import {
	TOOL_ERROR_STREAK_THRESHOLD,
	clearToolErrorStreak,
	noteToolErrorStreak,
} from "../../src/latency/tool-error-streak";

describe("tool-error-streak", () => {
	it("advises once at the threshold and stays silent afterward until cleared", () => {
		const session = {};
		for (let i = 1; i < TOOL_ERROR_STREAK_THRESHOLD; i++) {
			expect(noteToolErrorStreak(session, "edit", "ENOENT foo")).toBeUndefined();
		}
		const atThreshold = noteToolErrorStreak(session, "edit", "ENOENT foo");
		expect(typeof atThreshold).toBe("string");
		expect(atThreshold && atThreshold.length > 0).toBe(true);
		expect(noteToolErrorStreak(session, "edit", "ENOENT foo")).toBeUndefined();
		clearToolErrorStreak(session);
		expect(noteToolErrorStreak(session, "edit", "ENOENT foo")).toBeUndefined();
	});

	it("resets when the tool or message changes", () => {
		const session = {};
		noteToolErrorStreak(session, "edit", "a");
		noteToolErrorStreak(session, "edit", "a");
		expect(noteToolErrorStreak(session, "bash", "a")).toBeUndefined();
		noteToolErrorStreak(session, "bash", "a");
		expect(typeof noteToolErrorStreak(session, "bash", "a")).toBe("string");
	});
});
