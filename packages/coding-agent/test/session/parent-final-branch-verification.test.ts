/**
 * Ordinary cohort verification must use the active branch's parent-final receipt.
 *
 * Failure mode: a later-inserted receipt on an abandoned branch is the last
 * match in getEntries(), so session-end cohort verification reports that
 * abandoned passed/failed outcome instead of the active path (unknown, or the
 * receipt actually on the branch).
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { freezeLatencyArmSnapshot } from "../../src/latency/arms";
import {
	buildParentFinalVerificationDetails,
	PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
} from "../../src/latency/parent-final-verification";
import { defaultLatencyRolloutCohortFile, LatencyRolloutCohortStore } from "../../src/latency/rollout-cohort";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function appendMinimalAssistantMessage(manager: SessionManager, text = "ok"): void {
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "mock",
		api: "anthropic-messages",
		content: [{ type: "text", text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

async function ordinaryVerifier(manager: SessionManager): Promise<{ source: string; status: string } | undefined> {
	using tempDir = TempDir.createSync("@omp-parent-final-");
	const auth = createInMemoryAuthStorage();
	try {
		appendMinimalAssistantMessage(manager);
		const model = createMockModel({ provider: "anthropic", responses: [{ content: ["ok"] }] });
		const agent = new Agent({
			initialState: { model, systemPrompt: [], tools: [], messages: [] },
			streamFn: model.stream,
		});
		const store = new LatencyRolloutCohortStore(tempDir.join("cohort.jsonl"));
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(auth),
			latencyArmSnapshot: freezeLatencyArmSnapshot({ frozenAt: "2026-09-26T00:00:00.000Z" }),
			latencyRolloutStore: store,
		});
		await session.dispose();
		return store.readAll().at(-1)?.verifier ?? undefined;
	} finally {
		auth.close();
	}
}

describe("parent-final verification branch isolation", () => {
	it("keeps an abandoned passed receipt from marking a receipt-free active branch accepted", async () => {
		const manager = SessionManager.inMemory();
		const anchorId = manager.appendCustomEntry("anchor", { n: 1 });
		manager.appendCustomEntry(
			PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
			buildParentFinalVerificationDetails("passed", "extension", 2_000),
		);
		await manager.branch(anchorId);

		const verifier = await ordinaryVerifier(manager);
		expect(verifier).toEqual({ source: "unknown", status: "unknown" });
	});

	it("uses the active branch receipt when a later abandoned branch recorded the opposite outcome", async () => {
		const manager = SessionManager.inMemory();
		const anchorId = manager.appendCustomEntry("anchor", { n: 1 });
		const activeReceiptId = manager.appendCustomMessageEntry(
			PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
			"parent final verification: failed",
			false,
			buildParentFinalVerificationDetails("failed", "extension", 1_000),
			"agent",
			1_000,
		);
		await manager.branch(anchorId);
		manager.appendCustomEntry(
			PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
			buildParentFinalVerificationDetails("passed", "extension", 2_000),
		);
		await manager.branch(activeReceiptId);

		const verifier = await ordinaryVerifier(manager);
		expect(verifier).toEqual({ source: "extension", status: "failed" });
	});

	it("skips default cohort file creation when no latencyRolloutStore is configured", async () => {
		using tempDir = TempDir.createSync("@omp-parent-final-nostore-");
		const auth = createInMemoryAuthStorage();
		const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(tempDir.path());
		try {
			const model = createMockModel({ provider: "anthropic", responses: [{ content: ["ok"] }] });
			const agent = new Agent({
				initialState: { model, systemPrompt: [], tools: [], messages: [] },
				streamFn: model.stream,
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(auth),
				latencyArmSnapshot: freezeLatencyArmSnapshot({ frozenAt: "2026-09-26T00:00:00.000Z" }),
			});
			await session.dispose();
			const defaultCohortPath = path.join(
				tempDir.path(),
				".omp",
				"workflow-artifacts",
				"latency-rollout-cohort.jsonl",
			);
			expect(fs.existsSync(defaultCohortPath)).toBe(false);
		} finally {
			homeSpy.mockRestore();
			auth.close();
		}
	});

	it("skips rollout recording when sessionManager is owned elsewhere", async () => {
		using tempDir = TempDir.createSync("@omp-parent-final-owned-");
		const auth = createInMemoryAuthStorage();
		try {
			const manager = SessionManager.inMemory();
			vi.spyOn(manager, "isOwnedElsewhere").mockReturnValue(true);
			const model = createMockModel({ provider: "anthropic", responses: [{ content: ["ok"] }] });
			const agent = new Agent({
				initialState: { model, systemPrompt: [], tools: [], messages: [] },
				streamFn: model.stream,
			});
			const store = new LatencyRolloutCohortStore(tempDir.join("cohort.jsonl"));
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(auth),
				latencyArmSnapshot: freezeLatencyArmSnapshot({ frozenAt: "2026-09-26T00:00:00.000Z" }),
				latencyRolloutStore: store,
			});
			await session.dispose();
			expect(store.readAll()).toHaveLength(0);
		} finally {
			vi.restoreAllMocks();
			auth.close();
		}
	});

	it("records rollout observation once with preserved exitKind across postmortem and dispose", async () => {
		using tempDir = TempDir.createSync("@omp-parent-final-postmortem-");
		const auth = createInMemoryAuthStorage();
		let capturedExitCb: ((reason: postmortem.Reason) => void | Promise<void>) | undefined;
		const origRegister = postmortem.register.bind(postmortem);
		const registerSpy = vi.spyOn(postmortem, "register").mockImplementation((id, callback, options) => {
			if (id.startsWith("agent-session:")) capturedExitCb = callback;
			return origRegister(id, callback, options);
		});
		try {
			const manager = SessionManager.inMemory();
			appendMinimalAssistantMessage(manager, "partial work");
			const model = createMockModel({ provider: "anthropic", responses: [{ content: ["ok"] }] });
			const agent = new Agent({
				initialState: { model, systemPrompt: [], tools: [], messages: [] },
				streamFn: model.stream,
			});
			const store = new LatencyRolloutCohortStore(tempDir.join("cohort.jsonl"));
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(auth),
				latencyArmSnapshot: freezeLatencyArmSnapshot({ frozenAt: "2026-09-26T00:00:00.000Z" }),
				latencyRolloutStore: store,
			});
			expect(capturedExitCb).toBeDefined();
			await capturedExitCb?.(postmortem.Reason.SIGINT);
			await session.dispose();

			const records = store.readAll();
			expect(records).toHaveLength(1);
			expect(records[0]?.status).toBe("signal");
			expect(records[0]?.completed).toBe(false);
		} finally {
			registerSpy.mockRestore();
			auth.close();
		}
	});

	it("skips rollout recording when an empty session disposes without assistant messages or pending tool calls", async () => {
		using tempDir = TempDir.createSync("@omp-parent-final-empty-");
		const auth = createInMemoryAuthStorage();
		try {
			const model = createMockModel({ provider: "anthropic", responses: [{ content: ["ok"] }] });
			const agent = new Agent({
				initialState: { model, systemPrompt: [], tools: [], messages: [] },
				streamFn: model.stream,
			});
			const store = new LatencyRolloutCohortStore(tempDir.join("cohort.jsonl"));
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(auth),
				latencyArmSnapshot: freezeLatencyArmSnapshot({ frozenAt: "2026-09-26T00:00:00.000Z" }),
				latencyRolloutStore: store,
			});
			await session.dispose();
			expect(store.readAll()).toHaveLength(0);
		} finally {
			auth.close();
		}
	});

	it("degrades cleanly without hanging teardown when cohort observation or stop decision persistence fails", async () => {
		using tempDir = TempDir.createSync("@omp-parent-final-unwritable-");
		const auth = createInMemoryAuthStorage();
		const blockedParent = tempDir.join("blocked-parent");
		fs.writeFileSync(blockedParent, "not-a-directory\n");
		try {
			const managerObs = SessionManager.inMemory();
			appendMinimalAssistantMessage(managerObs);
			const modelA = createMockModel({ provider: "anthropic", responses: [{ content: ["ok"] }] });
			const agentA = new Agent({
				initialState: { model: modelA, systemPrompt: [], tools: [], messages: [] },
				streamFn: modelA.stream,
			});
			const obsFailStore = new LatencyRolloutCohortStore(path.join(blockedParent, "cohort.jsonl"));
			const sessionA = new AgentSession({
				agent: agentA,
				sessionManager: managerObs,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(auth),
				latencyArmSnapshot: freezeLatencyArmSnapshot({ frozenAt: "2026-09-26T00:00:00.000Z" }),
				latencyRolloutStore: obsFailStore,
			});
			await sessionA.dispose();
			expect(obsFailStore.controlPlaneDegraded).toBe(true);

			const managerStop = SessionManager.inMemory();
			appendMinimalAssistantMessage(managerStop);
			const modelB = createMockModel({ provider: "anthropic", responses: [{ content: ["ok"] }] });
			const agentB = new Agent({
				initialState: { model: modelB, systemPrompt: [], tools: [], messages: [] },
				streamFn: modelB.stream,
			});
			const stopFailStore = new LatencyRolloutCohortStore(path.join(blockedParent, "stop-cohort.jsonl"));
			vi.spyOn(stopFailStore, "appendObservation").mockReturnValueOnce(true);
			const unregisteredCombo = freezeLatencyArmSnapshot({
				frozenAt: "2026-09-26T00:00:00.000Z",
				arms: {
					context_optimization: true,
					read_dedupe: true,
					context_budget_tuning: false,
					role_static_split: false,
					bash_advisory: false,
					bash_bounded_injection: false,
					concurrency_declaration: false,
					concurrency_execution: false,
					eval_gate_migration: false,
					provider_health_breaker: false,
					adaptive_thinking_context: false,
					dsh_session_search: false,
					dsh_omit_goal_time: false,
					dsh_goal_hash_shadow: false,
					dsh_headless_continuation: false,
				},
			});
			const sessionB = new AgentSession({
				agent: agentB,
				sessionManager: managerStop,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(auth),
				latencyArmSnapshot: unregisteredCombo,
				latencyRolloutStore: stopFailStore,
			});
			await sessionB.dispose();
			expect(stopFailStore.controlPlaneDegraded).toBe(true);
		} finally {
			vi.restoreAllMocks();
			auth.close();
		}
	});

	it("directs defaultLatencyRolloutCohortFile() to a temp directory under bun test", () => {
		const cohortFile = defaultLatencyRolloutCohortFile();
		const prodDir = path.join(os.homedir(), ".omp", "workflow-artifacts");
		expect(cohortFile.startsWith(os.tmpdir())).toBe(true);
		expect(cohortFile.startsWith(prodDir)).toBe(false);
	});
});
