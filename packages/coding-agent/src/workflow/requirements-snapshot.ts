/**
 * Engine-owned authoritative requirements snapshot for plan-review coverage gates.
 *
 * The planner-authored PlanArtifact is never the requirements authority. Snapshot is
 * derived from the frozen WorkflowRequest (and optional structured constraints) before
 * planning, persisted, injected into reviewer context, and used to reject incomplete
 * approved coverage.
 */

import { fingerprintStable, stableSerialize } from "../latency/stable-serialize";
import type {
	PlanReviewArtifactV2,
	RequirementCoverageV1,
	RequirementsSnapshotRequirementV1,
	RequirementsSnapshotV1,
	WorkflowRequest,
} from "./types";

export const REQUIREMENTS_SNAPSHOT_KIND = "requirements_snapshot" as const;
export const REQUIREMENTS_SNAPSHOT_VERSION = 1 as const;

export interface BuildRequirementsSnapshotInput {
	workflowId: string;
	request: WorkflowRequest | { request: string; constraints?: string };
	createdAt?: string;
}

export interface MandatoryCoverageGateResult {
	ok: boolean;
	reason?: string;
	missingRequirementIds: string[];
	hashMismatch: boolean;
}

/** Split constraints into stable, non-empty requirement texts (newline / bullet aware). */
export function splitConstraintTexts(constraints: string): string[] {
	const lines = constraints
		.split(/\r?\n/)
		.map(line => line.replace(/^\s*[-*•]\s+/, "").trim())
		.filter(Boolean);
	if (lines.length === 0) {
		const trimmed = constraints.trim();
		return trimmed ? [trimmed] : [];
	}
	// Collapse soft-wrapped continuations: keep each non-empty line as its own requirement
	// so IDs stay stable across trivial whitespace-only reformats of the same line set.
	return lines;
}

/**
 * Deterministic extraction of mandatory requirements from the workflow request.
 * IDs are slot-stable (not content-hashed) so coverage rows stay comparable across
 * replan cycles while the frozen snapshot text remains the authority.
 */
export function extractRequirementsFromRequest(
	request: WorkflowRequest | { request: string; constraints?: string },
): RequirementsSnapshotRequirementV1[] {
	const requirements: RequirementsSnapshotRequirementV1[] = [];
	const requestText = typeof request.request === "string" ? request.request.trim() : "";
	if (requestText) {
		requirements.push({
			requirementId: "user:req-001",
			source: "user_requirement",
			mandatory: true,
			text: requestText,
		});
	}

	const constraintsRaw = "constraints" in request && typeof request.constraints === "string" ? request.constraints : "";
	const constraintParts = splitConstraintTexts(constraintsRaw);
	constraintParts.forEach((text, index) => {
		requirements.push({
			requirementId: `user:constraint-${String(index + 1).padStart(3, "0")}`,
			source: "user_requirement",
			mandatory: true,
			text,
		});
	});

	return requirements;
}

/** Canonical bytes used for sha256 — excludes createdAt so rebuilds match resume. */
export function requirementsSnapshotFingerprintPayload(
	snapshot: Pick<RequirementsSnapshotV1, "schemaVersion" | "kind" | "workflowId" | "source" | "requirements">,
): string {
	return stableSerialize({
		schemaVersion: snapshot.schemaVersion,
		kind: snapshot.kind,
		workflowId: snapshot.workflowId,
		source: snapshot.source,
		requirements: snapshot.requirements,
	});
}

export function computeRequirementsSnapshotSha256(
	snapshot: Pick<RequirementsSnapshotV1, "schemaVersion" | "kind" | "workflowId" | "source" | "requirements">,
): string {
	return fingerprintStable({
		schemaVersion: snapshot.schemaVersion,
		kind: snapshot.kind,
		workflowId: snapshot.workflowId,
		source: snapshot.source,
		requirements: snapshot.requirements,
	});
}

