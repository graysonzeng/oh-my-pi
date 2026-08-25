import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Api, ComputerAction, ComputerToolCallMetadata, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type as arkType } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ComputerTool, computerApproval } from "@oh-my-pi/pi-coding-agent/tools/computer";
import type {
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
	ComputerWorkerTransport,
} from "@oh-my-pi/pi-coding-agent/tools/computer/protocol";
import { ComputerSupervisor, type ComputerWorkerHandle } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { ComputerWorkerCore, type NativeDesktopSession } from "@oh-my-pi/pi-coding-agent/tools/computer/worker";
import type {
	AxNode,
	AxQuery,
	AxSnapshotOptions,
	DesktopCapabilities,
	DesktopDisplay,
	DesktopPoint,
	DesktopWindow,
	PointerOptions,
} from "@oh-my-pi/pi-natives";

const capabilities: DesktopCapabilities = {
	backend: "fake",
	displayServer: "memory",
	capture: true,
	input: true,
	ax: true,
	backgroundWindowInput: true,
	deliveryModes: ["background", "foreground"],
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 1,
};

const display: DesktopDisplay = {
	id: "display-1",
	name: "Primary",
	x: 0,
	y: 0,
	width: 64,
	height: 32,
	scale: 1,
	pixelX: 0,
	pixelY: 0,
	pixelWidth: 64,
	pixelHeight: 32,
	isPrimary: true,
};

const windowFixture: DesktopWindow = {
	id: "42",
	title: "Editor",
	app: "Code",
	pid: 123,
	x: 4,
	y: 5,
	width: 40,
	height: 20,
	focused: true,
};

const axNode: AxNode = {
	ref: "e1",
	role: "button",
	nativeRole: "button",
	title: "Save",
	enabled: true,
	focused: false,
	childCount: 0,
	x: 7,
	y: 8,
	width: 9,
	height: 10,
};

class FakeNativeSession implements NativeDesktopSession {
	readonly capabilities = capabilities;
	clickCount = 0;
	closeCount = 0;
	sourceWidth = 64;
	sourceHeight = 32;

