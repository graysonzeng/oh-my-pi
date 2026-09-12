/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists every running subagent — detached background spawns and
 * sync task calls alike — as numbered `N Id: description` jump-list rows and
 * yields no output once nothing qualifies, so the block self-clears.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-coding-agent/modes/composer";
import {
	InteractiveMode,
	layoutPinnedHud,
	renderSubagentHudLines,
	SubagentHudComponent,
	SUBAGENT_HUD_REFRESH_MS,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

function render(sessions: ObservableSession[], columns = 120): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns).join("\n"));
}
/**
 * Attach the streaming-phase fields to a progress snapshot. The runtime agent
 * lands `activityPhase` / `lastActivityAtMs` on `AgentProgress` in parallel;
 * consumers read them through `Record` access, so tests attach them without
 * depending on that type change landing first.
 */
function withLivePhase(
	progress: AgentProgress,
	live: {
		activityPhase?: "working" | "model" | "thinking" | "responding" | "tool";
		lastActivityAtMs?: number;
	},
): AgentProgress {
	return Object.assign(progress, live);
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	describe("model badges", () => {
		beforeEach(async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { "task.showResolvedModelBadge": true } });
		});

		afterEach(() => {
			resetSettingsForTest();
		});

		it("places thinking, model and optional advisor before the detached agent name", () => {
			const session = makeSession({
				id: "BadgeWorker",
				agent: "scout",
				description: "Inspect rendering",
				progress: makeProgress({
					id: "BadgeWorker",
					resolvedModel: "openai/gpt-5:high",
					resolvedModelIdentity: "openai/gpt-5",
					resolvedThinkingLevel: ThinkingLevel.High,
					advisor: true,
				}),
			});
			const out = render([session]);
			expect(out).toContain(`${theme.thinking.high.split(" ")[0]} openai/gpt-5 ${theme.icon.advisor} BadgeWorker`);
			expect(out).toContain(`BadgeWorker ${theme.format.bracketLeft}scout${theme.format.bracketRight}`);
			expect(out).toContain(": Inspect rendering");

			session.progress = makeProgress({
				id: "BadgeWorker",
				resolvedModel: "openai/gpt-5:high",
				resolvedModelIdentity: "openai/gpt-5",
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: false,
			});
			const withoutAdvisor = render([session]);
			expect(withoutAdvisor).toContain("openai/gpt-5 BadgeWorker");
			expect(withoutAdvisor).not.toContain(theme.icon.advisor);
		});

		it("keeps metadata hidden when disabled or settings have not initialized", () => {
			const sessions = [
				makeSession({
					id: "HiddenBadge",
					description: "Inspect rendering",
					progress: makeProgress({
						id: "HiddenBadge",
						resolvedModel: "openai/gpt-5:high",
						resolvedModelIdentity: "openai/gpt-5",
						resolvedThinkingLevel: ThinkingLevel.High,
						advisor: true,
					}),
				}),
			];
			Settings.instance.override("task.showResolvedModelBadge", false);
			const disabled = render(sessions);
			expect(disabled).toContain(`${theme.status.done} HiddenBadge: Inspect rendering`);
			expect(disabled).not.toContain("openai/gpt-5");
			expect(disabled).not.toContain(theme.icon.advisor);

			resetSettingsForTest();
			expect(render(sessions)).toBe(disabled);
		});

		it("preserves model identity and the agent name while fitting descriptions and task previews", () => {
			const metadata = {
				resolvedModel: `provider/${"shared-prefix-".repeat(8)}variant-z:high`,
				resolvedModelIdentity: `provider/${"shared-prefix-".repeat(8)}variant-z`,
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: true,
			};
			const sessions = [
				makeSession({
					id: "Description",
					description: "Inspect rendering ".repeat(20),
					progress: makeProgress({ id: "Description", ...metadata }),
				}),
				makeSession({
					id: "TaskPreview",
					progress: makeProgress({ id: "TaskPreview", task: "Inspect rendering ".repeat(20), ...metadata }),
				}),
			];
			const lines = render(sessions, 60).split("\n");
			for (const id of ["Description", "TaskPreview"]) {
				const row = lines.find(line => line.includes(id))!;
				expect(row).toContain(`variant-z ${theme.icon.advisor} ${id}`);
				expect(row.indexOf("variant-z")).toBeLessThan(row.indexOf(id));
				expect(row).not.toContain(":high");
			}
			for (const line of lines) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
			}
		});

		it("reserves custom tree prefixes, outer indent and roles before optional details", () => {
			const priorTree = Object.getOwnPropertyDescriptor(theme, "tree");
			try {
				Object.defineProperty(theme, "tree", {
					configurable: true,
					value: { ...theme.tree, branch: "界├", last: "界界└", vertical: "界界│" },
				});
				const sessions = [
					makeSession({
						id: `LongWorker${"界".repeat(30)}`,
						agent: `custom-role-${"extended-".repeat(10)}`,
						description: "Every available column ".repeat(10),
						progress: makeProgress({ id: "LongWorker", resolvedModelIdentity: "provider/model", advisor: true }),
					}),
					makeSession({ id: "ShortWorker", agent: "scout", description: "Every available column ".repeat(10) }),
				];
				for (const enabled of [true, false]) {
					Settings.instance.override("task.showResolvedModelBadge", enabled);
					for (const width of [40, 120, 40]) {
						const rows = render(sessions, width).split("\n");
						expect(rows.find(row => row.includes("LongWorker"))).toStartWith(" 界├ ");
						expect(rows.find(row => row.includes("ShortWorker"))).toStartWith(" 界界└ ");
						for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
						expect(rows.find(row => row.includes("LongWorker"))).toContain("LongWorker");
						expect(rows.find(row => row.includes("ShortWorker"))).toContain(
							`${theme.format.bracketLeft}scout${theme.format.bracketRight}`,
						);
					}
				}
			} finally {
				if (priorTree) Object.defineProperty(theme, "tree", priorTree);
				else Reflect.deleteProperty(theme, "tree");
			}
		});

		it("preserves a legacy selector without inventing a thinking glyph", () => {
			const out = render([
				makeSession({
					id: "LegacyWorker",
					progress: makeProgress({ id: "LegacyWorker", resolvedModel: "custom/model:high" }),
				}),
			]);
			expect(out).toContain(`${theme.status.done} custom/model:high LegacyWorker`);
			expect(out).not.toContain(theme.thinking.high.split(" ")[0]);
		});
	});

	it("renders running subagents as Id: description under a Subagents header", () => {
		const out = render([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(out).toContain("Subagents");
		expect(out).toContain("AuthLoader: Refactoring the auth flow");
		expect(out).toContain("SchemaMigrator: Migrating the users table");
	});

	it("shows a non-default role badge and hides descriptions that only echo the id", () => {
		const withRole = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "Refactor the auth flow",
			}),
		]);
		expect(withRole).toContain("AuthLoader");
		expect(withRole).toMatch(/AuthLoader.*scout/);
		expect(withRole).toContain("Refactor the auth flow");

		const echoed = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(echoed).toContain("AuthLoader");
		expect(echoed).toMatch(/AuthLoader.*scout/);
		expect(echoed).not.toContain("AuthLoader: AuthLoader");

		const collision = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(collision).toContain("AuthLoader-3");
		expect(collision).toMatch(/AuthLoader-3.*scout/);
		expect(collision).not.toContain("AuthLoader-3: AuthLoader");

		const mixedCase = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "authloader",
			}),
		]);
		expect(mixedCase).toContain("AuthLoader-3");
		expect(mixedCase).not.toContain("AuthLoader-3: authloader");

		const defaultWorker = render([
			makeSession({ id: "SchemaMigrator", agent: "task", description: "Migrate users" }),
		]);
		expect(defaultWorker).toContain("SchemaMigrator: Migrate users");
		expect(defaultWorker).not.toMatch(/SchemaMigrator.*task/);
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expect(out).toContain("StillRunning: live work");
		expect(out).not.toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("appends a compact current-tool activity sub-row under a running HUD identity line", () => {
		const out = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					currentTool: "read",
					currentToolArgs: "src/auth.ts",
					currentToolStartMs: Date.now() - 600,
				}),
			}),
		]);
		expect(out).toContain("AuthLoader: Refactor the auth flow");
		expect(out).toMatch(/read: src\/auth\.ts/);
		expect(out).not.toMatch(/read: src\/auth\.ts[\s\S]*read: src\/auth\.ts/);
	});

	it("prefers lastIntent over current args and falls back to the most recent completed tool", () => {
		const current = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					lastIntent: "Inspect login",
					currentTool: "read",
					currentToolArgs: "src/auth.ts",
					recentTools: [{ tool: "grep", args: "password", endMs: Date.now() }],
				}),
			}),
		]);
		expect(current).toMatch(/read: Inspect login/);
		expect(current).not.toContain("password");
		expect(current).not.toContain("src/auth.ts");

		const idle = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					recentTools: [{ tool: "grep", args: "password", endMs: Date.now() }],
				}),
			}),
		]);
		expect(idle).toMatch(/grep: password/);
	});

	it("shows elapsed only for a current tool that has been running more than 5s", () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const longRunning = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					currentTool: "read",
					currentToolArgs: "src/auth.ts",
					currentToolStartMs: now - 6_000,
				}),
			}),
		]);
		expect(longRunning).toMatch(/read: src\/auth\.ts/);
		expect(longRunning).toContain("6.0s");

		const recent = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					recentTools: [{ tool: "grep", args: "password", endMs: now }],
				}),
			}),
		]);
		expect(recent).toMatch(/grep: password/);
		expect(recent).not.toContain("6.0s");
	});

	it("marks finished recent tools as explicit last history, never as current work", () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const history = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					recentTools: [{ tool: "grep", args: "password", endMs: now }],
				}),
			}),
		]);
		const historyLine = history.split("\n").find(line => line.includes("grep:")) ?? "";
		expect(historyLine).toContain("last grep: password");

		const current = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					currentTool: "grep",
					currentToolArgs: "password",
				}),
			}),
		]);
		const currentLine = current.split("\n").find(line => line.includes("grep:")) ?? "";
		expect(currentLine).toContain("grep: password");
		expect(currentLine).not.toContain("last grep");
	});

	it("shows the observed phase label once a tool ended, never the stale tool name", () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const out = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: withLivePhase(
					makeProgress({
						id: "AuthLoader",
						recentTools: [{ tool: "read", args: "src/auth.ts", endMs: now - 60_000 }],
					}),
					{ activityPhase: "working", lastActivityAtMs: now - 30_000 },
				),
			}),
		]);
		expect(out).toContain("working");
		expect(out).toContain("30.0s no new events");
		expect(out).not.toContain("read");
		expect(out).not.toContain("src/auth.ts");
	});

	it("grows silence on later paints and narrow rows keep it over stale tool detail", () => {
		const now = 1_700_000_000_000;
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
		const session = makeSession({
			id: "AuthLoader",
			description: "Refactor the auth flow",
			progress: withLivePhase(
				makeProgress({
					id: "AuthLoader",
					recentTools: [{ tool: "read", args: "src/auth.ts", endMs: now - 60_000 }],
				}),
				{ activityPhase: "working", lastActivityAtMs: now - 30_000 },
			),
		});
		expect(render([session])).toContain("30.0s no new events");

		dateNow.mockReturnValue(now + 10_000);
		const grown = render([session]);
		expect(grown).toContain("40.0s no new events");
		expect(grown).not.toContain("30.0s");

		// The silence hint must survive before any stale tool args on a narrow
		// history row (`columns - 8` is the HUD activity budget).
		const historyIdle = makeSession({
			id: "AuthLoader",
			description: "Refactor the auth flow",
			progress: withLivePhase(
				makeProgress({
					id: "AuthLoader",
					recentTools: [{ tool: "read", args: "src/auth.ts", endMs: now }],
				}),
				{ activityPhase: "working", lastActivityAtMs: now - 30_000 },
			),
		});
		const narrowish = render([historyIdle], 46);
		expect(narrowish).toContain("working");
		expect(narrowish).toContain("no new events");
		expect(narrowish).not.toContain("src/auth.ts");
		for (const line of narrowish.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(46);
		}
	});

	it("renders the model phase as waiting on model without inventing tool time", () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const out = render([
			makeSession({
				id: "AuthLoader",
				progress: withLivePhase(makeProgress({ id: "AuthLoader" }), {
					activityPhase: "model",
					lastActivityAtMs: now - 5_000,
				}),
			}),
		]);
		expect(out).toContain("AuthLoader");
		expect(out).toContain("waiting on model");
		expect(out).not.toMatch(/\bread\b/);
		// 5s of silence is below the hint threshold; short quiet is normal.
		expect(out).not.toContain("no new events");
	});

	it("never renders terminal progress as running activity", () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const out = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: withLivePhase(
					makeProgress({
						id: "AuthLoader",
						status: "completed",
						currentTool: "read",
						currentToolArgs: "src/auth.ts",
						currentToolStartMs: now - 6_000,
					}),
					{ activityPhase: "tool", lastActivityAtMs: now - 30_000 },
				),
			}),
		]);
		expect(out).toContain("AuthLoader: Refactor the auth flow");
		expect(out).not.toMatch(/read: src\/auth\.ts/);
		expect(out).not.toContain("6.0s");
		expect(out.split("\n").filter(line => line.includes("AuthLoader")).length).toBe(1);
	});

	it("surfaces the real retry state ahead of the tool gist", () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const out = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					currentTool: "read",
					currentToolArgs: "src/auth.ts",
					currentToolStartMs: now - 6_000,
					retryState: {
						attempt: 2,
						maxAttempts: 5,
						delayMs: 45_000,
						errorMessage: "429 rate limited",
						startedAtMs: now,
					},
				}),
			}),
		]);
		expect(out).toContain("retry 2/5");
		expect(out).toContain("retrying in 45.0s");
		expect(out).not.toMatch(/\bread\b/);
	});

	it("truncates a long MCP tool name to the HUD viewport", () => {
		const longTool = `mcp__${"very-long-custom-tool-name-".repeat(8)}search`;
		const lines = renderSubagentHudLines(
			[
				makeSession({
					id: "AuthLoader",
					description: "Refactor the auth flow",
					progress: makeProgress({
						id: "AuthLoader",
						currentTool: longTool,
						currentToolArgs: "src/auth.ts",
					}),
				}),
			],
			40,
		).map(line => Bun.stripANSI(line));
		const activity = lines.find(line => /mcp|search|read|auth/.test(line) && !line.includes("AuthLoader:"));
		expect(activity).toBeDefined();
		expect(activity).not.toContain(longTool);
		expect(Bun.stringWidth(activity!)).toBeLessThanOrEqual(40);
	});

	it("sanitizes tabs and home paths in the HUD activity sub-row and keeps the identity line when activity is missing", () => {
		const homeFile = `${os.homedir()}/secret/token.ts`;
		const dirty = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					currentTool: "bash",
					currentToolArgs: `\tcat ${homeFile}`,
				}),
			}),
		]);
		expect(dirty).toContain("AuthLoader: Refactor the auth flow");
		expect(dirty).toContain("bash:");
		expect(dirty).toContain("~/secret/token.ts");
		expect(dirty).not.toContain("\t");
		expect(dirty).not.toContain(homeFile);

		const missing = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				progress: makeProgress({ id: "AuthLoader" }),
			}),
		]);
		expect(missing).toContain("AuthLoader: Refactor the auth flow");
		expect(missing.split("\n").filter(line => line.includes("AuthLoader")).length).toBe(1);
	});

	it("truncates the HUD activity sub-row to the viewport width", () => {
		const longPath = `src/${"very-long-module-name-".repeat(8)}auth.ts`;
		const lines = renderSubagentHudLines(
			[
				makeSession({
					id: "AuthLoader",
					description: "Refactor the auth flow",
					progress: makeProgress({
						id: "AuthLoader",
						currentTool: "read",
						currentToolArgs: longPath,
					}),
				}),
			],
			80,
		).map(line => Bun.stripANSI(line));
		const activity = lines.find(line => line.includes("read"));
		expect(activity).toBeDefined();
		expect(activity).not.toContain(longPath);
		expect(Bun.stringWidth(activity!)).toBeLessThanOrEqual(80);
		expect(lines.join("\n")).toContain("AuthLoader: Refactor the auth flow");
	});

	it("falls back to the description and task carried by progress snapshots", () => {
		const fromProgressDesc = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", description: "From progress" }) }),
		]);
		expect(fromProgressDesc).toContain("Worker: From progress");

		const fromTask = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", task: "Investigate flaky CI on macOS" }) }),
		]);
		expect(fromTask).toContain("Worker Investigate flaky CI on macOS");

		const multiLineTask = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				progress: makeProgress({
					id: "ReviewShell",
					agent: "scout",
					task: "Complete assignment thoroughly:\n\n# Target\nFiles: src/foo.ts",
				}),
			}),
		]);
		expect(multiLineTask).toContain("ReviewShell");
		expect(multiLineTask).toContain("Complete assignment thoroughly: ↵ # Tar");
		expect(multiLineTask).not.toContain("\n# Target");

		const multiLineDesc = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				description: "First line\n\nSecond line",
			}),
		]);
		expect(multiLineDesc).toContain("ReviewShell");
		expect(multiLineDesc).toContain("First line ↵ Second line");
		expect(multiLineDesc).not.toContain("\nSecond line");
	});
	it("lists sync and detached spawns alike", () => {
		// Sync task spawn (parent blocked on the call) and eval `agent()` spawn
		// (no detached flag at all) join the pinned jump list.
		const sessions = [
			makeSession({ id: "SyncSpawn", description: "inline task work", detached: false }),
			makeSession({ id: "EvalSpawn", description: "eval cell work", detached: undefined }),
			makeSession({ id: "BackgroundSpawn", description: "detached work" }),
		];
		const out = render(sessions);
		expect(out).toContain("BackgroundSpawn: detached work");
		expect(out).toContain("SyncSpawn: inline task work");
		expect(out).toContain("EvalSpawn: eval cell work");
		const hud = new SubagentHudComponent(renderSubagentHudLines(sessions, 120), [
			"SyncSpawn",
			"EvalSpawn",
			"BackgroundSpawn",
		]);
		hud.render(120);
		expect(hud.getClickAgentAtRow(2)).toBe("SyncSpawn");
		expect(hud.getClickAgentAtRow(3)).toBe("EvalSpawn");
		expect(hud.getClickAgentAtRow(4)).toBe("BackgroundSpawn");
	});
	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = render(registry.getSessions());
		expect(out).toContain("Detached: background work");
		expect(out).toContain("FromProgress: background work");
		expect(out).toContain("Inline: sync work");
	});

	it("renders nested ids as a breadcrumb and truncates long descriptions to the viewport", () => {
		const out = render([makeSession({ id: "Anna.Bob", description: `start ${"x".repeat(300)} end` })], 60);
		expect(out).toContain("Anna>Bob:");
		expect(out).not.toContain("end");
		for (const line of out.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("dedupes frames dual-published on the session bus and the shared bus", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const kinds: string[] = [];
		registry.onChange(kind => kinds.push(kind));
		const payload = makeLifecycle("DualPublished", 0, "dual-published frame");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		expect(kinds).toEqual(["lifecycle"]);
		expect(registry.getActiveSubagentCount()).toBe(1);
		registry.dispose();
	});

	it("keeps subagent registry order stable while progress arrives out of order", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const activeIds = () =>
			registry
				.getSessions()
				.filter(session => session.kind === "subagent" && session.status === "active")
				.map(session => session.id);

		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("SelectorSurfaces", 0, "Map model-selector resolution surfaces"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);
	});

	it("renders every live agent when expanded, with a collapse row", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = Bun.stripANSI(renderSubagentHudLines(active, 120, true).join("\n"));

		for (const session of active) {
			expect(out).toContain(`${session.id}: ${session.description}`);
		}
		expect(out).not.toContain("more running");
		expect(out).toContain("show less");
	});

	it("collapses to a few rows with an expander by default", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
				progress: makeProgress({
					id: `Worker${index}`,
					currentTool: "read",
					currentToolArgs: `src/file-${index}.ts`,
				}),
			}),
		);

		const out = render(active, 120);
		expect(out).toContain("Worker0: job 0");
		expect(out).toContain("Worker2: job 2");
		expect(out).not.toContain("Worker3: job 3");
		expect(out).toContain("7 more — expand");
		expect(out).not.toContain("show less");
	});
});

