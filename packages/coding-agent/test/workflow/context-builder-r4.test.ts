import { describe, expect, it } from "bun:test";
import { ContextBuilder, projectPlanForPrompt } from "../../src/workflow/context-builder";
import { buildPlannerToImplementerHandoff } from "../../src/workflow/stage-handoff";
import { planArtifact } from "./helpers";

describe("context assembly dedupe (R4)", () => {
	it("does not expand acceptance/verification lists beside a full inlined plan", () => {
		const plan = planArtifact({
			summary: "unique-plan-summary-xyz",
			acceptanceCriteria: ["must keep acceptance A", "must keep acceptance B"],
			verificationCommands: ["bun test unique-verify"],
		});
		const ctx = new ContextBuilder().buildImplementContext(plan);
		expect(ctx).toContain("unique-plan-summary-xyz");
		expect(ctx).toContain("must keep acceptance A");
		// Full plan JSON already carries criteria — section body must not re-list them.
		expect(ctx).toContain("(see Approved plan above)");
		const acceptanceSection = ctx.split("## Acceptance criteria")[1]?.split("##")[0] ?? "";
		expect(acceptanceSection).not.toContain("- must keep acceptance A");
		expect(acceptanceSection).toContain("(see Approved plan above)");
	});

	it("projects large plans while retaining full acceptance/verification arrays", () => {
		const hugeSteps = Array.from({ length: 400 }, (_, i) => ({
			id: `s${i}`,
			description: `step-${i}-${"x".repeat(40)}`,
			dependsOn: [] as string[],
		}));
		const plan = planArtifact({
			summary: "large",
			implementationSteps: hugeSteps,
			acceptanceCriteria: ["hard-constraint-keep-me", "second-hard"],
			verificationCommands: ["bun test keep-verify"],
		});
		const projected = projectPlanForPrompt(plan, {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 2_000,
		});
		expect(projected.mode).toBe("projected");
		expect(projected.planJson).toContain("hard-constraint-keep-me");
		expect(projected.planJson).toContain("second-hard");
		expect(projected.planJson).toContain("bun test keep-verify");
		expect(projected.planJson).toContain("_recoveryHint");
		expect(projected.planJson).toContain("_projection");
		// Projection keeps hard constraints + steps and adds recovery metadata; it is
		// not a byte-shrink guarantee — wire savings are measured on the assembled prompt.
		expect(projected.planJson).toContain('"id": "s0"');
		expect(projected.planJson).toContain('"id": "s399"');
	});

	it("omits plan-kind handoff duplicates when Approved plan is already inlined (D1/D4 assembly)", () => {
		const plan = planArtifact({
			summary: "handoff-dedupe",
			acceptanceCriteria: ["acc-1"],
			verificationCommands: ["bun check"],
		});
		const base = new ContextBuilder().buildImplementContext(plan);
		const handoff = buildPlannerToImplementerHandoff({ plan });
		const withHandoff = new ContextBuilder().appendStageHandoff(base, handoff);
		expect(withHandoff).toContain("## Approved plan");
		expect(withHandoff).toContain("Stage handoff");
		// Prompt view should not re-embed plan acceptance summary fields.
		expect(withHandoff).toContain("dedupeNote");
		expect(withHandoff).not.toMatch(/"summary": "acceptance: \[/);
		const baseBytes = Buffer.byteLength(base, "utf-8");
		const finalBytes = Buffer.byteLength(withHandoff, "utf-8");
		const naiveDupBytes = Buffer.byteLength(
			`${base}\n\n## Stage handoff\n\`\`\`json\n${JSON.stringify(handoff, null, 2)}\n\`\`\`\n`,
			"utf-8",
		);
		expect(finalBytes).toBeGreaterThan(baseBytes);
		expect(finalBytes).toBeLessThan(naiveDupBytes);
		// Handoff object still reports summary-field bytes, not wire tokens.
		expect(handoff.bytesAfterHandoff).toBeGreaterThan(0);
		expect(handoff.bytesAfterHandoff).toBeLessThan(handoff.bytesBeforeHandoff);
	});
});