	async listDisplays(): Promise<DesktopDisplay[]> {
		return [display];
	}
	async listWindows(): Promise<DesktopWindow[]> {
		return [windowFixture];
	}
	async capture(target: string): Promise<{
		data: Uint8Array;
		width: number;
		height: number;
		sourceWidth: number;
		sourceHeight: number;
		target: string;
	}> {
		return {
			data: Uint8Array.of(137, 80, 78, 71),
			width: 64,
			height: 32,
			sourceWidth: this.sourceWidth,
			sourceHeight: this.sourceHeight,
			target,
		};
	}
	async click(_target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {
		this.clickCount += 1;
	}
	async moveMouse(_target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {}
	async drag(_target: string, _points: DesktopPoint[], _opts?: PointerOptions | null): Promise<void> {}
	async scroll(
		_target: string,
		_x: number,
		_y: number,
		_dx: number,
		_dy: number,
		_opts?: PointerOptions | null,
	): Promise<void> {}
	async typeText(_target: string, _text: string, _opts?: PointerOptions | null): Promise<void> {}
	async keyChord(_target: string, _keys: string[], _opts?: PointerOptions | null): Promise<void> {}
	async raiseWindow(_windowId: string): Promise<void> {}
	async axSnapshot(_target: string, _opts?: AxSnapshotOptions | null): Promise<{ text: string }> {
		return { text: "- button [ref=e1]" };
	}
	async axQuery(_target: string, _query: AxQuery): Promise<AxNode[]> {
		return [axNode];
	}
	async axElementAt(_target: string, _x: number, _y: number): Promise<AxNode | null> {
		return axNode;
	}
	async axFocused(): Promise<AxNode | null> {
		return axNode;
	}
	async axNode(_ref: string): Promise<AxNode> {
		return axNode;
	}
	async axAttributes(_ref: string): Promise<Array<[string, string]>> {
		return [];
	}
	async axChildren(_ref: string): Promise<AxNode[]> {
		return [];
	}
	async axParent(_ref: string): Promise<AxNode | null> {
		return null;
	}
	async axPerform(_ref: string, _action: string): Promise<void> {}
	async axSetValue(_ref: string, _value: string): Promise<void> {}
	async axFocus(_ref: string): Promise<void> {}
	async axClick(_ref: string, _opts?: PointerOptions | null): Promise<void> {}
	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

class MemoryTransport implements ComputerWorkerTransport {
	readonly outbound: ComputerWorkerOutbound[] = [];
	#handler?: (message: ComputerWorkerInbound) => void;
	#waiters = new Set<{
		predicate: (message: ComputerWorkerOutbound) => boolean;
		resolve: (message: ComputerWorkerOutbound) => void;
	}>();

	send(message: ComputerWorkerOutbound): void {
		this.outbound.push(message);
		for (const waiter of this.#waiters) {
			if (!waiter.predicate(message)) continue;
			this.#waiters.delete(waiter);
			waiter.resolve(message);
		}
	}
	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}
	close(): void {}
	inbound(message: ComputerWorkerInbound): void {
		this.#handler?.(message);
	}
	waitFor(predicate: (message: ComputerWorkerOutbound) => boolean): Promise<ComputerWorkerOutbound> {
		const existing = this.outbound.find(predicate);
		if (existing) return Promise.resolve(existing);
		const pending = Promise.withResolvers<ComputerWorkerOutbound>();
		this.#waiters.add({ predicate, resolve: pending.resolve });
		return pending.promise;
	}
}

const snapshot = (readOnly = false): ComputerSessionSnapshot => ({
	cwd: import.meta.dir,
	sessionId: crypto.randomUUID(),
	captureMaxWidth: 1280,
	captureMaxHeight: 896,
	display: "all",
	readOnly,
});

async function runWorker(
	transport: MemoryTransport,
	id: string,
	code: string,
	readOnly = false,
	timeoutMs = 2_000,
): Promise<Extract<ComputerWorkerOutbound, { type: "result" }>> {
	transport.inbound({ type: "run", id, code, timeoutMs, session: snapshot(readOnly) });
	return (await transport.waitFor(
		(message): message is Extract<ComputerWorkerOutbound, { type: "result" }> =>
			message.type === "result" && message.id === id,
	)) as Extract<ComputerWorkerOutbound, { type: "result" }>;
}

function toolSession(): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated({ "computer.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as ToolSession;
}

const noOpController = {
	async run() {
		return { displays: [], returnValue: undefined, screenshots: [] };
	},
	async capabilities() {
		return undefined;
	},
	async close() {},
};

describe("computer schema and approval", () => {
	it("requires code, rejects unknown keys, and shares its lazily-created schema", async () => {
		const first = new ComputerTool(toolSession(), () => noOpController);
		const second = new ComputerTool(toolSession(), () => noOpController);
		const schema = first.parameters;

		expect(schema({ code: "await desktop.windows()" }) instanceof arkType.errors).toBe(false);
		expect(schema({}) instanceof arkType.errors).toBe(true);
		expect(schema({ code: "1", unexpected: true }) instanceof arkType.errors).toBe(true);
		expect(first.parameters).toBe(schema);
		expect(second.parameters).toBe(schema);
		await Promise.all([first.close(), second.close()]);
	});

	it("maps only literal read_only true to read approval", () => {
		expect(computerApproval({ read_only: true })).toBe("read");
		expect(computerApproval({})).toBe("exec");
		expect(computerApproval({ read_only: false })).toBe("exec");
		expect(computerApproval({ read_only: "yes" })).toBe("exec");
		expect(computerApproval("garbage")).toBe("exec");
	});
});

describe("computer worker round trips", () => {
	it("lists windows and returns screenshot caption, image, and detail through a fake native session", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, options => {
			expect(options).toEqual({ display: "all" });
			return native;
		});

		const result = await runWorker(
			transport,
			"capture",
			"const windows = await desktop.windows(); await desktop.screenshot(); ({ count: windows.length })",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.returnValue).toEqual({ count: 1 });
		const texts = result.payload.displays.filter(block => block.type === "text");
		const images = result.payload.displays.filter(block => block.type === "image");
		expect(texts).toHaveLength(1);
		expect(texts[0]?.text).toMatch(/^screenshot desktop 64×32 → .*omp-computer-.*\.png$/);
		expect(images).toEqual([{ type: "image", data: "iVBORw==", mimeType: "image/png" }]);
		expect(result.payload.screenshots).toHaveLength(1);
		expect(result.payload.screenshots[0]).toMatchObject({ width: 64, height: 32, target: "desktop" });
		expect(result.payload.screenshots[0]?.path).toMatch(/omp-computer-.*\.png$/);
	});

	it("reports source dimensions when a screenshot is scaled", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		native.sourceWidth = 128;
		native.sourceHeight = 64;
		new ComputerWorkerCore(transport, () => native);

		const result = await runWorker(transport, "scaled-capture", "await desktop.screenshot()");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.displays[0]).toEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringMatching(/^screenshot desktop 64×32 \(scaled from 128×64\) → .*omp-computer-.*\.png$/),
			}),
		);
		expect(result.payload.screenshots[0]).toMatchObject({
			width: 64,
			height: 32,
			sourceWidth: 128,
			sourceHeight: 64,
		});
	});

	it("blocks read-only click after capture before invoking native input", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const result = await runWorker(
			transport,
			"read-only",
			"await desktop.screenshot({ silent: true }); await desktop.click(1, 2)",
			true,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.isToolError).toBe(true);
		expect(result.error.message).toBe("read-only run: 'click' requires read_only: false");
		expect(native.clickCount).toBe(0);
	});

	it("rejects an aborted run with an abort error", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({ type: "run", id: "abort", code: "await wait(5_000)", timeoutMs: 5_000, session: snapshot() });
		await Promise.resolve();
		transport.inbound({ type: "abort", id: "abort" });
		const result = await transport.waitFor(message => message.type === "result" && message.id === "abort");
		expect(result.type).toBe("result");
		if (result.type !== "result" || result.ok) return;
		expect(result.error.isAbort).toBe(true);
		expect(result.error.name).toBe("ToolAbortError");
	});

	it("reports the worker watchdog timeout budget explicitly", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const result = await runWorker(transport, "timeout", "await wait(5_000)", false, 10);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({
			isToolError: true,
			message: "Computer code execution timed out after 10ms",
		});
	});

	it("round-trips tool calls and resolves the in-script promise", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const resultPromise = runWorker(transport, "bridge", "await tool.echo({ value: 7 })");
		const call = await transport.waitFor(message => message.type === "tool-call" && message.runId === "bridge");
		expect(call).toMatchObject({ type: "tool-call", runId: "bridge", name: "echo", args: { value: 7 } });
		if (call.type !== "tool-call") return;
		transport.inbound({ type: "tool-reply", id: call.id, reply: { ok: true, value: { echoed: 7 } } });
		const result = await resultPromise;
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload.returnValue).toEqual({ echoed: 7 });
	});

	it("uses a retained window screenshot in the current run payload", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const first = await runWorker(
			transport,
			"retain-window-screenshot",
			'globalThis.retainedWin = await desktop.window("42")',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-screenshot",
			"await globalThis.retainedWin.screenshot({ silent: true })",
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.payload.screenshots).toHaveLength(1);
		expect(second.payload.screenshots[0]).toMatchObject({
			width: 64,
			height: 32,
			sourceWidth: 64,
			sourceHeight: 32,
			target: "42",
		});
	});

	it("resolves ref() to a populated live element and find() to every match", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const result = await runWorker(
			transport,
			"ref-resolve",
			'const win = await desktop.window("42"); const el = await win.ref("e1"); const all = await win.find({ role: "button" }); ({ role: el.role, count: all.length })',
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload.returnValue).toEqual({ role: "button", count: 1 });
	});

	it("applies the current read-only policy to a retained writable window", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const first = await runWorker(
			transport,
			"retain-writable-window",
			'globalThis.retainedWin = await desktop.window("42")',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-read-only",
			"await globalThis.retainedWin.click(1, 1)",
			true,
		);
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error.message).toBe("read-only run: 'click' requires read_only: false");
		expect(native.clickCount).toBe(0);
	});

	it("allows a retained read-only window to mutate in a later exec run", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const first = await runWorker(
			transport,
			"retain-read-only-window",
			'globalThis.retainedWin = await desktop.window("42")',
			true,
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-exec",
			"await globalThis.retainedWin.screenshot({ silent: true }); await globalThis.retainedWin.click(1, 1)",
		);
		expect(second.ok).toBe(true);
		expect(native.clickCount).toBe(1);
	});

	it("denies async continuations leaked from an ended run the next run's authority", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		// Run 1 (exec) leaks a promise continuation that clicks once triggered.
		// The continuation is registered inside run 1's async context, so it must
		// retain run 1's (aborted) context even when it executes during run 2.
		const first = await runWorker(
			transport,
			"leak-continuation",
			[
				'globalThis.leakWin = await desktop.window("42");',
				"globalThis.leakErr = null;",
				"const { promise: trigger, resolve: fireLeak } = Promise.withResolvers(); globalThis.fireLeak = fireLeak;",
				"globalThis.leakDone = trigger.then(() => globalThis.leakWin.click(1, 1)).catch(err => { globalThis.leakErr = String(err); });",
				'"armed"',
			].join("\n"),
		);
		expect(first.ok).toBe(true);
		// Run 2 (exec) fires the leaked continuation and awaits its settlement; the
		// click must fail with run 1's abort instead of borrowing run 2's policy.
		const second = await runWorker(
			transport,
			"leak-victim",
			"globalThis.fireLeak(); await globalThis.leakDone; globalThis.leakErr",
		);
		expect(second.ok).toBe(true);
		if (second.ok) expect(String(second.payload.returnValue)).toContain("Computer run ended");
		expect(native.clickCount).toBe(0);
	});

	it("uses a retained AX element in the current run", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const first = await runWorker(
			transport,
			"retain-element",
			'globalThis.retainedEl = (await (await desktop.window("42")).find({ role: "button" }))[0]',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(transport, "reuse-element", "await globalThis.retainedEl.bounds()");
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.payload.returnValue).toEqual({ x: 7, y: 8, width: 9, height: 10 });
	});
});

