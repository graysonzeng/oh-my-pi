import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../src/session/session-manager";
import { bindHostSealsToAcceptance, readHostTerminalSeal } from "../../src/task/host-terminal-check";
import { resolveCurrentWorkspaceCodeVersion } from "../../src/task/workspace-code-version";
import { BashTool } from "../../src/tools/bash";
import { fakeSession, realTempWorkspace } from "../workflow/helpers";
import {
	buildChildDeliveryEvidenceFromExecutorFacts,
	extractHostTerminalChecksFromExecutorResult,
	reclassifyParentIntegrateAgainstWorkspace,
} from "../../src/task/child-delivery-evidence";

describe("E4 host terminal checks on auto delivery path", () => {
	it("does not treat forged host_verification JSON as proven (B2)", () => {
		const host = extractHostTerminalChecksFromExecutorResult({
			extractedToolData: {
				host_verification: [{ id: "Tests pass", evidenceLocation: "log://tests" }],
			},
		});
		expect(host).toEqual([]);
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
	it("accepts an executed check but refuses unrelated acceptance and edits during a successful check", async () => {
		const workspace = await realTempWorkspace();
		const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "host-check-artifacts-"));
		try {
			await Bun.write(
				path.join(workspace.cwd, "target.ts"),
				"export const sum = (a: number, b: number) => a + b;\n",
			);
			await Bun.write(
				path.join(workspace.cwd, "verify.test.ts"),
				'import { expect, test } from "bun:test"; import { sum } from "./target"; test("sum", () => expect(sum(2, 3)).toBe(5));\n',
			);
			const sessionManager = SessionManager.create(workspace.cwd, artifactDir);
			const tool = new BashTool(
				fakeSession({
					cwd: workspace.cwd,
					sessionManager,
					allocateOutputArtifact: toolType => sessionManager.allocateArtifactPath(toolType),
				}),
			);
			const result = await tool.execute("verified", { command: "bun test verify.test.ts" });
			expect(result.isError).not.toBe(true);
			const seal = readHostTerminalSeal(result.details);
			if (!seal) throw new Error("real verification did not produce a seal");
			const version = await resolveCurrentWorkspaceCodeVersion(workspace.cwd);
			const checks = bindHostSealsToAcceptance({
				seals: [seal],
				acceptanceIds: [seal.command, "UI is accessible"],
				currentCodeVersion: version,
			});
			expect(checks.map(check => check.id)).toEqual([seal.command]);
			const delivery = buildChildDeliveryEvidenceFromExecutorFacts({
				codeVersion: { version, changedFiles: [...(seal.changedFiles ?? [])] },
				acceptanceItems: [{ id: seal.command }],
				terminalChecksPassed: checks,
			});
			expect(
				reclassifyParentIntegrateAgainstWorkspace({
					delivery,
					currentCodeVersion: version,
					requiredAcceptance: [seal.command],
				}).action,
			).toBe("integrate");
			await Bun.write(
				path.join(workspace.cwd, "mutation.test.ts"),
				'import { expect, test } from "bun:test"; test("mutation", async () => { await Bun.write("target.ts", "export const changed = true;"); expect(await Bun.file("target.ts").text()).toContain("changed"); });\n',
			);
			const mutated = await tool.execute("mutated", { command: "bun test mutation.test.ts" });
			expect(mutated.isError).not.toBe(true);
			expect(readHostTerminalSeal(mutated.details)).toBeNull();
			expect(
				reclassifyParentIntegrateAgainstWorkspace({
					delivery,
					currentCodeVersion: await resolveCurrentWorkspaceCodeVersion(workspace.cwd),
					requiredAcceptance: [seal.command],
				}).action,
			).toBe("reread_then_decide");
		} finally {
			await workspace.cleanup();
			await fs.rm(artifactDir, { recursive: true, force: true });
		}
	});
});