describe("SubagentHudComponent click rows", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("maps item rows to session ids and chrome rows nowhere", () => {
		const lines = renderSubagentHudLines([makeSession({ id: "Alpha" }), makeSession({ id: "Beta" })], 120);
		const hud = new SubagentHudComponent(lines, ["Alpha", "Beta"]);

		const rendered = hud.render(120);
		expect(rendered).toHaveLength(lines.length);
		expect(Bun.stripANSI(rendered[2] ?? "")).toContain("Alpha");
		expect(Bun.stripANSI(rendered[3] ?? "")).toContain("Beta");

		expect(hud.getClickAgentAtRow(0)).toBeUndefined();
		expect(hud.getClickAgentAtRow(1)).toBeUndefined();
		expect(hud.getClickAgentAtRow(2)).toBe("Alpha");
		expect(hud.getClickAgentAtRow(3)).toBe("Beta");
		expect(hud.getClickAgentAtRow(4)).toBeUndefined();
		expect(hud.getClickAgentAtRow(-1)).toBeUndefined();
	});

	it("resolves the expander row to the toggle sentinel", () => {
		const hud = new SubagentHudComponent(["", "Subagents", "row", "toggle"], ["Only"], 3);
		hud.render(120);
		expect(hud.getClickAgentAtRow(3)).toBe(PINNED_HUD_TOGGLE_ID);
		expect(hud.getClickAgentAtRow(2)).toBe("Only");
	});

	it("maps wrapped continuation rows to the agent that started them", () => {
		const long = ` ${"x".repeat(200)}`;
		const hud = new SubagentHudComponent(["", "Subagents", long, "short"], ["Long", "Short"]);
		const rendered = hud.render(40);
		expect(rendered.length).toBeGreaterThan(4);
		const shortRow = rendered.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(shortRow).toBeGreaterThan(3);
		expect(hud.getClickAgentAtRow(2)).toBe("Long");
		expect(hud.getClickAgentAtRow(3)).toBe("Long");
		expect(hud.getClickAgentAtRow(shortRow)).toBe("Short");
		expect(hud.getClickAgentAtRow(shortRow + 1)).toBeUndefined();
	});
});

