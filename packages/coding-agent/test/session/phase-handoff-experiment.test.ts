/**
 * History S2 — phase-handoff experiment.
 *
 * Failure modes: defaults flip on; required retained state dropped; model/
 * concurrency flags smuggled true; claimedLiveWin true; globalFixedCap true.
 */
import { describe, expect, test } from "bun:test";
import {
	applyPhaseHandoffExperiment,
	buildPhaseHandoffExperimentRun,
	defaultPhaseHandoffExperimentConfig,
	resolvePhaseHandoffExperiment,
} from "../../src/session/phase-handoff-experiment";
import { cfgPhaseHandoffExperimentEnabled, cfgPhaseHandoffExperimentFactor } from "../../src/session/context-settings";

const retained = {
	openConstraints: ["keep public API stable"],
	modificationState: ["edited packages/coding-agent/src/foo.ts"],
	acceptanceBasis: ["bun test packages/coding-agent/test/foo.test.ts passes"],
};

describe("phase-handoff experiment defaults", () => {
	test("settings default off with factor none", () => {
		expect(cfgPhaseHandoffExperimentEnabled.default).toBe(false);
		expect(cfgPhaseHandoffExperimentFactor.default).toBe("none");
	});

	test("default config resolves to control without applying", () => {
		const { applied, receipt } = resolvePhaseHandoffExperiment(defaultPhaseHandoffExperimentConfig());
		expect(applied).toBe(false);
		expect(receipt.globalFixedCap).toBe(false);
		expect(receipt.modelOrConcurrencyChanged).toBe(false);
		expect(receipt.fallbackReason).toBe("disabled");
	});
});

describe("phase_boundary_carry_slim retention", () => {
	test("control keeps bulky carry and retained state", () => {
		const carried = {
			bulkyCarry: ["huge prior transcript", "old read dump"],
			retained,
		};
		const result = applyPhaseHandoffExperiment({
			config: { enabled: false, factor: "none" },
			carried,
		});
		expect(result.applied).toBe(false);
		expect(result.carried.bulkyCarry).toEqual(carried.bulkyCarry);
		expect(result.retained).toEqual(retained);
		expect(result.droppedBulkyCount).toBe(0);
	});

	test("treatment drops bulky carry while retaining required state", () => {
		const carried = {
			bulkyCarry: ["huge prior transcript", "old read dump"],
			retained,
		};
		const result = applyPhaseHandoffExperiment({
			config: { enabled: true, factor: "phase_boundary_carry_slim" },
			carried,
		});
		expect(result.applied).toBe(true);
		expect(result.carried.bulkyCarry).toEqual([]);
		expect(result.droppedBulkyCount).toBe(2);
		expect(result.retained.openConstraints).toEqual(retained.openConstraints);
		expect(result.retained.modificationState).toEqual(retained.modificationState);
		expect(result.retained.acceptanceBasis).toEqual(retained.acceptanceBasis);
		expect(result.receipt.globalFixedCap).toBe(false);
		expect(result.receipt.modelOrConcurrencyChanged).toBe(false);

		const run = buildPhaseHandoffExperimentRun({
			arm: "treatment",
			config: { enabled: true, factor: "phase_boundary_carry_slim" },
			result,
		});
		expect(run.claimedLiveWin).toBe(false);
		expect(run.retainedOpenConstraints).toBe(1);
		expect(run.retainedModificationState).toBe(1);
		expect(run.retainedAcceptanceBasis).toBe(1);
	});

	test("fails closed when required retained state is missing", () => {
		const result = applyPhaseHandoffExperiment({
			config: { enabled: true, factor: "phase_boundary_carry_slim" },
			carried: {
				bulkyCarry: ["dump"],
				retained: { openConstraints: [], modificationState: ["x"], acceptanceBasis: ["y"] },
			},
		});
		expect(result.applied).toBe(false);
		expect(result.receipt.fallbackReason).toBe("missing_required_state");
		expect(result.carried.bulkyCarry).toEqual(["dump"]);
	});
});
