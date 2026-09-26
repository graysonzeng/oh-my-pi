import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildCredentialRouteKey,
	credentialRouteAuthScope,
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

function makeAuthFailure(model: Model, errorMessage: string, errorStatus = 401): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage,
		errorStatus,
		timestamp: Date.now(),
	};
	message.errorId = AIError.classifyMessage(message);
	return message;
}

function providerUnavailableKey(model: Model, storage: AuthStorage, sessionId = "s0-cred-route"): string {
	const scope = credentialRouteAuthScope({
		authStorage: storage,
		owner: storage,
		sessionId,
		provider: model.provider,
		baseUrl: model.baseUrl,
		accountIds: model.accountAccess ? Object.keys(model.accountAccess) : undefined,
	});
	if (!scope) throw new Error("expected an established credential-route scope");
	return buildCredentialRouteKey({ provider: model.provider, providerScoped: true, authScope: scope });
}

function createHost(
	model: Model,
	modelRegistry: ModelRegistry,
	fallbackChains: Record<string, string[]>,
	sessionId = "s0-cred-route",
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
		sessionId: () => sessionId,
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
		authStorage.keys.setRuntime("github-copilot", "test-key");
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
			sharedCredentialRouteUnavailableRegistry().isUnavailable(providerUnavailableKey(primary, authStorage)),
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
			sharedCredentialRouteUnavailableRegistry().isUnavailable(providerUnavailableKey(primary, authStorage)),
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
			sharedCredentialRouteUnavailableRegistry().isUnavailable(providerUnavailableKey(primary, authStorage)),
		).toBe(false);
	});

	it("does not block a different auth owner that shares the session id", async () => {
		const otherDir = TempDir.createSync("@pi-s0-cred-route-other-");
		const otherAuth = await AuthStorage.create(otherDir.join("testauth.db"));
		otherAuth.keys.setRuntime("anthropic", "other-key");
		const otherRegistry = new ModelRegistry(otherAuth, otherDir.join("models.yml"), {
			settings: Settings.isolated(),
		});
		try {
			const failed = new TurnRecovery(
				createHost(primary, modelRegistry, {
					[`${primary.provider}/${primary.id}`]: [`${sibling.provider}/${sibling.id}`],
				}),
			);
			const message = makeAuthFailure(primary, "401 invalid api key");
			failed.noteConfigCredentialRouteFailure(message);
			const other = new TurnRecovery(
				createHost(
					primary,
					otherRegistry,
					{ [`${primary.provider}/${primary.id}`]: [`${sibling.provider}/${sibling.id}`] },
					"s0-cred-route",
				),
			);
			expect(other.isHardErrorFallbackEligible(message)).toBe(true);
			expect(
				sharedCredentialRouteUnavailableRegistry().isUnavailable(providerUnavailableKey(primary, otherAuth)),
			).toBe(false);
		} finally {
			otherAuth.close();
			otherDir.removeSync();
		}
	});

	it("stops blocking the same owner after the runtime credential changes", () => {
		const recovery = new TurnRecovery(
			createHost(primary, modelRegistry, {
				[`${primary.provider}/${primary.id}`]: [`${sibling.provider}/${sibling.id}`],
			}),
		);
		const message = makeAuthFailure(primary, "401 invalid api key");
		recovery.noteConfigCredentialRouteFailure(message);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
		authStorage.keys.setRuntime("anthropic", "replaced-key");
		try {
			expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
		} finally {
			authStorage.keys.setRuntime("anthropic", "test-key");
		}
	});

	it("keeps a healthy same-provider sibling eligible after a model-policy denial", () => {
		const denied = getBundledModel("github-copilot", "claude-fable-5");
		const healthy = getBundledModel("github-copilot", "claude-haiku-4.5");
		if (!denied || !healthy) throw new Error("Expected bundled GitHub Copilot models");
		const chains = {
			[`${denied.provider}/${denied.id}`]: [`${healthy.provider}/${healthy.id}`],
		};
		const policy = new TurnRecovery(createHost(denied, modelRegistry, chains));
		const denial = makeAuthFailure(denied, "GitHub Copilot access denied (HTTP 403)", 403);
		policy.noteConfigCredentialRouteFailure(denial);
		expect(policy.isHardErrorFallbackEligible(denial)).toBe(true);
		expect(
			sharedCredentialRouteUnavailableRegistry().isUnavailable(providerUnavailableKey(denied, authStorage)),
		).toBe(false);
	});

	it("still blocks same-provider siblings after a real copilot auth failure", () => {
		const denied = getBundledModel("github-copilot", "claude-fable-5");
		const healthy = getBundledModel("github-copilot", "claude-haiku-4.5");
		if (!denied || !healthy) throw new Error("Expected bundled GitHub Copilot models");
		const revoked = new TurnRecovery(
			createHost(denied, modelRegistry, {
				[`${denied.provider}/${denied.id}`]: [`${healthy.provider}/${healthy.id}`],
			}),
		);
		const authFailure = makeAuthFailure(denied, "401 invalid api key");
		revoked.noteConfigCredentialRouteFailure(authFailure);
		expect(revoked.isHardErrorFallbackEligible(authFailure)).toBe(false);
	});
});
