import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
/**
 * Deterministic stage-boundary role-aware handoff from typed workflow artifacts.
 * Does not call a model; does not delete source artifacts.
 * Fingerprint compares canonical payload (stable sort; fixed field order).
 */

import { sha256Hex } from "./optimization-receipt";
import type {
	ImplementationArtifactV1,
	PlanArtifactV1,
	PlanReviewArtifact,
	ReviewArtifactV1,
	ReviewFindingV1,
	StageHandoffArtifactRef,
	StageHandoffItemKind,
	StageHandoffPreservedItem,
	StageHandoffV1,
	VerificationArtifactV1,
	WorkflowStatus,
} from "./types";

export const STAGE_HANDOFF_VERSION = 1 as const;
export const STAGE_HANDOFF_KIND = "stage_handoff" as const;
/** Hard cap for each preservedItem.summary (characters, not bytes). */
export const STAGE_HANDOFF_SUMMARY_MAX = 500;

export type StageHandoffEdge = "planner→implementer" | "implementer→reviewer" | "reviewer→repair";

export type { StageHandoffArtifactRef, StageHandoffItemKind, StageHandoffPreservedItem, StageHandoffV1 };

/** Display edge label for prompt section headers (stable, human-readable). */
export function stageHandoffEdge(fromStage: WorkflowStatus, toStage: WorkflowStatus): StageHandoffEdge | string {
	if (toStage === "implementing") return "planner→implementer";
	if (toStage === "code_review") return "implementer→reviewer";
	if (toStage === "repairing") return "reviewer→repair";
	return `${fromStage}→${toStage}`;
}

export function clampSummary(text: string, max = STAGE_HANDOFF_SUMMARY_MAX): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/** Synthetic unit-test scheme. Not a filesystem path the read tool can open. */
const SYNTHETIC_RECOVERY_PREFIX = "file://workflow-artifact/";

/** True for the unit-test scheme, never for an ArtifactStore file URL. */
export function isSyntheticRecoveryUri(uri: string): boolean {
	return uri.startsWith(SYNTHETIC_RECOVERY_PREFIX);
}

/** Build a synthetic ref when engine has not yet wired storage ids (unit tests). */
export function syntheticArtifactRef(artifactId: string, content: unknown): StageHandoffArtifactRef {
	const body = typeof content === "string" ? content : stableJson(content);
	const contentSha256 = sha256Hex(body);
	return {
		artifactId,
		bytes: utf8Bytes(body),
		recoveryUri: `${SYNTHETIC_RECOVERY_PREFIX}${encodeURIComponent(artifactId)}#sha256=${contentSha256}`,
		contentSha256,
	};
}

/**
 * Absolute file URL for a workflow artifact already written under ArtifactStore.
 * The read tool strips `file://` via expandPath — that is the production resolver.
 */
export function fileRecoveryUri(absolutePath: string): string {
	return pathToFileURL(path.resolve(absolutePath)).href;
}

/**
 * Proven only when the ref is a real file URL, the file is readable, and its
 * bytes and sha256 match. Synthetic `file://workflow-artifact/` refs are not proven.
 */
export function isProvenPersistedRef(ref: StageHandoffArtifactRef | null | undefined): ref is StageHandoffArtifactRef {
	if (!ref?.recoveryUri || !ref.contentSha256) return false;
	if (!/^[a-f0-9]{64}$/i.test(ref.contentSha256)) return false;
	if (isSyntheticRecoveryUri(ref.recoveryUri)) return false;
	let filePath: string;
	try {
		filePath = fileURLToPath(ref.recoveryUri);
	} catch {
		return false;
	}
	if (!path.isAbsolute(filePath)) return false;
	try {
		const body = fs.readFileSync(filePath, "utf8");
		if (ref.bytes > 0 && Buffer.byteLength(body, "utf-8") !== ref.bytes) return false;
		return sha256Hex(body) === ref.contentSha256;
	} catch {
		return false;
	}
}

function stableJson(value: unknown): string {
	return JSON.stringify(value);
}

function sortPreserved(items: StageHandoffPreservedItem[]): StageHandoffPreservedItem[] {
	return [...items].sort((a, b) => {
		const k = a.kind.localeCompare(b.kind);
		if (k !== 0) return k;
		// Stable sort keeps each source field's shards contiguous and in their original order.
		return a.artifactId.localeCompare(b.artifactId);
	});
}

