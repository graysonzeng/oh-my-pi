/**
 * P0: workflow saveRaw must produce recoverable artifact:// URIs and never
 * overwrite existing session artifacts on resume.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveArtifactFile } from "../../src/internal-urls/artifact-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { ArtifactManager } from "../../src/session/artifacts";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { prepareWorkflowInvocation } from "../../src/workflow/runtime-invocation";
import type { WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession } from "./helpers";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-save-raw-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
});

const lossyToolStrategy = {
	outputTruncation: {
		enabled: true as const,
		rules: [{ toolName: "bash", strategy: "head" as const, maxBytes: 120, maxLines: 5 }],
	},
};

function requestWithArtifacts(session: ReturnType<typeof fakeSession>): WorkflowAgentRequest {
	return {
		workflowId: "wf_save_raw",
		attemptId: "att_1",
		role: "implementer",
		profile: {
			...DEFAULT_MODEL_PROFILES.grok_implementer,
			toolStrategy: lossyToolStrategy,
		},
		assignment: "recover artifacts",
		session,
	};
}

function extractArtifactId(uri: string | undefined): string {
	expect(uri).toMatch(/^artifact:\/\/\d+$/);
	return uri!.replace("artifact://", "");
}

describe("saveRaw artifact recoverability (P0)", () => {
	it("writes full text and resolves artifact://id to identical content", async () => {
		const dir = makeTmpDir();
		const manager = new ArtifactManager(dir);
		const session = fakeSession({
			getArtifactManager: () => manager,
			getArtifactsDir: () => dir,
		});
		const prepared = prepareWorkflowInvocation(requestWithArtifacts(session));
		const fullText = `${"noise line\n".repeat(80)}ERROR: compile failed\nunique-payload-αβγ`;

		const detailed = prepared.processToolResultDetailed("bash", fullText, { exitCode: 1 });
		const id = extractArtifactId(detailed.receipt?.recoveryUri);
		expect(detailed.text).toContain(`[raw output: artifact://${id}]`);
		expect(detailed.receipt?.reversible).toBe(true);

		const resolved = await resolveArtifactFile(parseInternalUrl(`artifact://${id}`), {
			localProtocolOptions: { getArtifactsDir: () => dir },
		});
		const recovered = await Bun.file(resolved.path).text();
		expect(recovered).toBe(fullText);
	});

	it("does not overwrite pre-existing 0.*.log after resume (nextId still 0)", async () => {
		const dir = makeTmpDir();
		const existingBody = "PREEXISTING_ARTIFACT_V0";
		fs.writeFileSync(path.join(dir, "0.bash.log"), existingBody, "utf-8");

		// Fresh manager mirrors resume: #nextId starts at 0, disk already has 0.bash.log.
		const manager = new ArtifactManager(dir);
		expect(manager.allocateId()).toBe(0); // prove counter is still naive; re-seed below
		// Reset by using a new manager (allocateId advanced the first one).
		const resumeManager = new ArtifactManager(dir);
		const session = fakeSession({
			getArtifactManager: () => resumeManager,
			getArtifactsDir: () => dir,
		});
		const prepared = prepareWorkflowInvocation(requestWithArtifacts(session));
		const fullText = `${"x".repeat(400)}\nERROR: boom\n`;

		const detailed = prepared.processToolResultDetailed("bash", fullText, { exitCode: 1 });
		const id = extractArtifactId(detailed.receipt?.recoveryUri);
		expect(id).not.toBe("0");
		expect(fs.readFileSync(path.join(dir, "0.bash.log"), "utf-8")).toBe(existingBody);

		const newFiles = fs.readdirSync(dir).filter(f => f.startsWith(`${id}.`));
		expect(newFiles.length).toBe(1);
		expect(fs.readFileSync(path.join(dir, newFiles[0]), "utf-8")).toBe(fullText);
	});

	it("fallback without getArtifactManager still yields numeric artifact:// id", async () => {
		const dir = makeTmpDir();
		fs.writeFileSync(path.join(dir, "0.tool.log"), "old", "utf-8");
		const session = fakeSession({
			getArtifactsDir: () => dir,
			// intentionally no getArtifactManager
		});
		const prepared = prepareWorkflowInvocation(requestWithArtifacts(session));
		const fullText = `${"line\n".repeat(100)}FAIL\n`;

		const detailed = prepared.processToolResultDetailed("bash", fullText, { exitCode: 2 });
		const id = extractArtifactId(detailed.receipt?.recoveryUri);
		expect(/^\d+$/.test(id)).toBe(true);
		expect(id).not.toBe("0");
		expect(detailed.receipt?.reversible).toBe(true);

		// Non-numeric ids must never appear (old wf-… fallback).
		expect(detailed.text).not.toMatch(/artifact:\/\/wf-/);

		const resolved = await resolveArtifactFile(parseInternalUrl(`artifact://${id}`), {
			localProtocolOptions: { getArtifactsDir: () => dir },
		});
		expect(await Bun.file(resolved.path).text()).toBe(fullText);
		expect(fs.readFileSync(path.join(dir, "0.tool.log"), "utf-8")).toBe("old");
	});

	it("missing artifacts dir returns undefined recovery (no fake URI)", () => {
		const session = fakeSession({
			// neither getArtifactManager nor getArtifactsDir
		});
		const prepared = prepareWorkflowInvocation(requestWithArtifacts(session));
		const fullText = `${"y".repeat(500)}\nERROR\n`;
		const detailed = prepared.processToolResultDetailed("bash", fullText, { exitCode: 1 });
		expect(detailed.text).not.toMatch(/artifact:\/\//);
		expect(detailed.receipt?.recoveryUri).toBeUndefined();
		expect(detailed.receipt?.reversible).toBe(false);
	});
});
