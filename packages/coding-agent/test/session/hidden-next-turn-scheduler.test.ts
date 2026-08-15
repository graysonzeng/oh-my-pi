import { describe, expect, it } from "bun:test";
import { HiddenNextTurnScheduler } from "../../src/session/hidden-next-turn-scheduler";

describe("hidden next-turn scheduler", () => {
	it("emits one pre-accept terminal and never a second agent_end", () => {
		const scheduler = new HiddenNextTurnScheduler("sess");
		const skip = scheduler.submit({ kind: "headless-goal", generation: 1, skip: "cap" });
		expect(skip.status).toBe("skip");
		if (skip.status !== "skip") return;
		expect(skip.phase).toBe("pre-accept");
		expect(scheduler.finalSettle(skip.deliveryId, "cap")).toBe(false);
	});

	it("pairs the same deliveryId after accept and retries without minting D2", () => {
		const scheduler = new HiddenNextTurnScheduler("sess");
		const accepted = scheduler.submit({ kind: "headless-goal", generation: 1 });
		expect(accepted.status).toBe("accepted");
		if (accepted.status !== "accepted") return;
		expect(scheduler.markNonterminal(accepted.deliveryId)).toBe(true);
		const retried = scheduler.submit({ kind: "headless-goal", generation: 1, resumeDeliveryId: accepted.deliveryId });
		expect(retried.status).toBe("accepted");
		if (retried.status !== "accepted") return;
		expect(retried.deliveryId).toBe(accepted.deliveryId);
		expect(retried.attempt).toBe(2);
		expect(scheduler.finalSettle(accepted.deliveryId, "error")).toBe(true);
		expect(scheduler.finalSettle(accepted.deliveryId, "error")).toBe(false);
	});

	it("keeps queued-user and hidden ids distinct", () => {
		const scheduler = new HiddenNextTurnScheduler("sess");
		const hidden = scheduler.submit({ kind: "headless-goal", generation: 1 });
		expect(hidden.status).toBe("accepted");
		if (hidden.status !== "accepted") return;
		scheduler.finalSettle(hidden.deliveryId, "completed");
		const queued = scheduler.submit({ kind: "queued-user", generation: 1 });
		expect(queued.status).toBe("accepted");
		if (queued.status !== "accepted") return;
		expect(queued.deliveryId).not.toBe(hidden.deliveryId);
		expect(queued.settleOwner).toBe("queued-user");
	});

	it("skips cap and ACP defer before accept so finalSettle is not required", () => {
		const scheduler = new HiddenNextTurnScheduler("sess");
		const cap = scheduler.submit({ kind: "headless-goal", generation: 1, skip: "cap" });
		expect(cap.status).toBe("skip");
		if (cap.status !== "skip") return;
		expect(cap.phase).toBe("pre-accept");
		expect(scheduler.record(cap.deliveryId)?.state).toBe("settled");
		expect(scheduler.unsettledNonterminals()).toEqual([]);
		const defer = scheduler.submit({ kind: "headless-goal", generation: 2, skip: "acp-defer" });
		expect(defer.status).toBe("skip");
		if (defer.status !== "skip") return;
		expect(defer.phase).toBe("pre-accept");
		expect(scheduler.finalSettle(defer.deliveryId, "acp-defer")).toBe(false);
	});
});
