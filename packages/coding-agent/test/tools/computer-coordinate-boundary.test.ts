/**
 * D7 computer-use boundary fixtures — coordinate / frame contracts.
 *
 * Validates documented mapping rules without claiming live platform coverage.
 * Native InvalidCoordinateFrame before capture is already covered in
 * packages/natives/test/desktop.test.ts. read_only is NOT a host sandbox.
 */
import { describe, expect, it } from "bun:test";

/** Model-visible frame geometry (what the model actually sees). */
export interface ModelFrameGeometry {
	width: number;
	height: number;
	/** Display scale (Retina = 2). */
	scale: number;
	/** Origin of this frame in desktop virtual coords (may be negative on multi-monitor). */
	originX: number;
	originY: number;
}

export interface MappedPoint {
	desktopX: number;
	desktopY: number;
}

export type MapPointResult =
	| { ok: true; point: MappedPoint }
	| { ok: false; reason: "stale_frame" | "out_of_bounds" | "no_frame" };

/**
 * Map model-image pixel coords onto desktop coords using the frame the model saw.
 * Rejects stale / missing frames and out-of-bounds pixels — never silently reuse.
 */
export function mapModelPointToDesktop(
	frame: ModelFrameGeometry | null,
	imageX: number,
	imageY: number,
	options?: { frameGeneration?: number; expectedGeneration?: number },
): MapPointResult {
	if (!frame) return { ok: false, reason: "no_frame" };
	if (
		options?.frameGeneration !== undefined &&
		options.expectedGeneration !== undefined &&
		options.frameGeneration !== options.expectedGeneration
	) {
		return { ok: false, reason: "stale_frame" };
	}
	if (imageX < 0 || imageY < 0 || imageX >= frame.width || imageY >= frame.height) {
		return { ok: false, reason: "out_of_bounds" };
	}
	return {
		ok: true,
		point: {
			desktopX: frame.originX + imageX * frame.scale,
			desktopY: frame.originY + imageY * frame.scale,
		},
	};
}

describe("computer coordinate boundary fixtures (D7)", () => {
	it("maps Retina-scaled points from the model-visible frame, not a raw capture size", () => {
		const frame: ModelFrameGeometry = { width: 1280, height: 800, scale: 2, originX: 0, originY: 0 };
		const mapped = mapModelPointToDesktop(frame, 100, 50);
		expect(mapped.ok).toBe(true);
		if (mapped.ok) {
			expect(mapped.point.desktopX).toBe(200);
			expect(mapped.point.desktopY).toBe(100);
		}
	});

	it("supports negative multi-monitor origins", () => {
		const frame: ModelFrameGeometry = { width: 800, height: 600, scale: 1, originX: -1920, originY: 0 };
		const mapped = mapModelPointToDesktop(frame, 10, 20);
		expect(mapped.ok).toBe(true);
		if (mapped.ok) {
			expect(mapped.point.desktopX).toBe(-1910);
			expect(mapped.point.desktopY).toBe(20);
		}
	});

	it("rejects out-of-bounds and stale frames instead of reusing last coordinates", () => {
		const frame: ModelFrameGeometry = { width: 100, height: 100, scale: 1, originX: 0, originY: 0 };
		expect(mapModelPointToDesktop(frame, 100, 0).ok).toBe(false);
		expect(mapModelPointToDesktop(null, 1, 1)).toEqual({ ok: false, reason: "no_frame" });
		expect(mapModelPointToDesktop(frame, 1, 1, { frameGeneration: 1, expectedGeneration: 2 })).toEqual({
			ok: false,
			reason: "stale_frame",
		});
	});
});
