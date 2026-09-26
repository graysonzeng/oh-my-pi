import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildCredentialRouteKey,
	resetSharedCredentialRouteUnavailableRegistryForTests,
	sharedCredentialRouteUnavailableRegistry,
} from "@oh-my-pi/pi-coding-agent/latency/credential-route-unavailable";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAuthFailure(model: Model, errorMessage: string): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage,
		errorStatus: 401,
		timestamp: Date.now(),
	};
	message.errorId = AIError.classifyMessage(message);
	return message;
}

function createHost(
	model: Model,
	modelRegistry: ModelRegistry,
	fallbackChains: Record<string, string[]>,
): TurnRecoveryHost {
	const settings = Settings.isolated({
		"retry.enabled": true,
		"retry.modelFallback": true,
		"retry.fallbackChains": fallbackChains,
	});
	const agentState = { messages: [] as AssistantMessage[] };
	return {
		agent: {
			state: agentState,
			replaceMessages(messages: AssistantMessage[]) {
				agentState.messages = messages;
			},
		} as never,
		sessionManager: {
			getLastModelChangeRole: () => undefined,
		} as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => model,
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
		sessionId: () => "s0-cred-route",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => false,
		runAutoCompaction: async () =>
			({ deferredHandoff: false, continuationScheduled: false }) as RecoveryCompactionResult,
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: async <T>(operation: () => T | Promise<T>): Promise<T> => operation(),
	};
}

describe("TurnRecovery credential-route unavailable (S0)", () => {
	const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
	const sibling = getBundledModel("anthropic", "claude-haiku-4-5");
	const otherProvider = getBundledModel("openai", "gpt-4o-mini");
	if (!primary || !sibling || !otherProvider) {
		throw new Error("Expected bundled models for S0 recovery fixtures");
	}

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-s0-cred-route-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), {
			settings: Settings.isolated(),
		});
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(() => {
		resetSharedCredentialRouteUnavailableRegistryForTests();
	});

	it("stops same-provider hard-error fallback after config auth failure", () => {
		const recovery = new TurnRecovery(
			createHost(primary, modelRegistry, {
				[`${primary.provider}/${primary.id}`]: [`${sibling.provider}/${sibling.id}`],
			}),
		);
		const message = makeAuthFailure(primary, "401 invalid api key");
		expect(recovery.isRetryableError(message)).toBe(false);
		recovery.noteConfigCredentialRouteFailure(message);
		expect(
			sharedCredentialRouteUnavailableRegistry().isUnavailable(
				buildCredentialRouteKey({ provider: primary.provider, providerScoped: true }),
			),
		).toBe(true);
		// Sibling on the same dead credential must not keep the chain alive.
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps a healthy cross-provider fallback eligible after config auth failure", () => {
		const recovery = new TurnRecovery(
			createHost(primary, modelRegistry, {
				[`${primary.provider}/${primary.id}`]: [`${otherProvider.provider}/${otherProvider.id}`],
			}),
		);
		const message = makeAuthFailure(primary, "503 auth_unavailable: no auth available");
		recovery.noteConfigCredentialRouteFailure(message);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("does not mark transport failures and leaves hard-error fallback unchanged", () => {
		const recovery = new TurnRecovery(
			createHost(primary, modelRegistry, {
				[`${primary.provider}/${primary.id}`]: [`${sibling.provider}/${sibling.id}`],
			}),
		);
		const message: AssistantMessage = {
			...makeAuthFailure(primary, "stream stall: idle timeout"),
			errorStatus: 503,
		};
		message.errorId = AIError.classifyMessage(message);
		recovery.noteConfigCredentialRouteFailure(message);
		expect(
			sharedCredentialRouteUnavailableRegistry().isUnavailable(
				buildCredentialRouteKey({ provider: primary.provider, providerScoped: true }),
			),
		).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("clears marks so a recovered route can resume", () => {
		const recovery = new TurnRecovery(
			createHost(primary, modelRegistry, {
				[`${primary.provider}/${primary.id}`]: [`${sibling.provider}/${sibling.id}`],
			}),
		);
		const message = makeAuthFailure(primary, "401 invalid api key");
		recovery.noteConfigCredentialRouteFailure(message);
		recovery.clearConfigCredentialRouteFailure();
		expect(
			sharedCredentialRouteUnavailableRegistry().isUnavailable(
				buildCredentialRouteKey({ provider: primary.provider, providerScoped: true }),
			),
		).toBe(false);
	});
});
