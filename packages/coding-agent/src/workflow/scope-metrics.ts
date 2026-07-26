/**
 * Scope adherence metrics from actual git diff + plan/benchmark allowlist.
 * Forbidden / readonly writes hard-violate; unplanned files warn; git failure → indeterminate.
 * Actual paths come only from git (or patch filesystem evidence) — never model self-report alone.
 */

import { $ } from "bun";
import { sha256Hex } from "./optimization-receipt";
import type { PlanArtifactV1 } from "./types";

export const SCOPE_METRICS_VERSION = 1 as const;
export const SCOPE_METRICS_KIND = "scope_metrics" as const;

/** Canonical status vocabulary (OBJECTIVE + git-fail degradation). */
export type ScopeStatus = "adhered" | "warning" | "violation" | "indeterminate";

/** Legacy aliases still accepted on dual-read surfaces (benchmark quality gate). */
export type ScopeStatusLegacy = "pass" | "hard_fail";

export type ScopeStatusAny = ScopeStatus | ScopeStatusLegacy;

export interface ScopeCreepFinding {
	/** Path that drifted outside plan / policy. */
	file: string;
	/** Human-readable reason (includes heuristic guess for unplanned files). */
	reason: string;
	/** Machine severity for gates. */
	severity: "warning" | "violation";
	/** Machine reason code. */
	code: "unplanned" | "forbidden" | "readonly_write" | "deleted_unplanned";
}

export interface ScopeMetricsV1 {
	schemaVersion: typeof SCOPE_METRICS_VERSION;
	kind: typeof SCOPE_METRICS_KIND;
	plannedFiles: string[];
	changedFiles: string[];
	unplannedFiles: string[];
	forbiddenFiles: string[];
	deletedFiles: string[];
	/** Total diff lines (insertions + deletions) when known; null when unobserved. */
	diffLines: number | null;
	touchedPackages: string[];
	scopeCreepFindings: ScopeCreepFinding[];
	/** null when no interactive user session (e.g. unattended benchmark) — not 0. */
	userCorrections: number | null;
	userRollbacks: number | null;
	status: ScopeStatus;
	contentFingerprint: string;
	/** Optional note when status is indeterminate (e.g. git failed). */
	indeterminateReason?: string;
}

export interface ScopeMetricsInput {
	/** Paths allowed by plan / benchmark allowlist (normalized relative). */
	plannedFiles: string[];
	/** Paths that must never be written (exact or directory prefix). */
	forbiddenFiles?: string[];
	/** Paths marked readonly — write is hard violation. */
	readonlyFiles?: string[];
	/** Actual changed paths from git (or patch evidence; never model prose alone). */
	changedFiles: string[];
	deletedFiles?: string[];
	/** Total lines, or {insertions, deletions} which is summed. */
	diffLines?: number | { insertions: number; deletions: number } | null;
	/** When false/undefined, corrections/rollbacks stay null. */
	interactive?: boolean;
	userCorrections?: number | null;
	userRollbacks?: number | null;
	/** Repo root prefixes used to derive touched packages (e.g. packages/). */
	packageRoots?: string[];
	/**
	 * Force indeterminate status (git collection failed).
	 * When true, changed sets are not treated as adherence evidence.
	 */
	indeterminate?: boolean;
	indeterminateReason?: string;
}

export interface ParsedNameStatus {
	changedFiles: string[];
	deletedFiles: string[];
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Exact or directory-prefix match (tool-policy / verifier style). */
export function pathMatchesPrefixList(file: string, entries: string[]): boolean {
	const n = normalizePath(file);
	return entries.some(entry => {
		const candidate = normalizePath(entry).replace(/\/+$/, "");
		if (!candidate) return false;
		return n === candidate || n.startsWith(`${candidate}/`);
	});
}

/**
 * Heuristic guess for why an unplanned path appeared.
 * Used only for finding reason text — never upgrades severity to hard violation.
 */
export function guessUnplannedReason(file: string): string {
	const n = normalizePath(file);
	const base = n.split("/").pop() ?? n;
	if (/\.d\.ts$/i.test(base) || /\.types\.ts$/i.test(base) || /\.types\.tsx$/i.test(base)) {
		return "generated types";
	}
	if (
		/^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum)$/i.test(
			base,
		)
	) {
		return "dependency lockfile";
	}
	if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(base) || /_(test|spec)\.(go|py)$/i.test(base)) {
		return "test file";
	}
	return "unplanned change";
}