/**
 * Blocking extracts must keep every character. Over the summary cap they shard;
 * each shard names its index so a reader can reassemble without guessing.
 */
function preservedItem(
	kind: StageHandoffItemKind,
	artifactId: string,
	summaryRaw: string,
	blocking: boolean,
): StageHandoffPreservedItem[] {
	if (!blocking) {
		const summary = clampSummary(summaryRaw);
		return [
			{
				kind,
				artifactId,
				summary,
				bytes: utf8Bytes(summary),
				blocking,
			},
		];
	}
	if (summaryRaw.length <= STAGE_HANDOFF_SUMMARY_MAX) {
		return [
			{
				kind,
				artifactId,
				summary: summaryRaw,
				bytes: utf8Bytes(summaryRaw),
				blocking: true,
			},
		];
	}
	const shards: StageHandoffPreservedItem[] = [];
	const chunk = STAGE_HANDOFF_SUMMARY_MAX;
	const shardCount = Math.ceil(summaryRaw.length / chunk);
	for (let index = 0; index < shardCount; index++) {
		const summary = summaryRaw.slice(index * chunk, (index + 1) * chunk);
		shards.push({
			kind,
			artifactId,
			summary,
			bytes: utf8Bytes(summary),
			blocking: true,
			shardIndex: index + 1,
			shardCount,
		});
	}
	return shards;
}

/** sha256 of the canonical handoff payload. Includes shard index and count. */
export function stageHandoffContentFingerprint(handoff: Omit<StageHandoffV1, "contentFingerprint">): string {
	const canonical = {
		kind: handoff.kind,
		fromStage: handoff.fromStage,
		toStage: handoff.toStage,
		preservedItems: handoff.preservedItems.map(p => ({
			kind: p.kind,
			artifactId: p.artifactId,
			summary: p.summary,
			bytes: p.bytes,
			blocking: p.blocking,
			shardIndex: p.shardIndex ?? null,
			shardCount: p.shardCount ?? null,
		})),
		omittedArtifactIds: handoff.omittedArtifactIds,
		recoveryUris: handoff.recoveryUris,
		bytesBeforeHandoff: handoff.bytesBeforeHandoff,
		bytesAfterHandoff: handoff.bytesAfterHandoff,
	};
	return sha256Hex(JSON.stringify(canonical));
}

function finalize(input: {
	fromStage: WorkflowStatus;
	toStage: WorkflowStatus;
	preservedItems: StageHandoffPreservedItem[];
	/** All candidate sources (included + omitted). */
	sources: StageHandoffArtifactRef[];
	/** Artifact ids fully omitted from preserved extract (still recoverable). */
	omittedArtifactIds: string[];
}): StageHandoffV1 {
	const preservedItems = sortPreserved(input.preservedItems);
	const recoveryUris = [...new Set(input.sources.map(s => s.recoveryUri))].sort();
	const omittedArtifactIds = [...new Set(input.omittedArtifactIds)].sort();
	const bytesBeforeHandoff = input.sources.reduce((sum, s) => sum + s.bytes, 0);
	// Preserved summary-field bytes only — not final provider request / wire tokens.
	const bytesAfterHandoff = preservedItems.reduce((sum, p) => sum + p.bytes, 0);
	const base: Omit<StageHandoffV1, "contentFingerprint"> = {
		schemaVersion: STAGE_HANDOFF_VERSION,
		kind: STAGE_HANDOFF_KIND,
		fromStage: input.fromStage,
		toStage: input.toStage,
		preservedItems,
		omittedArtifactIds,
		recoveryUris,
		bytesBeforeHandoff,
		bytesAfterHandoff,
	};
	return {
		...base,
		contentFingerprint: stageHandoffContentFingerprint(base),
	};
}

function defaultRef(
	explicit: StageHandoffArtifactRef | undefined,
	fallbackId: string,
	content: unknown,
): StageHandoffArtifactRef {
	return explicit ?? syntheticArtifactRef(fallbackId, content);
}

/**
 * Planning → Implement: keep goals, constraints, non-goals, decisions, affected files,
 * acceptance, risks, rollback. Evict exploratory process sources (passed as omittedSources).
 */
