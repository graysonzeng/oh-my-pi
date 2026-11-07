import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { changedFilesFromPatch, ImplementationVerifyStage } from "../../src/workflow/stages/implementation-verify";
import type { VerifierPort } from "../../src/workflow/types";
import { implArtifact } from "./helpers";

describe("ImplementationVerifyStage patch content", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-impl-verify-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("reads real patch content from disk and passes it to the verifier", async () => {
		const patchPath = path.join(dir, "change.patch");
		const secretPatch = "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+const x = 1\n";
		await Bun.write(patchPath, secretPatch);

		let seenPatch: string | undefined;
		let seenFiles: string[] | undefined;
		const verifier: VerifierPort = {
			async verify(artifact) {
				seenPatch = artifact.patchContent;
				seenFiles = artifact.changedFiles;
				return {
					kind: "verification",
					passed: true,
					checks: [],
					schemaVersion: 1,
					workflowId: artifact.workflowId,
					attemptId: artifact.attemptId,
					stage: artifact.stage,
					createdAt: new Date().toISOString(),
				};
			},
		};

		const stage = new ImplementationVerifyStage(verifier);
		await stage.execute({
			workflowId: "wf1",
			attemptId: "a1",
			implementation: implArtifact({
				patchPath,
				changedFiles: [],
			}),
			commands: [],
			cwd: dir,
		});
		expect(seenPatch).toBe(secretPatch);
		expect(seenFiles).toContain("src/a.ts");
	});

	it("changedFilesFromPatch extracts paths from unified diffs", () => {
		const files = changedFilesFromPatch("diff --git a/foo.ts b/foo.ts\n+++ b/foo.ts\n+hi\n");
		expect(files).toContain("foo.ts");
	});

	it("decodes quoted spaces and UTF-8 octal paths from Git patches", () => {
		const patch = [
			'diff --git "a/src/with space.ts" "b/src/with space.ts"',
			'+++ "b/src/with space.ts"',
			'diff --git "a/src/\\344\\275\\240\\345\\245\\275.ts" "b/src/\\344\\275\\240\\345\\245\\275.ts"',
			'+++ "b/src/\\344\\275\\240\\345\\245\\275.ts"',
		].join("\n");
		expect(changedFilesFromPatch(patch)).toEqual(["src/with space.ts", "src/你好.ts"]);
	});

	it("reports only the destination for copy-only patches while preserving rename endpoints", () => {
		const patch = [
			"diff --git a/src/template.ts b/src/template-copy.ts",
			"similarity index 100%",
			"copy from src/template.ts",
			"copy to src/template-copy.ts",
			"diff --git a/src/old.ts b/src/new.ts",
			"similarity index 100%",
			"rename from src/old.ts",
			"rename to src/new.ts",
		].join("\n");

		expect(changedFilesFromPatch(patch)).toEqual(["src/template-copy.ts", "src/old.ts", "src/new.ts"]);
	});

	it("preserves literal a and b directory prefixes from copy extension headers", () => {
		const patch = [
			"diff --git a/src/template.ts b/a/template-copy.ts",
			"similarity index 100%",
			"copy from src/template.ts",
			"copy to a/template-copy.ts",
		].join("\n");

		expect(changedFilesFromPatch(patch)).toEqual(["a/template-copy.ts"]);
	});

	it("does not parse hunk body lines that resemble file headers as paths", () => {
		const patch = [
			"diff --git a/src/note.md b/src/note.md",
			"--- a/src/note.md",
			"+++ b/src/note.md",
			"@@ -1 +1 @@",
			"--- note",
			"+++ note",
		].join("\n");

		expect(changedFilesFromPatch(patch)).toEqual(["src/note.md"]);
	});

	it("fails closed when branch mode has no readable patch evidence", async () => {
		let verifyCalls = 0;
		const verifier: VerifierPort = {
			async verify() {
				verifyCalls += 1;
				return {
					kind: "verification",
					passed: true,
					checks: [],
					schemaVersion: 1,
					workflowId: "wf1",
					attemptId: "a1",
					stage: "implementation_verify",
					createdAt: new Date().toISOString(),
				};
			},
		};

		const stage = new ImplementationVerifyStage(verifier);
		const result = await stage.execute({
			workflowId: "wf1",
			attemptId: "a1",
			implementation: implArtifact({
				patchPath: undefined,
				branchName: "wf/branch-only",
				changedFiles: ["src/model-reported-only.ts"],
			}),
			commands: [],
			cwd: dir,
		});

		expect(result.passed).toBe(false);
		expect(result.checks[0]?.id).toBe("isolation-artifact");
		expect(verifyCalls).toBe(0);
	});
});