class SupervisorWorker implements ComputerWorkerHandle {
	readonly #respond: boolean;
	#messageHandlers = new Set<(message: ComputerWorkerOutbound) => void>();
	#terminated = false;

	constructor(respond: boolean) {
		this.#respond = respond;
	}
	send(message: ComputerWorkerInbound): void {
		if (message.type === "run" && this.#respond) {
			queueMicrotask(() =>
				this.#emit({
					type: "result",
					id: message.id,
					ok: true,
					payload: { displays: [], returnValue: "fresh", screenshots: [], capabilities },
				}),
			);
		} else if (message.type === "close") {
			queueMicrotask(() => this.#emit({ type: "closed" }));
		}
	}
	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		queueMicrotask(() => this.#emit({ type: "ready" }));
		return () => this.#messageHandlers.delete(handler);
	}
	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}
	async terminate(): Promise<void> {
		this.#terminated = true;
	}
	#emit(message: ComputerWorkerOutbound): void {
		if (this.#terminated) return;
		for (const handler of this.#messageHandlers) handler(message);
	}
}

describe("computer supervisor recovery", () => {
	it("surfaces a timeout ToolError and creates a fresh worker for the next run", async () => {
		let workers = 0;
		const supervisor = new ComputerSupervisor(toolSession(), () => new SupervisorWorker(++workers > 1), {
			startMs: 200,
			closeMs: 200,
		});
		await expect(supervisor.run("await new Promise(() => {})", 5, snapshot())).rejects.toEqual(
			expect.objectContaining({
				name: "ToolError",
				message: "computer worker restarted; captures and ax refs were reset",
			}),
		);
		expect(promptText).toContain("Provider safety checks:\n1. Submit external form");
		expect(promptText).toContain("click button=left at (1, 2)");
		expect(result.providerMetadata).toMatchObject({ acknowledgedSafetyChecks: checks });
		expect(controller.batches).toHaveLength(1);
	});
});

