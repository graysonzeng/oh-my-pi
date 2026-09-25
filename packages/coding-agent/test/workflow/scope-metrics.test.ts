/**
 * Scope adherence metrics — pure parse/classify contracts + git-fail degradation.
 * Drives shipped parseGitNameStatus / buildScopeMetrics / collectScopeMetricsFromGit.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildScopeMetrics,
	collectScopeMetricsFromGit,
	formatScopeCreepReason,
	guessUnplannedReason,
	isScopeHardViolation,
	mergePlannedFiles,
	normalizeScopeStatus,
	parseGitNameStatus,
	pathMatchesPrefixList,
	plannedFilesFromPlan,
	SCOPE_METRICS_KIND,
} from "../../src/workflow/scope-metrics";
import type { PlanArtifactV1 } from "../../src/workflow/types";

function samplePlan(files: string[]): PlanArtifactV1 {
	return {
		schemaVersion: 1,
		workflowId: "wf",
		attemptId: "att",
		stage: "planning",
		createdAt: "2026-07-26T00:00:00.000Z",
		kind: "plan",
		summary: "test plan",
		assumptions: [],
		nonGoals: [],
		affectedFiles: files.map(p => ({ path: p, action: "modify" as const, reason: "planned" })),
		implementationSteps: [],
		acceptanceCriteria: [],
		verificationCommands: [],
		risks: [],
		rollback: [],
	};
}

describe("parseGitNameStatus", () => {
	it("parses A/M/D into changedFiles and deletedFiles", () => {
		const text = ["A\tsrc/new.ts", "M\tsrc/edit.ts", "D\tsrc/gone.ts"].join("\n");
		const parsed = parseGitNameStatus(text);
		expect(parsed.changedFiles).toEqual(["src/edit.ts", "src/gone.ts", "src/new.ts"]);
		expect(parsed.deletedFiles).toEqual(["src/gone.ts"]);
	});

	it("handles rename R and copy C (score-suffixed)", () => {
		const text = ["R100\told/name.ts\tnew/name.ts", "C075\tsrc/template.ts\tsrc/copy.ts"].join("\n");
		const parsed = parseGitNameStatus(text);
		expect(parsed.changedFiles).toContain("new/name.ts");
		expect(parsed.changedFiles).toContain("src/copy.ts");
		expect(parsed.changedFiles).not.toContain("old/name.ts");
		expect(parsed.deletedFiles).toContain("old/name.ts");
		// copy source is not deleted
		expect(parsed.deletedFiles).not.toContain("src/template.ts");
	});

	it("ignores empty lines and normalizes paths", () => {
		const parsed = parseGitNameStatus("\nM\t./src/a.ts\n\n");
		expect(parsed.changedFiles).toEqual(["src/a.ts"]);
	});
});

describe("pathMatchesPrefixList / forbidden detection", () => {
	it("matches directory prefix secrets/ against secrets/key.json", () => {
		expect(pathMatchesPrefixList("secrets/key.json", ["secrets/", ".env"])).toBe(true);
		expect(pathMatchesPrefixList("secrets/key.json", ["secrets"])).toBe(true);
		expect(pathMatchesPrefixList(".env", [".env"])).toBe(true);
		expect(pathMatchesPrefixList("src/a.ts", ["secrets/", ".env"])).toBe(false);
	});
});

describe("guessUnplannedReason heuristics", () => {
	it("classifies generated types, lockfiles, tests, and default", () => {
		expect(guessUnplannedReason("src/user.types.ts")).toBe("generated types");
		expect(guessUnplannedReason("src/foo.d.ts")).toBe("generated types");
		expect(guessUnplannedReason("package-lock.json")).toBe("dependency lockfile");
		expect(guessUnplannedReason("bun.lockb")).toBe("dependency lockfile");
		expect(guessUnplannedReason("src/user.test.ts")).toBe("test file");
		expect(guessUnplannedReason("src/user.spec.ts")).toBe("test file");
		expect(guessUnplannedReason("src/orphan.ts")).toBe("unplanned change");
	});

	it("formats reason template for unplanned files", () => {
		const reason = formatScopeCreepReason("src/user.types.ts", "unplanned");
		expect(reason).toBe("File src/user.types.ts modified but not in plan; generated types");
	});
});

describe("buildScopeMetrics classification", () => {
	it("marks adhered when all changed ⊆ planned and no forbidden", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["a.ts", "b.ts"],
			changedFiles: ["a.ts", "b.ts"],
			forbiddenFiles: ["secrets/"],
			interactive: false,
		});
		expect(metrics.status).toBe("adhered");
		expect(metrics.kind).toBe(SCOPE_METRICS_KIND);
		expect(metrics.unplannedFiles).toEqual([]);
		expect(metrics.forbiddenFiles).toEqual([]);
		expect(metrics.userCorrections).toBeNull();
		expect(metrics.userRollbacks).toBeNull();
	});

	it("computes unplannedFiles as changed − planned", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["a.ts", "b.ts"],
			changedFiles: ["a.ts", "b.ts", "c.ts"],
		});
		expect(metrics.unplannedFiles).toEqual(["c.ts"]);
		expect(metrics.status).toBe("warning");
		expect(metrics.scopeCreepFindings.some(f => f.file === "c.ts" && f.code === "unplanned")).toBe(true);
	});

	it("hard-violates forbidden prefix secrets/key.json", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["src/a.ts"],
			changedFiles: ["src/a.ts", "secrets/key.json"],
			forbiddenFiles: ["secrets/", ".env"],
		});
		expect(metrics.status).toBe("violation");
		expect(metrics.forbiddenFiles).toContain("secrets/key.json");
		expect(isScopeHardViolation(metrics.status)).toBe(true);
		const finding = metrics.scopeCreepFindings.find(f => f.file === "secrets/key.json");
		expect(finding?.severity).toBe("violation");
		expect(finding?.code).toBe("forbidden");
	});

	it("unplanned but generated types stays warning (not violation)", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["src/user.ts"],
			changedFiles: ["src/user.ts", "src/user.types.ts"],
			forbiddenFiles: ["secrets/"],
			interactive: false,
		});
		expect(metrics.status).toBe("warning");
		expect(metrics.status).not.toBe("violation");
		expect(metrics.unplannedFiles).toEqual(["src/user.types.ts"]);
		const finding = metrics.scopeCreepFindings.find(f => f.file === "src/user.types.ts");
		expect(finding?.reason).toContain("generated types");
		expect(finding?.severity).toBe("warning");
		expect(metrics.userCorrections).toBeNull();
		expect(metrics.userRollbacks).toBeNull();
	});

	it("readonly write is hard violation", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["src/a.ts"],
			changedFiles: ["src/a.ts", "docs/README.md"],
			readonlyFiles: ["docs/"],
		});
		expect(metrics.status).toBe("violation");
		expect(metrics.scopeCreepFindings.some(f => f.code === "readonly_write")).toBe(true);
	});

	it("tracks deleted files and unplanned deletions as warning", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["src/keep.ts"],
			changedFiles: ["src/keep.ts", "src/drop.ts"],
			deletedFiles: ["src/drop.ts"],
		});
		expect(metrics.deletedFiles).toContain("src/drop.ts");
		expect(metrics.unplannedFiles).toContain("src/drop.ts");
		expect(metrics.status).toBe("warning");
	});

	it("sums diffLines object into total number", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["a.ts"],
			changedFiles: ["a.ts"],
			diffLines: { insertions: 10, deletions: 2 },
		});
		expect(metrics.diffLines).toBe(12);
	});

	it("derives touchedPackages from monorepo paths", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["packages/coding-agent/src/a.ts"],
			changedFiles: ["packages/coding-agent/src/a.ts", "packages/utils/src/b.ts"],
		});
		expect(metrics.touchedPackages).toContain("packages/coding-agent");
		expect(metrics.touchedPackages).toContain("packages/utils");
	});

	it("interactive=false keeps corrections/rollbacks null (not 0)", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["a.ts"],
			changedFiles: ["a.ts"],
			interactive: false,
			userCorrections: 5,
			userRollbacks: 3,
		});
		expect(metrics.userCorrections).toBeNull();
		expect(metrics.userRollbacks).toBeNull();
	});

	it("interactive=true records corrections/rollbacks", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["a.ts"],
			changedFiles: ["a.ts"],
			interactive: true,
			userCorrections: 2,
			userRollbacks: 1,
		});
		expect(metrics.userCorrections).toBe(2);
		expect(metrics.userRollbacks).toBe(1);
	});

	it("indeterminate path clears changed evidence and does not use model files", () => {
		const metrics = buildScopeMetrics({
			plannedFiles: ["a.ts"],
			// Would-be model paths — ignored when indeterminate
			changedFiles: ["model-invented.ts"],
			indeterminate: true,
			indeterminateReason: "git collection failed",
			interactive: false,
		});
		expect(metrics.status).toBe("indeterminate");
		expect(metrics.changedFiles).toEqual([]);
		expect(metrics.unplannedFiles).toEqual([]);
		expect(metrics.userCorrections).toBeNull();
		expect(metrics.indeterminateReason).toMatch(/git/i);
	});

	it("same inputs yield same fingerprint", () => {
		const input = {
			plannedFiles: ["src/a.ts"],
			changedFiles: ["src/a.ts"],
			forbiddenFiles: ["package.json"],
		};
		expect(buildScopeMetrics(input).contentFingerprint).toBe(buildScopeMetrics(input).contentFingerprint);
	});

	it("merges plan affectedFiles with allowlist", () => {
		const plan = samplePlan(["src/a.ts"]);
		const planned = mergePlannedFiles(plannedFilesFromPlan(plan), ["src/b.ts", "test/a.test.ts"]);
		expect(planned).toEqual(["src/a.ts", "src/b.ts", "test/a.test.ts"]);
	});
});

describe("normalizeScopeStatus dual-read", () => {
	it("maps legacy pass/hard_fail to adhered/violation", () => {
		expect(normalizeScopeStatus("pass")).toBe("adhered");
		expect(normalizeScopeStatus("hard_fail")).toBe("violation");
		expect(normalizeScopeStatus("adhered")).toBe("adhered");
		expect(normalizeScopeStatus("violation")).toBe("violation");
		expect(isScopeHardViolation("hard_fail")).toBe(true);
		expect(isScopeHardViolation("warning")).toBe(false);
	});
});

describe("collectScopeMetricsFromGit failure → indeterminate", () => {
	let tmp: string | undefined;

	afterEach(async () => {
		if (tmp) {
			await fs.rm(tmp, { recursive: true, force: true });
			tmp = undefined;
		}
	});

	it("returns indeterminate when cwd is not a git repo (no model fallback)", async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scope-nogit-"));
		// Plain directory, no .git — all git commands fail
		const metrics = await collectScopeMetricsFromGit({
			cwd: tmp,
			plannedFiles: ["a.ts"],
			forbiddenFiles: ["secrets/"],
			interactive: false,
		});
		expect(metrics.status).toBe("indeterminate");
		expect(metrics.changedFiles).toEqual([]);
		// Must not invent paths
		expect(metrics.changedFiles).not.toContain("a.ts");
		expect(metrics.userCorrections).toBeNull();
		expect(metrics.userRollbacks).toBeNull();
	});

	it("collects real name-status from a micro worktree when git works", async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scope-git-"));
		const { $ } = await import("bun");
		await $`git init`.cwd(tmp).quiet();
		await $`git config user.email test@example.com`.cwd(tmp).quiet();
		await $`git config user.name test`.cwd(tmp).quiet();
		await Bun.write(path.join(tmp, "planned.ts"), "export const a = 1;\n");
		await $`git add planned.ts`.cwd(tmp).quiet();
		await $`git commit -m init`.cwd(tmp).quiet();
		await Bun.write(path.join(tmp, "planned.ts"), "export const a = 2;\n");
		await Bun.write(path.join(tmp, "extra.ts"), "export const e = 1;\n");
		await Bun.write(path.join(tmp, "secrets"), ""); // file named secrets — not prefix dir
		await fs.mkdir(path.join(tmp, "secrets-dir"), { recursive: true });
		// untracked extra.ts should appear via ls-files --others
		const metrics = await collectScopeMetricsFromGit({
			cwd: tmp,
			plannedFiles: ["planned.ts"],
			forbiddenFiles: ["secrets-dir/"],
			interactive: false,
		});
		// May be adhered/warning depending on tracked+untracked; must not be indeterminate
		expect(metrics.status).not.toBe("indeterminate");
		expect(metrics.changedFiles.length).toBeGreaterThan(0);
		expect(metrics.changedFiles).toContain("planned.ts");
		expect(metrics.changedFiles).toContain("extra.ts");
		expect(metrics.unplannedFiles).toContain("extra.ts");
		expect(metrics.status).toBe("warning");
	});
});
