import { describe, expect, it } from "bun:test";
import { ContextBuilder } from "../../src/workflow/context-builder";
import { FindingTracker } from "../../src/workflow/finding-tracker";
import { ImplementationArtifactJsonSchema, ReviewArtifactJsonSchema } from "../../src/workflow/json-schemas";
import { parseWorkflowArtifact } from "../../src/workflow/parse-artifact";
import { ReviewArtifactSchema } from "../../src/workflow/schemas";
import { planArtifact, reviewArtifact } from "./helpers";

describe("CR8 contract fixes", () => {
	it("JSON Schema findings items require priority/category/confidence", () => {
		const items = ReviewArtifactJsonSchema.properties.findings.items as unknown as {
			required: readonly string[];
			additionalProperties: boolean;
		};
		expect(items.required).toContain("priority");
		expect(items.required).toContain("category");
		expect(items.required).toContain("confidence");
		expect(items.additionalProperties).toBe(false);
		const cmd = ImplementationArtifactJsonSchema.properties.commandsRun.items as unknown as {
			required: readonly string[];
			additionalProperties: boolean;
		};
		expect([...cmd.required]).toEqual(["command", "exitCode", "summary"]);
		expect(cmd.additionalProperties).toBe(false);
	});

	it("changes_requested without findings is schema_violation", () => {
		expect(() =>
			parseWorkflowArtifact(
				ReviewArtifactSchema,
				{
					schemaVersion: 1,
					workflowId: "wf",
					attemptId: "a",
					stage: "plan_review",
					createdAt: "2026-07-23T00:00:00.000Z",
					kind: "review",
					subject: "plan",
					decision: "changes_requested",
					findings: [],
					explanation: "needs work",
					confidence: 0.9,
				},
				"ReviewArtifact",
			),
		).toThrow(/schema_violation|requires at least one finding/i);
	});

	it("replan/repair contexts include reviewer explanation", () => {
		const review = reviewArtifact("changes_requested", "plan", [
			{
				id: "f1",
				priority: "P1",
				category: "correctness",
				status: "open",
				confidence: 0.9,
				summary: "race",
				explanation: "Fix the race described here",
				suggestedOwner: "implementer",
			},
		]);
		// force explanation
		review.explanation = "Fix the race described here in detail";
		const cb = new ContextBuilder();
		const planCtx = cb.buildPlanContext({
			request: { request: "build it" },
			priorReview: review,
		});
		expect(planCtx).toContain("Fix the race described here in detail");
		const repairCtx = cb.buildRepairContext({
			plan: planArtifact(),
			findings: review.findings,
			reviewExplanation: review.explanation,
		});
		expect(repairCtx).toContain("Fix the race described here in detail");
	});

	it("recordRepairCycle once per unique fingerprint not per finding id", () => {
		const tracker = new FindingTracker();
		const base = {
			priority: "P1" as const,
			category: "correctness" as const,
			status: "open" as const,
			confidence: 0.9,
			summary: "same bug",
			explanation: "dup",
			suggestedOwner: "implementer" as const,
			file: "a.ts",
			line: 10,
		};
		const f1 = tracker.add({ id: "a", ...base });
		const f2 = tracker.add({ id: "b", ...base });
		const f3 = tracker.add({ id: "c", ...base });
		expect(f1.fingerprint).toBe(f2.fingerprint);
		expect(f2.fingerprint).toBe(f3.fingerprint);
		// Simulate engine dedupe: one record per fingerprint
		const seen = new Set<string>();
		const escalations: string[] = [];
		for (const f of [f1, f2, f3]) {
			if (seen.has(f.fingerprint)) continue;
			seen.add(f.fingerprint);
			escalations.push(tracker.recordRepairCycle(f.fingerprint));
		}
		expect(escalations).toEqual(["first_repair"]);
		expect(tracker.cycleCount(f1.fingerprint)).toBe(1);
	});
});