it("passes provider-native actions and safety checks to extension policy hooks", async () => {
	const settings = Settings.isolated({ "computer.enabled": true, "tools.approvalMode": "yolo" });
	const controller = new FakeController();
	const tool = new ComputerTool(toolSession(settings), () => controller);
	const actions: ComputerAction[] = [{ type: "click", x: 21, y: 34, button: "right", keys: ["SHIFT"] }];
	const checks = [{ id: "risk-hook", code: "external_side_effect", message: "Submit form" }];
	let hookInput: Record<string, unknown> | undefined;
	const runner = {
		hasHandlers: (type: string) => type === "tool_call",
		hasUI: () => true,
		consumeToolCallEmitted: () => false,
		getUIContext: () => ({ select: async () => "Approve" }),
		emitToolCall: async (event: { input: Record<string, unknown> }) => {
			hookInput = event.input;
			return { block: true, reason: "blocked by audit policy" };
		},
	} as unknown as ExtensionRunner;
	const wrapped = new ExtensionToolWrapper(tool as unknown as AgentTool, runner);
	await expect(
		wrapped.execute("call", {}, undefined, undefined, callContext(settings, actions, checks)),
	).rejects.toThrow("blocked by audit policy");
	expect(hookInput).toEqual({ actions, pendingSafetyChecks: checks });
	expect(controller.batches).toHaveLength(0);
});

