/**
 * D7 computer-use boundary fixtures — product native frame / capture / transport contracts.
 *
 * Does **not** reimplement coordinate mapping. Exercises desktop-adapter /
 * DesktopSession contracts already owned by natives. Live Wayland / macOS /
 * Win platforms remain 未验证 in this environment.
 *
 * `read_only` is NOT a host sandbox — covered by computer tool approval tests;
 * this file only documents the facade boundary via adapter fixtures.
 */
import { describe, expect, it } from "bun:test";
import { adaptDesktopSession } from "../../../natives/native/desktop-adapter.js";

class LegacyDesktopSession {
	static instances: LegacyDesktopSession[] = [];

	readonly actions: Array<Record<string, unknown>> = [];
	readonly options: Record<string, unknown>;
	readonly capabilities = {
		backend: "unavailable",
		capture: true,
		input: true,
		capturePermission: "unknown",
		inputPermission: "unknown",
		displayCount: 0,
	};
	closed = false;
	#captureImpl: (() => Promise<Record<string, unknown>>) | undefined;
	#executeImpl:
		| ((actions: Array<Record<string, unknown>>) => Promise<Record<string, unknown> | undefined>)
		| undefined;

	constructor(options: Record<string, unknown>) {
		this.options = options;
		LegacyDesktopSession.instances.push(this);
	}

	setCaptureImpl(fn: () => Promise<Record<string, unknown>>): void {
		this.#captureImpl = fn;
	}

	setExecuteImpl(fn: (actions: Array<Record<string, unknown>>) => Promise<Record<string, unknown> | undefined>): void {
		this.#executeImpl = fn;
	}

	async capture() {
		if (this.#captureImpl) return this.#captureImpl();
		return {
			width: (this.options.maxWidth as number | undefined) ?? 20,
			height: (this.options.maxHeight as number | undefined) ?? 10,
			data: new Uint8Array(),
		};
	}

	async execute(actions: Array<Record<string, unknown>>): Promise<Record<string, unknown> | undefined> {
		this.actions.push(...actions);
		if (this.#executeImpl) return this.#executeImpl(actions);
		return undefined;
	}

	async close() {
		this.closed = true;
	}
}

describe("computer coordinate / frame product contracts (D7)", () => {
	it("rejects coordinate input before any capture (InvalidCoordinateFrame)", async () => {
		LegacyDesktopSession.instances = [];
		const DesktopSession = adaptDesktopSession(LegacyDesktopSession);
		const session = new DesktopSession({ display: "all" });
		await expect(session.click("desktop", 1, 1)).rejects.toThrow(/^InvalidCoordinateFrame: /);
	});

	it("preserves Retina / scale via sourceWidth from display geometry (transport rescale)", async () => {
		LegacyDesktopSession.instances = [];
		class ScaledLegacy extends LegacyDesktopSession {
			override async capture() {
				return {
					width: 10,
					height: 5,
					data: new Uint8Array(),
					displays: [{ id: "1", x: 0, y: 0, width: 20, height: 10, scale: 2, pixelWidth: 10, pixelHeight: 5 }],
				};
			}
		}
		const DesktopSession = adaptDesktopSession(ScaledLegacy);
		const session = new DesktopSession({ display: "all" });
		const capture = await session.capture("desktop", { maxWidth: 10, maxHeight: 5 });
		// Model-visible size is capped; source dimensions keep native scale identity.
		expect(capture).toMatchObject({ width: 10, height: 5, sourceWidth: 40, sourceHeight: 20, target: "desktop" });
	});

	it("supports multi-monitor negative origins in capture display metadata", async () => {
		LegacyDesktopSession.instances = [];
		class NegOriginLegacy extends LegacyDesktopSession {
			override async capture() {
				return {
					width: 40,
					height: 20,
					data: new Uint8Array(),
					displays: [
						{
							id: "left",
							x: -1920,
							y: 0,
							width: 1920,
							height: 1080,
							scale: 1,
							pixelWidth: 1920,
							pixelHeight: 1080,
						},
						{ id: "main", x: 0, y: 0, width: 1920, height: 1080, scale: 1, pixelWidth: 1920, pixelHeight: 1080 },
					],
				};
			}
		}
		const DesktopSession = adaptDesktopSession(NegOriginLegacy);
		const session = new DesktopSession({ display: "all" });
		const capture = await session.capture("desktop");
		expect(capture.sourceWidth).toBeGreaterThan(1920);
		expect(capture.width).toBe(40);
		await session.click("desktop", 1, 1);
		const legacy = LegacyDesktopSession.instances.at(-1);
		expect(legacy?.actions.some(a => a.type === "click")).toBe(true);
	});

	it("invalidates the coordinate frame after move/zoom geometry change (stale)", async () => {
		LegacyDesktopSession.instances = [];
		class LayoutChangingLegacy extends LegacyDesktopSession {
			override async execute(actions: Array<Record<string, unknown>>) {
				this.actions.push(...actions);
				// Post-action geometry change → next pointer must reject as stale frame.
				return { width: 19, height: 10, data: new Uint8Array() };
			}
		}
		const DesktopSession = adaptDesktopSession(LayoutChangingLegacy);
		const session = new DesktopSession({ display: "all" });
		await session.capture("desktop");
		await session.click("desktop", 1, 1);
		await expect(session.click("desktop", 1, 1)).rejects.toThrow(/^InvalidCoordinateFrame: /);
	});

	it("fails closed for PermissionDenied-class targets without inventing a sandbox", async () => {
		LegacyDesktopSession.instances = [];
		const DesktopSession = adaptDesktopSession(LegacyDesktopSession);
		const session = new DesktopSession({ display: "all" });
		await expect(session.capture("window-name")).rejects.toThrow(/^InvalidTarget: /);
		await session.close();
		await expect(session.capture("desktop")).rejects.toThrow(/^Closed: /);
	});
});

describe("computer D7 platform coverage notes", () => {
	it("documents unverified live platforms without claiming pass", () => {
		// Contract for reviewers: fixture + adapter coverage ≠ live platform matrix.
		const unverified = ["wayland-live", "macos-live", "win32-live", "browser-dom-live"] as const;
		expect(unverified).toContain("wayland-live");
		// 未验证: no interactive desktop/browser session in this environment.
	});
});