export function formatScopeCreepReason(file: string, code: ScopeCreepFinding["code"]): string {
	const n = normalizePath(file);
	switch (code) {
		case "forbidden":
			return `File ${n} modified but is forbidden; forbidden path`;
		case "readonly_write":
			return `File ${n} modified but is readonly; readonly write`;
		case "deleted_unplanned":
			return `File ${n} deleted but not in plan; unplanned deletion`;
		case "unplanned":
			return `File ${n} modified but not in plan; ${guessUnplannedReason(n)}`;
	}
}

/**
 * Parse `git diff --name-status` text (A/M/D/R/C and score-suffixed forms).
 * Pure — no I/O; unit-tested with mock lines.
 */
export function parseGitNameStatus(text: string): ParsedNameStatus {
	const changed = new Set<string>();
	const deleted = new Set<string>();

	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\t+/);
		const codeRaw = parts[0] ?? "";
		// Codes may include similarity score: R100, C075, etc.
		const code = codeRaw.charAt(0).toUpperCase();
		const pathA = parts[1];
		const pathB = parts[2];
		if (!pathA) continue;

		if (code === "D") {
			const p = normalizePath(pathA);
			deleted.add(p);
			changed.add(p);
		} else if (code === "R" && pathB) {
			// Rename: old removed, new present
			deleted.add(normalizePath(pathA));
			changed.add(normalizePath(pathB));
		} else if (code === "C" && pathB) {
			// Copy: source unchanged, destination is a change
			changed.add(normalizePath(pathB));
		} else if (code === "A" || code === "M" || code === "T" || code === "U") {
			changed.add(normalizePath(pathA));
		} else {
			// Unknown / X / etc. — treat pathA as changed if present
			changed.add(normalizePath(pathA));
		}
	}

	return {
		changedFiles: [...changed].sort(),
		deletedFiles: [...deleted].sort(),
	};
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
	// monorepo conventions
	const m = n.match(/^(packages|apps|crates|services|modules)\/[^/]+/);
	return m?.[0] ?? null;
}

/**
 * Infer package/module roots from changed paths without FS (pure).
 * Looks for monorepo segments and parent dirs that look like package roots.
 */
export function deriveTouchedPackages(changedFiles: string[], packageRoots: string[] = ["packages"]): string[] {
	const out = new Set<string>();
	for (const f of changedFiles) {
		const pkg = packageOf(f, packageRoots);
		if (pkg) out.add(pkg);
		// Marker-file heuristic: if path itself is package.json / go.mod / Cargo.toml, parent is package
		const n = normalizePath(f);
		const base = n.split("/").pop() ?? "";
		if (/^(package\.json|go\.mod|Cargo\.toml|pyproject\.toml|composer\.json)$/i.test(base)) {
			const parent = n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : ".";
			out.add(parent);
		}
	}
	return [...out].sort();
}

function normalizeDiffLines(diffLines: ScopeMetricsInput["diffLines"]): number | null {
	if (diffLines == null) return null;
	if (typeof diffLines === "number") return diffLines;
	return diffLines.insertions + diffLines.deletions;
}

/** Map legacy status tokens to canonical ScopeStatus. */
export function normalizeScopeStatus(status: ScopeStatusAny | string | null | undefined): ScopeStatus | null {
	if (status == null) return null;
	switch (status) {
		case "adhered":
		case "pass":
			return "adhered";
		case "warning":
			return "warning";
		case "violation":
		case "hard_fail":
			return "violation";
		case "indeterminate":
			return "indeterminate";
		default:
			return null;
	}
}

