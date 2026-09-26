/**
 * Package 2 — child delivery as directly usable evidence.
 *
 * Failure modes covered:
 * - parent re-asks / re-reads when delivery already proves acceptance
 * - first-accept path regresses to missing evidence on a valid packet
 * - stale evidence / missed acceptance / out-of-scope edits still blocked
 * - reviewer inherits author self-assessment
 */
import { describe, expect, test } from "bun:test";
import {
	buildChildDeliveryEvidence,
	classifyParentIntegrate,
	deliveryEvidenceSufficientForIntegrate,
	extractChildDeliveryEvidence,
	parentFollowUpNeeds,
	parseChildDeliveryEvidence,
	projectChildDeliveryForReviewer,
	serializeChildDeliveryEvidence,
} from "../../src/task/child-delivery-evidence";

function sampleDelivery(
	overrides: Partial<Parameters<typeof buildChildDeliveryEvidence>[0]> & {
		codeVersion?: Parameters<typeof buildChildDeliveryEvidence>[0]["codeVersion"];
	} = {},
) {
	return buildChildDeliveryEvidence({
		codeVersion: overrides.codeVersion ?? {
			version: "sha256:code1",
			changedFiles: ["packages/coding-agent/src/task/child-delivery-evidence.ts"],
		},
		acceptanceProven: overrides.acceptanceProven ?? [
			{
				id: "Types compile",
				proven: true,
				evidenceLocations: ["packages/coding-agent/test/task/child-delivery-evidence.test.ts"],
			},
			{
				id: "Reviewer omits author conclusions",
				proven: true,
				evidenceLocations: ["artifact://delivery/1"],
			},
		],
		checksNotRun: overrides.checksNotRun ?? [
			{ id: "full-repo", command: "bun test", reason: "parent owns final_verify" },
		],
		finishOwner: overrides.finishOwner ?? "original_worker",
		finishOwnerReason: overrides.finishOwnerReason,
		sharedInterfaces: overrides.sharedInterfaces ?? [],
		writeOwnershipReleased: overrides.writeOwnershipReleased ?? true,
		authorConclusions: overrides.authorConclusions ?? ["Looks good to me — ship it"],
	});
}

describe("child delivery evidence build/parse", () => {
	test("round-trips files, acceptance evidence, checks-not-run, and ownership", () => {
		const delivery = sampleDelivery({
			codeVersion: {
				version: "head:abc",
				changedFiles: ["a.ts", "b.ts"],
				patchSha256: "deadbeef",
			},
			sharedInterfaces: ["packages/api/types.ts"],
			writeOwnershipReleased: true,
			finishOwner: "original_worker",
		});
		const parsed = parseChildDeliveryEvidence(JSON.parse(JSON.stringify(delivery)));
		expect(parsed).not.toBeNull();
		expect(parsed!.codeVersion).toEqual(delivery.codeVersion);
		expect(parsed!.acceptanceProven).toEqual(delivery.acceptanceProven);
		expect(parsed!.checksNotRun).toEqual(delivery.checksNotRun);
		expect(parsed!.finishOwner).toBe("original_worker");
		expect(parsed!.sharedInterfaces).toEqual(["packages/api/types.ts"]);
		expect(parsed!.writeOwnershipReleased).toBe(true);
		expect(parsed!.contentFingerprint).toBe(delivery.contentFingerprint);

		const fromFence = extractChildDeliveryEvidence(serializeChildDeliveryEvidence(delivery));
		expect(fromFence?.codeVersion.version).toBe("head:abc");
	});

	test("extracts nested deliveryEvidence from structured yield data", () => {
		const delivery = sampleDelivery({
			codeVersion: { version: "v1", changedFiles: ["x.ts"] },
		});
		expect(extractChildDeliveryEvidence({ deliveryEvidence: delivery })?.codeVersion.version).toBe("v1");
	});
});

