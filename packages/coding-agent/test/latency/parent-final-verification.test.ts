import { describe, expect, it } from "bun:test";
import {
	buildParentFinalVerificationDetails,
	criticalPathMsFromIntervals,
	ordinaryVerifierFromParentFinal,
	parseParentFinalVerificationDetails,
	sumChildIntervalMs,
	unionChildIntervalMs,
} from "../../src/latency/parent-final-verification";

describe("parent-final-verification", () => {
	it("parses explicit passed/failed receipts and rejects tool-success-shaped payloads", () => {
		expect(parseParentFinalVerificationDetails({ status: "passed", source: "workflow" })).toEqual({
			status: "passed",
			source: "workflow",
		});
		expect(parseParentFinalVerificationDetails({ status: "failed", source: "fixture", verifiedAtMs: 12 })).toEqual({
			status: "failed",
			source: "fixture",
			verifiedAtMs: 12,
		});
		expect(parseParentFinalVerificationDetails({ status: "completed" })).toBeNull();
		expect(parseParentFinalVerificationDetails({ exitCode: 0 })).toBeNull();
		expect(buildParentFinalVerificationDetails("passed", "extension", 99)).toEqual({
			status: "passed",
			source: "extension",
			verifiedAtMs: 99,
		});
	});

	it("maps receipts to ordinary verifier without turning missing into passed", () => {
		expect(ordinaryVerifierFromParentFinal(null)).toEqual({ source: "unknown", status: "unknown" });
		expect(ordinaryVerifierFromParentFinal({ status: "passed", source: "session_stop", ts: 1 })).toEqual({
			source: "session_stop",
			status: "passed",
		});
		expect(ordinaryVerifierFromParentFinal({ status: "failed", source: "workflow", ts: 1 })).toEqual({
			source: "unknown",
			status: "failed",
		});
	});

	it("keeps parent wall as critical path and refuses to treat parallel child sums as e2e", () => {
		const childIntervals = [
			{ start: 500, end: 1500 },
			{ start: 500, end: 1500 },
		];
		const path = criticalPathMsFromIntervals({
			startTs: 0,
			verifyTs: 3000,
			childIntervals,
		});
		expect(path).toBe(3000);
		expect(sumChildIntervalMs(childIntervals)).toBe(2000);
		expect(unionChildIntervalMs(childIntervals)).toBe(1000);
		expect(path).not.toBe(sumChildIntervalMs(childIntervals));
	});
});
