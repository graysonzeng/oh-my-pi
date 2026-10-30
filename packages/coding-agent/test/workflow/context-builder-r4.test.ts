import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ArtifactStore } from "../../src/workflow/artifact-store";
import { ContextBuilder, projectPlanForPrompt } from "../../src/workflow/context-builder";
import {
	buildPlannerToImplementerHandoff,
	buildReviewerToRepairHandoff,
	fileRecoveryUri,
	syntheticArtifactRef,
} from "../../src/workflow/stage-handoff";
import type { PlanArtifactV1, RequirementsSnapshotV1, StageHandoffArtifactRef } from "../../src/workflow/types";
import { expandPath } from "../../src/tools/path-utils";
import { planArtifact, reviewArtifact } from "./helpers";

const inclusion = {
	includePlan: true,
	includeReviewFindings: true,
	includeVerification: true,
	includeFullTranscript: false,
	maxArtifactBytes: 2_000,
} as const;

function hugePlan() {
	return planArtifact({
		implementationSteps: Array.from({ length: 40 }, (_, i) => ({
			id: `s${i}`,
			description: `step-${i}-${"x".repeat(400)}`,
			dependsOn: [] as string[],
		})),
		acceptanceCriteria: ["hard-constraint-keep-me", "second-hard"],
		verificationCommands: ["bun test keep-verify"],
	});
}

async function storePlan(plan: PlanArtifactV1): Promise<{
	dir: string;
	ref: StageHandoffArtifactRef;
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-r4-"));
	const store = new ArtifactStore(dir);
	const content = JSON.stringify(plan);
	const stored = await store.store({
		workflowId: plan.workflowId,
		attemptId: plan.attemptId,
		kind: "plan",
		schemaVersion: 1,
		relativePath: "",
		content,
	});
	return {
		dir,
		ref: {
			artifactId: stored.id,
			bytes: Buffer.byteLength(content, "utf-8"),
			recoveryUri: fileRecoveryUri(path.join(dir, stored.relativePath)),
			contentSha256: stored.sha256,
		},
	};
}

function snapshot(): RequirementsSnapshotV1 {
	return {
		schemaVersion: 1,
		kind: "requirements_snapshot",
		workflowId: "wf",
		createdAt: "2026-01-01T00:00:00.000Z",
		source: {
			request: "ship-frozen-request-text",
			constraints: "hard-constraint-z",
		},
		requirements: [],
		sha256: "ab".repeat(32),
	};
}

