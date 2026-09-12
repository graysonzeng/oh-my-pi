import { afterEach, describe, expect, it, vi } from "bun:test";
import * as agentCore from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Settings } from "../../src/config/settings";
import { WorkflowCancelledError } from "../../src/workflow/errors";
import { createSessionPipelineAuditor } from "../../src/workflow/pipeline-auditor";

afterEach(() => {
	vi.restoreAllMocks();
});

function flashModel(): Model {
	return buildModel({
		id: "deepseek-v4-flash",
		name: "deepseek-v4-flash",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	});
}

function assistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	const model = flashModel();
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function host() {
	return {
		settings: { get: () => undefined } as unknown as Settings,
		modelRegistry: {
			getAvailable: () => [flashModel()],
			getApiKey: async () => "test-key",
		},
	};
}

describe("pipeline completeness auditor abort", () => {
	it("aborted stopReason cancels instead of fail-closed incomplete", async () => {
		vi.spyOn(agentCore, "instrumentedCompleteSimple").mockResolvedValue(assistant("aborted"));
		const auditor = createSessionPipelineAuditor(host());
		await expect(auditor({ kind: "plan", request: "ship" })).rejects.toBeInstanceOf(WorkflowCancelledError);
	});

	it("pre-aborted signal cancels without a model call", async () => {
		const spy = vi.spyOn(agentCore, "instrumentedCompleteSimple");
		const auditor = createSessionPipelineAuditor(host());
		const controller = new AbortController();
		controller.abort();
		await expect(auditor({ kind: "plan", request: "ship", signal: controller.signal })).rejects.toBeInstanceOf(
			WorkflowCancelledError,
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("provider error still fail-closes as incomplete", async () => {
		vi.spyOn(agentCore, "instrumentedCompleteSimple").mockResolvedValue(assistant("error"));
		const auditor = createSessionPipelineAuditor(host());
		await expect(auditor({ kind: "plan", request: "ship" })).resolves.toEqual({
			complete: false,
			missing: ["pipeline_auditor_unavailable"],
			next: "Provide a complete executable request.",
		});
	});
});
