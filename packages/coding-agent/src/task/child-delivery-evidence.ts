/**
 * Child → parent delivery evidence (delivery-first Package 2).
 *
 * Extends the existing EvidenceHandoff / structured-result surface with a
 * machine-readable outbound packet so the parent can integrate without
 * re-investigating. Not a second handoff platform and not a prose report.
 *
 * Boundary: a structured report is not proof of correct completion. Reviewers
 * stay independent — author self-assessment is never inherited as truth.
 */

import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { fingerprintStable } from "../latency/stable-serialize";

export const CHILD_DELIVERY_EVIDENCE_KIND = "child_delivery_evidence" as const;
export const CHILD_DELIVERY_EVIDENCE_VERSION = 1 as const;
/** Fenced language tag for recoverable embedding in freeform output. */
export const CHILD_DELIVERY_EVIDENCE_FENCE = "child-delivery-evidence";

export interface CodeVersionIdentity {
	/** Workspace / patch identity (sha256, head id, content digest, …). */
	version: string;
	changedFiles: string[];
	patchSha256?: string;
}

export interface AcceptanceItemEvidence {
	/** Acceptance item id or exact acceptance text. */
	id: string;
	proven: boolean;
	/** Paths, artifact URIs, or log locations that prove the item. */
	evidenceLocations: string[];
}

export interface CheckNotRun {
	id: string;
	command?: string;
	/** Why the check was skipped (scoped ownership, reused seal, N/A, …). */
	reason: string;
}

export type FinishOwner = "original_worker" | "parent";

export interface ChildDeliveryEvidenceV1 {
	kind: typeof CHILD_DELIVERY_EVIDENCE_KIND;
	v: typeof CHILD_DELIVERY_EVIDENCE_VERSION;
	codeVersion: CodeVersionIdentity;
	acceptanceProven: AcceptanceItemEvidence[];
	checksNotRun: CheckNotRun[];
	/** Remaining work finishable by the original worker vs needs parent. */
	finishOwner: FinishOwner;
	finishOwnerReason?: string;
	/** Shared files / interfaces touched. */
	sharedInterfaces: string[];
	/** True when the child released write ownership on shared paths. */
	writeOwnershipReleased: boolean;
	/**
	 * Author reasoning / self-assessment. Stripped for reviewers; never used
	 * by {@link classifyParentIntegrate} as acceptance evidence.
	 */
	authorConclusions?: string[];
	contentFingerprint?: string;
}

export type ParentIntegrateClass = "done_valid" | "missing_local_evidence" | "cross_module" | "stale_context";

export type ParentIntegrateAction = "integrate" | "return_to_worker" | "parent_coordinate" | "reread_then_decide";

export interface ParentIntegrateDecision {
	classification: ParentIntegrateClass;
	action: ParentIntegrateAction;
	reasons: string[];
	/** Always false — author self-assessment never drives the decision. */
	usedAuthorSelfAssessment: false;
}

export interface BuildChildDeliveryEvidenceInput {
	codeVersion: CodeVersionIdentity;
	acceptanceProven?: AcceptanceItemEvidence[];
	checksNotRun?: CheckNotRun[];
	finishOwner?: FinishOwner;
	finishOwnerReason?: string;
	sharedInterfaces?: string[];
	writeOwnershipReleased?: boolean;
	authorConclusions?: string[];
}

const FENCE_RE = new RegExp(`\`\`\`${CHILD_DELIVERY_EVIDENCE_FENCE}\\s*\\n([\\s\\S]*?)\\n\`\`\``, "m");

function nonEmptyStrings(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	return values.map(v => v.trim()).filter(Boolean);
}

function normalizeCodeVersion(raw: unknown): CodeVersionIdentity | null {
	if (!isRecord(raw)) return null;
	const version = typeof raw.version === "string" ? raw.version.trim() : "";
	if (!version) return null;
	const changedFiles = Array.isArray(raw.changedFiles)
		? nonEmptyStrings(raw.changedFiles.filter((p): p is string => typeof p === "string"))
		: [];
	const out: CodeVersionIdentity = { version, changedFiles };
	if (typeof raw.patchSha256 === "string" && raw.patchSha256.trim()) {
		out.patchSha256 = raw.patchSha256.trim();
	}
	return out;
}

