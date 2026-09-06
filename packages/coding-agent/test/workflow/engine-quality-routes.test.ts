import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { ToolSession } from "../../src/tools";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { WorkflowEngine } from "../../src/workflow/engine";
import {
	RuntimeAdapter,
	type StructuredRunner,
	type StructuredRunnerRequest,
} from "../../src/workflow/runtime-adapter";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type {
	CapturedChangesMergeRequest,
	CapturedChangesMerger,
	ModelProfile,
	VerificationArtifactV1,
	VerifierPort,
	WorkflowAvailabilityPort,
	WorkflowQualityRoutes,
	WorkflowRole,
} from "../../src/workflow/types";
import { WorkflowTool } from "../../src/workflow/workflow-tool";
import { fakeSession, implArtifact, passVerifier, planArtifact, reviewArtifact, SAMPLE_PATCH } from "./helpers";

type IdentityMode = "valid" | "unknown" | "mismatch";

type QualityConfigFixture = {
	profiles: Record<string, ModelProfile>;
	qualityRoutes: WorkflowQualityRoutes;
	defaultQualityTier: "balanced" | "critical";
};

interface RunnerCall {
	stage: "planning" | "plan_review" | "implementing" | "code_review" | "repairing";
	model: string;
}

const MEDIUM = "medium" as NonNullable<ModelProfile["thinkingLevel"]>;

function strictProfile(id: string, role: WorkflowRole, modelPattern: string, vendor: string): ModelProfile {
	return {
		id,
		vendor,
		modelPattern,
		roles: [role],
		thinkingLevel: MEDIUM,
		strictIdentity: true,
		promptTemplate: role,
		promptVersion: "test-1",
		toolPolicyId: "test-workflow",
		maxRequests: 20,
		maxRuntimeMs: 30_000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 50_000,
		},
	};
}

function qualityConfig(suffix = "", criticalSameLineage = false): QualityConfigFixture {
	const id = (tier: "balanced" | "critical", role: WorkflowRole): string =>
		`${tier}_${role}${suffix ? `_${suffix}` : ""}`;
	const plannerModel = suffix ? "anthropic/claude-opus-4.8" : "anthropic/claude-fable-5";
	const planReviewerModel = suffix ? "openai/gpt-5.6-terra" : "openai/gpt-5.6-sol";
	const implementerModel = "xai/grok-4.6";
	const balancedReviewerModel = "openai/gpt-5.6-terra";
	const criticalReviewerModel = criticalSameLineage ? implementerModel : balancedReviewerModel;

	const profiles = [
		strictProfile(id("balanced", "planner"), "planner", plannerModel, "anthropic"),
		strictProfile(id("balanced", "plan_reviewer"), "plan_reviewer", planReviewerModel, "openai"),
		strictProfile(id("balanced", "implementer"), "implementer", implementerModel, "xai"),
		strictProfile(id("balanced", "code_reviewer"), "code_reviewer", balancedReviewerModel, "openai"),
		strictProfile(id("balanced", "repair"), "repair", plannerModel, "anthropic"),
		strictProfile(id("critical", "planner"), "planner", plannerModel, "anthropic"),
		strictProfile(id("critical", "plan_reviewer"), "plan_reviewer", planReviewerModel, "openai"),
		strictProfile(id("critical", "implementer"), "implementer", implementerModel, "xai"),
		strictProfile(
			id("critical", "code_reviewer"),
			"code_reviewer",
			criticalReviewerModel,
			criticalReviewerModel.split("/")[0]!,
		),
		strictProfile(id("critical", "repair"), "repair", plannerModel, "anthropic"),
	];
	const routesFor = (tier: "balanced" | "critical"): Readonly<Record<WorkflowRole, readonly string[]>> => ({
		planner: [id(tier, "planner")],
		plan_reviewer: [id(tier, "plan_reviewer")],
		plan_arbitrator: [],
		implementer: [id(tier, "implementer")],
		code_reviewer: [id(tier, "code_reviewer")],
		repair: [id(tier, "repair")],
	});
	return {
		profiles: Object.fromEntries(profiles.map(profile => [profile.id, profile])),
		qualityRoutes: { balanced: routesFor("balanced"), critical: routesFor("critical") },
		defaultQualityTier: "balanced",
	};
}

function requestModel(request: StructuredRunnerRequest): string {
	const model = Array.isArray(request.model) ? request.model[0] : request.model;
	if (!model) throw new Error("test runner requires a model");
	return model;
}

