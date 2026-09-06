import * as path from "node:path";
import type { Model, ProviderResponseMetadata, Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../src/tools";
import { buildRequirementsSnapshot, satisfyMandatoryCoverage } from "../../src/workflow/requirements-snapshot";
import type { StructuredRunner } from "../../src/workflow/runtime-adapter";
import type {
	ImplementationArtifactV1,
	PlanArtifactV1,
	PlanReviewArtifact,
	PlanReviewArtifactV2,
	PlanReviewFindingV2,
	ReviewArtifactV1,
	VerificationArtifactV1,
	VerifierPort,
} from "../../src/workflow/types";

/** Minimal session mock — avoid Settings import (pulls pi-natives). */
export function fakeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	const settings = {
		get: (_key: string) => undefined,
		set: () => {},
	};
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: settings as unknown as ToolSession["settings"],
		...overrides,
	};
}

const usage: Usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

/** Trusted isolation evidence used by engine verify stages in tests. */
export const SAMPLE_PATCH =
	"diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n before\n+const x = 1\n";

/** Persist a readable patch under cwd so implementation_verify can fail closed on trust, not ENOENT. */
export async function materializeSamplePatch(cwd: string, relativePath = "patches/x.patch"): Promise<string> {
	const full = path.isAbsolute(relativePath) ? relativePath : path.join(cwd, relativePath);
	await Bun.write(full, SAMPLE_PATCH);
	return full;
}

export function planArtifact(overrides: Partial<PlanArtifactV1> = {}): PlanArtifactV1 {
	return {
		schemaVersion: 1,
		workflowId: "wf",
		attemptId: "att",
		stage: "planning",
		createdAt: new Date().toISOString(),
		kind: "plan",
		summary: "Do the thing",
		assumptions: [],
		nonGoals: [],
		affectedFiles: [
			{ path: "src/a.ts", action: "modify", reason: "fix" },
			{ path: "src/b.ts", action: "modify", reason: "wire caller" },
		],
		implementationSteps: [
			{ id: "s1", description: "edit core", dependsOn: [] },
			{ id: "s2", description: "wire caller", dependsOn: ["s1"] },
		],
		acceptanceCriteria: ["tests pass"],
		verificationCommands: ["git diff --check"],
		risks: [],
		rollback: [],
		...overrides,
	};
}

function toPlanReviewFinding(finding: ReviewArtifactV1["findings"][number]): PlanReviewFindingV2 {
	return {
		...finding,
		basis: "repo_evidence",
		requirementId: null,
		sourceRefs: [finding.file ? `${finding.file}:${finding.line ?? 1}` : "test:fixture"],
		missingAuthority: null,
	};
}

export function planReviewArtifactV2(
	decision: PlanReviewArtifactV2["decision"],
	findings: Array<PlanReviewFindingV2 | ReviewArtifactV1["findings"][number]> = [],
	overrides: Partial<PlanReviewArtifactV2> = {},
	options: { request?: string; constraints?: string } = {},
): PlanReviewArtifactV2 {
	const resolvedFindings = findings.map(finding => ("basis" in finding ? finding : toPlanReviewFinding(finding)));
	const candidateFindings = overrides.findings ?? resolvedFindings;
	const finalFindings =
		decision === "changes_requested" && candidateFindings.length === 0
			? [
					{
						id: "f-default",
						priority: "P1" as const,
						category: "correctness" as const,
						status: "open" as const,
						confidence: 0.9,
						summary: "default finding for changes_requested",
						explanation: "tests must provide actionable findings",
						suggestedOwner: "implementer" as const,
						basis: "repo_evidence" as const,
						requirementId: null,
						sourceRefs: ["test:fixture"],
						missingAuthority: null,
					},
				]
			: candidateFindings;
	// Default approved fixtures satisfy the engine-owned request snapshot so happy-path
	// tests are not blocked by the mandatory coverage gate. Explicit coverage overrides win.
	const defaultSnapshot = buildRequirementsSnapshot({
		workflowId: overrides.workflowId ?? "wf",
		request: {
			request: options.request ?? "default test request",
			constraints: options.constraints,
		},
	});
	const defaultCoverage =
		decision === "approved" && overrides.coverage === undefined ? satisfyMandatoryCoverage(defaultSnapshot) : [];
	return {
		schemaVersion: 2,
		workflowId: "wf",
		attemptId: "att",
		stage: "plan_review",
		createdAt: new Date().toISOString(),
		modelProfileId: "test-profile",
		provider: "test",
		model: "test/model",
		promptVersion: "test-v2",
		kind: "review",
		subject: "plan",
		reviewKind: "initial",
		decision,
		explanation: `decision=${decision}`,
		confidence: 0.9,
		requirementsSnapshotRef: "artifact://requirements",
		requirementsSnapshotSha256: defaultSnapshot.sha256,
		coverage: defaultCoverage,
		uncoveredDimensions: [],
		antiAnchoringRationale: "checked mandatory requirements and open dimensions",
		reviewRound: 1,
		authorResponses: [],
		triggerReason: null,
		routeSelectionReceiptRef: null,
		cleanContextReceiptRef: null,
		specEvidenceReceiptRef: null,
		authorityReceiptRef: null,
		...overrides,
		findings: finalFindings,
	};
}