function normalizeAcceptanceItem(raw: unknown): AcceptanceItemEvidence | null {
	if (!isRecord(raw)) return null;
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id || typeof raw.proven !== "boolean") return null;
	const evidenceLocations = Array.isArray(raw.evidenceLocations)
		? nonEmptyStrings(raw.evidenceLocations.filter((p): p is string => typeof p === "string"))
		: [];
	return { id, proven: raw.proven, evidenceLocations };
}

function normalizeCheckNotRun(raw: unknown): CheckNotRun | null {
	if (!isRecord(raw)) return null;
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
	if (!id || !reason) return null;
	const out: CheckNotRun = { id, reason };
	if (typeof raw.command === "string" && raw.command.trim()) out.command = raw.command.trim();
	return out;
}

function fingerprintPayload(delivery: Omit<ChildDeliveryEvidenceV1, "contentFingerprint">): string {
	return fingerprintStable({
		kind: delivery.kind,
		v: delivery.v,
		codeVersion: delivery.codeVersion,
		acceptanceProven: delivery.acceptanceProven,
		checksNotRun: delivery.checksNotRun,
		finishOwner: delivery.finishOwner,
		finishOwnerReason: delivery.finishOwnerReason ?? "",
		sharedInterfaces: delivery.sharedInterfaces,
		writeOwnershipReleased: delivery.writeOwnershipReleased,
		authorConclusions: delivery.authorConclusions ?? [],
	});
}

/** Build a versioned child delivery evidence packet. */
export function buildChildDeliveryEvidence(input: BuildChildDeliveryEvidenceInput): ChildDeliveryEvidenceV1 {
	const codeVersion = normalizeCodeVersion(input.codeVersion);
	if (!codeVersion) throw new Error("child_delivery_evidence_missing_code_version");
	const acceptanceProven = (input.acceptanceProven ?? [])
		.map(normalizeAcceptanceItem)
		.filter((item): item is AcceptanceItemEvidence => item !== null);
	const checksNotRun = (input.checksNotRun ?? [])
		.map(normalizeCheckNotRun)
		.filter((item): item is CheckNotRun => item !== null);
	const finishOwner: FinishOwner = input.finishOwner === "parent" ? "parent" : "original_worker";
	const base: Omit<ChildDeliveryEvidenceV1, "contentFingerprint"> = {
		kind: CHILD_DELIVERY_EVIDENCE_KIND,
		v: CHILD_DELIVERY_EVIDENCE_VERSION,
		codeVersion,
		acceptanceProven,
		checksNotRun,
		finishOwner,
		sharedInterfaces: nonEmptyStrings(input.sharedInterfaces),
		writeOwnershipReleased: input.writeOwnershipReleased === true,
		...(input.finishOwnerReason?.trim() ? { finishOwnerReason: input.finishOwnerReason.trim() } : {}),
		...(input.authorConclusions && nonEmptyStrings(input.authorConclusions).length
			? { authorConclusions: nonEmptyStrings(input.authorConclusions) }
			: {}),
	};
	return { ...base, contentFingerprint: fingerprintPayload(base) };
}

