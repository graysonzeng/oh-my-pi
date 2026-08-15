import { createHash, randomUUID } from "node:crypto";
import {
	BACKGROUND_LATENCY_ARM_IDS,
	backgroundArmIdFromArms,
	backgroundFingerprint,
	type DimensionSlice,
	DSH_ARM_IDS,
	DSH_DIMENSION_ARMS,
	type DshAssignmentRole,
	declaredDimensionArms,
	dshCohortKey,
	type ExperimentDimensionId,
	emptyLatencyArms,
	type LatencyArmId,
} from "./arms";

export const DSH_EXPERIMENT_IDS = ["EXP-A1", "EXP-A23", "EXP-A4"] as const;
export type DshExperimentId = (typeof DSH_EXPERIMENT_IDS)[number];

export const DSH_ARM_ASSIGNMENT_CUSTOM_TYPE = "dsh.arm_assignment.v1" as const;
export const DSH_GOAL_HASH_SHADOW_CUSTOM_TYPE = "dsh.goal_hash_shadow.v1" as const;

export const DSH_EXPERIMENT_DIMENSION: Record<DshExperimentId, ExperimentDimensionId> = {
	"EXP-A1": "dim.a1",
	"EXP-A23": "dim.a23",
	"EXP-A4": "dim.a4",
};

export const DSH_DIMENSION_EXPERIMENT: Record<ExperimentDimensionId, DshExperimentId> = {
	"dim.a1": "EXP-A1",
	"dim.a23": "EXP-A23",
	"dim.a4": "EXP-A4",
};

export interface ExperimentDefinitionV1 {
	kind: "dsh-experiment-definition";
	event_id: string;
	revision: string;
	experimentId: DshExperimentId;
	salt: string;
	windowStart: string;
	windowEnd: string;
	washoutEnd?: string;
	evaluatedAt: string;
}

export interface DshAssignmentExperiment {
	experimentId: DshExperimentId;
	dimensionId: ExperimentDimensionId;
	role: DshAssignmentRole;
	stopApplied: boolean;
	executionId: string | null;
}

export interface DshAssignmentV1 {
	v: 1;
	sessionId: string;
	arms: Record<string, boolean>;
	assignedArms: Record<string, boolean>;
	dimensions: DimensionSlice[];
	fingerprint: string;
	frozenAt: string;
	experimentDefRevision: string;
	experiments: DshAssignmentExperiment[];
	invalidXor?: boolean;
}

export interface DshEligibilityInput {
	sessionId: string;
	agentKind: "main" | "sub";
	taskSubagentOptIn?: boolean;
	allowHeadlessGoalContinuation: boolean;
	acpDeferAgentInitiatedTurns: boolean;
	now: string;
}

export interface AssignDshInput {
	sessionId: string;
	eligibility: DshEligibilityInput;
	definitions: Partial<Record<DshExperimentId, ExperimentDefinitionV1>>;
	disabledArms: ReadonlySet<LatencyArmId>;
	restored?: DshAssignmentV1 | null;
	controlPlaneDegraded: boolean;
	probeOk: boolean;
	parentA1Assigned?: boolean;
	backgroundArms?: Record<LatencyArmId, boolean>;
}

export interface AssignDshResult {
	assignment: DshAssignmentV1;
	arms: Record<LatencyArmId, boolean>;
	dimensions: DimensionSlice[];
	backgroundArmId: string;
	invalidXor: boolean;
}

export function assignmentEventId(sessionId: string, fingerprint: string): string {
	return `dsh:${sessionId}:assignment:${fingerprint}`;
}

export function metricsEventId(sessionId: string, experimentId: DshExperimentId): string {
	return `dsh:${sessionId}:metrics:${experimentId}`;
}

export function intentEventId(sessionId: string, experimentId: DshExperimentId, executionId: string): string {
	return `dshint:${sessionId}:${experimentId}:${executionId}`;
}

export function isDshExperimentId(value: string): value is DshExperimentId {
	return (DSH_EXPERIMENT_IDS as readonly string[]).includes(value);
}

export function hashTreatmentBucket(sessionId: string, experimentId: DshExperimentId, salt: string): boolean {
	const digest = createHash("sha256").update(`${sessionId}:${experimentId}:${salt}`).digest("hex");
	const bucket = Number.parseInt(digest.slice(0, 4), 16);
	return bucket < 32_768;
}

