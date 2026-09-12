import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getLatestTodoPhasesFromEntries, type TodoPhase, TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";

beforeAll(async () => {
	await initTheme(false);
});

describe("eval todo state synchronization", () => {
	let session: AgentSession;
	let manager: SessionManager;
	let auth: AuthStorage;
	let bridge: ToolSession;
	let todo: TodoTool;
	let controller: EventController;
	let hud: TodoPhase[];
	let deliveries: Promise<void>[];
	let unsubscribe: () => void;

	beforeEach(async () => {
		auth = await AuthStorage.create(":memory:");
		manager = SessionManager.inMemory();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": true, "todo.reminders": false }),
			modelRegistry: new ModelRegistry(auth),
		});
		hud = [];
		deliveries = [];
		controller = new EventController({
			isInitialized: true,
			init: vi.fn(async () => {}),
			ui: { requestRender: vi.fn() },
			transcriptMessageComponents: new WeakMap(),
			pendingTools: new Map(),
			statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			clearPinnedError: vi.fn(),
			ensureLoadingAnimation: vi.fn(),
			viewSession: { isStreaming: false },
			setTodos: (phases: TodoPhase[]) => {
				hud = phases;
			},
			present: vi.fn(),
		} as unknown as InteractiveModeContext);
		unsubscribe = session.subscribe(event => {
			deliveries.push(controller.handleEvent(event));
		});
		bridge = {
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: (phases: TodoPhase[]) => session.setTodoPhases(phases),
			getSessionFile: () => manager.getSessionFile(),
			getToolByName: () => todo,
		} as unknown as ToolSession;
		todo = new TodoTool(bridge);
	});

	afterEach(async () => {
		unsubscribe();
		await session.dispose();
		auth.close();
	});

	it("clears the HUD and replay state when eval removes the todo list", async () => {
		await callSessionTool("todo", { op: "init", items: ["nested task"] }, { session: bridge });
		await Promise.all(deliveries);
		expect(hud[0]?.tasks.map(task => task.content)).toEqual(["nested task"]);

		await callSessionTool("todo", { op: "rm" }, { session: bridge });
		await Promise.all(deliveries);
		expect(hud.flatMap(phase => phase.tasks)).toEqual([]);
		expect(session.getTodoPhases()).toEqual(hud);
		expect(getLatestTodoPhasesFromEntries(manager.getBranch())).toEqual(hud);
	});

	it("updates the HUD after each nested completion and restores those completions from the branch", async () => {
		const initial = await todo.execute("init", { op: "init", items: ["first", "second"] });
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "init",
			toolName: "todo",
			isError: false,
			result: initial,
		});
		await Promise.all(deliveries);
		expect(hud[0]?.tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);

		await callSessionTool("todo", { op: "done", task: "first" }, { session: bridge });
		await Promise.all(deliveries);
		expect(hud[0]?.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		expect(getLatestTodoPhasesFromEntries(manager.getBranch())).toEqual(hud);

		await callSessionTool("todo", { op: "done", task: "second" }, { session: bridge });
		await Promise.all(deliveries);
		expect(hud[0]?.tasks.map(task => task.status)).toEqual(["completed", "completed"]);
		expect(session.getTodoPhases()).toEqual(hud);
		expect(getLatestTodoPhasesFromEntries(manager.getBranch())).toEqual(hud);

		const entriesBeforeReads = manager.getBranch().length;
		const eventsBeforeReads = deliveries.length;
		await callSessionTool("todo", { op: "view" }, { session: bridge });
		await callSessionTool("todo", { op: "done", task: "missing" }, { session: bridge });
		await Promise.all(deliveries);
		expect(manager.getBranch()).toHaveLength(entriesBeforeReads);
		expect(deliveries).toHaveLength(eventsBeforeReads);
		expect(session.getTodoPhases()).toEqual(hud);
	});
});
