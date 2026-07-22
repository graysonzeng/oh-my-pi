import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Verifier } from "../../src/workflow/verifier";

describe("Verifier", () => {
	let artifactDir: string;
	let verifier: Verifier;

	beforeEach(async () => {
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-verifier-"));
		verifier = new Verifier(process.cwd(), artifactDir);
	});

	afterEach(async () => {
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("executes an allowed command", async () => {
		const result = await verifier.verify({ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify" }, [
			'echo "test"',
		]);
		expect(result.passed).toBe(true);
		expect(result.checks[0]).toMatchObject({ status: "passed", exitCode: 0 });
	});

	it("detects changed files inside forbidden paths", async () => {
		const result = await verifier.verify(
			{
				workflowId: "wf1",
				attemptId: "att1",
				stage: "implementation_verify",
				changedFiles: ["forbidden/file.ts"],
			},
			[],
			["forbidden"],
		);
		expect(result.passed).toBe(false);
	});

	it("rejects unsafe shell syntax", async () => {
		const result = await verifier.verify({ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify" }, [
			"echo ok; echo unsafe",
		]);
		expect(result.checks[0]).toMatchObject({ status: "failed", summary: "Command rejected by verification policy" });
	});
});
