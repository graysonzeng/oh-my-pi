/**
 * Scope adherence metrics from actual git diff + plan/benchmark allowlist.
 * Forbidden writes hard-fail; unplanned files warn; interaction metrics null when unknown.
 */

import { $ } from "bun";
import { sha256Hex } from "./optimization-receipt";
import type { PlanArtifactV1 } from "./types";

export const SCOPE_METRICS_VERSION = 1 as const;
export const SCOPE_METRICS_KIND = "scope_metrics" as const;

export type ScopeStatus = "pass" | "warning" | "hard_fail";

export interface ScopeCreepFinding {
	path: string;
	severity: "warning" | "hard_fail";
	reason: "unplanned" | "forbidden" | "readonly_write" | "deleted_unplanned";
}

export interface ScopeMetricsV1 {
	schemaVersion: typeof SCOPE_METRICS_VERSION;
	kind: typeof SCOPE_METRICS_KIND;
	plannedFiles: string[];
	changedFiles: string[];
	unplannedFiles: string[];
	forbiddenFiles: string[];
	deletedFiles: string[];
	/** Insertions + deletions from git diff --numstat when available. */
	diffLines: { insertions: number; deletions: number } | null;
	touchedPackages: string[];
	scopeCreepFindings: ScopeCreepFinding[];
	/** null when no interactive user session (e.g. unattended benchmark). */
	userCorrections: number | null;
	userRollbacks: number | null;
	status: ScopeStatus;
	contentFingerprint: string;
}

