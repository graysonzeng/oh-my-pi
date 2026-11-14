import { describe, expect, it } from "bun:test";
import { computeActiveWallMs } from "../../src/latency";

const TEN_MIN_MS = 10 * 60 * 1000;

describe("computeActiveWallMs", () => {
	it("sorts out-of-order timestamps before summing adjacent gaps", () => {
		const t0 = 1_700_000_000_000;
		const t1 = t0 + 2_000;
		const t2 = t1 + 3_000;
		expect(computeActiveWallMs([t2, t0, t1])).toBe(5_000);
	});

	it("counts adjacent gaps of at most 10 minutes and drops larger park gaps", () => {
		const t0 = 1_700_000_000_000;
		const t1 = t0 + TEN_MIN_MS;
		const t2 = t1 + TEN_MIN_MS + 1;
		const t3 = t2 + 4_000;
		expect(computeActiveWallMs([t0, t1, t2, t3])).toBe(TEN_MIN_MS + 4_000);
	});

	it("returns undefined for fewer than two timestamps so callers can exclude the sample", () => {
		expect(computeActiveWallMs([])).toBeUndefined();
		expect(computeActiveWallMs([1_700_000_000_000])).toBeUndefined();
	});
});
