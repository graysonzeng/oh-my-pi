import { describe, expect, it } from "bun:test";
import {
	assertCliArtifactShape,
	classifyCliFailure,
	createCliSingleResult,
	normalizeCliUsage,
	parseExactCliModel,
} from "../../src/workflow/cli-runtime-result";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import type { WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession } from "./helpers";

describe("cli-runtime-result", () => {
	it("normalizes emitted token usage without estimating cost", () => {
		const usage = normalizeCliUsage({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 });
		expect(usage).toMatchObject({ input: 10, output: 4, cacheRead: 3, cacheWrite: 0, totalTokens: 17 });
		expect(usage?.cost.total).toBe(0);
	});

	it("uses reported cost when present", () => {
		const usage = normalizeCliUsage({ input_tokens: 1, output_tokens: 1, total_cost_usd: 0.02 });
		expect(usage?.cost.total).toBe(0.02);
	});

	it("prefers parsed status over stderr regex", () => {
		const error = classifyCliFailure({ exitCode: 1, status: 429, stderr: "request failed" });
		expect(error.kind).toBe("rate_limit");
	});

	it("maps 401 to authentication", () => {
		const error = classifyCliFailure({ exitCode: 1, status: 401, stderr: "nope" });
		expect(error.kind).toBe("authentication");
	});

	it("redacts secret-like values from error messages", () => {
		const error = classifyCliFailure({
			exitCode: 1,
			stderr: 'token=supersecrettokenvalue api_key="ABCDEFGHIJKLMNOP" authorization: Bearer abcdefghijklmnop',
		});
		expect(error.message).not.toContain("supersecrettokenvalue");
		expect(error.message).not.toContain("ABCDEFGHIJKLMNOP");
		expect(error.message).toMatch(/REDACTED/i);
	});

	it("parseExactCliModel rejects wildcards and multi-entry arrays", () => {
		expect(parseExactCliModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
		expect(() => parseExactCliModel(["a", "b"])).toThrow(/exact_single_model|exact/i);
		expect(() => parseExactCliModel("claude-sonnet-*")).toThrow(/wildcard/i);
	});

	it("assertCliArtifactShape checks required fields", () => {
		expect(() => assertCliArtifactShape({ kind: "plan" }, { type: "object", required: ["summary"] })).toThrow(
			/summary/,
		);
		expect(() =>
			assertCliArtifactShape({ kind: "plan", summary: "ok" }, { type: "object", required: ["summary"] }),
		).not.toThrow();
	});

	it("createCliSingleResult redacts stderr and marks valid artifact", () => {
		const request: WorkflowAgentRequest = {
			workflowId: "wf",
			attemptId: "att",
			role: "planner",
			profile: DEFAULT_MODEL_PROFILES.claude_planner,
			assignment: "plan",
			session: fakeSession(),
		};
		const result = createCliSingleResult({
			request,
			id: "raw",
			exitCode: 0,
			output: "{}",
			stderr: "token=supersecrettokenvalue",
			durationMs: 10,
			artifact: { kind: "plan" },
		});
		expect(result.structuredOutput?.status).toBe("valid");
		expect(result.stderr).not.toContain("supersecrettokenvalue");
	});
});
