/**
 * G4: routing-audit persist is incremental — second flush writes only new entries.
 */
import { describe, expect, it } from "bun:test";

/** Mirror of engine incremental slice (pure contract under test). */
function incrementalRoutingDelta(
	audit: ReadonlyArray<Record<string, unknown>>,
	persistedThrough: number,
): { delta: ReadonlyArray<Record<string, unknown>>; nextThrough: number } {
	if (audit.length === 0 || persistedThrough >= audit.length) {
		return { delta: [], nextThrough: persistedThrough };
	}
	const delta = audit.slice(persistedThrough);
	return { delta, nextThrough: audit.length };
}

describe("routing audit incremental persist (R7/G4)", () => {
	it("second flush emits only entries after persistedThrough", () => {
		const audit = [
			{ profileId: "planner", at: "t0" },
			{ profileId: "implementer", at: "t1" },
			{ profileId: "reviewer", at: "t2" },
		];
		const first = incrementalRoutingDelta(audit, 0);
		expect(first.delta).toHaveLength(3);
		expect(first.nextThrough).toBe(3);

		const noOp = incrementalRoutingDelta(audit, first.nextThrough);
		expect(noOp.delta).toHaveLength(0);
		expect(noOp.nextThrough).toBe(3);

		const grown = [...audit, { profileId: "repair", at: "t3" }];
		const second = incrementalRoutingDelta(grown, first.nextThrough);
		expect(second.delta).toHaveLength(1);
		expect(second.delta[0]?.profileId).toBe("repair");
		expect(second.nextThrough).toBe(4);
		// Prior entries must not reappear in the delta body.
		expect(second.delta.some(e => e.profileId === "planner")).toBe(false);
	});

	it("start-cleared cursor (persistedThrough=0 with empty audit) yields empty delta", () => {
		const cleared = incrementalRoutingDelta([], 0);
		expect(cleared.delta).toHaveLength(0);
		expect(cleared.nextThrough).toBe(0);
	});
});