export function buildRequirementsSnapshot(input: BuildRequirementsSnapshotInput): RequirementsSnapshotV1 {
	const requestText = typeof input.request.request === "string" ? input.request.request : String(input.request.request ?? "");
	const constraints =
		"constraints" in input.request && typeof input.request.constraints === "string"
			? input.request.constraints
			: null;
	const requirements = extractRequirementsFromRequest(input.request);
	const base = {
		schemaVersion: REQUIREMENTS_SNAPSHOT_VERSION,
		kind: REQUIREMENTS_SNAPSHOT_KIND,
		workflowId: input.workflowId,
		source: {
			request: requestText,
			constraints,
		},
		requirements,
	} as const;
	const sha256 = computeRequirementsSnapshotSha256(base);
	return {
		...base,
		createdAt: input.createdAt ?? new Date().toISOString(),
		sha256,
	};
}

/** Satisfied coverage rows for every mandatory requirement in a snapshot (test + fixture helper). */
export function satisfyMandatoryCoverage(snapshot: RequirementsSnapshotV1): RequirementCoverageV1[] {
	return snapshot.requirements
		.filter(req => req.mandatory)
		.map(req => ({
			requirementId: req.requirementId,
			source: req.source,
			mandatory: true,
			status: "satisfied" as const,
			evidenceRefs: [`snapshot:${req.requirementId}`],
			rationale: `covers ${req.requirementId}`,
		}));
}

/**
 * Full mandatory-coverage gate for `decision=approved`.
 * - Snapshot hash on the review must match the engine-owned frozen hash.
 * - Every mandatory snapshot ID must appear with status satisfied|not_applicable,
 *   non-empty rationale (schema) and non-empty evidenceRefs.
 */
export function validateApprovedMandatoryCoverage(
	review: PlanReviewArtifactV2,
	snapshot: RequirementsSnapshotV1,
): MandatoryCoverageGateResult {
	if (review.decision !== "approved") {
		return { ok: true, missingRequirementIds: [], hashMismatch: false };
	}

	if (review.requirementsSnapshotSha256 !== snapshot.sha256) {
		return {
			ok: false,
			reason: "requirements_snapshot_hash_mismatch",
			missingRequirementIds: [],
			hashMismatch: true,
		};
	}

	const coverageById = new Map<string, RequirementCoverageV1[]>();
	for (const row of review.coverage) {
		const list = coverageById.get(row.requirementId) ?? [];
		list.push(row);
		coverageById.set(row.requirementId, list);
	}

	const missingRequirementIds: string[] = [];
	for (const req of snapshot.requirements) {
		if (!req.mandatory) continue;
		const rows = coverageById.get(req.requirementId) ?? [];
		if (rows.length === 0) {
			missingRequirementIds.push(req.requirementId);
			continue;
		}
		const acceptable = rows.some(
			row =>
				(row.status === "satisfied" || row.status === "not_applicable") &&
				row.evidenceRefs.length > 0 &&
				row.rationale.trim().length > 0 &&
				row.mandatory === true,
		);
		const hasBlockingStatus = rows.some(
			row => row.status === "violated" || row.status === "missing_authority",
		);
		// Contradiction (satisfied+violated) is an arbitration trigger handled elsewhere;
		// still not a clean PASS for implement until arbitrator re-approves with clean coverage.
		if (!acceptable || hasBlockingStatus) {
			missingRequirementIds.push(req.requirementId);
		}
	}

	if (missingRequirementIds.length > 0) {
		return {
			ok: false,
			reason: "incomplete_mandatory_coverage",
			missingRequirementIds: [...new Set(missingRequirementIds)],
			hashMismatch: false,
		};
	}

	return { ok: true, missingRequirementIds: [], hashMismatch: false };
}

export function isRequirementsSnapshot(value: unknown): value is RequirementsSnapshotV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.kind === REQUIREMENTS_SNAPSHOT_KIND &&
		record.schemaVersion === REQUIREMENTS_SNAPSHOT_VERSION &&
		typeof record.workflowId === "string" &&
		typeof record.sha256 === "string" &&
		Array.isArray(record.requirements)
	);
}