function definitionCovers(def: ExperimentDefinitionV1, nowMs: number): boolean {
	const start = Date.parse(def.windowStart);
	const end = Date.parse(def.windowEnd);
	return Number.isFinite(start) && Number.isFinite(end) && nowMs >= start && nowMs < end;
}

function experimentEligible(
	experimentId: DshExperimentId,
	eligibility: DshEligibilityInput,
	definitions: Partial<Record<DshExperimentId, ExperimentDefinitionV1>>,
	parentA1Assigned: boolean,
): boolean {
	const nowMs = Date.parse(eligibility.now);
	if (!Number.isFinite(nowMs) || eligibility.sessionId.length === 0) return false;
	if (eligibility.agentKind === "sub" && eligibility.taskSubagentOptIn !== true) return false;
	const def = definitions[experimentId];
	if (!def || !definitionCovers(def, nowMs)) return false;
	if (experimentId === "EXP-A4") {
		if (eligibility.allowHeadlessGoalContinuation !== true) return false;
		if (eligibility.acpDeferAgentInitiatedTurns) return false;
	}
	if (experimentId === "EXP-A23") {
		const washoutEnd = definitions["EXP-A1"]?.washoutEnd;
		const washoutMs = washoutEnd ? Date.parse(washoutEnd) : Number.NaN;
		if (Number.isFinite(washoutMs) && nowMs < washoutMs && parentA1Assigned) return false;
	}
	return true;
}

function restoredExperiment(
	restored: DshAssignmentV1 | undefined | null,
	experimentId: DshExperimentId,
): DshAssignmentExperiment | undefined {
	return restored?.experiments.find(item => item.experimentId === experimentId);
}

export function assignDshExperiments(input: AssignDshInput): AssignDshResult {
	const assignedArms = emptyLatencyArms();
	const arms = emptyLatencyArms();
	if (input.backgroundArms) {
		for (const arm of BACKGROUND_LATENCY_ARM_IDS) {
			assignedArms[arm] = input.backgroundArms[arm] === true;
			arms[arm] = input.backgroundArms[arm] === true;
		}
	}
	for (const arm of DSH_ARM_IDS) {
		assignedArms[arm] = false;
		arms[arm] = false;
	}

	const dimensions: DimensionSlice[] = [];
	const experiments: DshAssignmentExperiment[] = [];
	const failClosed = input.controlPlaneDegraded || !input.probeOk;
	const restoredA1 = restoredExperiment(input.restored, "EXP-A1");
	const parentA1Assigned =
		input.parentA1Assigned === true || (restoredA1 !== undefined && restoredA1.role !== "excluded");
	const bgFingerprint = backgroundFingerprint(arms);
	const a2Stopped = input.disabledArms.has("dsh_omit_goal_time");
	const a3Stopped = input.disabledArms.has("dsh_goal_hash_shadow");
	const invalidXor = a2Stopped !== a3Stopped;

	const raw: Record<DshExperimentId, { eligible: boolean; assignedTreatment: boolean; stopApplied: boolean }> = {
		"EXP-A1": { eligible: false, assignedTreatment: false, stopApplied: false },
		"EXP-A23": { eligible: false, assignedTreatment: false, stopApplied: false },
		"EXP-A4": { eligible: false, assignedTreatment: false, stopApplied: false },
	};

	for (const experimentId of DSH_EXPERIMENT_IDS) {
		const dimId = DSH_EXPERIMENT_DIMENSION[experimentId];
		const eligible =
			!failClosed && experimentEligible(experimentId, input.eligibility, input.definitions, parentA1Assigned);
		const stopApplied = declaredDimensionArms(dimId).some(arm => input.disabledArms.has(arm));
		const restored = restoredExperiment(input.restored, experimentId);
		let assignedTreatment = false;
		if (eligible) {
			if (restored && restored.role !== "excluded") {
				assignedTreatment = restored.role === "treatment";
			} else {
				const def = input.definitions[experimentId];
				assignedTreatment = def ? hashTreatmentBucket(input.sessionId, experimentId, def.salt) : false;
			}
		}
		raw[experimentId] = { eligible, assignedTreatment, stopApplied };
	}

	if (invalidXor) {
		raw["EXP-A23"] = { eligible: false, assignedTreatment: false, stopApplied: true };
	}

	if (
		raw["EXP-A1"].eligible &&
		raw["EXP-A23"].eligible &&
		raw["EXP-A1"].assignedTreatment &&
		raw["EXP-A23"].assignedTreatment
	) {
		raw["EXP-A1"] = { eligible: false, assignedTreatment: false, stopApplied: raw["EXP-A1"].stopApplied };
		raw["EXP-A23"] = { eligible: false, assignedTreatment: false, stopApplied: raw["EXP-A23"].stopApplied };
	}

	for (const experimentId of DSH_EXPERIMENT_IDS) {
		const dimId = DSH_EXPERIMENT_DIMENSION[experimentId];
		const childArms = declaredDimensionArms(dimId);
		const state = raw[experimentId];
		let role: DshAssignmentRole = "excluded";
		if (state.eligible) {
			role = state.assignedTreatment && !state.stopApplied ? "treatment" : "control";
		}
		if (experimentId === "EXP-A23" && invalidXor) role = "excluded";

		const treatment = role === "treatment";
		for (const arm of childArms) {
			assignedArms[arm] = state.assignedTreatment;
			arms[arm] = treatment;
		}

		const slice: DimensionSlice = {
			id: dimId,
			childArms,
			assignedTreatment: state.assignedTreatment,
			treatment,
			stopApplied: state.stopApplied,
			role,
			cohortKey: role === "excluded" ? null : dshCohortKey(dimId, role, bgFingerprint),
			controlKey: role === "excluded" ? null : dshCohortKey(dimId, "control", bgFingerprint),
		};
		if (role !== "excluded") dimensions.push(slice);

		experiments.push({
			experimentId,
			dimensionId: dimId,
			role,
			stopApplied: state.stopApplied,
			executionId: null,
		});
	}

	const frozenAt = new Date().toISOString();
	const experimentDefRevision = DSH_EXPERIMENT_IDS.map(id => input.definitions[id]?.revision ?? "none").join("+");
	const payload = {
		v: 1 as const,
		sessionId: input.sessionId,
		assignedArms,
		dimensions,
		experiments: experiments.map(item => ({ ...item, executionId: null })),
		experimentDefRevision,
		invalidXor,
	};
	const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
	const assignment: DshAssignmentV1 = {
		v: 1,
		sessionId: input.sessionId,
		arms,
		assignedArms,
		dimensions,
		fingerprint,
		frozenAt,
		experimentDefRevision,
		experiments,
		invalidXor: invalidXor || undefined,
	};

	return {
		assignment,
		arms,
		dimensions,
		backgroundArmId: backgroundArmIdFromArms(arms),
		invalidXor,
	};
}

