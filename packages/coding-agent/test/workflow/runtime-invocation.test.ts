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

	it("keeps untyped and nonreplaceable context inline regardless of artifact inclusion cap", () => {
		const currentToolResult = `current-tool-result-${"x".repeat(500)}-CURRENT-TAIL`;
		const attachment = `attachment-${"y".repeat(500)}-ATTACHMENT-TAIL`;
		const handoff = `## Context\n${"z".repeat(500)}\n[raw output: artifact://42]\n## History\nHISTORY-TAIL`;
		const prepared = prepareWorkflowInvocation(
			baseRequest({
				profile: {
					...DEFAULT_MODEL_PROFILES.grok_implementer,
					contextPolicy: {
						...DEFAULT_MODEL_PROFILES.grok_implementer.contextPolicy,
						maxArtifactBytes: 80,
					},
				},
				context: handoff,
				contextEntries: [
					{
						id: "tool-current",
						bucket: "tool_results",
						kind: "tool_result",
						content: currentToolResult,
						replaceable: false,
					},
					{ id: "attachment", bucket: "artifacts", kind: "attachment", content: attachment },
				],
			}),
		);

		expect(prepared.context).toContain("CURRENT-TAIL");
		expect(prepared.context).toContain("ATTACHMENT-TAIL");
		expect(prepared.context).toContain("HISTORY-TAIL");
		expect(prepared.context).toContain("[raw output: artifact://42]");
		expect(prepared.promptAssemblyReceipt.totalBytes).toBe(Buffer.byteLength(prepared.context ?? "", "utf8"));
		expect(prepared.contextLedger.buckets.tool_results.bytes).toBe(Buffer.byteLength(currentToolResult, "utf8"));
		expect(prepared.contextLedger.buckets.artifacts.bytes).toBe(Buffer.byteLength(attachment, "utf8"));
	});

	it("attaches deterministic compiled policy without expanding role allowlist", () => {
		const prepared = prepareWorkflowInvocation(baseRequest());
		expect(prepared.compiledPolicy).toBeDefined();
		expect(prepared.compiledReceipt).toBeDefined();
		expect(prepared.compiledReceipt?.schemaVersion).toBe(1);
		expect(prepared.compiledPolicy?.guards.hard.length).toBeGreaterThan(0);
		// Role allowlist still owns tools — compiler does not inject extras
		expect(prepared.allowedTools).not.toContain("todo");
		expect(prepared.allowedTools).toContain("edit");
		// Shadow identity facts → no invented reasoning wire params
		expect(Object.keys(prepared.compiledPolicy?.reasoningAndSampling.wireParameters ?? {})).toEqual([]);

		const again = prepareWorkflowInvocation(baseRequest());
		expect(again.compiledReceipt?.modelFactsFingerprint).toBe(prepared.compiledReceipt?.modelFactsFingerprint);
		expect(again.compiledReceipt?.taskPolicyFingerprint).toBe(prepared.compiledReceipt?.taskPolicyFingerprint);
		expect(again.compiledReceipt?.promptStableHash).toBe(prepared.compiledReceipt?.promptStableHash);
	});

	it("does not widen allowlist when semanticTools include extra tools", () => {
		const prepared = prepareWorkflowInvocation(
			baseRequest({
				semanticTools: [
					{
						id: "todo",
						description: "todo",
						parametersSchema: { type: "object" },
						permission: "write",
					},
					{
						id: "edit",
						description: "edit",
						parametersSchema: { type: "object" },
						permission: "write",
					},
				],
			}),
		);
		expect(prepared.allowedTools).not.toContain("todo");
		const compiledIds = prepared.compiledPolicy?.tools.descriptors.map(d => d.id) ?? [];
		expect(compiledIds).not.toContain("todo");
	});
});
