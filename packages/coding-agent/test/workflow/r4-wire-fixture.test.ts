/**
 * D4: measure the assembled final request (static role prompt + context that
 * already carries the requirements snapshot). Not a naive handoff duplicate,
 * and not StageHandoffV1.bytesAfterHandoff.
 */
import { describe, expect, it } from "bun:test";
import implementerPrompt from "../../src/prompts/workflow/implementer.md" with { type: "text" };
import { ContextBuilder } from "../../src/workflow/context-builder";
import { assemblePrompt } from "../../src/workflow/prompt-assembly";
import { buildPlannerToImplementerHandoff } from "../../src/workflow/stage-handoff";
import type { RequirementsSnapshotV1 } from "../../src/workflow/types";
import { planArtifact } from "./helpers";

describe("R4/D4 assembled request boundary", () => {
	it("measures static role prompt plus snapshot context, not a naive duplicate", async () => {
		const plan = planArtifact({
			summary: "wire-fixture-plan-summary",
			acceptanceCriteria: ["acceptance must stay once in the wire body", "second acceptance criterion for volume"],
			verificationCommands: ["bun check", "bun test packages/coding-agent"],
			implementationSteps: Array.from({ length: 12 }, (_, i) => ({
				id: `step-${i}`,
				description: `Implement module ${i} with shared acceptance language that must not duplicate`,
				dependsOn: i > 0 ? [`step-${i - 1}`] : [],
			})),
		});
		const snapshot: RequirementsSnapshotV1 = {
			schemaVersion: 1,
			kind: "requirements_snapshot",
			workflowId: plan.workflowId,
			createdAt: plan.createdAt,
			source: { request: "ship-frozen-request-text", constraints: "hard-constraint-z" },
			requirements: [],
			sha256: "ab".repeat(32),
		};
		const builder = new ContextBuilder();
		const base = builder.buildImplementContext(plan, null, undefined, { requirementsSnapshot: snapshot });
		const handoff = buildPlannerToImplementerHandoff({ plan });
		const context = builder.appendStageHandoff(base, handoff, {
			stage: "implementing",
			requirementsSnapshot: snapshot,
		});
		const assembled = assemblePrompt({
			sections: [
				{
					id: "role_policy",
					content: implementerPrompt,
					stable: true,
					source: "prompts/workflow/implementer.md",
					authority: "system",
				},
				{ id: "handoff", content: context, stable: false, source: "context-builder", authority: "user" },
			],
			cacheObservable: false,
		});

		expect(assembled.text).toContain("acceptance must stay once in the wire body");
		expect(assembled.text.split("acceptance must stay once in the wire body").length - 1).toBe(1);
		expect(assembled.text).not.toContain("acceptance:");
		expect(assembled.text.split("ship-frozen-request-text").length - 1).toBe(1);
		expect(assembled.text).toContain("hard-constraint-z");
		expect(assembled.text.startsWith(implementerPrompt.trim())).toBe(true);
		expect(assembled.receipt.totalBytes).toBe(Buffer.byteLength(assembled.text, "utf-8"));
		expect(assembled.receipt.cacheObservable).toBe(false);
		expect(assembled.receipt.cacheReadTokens).toBeNull();
		expect(handoff.bytesAfterHandoff).not.toBe(assembled.receipt.totalBytes);
	});
});