/**
 * Bind one executionId per eligible experiment for this AgentSession lifecycle.
 * Same live session reuses existing ids. Resume (`newExecution: true`) mints new UUIDs.
 */
export function bindExecutionIds(
	assignment: DshAssignmentV1,
	options: { newExecution?: boolean; existing?: Partial<Record<DshExperimentId, string>> } = {},
): { assignment: DshAssignmentV1; mintedPending: Array<{ experimentId: DshExperimentId; executionId: string }> } {
	const mintedPending: Array<{ experimentId: DshExperimentId; executionId: string }> = [];
	const experiments = assignment.experiments.map(item => {
		if (item.role === "excluded") return { ...item, executionId: null };
		const reuse =
			options.newExecution === true ? undefined : (options.existing?.[item.experimentId] ?? item.executionId);
		if (reuse) return { ...item, executionId: reuse };
		const executionId = randomUUID();
		mintedPending.push({ experimentId: item.experimentId, executionId });
		return { ...item, executionId };
	});
	return { assignment: { ...assignment, experiments }, mintedPending };
}

export function applyAssignedDshArms(
	base: Record<LatencyArmId, boolean>,
	assignment: DshAssignmentV1,
): Record<LatencyArmId, boolean> {
	const next = { ...base };
	for (const arm of DSH_ARM_IDS) next[arm] = assignment.arms[arm] === true;
	return next;
}

export function parseRestoredAssignment(data: unknown): DshAssignmentV1 | null {
	if (!data || typeof data !== "object") return null;
	const value = data as Partial<DshAssignmentV1>;
	if (value.v !== 1 || typeof value.sessionId !== "string" || typeof value.fingerprint !== "string") return null;
	if (!Array.isArray(value.dimensions) || !Array.isArray(value.experiments) || !value.arms) return null;
	return value as DshAssignmentV1;
}

export { DSH_DIMENSION_ARMS };
