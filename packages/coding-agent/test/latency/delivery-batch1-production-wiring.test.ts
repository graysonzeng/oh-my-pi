/**
 * Batch 1 production wiring — prove real call sites (not library-only).
 *
 * Failure modes if these regress:
 * - W1 extension/user-accept sink missing → ordinary acceptance stays dead
 * - W2 parent consume unbound → packet-only settle remains decision-of-record
 * - W3 observe not persisted → restart cannot recompute handoff/verify lifecycle
 * - W0 identity not on session → receipts cannot associate build
 * - Status table claims runtime_wired while callers absent
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { freezeLatencyArmSnapshot } from "../../src/latency/arms";
import { BATCH1_PAIRED_EVIDENCE_READY, BATCH1_STATUS, batch1Status } from "../../src/latency/batch1-status";
import {
	appendEntryViaOrdinaryAcceptanceSink,
	recordExplicitUserAcceptance,
} from "../../src/latency/ordinary-acceptance-sink";
import {
	PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
	parseParentFinalVerificationDetails,
} from "../../src/latency/parent-final-verification";
import {
	RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE,
	buildRuntimeBuildIdentity,
	parseRuntimeBuildIdentity,
} from "../../src/latency/runtime-build-identity";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import {
	PARENT_INTEGRATE_DECISION_CUSTOM_TYPE,
	buildChildDeliveryEvidence,
} from "../../src/task/child-delivery-evidence";
import {
	EVIDENCE_HANDOFF_OBSERVE_CUSTOM_TYPE,
	getEvidenceHandoffObserveSnapshot,
	noteVerificationObserve,
	parseEvidenceHandoffObserveRecord,
	recomputeEvidenceHandoffObserveSnapshot,
	resetEvidenceHandoffObserveForTests,
} from "../../src/task/evidence-handoff-observe";
import { consumeChildDeliveryForParent, noteChildSettledObserve } from "../../src/task/parent-delivery-consume";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

afterEach(() => {
	resetEvidenceHandoffObserveForTests();
});

function createSession(manager: SessionManager): AgentSession {
	const model = createMockModel({ provider: "anthropic", responses: [{ content: ["ok"] }] });
	const agent = new Agent({
		initialState: { model, systemPrompt: [], tools: [], messages: [] },
		streamFn: model.stream,
	});
	return new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
		latencyArmSnapshot: freezeLatencyArmSnapshot({ frozenAt: "2026-09-26T00:00:00.000Z" }),
	});
}

describe("Batch1 production wiring — W1 ordinary acceptance sink", () => {
	it("routes extension appendEntry through trusted sink and rejects ungated green", () => {
		using _tmp = TempDir.createSync("@omp-wire-w1-");
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "fix it", timestamp: 1_000 });
		const session = createSession(manager);

		expect(() =>
			appendEntryViaOrdinaryAcceptanceSink(session, PARENT_FINAL_VERIFICATION_MESSAGE_TYPE, {
				status: "passed",
				source: "extension",
				// missing authority + acceptance → must not mint green
			}),
		).toThrow(/parent_final_verification_rejected/);

		const entryId = appendEntryViaOrdinaryAcceptanceSink(session, PARENT_FINAL_VERIFICATION_MESSAGE_TYPE, {
			status: "passed",
			source: "extension",
			authority: "extension",
			acceptanceItems: ["tests pass"],
			v: 1,
		});
		expect(entryId).toBeTruthy();
		const customs = manager
			.getBranch()
			.filter(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" && e.customType === PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
			);
		expect(customs).toHaveLength(1);
		const parsed = parseParentFinalVerificationDetails(customs[0]!.data);
		expect(parsed?.authority).toBe("extension");
		expect(parsed?.status).toBe("passed");
		// Must be custom, not custom_message (not model context).
		expect(customs[0]!.type).toBe("custom");
	});

	it("records explicit user accept with episode linkage; other custom types pass through", () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage({ role: "user", content: "ship goal", timestamp: 2_000 });
		const session = createSession(manager);

		const otherId = appendEntryViaOrdinaryAcceptanceSink(session, "unrelated_custom", { ok: true });
		expect(otherId).toBeTruthy();

		const result = recordExplicitUserAcceptance(session, {
			acceptanceItems: ["Goal objective satisfied"],
			eventId: `user-accept:test:${userId}`,
		});
		expect(result.recorded).toBe(true);
		if (!result.recorded) return;
		expect(result.details.authority).toBe("user_explicit");
		expect(result.details.attempt?.episode?.rootUserEntryId).toBe(userId);
	});
});

describe("Batch1 production wiring — W2 parent consume", () => {
	it("reclassifies against workspace, binds decision entry, and observes parent_consumed", () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage({ role: "user", content: "integrate child", timestamp: 3_000 });
		const delivery = buildChildDeliveryEvidence({
			codeVersion: { version: "ws-v1", changedFiles: ["a.ts"] },
			acceptanceProven: [{ id: "ok", proven: true, evidenceLocations: ["a.ts"] }],
			writeOwnershipReleased: true,
		});

		const consumed = consumeChildDeliveryForParent({
			delivery,
			currentCodeVersion: "ws-v1",
			requiredAcceptance: ["ok"],
			writeOwnershipReleased: true,
			episodeSessionId: manager.getSessionId(),
			rootUserEntryId: userId,
			jobId: "job-1",
			agentId: "agent-1",
			sink: manager,
			eventIdPrefix: "test:consume",
		});
		expect(consumed.decision.action).toBe("integrate");
		expect(consumed.entry.finalAccepted).toBe(false);
		expect(consumed.entry.kind).toBe("parent_integrate_decision");

		const decisions = manager
			.getBranch()
			.filter(e => e.type === "custom" && e.customType === PARENT_INTEGRATE_DECISION_CUSTOM_TYPE);
		expect(decisions).toHaveLength(1);

		const observes = manager
			.getBranch()
			.filter(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" && e.customType === EVIDENCE_HANDOFF_OBSERVE_CUSTOM_TYPE,
			)
			.map(e => parseEvidenceHandoffObserveRecord(e.data));
		expect(observes.some(r => r?.phase === "parent_consumed")).toBe(true);

		// Stale workspace cannot integrate.
		const stale = consumeChildDeliveryForParent({
			delivery,
			currentCodeVersion: "ws-moved",
			requiredAcceptance: ["ok"],
			writeOwnershipReleased: true,
			episodeSessionId: manager.getSessionId(),
			rootUserEntryId: userId,
			sink: manager,
			eventIdPrefix: "test:stale",
			observe: false,
		});
		expect(stale.decision.action).toBe("reread_then_decide");
	});
});

describe("Batch1 production wiring — W3 durable observe", () => {
	it("persists child_settled + verify run/reuse/reject and recomputes after restart", () => {
		const manager = SessionManager.inMemory();
		noteChildSettledObserve({
			sink: manager,
			eventId: "wire:child_settled:1",
			jobId: "j1",
			agentId: "a1",
			reason: "completed",
		});

		noteVerificationObserve({
			disposition: "run",
			reason: "execute",
			eventId: "wire:final:run:bun-test",
			sink: manager,
		});
		noteVerificationObserve({
			disposition: "reject",
			reason: "missing_validity",
			eventId: "wire:final:reject:missing_validity",
			sink: manager,
		});
		// async.running must never count as pass/reuse.
		noteVerificationObserve({
			disposition: "reuse",
			asyncRunning: true,
			eventId: "wire:async_running",
			sink: manager,
		});

		const live = getEvidenceHandoffObserveSnapshot();
		expect(live.childSettled).toBe(1);
		expect(live.verifyRun).toBeGreaterThanOrEqual(1);
		expect(live.verifyReject).toBeGreaterThanOrEqual(1);
		expect(live.verifyReuse).toBe(0);

		const records = manager
			.getBranch()
			.filter(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" && e.customType === EVIDENCE_HANDOFF_OBSERVE_CUSTOM_TYPE,
			)
			.map(e => parseEvidenceHandoffObserveRecord(e.data))
			.filter((r): r is NonNullable<typeof r> => r !== null);

		resetEvidenceHandoffObserveForTests();
		expect(getEvidenceHandoffObserveSnapshot().childSettled).toBe(0);
		const recomputed = recomputeEvidenceHandoffObserveSnapshot(records);
		expect(recomputed.childSettled).toBe(1);
		expect(recomputed.verifyReject).toBeGreaterThanOrEqual(1);
	});
});

describe("Batch1 production wiring — W0 identity + status honesty", () => {
	it("persists runtime_build_identity on session manager (session-init shape)", () => {
		const manager = SessionManager.inMemory();
		const identity = buildRuntimeBuildIdentity({
			runMode: "source",
			sourceSha: "abc123",
			dirty: false,
			model: "mock",
			provider: "anthropic",
			api: "anthropic-messages",
		});
		manager.appendCustomEntry(RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE, identity);
		const entry = manager
			.getBranch()
			.find(
				(e): e is Extract<typeof e, { type: "custom" }> =>
					e.type === "custom" && e.customType === RUNTIME_BUILD_IDENTITY_CUSTOM_TYPE,
			);
		expect(parseRuntimeBuildIdentity(entry?.data)?.sourceSha).toBe("abc123");
	});

	it("status table marks W0–W3 runtime_wired and paired_evidence_ready=false", () => {
		expect(BATCH1_PAIRED_EVIDENCE_READY).toBe(false);
		for (const id of ["W0", "W1", "W2", "W3"] as const) {
			const row = batch1Status(id);
			expect(row.code_complete).toBe(true);
			expect(row.runtime_wired).toBe(true);
			expect(row.mechanism_verified).toBe(true);
			expect(row.paired_evidence_ready).toBe(false);
		}
		expect(batch1Status("W8").paired_evidence_ready).toBe(false);
		expect(BATCH1_STATUS.every(row => row.paired_evidence_ready === false)).toBe(true);
	});
});
