import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { prepareWorkflowInvocation } from "../../src/workflow/runtime-invocation";
import type { WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession } from "./helpers";

function baseRequest(overrides: Partial<WorkflowAgentRequest> = {}): WorkflowAgentRequest {
	return {
		workflowId: "wf_1",
		attemptId: "att_1",
		role: "implementer",
		profile: {
			...DEFAULT_MODEL_PROFILES.grok_implementer,
			disabledTools: ["todo"],
		},
		assignment: "implement safely",
		context: "extra context body",
		outputSchema: { type: "object" },
		isolation: { requested: true, merge: "patch", apply: true },
		session: fakeSession(),
		...overrides,
	};
}

describe("prepareWorkflowInvocation", () => {
	it("prepares the same strict role policy for every runtime", () => {
		const prepared = prepareWorkflowInvocation(baseRequest());
		expect(prepared.assignment).toBe("implement safely");
		expect(prepared.context).toContain("## Context");
		expect(prepared.context).toContain("extra context body");
		expect(prepared.allowedTools).not.toContain("todo");
		expect(prepared.allowedTools).toContain("edit");
		expect(prepared.readonly).toBe(false);
		expect(prepared.isolationRequested).toBe(true);
		expect(prepared.session.workflowWritePolicy).toBeDefined();
	});

	it("rejects readonly roles that request isolation", () => {
		try {
			prepareWorkflowInvocation(
				baseRequest({
					role: "planner",
					profile: DEFAULT_MODEL_PROFILES.claude_planner,
					isolation: { requested: true },
				}),
			);
			expect.unreachable("expected policy violation");
		} catch (error) {
			expect(error).toMatchObject({ kind: "policy_violation" });
		}
	});

	it("rejects already-aborted requests", () => {
		const controller = new AbortController();
		controller.abort();
		try {
			prepareWorkflowInvocation(baseRequest({ signal: controller.signal }));
			expect.unreachable("expected cancelled");
		} catch (error) {
			expect(error).toMatchObject({ kind: "cancelled" });
		}
	});

	it("truncates context by profile contextPolicy", () => {
		const prepared = prepareWorkflowInvocation(
			baseRequest({
				profile: {
					...DEFAULT_MODEL_PROFILES.grok_implementer,
					contextPolicy: {
						...DEFAULT_MODEL_PROFILES.grok_implementer.contextPolicy,
						maxArtifactBytes: 80,
					},
				},
				context: "x".repeat(500),
			}),
		);
		expect(prepared.context?.length ?? 0).toBeLessThan(200);
		expect(prepared.context).toContain("truncated by contextPolicy");
	});
});
