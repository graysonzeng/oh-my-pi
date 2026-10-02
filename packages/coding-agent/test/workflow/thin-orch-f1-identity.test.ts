/**
 * Batch 1 thin-orchestration — F1 invocation / charge identity contracts.
 *
 * Failure modes defended:
 * - Real schema re-executions must bill as distinct invocations (no charge-key collision).
 * - Redelivering the same invocation identity must not double-bill.
 * - Profile switches get distinct invocation ids so cost attributes correctly.
 * - Captured write + schema failure must not re-launch the writer.
 */
import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { BudgetLedger, createWorkflowBudgetPort } from "../../src/workflow/budget-ledger";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import {
	mintInvocationId,
	prepareExecutionInvocation,
	sameExecutionIdentity,
} from "../../src/workflow/execution-control";
import { BudgetExhaustedError } from "../../src/workflow/errors";
import {
	RuntimeAdapter,
	type StructuredRunnerRequest,
	type StructuredRunnerResult,
} from "../../src/workflow/runtime-adapter";
import type { WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession, implArtifact } from "./helpers";

function usage(total: number): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

function baseRequest(overrides: Partial<WorkflowAgentRequest> = {}): WorkflowAgentRequest {
	return {
		workflowId: "wf_f1",
		attemptId: "att_stage_1",
		role: "implementer",
		profile: {
			...DEFAULT_MODEL_PROFILES.grok_implementer,
			maxRequests: 10,
			maxCostUsd: 10,
			outputStrategy: {
				retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
			},
		},
		assignment: "implement",
		outputSchema: {},
		isolation: { requested: true, merge: "patch", apply: true },
		session: fakeSession(),
		...overrides,
	};
}

function okResult(data: unknown, extra: Partial<StructuredRunnerResult["result"]> = {}): StructuredRunnerResult {
	return {
		result: {
			id: "raw_1",
			structuredOutput: { status: "valid", data },
			patchPath: "patches/a.patch",
			...extra,
		},
	};
}

