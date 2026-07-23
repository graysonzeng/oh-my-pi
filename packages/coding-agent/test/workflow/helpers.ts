import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../../src/tools";
import type { StructuredRunner } from "../../src/workflow/runtime-adapter";
import type {
	ImplementationArtifactV1,
	PlanArtifactV1,
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
		affectedFiles: [{ path: "src/a.ts", action: "modify", reason: "fix" }],
		implementationSteps: [{ id: "s1", description: "edit", dependsOn: [] }],
		acceptanceCriteria: ["tests pass"],
		verificationCommands: ["echo ok"],
		risks: [],
		rollback: [],
		...overrides,
	};
}

export function reviewArtifact(
	decision: ReviewArtifactV1["decision"],
	subject: ReviewArtifactV1["subject"] = "plan",
	findings: ReviewArtifactV1["findings"] = [],
): ReviewArtifactV1 {
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
		stage: subject === "plan" ? "plan_review" : "code_review",
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
	planReview?: ReviewArtifactV1 | (() => ReviewArtifactV1);
	implement?: ImplementationArtifactV1 | (() => ImplementationArtifactV1);
	codeReview?: ReviewArtifactV1 | (() => ReviewArtifactV1);
	repair?: ImplementationArtifactV1 | (() => ImplementationArtifactV1);
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
		return {
			result: {
				id: `raw_${label}`,
				structuredOutput: { status: "valid", data },
				patchPath: impl.patchPath,
				branchName: impl.branchName,
				usage,
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
