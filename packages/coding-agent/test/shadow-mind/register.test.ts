import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { tryRegisterShadowReviewJob } from "@oh-my-pi/pi-coding-agent/shadow-mind";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

const reviewerAgent: AgentDefinition = {
	name: "reviewer",
	description: "test reviewer",
	systemPrompt: "review",
	shadowReview: "code",
	source: "bundled",
};

const shadowEnabledSettings = () => Settings.isolated({ "task.shadowReview.enabled": true });

function sessionStub(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		model: { id: "mock-model", provider: "mock", api: "mock" },
		getAgentId: () => "RegisterReviewer",
		...overrides,
	} as unknown as AgentSession;
}

describe("tryRegisterShadowReviewJob fail-open", () => {
	afterEach(async () => {
		await AsyncJobManager.instance()?.dispose();
		AsyncJobManager.resetForTests();
	});

	it("does not register when AsyncJobManager is missing", () => {
		const id = tryRegisterShadowReviewJob({
			session: sessionStub({ asyncJobManager: undefined }),
			agent: reviewerAgent,
			cwd: "/tmp",
			restrictToolNames: false,
			settings: shadowEnabledSettings(),
		});
		expect(id).toBeUndefined();
	});

	it("does not register when the parent session has no model", () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 8 });
		AsyncJobManager.setInstance(manager);
		const id = tryRegisterShadowReviewJob({
			session: sessionStub({ asyncJobManager: manager, model: undefined }),
			agent: reviewerAgent,
			cwd: "/tmp",
			restrictToolNames: false,
			settings: shadowEnabledSettings(),
		});
		expect(id).toBeUndefined();
		expect(manager.getRunningJobs({ ownerId: "RegisterReviewer" })).toEqual([]);
	});

	it("does not register when manager.register throws", () => {
		const manager = {
			register: () => {
				throw new Error("Background job limit reached (1). Wait for running jobs to finish or cancel one.");
			},
			getRunningJobs: () => [],
		} as unknown as AsyncJobManager;
		const id = tryRegisterShadowReviewJob({
			session: sessionStub({ asyncJobManager: manager }),
			agent: reviewerAgent,
			cwd: "/tmp",
			restrictToolNames: false,
			settings: shadowEnabledSettings(),
		});
		expect(id).toBeUndefined();
	});

	it("does not register a bundled reviewer when the setting is left at default off", () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 8 });
		AsyncJobManager.setInstance(manager);
		const id = tryRegisterShadowReviewJob({
			session: sessionStub({ asyncJobManager: manager }),
			agent: reviewerAgent,
			cwd: "/tmp",
			restrictToolNames: false,
			settings: Settings.isolated(),
		});
		expect(id).toBeUndefined();
		expect(manager.getRunningJobs({ ownerId: "RegisterReviewer" })).toEqual([]);
	});
});
