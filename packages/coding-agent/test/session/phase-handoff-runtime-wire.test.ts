/**
 * W6 — phase-handoff production carry + maintenance rewrite wiring.
 *
 * Failure modes: flag off still mutates; unknown→unknown theater; shouldRewrite
 * discarded (shake never called); incomplete tool pairs silently dropped;
 * missing retain still rewrites; same boundary re-shaken; status lies.
 */
import { describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import {
	buildPhaseHandoffCarriedFromBranch,
	inferPhaseHandoffPhase,
	phaseHandoffHasIncompleteToolPairs,
	phaseHandoffRewriteAlreadyApplied,
	resolvePhaseHandoffBoundaryObservation,
} from "../../src/session/phase-handoff-carry";
import { PHASE_HANDOFF_MAINTENANCE_CUSTOM_TYPE } from "../../src/session/phase-handoff-maintenance";
import { SessionMaintenance, type SessionMaintenanceHost } from "../../src/session/session-maintenance";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function createMaintenance(settings: Settings, manager: SessionManager): SessionMaintenance {
	const model = createMockModel({ provider: "anthropic", responses: [{ content: ["ok"] }] });
	const agent = new Agent({
		initialState: { model, systemPrompt: [], tools: [], messages: [] },
		streamFn: model.stream,
	});
	const host = {
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
		extensionRunner: undefined,
		sideStreamFn: model.stream,
		providerSessionState: new Map(),
		preferWebsockets: () => undefined,
		model: () => model,
		thinkingLevel: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isGeneratingHandoff: () => false,
		promptGeneration: () => 0,
		sessionId: () => "phase-handoff-wire-test",
		messages: () => agent.state.messages,
		baseSystemPrompt: () => [],
		goalModeState: () => undefined,
		planReferencePath: () => "",
		nonMessageTokenSource: () => ({ getNonMessageTokens: () => 0 }),
		hasExperimentalContextRolloverTools: () => false,
		takeExperimentalContextRolloverRequest: () => false,
		queueExperimentalContextNotesReminder: () => {},
		memoryBackendSession: () => ({}),
		emitSessionEvent: async () => {},
		emitNotice: () => {},
		schedulePostPromptTask: () => {},
		scheduleAgentContinue: () => {},
		scheduleCompactionContinuation: () => false,
		persistTurnMessagesForMidRunCompaction: async () => false,
		findLastAssistantMessage: () => undefined,
		disconnectFromAgent: () => {},
		reconnectToAgent: () => {},
		drainStrandedQueuedMessages: () => {},
		buildDisplaySessionContext: () => ({}),
		convertToLlmForSideRequest: () => [],
		obfuscateTextForProvider: (text: string | undefined) => text,
		obfuscatePreparationForProvider: (preparation: unknown) => preparation,
		closeCodexProviderSessionsForHistoryRewrite: () => {},
		resetCodexProviderAfterCompaction: () => {},
		resetPlanReference: () => {},
		syncTodoPhasesFromBranch: () => {},
		resetAdvisorRuntimes: () => {},
		rebaseAdvisorPrefix: () => {},
		rebaseAfterCompaction: () => {},
		recordAnchoredHistoryRewrite: () => {},
		getContextBreakdown: () => undefined,
		getContextUsage: () => undefined,
		shake: async () => ({ removed: 0 }),
		dropImages: async () => ({ removed: 0 }),
		generateHandoffDocument: async () => undefined,
		removeAssistantMessageFromActiveContext: () => {},
		dropPersistedAssistantTurn: async () => undefined,
		runRecoveryCompactionWithRollback: async () => ({
			deferredHandoff: false,
			continuationScheduled: false,
		}),
		parseRetryAfterMsFromError: () => undefined,
		setModelTemporary: async () => {},
		abort: () => {},
		abortHandoff: () => {},
	} as unknown as SessionMaintenanceHost;
	return new SessionMaintenance(host);
}

function appendResearchThenImplement(manager: SessionManager): void {
	manager.appendMessage({
		role: "user",
		content: "investigate then fix",
		timestamp: 1,
	});
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "tc_read", name: "read", arguments: { path: "src/a.ts" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "tc_read",
		toolName: "read",
		content: [{ type: "text", text: "x".repeat(3_000) }],
		isError: false,
		timestamp: 3,
	});
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "tc_edit", name: "edit", arguments: { path: "src/a.ts" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 4,
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "tc_edit",
		toolName: "edit",
		content: [{ type: "text", text: "edited" }],
		isError: false,
		timestamp: 5,
	});
}