export function buildPlannerToImplementerHandoff(input: {
	plan: PlanArtifactV1;
	planReview?: PlanReviewArtifact | null;
	planRef?: StageHandoffArtifactRef;
	planReviewRef?: StageHandoffArtifactRef;
	/** Exploratory / process artifacts to record as omitted (not inlined). */
	omittedSources?: StageHandoffArtifactRef[];
}): StageHandoffV1 {
	const planRef = defaultRef(input.planRef, `${input.plan.workflowId}/plan`, input.plan);
	const plan = input.plan;
	const items: StageHandoffPreservedItem[] = [
		...preservedItem("plan", planRef.artifactId, `goal: ${plan.summary}`, true),
		...preservedItem("plan", planRef.artifactId, `constraints: ${stableJson(plan.assumptions)}`, true),
		...preservedItem("plan", planRef.artifactId, `non_goals: ${stableJson(plan.nonGoals)}`, true),
		...preservedItem("plan", planRef.artifactId, `affected_files: ${stableJson(plan.affectedFiles)}`, true),
		...preservedItem("plan", planRef.artifactId, `acceptance: ${stableJson(plan.acceptanceCriteria)}`, true),
		...preservedItem(
			"plan",
			planRef.artifactId,
			`verification_commands: ${stableJson(plan.verificationCommands)}`,
			true,
		),
		...preservedItem("plan", planRef.artifactId, `risks: ${stableJson(plan.risks)}`, false),
		...preservedItem("plan", planRef.artifactId, `rollback: ${stableJson(plan.rollback)}`, false),
		...preservedItem(
			"plan",
			planRef.artifactId,
			`implementation_steps: ${stableJson(plan.implementationSteps)}`,
			true,
		),
	];

	const sources: StageHandoffArtifactRef[] = [planRef];
	const omittedIds: string[] = [];

	if (input.planReview) {
		const reviewRef = defaultRef(input.planReviewRef, `${input.planReview.workflowId}/plan_review`, input.planReview);
		sources.push(reviewRef);
		items.push(
			...preservedItem("plan", reviewRef.artifactId, `decision: ${input.planReview.decision}`, true),
			...preservedItem(
				"finding",
				reviewRef.artifactId,
				`open_findings: ${stableJson(
					input.planReview.findings.filter(f => f.status === "open" || f.blocking === true),
				)}`,
				true,
			),
		);
		// Full review body is recoverable; only decision + open findings are inlined.
		omittedIds.push(reviewRef.artifactId);
	}

	// Plan body is always recoverable via recoveryUri; treat as omitted full body.
	omittedIds.push(planRef.artifactId);

	for (const extra of input.omittedSources ?? []) {
		sources.push(extra);
		omittedIds.push(extra.artifactId);
	}

	return finalize({
		fromStage: "planning",
		toStage: "implementing",
		preservedItems: items,
		sources,
		omittedArtifactIds: omittedIds,
	});
}

/**
 * Implement → Review: keep plan ref, changed files, patch path/content ref, commands/tests, unresolved.
 * Evict mid-state / exploratory noise via omittedSources.
 */
