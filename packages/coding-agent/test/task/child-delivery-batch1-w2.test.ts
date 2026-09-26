/**
 * Batch 1 W2 — child delivery producer + parent workspace reclassify.
 */
import { describe, expect, test } from "bun:test";
import {
	bindParentIntegrateDecisionEntry,
	buildChildDeliveryEvidence,
	buildChildDeliveryEvidenceFromExecutorFacts,
	classifyParentIntegrate,
	PARENT_INTEGRATE_DECISION_CUSTOM_TYPE,
	reclassifyParentIntegrateAgainstWorkspace,
} from "../../src/task/child-delivery-evidence";

describe("W2 executor producer", () => {
	test("strips forged proven without evidence locations", () => {
		const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "v1", changedFiles: ["a.ts"] },
			acceptanceItems: [
				{ id: "Types compile", claimedProven: true, evidenceLocations: [] },
				{
					id: "Tests pass",
					claimedProven: true,
					evidenceLocations: ["test/a.test.ts"],
				},
			],
			terminalChecksPassed: [{ id: "Tests pass", evidenceLocation: "log://tests" }],
			writeOwnershipReleased: true,
		});
		expect(delivery.acceptanceProven.find(item => item.id === "Types compile")?.proven).toBe(false);
		expect(delivery.acceptanceProven.find(item => item.id === "Tests pass")?.proven).toBe(true);
		expect(delivery.acceptanceProven.find(item => item.id === "Tests pass")?.evidenceLocations).toContain(
			"log://tests",
		);
	});

	test("worker cannot seal integrate without parent workspace reclassify", () => {
		const delivery = buildChildDeliveryEvidence({
			codeVersion: { version: "v1", changedFiles: ["a.ts"] },
			acceptanceProven: [{ id: "ok", proven: true, evidenceLocations: ["a.ts"] }],
			writeOwnershipReleased: true,
		});
		const packetOnly = classifyParentIntegrate({
			delivery,
			requiredAcceptance: ["ok"],
		});
		expect(packetOnly.action).toBe("integrate");

		const stale = reclassifyParentIntegrateAgainstWorkspace({
			delivery,
			currentCodeVersion: "v2-moved",
			requiredAcceptance: ["ok"],
		});
		expect(stale.action).toBe("reread_then_decide");
		expect(stale.classification).toBe("stale_context");
		expect(stale.boundToWorkspaceVersion).toBe("v2-moved");
	});

	test("unreleased write ownership and missing required acceptance cannot integrate", () => {
		const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "v1", changedFiles: ["api.ts"] },
			acceptanceItems: [{ id: "shared contract", claimedProven: true, evidenceLocations: ["api.ts"] }],
			sharedInterfaces: ["api.ts"],
			writeOwnershipReleased: false,
		});
		const decision = reclassifyParentIntegrateAgainstWorkspace({
			delivery,
			currentCodeVersion: "v1",
			requiredAcceptance: ["shared contract", "missing item"],
			writeOwnershipReleased: false,
		});
		expect(decision.action).not.toBe("integrate");
		expect(["return_to_worker", "parent_coordinate"]).toContain(decision.action);

		const owned = reclassifyParentIntegrateAgainstWorkspace({
			delivery,
			currentCodeVersion: "v1",
			requiredAcceptance: ["shared contract"],
			writeOwnershipReleased: false,
		});
		expect(owned.action).toBe("parent_coordinate");
		expect(owned.reasons.some(r => r.includes("write_ownership"))).toBe(true);
	});

	test("done_valid bind entry is not final acceptance", () => {
		const delivery = buildChildDeliveryEvidence({
			codeVersion: { version: "v1", changedFiles: ["a.ts"] },
			acceptanceProven: [{ id: "ok", proven: true, evidenceLocations: ["a.ts"] }],
			writeOwnershipReleased: true,
		});
		const decision = reclassifyParentIntegrateAgainstWorkspace({
			delivery,
			currentCodeVersion: "v1",
			requiredAcceptance: ["ok"],
			writeOwnershipReleased: true,
		});
		expect(decision.classification).toBe("done_valid");
		const entry = bindParentIntegrateDecisionEntry({
			decision,
			episodeSessionId: "s1",
			rootUserEntryId: "u1",
			workspaceVersion: decision.boundToWorkspaceVersion,
			taskToolCallId: "call-1",
		});
		expect(entry.kind).toBe(PARENT_INTEGRATE_DECISION_CUSTOM_TYPE);
		expect(entry.finalAccepted).toBe(false);
		expect(entry.action).toBe("integrate");
	});
});
