import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import {
	EDIT_FAILURE_ESCALATION_THRESHOLD,
	clearEditFailureEscalation,
	editPathFromToolArgs,
	formatEditFailureAdvisory,
	markEditFailureEscalated,
	normalizeEditFailurePath,
	noteEditFailureEscalation,
} from "../../src/session/edit-failure-escalation";

describe("edit-failure-escalation", () => {
	const cwd = "/tmp/edit-failure-cwd";

	it("advises re-read at threshold and keeps escalate re-triggerable until marked", () => {
		const session = {};
		expect(noteEditFailureEscalation(session, "src/a.ts", { cwd })).toEqual({
			escalateToTop: false,
			path: path.resolve(cwd, "src/a.ts"),
			count: 1,
		});
		const atThreshold = noteEditFailureEscalation(session, "src/a.ts", { cwd, escalateAvailable: true });
		expect(atThreshold.count).toBe(EDIT_FAILURE_ESCALATION_THRESHOLD);
		expect(atThreshold.escalateToTop).toBe(true);
		expect(atThreshold.advisory).toContain("src/a.ts");
		expect(atThreshold.advisory).toContain("Re-read");
		expect(atThreshold.advisory).toContain("Escalating");
		// Failed apply: further failures stay re-triggerable without re-advising.
		expect(noteEditFailureEscalation(session, "src/a.ts", { cwd }).advisory).toBeUndefined();
		expect(noteEditFailureEscalation(session, "src/a.ts", { cwd }).escalateToTop).toBe(true);
		markEditFailureEscalated(session, "src/a.ts", cwd);
		expect(noteEditFailureEscalation(session, "src/a.ts", { cwd }).escalateToTop).toBe(false);
	});

	it("omits Escalating when escalateAvailable is false", () => {
		const session = {};
		noteEditFailureEscalation(session, "b.ts", { cwd });
		const atThreshold = noteEditFailureEscalation(session, "b.ts", { cwd, escalateAvailable: false });
		expect(atThreshold.escalateToTop).toBe(true);
		expect(atThreshold.advisory).toContain("Re-read");
		expect(atThreshold.advisory).not.toContain("Escalating");
	});

	it("tracks paths independently and clears on success", () => {
		const session = {};
		noteEditFailureEscalation(session, "a.ts", { cwd });
		noteEditFailureEscalation(session, "b.ts", { cwd });
		expect(noteEditFailureEscalation(session, "a.ts", { cwd }).escalateToTop).toBe(true);
		expect(noteEditFailureEscalation(session, "b.ts", { cwd }).escalateToTop).toBe(true);
		clearEditFailureEscalation(session, "a.ts", cwd);
		expect(noteEditFailureEscalation(session, "a.ts", { cwd }).count).toBe(1);
		expect(noteEditFailureEscalation(session, "b.ts", { cwd }).advisory).toBeUndefined();
	});

	it("normalizes relative and absolute paths via path.resolve(cwd)", () => {
		expect(normalizeEditFailurePath("src/x.ts", cwd)).toBe(path.resolve(cwd, "src/x.ts"));
		expect(normalizeEditFailurePath(path.resolve(cwd, "src/x.ts"), cwd)).toBe(path.resolve(cwd, "src/x.ts"));
		const session = {};
		noteEditFailureEscalation(session, "src/x.ts", { cwd });
		const second = noteEditFailureEscalation(session, path.resolve(cwd, "src/x.ts"), { cwd });
		expect(second.count).toBe(2);
		expect(second.escalateToTop).toBe(true);
	});

	it("reads path from edit tool args including edits[] batches", () => {
		expect(editPathFromToolArgs({ path: "foo.ts" }, cwd)).toBe(path.resolve(cwd, "foo.ts"));
		expect(editPathFromToolArgs({ file_path: "bar.ts" }, cwd)).toBe(path.resolve(cwd, "bar.ts"));
		expect(editPathFromToolArgs({ edits: [{ path: "batch.ts" }] }, cwd)).toBe(path.resolve(cwd, "batch.ts"));
		expect(editPathFromToolArgs({ edits: [{}] }, cwd)).toBeUndefined();
	});

	it("formatEditFailureAdvisory toggles the Escalating clause", () => {
		expect(formatEditFailureAdvisory("p.ts", 2, false)).not.toContain("Escalating");
		expect(formatEditFailureAdvisory("p.ts", 2, true)).toContain("Escalating");
	});
});