describe("F1 execution identity layers", () => {
	it("mints distinct invocationIds for real re-executions under the same stageAttemptId", () => {
		const a = mintInvocationId("att_1", "initial");
		const b = mintInvocationId("att_1", "schema_repair");
		const c = mintInvocationId("att_1", "gate_parse_retry");
		expect(a).not.toBe(b);
		expect(b).not.toBe(c);
		expect(a).toContain("att_1");
		expect(
			sameExecutionIdentity(
				{ stageAttemptId: "att_1", invocationId: a },
				{ stageAttemptId: "att_1", invocationId: a },
			),
		).toBe(true);
		expect(
			sameExecutionIdentity(
				{ stageAttemptId: "att_1", invocationId: a },
				{ stageAttemptId: "att_1", invocationId: b },
			),
		).toBe(false);
	});

	it("reuses identity only when prepareExecutionInvocation is given reuseIdentity", () => {
		const reuse = { stageAttemptId: "att_1", invocationId: "inv_redeliver" };
		const first = prepareExecutionInvocation({
			stageAttemptId: "att_1",
			kind: "initial",
			reuseIdentity: reuse,
			startedAtMs: Date.now(),
			canSpend: () => true,
		});
		const second = prepareExecutionInvocation({
			stageAttemptId: "att_1",
			kind: "schema_repair",
			startedAtMs: Date.now(),
			canSpend: () => true,
		});
		expect(first.action).toBe("proceed");
		expect(second.action).toBe("proceed");
		if (first.action === "proceed" && second.action === "proceed") {
			expect(first.identity.invocationId).toBe("inv_redeliver");
			expect(second.identity.invocationId).not.toBe("inv_redeliver");
		}
	});

	it("bills schema retries as separate invocations (no charge-key collision)", async () => {
		let calls = 0;
		const adapter = new RuntimeAdapter(async (request: StructuredRunnerRequest) => {
			calls += 1;
			await request.onPayload?.({ call: calls }, undefined);
			if (calls === 1) {
				return {
					result: {
						id: "bad",
						structuredOutput: { status: "invalid", error: "missing summary" },
						usage: usage(0.1),
					},
				};
			}
			return okResult(implArtifact(), { usage: usage(0.2) });
		});
		const ledger = new BudgetLedger({ limitUsd: 10, maxRequests: 10 });
		adapter.setBudgetPort(createWorkflowBudgetPort(ledger));
		await adapter.run(baseRequest());
		expect(calls).toBe(2);
		const snap = ledger.snapshot();
		expect(snap.requests).toBe(2);
		const invocationCharges = (snap.charges ?? []).filter(c => c.unit === "invocation");
		expect(invocationCharges.length).toBe(2);
		expect(new Set(invocationCharges.map(c => c.invocationId)).size).toBe(2);
		for (const charge of invocationCharges) {
			expect(charge.attemptId).toBe("att_stage_1");
			// Legacy collision key must not be used.
			expect(charge.invocationId).not.toBe(`${charge.attemptId}:implementer:0`);
			expect(charge.invocationId).not.toBe(`${charge.attemptId}:implementer:1`);
		}
	});

	it("does not double-bill when redelivering the same invocation identity", async () => {
		const ledger = new BudgetLedger({ limitUsd: 10, maxRequests: 10 });
		const port = createWorkflowBudgetPort(ledger);
		const invocationId = "inv_same_call";
		const guard = port.bind({
			workflowId: "wf",
			attemptId: "att",
			invocationId,
			profileId: "p1",
			maxRequests: 5,
			maxCostUsd: 5,
		});
		const key = guard.beforeProviderRequest({ ordinal: 1 });
		guard.settleProviderUsage({
			idempotencyKey: key,
			launched: true,
			usage: usage(0.5),
		});
		guard.finishInvocation({ usage: usage(0.5), launched: true });
		guard.settleProviderUsage({
			idempotencyKey: key,
			launched: true,
			usage: usage(0.5),
		});
		guard.finishInvocation({ usage: usage(0.5), launched: true });
		const snap = ledger.snapshot();
		expect(snap.requests).toBe(1);
		expect(snap.providerRequests).toBe(1);
		expect(snap.knownCostLowerBoundUsd).toBe(0.5);
	});

	it("attributes successive profile launches under distinct invocation ids", async () => {
		const ledger = new BudgetLedger({ limitUsd: 10, maxRequests: 10 });
		const adapter = new RuntimeAdapter(async request => {
			await request.onPayload?.({ n: 1 }, undefined);
			return okResult(implArtifact(), { usage: usage(0.11) });
		});
		adapter.setBudgetPort(createWorkflowBudgetPort(ledger));
		await adapter.run(
			baseRequest({
				profile: { ...baseRequest().profile, id: "profile_a", outputStrategy: undefined },
			}),
		);
		await adapter.run(
			baseRequest({
				profile: { ...baseRequest().profile, id: "profile_b", outputStrategy: undefined },
			}),
		);
		const snap = ledger.snapshot();
		expect(snap.requests).toBe(2);
		const byProfile = new Map(snap.profiles.map(p => [p.profileId, p.requests]));
		expect(byProfile.get("profile_a")).toBe(1);
		expect(byProfile.get("profile_b")).toBe(1);
		const invocationIds = new Set((snap.charges ?? []).filter(c => c.unit === "invocation").map(c => c.invocationId));
		expect(invocationIds.size).toBe(2);
	});

	it("after captured write does not re-run writer on schema failure", async () => {
		let calls = 0;
		const adapter = new RuntimeAdapter(async request => {
			calls += 1;
			await request.onPayload?.({ call: calls }, undefined);
			return {
				result: {
					id: "bad",
					structuredOutput: { status: "invalid", error: "bad schema" },
					rawOutput: "not-json",
					changesApplied: true,
					patchPath: "patches/captured.patch",
					usage: usage(0.05),
				},
			};
		});
		const ledger = new BudgetLedger({ limitUsd: 10, maxRequests: 10 });
		adapter.setBudgetPort(createWorkflowBudgetPort(ledger));
		await expect(adapter.run(baseRequest())).rejects.toThrow(/captured_write_schema_unrepairable/);
		expect(calls).toBe(1);
		expect(ledger.snapshot().requests).toBe(1);
	});

	it("stops at shared budget before minting another paid call", async () => {
		const adapter = new RuntimeAdapter(async () => okResult(implArtifact(), { usage: usage(0.1) }));
		const ledger = new BudgetLedger({ limitUsd: 0.05, maxRequests: 5 });
		ledger.recordRequest(usage(0.05), "prior");
		adapter.setBudgetPort(createWorkflowBudgetPort(ledger));
		await expect(adapter.run(baseRequest())).rejects.toBeInstanceOf(BudgetExhaustedError);
	});
});