/** Parse a delivery evidence object; null when shape/version is wrong. */
export function parseChildDeliveryEvidence(value: unknown): ChildDeliveryEvidenceV1 | null {
	if (!isRecord(value)) return null;
	if (value.kind !== CHILD_DELIVERY_EVIDENCE_KIND || value.v !== CHILD_DELIVERY_EVIDENCE_VERSION) return null;
	const codeVersion = normalizeCodeVersion(value.codeVersion);
	if (!codeVersion) return null;
	try {
		const acceptanceRaw = Array.isArray(value.acceptanceProven) ? value.acceptanceProven : [];
		const checksRaw = Array.isArray(value.checksNotRun) ? value.checksNotRun : [];
		const acceptanceProven: AcceptanceItemEvidence[] = [];
		for (const raw of acceptanceRaw) {
			const item = normalizeAcceptanceItem(raw);
			if (!item) return null;
			acceptanceProven.push(item);
		}
		const checksNotRun: CheckNotRun[] = [];
		for (const raw of checksRaw) {
			const item = normalizeCheckNotRun(raw);
			if (!item) return null;
			checksNotRun.push(item);
		}
		const finishOwner: FinishOwner = value.finishOwner === "parent" ? "parent" : "original_worker";
		if (value.finishOwner !== "parent" && value.finishOwner !== "original_worker") return null;
		return buildChildDeliveryEvidence({
			codeVersion,
			acceptanceProven,
			checksNotRun,
			finishOwner,
			finishOwnerReason: typeof value.finishOwnerReason === "string" ? value.finishOwnerReason : undefined,
			sharedInterfaces: Array.isArray(value.sharedInterfaces)
				? value.sharedInterfaces.filter((s): s is string => typeof s === "string")
				: [],
			writeOwnershipReleased: value.writeOwnershipReleased === true,
			authorConclusions: Array.isArray(value.authorConclusions)
				? value.authorConclusions.filter((s): s is string => typeof s === "string")
				: undefined,
		});
	} catch {
		return null;
	}
}

/** Extract delivery evidence from structured yield/data or a fenced block. */
export function extractChildDeliveryEvidence(value: unknown): ChildDeliveryEvidenceV1 | null {
	const direct = parseChildDeliveryEvidence(value);
	if (direct) return direct;
	if (isRecord(value) && value.deliveryEvidence !== undefined) {
		const nested = parseChildDeliveryEvidence(value.deliveryEvidence);
		if (nested) return nested;
	}
	if (typeof value === "string") {
		const match = FENCE_RE.exec(value);
		if (!match) return null;
		try {
			return parseChildDeliveryEvidence(JSON.parse(match[1]!.trim()));
		} catch {
			return null;
		}
	}
	return null;
}

/** Serialize as a recoverable fenced JSON block. */
export function serializeChildDeliveryEvidence(delivery: ChildDeliveryEvidenceV1): string {
	const normalized = parseChildDeliveryEvidence(delivery);
	if (!normalized) throw new Error("child_delivery_evidence_serialize_invalid");
	return `\`\`\`${CHILD_DELIVERY_EVIDENCE_FENCE}\n${JSON.stringify(normalized, null, "\t")}\n\`\`\``;
}

/** Reviewers share raw evidence without author conclusions or proven claims. */
export function projectChildDeliveryForReviewer(delivery: ChildDeliveryEvidenceV1): ChildDeliveryEvidenceV1 {
	const base = parseChildDeliveryEvidence(delivery);
	if (!base) throw new Error("child_delivery_evidence_project_invalid");
	return buildChildDeliveryEvidence({
		codeVersion: base.codeVersion,
		// Keep ids + locations for where to look, but force proven:false so the
		// reviewer does not inherit author self-assessment of acceptance.
		acceptanceProven: base.acceptanceProven.map(item => ({
			id: item.id,
			proven: false,
			evidenceLocations: item.evidenceLocations,
		})),
		checksNotRun: base.checksNotRun,
		finishOwner: base.finishOwner,
		finishOwnerReason: base.finishOwnerReason,
		sharedInterfaces: base.sharedInterfaces,
		writeOwnershipReleased: base.writeOwnershipReleased,
		// intentionally omit authorConclusions
	});
}