export function buildImplementerToReviewerHandoff(input: {
	implementation: ImplementationArtifactV1;
	plan?: PlanArtifactV1 | null;
	verification?: VerificationArtifactV1 | null;
	implRef?: StageHandoffArtifactRef;
	planRef?: StageHandoffArtifactRef;
	verificationRef?: StageHandoffArtifactRef;
	patchRef?: StageHandoffArtifactRef;
	omittedSources?: StageHandoffArtifactRef[];
}): StageHandoffV1 {
	const impl = input.implementation;
	const implRef = defaultRef(input.implRef, `${impl.workflowId}/implementation`, impl);
	const items: StageHandoffPreservedItem[] = [
		...preservedItem("patch", implRef.artifactId, `implementation.summary: ${impl.summary}`, true),
		...preservedItem("patch", implRef.artifactId, `changed_files: ${stableJson(impl.changedFiles)}`, true),
		...preservedItem("patch", implRef.artifactId, `commands_run: ${stableJson(impl.commandsRun)}`, true),
		...preservedItem("patch", implRef.artifactId, `unresolved: ${stableJson(impl.unresolved)}`, true),
		...preservedItem("patch", implRef.artifactId, `addressed_step_ids: ${stableJson(impl.addressedStepIds)}`, false),
	];

	const sources: StageHandoffArtifactRef[] = [implRef];
	const omittedIds: string[] = [implRef.artifactId];

	const patchRef =
		input.patchRef ??
		(impl.patchPath && path.isAbsolute(impl.patchPath)
			? {
					artifactId: `${impl.workflowId}/patch`,
					bytes: utf8Bytes(impl.patchPath),
					recoveryUri: fileRecoveryUri(impl.patchPath),
				}
			: undefined);
	if (patchRef || impl.patchPath) {
		const ref = patchRef ?? syntheticArtifactRef(`${impl.workflowId}/patch`, impl.patchPath ?? "");
		if (!sources.some(s => s.artifactId === ref.artifactId)) sources.push(ref);
		items.push(
			...preservedItem(
				"patch",
				ref.artifactId,
				`patch: ${stableJson({ path: impl.patchPath ?? null, branch: impl.branchName ?? null })}`,
				true,
			),
		);
	}

	if (input.plan) {
		const planRef = defaultRef(input.planRef, `${input.plan.workflowId}/plan`, input.plan);
		sources.push(planRef);
		omittedIds.push(planRef.artifactId);
		items.push(
			...preservedItem(
				"plan",
				planRef.artifactId,
				`plan.ref: ${stableJson({ summary: input.plan.summary, acceptance: input.plan.acceptanceCriteria })}`,
				true,
			),
		);
	}

	if (input.verification) {
		const vRef = defaultRef(
			input.verificationRef,
			`${input.verification.workflowId}/verification`,
			input.verification,
		);
		sources.push(vRef);
		omittedIds.push(vRef.artifactId);
		const failed = input.verification.checks.filter(c => c.status === "failed");
		items.push(
			...preservedItem("verification", vRef.artifactId, `verification.passed: ${input.verification.passed}`, true),
			...preservedItem("verification", vRef.artifactId, `verification.failed_checks: ${stableJson(failed)}`, true),
		);
	}

	for (const extra of input.omittedSources ?? []) {
		sources.push(extra);
		omittedIds.push(extra.artifactId);
	}

	return finalize({
		fromStage: "implementing",
		toStage: "code_review",
		preservedItems: items,
		sources,
		omittedArtifactIds: omittedIds,
	});
}

/** Open blocking findings that must never be dropped on Review → Repair. */
export function selectBlockingFindings(review: ReviewArtifactV1): ReviewFindingV1[] {
	return review.findings.filter(
		f =>
			f.status === "open" && (f.blocking === true || f.priority === "P0" || review.decision === "changes_requested"),
	);
}

/**
 * Review → Repair: keep all open blocking findings (file/line), failed verification,
 * attempted-repair history. Evict resolved / informational / passed verification noise.
 */