function emitRuntimeIdentity(request: StructuredRunnerRequest, mode: IdentityMode): void {
	if (mode === "unknown") return;
	const configured = requestModel(request);
	const slash = configured.indexOf("/");
	const provider = slash > 0 ? configured.slice(0, slash) : "xai";
	const model = slash > 0 ? configured.slice(slash + 1) : configured;
	const attestedModel = mode === "mismatch" ? `${model}-mismatch` : model;
	request.onResponse?.(
		{ status: 200, headers: { "x-provider-model": `${provider}/${attestedModel}` } } as never,
		{
			provider,
			id: model,
			reasoning: true,
			thinking: { efforts: [MEDIUM] },
		} as never,
	);
}

async function writePatch(patchPath: string): Promise<void> {
	await fs.mkdir(path.dirname(patchPath), { recursive: true });
	await Bun.write(patchPath, SAMPLE_PATCH);
}

function qualityRunner(options: {
	calls: RunnerCall[];
	patchRoot?: string;
	implementIdentity?: IdentityMode;
}): StructuredRunner {
	return async request => {
		const agent = request.agent ?? "";
		let stage: RunnerCall["stage"];
		let data: unknown;
		let patchPath: string | undefined;
		if (agent === "designer" || agent === "planner") {
			stage = "planning";
			data = planArtifact();
		} else if (agent === "reviewer" || agent === "plan_reviewer" || agent === "code_reviewer") {
			if (/Independent code review/i.test(request.assignment)) {
				stage = "code_review";
				data = reviewArtifact("approved", "implementation");
			} else {
				stage = "plan_review";
				data = reviewArtifact("approved", "plan");
			}
		} else if (agent === "task" || agent === "implementer" || agent === "repair") {
			stage = /^Repair findings/i.test(request.assignment) ? "repairing" : "implementing";
			if (options.patchRoot) {
				patchPath = path.join(options.patchRoot, `${request.attemptId ?? "implementation"}.patch`);
				await writePatch(patchPath);
			}
			data = implArtifact({ patchPath, changedFiles: ["src/a.ts"] });
		} else {
			throw new Error(`unexpected scripted agent ${agent}`);
		}

		const model = requestModel(request);
		options.calls.push({ stage, model });
		emitRuntimeIdentity(request, stage === "implementing" ? (options.implementIdentity ?? "valid") : "valid");
		return {
			result: {
				id: `quality-${stage}`,
				structuredOutput: { status: "valid", data },
				patchPath,
				resolvedModel: model,
			},
		};
	};
}

function legacyRunner(calls: string[], patchPath: string): StructuredRunner {
	return async request => {
		const agent = request.agent ?? "";
		calls.push(agent);
		const model = requestModel(request);
		emitRuntimeIdentity(request, "valid");
		let data: unknown;
		if (agent === "designer" || agent === "planner") data = planArtifact();
		else if (agent === "reviewer" || agent === "plan_reviewer") data = reviewArtifact("approved", "plan");
		else if (agent === "task" || agent === "implementer") {
			await writePatch(patchPath);
			data = implArtifact({ patchPath });
		} else if (agent === "reviewer" || /Independent code review/i.test(request.assignment)) {
			data = reviewArtifact("approved", "implementation");
		} else throw new Error(`unexpected legacy agent ${agent}`);
		return {
			result: {
				id: `legacy-${calls.length}`,
				structuredOutput: { status: "valid", data },
				patchPath: agent === "task" || agent === "implementer" ? patchPath : undefined,
				resolvedModel: model,
			},
		};
	};
}

function availableProfiles(): WorkflowAvailabilityPort {
	return {
		async probe({ profile }) {
			const configured = Array.isArray(profile.modelPattern) ? profile.modelPattern[0]! : profile.modelPattern;
			const slash = configured.indexOf("/");
			const provider = slash > 0 ? configured.slice(0, slash) : profile.vendor;
			const model = slash > 0 ? configured.slice(slash + 1) : configured;
			return {
				status: "available",
				actualProvider: provider,
				actualModel: model,
				attestedProvider: provider,
				attestedModel: model,
				identityProvenance: "provider_echo",
				exactIdentityMatch: true,
				effortSupported: true,
				latencyMs: 1,
			};
		},
	};
}

