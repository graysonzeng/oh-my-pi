import { afterEach, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { IrcBus, type IrcMessage } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import type { CustomMessage } from "../../src/session/messages";
import { attachIrcWakeTurnMonitor } from "../../src/task/executor";

afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

for (const scenario of ["report", "waiting", "reply", "sibling", "replaced-parent", "timeout"] as const) {
	it(`IRC wake report delivery: ${scenario}`, async () => {
		let observe: ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
		const received: IrcMessage[] = [];
		let waited: Promise<IrcMessage | null> | undefined;
		const aborted = Promise.withResolvers<void>();
		const parent = {
			deliverIrcMessage: async (message: IrcMessage) => {
				received.push(message);
				return "injected";
			},
		} as unknown as AgentSession;
		const child = {
			settings: Settings.isolated(),
			setIrcWakeTurnObserver: (callback: typeof observe) => {
				observe = callback;
			},
			subscribe: () => () => {},
			getLastAssistantMessage: () => ({
				role: "assistant",
				content: [{ type: "text", text: "Authorization remains unchecked." }],
				stopReason: scenario === "timeout" ? "aborted" : "stop",
				errorMessage: scenario === "timeout" ? "runtime limit exceeded" : undefined,
			}),
			abort: async () => {
				aborted.resolve();
			},
		} as unknown as AgentSession;
		const registry = AgentRegistry.global();
		registry.register({ id: "Parent", displayName: "Parent", kind: "main", session: parent });
		registry.register({ id: "Review", displayName: "Review", kind: "sub", parentId: "Parent", session: child });
		attachIrcWakeTurnMonitor(child, {
			id: "Review",
			agent: { name: "reviewer", description: "Review", systemPrompt: "", source: "bundled" },
			performanceClass: "review",
			maxRuntimeMs: scenario === "timeout" ? 10 : 0,
			softRequestBudget: 0,
		});
		const finish = observe!([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "Review authorization",
				display: true,
				details: {
					id: "request-1",
					from: scenario === "sibling" ? "Sibling" : "Parent",
					...(scenario === "reply" ? { replyTo: "earlier" } : {}),
				},
				timestamp: 0,
			},
		]);
		if (scenario === "replaced-parent") {
			registry.register({ id: "Parent", displayName: "New parent", kind: "main", session: parent });
		}
		if (scenario === "waiting") {
			waited = IrcBus.global().wait("Parent", { from: "Review" }, 0);
		}
		if (scenario === "timeout") {
			await aborted.promise;
		}
		await finish!();
		await finish!();
		if (scenario === "waiting") {
			const message = await waited!;
			expect(message?.replyTo).toBe("request-1");
			expect(message?.body).toContain("Authorization remains unchecked.");
			expect(received).toHaveLength(0);
		} else if (scenario === "report" || scenario === "timeout") {
			expect(received).toHaveLength(1);
			expect(received[0]?.replyTo).toBe("request-1");
			expect(received[0]?.body).toContain("Authorization remains unchecked.");
			expect(received[0]?.body).not.toContain('status="completed"');
			expect(received[0]?.body).toContain(
				scenario === "timeout" ? 'completionKind="timeout"' : "required terminal verdict",
			);
		} else {
			expect(received).toHaveLength(0);
		}
	});
}