export function buildReviewerToRepairHandoff(input: {
	review: ReviewArtifactV1;
	verification?: VerificationArtifactV1 | null;
	implementation?: ImplementationArtifactV1 | null;
	/** Attempted repair history (finding id → cycle count or notes). */
	repairHistory?: Array<{ findingId: string; fingerprint?: string; cycles: number; notes?: string }>;
	reviewRef?: StageHandoffArtifactRef;
	verificationRef?: StageHandoffArtifactRef;
	implRef?: StageHandoffArtifactRef;
	omittedSources?: StageHandoffArtifactRef[];
}): StageHandoffV1 {
	const review = input.review;
	const reviewRef = defaultRef(input.reviewRef, `${review.workflowId}/review`, review);
	const blockingFindings = selectBlockingFindings(review);
	// Strict open+blocking for non-droppable; still include P0/open under changes_requested above.
	const mustKeep = blockingFindings.filter(f => f.status === "open" && (f.blocking === true || f.priority === "P0"));
	const keepList = mustKeep.length > 0 ? mustKeep : blockingFindings;

	const items: StageHandoffPreservedItem[] = [
		...preservedItem("finding", reviewRef.artifactId, `review.decision: ${review.decision}`, true),
	];

	for (const f of keepList) {
		items.push(
			...preservedItem(
				"finding",
				reviewRef.artifactId,
				`blocking_finding: ${stableJson({
					id: f.id,
					priority: f.priority,
					status: f.status,
					blocking: true,
					summary: f.summary,
					file: f.file ?? null,
					line: f.line ?? null,
					category: f.category,
				})}`,
				true,
			),
		);
	}

	// Open non-blocking findings stay recoverable via full review; only list ids if any.
	const openNonBlocking = review.findings.filter(
		f => (f.status === "open" || f.status === "in_progress") && !keepList.some(k => k.id === f.id),
	);
	if (openNonBlocking.length > 0) {
		items.push(
			...preservedItem(
				"finding",
				reviewRef.artifactId,
				`open_nonblocking_ids: ${stableJson(openNonBlocking.map(f => f.id))}`,
				false,
			),
		);
	}

	const sources: StageHandoffArtifactRef[] = [reviewRef];
	const omittedIds: string[] = [reviewRef.artifactId];

	// Explicitly omit resolved / informational from preserved content (still in full review).
	const resolvedOrInfo = review.findings.filter(
		f => f.status === "resolved" || f.status === "rejected" || (f.priority === "P3" && f.blocking !== true),
	);
	if (resolvedOrInfo.length > 0) {
		// No separate artifact ids — noted only by absence from preservedItems.
	}

	if (input.verification) {
		const vRef = defaultRef(
			input.verificationRef,
			`${input.verification.workflowId}/verification`,
			input.verification,
		);
		sources.push(vRef);
		omittedIds.push(vRef.artifactId);
		const failed = input.verification.checks.filter(c => c.status === "failed");
		if (failed.length > 0 || !input.verification.passed) {
			items.push(
				...preservedItem("verification", vRef.artifactId, `verification.failed: ${stableJson(failed)}`, true),
			);
		}
		// Passed checks are omitted from preserved (noise).
	}

	if (input.implementation) {
		const implRef = defaultRef(
			input.implRef,
			`${input.implementation.workflowId}/implementation`,
			input.implementation,
		);
		sources.push(implRef);
		omittedIds.push(implRef.artifactId);
		items.push(
			...preservedItem(
				"patch",
				implRef.artifactId,
				`implementation.changed_files: ${stableJson(input.implementation.changedFiles)}`,
				true,
			),
			...preservedItem(
				"patch",
				implRef.artifactId,
				`implementation.unresolved: ${stableJson(input.implementation.unresolved)}`,
				true,
			),
		);
	}

	if (input.repairHistory?.length) {
		items.push(
			...preservedItem("finding", reviewRef.artifactId, `repair_history: ${stableJson(input.repairHistory)}`, true),
		);
	}

	for (const extra of input.omittedSources ?? []) {
		sources.push(extra);
		omittedIds.push(extra.artifactId);
	}

	return finalize({
		fromStage: "code_review",
		toStage: "repairing",
		preservedItems: items,
		sources,
		omittedArtifactIds: omittedIds,
	});
}

/** Stable JSON serialization for persistence / prompt injection. */
export function serializeStageHandoff(handoff: StageHandoffV1): string {
	// Rebuild with sorted arrays to guarantee stable key order in nested objects via JSON.stringify insertion order.
	const ordered: StageHandoffV1 = {
		schemaVersion: handoff.schemaVersion,
		kind: handoff.kind,
		fromStage: handoff.fromStage,
		toStage: handoff.toStage,
		preservedItems: sortPreserved(handoff.preservedItems),
		omittedArtifactIds: [...handoff.omittedArtifactIds].sort(),
		recoveryUris: [...handoff.recoveryUris].sort(),
		bytesBeforeHandoff: handoff.bytesBeforeHandoff,
		bytesAfterHandoff: handoff.bytesAfterHandoff,
		contentFingerprint: handoff.contentFingerprint,
	};
	return JSON.stringify(ordered);
}

/**
 * Keep-all degrade handoff: preserves full source refs without eviction.
 * Used when construction fails mid-flight so the workflow is not blocked.
 */
export function buildKeepAllHandoff(input: {
	fromStage: WorkflowStatus;
	toStage: WorkflowStatus;
	sources: StageHandoffArtifactRef[];
}): StageHandoffV1 {
	const items = input.sources.flatMap(s =>
		preservedItem("plan", s.artifactId, `keep_all: full source ${s.recoveryUri} (${s.bytes} bytes)`, true),
	);
	return finalize({
		fromStage: input.fromStage,
		toStage: input.toStage,
		preservedItems: items,
		sources: input.sources,
		omittedArtifactIds: [],
	});
}
