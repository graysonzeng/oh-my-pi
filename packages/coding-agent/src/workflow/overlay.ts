import { isRecord } from "@oh-my-pi/pi-utils";

/** DevFlow pipeline overlay types. No new WorkflowStatus / WorkflowRole. */

export type PipelineKind = "devflow";

export type PipelineGateVerdict = "PASS" | "PASS_WITH_NOTES" | "NEEDS_REVISION" | "NEEDS_REDESIGN";

export type PipelineGateSubject = "plan" | "implementation";

export type PipelineGateIntent = "approve" | "replan_counted" | "replan_exempt" | "block" | "pause_grill";

export type OverlaySidecarPhase = "running" | "grilling" | "idle";

export type OverlayGrillReason = "incomplete_plan" | "needs_redesign" | "gate_parse_failed" | "max_grill_questions";

export interface OverlayGrillState {
	round: number;
	maxQuestions: number;
	lastQuestion: string;
	missing: string[];
	reason?: OverlayGrillReason;
	/** Append-only user answers; copied into planner context. */
	answers: string[];
}

export interface OverlaySidecar {
	schemaVersion: 1;
	phase: OverlaySidecarPhase;
	grill: OverlayGrillState;
	planningCompletenessRetries: number;
	gateResultArtifactId?: string;
}

export interface CreateWorkflowOptions {
	pipelineKind?: PipelineKind;
	overlaySidecar?: OverlaySidecar;
	ownerSessionId?: string;
}

export interface PipelineCompletenessResult {
	complete: boolean;
	missing: string[];
	next?: string;
}

export interface PipelineAuditorInput {
	kind: "preflight" | "plan";
	request: string;
	planSummary?: string;
	grillAnswers?: readonly string[];
	signal?: AbortSignal;
}

export type PipelineAuditor = (input: PipelineAuditorInput) => Promise<PipelineCompletenessResult>;

export const PIPELINE_ANTI_ANCHORING_RATIONALE =
	"Engine-derived approval: checked open findings and mandatory coverage from the current control state without a second model call.";

export function emptyDevflowSidecar(answers: readonly string[] = [], maxQuestions = 8): OverlaySidecar {
	return {
		schemaVersion: 1,
		phase: "running",
		grill: {
			round: 0,
			maxQuestions,
			lastQuestion: "",
			missing: [],
			answers: [...answers],
		},
		planningCompletenessRetries: 0,
	};
}

const SIDECAR_KEYS: Record<string, true> = {
	schemaVersion: true,
	phase: true,
	grill: true,
	planningCompletenessRetries: true,
	gateResultArtifactId: true,
};
const GRILL_KEYS: Record<string, true> = {
	round: true,
	maxQuestions: true,
	lastQuestion: true,
	missing: true,
	reason: true,
	answers: true,
};
const GRILL_REASONS: Record<OverlayGrillReason, true> = {
	incomplete_plan: true,
	needs_redesign: true,
	gate_parse_failed: true,
	max_grill_questions: true,
};

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

export function parseOverlaySidecar(raw: string | null | undefined): OverlaySidecar | undefined {
	if (raw == null || raw === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!isRecord(parsed) ||
			!Object.keys(parsed).every(key => SIDECAR_KEYS[key] === true) ||
			parsed.schemaVersion !== 1
		) {
			return undefined;
		}
		if (parsed.phase !== "running" && parsed.phase !== "grilling" && parsed.phase !== "idle") return undefined;
		if (!Number.isInteger(parsed.planningCompletenessRetries) || Number(parsed.planningCompletenessRetries) < 0) {
			return undefined;
		}
		if (
			Object.hasOwn(parsed, "gateResultArtifactId") &&
			(typeof parsed.gateResultArtifactId !== "string" || parsed.gateResultArtifactId.length === 0)
		) {
			return undefined;
		}
		const grill = parsed.grill;
		if (!isRecord(grill) || !Object.keys(grill).every(key => GRILL_KEYS[key] === true)) return undefined;
		if (!Number.isInteger(grill.round) || Number(grill.round) < 0) return undefined;
		if (!Number.isInteger(grill.maxQuestions) || Number(grill.maxQuestions) <= 0) return undefined;
		if (typeof grill.lastQuestion !== "string") return undefined;
		if (!isStringArray(grill.missing) || !isStringArray(grill.answers)) return undefined;
		if (
			Object.hasOwn(grill, "reason") &&
			(typeof grill.reason !== "string" || GRILL_REASONS[grill.reason as OverlayGrillReason] !== true)
		) {
			return undefined;
		}
		return parsed as unknown as OverlaySidecar;
	} catch {
		return undefined;
	}
}

export function isAwaitingGrill(sidecar: OverlaySidecar | undefined): boolean {
	return sidecar?.phase === "grilling";
}

export function overlayReason(sidecar: OverlaySidecar | undefined): string | undefined {
	return sidecar?.grill.reason;
}

export function appendGrillAnswers(sidecar: OverlaySidecar, answers: readonly string[]): OverlaySidecar {
	return {
		...sidecar,
		grill: {
			...sidecar.grill,
			answers: [...sidecar.grill.answers, ...answers.filter(a => a.trim().length > 0)],
		},
	};
}

export function sidecarWithGrillPause(
	sidecar: OverlaySidecar,
	reason: OverlayGrillReason,
	missing: readonly string[] = [],
	lastQuestion = "",
): OverlaySidecar {
	return {
		...sidecar,
		phase: "grilling",
		grill: {
			...sidecar.grill,
			reason,
			missing: [...missing],
			lastQuestion,
		},
	};
}

/** Fail-closed parse of Flash completeness JSON. Invalid shapes are undefined. */
export function parsePipelineCompletenessResult(raw: unknown): PipelineCompletenessResult | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (typeof record.complete !== "boolean") return undefined;
	const missing = Array.isArray(record.missing)
		? record.missing.filter((item): item is string => typeof item === "string")
		: [];
	const next = typeof record.next === "string" ? record.next : undefined;
	return { complete: record.complete, missing, next };
}

export function sidecarIdle(sidecar: OverlaySidecar): OverlaySidecar {
	const { reason: _reason, ...grill } = sidecar.grill;
	return {
		...sidecar,
		phase: "idle",
		grill: {
			...grill,
			lastQuestion: "",
			missing: [],
		},
	};
}