function acceptanceSatisfied(
	delivery: ChildDeliveryEvidenceV1,
	requiredAcceptance: readonly string[] | undefined,
): { ok: boolean; missing: string[] } {
	const provenIds = new Set(
		delivery.acceptanceProven.filter(item => item.proven && item.evidenceLocations.length > 0).map(item => item.id),
	);
	const required = nonEmptyStrings(requiredAcceptance);
	if (required.length === 0) {
		// No contract list: require at least one proven item with evidence, or
		// an explicit empty acceptanceProven when the child claims nothing to prove.
		if (delivery.acceptanceProven.length === 0) return { ok: false, missing: ["<acceptance>"] };
		const unproven = delivery.acceptanceProven.filter(item => !item.proven || item.evidenceLocations.length === 0);
		return {
			ok: unproven.length === 0,
			missing: unproven.map(item => item.id),
		};
	}
	const missing = required.filter(item => !provenIds.has(item));
	return { ok: missing.length === 0, missing };
}

/**
 * Parent integrate classifier over a child delivery packet.
 *
 * | State | Action |
 * |---|---|
 * | Done + evidence valid | integrate |
 * | Missing local evidence | return to original worker |
 * | Cross-module issue | parent coordinates |
 * | Original context stale | re-read then decide fresh worker |
 *
 * Never trusts `authorConclusions`.
 */
export function classifyParentIntegrate(input: {
	delivery: ChildDeliveryEvidenceV1 | null | undefined;
	/** Inbound handoff / facts marked stale. */
	staleEvidence?: boolean;
	/** Delivery code version no longer matches workspace. */
	codeVersionStale?: boolean;
	/** Acceptance items from the task contract. */
	requiredAcceptance?: readonly string[];
	/** Child edited paths outside declared scope. */
	outOfScopeEdits?: boolean;
	/** Shared-interface / multi-module coordination required. */
	crossModule?: boolean;
}): ParentIntegrateDecision {
	const reasons: string[] = [];
	const delivery = input.delivery ? parseChildDeliveryEvidence(input.delivery) : null;

	if (input.staleEvidence === true || input.codeVersionStale === true) {
		if (input.staleEvidence === true) reasons.push("stale_evidence");
		if (input.codeVersionStale === true) reasons.push("code_version_stale");
		return {
			classification: "stale_context",
			action: "reread_then_decide",
			reasons,
			usedAuthorSelfAssessment: false,
		};
	}

	if (!delivery) {
		return {
			classification: "missing_local_evidence",
			action: "return_to_worker",
			reasons: ["missing_delivery_evidence"],
			usedAuthorSelfAssessment: false,
		};
	}

	if (input.outOfScopeEdits === true) {
		return {
			classification: "cross_module",
			action: "parent_coordinate",
			reasons: ["out_of_scope_edits"],
			usedAuthorSelfAssessment: false,
		};
	}

	const needsParent =
		input.crossModule === true ||
		delivery.finishOwner === "parent" ||
		(delivery.sharedInterfaces.length > 0 && !delivery.writeOwnershipReleased);

	if (needsParent) {
		if (input.crossModule === true) reasons.push("cross_module");
		if (delivery.finishOwner === "parent") reasons.push("finish_owner_parent");
		if (delivery.sharedInterfaces.length > 0 && !delivery.writeOwnershipReleased) {
			reasons.push("write_ownership_held");
		}
		return {
			classification: "cross_module",
			action: "parent_coordinate",
			reasons,
			usedAuthorSelfAssessment: false,
		};
	}

	const acceptance = acceptanceSatisfied(delivery, input.requiredAcceptance);
	if (!acceptance.ok) {
		return {
			classification: "missing_local_evidence",
			action: "return_to_worker",
			reasons: acceptance.missing.map(id => `acceptance_unproven:${id}`),
			usedAuthorSelfAssessment: false,
		};
	}

	// Integrate requires an explicit code version *and* declared changed files —
	// empty changedFiles with a non-empty version previously slipped through
	// because normalizeCodeVersion already rejects empty version.
	if (delivery.codeVersion.changedFiles.length === 0) {
		return {
			classification: "missing_local_evidence",
			action: "return_to_worker",
			reasons: ["missing_changed_files"],
			usedAuthorSelfAssessment: false,
		};
	}

	return {
		classification: "done_valid",
		action: "integrate",
		reasons: ["delivery_evidence_valid"],
		usedAuthorSelfAssessment: false,
	};
}

