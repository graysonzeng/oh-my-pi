import { describe, expect, it } from "bun:test";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runShadowCohort } from "@oh-my-pi/pi-coding-agent/shadow-mind/cohort";
import { SHADOW_DIMENSION_IDS } from "@oh-my-pi/pi-coding-agent/shadow-mind/types";

function fakeParent(): AgentSession {
	return {
		messages: [{ role: "user", content: "review this patch", timestamp: Date.now() }],
		systemPrompt: ["you are a reviewer"],
		model: { id: "mock-model", provider: "mock", api: "mock" },
		configuredThinkingLevel: () => "medium",
		thinkingLevel: "medium",
		modelRegistry: { authStorage: {} },
		settings: {},
		sessionManager: {
			getSessionId: () => "sess-1",
			appendCustomEntry: () => {},
		},
		getAgentId: () => "ReviewerOne",
	} as unknown as AgentSession;
}

describe("shadow cohort dimension statuses", () => {
	it("maps report, silent, timeout, and error without treating silent as uncovered", async () => {
		const parent = fakeParent();
		const disposed: string[] = [];
		const createSession: typeof import("@oh-my-pi/pi-coding-agent/sdk").createAgentSession = async options => {
			const shadowId = String(options?.agentId ?? "").split(":shadow:")[1];
			const session = {
				getActiveToolNames: () => ["read", "grep", "glob", "report_to_main"],
				prompt: async () => {
					if (shadowId === "architecture-review") {
						const tool = options?.customTools?.[0] as
							| { execute?: (...args: never[]) => Promise<unknown> }
							| undefined;
						await tool?.execute?.("t" as never, { content: "arch" } as never);
						return;
					}
					if (shadowId === "correctness-review") {
						await new Promise(() => {});
					}
					if (shadowId === "completion-review") {
						throw new Error("boom");
					}
				},
				waitForIdle: async () => {},
				abort: async () => {},
				dispose: async () => {
					disposed.push(shadowId ?? "unknown");
				},
			};
			return { session } as unknown as CreateAgentSessionResult;
		};

		const text = await runShadowCohort({
			parent,
			cwd: "/tmp",
			reviewerAgentId: "ReviewerOne",
			signal: new AbortController().signal,
			reportProgress: async () => {},
			markRunning: () => {},
			createSession,
			perChildTimeoutSeconds: 0.05,
			drainTimeoutSeconds: 1,
		});

		expect(text).toContain("architecture-review: reported");
		expect(text).toContain("grounded-review: completed_no_finding");
		expect(text).toContain("correctness-review: timeout");
		expect(text).toContain("completion-review: error");
		expect(text).not.toMatch(/grounded-review: (timeout|error|aborted)/);
		expect(disposed.sort()).toEqual([...SHADOW_DIMENSION_IDS].sort());
	});
});
