import type { Settings } from "../config/settings";
import type { SessionManager } from "../session/session-manager";
import {
	deriveLatencyCombination,
	freezeLatencyArmSnapshot,
	type LatencyArmSnapshotV1,
	resolveLatencyArmsFromSettings,
} from "./arms";
import {
	applyAssignedDshArms,
	assignDshExperiments,
	assignmentEventId,
	bindExecutionIds,
	DSH_ARM_ASSIGNMENT_CUSTOM_TYPE,
	type DshAssignmentV1,
	type DshEligibilityInput,
	type DshExperimentId,
	intentEventId,
	parseRestoredAssignment,
} from "./assignment";
import type { LatencyRolloutCohortStore } from "./rollout-cohort";

export interface PreparedLatencySnapshot {
	snapshot: LatencyArmSnapshotV1;
	assignment: DshAssignmentV1;
	invalidXor: boolean;
	store: LatencyRolloutCohortStore;
}

export function restoreAssignmentFromJournal(sessionManager: SessionManager): DshAssignmentV1 | null {
	const entries = sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== DSH_ARM_ASSIGNMENT_CUSTOM_TYPE) continue;
		const parsed = parseRestoredAssignment(entry.data);
		if (parsed) return parsed;
	}
	return null;
}

export function prepareLatencySnapshot(input: {
	sessionManager: SessionManager;
	settings: Settings;
	store: LatencyRolloutCohortStore;
	eligibility: DshEligibilityInput;
	resume: boolean;
	codeRevision?: string;
}): PreparedLatencySnapshot {
	const now = input.eligibility.now;
	input.store.sweepStaleProbes(now);
	const probeOk = input.store.probe();
	const degraded = input.store.controlPlaneDegraded || !input.store.startupAllowsTreatment(now);
	const disabled = new Set(input.store.readActiveDecisions(now));
	const restored = restoreAssignmentFromJournal(input.sessionManager);
	const getSetting = input.store.applyDecisionsToGetSetting(path => {
		try {
			return input.settings.get(path as Parameters<typeof input.settings.get>[0]);
		} catch {
			return false;
		}
	}, now);
	const live = resolveLatencyArmsFromSettings(getSetting);
	const assigned = assignDshExperiments({
		sessionId: input.eligibility.sessionId,
		eligibility: input.eligibility,
		definitions: input.store.readActiveExperimentDefs(now),
		disabledArms: disabled,
		restored,
		controlPlaneDegraded: degraded,
		probeOk,
		backgroundArms: live,
	});
	const existing: Partial<Record<DshExperimentId, string>> = {};
	if (restored && !input.resume) {
		for (const item of restored.experiments) {
			if (item.executionId) existing[item.experimentId] = item.executionId;
		}
	}
	const bound = bindExecutionIds(assigned.assignment, {
		newExecution: input.resume || !restored,
		existing,
	});
	for (const pending of bound.mintedPending) {
		const startedAt = new Date().toISOString();
		const ok = input.store.appendRunIntent({
			kind: "dsh-run-intent",
			event_id: intentEventId(input.eligibility.sessionId, pending.experimentId, pending.executionId),
			sessionId: input.eligibility.sessionId,
			experimentId: pending.experimentId,
			executionId: pending.executionId,
			state: "pending",
			startedAt,
			committedAt: null,
			metricsEventId: null,
			expiresAt: new Date(Date.parse(startedAt) + 30 * 24 * 60 * 60 * 1000).toISOString(),
		});
		if (!ok) {
			const experiment = bound.assignment.experiments.find(item => item.experimentId === pending.experimentId);
			if (experiment) {
				experiment.role = "excluded";
				experiment.executionId = null;
			}
			bound.assignment.dimensions = bound.assignment.dimensions.filter(
				slice =>
					slice.id !==
					(pending.experimentId === "EXP-A1"
						? "dim.a1"
						: pending.experimentId === "EXP-A23"
							? "dim.a23"
							: "dim.a4"),
			);
			if (pending.experimentId === "EXP-A1") bound.assignment.arms.dsh_session_search = false;
			if (pending.experimentId === "EXP-A23") {
				bound.assignment.arms.dsh_omit_goal_time = false;
				bound.assignment.arms.dsh_goal_hash_shadow = false;
			}
			if (pending.experimentId === "EXP-A4") bound.assignment.arms.dsh_headless_continuation = false;
		}
	}

	if (assigned.invalidXor) {
		input.store.appendAssignment({
			kind: "dsh-arm-assignment",
			event_id: assignmentEventId(input.eligibility.sessionId, bound.assignment.fingerprint),
			sessionId: input.eligibility.sessionId,
			payload: bound.assignment,
			endedAt: now,
		});
	} else if (bound.assignment.dimensions.length > 0) {
		input.sessionManager.appendCustomEntry(DSH_ARM_ASSIGNMENT_CUSTOM_TYPE, bound.assignment);
		input.store.appendAssignment({
			kind: "dsh-arm-assignment",
			event_id: assignmentEventId(input.eligibility.sessionId, bound.assignment.fingerprint),
			sessionId: input.eligibility.sessionId,
			payload: bound.assignment,
			endedAt: now,
		});
	}

	const arms = applyAssignedDshArms(live, bound.assignment);
	const combination = bound.assignment.dimensions.length > 0 ? {} : deriveLatencyCombination(arms);
	const snapshot = freezeLatencyArmSnapshot({
		arms,
		...combination,
		dimensions: bound.assignment.dimensions.length > 0 ? bound.assignment.dimensions : null,
		backgroundArmId: assigned.backgroundArmId,
		codeRevision: input.codeRevision,
		configHash: bound.assignment.fingerprint,
		frozenAt: bound.assignment.frozenAt,
	});
	return { snapshot, assignment: bound.assignment, invalidXor: assigned.invalidXor, store: input.store };
}

export function executionIdTable(assignment: DshAssignmentV1): Map<DshExperimentId, string> {
	const table = new Map<DshExperimentId, string>();
	for (const item of assignment.experiments) {
		if (item.executionId) table.set(item.experimentId, item.executionId);
	}
	return table;
}