/**
 * Follow-up asks the parent would still need after seeing the delivery packet.
 * Empty when classification is done_valid — parent should not re-read for those.
 */
export function parentFollowUpNeeds(decision: ParentIntegrateDecision): string[] {
	if (decision.classification === "done_valid") return [];
	return decision.reasons.slice();
}

/** True when the delivery packet alone is enough for integrate (no parent re-read). */
export function deliveryEvidenceSufficientForIntegrate(decision: ParentIntegrateDecision): boolean {
	return decision.classification === "done_valid" && decision.action === "integrate";
}

/**
 * Classify a settled child result for the parent integrate path.
 * Always returns a decision — missing/absent packets fail closed to return_to_worker.
 */
export function classifyChildResultForParentIntegrate(input: {
	deliveryEvidence?: ChildDeliveryEvidenceV1 | null;
	staleEvidence?: boolean;
	codeVersionStale?: boolean;
	requiredAcceptance?: readonly string[];
	outOfScopeEdits?: boolean;
	crossModule?: boolean;
}): ParentIntegrateDecision {
	return classifyParentIntegrate({
		delivery: input.deliveryEvidence ?? null,
		staleEvidence: input.staleEvidence,
		codeVersionStale: input.codeVersionStale,
		requiredAcceptance: input.requiredAcceptance,
		outOfScopeEdits: input.outOfScopeEdits,
		crossModule: input.crossModule,
	});
}

/**
 * Stable producer from executor facts (Batch 1 W2).
 *
 * Builds a packet from real patch / code version / terminal checks / write
 * ownership. The worker may claim local evidence locations, but cannot seal
 * parent-final acceptance — forged `proven:true` without evidence locations is
 * stripped. Missing deterministic sources stay missing/unchecked.
 */
export function buildChildDeliveryEvidenceFromExecutorFacts(input: {
	codeVersion: CodeVersionIdentity;
	/** Acceptance items with optional evidence paths from terminal checks. */
	acceptanceItems?: readonly {
		id: string;
		evidenceLocations?: readonly string[];
		/** Ignored when evidenceLocations is empty — worker cannot forge proven. */
		claimedProven?: boolean;
	}[];
	checksNotRun?: readonly CheckNotRun[];
	/** Terminal checks that actually ran green for this code version. */
	terminalChecksPassed?: readonly { id: string; evidenceLocation?: string }[];
	finishOwner?: FinishOwner;
	finishOwnerReason?: string;
	sharedInterfaces?: readonly string[];
	writeOwnershipReleased?: boolean;
	authorConclusions?: readonly string[];
}): ChildDeliveryEvidenceV1 {
	const terminalById = new Map((input.terminalChecksPassed ?? []).map(check => [check.id, check] as const));
	const acceptanceProven: AcceptanceItemEvidence[] = (input.acceptanceItems ?? []).map(item => {
		const terminal = terminalById.get(item.id);
		const locations = nonEmptyStrings([
			...(item.evidenceLocations ?? []),
			...(terminal?.evidenceLocation ? [terminal.evidenceLocation] : []),
		]);
		// Worker cannot seal proven without at least one evidence location.
		const proven = locations.length > 0 && item.claimedProven !== false;
		return { id: item.id.trim(), proven, evidenceLocations: locations };
	});
	return buildChildDeliveryEvidence({
		codeVersion: input.codeVersion,
		acceptanceProven,
		checksNotRun: input.checksNotRun ? [...input.checksNotRun] : undefined,
		finishOwner: input.finishOwner,
		finishOwnerReason: input.finishOwnerReason,
		sharedInterfaces: input.sharedInterfaces ? [...input.sharedInterfaces] : undefined,
		writeOwnershipReleased: input.writeOwnershipReleased,
		authorConclusions: input.authorConclusions ? [...input.authorConclusions] : undefined,
	});
}

