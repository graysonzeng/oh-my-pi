import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createMemoryContext(backend: string) {
	const showWarning = vi.fn();
	const showError = vi.fn();
	const presentCommandOutput = vi.fn();
	const ctx = {
		settings: Settings.isolated({ "memory.backend": backend }),
		sessionManager: { getCwd: () => "/tmp/project" },
		session: undefined,
		showWarning,
		showError,
		presentCommandOutput,
	} as unknown as InteractiveModeContext;
	return { ctx, showWarning, showError, presentCommandOutput };
}

describe("CommandController /memory stats and /memory diagnose", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("tells the user memory is off instead of naming a nonexistent 'off backend' for /memory stats", async () => {
		const { ctx, showWarning } = createMemoryContext("off");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory stats");

		expect(showWarning).toHaveBeenCalledWith("Memory backend is off — there is nothing to show.");
	});

	it("tells the user memory is off instead of naming a nonexistent 'off backend' for /memory diagnose", async () => {
		const { ctx, showWarning } = createMemoryContext("off");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory diagnose");

		expect(showWarning).toHaveBeenCalledWith("Memory backend is off — there is nothing to show.");
	});

	it("still names the backend when a real backend simply has no stats hook", async () => {
		const { ctx, showWarning } = createMemoryContext("local");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory stats");

		expect(showWarning).toHaveBeenCalledWith("Memory stats is not available for the local backend.");
	});

	it("surfaces unsupported export on the off backend instead of inventing a package", async () => {
		const { ctx, showWarning, presentCommandOutput } = createMemoryContext("off");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory export");

		expect(presentCommandOutput).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(
			"Memory export is unsupported for the off backend (search results are never a full export).",
		);
	});

	it("requires a path for import-preview and lists transfer verbs in unknown usage", async () => {
		const { ctx, showError } = createMemoryContext("off");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory import-preview");
		expect(showError).toHaveBeenCalledWith("Usage: /memory import-preview <path>");

		await controller.handleMemoryCommand("/memory unknownverb");
		expect(showError).toHaveBeenCalledWith(
			"Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild|queue|sync|export|import-preview|import-apply|mm ...>",
		);
	});
});
