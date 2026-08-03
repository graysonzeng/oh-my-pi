/**
 * Focused behavior tests for the remaining Major fixes:
 * - M9: budget ledger persisted atomically with attempt + stage transitions
 * - M11: schema-violation headlines on the runtime path reach the schema-retry loop
 * - M12: cross-attempt usage aggregation never invents zero cost
 * - M14: resolved toolPolicyId flows prepare → result → evidence
 * - M16: workflow catalog presentation fields survive the child-session handoff
 * - M17: secret redaction covers standalone bearer / sk- keys / PEM blocks
 * - M18: incomplete model profiles fail closed at load
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { XdProtocolHandler } from "../../src/internal-urls/xd-protocol";
import { resolveWorkflowCatalogToolDocs } from "../../src/tools/read";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowPolicyError } from "../../src/workflow/errors";
import { assertSupportedModelProfile, normalizeModelProfile } from "../../src/workflow/model-profile-registry";
import { RuntimeAdapter, type StructuredRunnerResult } from "../../src/workflow/runtime-adapter";
import { prepareWorkflowRunnerSession } from "../../src/workflow/runtime-default";
import { prepareWorkflowInvocation } from "../../src/workflow/runtime-invocation";
import { containsSecret, redactSecretsInText } from "../../src/workflow/secret-redact";
import { resolveWorkflowProfilesFromSettings } from "../../src/workflow/session-config";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type { ModelProfile, WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, scriptedRunner } from "./helpers";

const COMPLETE_PROFILE: ModelProfile = {
	id: "complete_profile",
	vendor: "test",
	modelPattern: ["test/model"],
	roles: ["implementer"],
	promptTemplate: "implementer",
	promptVersion: "1.0",
	toolPolicyId: "scoped-implementation",
	maxRequests: 10,
	maxRuntimeMs: 60_000,
	retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
	contextPolicy: {
		includePlan: true,
		includeReviewFindings: true,
		includeVerification: true,
		includeFullTranscript: false,
		maxArtifactBytes: 10_000,
	},
};

function baseRequest(overrides: Partial<WorkflowAgentRequest> = {}): WorkflowAgentRequest {
	return {
		workflowId: "wf_1",
		attemptId: "att_1",
		role: "implementer",
		profile: { ...COMPLETE_PROFILE },
		assignment: "implement",
		context: "ctx",
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

describe("M9: budget persisted atomically with stage settlement", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-m9-arts-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("completeAttemptAndTransition persists the ledger in the same transaction", async () => {
		const workflowId = await store.createWorkflow({ request: "x" }, {});
		await store.transitionWorkflow(workflowId, "created", "planning", "start planning");
		const attemptId = await store.beginAttempt(workflowId, "planning");
		const budget = { requests: 3, costUsd: 0.07, costKnown: true };

		await store.completeAttemptAndTransition({
			workflowId,
			attemptId,
			attemptStatus: "completed",
			fromStatus: "planning",
			toStatus: "plan_review",
			reason: "plan ready",
			usage: { input: 1 },
			budget,
		});

		const snapshot = await store.resumeFromPersistedState(workflowId);
		expect(snapshot?.budgetTotals).toMatchObject({ requests: 3, costUsd: 0.07 });
		expect(snapshot?.state.status).toBe("plan_review");
	});

	it("transitionWorkflow persists the ledger atomically without an attempt", async () => {
		const workflowId = await store.createWorkflow({ request: "x" }, {});
		await store.transitionWorkflow(workflowId, "created", "planning", "start", undefined, undefined, {
			requests: 1,
		});
		const snapshot = await store.resumeFromPersistedState(workflowId);
		expect(snapshot?.budgetTotals).toMatchObject({ requests: 1 });
	});

	it("a fresh engine resume restores usage persisted at the transition boundary", async () => {
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		const workflowId = await engine.startWorkflow({ request: "budget atomicity" });
		await engine.resume(workflowId, { singleStep: true }); // created → planning
		await engine.resume(workflowId, { singleStep: true }); // planning runs + transitions
		expect((await engine.getState(workflowId))?.status).toBe("plan_review");
		expect(engine.budgetSnapshot().requests).toBe(1);

		// New engine instance: budget must come back from budget_json (written
		// inside the transition transaction), not from the dead in-memory ledger.
		const engine2 = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		expect(engine2.budgetSnapshot().requests).toBe(0);
		await engine2.resume(workflowId, { singleStep: true });
		expect(engine2.budgetSnapshot().requests).toBeGreaterThanOrEqual(1);
	});
});

describe("M11: schema violations on headline-only runtime errors retry", () => {
	it("routes an error-only schema_violation through the retry loop", async () => {
		let calls = 0;
		const contexts: string[] = [];
		const adapter = new RuntimeAdapter(async req => {
			calls += 1;
			contexts.push(req.context ?? "");
			if (calls === 1) {
				// No structuredOutput block — the executor surfaced the violation only
				// as an error headline (schema_violation classification).
				return {
					result: {
						id: "headline-fail",
						error: "schema_violation: missing required fields: summary",
						exitCode: 1,
						rawOutput: '{"error":"schema_violation"}',
					},
				};
			}
			return okResult(implArtifact());
		});
		const result = await adapter.run(
			baseRequest({
				profile: {
					...COMPLETE_PROFILE,
					outputStrategy: {
						retryOnSchemaViolation: { enabled: true, maxRetries: 1, includeErrorInRetry: true },
					},
				},
			}),
		);
		expect(result.artifact).toBeDefined();
		expect(calls).toBe(2);
		// The retry prompt must carry the violation headline so the model can fix it.
		expect(contexts[1]).toMatch(/missing required fields|missing summary/i);
	});

	it("does not retry when the error headline is not schema-related", async () => {
		let calls = 0;
		const adapter = new RuntimeAdapter(async () => {
			calls += 1;
			return { result: { id: "e", error: "provider exploded", exitCode: 1 } };
		});
		await expect(
			adapter.run(
				baseRequest({
					profile: {
						...COMPLETE_PROFILE,
						outputStrategy: {
							retryOnSchemaViolation: { enabled: true, maxRetries: 3, includeErrorInRetry: true },
						},
					},
				}),
			),
		).rejects.toMatchObject({ kind: "provider_permanent" });
		expect(calls).toBe(1);
	});
});

describe("M12: cross-attempt usage aggregation never invents cost", () => {
	it("keeps cost undefined when neither attempt reported one", async () => {
		let calls = 0;
		const adapter = new RuntimeAdapter(async () => {
			calls += 1;
			if (calls === 1) {
				return {
					result: {
						id: "bad",
						structuredOutput: { status: "invalid", error: "bad" },
						usage: { input: 10, output: 5, totalTokens: 15 },
					},
				};
			}
			return {
				result: {
					id: "ok",
					structuredOutput: { status: "valid", data: implArtifact() },
					usage: { input: 20, output: 10, totalTokens: 30 },
				},
			};
		});
		const result = await adapter.run(
			baseRequest({
				profile: {
					...COMPLETE_PROFILE,
					outputStrategy: {
						retryOnSchemaViolation: { enabled: true, maxRetries: 1, includeErrorInRetry: true },
					},
				},
			}),
		);
		expect(calls).toBe(2);
		// Unknown cost must stay unknown — never a fabricated { total: 0 }.
		expect(result.usage?.cost).toBeUndefined();
		expect(result.usage?.input).toBe(30);
	});

	it("sums reported cost fields across attempts", async () => {
		let calls = 0;
		const adapter = new RuntimeAdapter(async () => {
			calls += 1;
			if (calls === 1) {
				return {
					result: {
						id: "bad",
						structuredOutput: { status: "invalid", error: "bad" },
						usage: { input: 1, totalTokens: 1, cost: { input: 0.01, total: 0.01 } },
					},
				};
			}
			return {
				result: {
					id: "ok",
					structuredOutput: { status: "valid", data: implArtifact() },
					usage: { input: 2, totalTokens: 2, cost: { input: 0.02, total: 0.02 } },
				},
			};
		});
		const result = await adapter.run(
			baseRequest({
				profile: {
					...COMPLETE_PROFILE,
					outputStrategy: {
						retryOnSchemaViolation: { enabled: true, maxRetries: 1, includeErrorInRetry: true },
					},
				},
			}),
		);
		expect(result.usage?.cost?.total).toBeCloseTo(0.03);
		expect(result.usage?.cost?.input).toBeCloseTo(0.03);
	});
});

describe("M14: resolved toolPolicyId flows through prepare and evidence", () => {
	let store: WorkflowStore;
	let artifactDir: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-m14-arts-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("prepared invocation exposes the role default when no named override matches", () => {
		const prepared = prepareWorkflowInvocation(baseRequest());
		expect(prepared.resolvedToolPolicyId).toBe("scoped-implementation");
	});

	it("prepared invocation exposes a named readonly override", () => {
		const prepared = prepareWorkflowInvocation(
			baseRequest({
				role: "implementer",
				profile: { ...COMPLETE_PROFILE, toolPolicyId: "readonly-review" },
			}),
		);
		expect(prepared.resolvedToolPolicyId).toBe("readonly-review");
	});

	it("usage evidence records configured + resolved policy ids", async () => {
		const engine = new WorkflowEngine({
			store,
			adapter: new RuntimeAdapter(
				scriptedRunner({
					plan: planArtifact(),
					planReview: reviewArtifact("approved", "plan"),
					implement: implArtifact(),
					codeReview: reviewArtifact("approved", "implementation"),
				}),
			),
			verifier: passVerifier(),
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession(),
		});
		const workflowId = await engine.startWorkflow({ request: "policy evidence" });
		await engine.resume(workflowId, { singleStep: true }); // created → planning
		await engine.resume(workflowId, { singleStep: true }); // planning runs
		const report = await engine.getStatusReport(workflowId);
		expect(report?.modelAttempts.length).toBeGreaterThan(0);
		const planning = report?.modelAttempts.find(attempt => attempt.stage === "planning");
		expect(planning?.executions[0]?.toolPolicyId).toBe("readonly-planning");
	});
});

describe("M16: workflow catalog presentation fields survive the child handoff", () => {
	it("prepareWorkflowRunnerSession preserves presentation maps", () => {
		const schemas = new Map<string, unknown>([["bash", { type: "object" }]]);
		const allowed = ["read", "bash", "yield"];
		const skillBodies = new Map<string, string>([["repo", "# repo body"]]);
		const session = {
			...fakeSession(),
			workflowToolOptimization: {
				processResult: (_t: string, o: string) => o,
				transformTools: (tools: unknown[]) => tools,
				presentationToolSchemas: schemas,
				presentationAllowedTools: allowed,
				presentationSkillBodies: skillBodies,
			},
		};
		const out = prepareWorkflowRunnerSession(session as never);
		expect(out.workflowToolOptimization?.presentationToolSchemas).toBe(schemas);
		expect(out.workflowToolOptimization?.presentationAllowedTools).toBe(allowed);
		expect(out.workflowToolOptimization?.presentationSkillBodies).toBe(skillBodies);
	});

	it("xd://skills resolves an in-memory body without a file path", async () => {
		const handler = new XdProtocolHandler();
		const url = new URL("xd://skills/repo");
		const resource = await handler.resolve(
			url as never,
			{
				skills: [{ name: "repo", description: "repo skill", content: "# in-memory body" }],
			} as never,
		);
		expect(resource.content).toBe("# in-memory body");
	});

	it("resolveWorkflowCatalogToolDocs renders allowlisted schema docs and refuses out-of-scope tools", () => {
		const schemas = new Map<string, unknown>([
			["bash", { type: "object", properties: { command: { type: "string" } } }],
		]);
		const docs = resolveWorkflowCatalogToolDocs("bash", {
			presentationToolSchemas: schemas,
			presentationAllowedTools: ["read", "bash", "yield"],
		});
		expect(docs).toContain("# Tool: bash");
		expect(docs).toContain('"command"');

		// Out-of-allowlist names never resolve — catalog cannot elevate privileges.
		expect(() =>
			resolveWorkflowCatalogToolDocs("task", {
				presentationToolSchemas: schemas,
				presentationAllowedTools: ["read", "bash", "yield"],
			}),
		).toThrow(/outside the role allowlist/);
		// Allowlisted but never captured: observable failure, not fake recovery.
		expect(() =>
			resolveWorkflowCatalogToolDocs("read", {
				presentationToolSchemas: schemas,
				presentationAllowedTools: ["read", "bash", "yield"],
			}),
		).toThrow(/No full schema registered/);
	});
});

describe("M17: secret redaction has no gaps", () => {
	it("redacts standalone OpenAI-style sk- keys", () => {
		const text = "called with sk-proj-ABCdef1234567890XYZ and continued";
		expect(containsSecret(text)).toBe(true);
		expect(redactSecretsInText(text)).toContain("sk-[REDACTED]");
		expect(redactSecretsInText(text)).not.toContain("sk-proj-ABCdef");
	});

	it("redacts a standalone Bearer token without the authorization keyword", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig1234567890abcdef";
		const withBearer = `use Bearer ${jwt} to call`;
		expect(containsSecret(withBearer)).toBe(true);
		expect(redactSecretsInText(withBearer)).toContain("Bearer [REDACTED]");
		expect(redactSecretsInText(withBearer)).not.toContain("eyJhbGci");
	});

	it("redacts PEM private key blocks", () => {
		const pem = [
			"-----BEGIN PRIVATE KEY-----",
			"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
			"-----END PRIVATE KEY-----",
		].join("\n");
		expect(containsSecret(pem)).toBe(true);
		expect(redactSecretsInText(pem)).toContain("[REDACTED PRIVATE KEY BLOCK]");
		expect(redactSecretsInText(pem)).not.toContain("MIIEvQIBADAN");
	});

	it("still redacts classic key=value and JSON forms", () => {
		expect(redactSecretsInText("api_key=sk-abcdefghij1234567890")).toContain("[REDACTED]");
		expect(redactSecretsInText('{"password":"hunter2secret!"}')).toContain('"password":"[REDACTED]"');
		expect(redactSecretsInText("Authorization: Bearer abcdefgh12345678")).toContain("Bearer [REDACTED]");
	});
});

describe("M18: incomplete profiles fail closed", () => {
	it("rejects a profile missing contextPolicy", () => {
		const incomplete: ModelProfile = {
			...COMPLETE_PROFILE,
			contextPolicy: undefined as never,
		};
		expect(() => normalizeModelProfile(incomplete)).toThrow(WorkflowPolicyError);
		try {
			normalizeModelProfile(incomplete);
			expect.unreachable("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(WorkflowPolicyError);
			expect((error as WorkflowPolicyError).message).toContain("incomplete_model_profile");
			expect(((error as WorkflowPolicyError).details as { missingFields?: string[] }).missingFields).toContain(
				"contextPolicy|contextStrategy.artifactInclusion",
			);
		}
	});

	it("rejects a profile missing identity fields", () => {
		const incomplete = {
			...COMPLETE_PROFILE,
			roles: [],
		};
		expect(() => assertSupportedModelProfile(incomplete)).toThrow("incomplete_model_profile");
	});

	it("settings resolution fails closed instead of silently preserving partial entries", () => {
		expect(() =>
			resolveWorkflowProfilesFromSettings(
				{
					orphan_partial: {
						id: "orphan_partial",
						vendor: "openai",
						modelPattern: "openai/gpt-5.6-sol",
					},
				},
				{ [COMPLETE_PROFILE.id]: COMPLETE_PROFILE },
			),
		).toThrow("incomplete_model_profile");
	});

	it("accepts the complete live-config-shaped profile", () => {
		const normalized = normalizeModelProfile(COMPLETE_PROFILE);
		expect(normalized.id).toBe(COMPLETE_PROFILE.id);
		expect(() => resolveWorkflowProfilesFromSettings({ [COMPLETE_PROFILE.id]: COMPLETE_PROFILE }, {})).not.toThrow();
	});
});
