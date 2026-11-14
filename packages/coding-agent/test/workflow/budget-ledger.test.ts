import { beforeEach, describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { BudgetLedger, createWorkflowBudgetPort } from "../../src/workflow/budget-ledger";
import { BudgetExhaustedError } from "../../src/workflow/errors";

describe("BudgetLedger", () => {
	let ledger: BudgetLedger;

	beforeEach(() => {
		ledger = new BudgetLedger({ limitUsd: 1, maxRequests: 5, maxRepairCycles: 2 });
	});

	it("accumulates requests, tokens, cache, tools, stage time, repairs", () => {
		const usage: Usage = {
			input: 100,
			output: 200,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 315,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		};
		ledger.recordRequest(usage);
		ledger.recordToolCalls(3);
		ledger.recordStageTime(1500);
		ledger.recordRepairCycle();
		const snap = ledger.snapshot();
		expect(snap.requests).toBe(1);
		expect(snap.tokensIn).toBe(100);
		expect(snap.tokensOut).toBe(200);
		expect(snap.cacheRead).toBe(10);
		expect(snap.cacheWrite).toBe(5);
		expect(snap.costUsd).toBe(0.3);
		expect(snap.costKnown).toBe(true);
		expect(snap.toolCalls).toBe(3);
		expect(snap.stageTimeMs).toBe(1500);
		expect(snap.repairCycles).toBe(1);
	});

	it("records unknown cost without inventing values", () => {
		const usage = {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: undefined as unknown as number },
		} as Usage;
		ledger.recordRequest(usage);
		const snap = ledger.snapshot();
		expect(snap.costKnown).toBe(false);
		expect(snap.costUsd).toBeNull();
		expect(snap.knownCostLowerBoundUsd).toBe(0);
		expect(snap.unknownCostRequestCount).toBe(1);
	});

	it("keeps accumulating known lower bound after an unknown cost appears", () => {
		const known = (total: number): Usage => ({
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
		});
		ledger.recordRequest(known(1), "p1");
		ledger.recordRequest(
			{
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: undefined as unknown as number },
			} as Usage,
			"p1",
		);
		ledger.recordRequest(known(2), "p1");
		const snap = ledger.snapshot();
		expect(snap.costKnown).toBe(false);
		expect(snap.costUsd).toBeNull();
		expect(snap.knownCostLowerBoundUsd).toBe(3);
		expect(snap.unknownCostRequestCount).toBe(1);
		const p1 = snap.profiles.find(p => p.profileId === "p1");
		expect(p1?.knownCostLowerBoundUsd).toBe(3);
		expect(p1?.costUsd).toBeNull();
	});

	it("isolates profile unknown coverage from other profiles", () => {
		const known = (total: number): Usage => ({
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
		});
		const led = new BudgetLedger({ limitUsd: 100, maxRequests: 100 });
		led.recordRequest(
			{
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: undefined as unknown as number },
			} as Usage,
			"unknown_profile",
		);
		led.recordRequest(known(0.4), "known_profile");
		const snap = led.snapshot();
		expect(snap.costKnown).toBe(false);
		expect(snap.knownCostLowerBoundUsd).toBe(0.4);
		const unknown = snap.profiles.find(p => p.profileId === "unknown_profile");
		const knownProf = snap.profiles.find(p => p.profileId === "known_profile");
		expect(unknown?.costUsd).toBeNull();
		expect(unknown?.knownCostLowerBoundUsd).toBe(0);
		expect(knownProf?.costUsd).toBe(0.4);
		expect(knownProf?.knownCostLowerBoundUsd).toBe(0.4);
	});

	it("hard-stops when known lower bound reaches the limit even if total is unknown", async () => {
		const led = new BudgetLedger({ limitUsd: 1 });
		led.recordRequest({
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0.6, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.6 },
		});
		led.recordRequest({
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: undefined as unknown as number },
		} as Usage);
		led.recordRequest({
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		});
		expect(led.snapshot().knownCostLowerBoundUsd).toBe(1.1);
		expect(led.snapshot().costUsd).toBeNull();
		expect(await led.checkPreStage()).toBe(false);
	});

	it("does not reconstruct known zero from a legacy unknown snapshot", () => {
		const restored = new BudgetLedger({ limitUsd: 5 });
		restored.restore({ costKnown: false, costUsd: null, requests: 2 });
		const snap = restored.snapshot();
		expect(snap.costKnown).toBe(false);
		expect(snap.costUsd).toBeNull();
		expect(snap.knownCostLowerBoundUsd).toBe(0);
		expect(snap.unknownCostRequestCount).toBeGreaterThanOrEqual(1);
	});

	it("enforces per-profile request caps", () => {
		const led = new BudgetLedger({ limitUsd: 100, maxRequests: 100 });
		expect(led.checkProfileBudget("p1", { maxRequests: 2 })).toBe(true);
		led.recordRequest(undefined, "p1");
		led.recordRequest(undefined, "p1");
		expect(led.checkProfileBudget("p1", { maxRequests: 2 })).toBe(false);
		expect(led.checkProfileBudget("p2", { maxRequests: 2 })).toBe(true);
	});

	it("restores per-profile request and cost gates from a snapshot", () => {
		const original = new BudgetLedger({ limitUsd: 100, maxRequests: 100 });
		original.recordRequest(
			{
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
			},
			"limited",
		);
		const restored = new BudgetLedger({ limitUsd: 100, maxRequests: 100 });
		restored.restore(original.snapshot());
		expect(restored.checkProfileBudget("limited", { maxRequests: 1 })).toBe(false);
		expect(restored.checkProfileBudget("limited", { maxCostUsd: 0.5 })).toBe(false);
	});

	it("pre-stage and pre-retry hard-stop on limits", async () => {
		expect(await ledger.checkPreStage()).toBe(true);
		ledger.recordRepairCycle();
		ledger.recordRepairCycle();
		// Repair-cycle cap applies only to checkPreRepair, not generic pre-stage/verify.
		expect(await ledger.checkPreStage()).toBe(true);
		expect(await ledger.checkPreRetry()).toBe(true);
		expect(await ledger.checkPreRepair()).toBe(false);

		const costLedger = new BudgetLedger({ limitUsd: 0.5 });
		costLedger.recordRequest({
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0.3, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.6 },
		});
		expect(await costLedger.checkPreStage()).toBe(false);
	});

	it("reset clears spend but keeps constructor limits including a zero request cap", () => {
		const led = new BudgetLedger({ limitUsd: 1, maxRequests: 0 });
		led.recordRequest(undefined, "p1");
		led.reset();
		const snap = led.snapshot();
		expect(snap.limitUsd).toBe(1);
		expect(snap.requests).toBe(0);
		expect(snap.costKnown).toBe(true);
		expect(led.canStartExternalCall()).toBe(false);
	});

	it("marks a missing snapshot as unknown coverage instead of known zero", () => {
		const led = new BudgetLedger({ limitUsd: 5 });
		led.markUnrecordedCoverage();
		const snap = led.snapshot();
		expect(snap.costKnown).toBe(false);
		expect(snap.costUsd).toBeNull();
		expect(snap.unknownCostRequestCount).toBeGreaterThanOrEqual(1);
		expect(snap.knownCostLowerBoundUsd).toBe(0);
	});

	it("does not turn a legacy unknown numeric total into a known zero", () => {
		const led = new BudgetLedger({ limitUsd: 5 });
		led.restore({ costKnown: false, costUsd: 0, requests: 3 });
		const snap = led.snapshot();
		expect(snap.costKnown).toBe(false);
		expect(snap.costUsd).toBeNull();
		expect(snap.requests).toBe(3);
	});

	it("upgrades one unknown provider charge without counting it twice", () => {
		const led = new BudgetLedger({ limitUsd: 10 });
		const charge = {
			idempotencyKey: "wf:att:inv:ord:1",
			workflowId: "wf",
			attemptId: "att",
			invocationId: "inv",
			profileId: "p1",
			unit: "provider" as const,
			launched: true,
			settlesCost: true,
		};
		led.recordCharge({ ...charge, usage: null });
		led.recordCharge({
			...charge,
			usage: {
				input: 2,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 },
			},
		});
		const snap = led.snapshot();
		expect(snap.providerRequests).toBe(1);
		expect(snap.requests).toBe(0);
		expect(snap.knownCostLowerBoundUsd).toBe(0.2);
		expect(snap.unknownCostRequestCount).toBe(0);
		expect(snap.costKnown).toBe(true);
		expect(led.hasCharge(charge.idempotencyKey)).toBe(true);
	});

	it("does not count a local precheck that never launched", () => {
		const led = new BudgetLedger({ limitUsd: 10 });
		led.recordCharge({
			idempotencyKey: "local",
			unit: "invocation",
			launched: false,
			settlesCost: true,
		});
		expect(led.snapshot().requests).toBe(0);
		expect(led.snapshot().unknownCostRequestCount).toBe(0);
	});
});

describe("workflow budget port reservation", () => {
	it("reserves maxRequests on the first provider handoff and keeps later turns on the same invocation", () => {
		const ledger = new BudgetLedger({ limitUsd: 10, maxRequests: 1 });
		const port = createWorkflowBudgetPort(ledger);
		const first = port.bind({
			workflowId: "wf",
			attemptId: "att",
			invocationId: "left",
			profileId: "grok_implementer",
			maxRequests: 1,
		});
		const second = port.bind({
			workflowId: "wf",
			attemptId: "att",
			invocationId: "right",
			profileId: "grok_implementer",
			maxRequests: 1,
		});
		first.beforeProviderRequest({ ordinal: 1 });
		expect(() => second.beforeProviderRequest({ ordinal: 1 })).toThrow(BudgetExhaustedError);
		first.beforeProviderRequest({ ordinal: 2 });
		const snap = ledger.snapshot();
		expect(snap.requests).toBe(1);
		expect(snap.providerRequests).toBe(2);
		expect(snap.unknownCostRequestCount).toBe(2);
	});
});