function seedRetainedExtras(manager: SessionManager): void {
	manager.appendCustomEntry("user_todo_edit", {
		phases: [
			{
				name: "Research",
				tasks: [{ content: "map callers", status: "completed" }],
			},
			{
				name: "Implement",
				tasks: [{ content: "keep API stable", status: "in_progress" }],
			},
			{
				name: "Verify",
				tasks: [{ content: "tests pass", status: "pending" }],
			},
		],
	});
	manager.appendCustomEntry("parent_final_verification", {
		status: "failed",
		source: "extension",
		v: 1,
		authority: "extension",
		acceptanceContract: { items: ["tests pass", "API compat"] },
		evidenceRefs: ["artifact://retain-9"],
	});
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "tc_fail", name: "bash", arguments: { command: "bun run lint" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 6,
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "tc_fail",
		toolName: "bash",
		content: [{ type: "text", text: "FAIL lint" }],
		isError: true,
		timestamp: 7,
	});
}

describe("phase-handoff carry builders", () => {
	it("infers research→implement boundary and builds semantic retain (not three arrays only)", () => {
		const manager = SessionManager.inMemory();
		appendResearchThenImplement(manager);
		seedRetainedExtras(manager);
		const branch = manager.getBranch();

		expect(inferPhaseHandoffPhase(branch)).toBe("implement");
		const boundary = resolvePhaseHandoffBoundaryObservation(branch);
		expect(boundary.fromPhase).toBe("research");
		expect(boundary.toPhase).toBe("implement");
		expect(boundary.boundaryKey).toBe("research->implement");

		const carried = buildPhaseHandoffCarriedFromBranch(branch);
		expect(carried.retained.openConstraints.some(s => s.includes("keep API stable"))).toBe(true);
		expect(carried.retained.modificationState.some(s => s.includes("src/a.ts"))).toBe(true);
		expect(carried.retained.acceptanceBasis).toEqual(expect.arrayContaining(["tests pass", "API compat"]));
		expect(carried.retained.failedAttempts?.some(s => s.includes("FAIL lint"))).toBe(true);
		expect(carried.retained.artifactLocators).toEqual(expect.arrayContaining(["artifact://retain-9"]));
		expect(carried.bulkyCarry.some(s => s.includes("tc_read"))).toBe(true);
		expect(phaseHandoffHasIncompleteToolPairs(carried.retained)).toBe(false);
	});

	it("flags incomplete tool pairs so rewrite must fail open", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "tc_pending", name: "edit", arguments: { path: "x.ts" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		});
		const carried = buildPhaseHandoffCarriedFromBranch(manager.getBranch());
		expect(phaseHandoffHasIncompleteToolPairs(carried.retained)).toBe(true);
		expect(carried.retained.incompleteTools?.some(s => s.includes("tc_pending"))).toBe(true);
	});
});