function captureMerger(calls: CapturedChangesMergeRequest[]): CapturedChangesMerger {
	return async request => {
		calls.push({ ...request, patches: request.patches.map(patch => ({ ...patch })) });
		const content = await Promise.all(
			request.patches.map(async patch => {
				const fullPath = path.isAbsolute(patch.patchPath)
					? patch.patchPath
					: path.join(request.cwd, patch.patchPath);
				return Bun.file(fullPath).text();
			}),
		);
		await fs.mkdir(path.dirname(request.outputPatchPath), { recursive: true });
		await Bun.write(
			request.outputPatchPath,
			content.map(text => (text.length === 0 || text.endsWith("\n") ? text : `${text}\n`)).join(""),
		);
		const applied = Bun.spawn(["git", "apply", request.outputPatchPath], {
			cwd: request.cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		if ((await applied.exited) !== 0) throw new Error(await new Response(applied.stderr).text());
		return { patchPath: request.outputPatchPath, changesApplied: true, summary: "captured" };
	};
}

function makeEngine(options: {
	store: WorkflowStore;
	artifactStore: ArtifactStore;
	session: ToolSession;
	config?: QualityConfigFixture;
	runner: StructuredRunner;
	merger?: CapturedChangesMerger;
	availability?: WorkflowAvailabilityPort;
	verifier?: VerifierPort;
}): WorkflowEngine {
	return new WorkflowEngine({
		store: options.store,
		config: options.config,
		adapter: new RuntimeAdapter(options.runner, options.merger),
		verifier: options.verifier ?? passVerifier(),
		artifactStore: options.artifactStore,
		session: options.session,
		availability: options.availability,
		ownsStore: false,
	});
}

async function initializeGitFixture(cwd: string): Promise<string> {
	const sourcePath = path.join(cwd, "src", "a.ts");
	await fs.mkdir(path.dirname(sourcePath), { recursive: true });
	await Bun.write(sourcePath, "before\n");
	await $`git init -q`.cwd(cwd);
	await $`git config user.email test@example.invalid`.cwd(cwd);
	await $`git config user.name workflow-test`.cwd(cwd);
	await $`git add src/a.ts`.cwd(cwd);
	await $`git commit -qm base`.cwd(cwd);
	return sourcePath;
}

describe("WorkflowEngine quality routes", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let cwd: string;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-quality-route-arts-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-quality-route-cwd-"));
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("persists the selected tier in policy and writes the same frozen snapshot artifact", async () => {
		const config = qualityConfig();
		const calls: RunnerCall[] = [];
		const session = fakeSession({ cwd });
		const artifactStore = new ArtifactStore(artifactDir);
		const engine = makeEngine({
			store,
			artifactStore,
			session,
			config,
			runner: qualityRunner({ calls }),
			availability: availableProfiles(),
		});

		const started = await engine.start({ request: "persist quality route", qualityTier: "balanced" });
		const created = await store.getCurrentState(started.workflowId);
		expect(created?.status).toBe("created");
		const persistedRequest = JSON.parse(created!.requestJson) as { qualityTier?: string };
		const policy = JSON.parse(created!.policyJson) as {
			degradedMode: boolean;
			qualityRouteSnapshot?: { qualityTier: string; fingerprint: string; routes: Record<string, string[]> };
		};
		expect(persistedRequest.qualityTier).toBe("balanced");
		expect(policy.degradedMode).toBe(false);
		expect(policy.qualityRouteSnapshot?.qualityTier).toBe("balanced");
		expect(policy.qualityRouteSnapshot?.fingerprint).toEqual(expect.any(String));

		await engine.resume(started.workflowId, { singleStep: true, session });
		await engine.resume(started.workflowId, { singleStep: true, session });

		const metadata = (await store.listArtifacts(started.workflowId)).find(
			artifact => artifact.kind === "quality-route-snapshot",
		);
		expect(metadata).toBeDefined();
		const loaded = await artifactStore.load(metadata!.relativePath, metadata!.sha256);
		expect(loaded?.content).toBeDefined();
		expect(JSON.parse(loaded!.content!)).toEqual(policy.qualityRouteSnapshot);
		expect(calls.map(call => call.stage)).toEqual(["planning"]);
	});

	it("rejects degraded mode whenever a quality route tier is selected", async () => {
		const calls: RunnerCall[] = [];
		const engine = makeEngine({
			store,
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd }),
			config: qualityConfig(),
			runner: qualityRunner({ calls }),
			availability: availableProfiles(),
		});

		await expect(
			engine.start({ request: "degraded quality route", qualityTier: "critical" }, { degradedMode: true }),
		).rejects.toThrow(/quality_route_degraded_mode_forbidden/);
		expect(calls).toHaveLength(0);
	});

	it("resumes from the persisted snapshot after settings, profiles, and routes mutate", async () => {
		const initial = qualityConfig();
		let active = initial;
		const calls: RunnerCall[] = [];
		const settingsSession = fakeSession({
			cwd,
			settings: {
				get: (key: string) => {
					if (key === "workflow.profiles") return active.profiles;
					if (key === "workflow.qualityRoutes") return active.qualityRoutes;
					if (key === "workflow.defaultQualityTier") return active.defaultQualityTier;
					return undefined;
				},
				set: () => {},
			} as unknown as ToolSession["settings"],
		});
		const artifactStore = new ArtifactStore(artifactDir);
		const tool = new WorkflowTool(settingsSession, session => {
			return makeEngine({
				store,
				artifactStore,
				session,
				config: active,
				runner: qualityRunner({ calls }),
				availability: availableProfiles(),
			});
		});

		const started = await tool.execute("start", {
			op: "start",
			request: "freeze route before settings change",
			qualityTier: "balanced",
		});
		const workflowId = started.details!.workflowId!;
		await tool.execute("advance-created", { op: "resume", workflowId, singleStep: true });
		const initialState = await store.getCurrentState(workflowId);
		const initialPolicy = JSON.parse(initialState!.policyJson) as {
			qualityRouteSnapshot: { fingerprint: string; routes: Record<string, string[]> };
		};
		const initialPlanner = initial.profiles.balanced_planner!;
		const initialPlannerModel = Array.isArray(initialPlanner.modelPattern)
			? initialPlanner.modelPattern[0]!
			: initialPlanner.modelPattern;

		active = qualityConfig("mutated");
		expect(active.profiles.balanced_planner_mutated?.modelPattern).not.toBe(initialPlanner.modelPattern);
		await tool.execute("resume-planning", { op: "resume", workflowId, singleStep: true });

		expect(calls).toEqual([{ stage: "planning", model: initialPlannerModel }]);
		const finalState = await store.getCurrentState(workflowId);
		const finalPolicy = JSON.parse(finalState!.policyJson) as typeof initialPolicy;
		expect(finalPolicy.qualityRouteSnapshot.fingerprint).toBe(initialPolicy.qualityRouteSnapshot.fingerprint);
		expect(finalPolicy.qualityRouteSnapshot.routes).toEqual(initialPolicy.qualityRouteSnapshot.routes);
		const snapshotMeta = (await store.listArtifacts(workflowId)).find(
			artifact => artifact.kind === "quality-route-snapshot",
		);
		expect(snapshotMeta).toBeDefined();
		const persisted = await artifactStore.load(snapshotMeta!.relativePath, snapshotMeta!.sha256);
		expect(JSON.parse(persisted!.content!).fingerprint).toBe(initialPolicy.qualityRouteSnapshot.fingerprint);
	});

	it("fails closed before attempts when a persisted quality policy is truncated", async () => {
		const dbPath = path.join(os.tmpdir(), `wf-quality-corrupt-${crypto.randomUUID()}.db`);
		const persistedStore = new WorkflowStore(dbPath);
		const calls: RunnerCall[] = [];
		const session = fakeSession({ cwd });
		const artifactStore = new ArtifactStore(artifactDir);
		try {
			const engine = makeEngine({
				store: persistedStore,
				artifactStore,
				session,
				config: qualityConfig(),
				runner: qualityRunner({ calls }),
				availability: availableProfiles(),
			});
			const { workflowId } = await engine.start({ request: "corrupt frozen route", qualityTier: "balanced" });

			const database = new Database(dbPath);
			try {
				database.run("UPDATE workflows SET policy_json = ? WHERE id = ?", ['{"degradedMode":false', workflowId]);
			} finally {
				database.close();
			}

			const resumed = makeEngine({
				store: persistedStore,
				artifactStore,
				session,
				config: qualityConfig("mutated"),
				runner: qualityRunner({ calls }),
				availability: availableProfiles(),
			});
			await expect(resumed.resume(workflowId, { singleStep: true, session })).rejects.toThrow(
				/quality_route_policy_invalid/,
			);
			expect(calls).toHaveLength(0);
			expect(await persistedStore.listAttempts(workflowId)).toHaveLength(0);
		} finally {
			persistedStore.close();
			await fs.rm(dbPath, { force: true });
		}
	});

	it("fails closed before attempts when valid quality policy JSON loses its snapshot", async () => {
		const dbPath = path.join(os.tmpdir(), `wf-quality-missing-${crypto.randomUUID()}.db`);
		const persistedStore = new WorkflowStore(dbPath);
		const calls: RunnerCall[] = [];
		const session = fakeSession({ cwd });
		const artifactStore = new ArtifactStore(artifactDir);
		try {
			const engine = makeEngine({
				store: persistedStore,
				artifactStore,
				session,
				config: qualityConfig(),
				runner: qualityRunner({ calls }),
				availability: availableProfiles(),
			});
			const { workflowId } = await engine.start({ request: "remove frozen route", qualityTier: "balanced" });
			const state = await persistedStore.getCurrentState(workflowId);
			const policy = JSON.parse(state!.policyJson) as Record<string, unknown>;
			delete policy.qualityRouteSnapshot;

			const database = new Database(dbPath);
			try {
				database.run("UPDATE workflows SET policy_json = ? WHERE id = ?", [JSON.stringify(policy), workflowId]);
			} finally {
				database.close();
			}

			const resumed = makeEngine({
				store: persistedStore,
				artifactStore,
				session,
				config: qualityConfig("mutated"),
				runner: qualityRunner({ calls }),
				availability: availableProfiles(),
			});
			await expect(resumed.resume(workflowId, { singleStep: true, session })).rejects.toThrow(
				/quality_route_snapshot_missing/,
			);
			expect(calls).toHaveLength(0);
			expect(await persistedStore.listAttempts(workflowId)).toHaveLength(0);
		} finally {
			persistedStore.close();
			await fs.rm(dbPath, { force: true });
		}
	});

	it("does not persist an unreachable workflow when quality preflight fails", async () => {
		const dbPath = path.join(os.tmpdir(), `wf-quality-preflight-${crypto.randomUUID()}.db`);
		const persistedStore = new WorkflowStore(dbPath);
		const calls: RunnerCall[] = [];
		const session = fakeSession({ cwd });
		try {
			const engine = makeEngine({
				store: persistedStore,
				artifactStore: new ArtifactStore(artifactDir),
				session,
				config: qualityConfig(),
				runner: qualityRunner({ calls }),
				availability: {
					async probe({ profile }) {
						if (profile.roles.includes("planner")) {
							return { status: "unavailable", latencyMs: 1, errorKind: "quota" };
						}
						return availableProfiles().probe({ profile, role: profile.roles[0]!, session });
					},
				},
			});

			await expect(engine.start({ request: "preflight must fail", qualityTier: "balanced" })).rejects.toThrow(
				/required_role_unavailable/,
			);
			expect(calls).toHaveLength(0);
			const database = new Database(dbPath);
			try {
				const row = database.query("SELECT COUNT(*) AS count FROM workflows").get() as { count: number };
				expect(row.count).toBe(0);
			} finally {
				database.close();
			}
		} finally {
			persistedStore.close();
			await fs.rm(dbPath, { force: true });
		}
	});

	it("blocks a critical code reviewer with the implementer's model lineage before invoking it", async () => {
		const sourcePath = await initializeGitFixture(cwd);
		const calls: RunnerCall[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const session = fakeSession({ cwd });
		const engine = makeEngine({
			store,
			artifactStore: new ArtifactStore(artifactDir),
			session,
			config: qualityConfig("", true),
			runner: qualityRunner({ calls, patchRoot: artifactDir }),
			merger: captureMerger(mergeCalls),
			availability: availableProfiles(),
		});

		const id = await engine.startWorkflow({ request: "critical lineage gate", qualityTier: "critical" });
		const result = await engine.run(id, session);
		expect(result.state.status).toBe("blocked");
		expect(calls.filter(call => call.stage === "code_review")).toHaveLength(0);
		expect(mergeCalls).toHaveLength(1);
		// Implement/merge completed with attested identity and approved scope; the
		// lineage block happens only when selecting the code reviewer afterwards.
		expect(await Bun.file(sourcePath).text()).toBe("before\nconst x = 1\n");
		const codeReviewAttempt = (await store.listAttempts(id)).find(attempt => attempt.stage === "code_review");
		expect(codeReviewAttempt?.status).toBe("failed");
		expect(codeReviewAttempt?.errorSummary).toMatch(/independent_reviewer_unavailable/);
	});

	it("does not merge or mutate the fixture when strict write identity is unknown", async () => {
		const sourcePath = path.join(cwd, "src", "a.ts");
		await fs.mkdir(path.dirname(sourcePath), { recursive: true });
		await Bun.write(sourcePath, "before\n");
		const calls: RunnerCall[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const engine = makeEngine({
			store,
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd }),
			config: qualityConfig(),
			runner: qualityRunner({ calls, patchRoot: artifactDir, implementIdentity: "unknown" }),
			merger: captureMerger(mergeCalls),
			availability: availableProfiles(),
		});
		const id = await engine.startWorkflow({ request: "unknown strict identity", qualityTier: "balanced" });

		await expect(engine.run(id, fakeSession({ cwd }))).rejects.toThrow(
			/identity|quality_route_candidates_exhausted/i,
		);
		expect((await engine.getState(id))?.status).toBe("blocked");
		expect(mergeCalls).toHaveLength(0);
		expect(await Bun.file(sourcePath).text()).toBe("before\n");
	});

	it("does not merge or mutate the fixture when strict write identity mismatches", async () => {
		const sourcePath = path.join(cwd, "src", "a.ts");
		await fs.mkdir(path.dirname(sourcePath), { recursive: true });
		await Bun.write(sourcePath, "before\n");
		const calls: RunnerCall[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const engine = makeEngine({
			store,
			artifactStore: new ArtifactStore(artifactDir),
			session: fakeSession({ cwd }),
			config: qualityConfig(),
			runner: qualityRunner({ calls, patchRoot: artifactDir, implementIdentity: "mismatch" }),
			merger: captureMerger(mergeCalls),
			availability: availableProfiles(),
		});
		const id = await engine.startWorkflow({ request: "mismatched strict identity", qualityTier: "balanced" });

		await expect(engine.run(id, fakeSession({ cwd }))).rejects.toThrow(
			/identity|quality_route_candidates_exhausted/i,
		);
		expect((await engine.getState(id))?.status).toBe("blocked");
		expect(mergeCalls).toHaveLength(0);
		expect(await Bun.file(sourcePath).text()).toBe("before\n");
	});

	it("canonicalizes legacy effort aliases before routing", async () => {
		const aliasProfile = {
			...strictProfile("legacy_alias_planner", "planner", "xai/grok-4.6", "xai"),
			strictIdentity: false,
			thinkingLevel: "med" as ModelProfile["thinkingLevel"],
		};
		let observedEffort: unknown;
		const session = fakeSession({ cwd });
		const engine = makeEngine({
			store,
			artifactStore: new ArtifactStore(artifactDir),
			session,
			config: {
				profiles: { [aliasProfile.id]: aliasProfile },
				qualityRoutes: {},
				defaultQualityTier: "balanced",
			},
			runner: async request => {
				observedEffort = request.thinkingLevel;
				return {
					result: {
						id: "legacy-alias-planner",
						structuredOutput: { status: "valid", data: planArtifact() },
						resolvedModel: "xai/grok-4.6",
					},
				};
			},
		});
		const workflowId = await engine.startWorkflow({ request: "canonical legacy effort" });

		await engine.resume(workflowId, { singleStep: true, session });
		await engine.resume(workflowId, { singleStep: true, session });

		expect(observedEffort).toBe("medium");
	});

	it("runs implementation verification deterministically without another model invocation", async () => {
		const patchPath = path.join(artifactDir, "legacy.patch");
		const modelCalls: string[] = [];
		let verifierCalls = 0;
		const verifier: VerifierPort = {
			async verify(artifact) {
				verifierCalls += 1;
				const result: VerificationArtifactV1 = {
					kind: "verification",
					schemaVersion: 1,
					workflowId: artifact.workflowId,
					attemptId: artifact.attemptId,
					stage: artifact.stage,
					createdAt: new Date().toISOString(),
					passed: true,
					checks: [{ id: "deterministic", status: "passed", summary: "patch verified" }],
				};
				return result;
			},
		};
		const session = fakeSession({ cwd });
		const engine = makeEngine({
			store,
			artifactStore: new ArtifactStore(artifactDir),
			session,
			runner: legacyRunner(modelCalls, patchPath),
			verifier,
		});
		const id = await engine.startWorkflow({ request: "deterministic verification" });
		await engine.resume(id, { singleStep: true, session });
		await engine.resume(id, { singleStep: true, session });
		await engine.resume(id, { singleStep: true, session });
		await engine.resume(id, { singleStep: true, session });
		expect((await engine.getState(id))?.status).toBe("implementation_verify");
		const modelCallsBeforeVerify = modelCalls.length;

		const result = await engine.resume(id, { singleStep: true, session });
		expect(result.state.status).toBe("code_review");
		expect(modelCalls.length).toBe(modelCallsBeforeVerify);
		expect(verifierCalls).toBe(1);
	});
});