export interface ScopeMetricsInput {
	/** Paths allowed by plan / benchmark allowlist (normalized relative). */
	plannedFiles: string[];
	/** Paths that must never be written. */
	forbiddenFiles?: string[];
	/** Actual changed paths from git (or injected for tests). */
	changedFiles: string[];
	deletedFiles?: string[];
	diffLines?: { insertions: number; deletions: number } | null;
	/** When false/undefined, corrections/rollbacks stay null. */
	interactive?: boolean;
	userCorrections?: number | null;
	userRollbacks?: number | null;
	/** Repo root prefixes used to derive touched packages (e.g. packages/). */
	packageRoots?: string[];
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function packageOf(path: string, roots: string[]): string | null {
	const n = normalizePath(path);
	for (const root of roots) {
		const r = normalizePath(root).replace(/\/$/, "");
		if (n.startsWith(`${r}/`)) {
			const rest = n.slice(r.length + 1);
			const pkg = rest.split("/")[0];
			return pkg ? `${r}/${pkg}` : r;
		}
	}
	// monorepo convention packages/<name>/
	const m = n.match(/^(packages\/[^/]+)/);
	return m?.[1] ?? null;
}

/** Pure builder — inject git results for tests. */
export function buildScopeMetrics(input: ScopeMetricsInput): ScopeMetricsV1 {
	const planned = [...new Set(input.plannedFiles.map(normalizePath))].sort();
	const plannedSet = new Set(planned);
	const forbidden = [...new Set((input.forbiddenFiles ?? []).map(normalizePath))].sort();
	const forbiddenSet = new Set(forbidden);
	const changed = [...new Set(input.changedFiles.map(normalizePath))].sort();
	const deleted = [...new Set((input.deletedFiles ?? []).map(normalizePath))].sort();

	const unplannedFiles = changed.filter(f => !plannedSet.has(f) && !forbiddenSet.has(f));
	const forbiddenHits = changed.filter(f => forbiddenSet.has(f));
	const deletedUnplanned = deleted.filter(f => !plannedSet.has(f));

	const findings: ScopeCreepFinding[] = [];
	for (const path of forbiddenHits) {
		findings.push({ path, severity: "hard_fail", reason: "forbidden" });
	}
	for (const path of unplannedFiles) {
		findings.push({ path, severity: "warning", reason: "unplanned" });
	}
	for (const path of deletedUnplanned) {
		findings.push({ path, severity: "warning", reason: "deleted_unplanned" });
	}

	let status: ScopeStatus = "pass";
	if (findings.some(f => f.severity === "hard_fail")) status = "hard_fail";
	else if (findings.length > 0) status = "warning";

	const packageRoots = input.packageRoots ?? ["packages"];
	const touchedPackages = [
		...new Set(changed.map(p => packageOf(p, packageRoots)).filter((p): p is string => Boolean(p))),
	].sort();

	const interactive = input.interactive === true;
	const userCorrections = interactive ? (input.userCorrections ?? 0) : null;
	const userRollbacks = interactive ? (input.userRollbacks ?? 0) : null;

	const metrics: ScopeMetricsV1 = {
		schemaVersion: SCOPE_METRICS_VERSION,
		kind: SCOPE_METRICS_KIND,
		plannedFiles: planned,
		changedFiles: changed,
		unplannedFiles,
		forbiddenFiles: forbiddenHits,
		deletedFiles: deleted,
		diffLines: input.diffLines ?? null,
		touchedPackages,
		scopeCreepFindings: findings.sort((a, b) => a.path.localeCompare(b.path)),
		userCorrections,
		userRollbacks,
		status,
		contentFingerprint: "",
	};
	metrics.contentFingerprint = sha256Hex(
		JSON.stringify({
			planned: metrics.plannedFiles,
			changed: metrics.changedFiles,
			unplanned: metrics.unplannedFiles,
			forbidden: metrics.forbiddenFiles,
			deleted: metrics.deletedFiles,
			status: metrics.status,
			findings: metrics.scopeCreepFindings,
		}),
	);
	return metrics;
}

/** Derive planned paths from a plan artifact. */
export function plannedFilesFromPlan(plan: PlanArtifactV1): string[] {
	return plan.affectedFiles.map(f => normalizePath(f.path));
}

export interface CollectGitScopeOptions {
	cwd: string;
	/** Diff base (default HEAD for unstaged+staged working tree via status). */
	baseRef?: string;
	plannedFiles: string[];
	forbiddenFiles?: string[];
	interactive?: boolean;
}

/**
 * Collect changed/deleted files via git in an isolated worktree.
 * Uses Bun shell APIs only (no ad-hoc node child_process).
 */
export async function collectScopeMetricsFromGit(options: CollectGitScopeOptions): Promise<ScopeMetricsV1> {
	const cwd = options.cwd;
	const baseRef = options.baseRef ?? "HEAD";

	const nameStatus = await $`git diff --name-status ${baseRef}`.cwd(cwd).quiet().nothrow();
	const staged = await $`git diff --name-status --cached`.cwd(cwd).quiet().nothrow();
	const untracked = await $`git ls-files --others --exclude-standard`.cwd(cwd).quiet().nothrow();
	const numstat = await $`git diff --numstat ${baseRef}`.cwd(cwd).quiet().nothrow();

	const changed = new Set<string>();
	const deleted = new Set<string>();

	const parseNameStatus = (text: string) => {
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const parts = trimmed.split(/\t+/);
			const code = parts[0] ?? "";
			const pathA = parts[1];
			const pathB = parts[2];
			if (!pathA) continue;
			if (code.startsWith("D")) {
				deleted.add(normalizePath(pathA));
				changed.add(normalizePath(pathA));
			} else if (code.startsWith("R") && pathB) {
				deleted.add(normalizePath(pathA));
				changed.add(normalizePath(pathB));
			} else {
				changed.add(normalizePath(pathA));
			}
		}
	};

	if (nameStatus.exitCode === 0) parseNameStatus(nameStatus.text());
	if (staged.exitCode === 0) parseNameStatus(staged.text());
	if (untracked.exitCode === 0) {
		for (const line of untracked.text().split("\n")) {
			const p = line.trim();
			if (p) changed.add(normalizePath(p));
		}
	}

	let diffLines: { insertions: number; deletions: number } | null = null;
	if (numstat.exitCode === 0) {
		let ins = 0;
		let del = 0;
		for (const line of numstat.text().split("\n")) {
			const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t/);
			if (!m) continue;
			if (m[1] !== "-") ins += Number(m[1]);
			if (m[2] !== "-") del += Number(m[2]);
		}
		diffLines = { insertions: ins, deletions: del };
	}

	return buildScopeMetrics({
		plannedFiles: options.plannedFiles,
		forbiddenFiles: options.forbiddenFiles,
		changedFiles: [...changed],
		deletedFiles: [...deleted],
		diffLines,
		interactive: options.interactive,
	});
}
