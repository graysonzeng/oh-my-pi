import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { $ } from "bun";
import { LATENCY_ARM_IDS, LATENCY_ARM_SETTINGS, type LatencyArmId } from "../../src/latency/arms";
import { buildMechanicalClass } from "../../src/latency/mechanical-class";
import type { ToolSession } from "../../src/tools";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import type { WorkflowDefaultConfig } from "../../src/workflow/default-config";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowCancelledError, WorkflowError, WorkflowPolicyError } from "../../src/workflow/errors";
import { sha256Hex } from "../../src/workflow/optimization-receipt";
import {
	RuntimeAdapter,
	type StructuredRunner,
	type StructuredRunnerRequest,
	type StructuredRunnerResult,
} from "../../src/workflow/runtime-adapter";
import { buildScopeMetrics } from "../../src/workflow/scope-metrics";
import { WorkflowStore } from "../../src/workflow/sqlite-store";
import type {
	CapturedChangesMergeRequest,
	CapturedChangesMerger,
	ImplementationArtifactV1,
	ModelProfile,
	PlanArtifactV1,
	PlanReviewArtifactV2,
	ReviewArtifactV1,
	ReviewFindingV1,
	VerifierPort,
	WorkflowAvailabilityPort,
	WorkflowQualityRoutes,
	WorkflowRole,
	WorkflowRuntimeIdentityReceiptV1,
	WorkPackageStateArtifactV1,
	WorkPackageV1,
} from "../../src/workflow/types";
import { executeWorkPackagePlan, type WorkPackageExecutionPlan } from "../../src/workflow/work-packages";
import { planReviewArtifactV2, reviewArtifact } from "./helpers";

type ScriptValue<T> = T | (() => T);
type ImplementScript = (
	request: StructuredRunnerRequest,
	packageId: string | undefined,
) => ImplementationArtifactV1 | Promise<ImplementationArtifactV1>;

interface RunnerScript {
	plan: ScriptValue<PlanArtifactV1>;
	planReview: ScriptValue<PlanReviewArtifactV2>;
	implement: ImplementScript;
	codeReview: ScriptValue<ReviewArtifactV1>;
	identityMode?: (request: StructuredRunnerRequest, packageId: string | undefined) => IdentityMode;
}

const PACKAGE_ASSIGNMENT = /^# Work package `([^`]+)`/;
type IdentityMode = "valid" | "unknown" | "mismatch";

const MEDIUM = "medium" as NonNullable<ModelProfile["thinkingLevel"]>;

function resolveScript<T>(value: ScriptValue<T>): T {
	return typeof value === "function" ? (value as () => T)() : value;
}

function packageIdFromAssignment(assignment: string): string | undefined {
	return PACKAGE_ASSIGNMENT.exec(assignment)?.[1];
}

function requestModel(request: StructuredRunnerRequest): string {
	const model = Array.isArray(request.model) ? request.model[0] : request.model;
	if (!model) throw new Error("strict package runner requires a model");
	return model;
}

function emitRuntimeIdentity(request: StructuredRunnerRequest, mode: IdentityMode): void {
	if (mode === "unknown") return;
	const configured = requestModel(request);
	const slash = configured.indexOf("/");
	const provider = slash > 0 ? configured.slice(0, slash) : "xai";
	const model = slash > 0 ? configured.slice(slash + 1) : configured;
	const attestedModel = mode === "mismatch" ? `${model}-mismatch` : model;
	const reportedEffort = request.thinkingLevel ?? MEDIUM;
	request.onResponse?.(
		{ status: 200, headers: { "x-provider-model": `${provider}/${attestedModel}` } } as never,
		{
			provider,
			id: model,
			reasoning: true,
			thinking: { efforts: [reportedEffort] },
		} as never,
	);
}

