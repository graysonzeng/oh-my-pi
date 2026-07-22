import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { RuntimeAdapter } from "../../src/workflow/runtime-adapter";
import type { WorkflowAgentRequest } from "../../src/workflow/types";

function createRequest(signal?: AbortSignal): WorkflowAgentRequest {
	return {
		workflowId: "wf_1",
		attemptId: "att_1",
		role: "implementer",
		profile: {
			id: "grok_implementer",
			vendor: "xai",
			modelPattern: ["grok-4"],
			roles: ["implementer"],
			promptTemplate: "implementer",
			promptVersion: "1.0",
			toolPolicyId: "scoped-implementation",
			maxRequests: 200,
			maxRuntimeMs: 600_000,
			retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
			contextPolicy: {
				includePlan: true,
				includeReviewFindings: false,
				includeVerification: true,
				includeFullTranscript: false,
				maxArtifactBytes: 1024 * 1024,
			},
		},
		assignment: "implement the plan",
		context: "plan context",
		outputSchema: {},
		isolation: { requested: true, merge: "patch", apply: true },
		session: {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		},
		signal,
	};
}

describe("RuntimeAdapter", () => {
	it("preserves a validated workflow request", () => {
		const adapter = new RuntimeAdapter();
		const request = createRequest();
		expect(adapter.buildRequest(request)).toBe(request);
	});

	it("preserves abort propagation", () => {
		const adapter = new RuntimeAdapter();
		const controller = new AbortController();
		expect(adapter.buildRequest(createRequest(controller.signal)).signal).toBe(controller.signal);
	});
});