/** True when status is a hard quality-gate failure. */
export function isScopeHardViolation(status: ScopeStatusAny | string | null | undefined): boolean {
	return normalizeScopeStatus(status) === "violation";
}

/** Pure builder — inject git/patch results for tests. */
export function buildScopeMetrics(input: ScopeMetricsInput): ScopeMetricsV1 {
	if (input.indeterminate) {
		const planned = [...new Set(input.plannedFiles.map(normalizePath))].sort();
		const metrics: ScopeMetricsV1 = {
			schemaVersion: SCOPE_METRICS_VERSION,
			kind: SCOPE_METRICS_KIND,
			plannedFiles: planned,
			changedFiles: [],
			unplannedFiles: [],
			forbiddenFiles: [],
			deletedFiles: [],
			diffLines: null,
			touchedPackages: [],
			scopeCreepFindings: [],
			userCorrections: input.interactive === true ? (input.userCorrections ?? 0) : null,
			userRollbacks: input.interactive === true ? (input.userRollbacks ?? 0) : null,
			status: "indeterminate",
			contentFingerprint: "",
			indeterminateReason: input.indeterminateReason ?? "git collection failed",
		};
		metrics.contentFingerprint = sha256Hex(
			JSON.stringify({
				status: metrics.status,
				reason: metrics.indeterminateReason,
				planned: metrics.plannedFiles,
			}),
		);
		return metrics;
	}

	const planned = [...new Set(input.plannedFiles.map(normalizePath))].sort();
	const plannedSet = new Set(planned);
	const forbiddenEntries = [...new Set((input.forbiddenFiles ?? []).map(normalizePath))];
	const readonlyEntries = [...new Set((input.readonlyFiles ?? []).map(normalizePath))];
	const changed = [...new Set(input.changedFiles.map(normalizePath))].sort();
	const deleted = [...new Set((input.deletedFiles ?? []).map(normalizePath))].sort();

	const forbiddenHits = changed.filter(f => pathMatchesPrefixList(f, forbiddenEntries));
	const forbiddenSet = new Set(forbiddenHits);
	const readonlyHits = changed.filter(f => !forbiddenSet.has(f) && pathMatchesPrefixList(f, readonlyEntries));
	const readonlySet = new Set(readonlyHits);

	const unplannedFiles = changed.filter(f => !plannedSet.has(f) && !forbiddenSet.has(f) && !readonlySet.has(f));
	const deletedUnplanned = deleted.filter(f => !plannedSet.has(f) && !forbiddenSet.has(f));

	const findings: ScopeCreepFinding[] = [];
	for (const file of forbiddenHits) {
		findings.push({
			file,
			severity: "violation",
			code: "forbidden",
			reason: formatScopeCreepReason(file, "forbidden"),
		});
	}
	for (const file of readonlyHits) {
		findings.push({
			file,
			severity: "violation",
			code: "readonly_write",
			reason: formatScopeCreepReason(file, "readonly_write"),
		});
	}
	for (const file of unplannedFiles) {
		findings.push({
			file,
			severity: "warning",
			code: "unplanned",
			reason: formatScopeCreepReason(file, "unplanned"),
		});
	}
	for (const file of deletedUnplanned) {
		// Deleted unplanned that aren't already listed as unplanned in changed
		if (!unplannedFiles.includes(file) && !forbiddenSet.has(file)) {
			findings.push({
				file,
				severity: "warning",
				code: "deleted_unplanned",
				reason: formatScopeCreepReason(file, "deleted_unplanned"),
			});
		}
	}

	let status: ScopeStatus = "adhered";
	if (findings.some(f => f.severity === "violation")) status = "violation";
	else if (findings.length > 0) status = "warning";

	const packageRoots = input.packageRoots ?? ["packages", "apps", "crates", "services"];
	const touchedPackages = deriveTouchedPackages(changed, packageRoots);

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
		diffLines: normalizeDiffLines(input.diffLines),
		touchedPackages,
		scopeCreepFindings: findings.sort((a, b) => a.file.localeCompare(b.file)),
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

/** Merge plan affected files with optional benchmark/case allowlist. */
export function mergePlannedFiles(planFiles: string[], allowlist?: string[] | null): string[] {
	const set = new Set(planFiles.map(normalizePath));
	for (const p of allowlist ?? []) set.add(normalizePath(p));
	return [...set].sort();
}

export interface CollectGitScopeOptions {
	cwd: string;
	/** Diff base (default HEAD). */
	baseRef?: string;
	plannedFiles: string[];
	forbiddenFiles?: string[];
	readonlyFiles?: string[];
	interactive?: boolean;
	userCorrections?: number | null;
	userRollbacks?: number | null;
	packageRoots?: string[];
}

/**
 * Collect changed/deleted files via git in an isolated worktree.
 * Uses Bun shell APIs only. On total git failure returns status=indeterminate
 * (never invents paths from model self-report).
 */
export async function collectScopeMetricsFromGit(options: CollectGitScopeOptions): Promise<ScopeMetricsV1> {
	const cwd = options.cwd;
	const baseRef = options.baseRef ?? "HEAD";

	const nameStatus = await $`git diff --name-status ${baseRef}`.cwd(cwd).quiet().nothrow();
	const staged = await $`git diff --name-status --cached`.cwd(cwd).quiet().nothrow();
	const untracked = await $`git ls-files --others --exclude-standard`.cwd(cwd).quiet().nothrow();
	const numstat = await $`git diff --numstat ${baseRef}`.cwd(cwd).quiet().nothrow();

	const gitUsable = nameStatus.exitCode === 0 || staged.exitCode === 0 || untracked.exitCode === 0;

	if (!gitUsable) {
		const detail = [
			`diff=${nameStatus.exitCode}`,
			`staged=${staged.exitCode}`,
			`untracked=${untracked.exitCode}`,
		].join(" ");
		return buildScopeMetrics({
			plannedFiles: options.plannedFiles,
			forbiddenFiles: options.forbiddenFiles,
			readonlyFiles: options.readonlyFiles,
			changedFiles: [],
			indeterminate: true,
			indeterminateReason: `git collection failed (${detail})`,
			interactive: options.interactive,
			userCorrections: options.userCorrections,
			userRollbacks: options.userRollbacks,
		});
	}

	const changed = new Set<string>();
	const deleted = new Set<string>();

	const absorb = (parsed: ParsedNameStatus) => {
		for (const p of parsed.changedFiles) changed.add(p);
		for (const p of parsed.deletedFiles) deleted.add(p);
	};

	if (nameStatus.exitCode === 0) absorb(parseGitNameStatus(nameStatus.text()));
	if (staged.exitCode === 0) absorb(parseGitNameStatus(staged.text()));
	if (untracked.exitCode === 0) {
		for (const line of untracked.text().split("\n")) {
			const p = line.trim();
			if (p) changed.add(normalizePath(p));
		}
	}

	let diffLines: number | null = null;
	if (numstat.exitCode === 0) {
		let ins = 0;
		let del = 0;
		for (const line of numstat.text().split("\n")) {
			const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t/);
			if (!m) continue;
			if (m[1] !== "-") ins += Number(m[1]);
			if (m[2] !== "-") del += Number(m[2]);
		}
		diffLines = ins + del;
	}

	return buildScopeMetrics({
		plannedFiles: options.plannedFiles,
		forbiddenFiles: options.forbiddenFiles,
		readonlyFiles: options.readonlyFiles,
		changedFiles: [...changed],
		deletedFiles: [...deleted],
		diffLines,
		interactive: options.interactive,
		userCorrections: options.userCorrections,
		userRollbacks: options.userRollbacks,
		packageRoots: options.packageRoots,
	});
}