describe("context assembly dedupe (R4)", () => {
	it("keeps acceptance once when the plan JSON is already in the implement prompt", () => {
		const plan = planArtifact({
			acceptanceCriteria: ["must keep acceptance A"],
			verificationCommands: ["bun check"],
		});
		const ctx = new ContextBuilder().buildImplementContext(plan);
		expect(ctx).toContain("must keep acceptance A");
		const acceptanceSection = ctx.split("## Acceptance criteria")[1]?.split("##")[0] ?? "";
		expect(acceptanceSection).toContain("(see Approved plan above)");
		expect(acceptanceSection).not.toContain("- must keep acceptance A");
		expect(ctx.split("must keep acceptance A").length - 1).toBe(1);
	});

	it("keeps every step when no persisted file ref can recover them", () => {
		const plan = hugePlan();
		const projected = projectPlanForPrompt(plan, inclusion);
		expect(projected.mode).toBe("full");
		expect(projected.recoveryUri).toBeUndefined();
		expect(projected.planJson).toContain("hard-constraint-keep-me");
		expect(projected.planJson).toContain("bun test keep-verify");
		expect(projected.planJson).toContain('"id": "s39"');
		const synthetic = projectPlanForPrompt(plan, inclusion, syntheticArtifactRef("plan", plan));
		expect(synthetic.mode).toBe("full");
		expect(synthetic.planJson).toContain('"id": "s39"');
	});

	it("omits oversized steps only after the stored file verifies, and the file still has them", async () => {
		const plan = hugePlan();
		const stored = await storePlan(plan);
		try {
			const projected = projectPlanForPrompt(plan, inclusion, stored.ref);
			expect(projected.mode).toBe("projected");
			expect(projected.planJson).toContain("hard-constraint-keep-me");
			expect(projected.planJson).toContain("bun test keep-verify");
			expect(projected.planJson).not.toContain('"id": "s39"');
			const withinConfiguredBudget = projectPlanForPrompt(
				plan,
				{ ...inclusion, maxArtifactBytes: 1_000_000 },
				stored.ref,
			);
			expect(withinConfiguredBudget.mode).toBe("full");
			expect(withinConfiguredBudget.planJson).toContain('"id": "s39"');
			expect(projected.recoveryUri).toBe(stored.ref.recoveryUri);
			const ctx = new ContextBuilder().buildImplementContext(plan, null, inclusion, { planRef: stored.ref });
			expect(ctx).toContain(stored.ref.recoveryUri!);
			expect(ctx).toContain(stored.ref.contentSha256!);
			expect(ctx.split("hard-constraint-keep-me").length - 1).toBe(1);
			const resolved = expandPath(stored.ref.recoveryUri);
			const text = await Bun.file(resolved).text();
			const recovered = JSON.parse(text) as PlanArtifactV1;
			expect(recovered.implementationSteps.at(-1)?.id).toBe("s39");
			expect(recovered.acceptanceCriteria).toContain("hard-constraint-keep-me");
		} finally {
			await fs.rm(stored.dir, { recursive: true, force: true });
		}
	});

	it("keeps the full plan when the recovery file is missing or the sha does not match", async () => {
		const plan = hugePlan();
		const missing = fileRecoveryUri(path.join(os.tmpdir(), `missing-plan-${Date.now()}.json`));
		const missingRef: StageHandoffArtifactRef = {
			artifactId: "missing",
			bytes: 12,
			recoveryUri: missing,
			contentSha256: "cd".repeat(32),
		};
		expect(projectPlanForPrompt(plan, inclusion, missingRef).mode).toBe("full");
		const stored = await storePlan(plan);
		try {
			const mismatched = { ...stored.ref, contentSha256: "ef".repeat(32) };
			const projected = projectPlanForPrompt(plan, inclusion, mismatched);
			expect(projected.mode).toBe("full");
			expect(projected.planJson).toContain('"id": "s39"');
		} finally {
			await fs.rm(stored.dir, { recursive: true, force: true });
		}
	});

	it("drops repeated plan extracts on repair without dropping the blocking finding", () => {
		const plan = planArtifact({
			acceptanceCriteria: ["repair-acceptance-once"],
			verificationCommands: ["bun check"],
		});
		const finding = {
			id: "f1",
			priority: "P0" as const,
			category: "correctness" as const,
			status: "open" as const,
			confidence: 0.9,
			summary: "blocking repair fact",
			explanation: "null",
			file: "src/a.ts",
			line: 4,
			suggestedOwner: "implementer" as const,
			blocking: true,
		};
		const builder = new ContextBuilder();
		const base = builder.buildRepairContext({ plan, findings: [finding] });
		const planner = buildPlannerToImplementerHandoff({ plan });
		const withPlanner = builder.appendStageHandoff(base, planner);
		expect(withPlanner.split("repair-acceptance-once").length - 1).toBe(1);
		expect(withPlanner).not.toContain("acceptance:");
		const review = reviewArtifact("changes_requested", "implementation", [finding]);
		const handoff = buildReviewerToRepairHandoff({ review, implementation: undefined });
		const withRepair = builder.appendStageHandoff(base, handoff);
		expect(withRepair).toContain("blocking repair fact");
		expect(withRepair.split("repair-acceptance-once").length - 1).toBe(1);
	});

	it("adds frozen request and constraints only on downstream stages", () => {
		const plan = planArtifact({ summary: "downstream-plan" });
		const source = snapshot();
		const builder = new ContextBuilder();
		const implement = builder.buildImplementContext(plan, null, undefined, { requirementsSnapshot: source });
		expect(implement).toContain("## Frozen request");
		expect(implement).toContain("ship-frozen-request-text");
		expect(implement).toContain("## Frozen constraints");
		expect(implement).toContain("hard-constraint-z");
		const again = builder.appendStageHandoff(implement, null, {
			stage: "implementing",
			requirementsSnapshot: source,
		});
		expect(again.split("## Frozen request").length - 1).toBe(1);

		const planning = builder.buildPlanContext({
			request: { request: "ship-frozen-request-text", constraints: "hard-constraint-z" },
		});
		const planningAssembled = builder.appendStageHandoff(planning, null, {
			stage: "planning",
			requirementsSnapshot: source,
		});
		expect(planningAssembled).not.toContain("## Frozen request");
		expect(planningAssembled.split("ship-frozen-request-text").length - 1).toBe(1);

		const reviewed = builder.buildPlanReviewContext(plan, undefined, source);
		expect(reviewed).toContain("ship-frozen-request-text");
		expect(reviewed).not.toContain("## Frozen request");
		const reviewedAgain = builder.appendStageHandoff(reviewed, null, {
			stage: "plan_review",
			requirementsSnapshot: source,
		});
		expect(reviewedAgain).not.toContain("## Frozen request");
		expect(reviewedAgain.split("ship-frozen-request-text").length - 1).toBe(1);
	});

	it("recovers a stored plan through the file URL the read tool already resolves", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-r4-"));
		try {
			const store = new ArtifactStore(dir);
			const plan = planArtifact({ summary: "recover-me" });
			const stored = await store.store({
				workflowId: plan.workflowId,
				attemptId: plan.attemptId,
				kind: "plan",
				schemaVersion: 1,
				relativePath: "",
				content: JSON.stringify(plan),
			});
			const uri = fileRecoveryUri(path.join(dir, stored.relativePath));
			expect(uri.startsWith("file://")).toBe(true);
			const resolved = expandPath(uri);
			expect(pathToFileURL(resolved).href).toBe(uri);
			const text = await Bun.file(resolved).text();
			expect(text).toContain("recover-me");
			const loaded = await store.load(stored.relativePath, stored.sha256);
			expect(loaded?.content).toBe(text);
			await expect(store.load(stored.relativePath, "0".repeat(64))).rejects.toThrow(/hash/i);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