describe("applyPhaseHandoffAtMaintenanceBoundary production wire", () => {
	it("flag off → no observe custom entry and no shake (production unchanged)", async () => {
		const manager = SessionManager.inMemory();
		appendResearchThenImplement(manager);
		seedRetainedExtras(manager);
		const maintenance = createMaintenance(Settings.isolated({ "compaction.enabled": false }), manager);
		const shakeSpy = vi.spyOn(maintenance, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 0,
			blocksDropped: 0,
			tokensFreed: 0,
		});

		const result = await maintenance.applyPhaseHandoffAtMaintenanceBoundary();
		expect(result.observed).toBe(false);
		expect(result.rewritten).toBe(false);
		expect(shakeSpy).not.toHaveBeenCalled();
		const customs = manager
			.getBranch()
			.filter(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" && e.customType === PHASE_HANDOFF_MAINTENANCE_CUSTOM_TYPE,
			);
		expect(customs).toHaveLength(0);
	});

	it("flag on + boundary + retain → consumes shouldRewriteContext via shake(elide)", async () => {
		const manager = SessionManager.inMemory();
		appendResearchThenImplement(manager);
		seedRetainedExtras(manager);
		const maintenance = createMaintenance(
			Settings.isolated({
				"compaction.enabled": false,
				"deliveryExperiment.phaseHandoff.enabled": true,
				"deliveryExperiment.phaseHandoff.factor": "phase_boundary_carry_slim",
			}),
			manager,
		);
		const shakeSpy = vi.spyOn(maintenance, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 2,
			blocksDropped: 0,
			tokensFreed: 4_200,
			artifactId: "shake-art-1",
		});

		const result = await maintenance.applyPhaseHandoffAtMaintenanceBoundary();
		expect(result.observed).toBe(true);
		expect(result.shouldRewriteContext).toBe(true);
		expect(result.rewritten).toBe(true);
		expect(shakeSpy).toHaveBeenCalledTimes(1);
		expect(shakeSpy.mock.calls[0]![0]).toBe("elide");

		const customs = manager
			.getBranch()
			.filter(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" && e.customType === PHASE_HANDOFF_MAINTENANCE_CUSTOM_TYPE,
			);
		expect(customs.length).toBeGreaterThanOrEqual(1);
		const data = customs.at(-1)!.data as {
			rewriteApplied: boolean;
			rewriteTokensFreed: number;
			claimedLiveWin: boolean;
			boundaryKey: string;
			shouldRewriteContext: boolean;
		};
		expect(data.rewriteApplied).toBe(true);
		expect(data.rewriteTokensFreed).toBe(4_200);
		expect(data.claimedLiveWin).toBe(false);
		expect(data.boundaryKey).toBe("research->implement");
		expect(phaseHandoffRewriteAlreadyApplied(manager.getBranch(), "research->implement")).toBe(true);
	});

	it("missing required retain → fail open, no shake", async () => {
		const manager = SessionManager.inMemory();
		// research→implement tools but no constraints / acceptance / recovery
		appendResearchThenImplement(manager);
		const maintenance = createMaintenance(
			Settings.isolated({
				"compaction.enabled": false,
				"deliveryExperiment.phaseHandoff.enabled": true,
				"deliveryExperiment.phaseHandoff.factor": "phase_boundary_carry_slim",
			}),
			manager,
		);
		const shakeSpy = vi.spyOn(maintenance, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 1,
			blocksDropped: 0,
			tokensFreed: 100,
		});

		const result = await maintenance.applyPhaseHandoffAtMaintenanceBoundary();
		expect(result.rewritten).toBe(false);
		expect(result.shouldRewriteContext).toBe(false);
		expect(shakeSpy).not.toHaveBeenCalled();
	});

	it("incomplete tool pairs → fail open, no shake (no silent drop)", async () => {
		const manager = SessionManager.inMemory();
		appendResearchThenImplement(manager);
		seedRetainedExtras(manager);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "tc_open", name: "edit", arguments: { path: "y.ts" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 20,
		});
		const maintenance = createMaintenance(
			Settings.isolated({
				"compaction.enabled": false,
				"deliveryExperiment.phaseHandoff.enabled": true,
				"deliveryExperiment.phaseHandoff.factor": "phase_boundary_carry_slim",
			}),
			manager,
		);
		const shakeSpy = vi.spyOn(maintenance, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 9,
			blocksDropped: 0,
			tokensFreed: 9_000,
		});

		const result = await maintenance.applyPhaseHandoffAtMaintenanceBoundary();
		expect(result.rewriteSkippedReason).toBe("incomplete_tool_pairs");
		expect(result.rewritten).toBe(false);
		expect(shakeSpy).not.toHaveBeenCalled();
	});

	it("idempotent: second apply on same boundary does not shake again", async () => {
		const manager = SessionManager.inMemory();
		appendResearchThenImplement(manager);
		seedRetainedExtras(manager);
		const maintenance = createMaintenance(
			Settings.isolated({
				"compaction.enabled": false,
				"deliveryExperiment.phaseHandoff.enabled": true,
				"deliveryExperiment.phaseHandoff.factor": "phase_boundary_carry_slim",
			}),
			manager,
		);
		const shakeSpy = vi.spyOn(maintenance, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 1,
			blocksDropped: 0,
			tokensFreed: 500,
			artifactId: "a1",
		});

		const first = await maintenance.applyPhaseHandoffAtMaintenanceBoundary();
		expect(first.rewritten).toBe(true);
		expect(shakeSpy).toHaveBeenCalledTimes(1);

		const second = await maintenance.applyPhaseHandoffAtMaintenanceBoundary();
		// Second pass must not shake again (already_rewritten or silent no-op).
		expect(second.rewritten).toBe(false);
		expect(shakeSpy).toHaveBeenCalledTimes(1);
		if (second.rewriteSkippedReason !== undefined) {
			expect(second.rewriteSkippedReason).toBe("already_rewritten");
		}
	});

	it("shake failure fails open without claiming rewrite", async () => {
		const manager = SessionManager.inMemory();
		appendResearchThenImplement(manager);
		seedRetainedExtras(manager);
		const maintenance = createMaintenance(
			Settings.isolated({
				"compaction.enabled": false,
				"deliveryExperiment.phaseHandoff.enabled": true,
				"deliveryExperiment.phaseHandoff.factor": "phase_boundary_carry_slim",
			}),
			manager,
		);
		vi.spyOn(maintenance, "shake").mockRejectedValue(new Error("persist boom"));

		const result = await maintenance.applyPhaseHandoffAtMaintenanceBoundary();
		expect(result.shouldRewriteContext).toBe(true);
		expect(result.rewritten).toBe(false);
		expect(result.rewriteSkippedReason).toBe("shake_failed_open");
	});
});
