import type { Usage } from "@oh-my-pi/pi-ai";

export interface BudgetSnapshot {
	limitUsd: number;
	costUsd: number;
	requests: number;
	tokensIn: number;
	tokensOut: number;
}

export class BudgetLedger {
	readonly #limitUsd: number;
	#costUsd = 0;
	#requests = 0;
	#tokensIn = 0;
	#tokensOut = 0;

	constructor(limitUsd = 10) {
		this.#limitUsd = limitUsd;
	}

	async checkPreStage(): Promise<boolean> {
		return this.#costUsd < this.#limitUsd;
	}

	recordRequest(usage?: Usage): void {
		this.#requests += 1;
		this.#tokensIn += usage?.input ?? 0;
		this.#tokensOut += usage?.output ?? 0;
		this.#costUsd += usage?.cost.total ?? 0;
	}

	snapshot(): BudgetSnapshot {
		return {
			limitUsd: this.#limitUsd,
			costUsd: this.#costUsd,
			requests: this.#requests,
			tokensIn: this.#tokensIn,
			tokensOut: this.#tokensOut,
		};
	}
}