function strictProfile(id: string, role: WorkflowRole, modelPattern: string, vendor: string): ModelProfile {
	return {
		id,
		vendor,
		modelPattern,
		roles: [role],
		thinkingLevel: MEDIUM,
		strictIdentity: true,
		promptTemplate: role,
		promptVersion: "strict-package-test-1",
		toolPolicyId: "strict-package-test",
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

function strictPackageConfig(
	forbiddenPaths: string[] = [],
	implementerProfile = strictProfile("strict_implementer", "implementer", "xai/grok-4.6", "xai"),
): Partial<WorkflowDefaultConfig> {
	const profiles = [
		strictProfile("strict_planner", "planner", "anthropic/claude-fable-5", "anthropic"),
		strictProfile("strict_plan_reviewer", "plan_reviewer", "openai/gpt-5.6-sol", "openai"),
		implementerProfile,
		strictProfile("strict_code_reviewer", "code_reviewer", "openai/gpt-5.6-sol", "openai"),
		strictProfile("strict_repair", "repair", "anthropic/claude-fable-5", "anthropic"),
	];
	const route: Readonly<Record<WorkflowRole, readonly string[]>> = {
		planner: ["strict_planner"],
		plan_reviewer: ["strict_plan_reviewer"],
		plan_arbitrator: [],
		implementer: [implementerProfile.id],
		code_reviewer: ["strict_code_reviewer"],
		repair: ["strict_repair"],
	};
	const qualityRoutes: WorkflowQualityRoutes = { balanced: route, critical: route };
	return {
		profiles: Object.fromEntries(profiles.map(profile => [profile.id, profile])),
		qualityRoutes,
		defaultQualityTier: "balanced",
		forbiddenPaths,
	};
}

function roleStaticSplitConfig(): Partial<WorkflowDefaultConfig> {
	const flashRepair = strictProfile("role_repair_flash", "repair", "deepseek/deepseek-v4-flash", "deepseek");
	flashRepair.thinkingLevel = ThinkingLevel.Max;
	const profiles = [
		strictProfile("role_planner", "planner", "anthropic/claude-fable-5", "anthropic"),
		strictProfile("role_plan_reviewer", "plan_reviewer", "openai/gpt-5.6-sol", "openai"),
		strictProfile("role_implementer", "implementer", "xai/grok-4.6", "xai"),
		strictProfile("role_code_reviewer", "code_reviewer", "openai/gpt-5.6-terra", "openai"),
		strictProfile("role_repair_strong", "repair", "anthropic/claude-fable-5", "anthropic"),
		flashRepair,
	];
	return { profiles: Object.fromEntries(profiles.map(profile => [profile.id, profile])), qualityRoutes: {} };
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

function strictPackageReceipt(
	profileId = "strict_implementer",
	provider = "xai",
	model = "grok-4.6",
	modelFamily = "xai",
): WorkflowRuntimeIdentityReceiptV1 {
	return {
		schemaVersion: 1,
		configured: {
			profileId,
			provider,
			model,
			checkpoint: null,
			provenance: "configured",
			modelPattern: `${provider}/${model}`,
			requestedEffort: MEDIUM,
			modelFamily,
		},
		localResolution: {
			provider,
			model,
			checkpoint: null,
			provenance: "local_resolution",
		},
		attested: {
			provider,
			model,
			checkpoint: null,
			provenance: "provider_echo",
		},
		exactMatch: true,
		effortSupported: true,
		modelFamily,
	};
}

function makePlan(workPackages?: WorkPackageV1[]): PlanArtifactV1 {
	const affectedFiles = [
		...new Set((workPackages?.flatMap(workPackage => workPackage.paths) ?? ["src/a.ts"]).map(file => file.trim())),
	].map(pathname => ({ path: pathname, action: "modify" as const, reason: "test" }));
	const implementationSteps = workPackages?.map(workPackage => ({
		id: `step-${workPackage.id}`,
		description: workPackage.assignment,
		dependsOn: workPackage.dependsOn.map(dependency => `step-${dependency}`),
	})) ?? [{ id: "step-a", description: "edit src/a.ts", dependsOn: [] }];
	const plan: PlanArtifactV1 = {
		schemaVersion: 1,
		workflowId: "wf",
		attemptId: "att",
		stage: "planning",
		createdAt: new Date().toISOString(),
		kind: "plan",
		summary: "Implement the test plan",
		assumptions: [],
		nonGoals: [],
		affectedFiles,
		implementationSteps,
		acceptanceCriteria: ["the workflow completes"],
		verificationCommands: [],
		risks: [],
		rollback: [],
	};
	if (workPackages) {
		plan.workPackages = workPackages.map(workPackage => ({
			...workPackage,
			paths: [...workPackage.paths],
			dependsOn: [...workPackage.dependsOn],
		}));
	}
	return plan;
}

function makeReview(subject: "plan"): PlanReviewArtifactV2;
function makeReview(subject: "implementation"): ReviewArtifactV1;
function makeReview(subject: ReviewArtifactV1["subject"]): PlanReviewArtifactV2 | ReviewArtifactV1 {
	if (subject === "plan") return planReviewArtifactV2("approved");
	return {
		schemaVersion: 1,
		workflowId: "wf",
		attemptId: "att",
		stage: "code_review",
		createdAt: new Date().toISOString(),
		kind: "review",
		subject,
		decision: "approved",
		findings: [],
		explanation: "approved by scripted review",
		confidence: 0.99,
	};
}

function makeImplementation(
	patchPath: string,
	changedFiles: string[],
	summary = "implemented",
): ImplementationArtifactV1 {
	return {
		schemaVersion: 1,
		workflowId: "wf",
		attemptId: "att",
		stage: "implementing",
		createdAt: new Date().toISOString(),
		kind: "implementation",
		summary,
		changedFiles: [...changedFiles],
		addressedStepIds: changedFiles.map(file => `step-${file.replaceAll("/", "-")}`),
		commandsRun: [],
		patchPath,
		branchName: "wf/test",
		unresolved: [],
	};
}

function patchText(
	changedFiles: readonly string[],
	replacements: Readonly<Record<string, { before: string; after: string }>> = {},
): string {
	return changedFiles
		.map(file => {
			const stem = path.basename(file, path.extname(file));
			const replacement = replacements[file] ?? { before: `before-${stem}`, after: `after-${stem}` };
			return [
				`diff --git a/${file} b/${file}`,
				`--- a/${file}`,
				`+++ b/${file}`,
				"@@ -1 +1 @@",
				`-${replacement.before}`,
				`+${replacement.after}`,
				"",
			].join("\n");
		})
		.join("\n");
}

async function writePatchFile(
	cwd: string,
	patchPath: string,
	changedFiles: readonly string[],
	replacements: Readonly<Record<string, { before: string; after: string }>> = {},
): Promise<void> {
	const fullPath = path.isAbsolute(patchPath) ? patchPath : path.join(cwd, patchPath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });
	await Bun.write(fullPath, patchText(changedFiles.length > 0 ? changedFiles : ["src/a.ts"], replacements));
}

async function initializeGitRepository(repository: string): Promise<void> {
	await $`git init -q -b main`.cwd(repository).quiet();
	await $`git config user.email test@example.com`.cwd(repository).quiet();
	await $`git config user.name Test`.cwd(repository).quiet();
	await $`git add .`.cwd(repository).quiet();
	await $`git commit -q -m initial`.cwd(repository).quiet();
}

function scriptedRunner(script: RunnerScript): StructuredRunner {
	return async request => {
		const agent = request.agent ?? "";
		let label: string;
		let data: unknown;
		let patchPath: string | undefined;
		let branchName: string | undefined;
		if (agent === "designer" || agent === "planner") {
			label = "plan";
			data = resolveScript(script.plan);
		} else if (agent === "reviewer" || agent === "plan_reviewer" || agent === "code_reviewer") {
			if (
				/Independent code review/i.test(request.assignment) ||
				/code review|implementation/i.test(request.assignment)
			) {
				label = "code-review";
				data = resolveScript(script.codeReview);
			} else {
				label = "plan-review";
				data = resolveScript(script.planReview);
			}
		} else if (agent === "task" || agent === "implementer") {
			label = "implement";
			const packageId = packageIdFromAssignment(request.assignment);
			const artifact = await script.implement(request, packageId);
			data = artifact;
			patchPath = artifact.patchPath;
			branchName = artifact.branchName;
			if (patchPath) await writePatchFile(request.session.cwd, patchPath, artifact.changedFiles);
		} else {
			throw new Error(`unexpected scripted agent ${agent}`);
		}
		// Always emit provider-echo attestation so plan_reviewer pin (HIGH-4) and
		// implementer identity receipts succeed under strict routes.
		const identityMode: IdentityMode =
			script.identityMode?.(request, packageIdFromAssignment(request.assignment)) ?? "valid";
		emitRuntimeIdentity(request, identityMode);
		const result: StructuredRunnerResult["result"] = {
			id: `scripted-${label}`,
			structuredOutput: { status: "valid", data },
			patchPath,
			branchName,
			resolvedModel: identityMode === "unknown" ? "test/model" : requestModel(request),
		};
		return { result };
	};
}

function fakeSession(
	cwd: string,
	maxConcurrency = 1,
	exposeMaxConcurrency = true,
	latency?: {
		frozen?: Partial<Record<LatencyArmId, boolean>>;
		live?: Partial<Record<LatencyArmId, boolean>>;
	},
): ToolSession {
	const settings = {
		get: (key: string): unknown => {
			if (key === "task.maxConcurrency" && exposeMaxConcurrency) return maxConcurrency;
			for (const arm of LATENCY_ARM_IDS) {
				if (key === LATENCY_ARM_SETTINGS[arm]) return latency?.live?.[arm];
			}
			return undefined;
		},
		set: () => {},
	};
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: settings as unknown as ToolSession["settings"],
		...(latency?.frozen ? { isLatencyArmEnabled: (arm: LatencyArmId) => latency.frozen?.[arm] === true } : {}),
	};
}

function passVerifier(): VerifierPort {
	return {
		async verify(artifact) {
			return {
				kind: "verification",
				schemaVersion: 1,
				workflowId: artifact.workflowId,
				attemptId: artifact.attemptId,
				stage: artifact.stage,
				createdAt: new Date().toISOString(),
				passed: true,
				checks: [{ id: "pass", status: "passed", summary: "scripted verifier passed" }],
			};
		},
	};
}

function combinedMerger(calls: CapturedChangesMergeRequest[]): CapturedChangesMerger {
	return async request => {
		calls.push({ ...request, patches: request.patches.map(patch => ({ ...patch })) });
		const contents = await Promise.all(
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
			contents.map(content => (content.length === 0 || content.endsWith("\n") ? content : `${content}\n`)).join(""),
		);
		const applied = Bun.spawn(["git", "apply", request.outputPatchPath], {
			cwd: request.cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		if ((await applied.exited) !== 0) throw new Error(await new Response(applied.stderr).text());
		return {
			patchPath: request.outputPatchPath,
			changesApplied: true,
			summary: `merged ${request.patches.map(patch => patch.packageId).join(",")}`,
		};
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(value => {
		resolve = value;
	});
	return { promise, resolve };
}

describe("WorkflowEngine work-package execution", () => {
	let store: WorkflowStore;
	let artifactDir: string;
	let cwd: string;
	let artifactStore: ArtifactStore;

	beforeEach(async () => {
		store = new WorkflowStore(":memory:");
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-package-engine-arts-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wf-package-engine-cwd-"));
		artifactStore = new ArtifactStore(artifactDir);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await Bun.write(path.join(cwd, "src/a.ts"), "before-a\n");
		await Bun.write(path.join(cwd, "src/b.ts"), "before-b\n");
		await Bun.write(path.join(cwd, "src/c.ts"), "before-c\n");
		await fs.mkdir(path.join(cwd, "src/shared-a"), { recursive: true });
		await fs.mkdir(path.join(cwd, "src/shared-b"), { recursive: true });
		await Bun.write(path.join(cwd, "src/shared-a/a.ts"), "before-a\n");
		await Bun.write(path.join(cwd, "src/shared-b/b.ts"), "before-b\n");
	});

	afterEach(async () => {
		store.close();
		await fs.rm(artifactDir, { recursive: true, force: true });
		await fs.rm(cwd, { recursive: true, force: true });
	});

	function makeEngine(
		runner: StructuredRunner,
		merger: CapturedChangesMerger | undefined,
		maxConcurrency = 1,
		config?: Partial<WorkflowDefaultConfig>,
	): WorkflowEngine {
		return new WorkflowEngine({
			store,
			config,
			adapter: new RuntimeAdapter(runner, merger),
			verifier: passVerifier(),
			artifactStore,
			session: fakeSession(cwd, maxConcurrency),
			availability: config ? availableProfiles() : undefined,
		});
	}

	async function latestPackageState(workflowId: string): Promise<WorkPackageStateArtifactV1> {
		const candidates = (await artifactStore.listByWorkflow(workflowId))
			.filter(artifact => artifact.kind === "work-package-state" && typeof artifact.content === "string")
			.map(artifact => JSON.parse(artifact.content!) as WorkPackageStateArtifactV1)
			.sort((left, right) => left.revision - right.revision);
		const latest = candidates.at(-1);
		if (!latest) throw new Error("missing persisted work-package state");
		return latest;
	}

	async function persistPackageState(workflowId: string, attemptId: string, state: WorkPackageStateArtifactV1) {
		const stored = await artifactStore.store({
			workflowId,
			attemptId,
			kind: "work-package-state",
			schemaVersion: 1,
			relativePath: "",
			content: JSON.stringify(state),
		});
		await store.addArtifact(stored);
	}

	/**
	 * Persist a strict write-commit state as if the engine crashed right after the
	 * merger applied the canonical patch but before the applied-state write, plus
	 * the approved scope metrics the recovery path rehydrates.
	 */
	async function persistStrictWriteRecoveryState(options: {
		workflowId: string;
		staleAttemptId: string;
		stage: "implementing" | "repairing";
		packageId: string;
		profileId: string;
		receipt: WorkflowRuntimeIdentityReceiptV1;
		patchPath: string;
		changedFiles: string[];
		mergeStatus: "prepared" | "applied";
		patchSha256?: string;
		addressedStepIds?: string[];
		revision?: number;
	}) {
		const state: WorkPackageStateArtifactV1 = {
			kind: "work-package-state",
			schemaVersion: 1,
			workflowId: options.workflowId,
			attemptId: options.staleAttemptId,
			stage: options.stage,
			createdAt: new Date().toISOString(),
			revision: options.revision ?? 4,
			mode: "capture_then_apply",
			packages: [
				{
					id: options.packageId,
					assignment: `Validated ${options.stage} write`,
					paths: [...options.changedFiles],
					dependsOn: [],
					status: "succeeded",
					invocationAttemptId: `${options.staleAttemptId}:${options.packageId}`,
					implementation: {
						...makeImplementation(options.patchPath, options.changedFiles, `recovered ${options.stage}`),
						modelProfileId: options.profileId,
						...(options.addressedStepIds ? { addressedStepIds: [...options.addressedStepIds] } : {}),
					},
					identityReceipt: options.receipt,
					modelFamily: options.receipt.modelFamily ?? undefined,
				},
			],
			scopeStatus: "adhered",
			merge: {
				status: options.mergeStatus,
				order: [options.packageId],
				patchPath: options.patchPath,
				changesApplied: options.mergeStatus === "applied",
				summary: "fabricated recovery fixture",
				...(options.patchSha256 ? { patchSha256: options.patchSha256 } : {}),
			},
		};
		await persistPackageState(options.workflowId, options.staleAttemptId, state);
		const scopeMetrics = buildScopeMetrics({
			plannedFiles: options.changedFiles,
			changedFiles: options.changedFiles,
		});
		const storedScope = await artifactStore.store({
			workflowId: options.workflowId,
			attemptId: options.staleAttemptId,
			kind: "scope-metrics",
			schemaVersion: 1,
			relativePath: "",
			content: JSON.stringify(scopeMetrics),
		});
		await store.addArtifact(storedScope);
	}

	it("routes frozen role-static repair to Flash without degrading the plan reviewer", async () => {
		const cases = [
			{ frozen: true, live: false, expectedRepairModel: "deepseek/deepseek-v4-flash" },
			{ frozen: false, live: true, expectedRepairModel: "anthropic/claude-fable-5" },
		] as const;
		for (const testCase of cases) {
			const repairModels: string[] = [];
			const planReviewerModels: string[] = [];
			let codeReviewCalls = 0;
			const finding: ReviewFindingV1 = {
				id: "mechanical-repair",
				priority: "P2",
				category: "maintainability",
				status: "open",
				confidence: 0.99,
				summary: "Apply the deterministic repair",
				explanation: "The scripted repair is mechanical",
				suggestedOwner: "implementer",
				blocking: true,
			};
			const scripted = scriptedRunner({
				plan: makePlan(),
				planReview: makeReview("plan"),
				implement: async (request, packageId) => {
					const isRepair = /Repair findings/i.test(request.assignment);
					if (isRepair) repairModels.push(requestModel(request));
					const artifact = makeImplementation(
						`patches/${packageId ?? "whole-plan"}.patch`,
						["src/a.ts"],
						packageId ? "repair" : "implementation",
					);
					return isRepair ? { ...artifact, addressedStepIds: [finding.id] } : artifact;
				},
				codeReview: () => {
					codeReviewCalls += 1;
					if (codeReviewCalls === 1) {
						return { ...makeReview("implementation"), decision: "changes_requested", findings: [finding] };
					}
					return makeReview("implementation");
				},
			});
			const runner: StructuredRunner = async request => {
				if (request.agent === "reviewer") {
					planReviewerModels.push(requestModel(request));
				}
				return scripted(request);
			};
			const engine = makeEngine(runner, combinedMerger([]), 1, roleStaticSplitConfig());
			const workflowId = await engine.startWorkflow(
				{ request: `role static split ${testCase.frozen ? "frozen-on" : "frozen-off"}` },
				{
					mechanicalClass: buildMechanicalClass({
						class: "mechanical_repair",
						source: "caller_declaration",
						targetRole: "repair",
					}),
				},
			);
			const result = await engine.run(
				workflowId,
				fakeSession(cwd, 1, true, {
					frozen: { role_static_split: testCase.frozen },
					live: { role_static_split: testCase.live },
				}),
			);

			expect(result.state.status).toBe("completed");
			expect(repairModels).toEqual([testCase.expectedRepairModel]);
			expect(planReviewerModels).toContain("openai/gpt-5.6-sol");
		}
	});

	it("runs a package-less plan through exactly one whole-plan implementer call without merging", async () => {
		const wholePlanRequests: StructuredRunnerRequest[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const runner = scriptedRunner({
			plan: makePlan(),
			planReview: makeReview("plan"),
			implement: async (request, packageId) => {
				expect(packageId).toBeUndefined();
				wholePlanRequests.push(request);
				return makeImplementation("patches/whole-plan.patch", ["src/a.ts"], "whole-plan");
			},
			codeReview: makeReview("implementation"),
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls));
		const workflowId = await engine.startWorkflow({ request: "run package-less plan" });

		const result = await engine.run(workflowId, fakeSession(cwd));

		expect(result.state.status).toBe("completed");
		expect(wholePlanRequests).toHaveLength(1);
		expect(wholePlanRequests[0]?.isolation).toMatchObject({
			requested: true,
			merge: "patch",
			apply: true,
		});
		expect(mergeCalls).toHaveLength(0);
		expect(result.workPackageState).toBeUndefined();
	});

	it("runs baseline plan.workPackages concurrently with optimization arms off", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Implement A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "b", assignment: "Implement B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const firstStarted = deferred<void>();
		const secondStarted = deferred<void>();
		const releaseFirst = deferred<void>();
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		let active = 0;
		let peakActive = 0;
		let firstPackageId: string | undefined;
		const isolationByPackage = new Map<string, StructuredRunnerRequest["isolation"]>();
		const runner = scriptedRunner({
			plan: makePlan(packages),
			planReview: makeReview("plan"),
			implement: async (request, packageId) => {
				if (!packageId) return makeImplementation("patches/whole-plan.patch", ["src/a.ts"]);
				isolationByPackage.set(packageId, request.isolation);
				active += 1;
				peakActive = Math.max(peakActive, active);
				if (firstPackageId === undefined) {
					firstPackageId = packageId;
					firstStarted.resolve();
					await releaseFirst.promise;
				} else {
					secondStarted.resolve();
				}
				active -= 1;
				return makeImplementation(`patches/${packageId}.patch`, [`src/${packageId}.ts`], packageId);
			},
			codeReview: makeReview("implementation"),
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls), 2);
		const workflowId = await engine.startWorkflow({ request: "run independent packages" });
		const run = engine.run(workflowId, fakeSession(cwd, 2));

		await firstStarted.promise;
		await secondStarted.promise;
		expect(peakActive).toBe(2);
		releaseFirst.resolve();
		const result = await run;

		expect(result.state.status).toBe("completed");
		expect(result.implementation?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
		expect(result.implementation?.patchPath).toBeDefined();
		const aggregatePatch = await Bun.file(result.implementation!.patchPath!).text();
		expect(aggregatePatch).toContain("src/a.ts");
		expect(aggregatePatch).toContain("src/b.ts");
		expect(mergeCalls).toHaveLength(1);
		expect(mergeCalls[0]?.patches.map(patch => patch.packageId)).toEqual(["a", "b"]);
		expect(isolationByPackage.get("a")).toMatchObject({
			requested: true,
			merge: "patch",
			apply: false,
		});
		expect(isolationByPackage.get("b")).toMatchObject({
			requested: true,
			merge: "patch",
			apply: false,
		});
		expect(result.workPackageState?.kind).toBe("work-package-state");
		expect(result.workPackageState?.revision).toBeGreaterThan(0);
		expect(result.workPackageState?.merge).toMatchObject({
			status: "applied",
			changesApplied: true,
			order: ["a", "b"],
		});
		expect(result.workPackageState?.packages.map(workPackage => [workPackage.id, workPackage.status])).toEqual([
			["a", "succeeded"],
			["b", "succeeded"],
		]);
	});

	// Declaration-derived lowering is independently gated from the baseline plan.workPackages path.
	it("lowers frozen-enabled independent write declarations while live settings drift off", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "decl-a", assignment: "Declared A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "decl-b", assignment: "Declared B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const packageCalls: string[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const runner = scriptedRunner({
			plan: makePlan(packages),
			planReview: makeReview("plan"),
			implement: async (_request, packageId) => {
				if (!packageId) throw new Error("declaration should lower to packages");
				packageCalls.push(packageId);
				const file = packageId === "decl-a" ? "src/a.ts" : "src/b.ts";
				return makeImplementation(`patches/${packageId}.patch`, [file], packageId);
			},
			codeReview: makeReview("implementation"),
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls), 2);
		const workflowId = await engine.startWorkflow({ request: "lower independent declaration units" });
		const result = await engine.run(
			workflowId,
			fakeSession(cwd, 2, true, {
				frozen: { concurrency_declaration: true, concurrency_execution: true },
				live: { concurrency_declaration: false, concurrency_execution: false },
			}),
		);

		expect(result.state.status).toBe("completed");
		expect([...packageCalls].sort()).toEqual(["decl-a", "decl-b"]);
		expect(mergeCalls).toHaveLength(1);
		expect(result.workPackageState?.packages.map(workPackage => workPackage.id)).toEqual(["decl-a", "decl-b"]);
	});

	it("ignores a declaration when its frozen declaration arm is off and preserves baseline work packages", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "base-a", assignment: "Baseline A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "base-b", assignment: "Baseline B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const packageCalls: string[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const runner = scriptedRunner({
			plan: makePlan(packages),
			planReview: makeReview("plan"),
			implement: async (_request, packageId) => {
				if (!packageId) throw new Error("baseline packages should remain active");
				packageCalls.push(packageId);
				return makeImplementation(`patches/${packageId}.patch`, [`src/${packageId.replace("base-", "")}.ts`]);
			},
			codeReview: makeReview("implementation"),
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls), 2);
		const workflowId = await engine.startWorkflow(
			{ request: "preserve baseline work packages" },
			{ concurrencyDeclaration: { unknownField: true } },
		);
		const result = await engine.run(
			workflowId,
			fakeSession(cwd, 2, true, {
				frozen: { concurrency_declaration: false, concurrency_execution: true },
				live: { concurrency_declaration: true, concurrency_execution: false },
			}),
		);

		expect(result.state.status).toBe("completed");
		expect([...packageCalls].sort()).toEqual(["base-a", "base-b"]);
		expect(result.workPackageState?.packages.map(workPackage => workPackage.id)).toEqual(["base-a", "base-b"]);
	});

	it("falls back to one whole-plan implementation when one package consumes a predecessor API", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "b", assignment: "Consume the API added by A", paths: ["src/b.ts"], dependsOn: ["a"] },
			{ id: "c", assignment: "Implement independent C", paths: ["src/c.ts"], dependsOn: [] },
			{ id: "a", assignment: "Add the shared API", paths: ["src/a.ts"], dependsOn: [] },
		];
		const packageCalls: string[] = [];
		const wholePlanContexts: string[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const runner = scriptedRunner({
			plan: makePlan(packages),
			planReview: makeReview("plan"),
			implement: async (request, packageId) => {
				if (packageId) {
					packageCalls.push(packageId);
					return makeImplementation(`patches/${packageId}.patch`, [`src/${packageId}.ts`], packageId);
				}
				wholePlanContexts.push(request.context ?? "");
				return makeImplementation("patches/whole-plan.patch", ["src/a.ts", "src/b.ts", "src/c.ts"]);
			},
			codeReview: makeReview("implementation"),
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls), 2);
		const workflowId = await engine.startWorkflow({ request: "run dependent packages safely" });

		const result = await engine.run(
			workflowId,
			fakeSession(cwd, 2, true, {
				frozen: { concurrency_declaration: true, concurrency_execution: true },
				live: { concurrency_declaration: false, concurrency_execution: false },
			}),
		);

		expect(result.state.status).toBe("completed");
		expect(packageCalls).toEqual([]);
		expect(wholePlanContexts).toHaveLength(1);
		expect(wholePlanContexts[0]).toContain("Add the shared API");
		expect(wholePlanContexts[0]).toContain("Consume the API added by A");
		expect(mergeCalls).toHaveLength(0);
		expect(result.workPackageState).toBeUndefined();
	});

	it("falls back to one serial whole-plan call for overlap, cycles, and an effectively serial limit", async () => {
		const cases: Array<{ label: string; packages: WorkPackageV1[]; maxConcurrency: number }> = [
			{
				label: "shared path",
				maxConcurrency: 2,
				packages: [
					{ id: "a", assignment: "Own shared directory", paths: ["src/shared"], dependsOn: [] },
					{ id: "b", assignment: "Own nested file", paths: ["src/shared/b.ts"], dependsOn: [] },
				],
			},
			{
				label: "dependency cycle",
				maxConcurrency: 2,
				packages: [
					{ id: "a", assignment: "Cycle A", paths: ["src/a.ts"], dependsOn: ["b"] },
					{ id: "b", assignment: "Cycle B", paths: ["src/b.ts"], dependsOn: ["a"] },
				],
			},
			{
				label: "maxConcurrency one",
				maxConcurrency: 1,
				packages: [
					{ id: "a", assignment: "Serial A", paths: ["src/a.ts"], dependsOn: [] },
					{ id: "b", assignment: "Serial B", paths: ["src/b.ts"], dependsOn: [] },
				],
			},
		];

		for (const testCase of cases) {
			const wholePlanRequests: StructuredRunnerRequest[] = [];
			const packageRequests: StructuredRunnerRequest[] = [];
			const mergeCalls: CapturedChangesMergeRequest[] = [];
			const runner = scriptedRunner({
				plan: makePlan(testCase.packages),
				planReview: makeReview("plan"),
				implement: async (request, packageId) => {
					if (packageId) packageRequests.push(request);
					else wholePlanRequests.push(request);
					return makeImplementation("patches/whole-plan-fallback.patch", ["src/a.ts", "src/b.ts"], testCase.label);
				},
				codeReview: makeReview("implementation"),
			});
			const engine = makeEngine(runner, combinedMerger(mergeCalls), testCase.maxConcurrency);
			const workflowId = await engine.startWorkflow({ request: testCase.label });

			const result = await engine.run(workflowId, fakeSession(cwd, testCase.maxConcurrency));

			expect(result.state.status).toBe("completed");
			expect(wholePlanRequests).toHaveLength(1);
			expect(packageRequests).toHaveLength(0);
			expect(wholePlanRequests[0]?.isolation).toMatchObject({
				requested: true,
				merge: "patch",
				apply: true,
			});
			expect(mergeCalls).toHaveLength(0);
		}
	});

	it("does not merge a partial capture and classifies package failures into failed or blocked workflows", async () => {
		const failureKinds = ["provider_permanent", "merge_conflict"] as const;
		for (const failureKind of failureKinds) {
			const packages: WorkPackageV1[] = [
				{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
				{ id: "b", assignment: "Fail B", paths: ["src/b.ts"], dependsOn: [] },
			];
			const mergeCalls: CapturedChangesMergeRequest[] = [];
			const runner = scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async (_request, packageId) => {
					if (packageId === "b") {
						throw new WorkflowError(`package ${packageId} failed`, failureKind);
					}
					return makeImplementation(`patches/${packageId ?? "whole-plan"}.patch`, [`src/${packageId ?? "a"}.ts`]);
				},
				codeReview: makeReview("implementation"),
			});
			const engine = makeEngine(runner, combinedMerger(mergeCalls), 2);
			const workflowId = await engine.startWorkflow({ request: `failure ${failureKind}` });
			let runResult: Awaited<ReturnType<WorkflowEngine["run"]>> | undefined;
			let runError: unknown;
			try {
				runResult = await engine.run(workflowId, fakeSession(cwd, 2));
			} catch (error) {
				runError = error;
			}

			const state = await engine.getState(workflowId);
			const packageState = await latestPackageState(workflowId);
			const failedPackage = packageState.packages.find(workPackage => workPackage.id === "b");
			const attempts = await store.listAttempts(workflowId);
			const transitions = await store.listTransitions(workflowId);
			const implementingAttempt = attempts.find(attempt => attempt.stage === "implementing");
			const expectedStatus = failureKind === "merge_conflict" ? "blocked" : "failed";

			expect(state?.status).toBe(expectedStatus);
			expect(runResult?.state.status ?? state?.status).toBe(expectedStatus);
			if (failureKind === "provider_permanent") {
				expect(runError).toBeInstanceOf(WorkflowError);
				expect((runError as WorkflowError).kind).toBe(failureKind);
			} else {
				expect(runError).toBeUndefined();
			}
			expect(mergeCalls).toHaveLength(0);
			expect(packageState.kind).toBe("work-package-state");
			expect(packageState.revision).toBeGreaterThan(0);
			expect(failedPackage?.status).toBe("failed");
			expect(failedPackage?.errorKind).toBe(failureKind);
			expect(failedPackage?.errorSummary).toContain("package b failed");
			expect(implementingAttempt?.status).toBe("failed");
			expect(implementingAttempt?.errorSummary).toContain("package b failed");
			expect(transitions.at(-1)?.reason).toContain("package b failed");
			expect(await Bun.file(path.join(cwd, "src/a.ts")).text()).toBe("before-a\n");
			expect(await Bun.file(path.join(cwd, "src/b.ts")).text()).toBe("before-b\n");
		}
	});

	it("routes missing and non-finite maxConcurrency through the unbounded work-package contract", async () => {
		for (const testCase of [
			{ label: "missing", session: fakeSession(cwd, 1, false) },
			{ label: "non-finite", session: fakeSession(cwd, Number.POSITIVE_INFINITY) },
		]) {
			const packages: WorkPackageV1[] = [
				{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
				{ id: "b", assignment: "Capture B", paths: ["src/b.ts"], dependsOn: [] },
			];
			const mergeCalls: CapturedChangesMergeRequest[] = [];
			let wholePlanCalls = 0;
			let packageStarts = 0;
			const runner = scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async (_request, packageId) => {
					if (!packageId) {
						wholePlanCalls += 1;
						return makeImplementation("patches/whole-plan.patch", ["src/a.ts", "src/b.ts"]);
					}
					packageStarts += 1;
					return makeImplementation(`patches/${testCase.label}-${packageId}.patch`, [`src/${packageId}.ts`]);
				},
				codeReview: makeReview("implementation"),
			});
			const engine = makeEngine(runner, combinedMerger(mergeCalls), 2);
			const workflowId = await engine.startWorkflow({ request: `unbounded ${testCase.label}` });
			const run = engine.run(workflowId, testCase.session);
			const result = await run;

			expect(result.state.status).toBe("completed");
			expect(wholePlanCalls).toBe(0);
			expect(packageStarts).toBe(2);
			expect(mergeCalls).toHaveLength(1);
		}
	});

	it("does not merge strict packages when one runtime identity mismatches", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "b", assignment: "Capture B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const runner = scriptedRunner({
			plan: makePlan(packages),
			planReview: makeReview("plan"),
			implement: async (_request, packageId) =>
				makeImplementation(`patches/strict-${packageId}.patch`, [`src/${packageId}.ts`], packageId),
			codeReview: makeReview("implementation"),
			identityMode: (_request, packageId) => (packageId === "b" ? "mismatch" : "valid"),
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls), 2, strictPackageConfig());
		const workflowId = await engine.startWorkflow({
			request: "reject mismatched strict package identity",
			qualityTier: "balanced",
		});

		await expect(engine.run(workflowId, fakeSession(cwd, 2))).rejects.toThrow(
			/identity|quality_route_candidates_exhausted/i,
		);

		const packageState = await latestPackageState(workflowId);
		const failed = packageState.packages.find(workPackage => workPackage.id === "b");
		expect((await engine.getState(workflowId))?.status).toBe("blocked");
		expect(mergeCalls).toHaveLength(0);
		expect(failed?.status).toBe("failed");
		expect(failed?.errorSummary).toMatch(/identity/i);
	});

	it("does not merge strict packages until aggregate scope is approved", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "b", assignment: "Capture B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const runner = scriptedRunner({
			plan: makePlan(packages),
			planReview: makeReview("plan"),
			implement: async (_request, packageId) =>
				makeImplementation(`patches/strict-${packageId}.patch`, [`src/${packageId}.ts`], packageId),
			codeReview: makeReview("implementation"),
			identityMode: () => "valid",
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls), 2, strictPackageConfig(["src/b.ts"]));
		const workflowId = await engine.startWorkflow({
			request: "reject forbidden strict package scope",
			qualityTier: "balanced",
		});

		await expect(engine.run(workflowId, fakeSession(cwd, 2))).rejects.toThrow(/strict_write_scope_not_approved/i);

		const packageState = await latestPackageState(workflowId);
		const scopeMetadata = (await store.listArtifacts(workflowId)).find(artifact => artifact.kind === "scope-metrics");
		expect(scopeMetadata).toBeDefined();
		const scopeArtifact = await artifactStore.load(scopeMetadata!.relativePath, scopeMetadata!.sha256);
		expect((await engine.getState(workflowId))?.status).toBe("blocked");
		expect(mergeCalls).toHaveLength(0);
		expect(packageState.packages.every(workPackage => workPackage.status === "succeeded")).toBe(true);
		expect(JSON.parse(scopeArtifact!.content!).status).toBe("violation");
	});

	it("merges strict directory-owned packages whose patches touch nested files", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Own shared A", paths: ["src/shared-a"], dependsOn: [] },
			{ id: "b", assignment: "Own shared B", paths: ["src/shared-b"], dependsOn: [] },
		];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const runner = scriptedRunner({
			plan: makePlan(packages),
			planReview: makeReview("plan"),
			implement: async (_request, packageId) =>
				makeImplementation(`patches/directory-${packageId}.patch`, [`src/shared-${packageId}/${packageId}.ts`]),
			codeReview: makeReview("implementation"),
			identityMode: () => "valid",
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls), 2, strictPackageConfig());
		const workflowId = await engine.startWorkflow({
			request: "merge directory-owned strict packages",
			qualityTier: "balanced",
		});

		const result = await engine.run(workflowId, fakeSession(cwd, 2));

		expect(result.state.status).toBe("completed");
		expect(mergeCalls).toHaveLength(1);
		expect(mergeCalls[0]?.patches.map(patch => patch.packageId)).toEqual(["a", "b"]);
		const scopeMetadata = (await store.listArtifacts(workflowId))
			.filter(artifact => artifact.kind === "scope-metrics")
			.at(-1);
		if (!scopeMetadata) throw new Error("missing final scope metrics metadata");
		const latestScope = await artifactStore.load(scopeMetadata.relativePath, scopeMetadata.sha256);
		if (!latestScope?.content) throw new Error("missing final scope metrics");
		const scope = JSON.parse(latestScope.content) as {
			status: string;
			plannedFiles: string[];
			unplannedFiles: string[];
		};
		expect(scope.status).toBe("adhered");
		expect(scope.plannedFiles).toEqual(expect.arrayContaining(["src/shared-a/a.ts", "src/shared-b/b.ts"]));
		expect(scope.unplannedFiles).toEqual([]);
	});

	it("merges strict packages exactly once after identity and scope approval", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "b", assignment: "Capture B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const runner = scriptedRunner({
			plan: makePlan(packages),
			planReview: makeReview("plan"),
			implement: async (_request, packageId) =>
				makeImplementation(`patches/strict-${packageId}.patch`, [`src/${packageId}.ts`], packageId),
			codeReview: makeReview("implementation"),
			identityMode: () => "valid",
		});
		const engine = makeEngine(runner, combinedMerger(mergeCalls), 2, strictPackageConfig());
		const workflowId = await engine.startWorkflow({
			request: "merge approved strict packages",
			qualityTier: "balanced",
		});

		const result = await engine.run(workflowId, fakeSession(cwd, 2));

		expect(result.state.status).toBe("completed");
		expect(mergeCalls).toHaveLength(1);
		expect(mergeCalls[0]?.patches.map(patch => patch.packageId)).toEqual(["a", "b"]);
		expect(
			result.workPackageState?.packages.every(workPackage => workPackage.identityReceipt?.exactMatch === true),
		).toBe(true);
		expect(result.workPackageState?.merge.status).toBe("applied");
	});

	it("resumes strict packages with the persisted receipt and merges exactly once", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "b", assignment: "Capture B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const persistedReceipt = strictPackageReceipt();
		const captureEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async () => makeImplementation("patches/unexpected.patch", ["src/a.ts"]),
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			undefined,
			2,
			strictPackageConfig(),
		);
		const workflowId = await captureEngine.startWorkflow({
			request: "resume strict package capture",
			qualityTier: "balanced",
		});
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		expect((await captureEngine.getState(workflowId))?.status).toBe("implementing");
		const implementingState = await captureEngine.getState(workflowId);
		const staleAttemptId = await store.beginAttempt(
			workflowId,
			"implementing",
			undefined,
			implementingState!.version,
		);

		const capturePlan: WorkPackageExecutionPlan = {
			packages: [packages[0]!],
			waves: [[packages[0]!]],
			mergeOrder: ["a"],
			maxConcurrency: 2,
		};
		const captured = await executeWorkPackagePlan({
			workflowId,
			attemptId: staleAttemptId,
			cwd,
			plan: capturePlan,
			execute: async workPackage => {
				const patchPath = "patches/captured-a.patch";
				await writePatchFile(cwd, patchPath, workPackage.paths);
				return {
					artifact: makeImplementation(patchPath, workPackage.paths, "captured A"),
					identityReceipt: persistedReceipt,
					modelFamily: persistedReceipt.modelFamily ?? undefined,
				};
			},
			persist: state => persistPackageState(workflowId, staleAttemptId, state),
		});
		const captureState: WorkPackageStateArtifactV1 = {
			...captured,
			attemptId: staleAttemptId,
			revision: captured.revision + 1,
			createdAt: new Date().toISOString(),
			packages: [...captured.packages, { ...packages[1]!, status: "pending" }],
			merge: { status: "pending", order: ["a", "b"] },
		};
		await persistPackageState(workflowId, staleAttemptId, captureState);
		expect(captureState.packages.find(workPackage => workPackage.id === "a")?.status).toBe("succeeded");
		expect(captureState.packages.find(workPackage => workPackage.id === "a")?.identityReceipt).toEqual(
			persistedReceipt,
		);
		expect((await store.listAttempts(workflowId)).find(attempt => attempt.id === staleAttemptId)?.status).toBe(
			"in_progress",
		);

		const resumedPackageCalls: string[] = [];
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const resumeEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async (_request, packageId) => {
					if (!packageId) return makeImplementation("patches/whole-plan.patch", ["src/a.ts"]);
					resumedPackageCalls.push(packageId);
					return makeImplementation(
						`patches/resumed-${packageId}.patch`,
						[`src/${packageId}.ts`],
						`resumed ${packageId}`,
					);
				},
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			combinedMerger(mergeCalls),
			2,
			strictPackageConfig(),
		);

		const result = await resumeEngine.resume(workflowId, { forceUnlock: true });
		const attempts = await store.listAttempts(workflowId);
		const stale = attempts.find(attempt => attempt.id === staleAttemptId);

		expect(result.state.status).toBe("completed");
		expect(resumedPackageCalls).toEqual(["b"]);
		expect(stale?.status).toBe("failed");
		expect(stale?.errorSummary).toBe("work_package_capture_interrupted_resumable");
		expect(mergeCalls).toHaveLength(1);
		expect(mergeCalls[0]?.patches.map(patch => patch.packageId)).toEqual(["a", "b"]);
		expect(result.workPackageState?.kind).toBe("work-package-state");
		expect(result.workPackageState?.revision).toBeGreaterThan(captureState.revision);
		expect(result.workPackageState?.merge).toMatchObject({
			status: "applied",
			changesApplied: true,
			order: ["a", "b"],
		});
		expect(result.workPackageState?.packages.every(workPackage => workPackage.status === "succeeded")).toBe(true);
		expect(result.workPackageState?.packages.find(workPackage => workPackage.id === "a")?.identityReceipt).toEqual(
			persistedReceipt,
		);
	});

	it("rejects reusable receipts that are not bound to the selected implementer profile", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "b", assignment: "Capture B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const selectedProfile = {
			...strictProfile("strict_implementer_v2", "implementer", "xai/grok-4.6", "xai"),
			thinkingLevel: "high" as NonNullable<ModelProfile["thinkingLevel"]>,
		};
		const config = strictPackageConfig([], selectedProfile);
		const captureEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async () => makeImplementation("patches/unexpected.patch", ["src/a.ts"]),
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			undefined,
			2,
			config,
		);
		const workflowId = await captureEngine.startWorkflow({
			request: "reject stale package receipt",
			qualityTier: "balanced",
		});
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		const implementingState = await captureEngine.getState(workflowId);
		const staleAttemptId = await store.beginAttempt(
			workflowId,
			"implementing",
			undefined,
			implementingState!.version,
		);
		const persistedReceipt = strictPackageReceipt();
		for (const workPackage of packages) {
			await writePatchFile(cwd, `patches/stale-${workPackage.id}.patch`, workPackage.paths);
		}
		const staleState: WorkPackageStateArtifactV1 = {
			kind: "work-package-state",
			schemaVersion: 1,
			workflowId,
			attemptId: staleAttemptId,
			stage: "implementing",
			createdAt: new Date().toISOString(),
			revision: 1,
			mode: "capture_then_apply",
			packages: packages.map(workPackage => ({
				...workPackage,
				status: "succeeded",
				invocationAttemptId: `${staleAttemptId}:${workPackage.id}`,
				implementation: {
					...makeImplementation(`patches/stale-${workPackage.id}.patch`, workPackage.paths),
					modelProfileId: "strict_implementer",
				},
				identityReceipt: persistedReceipt,
				modelFamily: persistedReceipt.modelFamily ?? undefined,
			})),
			merge: { status: "pending", order: ["a", "b"] },
		};
		await persistPackageState(workflowId, staleAttemptId, staleState);

		let implementCalls = 0;
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const resumeEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async () => {
					implementCalls += 1;
					return makeImplementation("patches/should-not-run.patch", ["src/a.ts"]);
				},
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			combinedMerger(mergeCalls),
			2,
			config,
		);

		await expect(resumeEngine.resume(workflowId, { forceUnlock: true })).rejects.toThrow(
			/strict_write_identity_not_verified/i,
		);
		expect(implementCalls).toBe(0);
		expect(mergeCalls).toHaveLength(0);
	});

	it("resumes an already-applied package merge without rerunning implementers or the merge seam", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "b", assignment: "Capture B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const config = strictPackageConfig();
		const captureEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async () => makeImplementation("patches/unexpected.patch", ["src/a.ts"]),
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			undefined,
			2,
			config,
		);
		const workflowId = await captureEngine.startWorkflow({
			request: "recover applied package merge",
			qualityTier: "balanced",
		});
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		const implementingState = await captureEngine.getState(workflowId);
		const staleAttemptId = await store.beginAttempt(
			workflowId,
			"implementing",
			undefined,
			implementingState!.version,
		);
		const receipt = strictPackageReceipt();
		const appliedReplacements = {
			"src/a.ts": { before: "before-a", after: "after-a" },
			"src/b.ts": { before: "before-b", after: "after-b" },
		} as const;
		await initializeGitRepository(cwd);
		for (const workPackage of packages) {
			await writePatchFile(cwd, `patches/applied-${workPackage.id}.patch`, workPackage.paths, appliedReplacements);
		}
		const aggregatePatchPath = "patches/applied.packages.patch";
		await writePatchFile(
			cwd,
			aggregatePatchPath,
			packages.flatMap(workPackage => workPackage.paths),
			appliedReplacements,
		);
		for (const [file, replacement] of Object.entries(appliedReplacements)) {
			await Bun.write(path.join(cwd, file), `${replacement.after}\n`);
		}
		const appliedState: WorkPackageStateArtifactV1 = {
			kind: "work-package-state",
			schemaVersion: 1,
			workflowId,
			attemptId: staleAttemptId,
			stage: "implementing",
			createdAt: new Date().toISOString(),
			revision: 4,
			mode: "capture_then_apply",
			packages: packages.map(workPackage => ({
				...workPackage,
				status: "succeeded",
				invocationAttemptId: `${staleAttemptId}:${workPackage.id}`,
				implementation: {
					...makeImplementation(`patches/applied-${workPackage.id}.patch`, workPackage.paths),
					modelProfileId: "strict_implementer",
				},
				identityReceipt: receipt,
				modelFamily: receipt.modelFamily ?? undefined,
			})),
			merge: {
				status: "applied",
				order: ["a", "b"],
				patchPath: aggregatePatchPath,
				changesApplied: true,
				summary: "already merged",
			},
		};
		await persistPackageState(workflowId, staleAttemptId, appliedState);
		const scopeMetrics = buildScopeMetrics({
			plannedFiles: packages.flatMap(workPackage => workPackage.paths),
			changedFiles: packages.flatMap(workPackage => workPackage.paths),
		});
		const storedScope = await artifactStore.store({
			workflowId,
			attemptId: staleAttemptId,
			kind: "scope-metrics",
			schemaVersion: 1,
			relativePath: "",
			content: JSON.stringify(scopeMetrics),
		});
		await store.addArtifact(storedScope);

		let implementCalls = 0;
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const resumeEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async () => {
					implementCalls += 1;
					return makeImplementation("patches/should-not-run.patch", ["src/a.ts"]);
				},
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			combinedMerger(mergeCalls),
			1,
			config,
		);

		const result = await resumeEngine.resume(workflowId, {
			forceUnlock: true,
			singleStep: true,
			session: fakeSession(cwd, 1),
		});
		const staleAttempt = (await store.listAttempts(workflowId)).find(attempt => attempt.id === staleAttemptId);

		expect(result.state.status).toBe("implementation_verify");
		expect(staleAttempt?.status).toBe("failed");
		expect(staleAttempt?.errorSummary).toBe("work_package_merge_already_applied_resume");
		expect(implementCalls).toBe(0);
		expect(mergeCalls).toHaveLength(0);
		expect(result.workPackageState?.merge).toMatchObject({ status: "applied", changesApplied: true });
	});

	it("fails closed when an applied package merge was reverted", async () => {
		const packages: WorkPackageV1[] = [
			{ id: "a", assignment: "Capture A", paths: ["src/a.ts"], dependsOn: [] },
			{ id: "b", assignment: "Capture B", paths: ["src/b.ts"], dependsOn: [] },
		];
		const config = strictPackageConfig();
		const captureEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async () => makeImplementation("patches/unexpected.patch", ["src/a.ts"]),
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			undefined,
			2,
			config,
		);
		const workflowId = await captureEngine.startWorkflow({
			request: "reject reverted applied package merge",
			qualityTier: "balanced",
		});
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		const implementingState = await captureEngine.getState(workflowId);
		const staleAttemptId = await store.beginAttempt(
			workflowId,
			"implementing",
			undefined,
			implementingState!.version,
		);
		const receipt = strictPackageReceipt();
		const appliedReplacements = {
			"src/a.ts": { before: "before-a", after: "after-a" },
			"src/b.ts": { before: "before-b", after: "after-b" },
		} as const;
		await initializeGitRepository(cwd);
		for (const workPackage of packages) {
			await writePatchFile(cwd, `patches/reverted-${workPackage.id}.patch`, workPackage.paths, appliedReplacements);
		}
		const aggregatePatchPath = "patches/reverted.packages.patch";
		await writePatchFile(
			cwd,
			aggregatePatchPath,
			packages.flatMap(workPackage => workPackage.paths),
			appliedReplacements,
		);
		const appliedState: WorkPackageStateArtifactV1 = {
			kind: "work-package-state",
			schemaVersion: 1,
			workflowId,
			attemptId: staleAttemptId,
			stage: "implementing",
			createdAt: new Date().toISOString(),
			revision: 4,
			mode: "capture_then_apply",
			packages: packages.map(workPackage => ({
				...workPackage,
				status: "succeeded",
				invocationAttemptId: `${staleAttemptId}:${workPackage.id}`,
				implementation: {
					...makeImplementation(`patches/reverted-${workPackage.id}.patch`, workPackage.paths),
					modelProfileId: "strict_implementer",
				},
				identityReceipt: receipt,
				modelFamily: receipt.modelFamily ?? undefined,
			})),
			merge: {
				status: "applied",
				order: ["a", "b"],
				patchPath: aggregatePatchPath,
				changesApplied: true,
				summary: "already merged",
			},
		};
		await persistPackageState(workflowId, staleAttemptId, appliedState);
		const scopeMetrics = buildScopeMetrics({
			plannedFiles: packages.flatMap(workPackage => workPackage.paths),
			changedFiles: packages.flatMap(workPackage => workPackage.paths),
		});
		const storedScope = await artifactStore.store({
			workflowId,
			attemptId: staleAttemptId,
			kind: "scope-metrics",
			schemaVersion: 1,
			relativePath: "",
			content: JSON.stringify(scopeMetrics),
		});
		await store.addArtifact(storedScope);

		let implementCalls = 0;
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const resumeEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(packages),
				planReview: makeReview("plan"),
				implement: async () => {
					implementCalls += 1;
					return makeImplementation("patches/should-not-run.patch", ["src/a.ts"]);
				},
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			combinedMerger(mergeCalls),
			1,
			config,
		);

		await expect(
			resumeEngine.resume(workflowId, {
				forceUnlock: true,
				singleStep: true,
				session: fakeSession(cwd, 1),
			}),
		).rejects.toThrow(/work_package_applied_patch_drift/i);
		const staleAttempt = (await store.listAttempts(workflowId)).find(attempt => attempt.id === staleAttemptId);

		expect((await resumeEngine.getState(workflowId))?.status).toBe("blocked");
		expect(staleAttempt?.status).toBe("failed");
		expect(staleAttempt?.errorSummary).toBe("work_package_merge_already_applied_resume");
		expect(implementCalls).toBe(0);
		expect(mergeCalls).toHaveLength(0);
	});

	it("keeps the existing blocked semantics for a stale serial write-stage attempt", async () => {
		let implementCalls = 0;
		const runner = scriptedRunner({
			plan: makePlan(),
			planReview: makeReview("plan"),
			implement: async () => {
				implementCalls += 1;
				return makeImplementation("patches/should-not-run.patch", ["src/a.ts"]);
			},
			codeReview: makeReview("implementation"),
		});
		const engine = makeEngine(runner, async () => {
			throw new Error("merge seam must not run");
		});
		const workflowId = await engine.startWorkflow({ request: "stale serial write" });
		await engine.resume(workflowId, { singleStep: true });
		await engine.resume(workflowId, { singleStep: true });
		await engine.resume(workflowId, { singleStep: true });
		const beforeStale = await engine.getState(workflowId);
		const staleAttemptId = await store.beginAttempt(workflowId, "implementing", undefined, beforeStale!.version);

		let error: unknown;
		try {
			await engine.resume(workflowId, { forceUnlock: true });
		} catch (caught) {
			error = caught;
		}
		const after = await engine.getState(workflowId);
		const stale = (await store.listAttempts(workflowId)).find(attempt => attempt.id === staleAttemptId);

		expect(error).toBeInstanceOf(WorkflowPolicyError);
		expect((error as WorkflowPolicyError).message).toContain("write_stage_interrupted_no_rerun");
		expect(after?.status).toBe("blocked");
		expect(stale?.status).toBe("failed");
		expect(stale?.errorSummary).toBe("write_stage_interrupted_no_rerun");
		expect(implementCalls).toBe(0);
	});

	it("resumes a crash-interrupted strict implement merge with zero model and merge calls", async () => {
		const config = strictPackageConfig();
		const captureEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(),
				planReview: makeReview("plan"),
				implement: async () => {
					throw new Error("capture engine must not run the implementer");
				},
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			undefined,
			1,
			config,
		);
		const workflowId = await captureEngine.startWorkflow({
			request: "crash resume strict implement",
			qualityTier: "balanced",
		});
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		await captureEngine.resume(workflowId, { singleStep: true });
		const implementingState = await captureEngine.getState(workflowId);
		expect(implementingState?.status).toBe("implementing");
		const staleAttemptId = await store.beginAttempt(
			workflowId,
			"implementing",
			undefined,
			implementingState!.version,
		);

		// The merger applied the canonical patch, then the process died before the
		// applied-state write; the persisted state still says "prepared".
		const patchPath = "patches/crash-implement.patch";
		await writePatchFile(cwd, patchPath, ["src/a.ts"]);
		const patchText = await Bun.file(path.join(cwd, patchPath)).text();
		await $`git apply ${patchPath}`.cwd(cwd).quiet();
		expect(await Bun.file(path.join(cwd, "src/a.ts")).text()).toBe("after-a\n");
		await persistStrictWriteRecoveryState({
			workflowId,
			staleAttemptId,
			stage: "implementing",
			packageId: "validated-implementing",
			profileId: "strict_implementer",
			receipt: strictPackageReceipt(),
			patchPath,
			changedFiles: ["src/a.ts"],
			mergeStatus: "prepared",
			patchSha256: sha256Hex(patchText),
		});

		let implementCalls = 0;
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const resumeEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(),
				planReview: makeReview("plan"),
				implement: async () => {
					implementCalls += 1;
					return makeImplementation("patches/should-not-run.patch", ["src/a.ts"]);
				},
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			combinedMerger(mergeCalls),
			1,
			config,
		);

		const result = await resumeEngine.resume(workflowId, {
			forceUnlock: true,
			session: fakeSession(cwd, 1),
		});

		expect(result.state.status).toBe("completed");
		expect(implementCalls).toBe(0);
		expect(mergeCalls).toHaveLength(0);
		expect(await Bun.file(path.join(cwd, "src/a.ts")).text()).toBe("after-a\n");
		expect(result.workPackageState?.merge).toMatchObject({ status: "applied", changesApplied: true });
		const stale = (await store.listAttempts(workflowId)).find(attempt => attempt.id === staleAttemptId);
		expect(stale?.status).toBe("failed");
		expect(stale?.errorSummary).toBe("work_package_merge_prepared_resume");
	});

	it("resumes a crash-interrupted strict repair merge with zero model and merge calls", async () => {
		const config = strictPackageConfig();
		const blockingFinding: ReviewFindingV1 = {
			id: "f-blocking",
			priority: "P1",
			category: "correctness",
			status: "open",
			confidence: 0.99,
			summary: "blocking correctness finding",
			explanation: "must be repaired",
			suggestedOwner: "implementer",
		};
		const reviewWithFindings = reviewArtifact("changes_requested", "implementation", [blockingFinding]);
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const driver = makeEngine(
			scriptedRunner({
				plan: makePlan(),
				planReview: makeReview("plan"),
				implement: async () => makeImplementation("patches/impl.patch", ["src/a.ts"]),
				codeReview: reviewWithFindings,
				identityMode: () => "valid",
			}),
			combinedMerger(mergeCalls),
			1,
			config,
		);
		const workflowId = await driver.startWorkflow({
			request: "crash resume strict repair",
			qualityTier: "balanced",
		});
		for (let step = 0; step < 6; step++) {
			await driver.resume(workflowId, { singleStep: true });
		}
		const repairingState = await driver.getState(workflowId);
		expect(repairingState?.status).toBe("repairing");
		const staleAttemptId = await store.beginAttempt(workflowId, "repairing", undefined, repairingState!.version);

		const patchPath = "patches/crash-repair.patch";
		await writePatchFile(cwd, patchPath, ["src/a.ts"], {
			"src/a.ts": { before: "after-a", after: "repaired-a" },
		});
		const patchText = await Bun.file(path.join(cwd, patchPath)).text();
		await $`git apply ${patchPath}`.cwd(cwd).quiet();
		await persistStrictWriteRecoveryState({
			workflowId,
			staleAttemptId,
			stage: "repairing",
			packageId: "validated-repairing",
			profileId: "strict_repair",
			receipt: strictPackageReceipt("strict_repair", "anthropic", "claude-fable-5", "anthropic"),
			patchPath,
			changedFiles: ["src/a.ts"],
			mergeStatus: "prepared",
			patchSha256: sha256Hex(patchText),
			addressedStepIds: ["f-blocking"],
			revision: 8,
		});

		let implementCalls = 0;
		const repairCalls = 0;
		const resumeMergeCalls: CapturedChangesMergeRequest[] = [];
		const resumeEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(),
				planReview: makeReview("plan"),
				implement: async () => {
					implementCalls += 1;
					return makeImplementation("patches/should-not-run.patch", ["src/a.ts"]);
				},
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			combinedMerger(resumeMergeCalls),
			1,
			config,
		);

		const result = await resumeEngine.resume(workflowId, {
			forceUnlock: true,
			session: fakeSession(cwd, 1),
		});

		expect(result.state.status).toBe("completed");
		expect(implementCalls).toBe(0);
		expect(repairCalls).toBe(0);
		expect(resumeMergeCalls).toHaveLength(0);
		expect(result.workPackageState?.merge).toMatchObject({ status: "applied", changesApplied: true });
		const stale = (await store.listAttempts(workflowId)).find(attempt => attempt.id === staleAttemptId);
		expect(stale?.status).toBe("failed");
		expect(stale?.errorSummary).toBe("work_package_merge_prepared_resume");
	});

	it("fails closed on missing, empty, hash-mismatched, and ambiguous persisted patch evidence", async () => {
		const config = strictPackageConfig();
		const cases: Array<{
			label: string;
			patchPath: string;
			patchText: string;
			applyToTree: boolean;
			writeFile: boolean;
			patchSha256?: string;
			expected: RegExp;
		}> = [
			{
				label: "missing patch file",
				patchPath: "patches/ghost.patch",
				patchText: "",
				applyToTree: false,
				writeFile: false,
				expected: /work_package_applied_patch_unreadable/,
			},
			{
				label: "empty patch body",
				patchPath: "patches/empty.patch",
				patchText: "",
				applyToTree: false,
				writeFile: true,
				expected: /work_package_applied_patch_ambiguous/,
			},
			{
				label: "hash mismatch",
				patchPath: "patches/mismatch.patch",
				patchText:
					"diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-before-a\n+after-a\n",
				applyToTree: false,
				writeFile: true,
				patchSha256: "0".repeat(64),
				expected: /work_package_applied_patch_hash_mismatch/,
			},
			{
				label: "ambiguous insertion evidence",
				patchPath: "patches/ambiguous.patch",
				patchText: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,0 +2,1 @@\n+X\n",
				applyToTree: true,
				writeFile: true,
				expected: /work_package_applied_patch_drift/,
			},
		];

		for (const testCase of cases) {
			const captureEngine = makeEngine(
				scriptedRunner({
					plan: makePlan(),
					planReview: makeReview("plan"),
					implement: async () => {
						throw new Error("capture engine must not run the implementer");
					},
					codeReview: makeReview("implementation"),
					identityMode: () => "valid",
				}),
				undefined,
				1,
				config,
			);
			const workflowId = await captureEngine.startWorkflow({
				request: `evidence ${testCase.label}`,
				qualityTier: "balanced",
			});
			await captureEngine.resume(workflowId, { singleStep: true });
			await captureEngine.resume(workflowId, { singleStep: true });
			await captureEngine.resume(workflowId, { singleStep: true });
			const implementingState = await captureEngine.getState(workflowId);
			expect(implementingState?.status).toBe("implementing");
			const staleAttemptId = await store.beginAttempt(
				workflowId,
				"implementing",
				undefined,
				implementingState!.version,
			);

			const patchPath = testCase.patchPath;
			if (testCase.writeFile) {
				await fs.mkdir(path.dirname(path.join(cwd, patchPath)), { recursive: true });
				await Bun.write(path.join(cwd, patchPath), testCase.patchText);
				if (testCase.applyToTree) {
					await Bun.write(path.join(cwd, "src/a.ts"), "a\nb\nc\n");
					await $`git apply ${patchPath}`.cwd(cwd).quiet();
				}
			}
			await persistStrictWriteRecoveryState({
				workflowId,
				staleAttemptId,
				stage: "implementing",
				packageId: "validated-implementing",
				profileId: "strict_implementer",
				receipt: strictPackageReceipt(),
				patchPath,
				changedFiles: ["src/a.ts"],
				mergeStatus: "applied",
				patchSha256: testCase.patchSha256,
			});

			let implementCalls = 0;
			const mergeCalls: CapturedChangesMergeRequest[] = [];
			const resumeEngine = makeEngine(
				scriptedRunner({
					plan: makePlan(),
					planReview: makeReview("plan"),
					implement: async () => {
						implementCalls += 1;
						return makeImplementation("patches/should-not-run.patch", ["src/a.ts"]);
					},
					codeReview: makeReview("implementation"),
				}),
				combinedMerger(mergeCalls),
				1,
				config,
			);

			await expect(
				resumeEngine.resume(workflowId, { forceUnlock: true, session: fakeSession(cwd, 1) }),
			).rejects.toThrow(testCase.expected);
			expect(implementCalls).toBe(0);
			expect(mergeCalls).toHaveLength(0);
			const stale = (await store.listAttempts(workflowId)).find(attempt => attempt.id === staleAttemptId);
			expect(stale?.status).toBe("failed");
			expect(stale?.errorSummary).toBe("work_package_merge_already_applied_resume");
		}
	});

	it("waits for the merge settlement barrier when cancelled mid-merge and never re-runs work", async () => {
		const config = strictPackageConfig();
		const midMerge = deferred<void>();
		let implementCalls = 0;
		let mergerEntered = false;
		const mergeCalls: CapturedChangesMergeRequest[] = [];
		const blockingMerger: CapturedChangesMerger = async request => {
			mergeCalls.push({ ...request, patches: request.patches.map(patch => ({ ...patch })) });
			mergerEntered = true;
			const contents = await Promise.all(
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
				contents
					.map(content => (content.length === 0 || content.endsWith("\n") ? content : `${content}\n`))
					.join(""),
			);
			const applied = Bun.spawn(["git", "apply", request.outputPatchPath], {
				cwd: request.cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			if ((await applied.exited) !== 0) throw new Error(await new Response(applied.stderr).text());
			midMerge.resolve();
			// Simulate a cancellation arriving mid-merge: wait for the abort signal,
			// then surface the cancellation to the engine's uncertain-outcome path.
			await new Promise<void>(resolve => {
				if (request.signal?.aborted) resolve();
				else request.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new WorkflowCancelledError("cancelled during merge");
		};

		const engine = makeEngine(
			scriptedRunner({
				plan: makePlan(),
				planReview: makeReview("plan"),
				implement: async () => {
					implementCalls += 1;
					return makeImplementation("patches/whole-plan.patch", ["src/a.ts"]);
				},
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			blockingMerger,
			1,
			config,
		);
		const workflowId = await engine.startWorkflow({ request: "cancel during merge", qualityTier: "balanced" });
		const runPromise = engine.run(workflowId, fakeSession(cwd, 1));

		await midMerge.promise;
		expect(mergerEntered).toBe(true);
		expect(await Bun.file(path.join(cwd, "src/a.ts")).text()).toBe("after-a\n");
		const cancelledState = await engine.cancel(workflowId, "caller cancelled mid-merge");
		const runResult = await runPromise;

		expect(cancelledState.status).toBe("cancelled");
		expect(implementCalls).toBe(1);
		expect(mergeCalls).toHaveLength(1);
		expect(runResult.workPackageState?.merge).toMatchObject({ status: "applied", changesApplied: true });
		expect((await engine.getState(workflowId))?.status).toBe("cancelled");

		let resumeCalls = 0;
		const freshEngine = makeEngine(
			scriptedRunner({
				plan: makePlan(),
				planReview: makeReview("plan"),
				implement: async () => {
					resumeCalls += 1;
					return makeImplementation("patches/should-not-run.patch", ["src/a.ts"]);
				},
				codeReview: makeReview("implementation"),
				identityMode: () => "valid",
			}),
			combinedMerger(mergeCalls),
			1,
			config,
		);
		await expect(freshEngine.resume(workflowId, { forceUnlock: true, session: fakeSession(cwd, 1) })).rejects.toThrow(
			/cannot_resume_terminal/,
		);
		expect(resumeCalls).toBe(0);
	});
});
