import { describe, expect, it } from "bun:test";
import { RuntimeAdapter, type StructuredRunner, type StructuredRunnerResult } from "../../src/workflow/runtime-adapter";
import type { WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession } from "./helpers";

function baseRequest(signal?: AbortSignal): WorkflowAgentRequest {
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
		assignment: "implement",
		context: "ctx",
		outputSchema: {},
		isolation: { requested: true, merge: "patch", apply: true },
		session: fakeSession(),
		signal,
	};
}

function okResult(data: unknown, extra: Partial<StructuredRunnerResult["result"]> = {}): StructuredRunnerResult {
	return {
		result: {
			id: "raw_1",
			structuredOutput: { status: "valid", data },
			patchPath: "patches/a.patch",
			branchName: "wf/branch",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
			...extra,
		},
	};
}

describe("RuntimeAdapter", () => {
	it("accepts schema-valid structured output and propagates isolation + usage", async () => {
		const runner: StructuredRunner = async () =>
			okResult({ kind: "implementation", summary: "ok", changedFiles: ["a.ts"] });
		const adapter = new RuntimeAdapter(runner);
		const result = await adapter.run(baseRequest());
		expect(result.artifact).toMatchObject({ summary: "ok" });
		expect(result.patchPath).toBe("patches/a.patch");
		expect(result.branchName).toBe("wf/branch");
		expect(result.usage?.output).toBe(2);
	});

	it("strict schema rejection maps to schema_violation", async () => {
		const runner: StructuredRunner = async () => ({
			result: {
				id: "raw_2",
				structuredOutput: { status: "invalid", error: "missing fields" },
			},
		});
		const adapter = new RuntimeAdapter(runner);
		await expect(adapter.run(baseRequest())).rejects.toMatchObject({ kind: "schema_violation" });
	});

	it("maps timeout and cancel errors", async () => {
		const timeoutRunner: StructuredRunner = async () => {
			throw new Error("request timed out");
		};
		await expect(new RuntimeAdapter(timeoutRunner).run(baseRequest())).rejects.toMatchObject({
			kind: "timeout",
		});

		const cancelRunner: StructuredRunner = async () => {
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		};
		await expect(new RuntimeAdapter(cancelRunner).run(baseRequest())).rejects.toMatchObject({
			kind: "cancelled",
		});

		const controller = new AbortController();
		controller.abort();
		await expect(
			new RuntimeAdapter(async () => okResult({})).run(baseRequest(controller.signal)),
		).rejects.toMatchObject({
			kind: "cancelled",
		});
	});

	it("preserves request and abort signal on buildRequest", () => {
		const adapter = new RuntimeAdapter(async () => okResult({}));
		const controller = new AbortController();
		const req = baseRequest(controller.signal);
		expect(adapter.buildRequest(req)).toBe(req);
		expect(adapter.buildRequest(req).signal).toBe(controller.signal);
	});

	it("maps workflow roles to registered bundled agent names", () => {
		expect(RuntimeAdapter.agentNameForRole("planner")).toBe("designer");
		expect(RuntimeAdapter.agentNameForRole("plan_reviewer")).toBe("reviewer");
		expect(RuntimeAdapter.agentNameForRole("implementer")).toBe("task");
		expect(RuntimeAdapter.agentNameForRole("code_reviewer")).toBe("reviewer");
		expect(RuntimeAdapter.agentNameForRole("repair")).toBe("task");
	});

	it("forwards mapped agent name to the runner", async () => {
		let seenAgent: string | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seenAgent = req.agent;
			return okResult({ ok: true });
		});
		await adapter.run(baseRequest());
		expect(seenAgent).toBe("task"); // implementer → task
	});

	it("fails when exitCode is non-zero even if structured output is valid", async () => {
		const runner: StructuredRunner = async () => okResult({ kind: "implementation", summary: "ok" }, { exitCode: 1 });
		await expect(new RuntimeAdapter(runner).run(baseRequest())).rejects.toMatchObject({
			kind: "tool_failure",
		});
	});

	it("fails when aborted or error is present even if structured output is valid", async () => {
		const aborted: StructuredRunner = async () =>
			okResult({ kind: "implementation", summary: "ok" }, { aborted: true, exitCode: 130 });
		await expect(new RuntimeAdapter(aborted).run(baseRequest())).rejects.toMatchObject({
			kind: "cancelled",
		});

		const errored: StructuredRunner = async () =>
			okResult({ kind: "implementation", summary: "ok" }, { error: "provider died", exitCode: 0 });
		await expect(new RuntimeAdapter(errored).run(baseRequest())).rejects.toMatchObject({
			kind: "provider_permanent",
		});
	});

	it("injects versioned workflow prompt template into runner context", async () => {
		let seenContext: string | undefined;
		let seenAssignment: string | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seenContext = req.context;
			seenAssignment = req.assignment;
			return okResult({ ok: true });
		});
		await adapter.run(baseRequest());
		expect(seenAssignment).toBe("implement");
		expect(seenContext).toMatch(/Workflow Implementer/i);
		expect(seenContext).toMatch(/Injection boundary/i);
		expect(seenContext).toContain("ctx");
	});
});
