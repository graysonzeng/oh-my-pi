import { beforeEach, describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { BudgetLedger } from "../../src/workflow/budget-ledger";

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
});