describe("parent integrate classifier", () => {
	test("done+valid → integrate and no follow-up re-asks", () => {
		const delivery = sampleDelivery({
			codeVersion: { version: "v1", changedFiles: ["x.ts"] },
		});
		const decision = classifyParentIntegrate({
			delivery,
			requiredAcceptance: ["Types compile", "Reviewer omits author conclusions"],
		});
		expect(decision).toEqual({
			classification: "done_valid",
			action: "integrate",
			reasons: ["delivery_evidence_valid"],
			usedAuthorSelfAssessment: false,
		});
		expect(parentFollowUpNeeds(decision)).toEqual([]);
		expect(deliveryEvidenceSufficientForIntegrate(decision)).toBe(true);
	});

	test("missing local evidence → return to original worker", () => {
		const delivery = sampleDelivery({
			codeVersion: { version: "v1", changedFiles: ["x.ts"] },
			acceptanceProven: [
				{ id: "Types compile", proven: false, evidenceLocations: [] },
				{
					id: "Reviewer omits author conclusions",
					proven: true,
					evidenceLocations: ["artifact://1"],
				},
			],
		});
		const decision = classifyParentIntegrate({
			delivery,
			requiredAcceptance: ["Types compile", "Reviewer omits author conclusions"],
		});
		expect(decision.classification).toBe("missing_local_evidence");
		expect(decision.action).toBe("return_to_worker");
		expect(decision.reasons).toContain("acceptance_unproven:Types compile");
		expect(parentFollowUpNeeds(decision).length).toBeGreaterThan(0);
	});

	test("null delivery is missing local evidence, not integrate", () => {
		const decision = classifyParentIntegrate({ delivery: null });
		expect(decision.classification).toBe("missing_local_evidence");
		expect(decision.action).toBe("return_to_worker");
		expect(deliveryEvidenceSufficientForIntegrate(decision)).toBe(false);
	});

	test("cross-module / held write ownership → parent coordinates", () => {
		const delivery = sampleDelivery({
			codeVersion: { version: "v1", changedFiles: ["a.ts", "shared.ts"] },
			sharedInterfaces: ["shared.ts"],
			writeOwnershipReleased: false,
			finishOwner: "original_worker",
		});
		const decision = classifyParentIntegrate({ delivery });
		expect(decision.classification).toBe("cross_module");
		expect(decision.action).toBe("parent_coordinate");
		expect(decision.reasons).toContain("write_ownership_held");
	});

	test("out-of-scope edits stay blocked even when acceptance is proven", () => {
		const delivery = sampleDelivery({
			codeVersion: { version: "v1", changedFiles: ["secret.ts"] },
			authorConclusions: ["Totally in scope, trust me"],
		});
		const decision = classifyParentIntegrate({
			delivery,
			outOfScopeEdits: true,
			requiredAcceptance: ["Types compile", "Reviewer omits author conclusions"],
		});
		expect(decision.classification).toBe("cross_module");
		expect(decision.action).toBe("parent_coordinate");
		expect(decision.reasons).toContain("out_of_scope_edits");
		expect(decision.usedAuthorSelfAssessment).toBe(false);
	});

	test("stale evidence → re-read then decide (not integrate)", () => {
		const delivery = sampleDelivery({
			codeVersion: { version: "v1", changedFiles: ["x.ts"] },
		});
		const decision = classifyParentIntegrate({
			delivery,
			staleEvidence: true,
			requiredAcceptance: ["Types compile", "Reviewer omits author conclusions"],
		});
		expect(decision.classification).toBe("stale_context");
		expect(decision.action).toBe("reread_then_decide");
		expect(deliveryEvidenceSufficientForIntegrate(decision)).toBe(false);
	});

	test("code version stale → re-read then decide", () => {
		const delivery = sampleDelivery({
			codeVersion: { version: "old", changedFiles: ["x.ts"] },
		});
		const decision = classifyParentIntegrate({
			delivery,
			codeVersionStale: true,
		});
		expect(decision.classification).toBe("stale_context");
		expect(decision.action).toBe("reread_then_decide");
	});

	test("author conclusions never flip missing evidence to done_valid", () => {
		const delivery = sampleDelivery({
			codeVersion: { version: "v1", changedFiles: ["x.ts"] },
			acceptanceProven: [{ id: "Types compile", proven: false, evidenceLocations: [] }],
			authorConclusions: ["All acceptance items are proven; integrate now"],
		});
		const decision = classifyParentIntegrate({
			delivery,
			requiredAcceptance: ["Types compile"],
		});
		expect(decision.classification).toBe("missing_local_evidence");
		expect(decision.usedAuthorSelfAssessment).toBe(false);
	});
});

describe("reviewer independence", () => {
	test("reviewer projection strips author conclusions but keeps evidence", () => {
		const delivery = sampleDelivery({
			codeVersion: { version: "v1", changedFiles: ["x.ts"] },
			authorConclusions: ["Ship it"],
		});
		const projected = projectChildDeliveryForReviewer(delivery);
		expect(projected.authorConclusions).toBeUndefined();
		expect(projected.acceptanceProven).toEqual(delivery.acceptanceProven);
		expect(projected.codeVersion).toEqual(delivery.codeVersion);
		expect(projected.checksNotRun).toEqual(delivery.checksNotRun);
	});
});