/**
 * Parent reclassification against the **current** workspace + acceptance
 * contract + freshness (Batch 1 W2). Bind the decision to the parent integrate
 * prompt / controlled decision entry — never inherit child packet-only integrate.
 *
 * `done_valid` here means integrate-eligible, NOT final parent acceptance.
 */
export function reclassifyParentIntegrateAgainstWorkspace(input: {
	delivery: ChildDeliveryEvidenceV1 | null | undefined;
	/** Current workspace / patch identity fingerprint. */
	currentCodeVersion: string;
	requiredAcceptance?: readonly string[];
	/** Inbound handoff / facts marked stale. */
	staleEvidence?: boolean;
	outOfScopeEdits?: boolean;
	crossModule?: boolean;
	/** When false/undefined, write ownership still held blocks integrate. */
	writeOwnershipReleased?: boolean;
}): ParentIntegrateDecision & { boundToWorkspaceVersion: string } {
	const delivery = input.delivery ? parseChildDeliveryEvidence(input.delivery) : null;
	const current = input.currentCodeVersion.trim();
	const codeVersionStale = !delivery || !current || delivery.codeVersion.version !== current;

	const decision = classifyParentIntegrate({
		delivery,
		staleEvidence: input.staleEvidence === true,
		codeVersionStale,
		requiredAcceptance: input.requiredAcceptance,
		outOfScopeEdits: input.outOfScopeEdits,
		crossModule:
			input.crossModule === true ||
			(delivery !== null && delivery.sharedInterfaces.length > 0 && input.writeOwnershipReleased === false),
	});

	// Packet-only freshness already handled by codeVersionStale. Unreleased
	// write ownership cannot integrate even if the child claimed release.
	if (
		decision.action === "integrate" &&
		delivery &&
		delivery.sharedInterfaces.length > 0 &&
		input.writeOwnershipReleased === false
	) {
		return {
			classification: "cross_module",
			action: "parent_coordinate",
			reasons: ["write_ownership_unreleased"],
			usedAuthorSelfAssessment: false,
			boundToWorkspaceVersion: current,
		};
	}

	return { ...decision, boundToWorkspaceVersion: current };
}

/**
 * Bind a parent integrate decision onto a controlled decision entry payload
 * (custom entry / prompt injection metadata — not model-context prose).
 */
export function bindParentIntegrateDecisionEntry(input: {
	decision: ParentIntegrateDecision;
	episodeSessionId: string;
	rootUserEntryId: string;
	taskToolCallId?: string | null;
	jobId?: string | null;
	agentId?: string | null;
	workspaceVersion: string;
	recordedAtMs?: number;
}): {
	kind: "parent_integrate_decision";
	v: 1;
	classification: ParentIntegrateClass;
	action: ParentIntegrateAction;
	reasons: string[];
	usedAuthorSelfAssessment: false;
	episode: { sessionId: string; rootUserEntryId: string };
	taskToolCallId: string | null;
	jobId: string | null;
	agentId: string | null;
	workspaceVersion: string;
	recordedAtMs: number;
	/** Explicit: integrate-eligible is not final acceptance. */
	finalAccepted: false;
} {
	return {
		kind: "parent_integrate_decision",
		v: 1,
		classification: input.decision.classification,
		action: input.decision.action,
		reasons: [...input.decision.reasons],
		usedAuthorSelfAssessment: false,
		episode: {
			sessionId: input.episodeSessionId,
			rootUserEntryId: input.rootUserEntryId,
		},
		taskToolCallId: input.taskToolCallId ?? null,
		jobId: input.jobId ?? null,
		agentId: input.agentId ?? null,
		workspaceVersion: input.workspaceVersion,
		recordedAtMs: input.recordedAtMs ?? Date.now(),
		finalAccepted: false,
	};
}

export const PARENT_INTEGRATE_DECISION_CUSTOM_TYPE = "parent_integrate_decision";
