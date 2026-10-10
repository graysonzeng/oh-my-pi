import { describe, expect, it } from "bun:test";
import {
	EDIT_FAILURE_ESCALATION_THRESHOLD,
	clearEditFailureEscalation,
	editPathFromToolArgs,
	noteEditFailureEscalation,
} from "../../src/session/edit-failure-escalation";

describe("edit-failure-escalation", () => {
	it("advises re-read and escalates once at two failures on the same path", () => {
		const session = {};
		expect(noteEditFailureEscalation(session, "src/a.ts")).toEqual({
			escalateToTop: false,
			path: "src/a.ts",
			count: 1,
		});
		const atThreshold = noteEditFailureEscalation(session, "src/a.ts");
		expect(atThreshold.count).toBe(EDIT_FAILURE_ESCALATION_THRESHOLD);
		expect(atThreshold.escalateToTop).toBe(true);
		expect(atThreshold.advisory).toContain("src/a.ts");
		expect(atThreshold.advisory).toContain("Re-read");
		// Further failures stay silent until cleared.
		expect(noteEditFailureEscalation(session, "src/a.ts").advisory).toBeUndefined();
		expect(noteEditFailureEscalation(session, "src/a.ts").escalateToTop).toBe(false);
	});

	it("tracks paths independently and clears on success", () => {
		const session = {};
		noteEditFailureEscalation(session, "a.ts");
		noteEditFailureEscalation(session, "b.ts");
		expect(noteEditFailureEscalation(session, "a.ts").escalateToTop).toBe(true);
		expect(noteEditFailureEscalation(session, "b.ts").escalateToTop).toBe(true);
		clearEditFailureEscalation(session, "a.ts");
		expect(noteEditFailureEscalation(session, "a.ts").count).toBe(1);
		expect(noteEditFailureEscalation(session, "b.ts").advisory).toBeUndefined();
	});

	it("reads path from edit tool args including edits[] batches", () => {
		expect(editPathFromToolArgs({ path: "foo.ts" })).toBe("foo.ts");
		expect(editPathFromToolArgs({ file_path: "bar.ts" })).toBe("bar.ts");
		expect(editPathFromToolArgs({ edits: [{ path: "batch.ts" }] })).toBe("batch.ts");
		expect(editPathFromToolArgs({ edits: [{}] })).toBeUndefined();
	});
});
