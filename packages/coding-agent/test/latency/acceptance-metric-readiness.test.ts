import { describe, expect, it } from "bun:test";
import { buildDeliveryCostBaselineReport } from "../../src/latency/delivery-cost-baseline";
import { buildParentFinalVerificationDetails } from "../../src/latency/parent-final-verification";
import { buildSubagentBaselineReport, parseSessionJsonl } from "../../src/latency/subagent-report";

/**
 * S1 readiness: Package 1 can emit cost-per-accepted when a receipt exists, and
 * keeps cost-per-accepted null / unknown until then. Does not expand schemas.
 */

const PARENT = "/tmp/sessions/s1-accept/sess.jsonl";

function line(value: unknown): string {
	return JSON.stringify(value);
}

describe("acceptance metric readiness (S1)", () => {
	it("keeps costPerAcceptedTask null when no parent_final_verification receipt exists", () => {
		const jsonl = [
			line({
				type: "session",
				version: 3,
				id: "no-receipt",
				timestamp: "2026-09-26T10:00:00.000Z",
				cwd: "/tmp",
			}),
			line({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-09-26T10:00:00.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "do work" }],
					timestamp: 1_000,
				},
			}),
			line({
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-09-26T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					timestamp: 2_000,
					model: "test/model",
					stopReason: "stop",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { input: 0.1, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.15 },
					},
				},
			}),
		].join("\n");
		const session = parseSessionJsonl(jsonl, PARENT);
		const baseline = buildSubagentBaselineReport([session]);
		const cost = buildDeliveryCostBaselineReport([session]);
		expect(cost.unknownCohort.costPerAcceptedTask).toBeNull();
		expect(cost.ordinary.acceptedTaskCount).toBe(0);
		expect(cost.workflow.acceptedTaskCount).toBe(0);
		expect(baseline.uncomputableFromHistory).toContain("parentFinalVerification");
	});

	it("emits costPerAcceptedTask when a workflow receipt with verifiedAtMs exists", () => {
		const verifiedAtMs = 5_000;
		const details = buildParentFinalVerificationDetails("passed", "workflow", verifiedAtMs, {
			authority: "workflow",
		});
		expect(details.verifiedAtMs).toBe(verifiedAtMs);
		const jsonl = [
			line({
				type: "session",
				version: 3,
				id: "with-receipt",
				timestamp: "2026-09-26T10:00:00.000Z",
				cwd: "/tmp",
			}),
			line({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-09-26T10:00:00.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "do work" }],
					timestamp: 1_000,
				},
			}),
			line({
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-09-26T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					timestamp: 2_000,
					model: "test/model",
					stopReason: "stop",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 },
					},
				},
			}),
			line({
				type: "custom",
				id: "pfv1",
				parentId: null,
				timestamp: "2026-09-26T10:00:05.000Z",
				customType: "parent_final_verification",
				data: details,
			}),
		].join("\n");
		const session = parseSessionJsonl(jsonl, PARENT);
		expect(session.parentFinalVerifications.at(-1)).toMatchObject({
			status: "passed",
			source: "workflow",
			ts: verifiedAtMs,
		});
		const baseline = buildSubagentBaselineReport([session]);
		const cost = buildDeliveryCostBaselineReport([session]);
		expect(cost.workflow.acceptedTaskCount).toBe(1);
		expect(cost.workflow.costPerAcceptedTask).toBeCloseTo(0.3);
		expect(baseline.uncomputableFromHistory).not.toContain("parentFinalVerification");
	});
});
