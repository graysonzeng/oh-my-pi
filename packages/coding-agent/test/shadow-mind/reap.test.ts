import { describe, expect, it } from "bun:test";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runShadowCohort } from "@oh-my-pi/pi-coding-agent/shadow-mind/cohort";

describe("shadow cohort reap", () => {
	it("disposes each child once when the parent aborts", async () => {
		const disposeCounts = new Map<string, number>();
		const parent = {
			messages: [],
			systemPrompt: ["reviewer"],
			model: { id: "mock-model", provider: "mock", api: "mock" },
			configuredThinkingLevel: () => undefined,
			thinkingLevel: undefined,
			modelRegistry: { authStorage: {} },
			settings: {},
			sessionManager: { getSessionId: () => "s", appendCustomEntry: () => {} },
		} as unknown as AgentSession;

		const parentAbort = new AbortController();
		const createSession: typeof import("@oh-my-pi/pi-coding-agent/sdk").createAgentSession = async options => {
			const id = String(options?.agentId);
			parentAbort.abort();
			return {
				session: {
					getActiveToolNames: () => ["read", "grep", "glob", "report_to_main"],
					prompt: async () => {
						await new Promise(() => {});
					},
					waitForIdle: async () => {},
					abort: async () => {},
					dispose: async () => {
						disposeCounts.set(id, (disposeCounts.get(id) ?? 0) + 1);
					},
				},
			} as unknown as CreateAgentSessionResult;
		};

		await runShadowCohort({
			parent,
			cwd: "/tmp",
			reviewerAgentId: "Owner",
			signal: parentAbort.signal,
			reportProgress: async () => {},
			markRunning: () => {},
			createSession,
			perChildTimeoutSeconds: 1,
			drainTimeoutSeconds: 1,
		});

		expect(disposeCounts.size).toBe(4);
		for (const count of disposeCounts.values()) {
			expect(count).toBe(1);
		}
	});
});