export function reviewArtifact(
	decision: ReviewArtifactV1["decision"],
	subject: "plan",
	findings?: ReviewArtifactV1["findings"],
): PlanReviewArtifactV2;
export function reviewArtifact(
	decision: ReviewArtifactV1["decision"],
	subject: "implementation",
	findings?: ReviewArtifactV1["findings"],
): ReviewArtifactV1;
export function reviewArtifact(
	decision: ReviewArtifactV1["decision"],
	subject?: ReviewArtifactV1["subject"],
	findings?: ReviewArtifactV1["findings"],
): PlanReviewArtifact | ReviewArtifactV1;
export function reviewArtifact(
	decision: ReviewArtifactV1["decision"],
	subject: ReviewArtifactV1["subject"] = "plan",
	findings: ReviewArtifactV1["findings"] = [],
): PlanReviewArtifact | ReviewArtifactV1 {
	if (subject === "plan") return planReviewArtifactV2(decision, findings);
	// changes_requested must include ≥1 finding (schema contract).
	const resolvedFindings =
		decision === "changes_requested" && findings.length === 0
			? [
					{
						id: "f-default",
						priority: "P1" as const,
						category: "correctness" as const,
						status: "open" as const,
						confidence: 0.9,
						summary: "default finding for changes_requested",
						explanation: "tests must provide actionable findings",
						suggestedOwner: "implementer" as const,
					},
				]
			: findings;
	return {
		schemaVersion: 1,
		workflowId: "wf",
		attemptId: "att",
		stage: "code_review",
		createdAt: new Date().toISOString(),
		kind: "review",
		subject,
		decision,
		findings: resolvedFindings,
		explanation: `decision=${decision}`,
		confidence: 0.9,
	};
}

export function implArtifact(overrides: Partial<ImplementationArtifactV1> = {}): ImplementationArtifactV1 {
	return {
		schemaVersion: 1,
		workflowId: "wf",
		attemptId: "att",
		stage: "implementing",
		createdAt: new Date().toISOString(),
		kind: "implementation",
		summary: "done",
		changedFiles: ["src/a.ts"],
		addressedStepIds: ["s1"],
		commandsRun: [],
		patchPath: "patches/x.patch",
		branchName: "wf/impl",
		unresolved: [],
		...overrides,
	};
}

/**
 * Scripted fake runner keyed by bundled agent names (post role→agent map)
 * plus assignment text to disambiguate reviewer/task dual-use.
 */
