/**
 * D4: frozen fixture comparing assembled prompt UTF-8 bytes and tokenizer
 * estimates — not StageHandoffV1.bytesAfterHandoff (summary-field only).
 */
import { describe, expect, it } from "bun:test";
import { Encoding, countTokens } from "@oh-my-pi/pi-natives";
import { ContextBuilder } from "../../src/workflow/context-builder";
import { estimateTokens } from "../../src/workflow/context-evictor";
import { buildPlannerToImplementerHandoff } from "../../src/workflow/stage-handoff";
import { planArtifact } from "./helpers";

function measureWire(text: string) {
	const utf8Bytes = Buffer.byteLength(text, "utf-8");
	return {
		utf8Bytes,
		estimateBytesDiv4: estimateTokens(text),
		tokenizerJev: countTokens(text, Encoding.Jev),
	};
}

describe("R4/D4 frozen wire fixture (assembly boundary)", () => {
	it("records real byte and token deltas for deduped vs naive-duplicate handoff", async () => {
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
		const base = new ContextBuilder().buildImplementContext(plan);
		const handoff = buildPlannerToImplementerHandoff({ plan });
		const deduped = new ContextBuilder().appendStageHandoff(base, handoff);
		const naiveDup = `${base}\n\n## Stage handoff\n\`\`\`json\n${JSON.stringify(handoff, null, 2)}\n\`\`\`\n`;

		const baseM = measureWire(base);
		const dedupedM = measureWire(deduped);
		const naiveM = measureWire(naiveDup);

		expect(deduped).toContain("## Approved plan");
		expect(deduped).toContain("dedupeNote");
		expect(dedupedM.utf8Bytes).toBeGreaterThan(baseM.utf8Bytes);
		expect(dedupedM.utf8Bytes).toBeLessThan(naiveM.utf8Bytes);
		expect(dedupedM.tokenizerJev).toBeLessThan(naiveM.tokenizerJev);
		expect(dedupedM.estimateBytesDiv4).toBeLessThan(naiveM.estimateBytesDiv4);

		// bytesAfterHandoff is summary-field accounting — must not be treated as wire save.
		expect(handoff.bytesAfterHandoff).toBeLessThan(handoff.bytesBeforeHandoff);
		expect(handoff.bytesAfterHandoff).not.toBe(naiveM.utf8Bytes - dedupedM.utf8Bytes);

		// Frozen numeric report for artifacts (assert semantic shape, not exact churn).
		const report = {
			fixture: "planner_to_implementer_dedupe_v1",
			base: baseM,
			deduped: dedupedM,
			naiveDuplicate: naiveM,
			savedUtf8BytesVsNaive: naiveM.utf8Bytes - dedupedM.utf8Bytes,
			savedTokenizerJevVsNaive: naiveM.tokenizerJev - dedupedM.tokenizerJev,
			handoffObjectBytesAfter: handoff.bytesAfterHandoff,
			handoffObjectBytesBefore: handoff.bytesBeforeHandoff,
			note: "Wire measurement is assembled prompt UTF-8 + countTokens(Jev) + estimateTokens(bytes/4). handoff.bytesAfterHandoff is not wire.",
		};
		expect(report.savedUtf8BytesVsNaive).toBeGreaterThan(0);
		expect(report.savedTokenizerJevVsNaive).toBeGreaterThan(0);
		await Bun.write(
			new URL("../../../../artifacts/r4-wire-fixture-report.json", import.meta.url).pathname,
			`${JSON.stringify(report, null, 2)}\n`,
		);
	});
});
