import { describe, expect, it } from "bun:test";
import {
	successRateByAgent,
	taskOutcomesFromAsyncResultDetails,
	taskOutcomesFromToolDetails,
} from "../../src/stats/task-outcome";
import { settledTaskDeliveryFields } from "../../src/session/async-job-delivery";

describe("task-outcome persistence contract", () => {
	it("reads finalStatus from async-result jobs when details.results is empty", () => {
		const settled = settledTaskDeliveryFields({
			id: "scout_0",
			agentId: "scout_0",
			latestDetails: {
				results: [],
				progress: [{ id: "scout_0", agent: "scout", status: "completed", exitCode: 0 }],
			},
		});
		expect(settled.finalStatus).toBe("success");
		expect(settled.agent).toBe("scout");
		expect(settled.status).toBe("completed");
		expect(settled.exitCode).toBe(0);

		const rows = taskOutcomesFromAsyncResultDetails({
			jobs: [
				{
					jobId: "scout_0",
					agentUrlId: "scout_0",
					agent: "scout",
					finalStatus: "success",
					status: "completed",
					exitCode: 0,
				},
				{
					jobId: "task_1",
					agent: "task",
					finalStatus: "failed",
					exitCode: 1,
				},
			],
		});
		expect(rows.map(r => [r.agent, r.finalStatus])).toEqual([
			["scout", "success"],
			["task", "failed"],
		]);
		const rates = successRateByAgent(rows);
		expect(rates.scout).toEqual({ total: 1, success: 1, rate: 1 });
		expect(rates.task).toEqual({ total: 1, success: 0, rate: 0 });
	});

	it("prefers details.results when present and maps aborted", () => {
		const rows = taskOutcomesFromToolDetails({
			results: [{ id: "r1", agent: "reviewer", aborted: true, exitCode: 1 }],
			progress: [],
		});
		expect(rows).toEqual([{ id: "r1", agent: "reviewer", finalStatus: "aborted", source: "results" }]);
	});
});