it("sanitizes provider safety text as approval data", async () => {
	const settings = Settings.isolated({ "computer.enabled": true, "tools.approvalMode": "yolo" });
	const tool = new ComputerTool(toolSession(settings), () => new FakeController());
	let promptText = "";
	const runner = {
		hasHandlers: () => false,
		hasUI: () => true,
		consumeToolCallEmitted: () => false,
		getUIContext: () => ({
			select: async (message: string) => {
				promptText = message;
				return "Deny";
			},
		}),
	} as unknown as ExtensionRunner;
	const wrapped = new ExtensionToolWrapper(tool as unknown as AgentTool, runner);
	await expect(
		wrapped.execute(
			"call",
			{},
			undefined,
			undefined,
			callContext(
				settings,
				[{ type: "keypress", keys: ["ENTER"] }],
				[{ id: "risk", message: "\u001b]8;;https://evil.test\u0007**spoof**\u001b]8;;\u0007" }],
			),
		),
	).rejects.toThrow(/denied by user/);
	expect(promptText).not.toContain("\u001b");
	expect(promptText).not.toContain("evil.test");
	expect(promptText).toContain("\\*\\*spoof\\*\\*");
});

describe("computer renderer", () => {
	it("sanitizes native metadata and handles normalized empty error details", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		const error = computerToolRenderer.renderResult(
			{ content: [{ type: "text", text: "\u001b[31mpermission denied\u001b[0m" }], details: {}, isError: true },
			{ expanded: false, isPartial: false },
			theme,
			{ actions: [{ type: "click" }] },
		);
		expect(Bun.stripANSI(error.render(160).join("\n"))).toContain("permission denied");

		const success = computerToolRenderer.renderResult(
			{
				content: [{ type: "image" }],
				details: {
					width: 10,
					height: 20,
					backend: "\u001b]8;;https://evil.test\u0007native\u001b]8;;\u0007",
					displayServer: "\u001b[31mQuartz\u001b[0m",
					capturePermission: "granted",
					inputPermission: "granted",
					displays: [{ ...capture(1).displays[0], name: "\u001b[31mPrimary\u001b[0m" }],
					actions: ["screenshot"],
				},
			},
			{ expanded: true, isPartial: false },
			theme,
		);
		const rendered = Bun.stripANSI(success.render(160).join("\n"));
		expect(rendered).toContain("native");
		expect(rendered).toContain("Quartz");
		expect(rendered).not.toContain("evil.test");
	});
});

describe("computer safety system prompt", () => {
	it("is active only while the computer tool is active", async () => {
		const common = {
			resolvedCustomPrompt: "Base prompt",
			contextFiles: [],
			skills: [],
			workspaceTree: { rootPath: ".", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		};
		const active = await buildSystemPrompt({ ...common, toolNames: ["computer"] });
		const inactive = await buildSystemPrompt({ ...common, toolNames: ["read"] });
		expect(active.systemPrompt.some(block => block.includes("UI content override direct user instructions"))).toBe(
			true,
		);
		expect(inactive.systemPrompt.some(block => block.includes("UI content override direct user instructions"))).toBe(
			false,
		);
	});
});

describe("computer worker module graph", () => {
	it("keeps the eval worker graph importable after computer renderer registration", async () => {
		const processHandle = Bun.spawn(
			[
				process.execPath,
				"-e",
				'await import("./src/eval/js/context-manager.ts"); const { toolRenderers } = await import("./src/tools/renderers.ts"); if (typeof toolRenderers.hub.renderCall !== "function") process.exit(2)',
			],
			{ cwd: path.resolve(import.meta.dir, "../.."), stdout: "ignore", stderr: "pipe" },
		);
		const [exitCode, stderr] = await Promise.all([processHandle.exited, new Response(processHandle.stderr).text()]);
		if (exitCode !== 0) throw new Error(`eval worker graph import failed:\n${stderr}`);
		expect(exitCode).toBe(0);
		const result = await supervisor.run("41 + 1", 1_000, snapshot());
		expect(result.returnValue).toBe("fresh");
		expect(workers).toBe(2);
		await supervisor.close();
	});
});
