/**
 * Shared presentation classifier contract: skipped vs started-aborted vs
 * executed failure vs success. Every presentation surface keys off this
 * classifier, never raw `isError` or English text.
 */
import { describe, expect, it } from "bun:test";
import {
	classifyToolPresentation,
	isSkippedSyntheticResult,
	isStartedAbortedResult,
	toolPresentationLabel,
} from "@oh-my-pi/pi-coding-agent/presentation/tool-status";

function result(details: unknown, isError = false): { details?: unknown; isError?: boolean } {
	return { details, isError };
}

describe("classifyToolPresentation", () => {
	it("classifies a never-invoked synthetic skip as skipped even when error-shaped", () => {
		const r = result({ __synthetic: true, source: "prestart_queued_steering", executed: false }, true);
		expect(classifyToolPresentation(r)).toBe("skipped");
		expect(isSkippedSyntheticResult(r)).toBe(true);
	});

	it("classifies pre-start budget/user/system/irc variants as skipped", () => {
		const sources = ["prestart_budget", "prestart_user_cancel", "prestart_system_cancel", "prestart_irc_cancel"];
		for (const source of sources) {
			expect(classifyToolPresentation(result({ __synthetic: true, source, executed: false }, true))).toBe("skipped");
		}
	});

	it("classifies a started-abort as aborted, never skipped", () => {
		for (const source of [
			"started_aborted_user",
			"started_aborted_system",
			"started_aborted_irc",
			"started_aborted_external",
		]) {
			const r = result({ __synthetic: true, source, executed: true }, true);
			expect(classifyToolPresentation(r)).toBe("aborted");
			expect(isSkippedSyntheticResult(r)).toBe(false);
			expect(isStartedAbortedResult(r)).toBe(true);
		}
	});

	it("classifies an executed error as failed", () => {
		expect(classifyToolPresentation(result({ some: "detail" }, true))).toBe("failed");
		expect(classifyToolPresentation(result(undefined, true))).toBe("failed");
	});

	it("classifies a success as succeeded", () => {
		expect(classifyToolPresentation(result({ some: "detail" }, false))).toBe("succeeded");
		expect(classifyToolPresentation(result(undefined))).toBe("succeeded");
	});

	it("never classifies error-shaped legacy results as skipped without the marker", () => {
		expect(classifyToolPresentation(result(undefined, true))).toBe("failed");
	});

	it("labels skipped/aborted states for optional source display", () => {
		expect(toolPresentationLabel("skipped", "prestart_budget")).toContain("budget");
		expect(toolPresentationLabel("aborted", "started_aborted_irc")).toContain("interrupt");
		expect(toolPresentationLabel("skipped")).toBe("skipped");
	});
});