export function scriptedRunner(script: {
	plan?: PlanArtifactV1 | (() => PlanArtifactV1);
	planReview?: PlanReviewArtifact | (() => PlanReviewArtifact);
	implement?: ImplementationArtifactV1 | (() => ImplementationArtifactV1);
	codeReview?: ReviewArtifactV1 | (() => ReviewArtifactV1);
	repair?: ImplementationArtifactV1 | (() => ImplementationArtifactV1);
	gatePlanReview?: unknown | (() => unknown);
	gateCodeReview?: unknown | (() => unknown);
}): StructuredRunner {
	return async request => {
		const agent = request.agent ?? "";
		const assignment = request.assignment ?? "";
		const pick = <T>(v: T | (() => T) | undefined, label: string): T => {
			if (v === undefined) throw new Error(`no script for ${label}`);
			return typeof v === "function" ? (v as () => T)() : v;
		};
		let data: unknown;
		let label: string;
		if (agent === "designer" || agent === "planner") {
			label = "plan";
			data = pick(script.plan, label);
		} else if (agent === "subagent-sol" || agent === "subagent-grok" || agent.includes("claude")) {
			if (request.workflowRole === "code_reviewer") {
				label = "gateCodeReview";
				data = pick(script.gateCodeReview ?? script.codeReview, label);
			} else {
				label = "gatePlanReview";
				data = pick(script.gatePlanReview ?? script.planReview, label);
			}
		} else if (agent === "reviewer" || agent === "plan_reviewer" || agent === "code_reviewer") {
			// plan_reviewer and code_reviewer both map to bundled "reviewer"
			if (/code review|implementation/i.test(assignment) && !/plan/i.test(assignment)) {
				label = "codeReview";
				data = pick(script.codeReview, label);
			} else if (/Independent code review/i.test(assignment)) {
				label = "codeReview";
				data = pick(script.codeReview, label);
			} else if (/Review the plan/i.test(assignment) || /plan/i.test(assignment)) {
				label = "planReview";
				data = pick(script.planReview, label);
			} else if (script.planReview && !script.codeReview) {
				label = "planReview";
				data = pick(script.planReview, label);
			} else if (script.codeReview && !script.planReview) {
				label = "codeReview";
				data = pick(script.codeReview, label);
			} else {
				// Prefer planReview first if both present (happy path order)
				label = script.planReview ? "planReview" : "codeReview";
				data = pick(script.planReview ?? script.codeReview, label);
			}
		} else if (agent === "task" || agent === "implementer" || agent === "repair") {
			if (/^Repair findings/i.test(assignment) || agent === "repair") {
				label = "repair";
				data = pick(script.repair ?? script.implement, label);
			} else {
				label = "implement";
				data = pick(script.implement, label);
			}
		} else {
			throw new Error(`unexpected agent ${agent}`);
		}
		const impl = data as ImplementationArtifactV1;
		const patchPath = impl.patchPath;
		if ((label === "implement" || label === "repair") && patchPath) {
			const cwd = request.session?.cwd ?? "/tmp";
			await materializeSamplePatch(cwd, patchPath);
		}
		// Emit a provider-echo attestation so RuntimeAdapter builds a real identity receipt.
		// Prefer the request model pattern when it is an exact provider/model string; otherwise
		// infer provider from bare model ids so lineage diversity (arbitrator avoid) still works.
		const modelSelector = Array.isArray(request.model) ? request.model[0] : request.model;
		let provider = "xai";
		let modelId = "grok-code-test";
		if (typeof modelSelector === "string" && modelSelector.trim().length > 0) {
			if (modelSelector.includes("/")) {
				const slash = modelSelector.indexOf("/");
				provider = modelSelector.slice(0, slash);
				modelId = modelSelector.slice(slash + 1) || modelId;
			} else {
				modelId = modelSelector;
				if (modelId.startsWith("claude") || modelId.startsWith("anthropic")) provider = "anthropic";
				else if (
					modelId.startsWith("gpt") ||
					modelId.startsWith("o1") ||
					modelId.startsWith("o3") ||
					modelId.startsWith("o4")
				) {
					provider = "openai";
				} else if (modelId.startsWith("gemini")) provider = "google";
				else if (modelId.startsWith("grok")) provider = "xai";
			}
		}
		const resolvedModel = `${provider}/${modelId}`;
		if (request.onResponse) {
			const response: ProviderResponseMetadata = {
				status: 200,
				headers: {
					"x-provider-model": modelId,
					"x-omp-resolved-provider": provider,
				},
				requestId: `scripted_${label}`,
			};
			const localModel = {
				id: modelId,
				provider,
				api: "openai-responses",
				name: modelId,
				baseUrl: "https://provider.invalid",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16_000,
				maxTokens: 1_000,
			} as Model;
			request.onResponse(response, localModel);
		}
		return {
			result: {
				id: `raw_${label}`,
				structuredOutput: { status: "valid", data },
				patchPath,
				branchName: impl.branchName,
				usage,
				toolCalls: label === "implement" || label === "repair" ? 3 : undefined,
				resolvedModel,
			},
		};
	};
}

export function passVerifier(): VerifierPort {
	return {
		async verify(artifact, _commands) {
			const result: VerificationArtifactV1 = {
				kind: "verification",
				passed: true,
				checks: [{ id: "c1", status: "passed", summary: "ok" }],
				schemaVersion: 1,
				workflowId: artifact.workflowId,
				attemptId: artifact.attemptId,
				stage: artifact.stage,
				createdAt: new Date().toISOString(),
			};
			return result;
		},
	};
}

export function failVerifier(): VerifierPort {
	return {
		async verify(artifact) {
			return {
				kind: "verification",
				passed: false,
				checks: [{ id: "c1", status: "failed", summary: "fail" }],
				schemaVersion: 1,
				workflowId: artifact.workflowId,
				attemptId: artifact.attemptId,
				stage: artifact.stage,
				createdAt: new Date().toISOString(),
			};
		},
	};
}
