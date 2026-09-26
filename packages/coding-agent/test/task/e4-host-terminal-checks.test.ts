import { describe, expect, it } from "bun:test";
import {
	buildChildDeliveryEvidenceFromExecutorFacts,
	extractHostTerminalChecksFromExecutorResult,
	reclassifyParentIntegrateAgainstWorkspace,
} from "../../src/task/child-delivery-evidence";

describe("E4 host terminal checks on auto delivery path", () => {
	it("ignores bare ids without evidenceLocation (cannot forge proven)", () => {
		const checks = extractHostTerminalChecksFromExecutorResult({
			extractedToolData: {
				host_verification: [{ id: "Tests pass" }, { id: "ok", evidenceLocation: "   " }],
			},
		});
		expect(checks).toEqual([]);
	});

	it("wires host_verification receipts into proven acceptance when version matches (B1)", () => {
		const host = extractHostTerminalChecksFromExecutorResult({
			extractedToolData: {
				host_verification: [{ id: "Tests pass", evidenceLocation: "log://tests" }],
			},
		});
		expect(host).toEqual([{ id: "Tests pass", evidenceLocation: "log://tests" }]);
		const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "content:abc", changedFiles: ["a.ts"] },
			acceptanceItems: [{ id: "Tests pass", claimedProven: true }],
			terminalChecksPassed: host,
			writeOwnershipReleased: true,
		});
		expect(delivery.acceptanceProven[0]?.proven).toBe(true);
		const decision = reclassifyParentIntegrateAgainstWorkspace({
			delivery,
			currentCodeVersion: "content:abc",
			requiredAcceptance: ["Tests pass"],
			writeOwnershipReleased: true,
		});
		expect(decision.action).toBe("integrate");
		expect(decision.classification).toBe("done_valid");
	});

	it("without host receipts stays unverified / checksNotRun (B5)", () => {
		const host = extractHostTerminalChecksFromExecutorResult({ extractedToolData: {} });
		expect(host).toHaveLength(0);
		const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "content:abc", changedFiles: ["a.ts"] },
			acceptanceItems: [{ id: "Tests pass", claimedProven: false }],
			checksNotRun: [{ id: "parent_acceptance", reason: "parent owns final acceptance" }],
			writeOwnershipReleased: false,
		});
		expect(delivery.acceptanceProven[0]?.proven).toBe(false);
		expect(delivery.checksNotRun.some(c => c.id === "parent_acceptance")).toBe(true);
	});
});
