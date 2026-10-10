/**
 * Batch 1 thin-orchestration — F3 acceptance contract + scope unknown + parent_verification_required.
 */
import { describe, expect, it } from "bun:test";
import {
	buildAcceptanceContractFromCriteria,
	criteriaBoundToCommand,
	normalizeAcceptanceCriteria,
} from "../../src/workflow/acceptance-contract";
import {
	buildChildDeliveryEvidenceFromExecutorFacts,
	classifyParentIntegrate,
} from "../../src/task/child-delivery-evidence";
import {
	bindHostSealsToAcceptance,
	classifyFilesAgainstScope,
	rememberHostTerminalSealForTests,
	type HostTerminalSeal,
} from "../../src/task/host-terminal-check";
import { buildLayeredVerificationPlan } from "../../src/workflow/layered-verification";
import { buildVerificationCodeState } from "../../src/workflow/verification-validity";

describe("F3 acceptance criterion mapping", () => {
	it("normalizes string criteria into criterionId/description/verification/evidenceRefs", () => {
		const criteria = normalizeAcceptanceCriteria(["Types compile", "Manual QA"]);
		expect(criteria).toEqual([
			{
				criterionId: "Types compile",
				description: "Types compile",
				verification: "manual",
				evidenceRefs: [],
			},
			{
				criterionId: "Manual QA",
				description: "Manual QA",
				verification: "manual",
				evidenceRefs: [],
			},
		]);
		const contract = buildAcceptanceContractFromCriteria([
			{
				criterionId: "ac-types",
				description: "Types compile",
				verification: "command-check",
				evidenceRefs: ["bun test"],
			},
		]);
		expect(contract?.items).toEqual(["ac-types"]);
		expect(contract?.criteria?.[0]?.verification).toBe("command-check");
		expect(criteriaBoundToCommand(contract!.criteria!, "bun test")).toHaveLength(1);
		expect(criteriaBoundToCommand(contract!.criteria!, "bun run check")).toHaveLength(0);
	});

	it("command seals prove only explicitly bound command-check criteria", () => {
		const seal: HostTerminalSeal = {
			id: "bun test",
			command: "bun test",
			cwd: "/tmp",
			codeVersion: "content:abc",
			evidenceLocation: "log://bun-test",
			executor: "host_bash",
			trustId: "trust-f3-1",
		};
		rememberHostTerminalSealForTests(seal);

		const bound = bindHostSealsToAcceptance({
			seals: [seal],
			acceptanceIds: ["ac-types", "UI looks good"],
			currentCodeVersion: "content:abc",
			criteria: [
				{
					criterionId: "ac-types",
					description: "Unit tests",
					verification: "command-check",
					evidenceRefs: ["bun test"],
				},
				{
					criterionId: "UI looks good",
					description: "UI looks good",
					verification: "manual",
					evidenceRefs: [],
				},
			],
		});
		expect(bound.map(b => b.id)).toEqual(["ac-types"]);
	});

	it("legacy path requires command equality — seal.id alone does not invent a bind", () => {
		const seal: HostTerminalSeal = {
			id: "Types compile",
			command: "bun test",
			cwd: "/tmp",
			codeVersion: "content:abc",
			evidenceLocation: "log://bun-test",
			executor: "host_bash",
			trustId: "trust-f3-2",
		};
		rememberHostTerminalSealForTests(seal);
		const unbound = bindHostSealsToAcceptance({
			seals: [seal],
			acceptanceIds: ["Types compile"],
			currentCodeVersion: "content:abc",
		});
		expect(unbound).toEqual([]);
		const bound = bindHostSealsToAcceptance({
			seals: [seal],
			acceptanceIds: ["bun test"],
			currentCodeVersion: "content:abc",
		});
		expect(bound.map(b => b.id)).toEqual(["bun test"]);
	});

	it("empty scope is unknown — not proven in-scope", () => {
		expect(classifyFilesAgainstScope(["src/a.ts"], undefined)).toBe("unknown");
		expect(classifyFilesAgainstScope(["src/a.ts"], [])).toBe("unknown");
		expect(classifyFilesAgainstScope(["src/a.ts"], ["src"])).toBe("inside");
		expect(classifyFilesAgainstScope(["other/a.ts"], ["src"])).toBe("outside");
	});

	it("parent_owns_verify uses parent_verification_required — not cross_module", () => {
		const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "v1", changedFiles: ["a.ts"] },
			acceptanceItems: [{ id: "Tests pass", claimedProven: false }],
			checksNotRun: [{ id: "parent_acceptance", reason: "parent owns final acceptance" }],
			writeOwnershipReleased: true,
		});
		const decision = classifyParentIntegrate({
			delivery,
			requiredAcceptance: ["Tests pass"],
		});
		expect(decision.classification).toBe("parent_verification_required");
		expect(decision.action).toBe("parent_coordinate");
		expect(decision.reasons).toContain("parent_owns_verify");
	});

	it("scope_unknown classification is distinct from cross_module", () => {
		const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
			codeVersion: { version: "v1", changedFiles: ["a.ts"] },
			acceptanceItems: [{ id: "ok", claimedProven: true, evidenceLocations: ["a.ts"] }],
			writeOwnershipReleased: true,
		});
		const decision = classifyParentIntegrate({
			delivery,
			requiredAcceptance: ["ok"],
			scopeBoundary: "unknown",
		});
		expect(decision.classification).toBe("scope_unknown");
		expect(decision.action).toBe("parent_coordinate");
	});

	it("layered verify skips slice work for parent_verification_required", () => {
		const plan = buildLayeredVerificationPlan({
			layer: "slice_local",
			commands: ["bun test"],
			codeState: buildVerificationCodeState({
				implementation: { attemptId: "impl-1" },
				patchContent: "diff --git a/src/a.ts\n+hi\n",
				changedFiles: ["src/a.ts"],
				workspace: {
					cwd: "/repo",
					vcs: "git",
					root: "/repo",
					headId: "abc123",
					contentSha256: "a".repeat(64),
				},
			}),
			parentOwnsVerify: false,
			parentClassification: "parent_verification_required",
		});
		expect(plan.skipped[0]?.reason).toBe("parent_verification_required");
	});
});
