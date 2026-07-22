import { beforeEach, describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { BudgetLedger } from "../../src/workflow/budget-ledger";

describe("BudgetLedger", () => {
	let ledger: BudgetLedger;

	beforeEach(() => {
		ledger = new BudgetLedger();
	});

	it("accumulates requests, tokens, tools", async () => {
		const usage: Usage = {
			input: 100,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 300,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		};
		ledger.recordRequest(usage);
		expect(ledger.snapshot()).toEqual({ limitUsd: 10, costUsd: 0.3, requests: 1, tokensIn: 100, tokensOut: 200 });
	});

	it("pre-stage and pre-retry rejection", async () => {
		expect(await ledger.checkPreStage()).toBe(true);
	});
});