describe("layoutPinnedHud", () => {
	it("fits small lists without an expander", () => {
		expect(layoutPinnedHud(0, false)).toEqual({ itemRows: 0, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, false)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, true)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
	});

	it("collapses longer lists behind an expander", () => {
		expect(layoutPinnedHud(4, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
		expect(layoutPinnedHud(10, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
	});

	it("expands to every row with a collapse row", () => {
		expect(layoutPinnedHud(5, true)).toEqual({ itemRows: 5, toggle: "collapse", toggleRow: 7 });
		expect(layoutPinnedHud(10, true)).toEqual({ itemRows: 10, toggle: "collapse", toggleRow: 12 });
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});
	it("coalesces a burst of progress observer changes into one render request", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();

		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("BurstAgent0: Burst job 0");
		expect(hud).toContain("BurstAgent2: Burst job 2");
		expect(hud).not.toContain("BurstAgent3: Burst job 3");
		expect(hud).toContain("3 more — expand");
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("applies the setting over a clicked expand override", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		for (let index = 0; index < 5; index++) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(`Override${index}`, index, `job ${index}`));
		}
		await Promise.resolve();
		const hudText = () => Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));

		mode.togglePinnedHudExpanded();
		expect(hudText()).toContain("Override4");

		mode.applyPinnedAgentsSetting();
		expect(hudText()).not.toContain("Override4");
		expect(hudText()).toContain("more — expand");
	});

	it("rebuilds the HUD with current-tool activity from a progress-channel snapshot", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: makeProgress({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				currentToolStartMs: now - 6_000,
			}),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("AuthLoader: Refactor the auth flow");
		expect(hud).toMatch(/read: src\/auth\.ts/);
		expect(hud).toContain("6.0s");
		const firstNarrow = Bun.stripANSI(mode.subagentContainer.render(40).join("\n"));
		expect(firstNarrow).toContain("AuthLoader");
		expect(firstNarrow).toMatch(/read: src\/auth\.ts/);
		expect(firstNarrow).toContain("6.0s");
		for (const line of firstNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: makeProgress({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				currentTool: "grep",
				currentToolArgs: "password",
				recentTools: [{ tool: "read", args: "src/auth.ts", endMs: now }],
			}),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const switched = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(switched).toMatch(/grep: password/);
		expect(switched).not.toContain("src/auth.ts");
		expect(switched).not.toContain("6.0s");
		const switchedNarrow = Bun.stripANSI(mode.subagentContainer.render(40).join("\n"));
		expect(switchedNarrow).toMatch(/grep: password/);
		expect(switchedNarrow).not.toContain("src/auth.ts");
		expect(switchedNarrow).not.toContain("6.0s");
		for (const line of switchedNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true),
			status: "completed",
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const cleared = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(cleared).not.toContain("AuthLoader");
		expect(cleared).not.toMatch(/grep: password/);
		expect(cleared).not.toContain("src/auth.ts");
		const clearedNarrow = Bun.stripANSI(mode.subagentContainer.render(40).join("\n"));
		expect(clearedNarrow).not.toContain("AuthLoader");
		expect(clearedNarrow).not.toMatch(/grep: password/);
		expect(clearedNarrow).not.toContain("src/auth.ts");
		for (const line of clearedNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("grows HUD current-tool elapsed on a later paint without a new progress snapshot", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		const now = 1_700_000_000_000;
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: makeProgress({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				currentToolStartMs: now - 6_000,
			}),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const first = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(first).toMatch(/read: src\/auth\.ts/);
		expect(first).toContain("6.0s");
		expect(first).not.toContain("7.0s");
		const firstElapsedNarrow = Bun.stripANSI(mode.subagentContainer.render(40).join("\n"));
		expect(firstElapsedNarrow).toMatch(/read: src\/auth\.ts/);
		expect(firstElapsedNarrow).toContain("6.0s");
		expect(firstElapsedNarrow).not.toContain("7.0s");
		for (const line of firstElapsedNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
		dateNow.mockReturnValue(now + 1_000);
		const grown = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(grown).toMatch(/read: src\/auth\.ts/);
		expect(grown).toContain("7.0s");
		expect(grown).not.toContain("6.0s");
		expect(grown.split("\n").filter(line => /read: src\/auth\.ts/.test(line))).toHaveLength(1);
		const narrow = Bun.stripANSI(mode.subagentContainer.render(40).join("\n"));
		expect(narrow).toContain("7.0s");
		expect(narrow).not.toContain("6.0s");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("truncates HUD activity to the current render width", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		const longTool = `mcp__${"very-long-custom-tool-name-".repeat(8)}search`;
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: makeProgress({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				currentTool: longTool,
				currentToolArgs: "src/auth.ts",
			}),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const wide = mode.subagentContainer.render(120).map(line => Bun.stripANSI(line).trimEnd());
		const wideActivity = wide.find(line => /mcp|search|read|auth/.test(line) && !line.includes("AuthLoader:"));
		expect(wideActivity).toBeDefined();
		expect(wideActivity).toContain("mcp__");
		const narrow = mode.subagentContainer.render(40).map(line => Bun.stripANSI(line).trimEnd());
		const activity = narrow.find(line => /mcp|search|read|auth/.test(line) && !line.includes("AuthLoader:"));
		expect(activity).toBeDefined();
		expect(activity).not.toContain(longTool);
		expect(Bun.stringWidth(activity!)).toBeLessThanOrEqual(40);
		expect(Bun.stringWidth(activity!)).toBeLessThan(Bun.stringWidth(wideActivity!));
	});

	it("prefers lastIntent over current args through InteractiveMode", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: makeProgress({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				lastIntent: "Inspect login",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				recentTools: [{ tool: "grep", args: "password", endMs: Date.now() }],
			}),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const out = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(out).toMatch(/read: Inspect login/);
		expect(out).not.toContain("src/auth.ts");
		expect(out).not.toContain("password");
		expect(out.split("\n").filter(line => /read: Inspect login/.test(line))).toHaveLength(1);
		const narrow = Bun.stripANSI(mode.subagentContainer.render(40).join("\n"));
		expect(narrow).toMatch(/read: Inspect login/);
		expect(narrow).not.toContain("src/auth.ts");
		expect(narrow).not.toContain("password");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("keeps HUD overflow collapsed with live activity through InteractiveMode", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		for (let index = 0; index < 10; index++) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(`Worker${index}`, index, `job ${index}`, true));
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				...makeProgressPayload(`Worker${index}`, index, `job ${index}`, true),
				progress: makeProgress({
					id: `Worker${index}`,
					description: `job ${index}`,
					currentTool: "read",
					currentToolArgs: `src/file-${index}.ts`,
				}),
			});
		}
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const out = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		const activityRows = out.split("\n").filter(line => /read: src\/file-\d+\.ts/.test(line));
		expect(activityRows).toHaveLength(3);
		for (let index = 0; index < 3; index++) {
			expect(out).toContain(`Worker${index}: job ${index}`);
			expect(out).toContain(`src/file-${index}.ts`);
		}
		expect(out).not.toContain("Worker3: job 3");
		expect(out).not.toContain("src/file-3.ts");
		expect(out).toContain("7 more — expand");
		const overflowNarrow = Bun.stripANSI(mode.subagentContainer.render(40).join("\n"));
		expect(overflowNarrow.split("\n").filter(line => /read: src\/file-\d+/.test(line))).toHaveLength(3);
		expect(overflowNarrow).toContain("Worker0");
		expect(overflowNarrow).not.toContain("Worker3");
		expect(overflowNarrow).toContain("more — expand");
		for (const line of overflowNarrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("shortens home paths in HUD activity through InteractiveMode", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		const homeFile = `${os.homedir()}/secret/token.ts`;
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: makeProgress({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				currentTool: "bash",
				currentToolArgs: `\tcat ${homeFile}`,
			}),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const out = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(out).toContain("AuthLoader: Refactor the auth flow");
		expect(out).toContain("bash:");
		expect(out).toContain("~/secret/token.ts");
		expect(out).not.toContain("\t");
		expect(out).not.toContain(homeFile);
		const narrow = Bun.stripANSI(mode.subagentContainer.render(40).join("\n"));
		expect(narrow).toContain("bash:");
		expect(narrow).toContain("~/secret");
		expect(narrow).not.toContain("\t");
		expect(narrow).not.toContain(homeFile);
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("excludes recentOutput from HUD compact activity through InteractiveMode", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: makeProgress({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				recentOutput: ["thinking about the auth flow", "secret stdout line"],
			}),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const out = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(out).toMatch(/read: src\/auth\.ts/);
		expect(out).not.toContain("thinking about the auth flow");
		expect(out).not.toContain("secret stdout line");
		expect(out.split("\n").filter(line => /read: src\/auth\.ts/.test(line))).toHaveLength(1);
		const narrow = Bun.stripANSI(mode.subagentContainer.render(40).join("\n"));
		expect(narrow).toMatch(/read: src\/auth\.ts/);
		expect(narrow).not.toContain("thinking about the auth flow");
		expect(narrow).not.toContain("secret stdout line");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("keeps the HUD identity line without inventing thinking when activity is missing through InteractiveMode", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: makeProgress({
				id: "AuthLoader",
				description: "Refactor the auth flow",
				recentOutput: ["thinking about the auth flow"],
			}),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const out = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(out).toContain("AuthLoader: Refactor the auth flow");
		expect(out.split("\n").filter(line => line.includes("AuthLoader")).length).toBe(1);
		expect(out).not.toContain("thinking");
		expect(out).not.toContain("no activity");
		expect(out).not.toContain("thinking about the auth flow");
		expect(out).not.toMatch(/\bread\b/);
		expect(out).not.toMatch(/\bgrep\b/);
		const narrow = Bun.stripANSI(mode.subagentContainer.render(40).join("\n"));
		expect(narrow).toContain("AuthLoader");
		expect(narrow.split("\n").filter(line => line.includes("AuthLoader")).length).toBe(1);
		expect(narrow).not.toContain("thinking");
		expect(narrow).not.toContain("no activity");
		expect(narrow).not.toContain("thinking about the auth flow");
		expect(narrow).not.toMatch(/\bread\b/);
		expect(narrow).not.toMatch(/\bgrep\b/);
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("does not auto-complete a todo when status is completed but completionKind is budget_stop", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		mode.todoPhases = [{ name: "Work", tasks: [{ content: "Review the change", status: "in_progress" }] }];
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("BudgetStopReviewer", 0, "Review the change", true),
			status: "completed",
			completionKind: "budget_stop",
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		expect(mode.todoPhases[0]?.tasks[0]?.status).toBe("in_progress");
	});

	it("repaints the detached HUD at a bounded low frequency and stops after stop()", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: withLivePhase(
				makeProgress({
					id: "AuthLoader",
					description: "Refactor the auth flow",
					recentTools: [{ tool: "read", args: "src/auth.ts", endMs: now }],
				}),
				{ activityPhase: "working", lastActivityAtMs: now - 30_000 },
			),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		// The coalesced observer flush drew the row exactly once.
		expect(requestRender).toHaveBeenCalledTimes(1);
		const first = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(first).toContain("working");
		expect(first).toContain("30.0s no new events");

		// The low-frequency ticker repaints without new progress events, so
		// silence/elapsed keep advancing; it never emits worker activity.
		vi.advanceTimersByTime(SUBAGENT_HUD_REFRESH_MS);
		expect(requestRender).toHaveBeenCalledTimes(2);

		// stop() clears the ticker: no repaints past this point.
		mode.stop();
		const settled = requestRender.mock.calls.length;
		vi.advanceTimersByTime(10_000);
		expect(requestRender.mock.calls.length).toBe(settled);
	});

	it("clears the HUD ticker once no detached active rows remain", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: withLivePhase(makeProgress({ id: "AuthLoader", description: "Refactor the auth flow" }), {
				activityPhase: "working",
				lastActivityAtMs: 5_000,
			}),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		expect(requestRender).toHaveBeenCalledTimes(1);

		// Completing the last detached subagent flushes a HUD with nothing to
		// keep alive, so the ticker clears itself instead of scheduling more
		// repaints.
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true),
			status: "completed",
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const afterComplete = requestRender.mock.calls.length;
		vi.advanceTimersByTime(10_000);
		expect(requestRender.mock.calls.length).toBe(afterComplete);
	});

	it("renders phase and silence through InteractiveMode and keeps silence over history args", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", 0, "Refactor the auth flow", true));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("AuthLoader", 0, "Refactor the auth flow", true),
			progress: withLivePhase(
				makeProgress({
					id: "AuthLoader",
					description: "Refactor the auth flow",
					recentTools: [{ tool: "read", args: "src/auth.ts", endMs: now - 60_000 }],
				}),
				{ activityPhase: "working", lastActivityAtMs: now - 30_000 },
			),
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const wide = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(wide).toContain("AuthLoader: Refactor the auth flow");
		expect(wide).toContain("working");
		expect(wide).toContain("30.0s no new events");
		expect(wide).not.toContain("read");
		expect(wide).not.toContain("src/auth.ts");

		// Narrow rows: the stale history tool description never crowds out the
		// silence hint — phase + silence survive, tool args are dropped.
		const narrow = Bun.stripANSI(mode.subagentContainer.render(42).join("\n"));
		expect(narrow).toContain("working");
		expect(narrow).toContain("no new events");
		expect(narrow).not.toContain("src/auth.ts");
		for (const line of narrow.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(42);
		}
	});
});

describe("SessionObserverRegistry completionKind", () => {
	it("stores budget_stop instead of treating the lifecycle as ordinary completed", () => {
		const registry = new SessionObserverRegistry();
		const eventBus = new EventBus();
		registry.subscribeToEventBus(eventBus, eventBus);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("ForcedYield", 1, "Forced yield", true),
			status: "completed",
			completionKind: "budget_stop",
		});
		const observed = registry.getSession("ForcedYield");
		expect(observed?.status).toBe("completed");
		expect(observed?.completionKind).toBe("budget_stop");
	});
});
