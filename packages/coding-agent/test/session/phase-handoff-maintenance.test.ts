/**
 * W6 — phase-handoff maintenance wiring.
 *
 * Failure modes: flag off still mutates context; missing retain still drops bulky;
 * claimedLiveWin true; SessionMaintenance.observePhaseHandoffBoundary dead.
 */
import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
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
		sessionId: () => "phase-handoff-test",
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

const retainedOk = {
	openConstraints: ["keep API"],
	modificationState: ["edited foo.ts"],
	acceptanceBasis: ["tests pass"],
	failedAttempts: ["first lint fail"],
	artifactLocators: ["artifact://9"],
};

describe("phase-handoff SessionMaintenance wiring", () => {
	it("flag off → observePhaseHandoffBoundary returns undefined (production unchanged)", () => {
		const manager = SessionManager.inMemory();
		const maintenance = createMaintenance(Settings.isolated({ "compaction.enabled": false }), manager);
		const result = maintenance.observePhaseHandoffBoundary({
			fromPhase: "research",
			toPhase: "implement",
			carried: { bulkyCarry: ["dump"], retained: retainedOk },
		});
		expect(result).toBeUndefined();
	});

	it("flag on → persists shadow/apply custom entry; treatment drops bulky at boundary", () => {
		const manager = SessionManager.inMemory();
		const maintenance = createMaintenance(
			Settings.isolated({
				"compaction.enabled": false,
				"deliveryExperiment.phaseHandoff.enabled": true,
				"deliveryExperiment.phaseHandoff.factor": "phase_boundary_carry_slim",
			}),
			manager,
		);

		const result = maintenance.observePhaseHandoffBoundary({
			fromPhase: "research",
			toPhase: "implement",
			carried: {
				bulkyCarry: ["huge transcript", "old dump"],
				retained: retainedOk,
			},
		});
		expect(result).toBeTruthy();
		expect(result!.shadow.boundaryDetected).toBe(true);
		expect(result!.apply.applied).toBe(true);
		expect(result!.shouldRewriteContext).toBe(true);
		expect(result!.claimedLiveWin).toBe(false);
		expect(result!.bulkyCarry).toEqual([]);

		const customs = manager
			.getBranch()
			.filter(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" && e.customType === PHASE_HANDOFF_MAINTENANCE_CUSTOM_TYPE,
			);
		expect(customs.length).toBeGreaterThanOrEqual(1);
		expect((customs[0]!.data as { claimedLiveWin: boolean }).claimedLiveWin).toBe(false);
	});
});
