/**
 * TurnRecovery integration for edit-failure escalation:
 * apply failure stays re-triggerable; modelFallback off skips swap; non-edit
 * failures do not trigger; success clears the streak.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

function createHost(
	model: Model,
	modelRegistry: ModelRegistry,
	options: {
		modelFallback?: boolean;
		modelRoles?: Record<string, string>;
		cwd?: string;
	} = {},
): TurnRecoveryHost & { activeModel: Model } {
	const settings = Settings.isolated({
		"retry.modelFallback": options.modelFallback !== false,
		...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
	});
	if (options.modelRoles) {
		for (const [role, selector] of Object.entries(options.modelRoles)) {
			settings.setModelRole(role, selector);
		}
	}
	const state = { activeModel: model };
	const host: TurnRecoveryHost & { activeModel: Model } = {
		activeModel: model,
		agent: { state: { messages: [] }, replaceMessages() {} } as never,
		sessionManager: {
			getCwd: () => options.cwd ?? "/tmp/edit-escalation-test",
			getLastModelChangeRole: () => undefined,
			appendModelChange: () => {},
			getSessionId: () => "edit-escalation-session",
			getStorage: () => undefined,
		} as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => state.activeModel,
		contextFitsModel: () => true,
		textOutputCommitted: () => true,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		promptSequence: () => 0,
		sessionId: () => "edit-escalation-session",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async next => {
			state.activeModel = next;
			host.activeModel = next;
		},
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => ({ restored: false }),
		runAutoCompaction: async () =>
			({ deferredHandoff: false, continuationScheduled: false }) as RecoveryCompactionResult,
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: async <T>(operation: () => T | Promise<T>): Promise<T> => operation(),
	};
	return host;
}

describe("TurnRecovery edit-failure escalation", () => {
	const worker = getBundledModel("openai", "gpt-4o-mini");
	const top = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!worker || !top) throw new Error("Expected bundled models for edit-failure escalation tests");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-edit-escalation-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), {
			settings: Settings.isolated(),
		});
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("keeps escalate re-triggerable when apply fails, then marks after success", async () => {
		const host = createHost(worker, modelRegistry, {
			modelRoles: {
				slow: `${top.provider}/${top.id}`,
				default: `${top.provider}/${top.id}`,
			},
		});
		const recovery = new TurnRecovery(host);
		const session = {};
		const args = { path: "src/fail.ts" };
		expect(
			recovery.noteEditToolOutcome(session, { toolName: "edit", isError: true, toolArgs: args })?.escalateToTop,
		).toBe(false);
		const atThreshold = recovery.noteEditToolOutcome(session, {
			toolName: "edit",
			isError: true,
			toolArgs: args,
			escalateAvailable: false,
		});
		expect(atThreshold?.escalateToTop).toBe(true);
		expect(atThreshold?.advisory).toContain("Re-read");
		expect(atThreshold?.advisory).not.toContain("Escalating");

		// Force apply to fail by clearing auth mid-flight.
		authStorage.keys.removeRuntime("anthropic");
		expect(await recovery.escalateEditFailuresToTopModel({ reason: "test-fail" })).toBe(false);
		expect(host.model()).toBe(worker);
		// Still re-triggerable.
		expect(
			recovery.noteEditToolOutcome(session, { toolName: "edit", isError: true, toolArgs: args })?.escalateToTop,
		).toBe(true);

		authStorage.keys.setRuntime("anthropic", "test-key");
		expect(await recovery.escalateEditFailuresToTopModel({ reason: "test-ok" })).toBe(true);
		recovery.markEditFailureEscalated(session, atThreshold!.path);
		expect(
			recovery.noteEditToolOutcome(session, { toolName: "edit", isError: true, toolArgs: args })?.escalateToTop,
		).toBe(false);
		expect(host.model()?.provider).toBe(top.provider);
	});

	it("does not escalate when retry.modelFallback is false", async () => {
		const host = createHost(worker, modelRegistry, {
			modelFallback: false,
			modelRoles: { slow: `${top.provider}/${top.id}` },
		});
		const recovery = new TurnRecovery(host);
		const session = {};
		recovery.noteEditToolOutcome(session, { toolName: "edit", isError: true, toolArgs: { path: "a.ts" } });
		const atThreshold = recovery.noteEditToolOutcome(session, {
			toolName: "edit",
			isError: true,
			toolArgs: { path: "a.ts" },
			escalateAvailable: false,
		});
		expect(atThreshold?.advisory).toContain("Re-read");
		expect(atThreshold?.advisory).not.toContain("Escalating");
		expect(await recovery.escalateEditFailuresToTopModel()).toBe(false);
		expect(host.model()).toBe(worker);
	});

	it("ignores non-edit tool failures", () => {
		const host = createHost(worker, modelRegistry);
		const recovery = new TurnRecovery(host);
		const session = {};
		expect(
			recovery.noteEditToolOutcome(session, {
				toolName: "bash",
				isError: true,
				toolArgs: { command: "false" },
			}),
		).toBeUndefined();
		expect(
			recovery.noteEditToolOutcome(session, {
				toolName: "bash",
				isError: true,
				toolArgs: { command: "false" },
			}),
		).toBeUndefined();
	});

	it("clears the streak on a successful edit", () => {
		const host = createHost(worker, modelRegistry);
		const recovery = new TurnRecovery(host);
		const session = {};
		const args = { path: "ok.ts" };
		recovery.noteEditToolOutcome(session, { toolName: "edit", isError: true, toolArgs: args });
		expect(
			recovery.noteEditToolOutcome(session, { toolName: "edit", isError: true, toolArgs: args })?.escalateToTop,
		).toBe(true);
		expect(
			recovery.noteEditToolOutcome(session, { toolName: "edit", isError: false, toolArgs: args }),
		).toBeUndefined();
		expect(recovery.noteEditToolOutcome(session, { toolName: "edit", isError: true, toolArgs: args })?.count).toBe(1);
	});
});
