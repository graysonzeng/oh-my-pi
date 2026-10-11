import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { IrcBus, type IrcMessage } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import type { CustomMessage } from "../../src/session/messages";
import { attachIrcWakeTurnMonitor } from "../../src/task/executor";
import { createSessionDefaults } from "../helpers/session-defaults";

beforeEach(() => {
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

for (const scenario of [
	"report",
	"schema-reject",
	"waiting",
	"reply",
	"sibling",
	"replaced-parent",
	"timeout",
] as const) {
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
			...createSessionDefaults(),
			settings: Settings.isolated(),
			setIrcWakeTurnObserver: (callback: typeof observe) => {
				observe = callback;
			},
			subscribe: () => () => {},
			trackIrcReply: () => {},
			getLastAssistantMessage: () => ({
				role: "assistant",
				content: [
					{
						type: "text",
						text:
							scenario === "schema-reject"
								? JSON.stringify({ verdict: "approve" })
								: "Authorization remains unchecked.",
					},
				],
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
			...(scenario === "schema-reject"
				? {
						outputSchema: {
							type: "object",
							properties: { approved: { type: "boolean" } },
							required: ["approved"],
						},
					}
				: {}),
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
		} else if (scenario === "sibling" || scenario === "timeout") {
			// Generic IrcBus relay: sibling wakes target Sibling (not Parent);
			// aborted/timeout wakes do not auto-relay. trackIrcReply still
			// settles in the observer finally so await:true waiters unblock.
			expect(received).toHaveLength(0);
		} else {
			// report / schema-reject / reply / replaced-parent: bus.send to the
			// waker id, delivered via Parent.deliverIrcMessage. Body is the
			// turn text (no parent-only status envelope).
			expect(received).toHaveLength(1);
			expect(received[0]?.replyTo).toBe("request-1");
			if (scenario === "schema-reject") {
				expect(received[0]?.body).toContain(JSON.stringify({ verdict: "approve" }));
			} else {
				expect(received[0]?.body).toContain("Authorization remains unchecked.");
			}
		}
	});
}

describe("IRC wake artifact refresh", () => {
	const tempDirs: TempDir[] = [];
	afterEach(async () => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
	});

	const REVIEW_SCHEMA = {
		type: "object",
		properties: { approved: { type: "boolean" } },
		required: ["approved"],
	} as const;

	async function runWake(args: {
		artifactsDir: string;
		finalText: string;
		outputSchema?: unknown;
		turnError?: unknown;
	}): Promise<void> {
		let observe: ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
		const parent = {
			deliverIrcMessage: async () => "injected",
		} as unknown as AgentSession;
		const child = {
			...createSessionDefaults(),
			settings: Settings.isolated(),
			setIrcWakeTurnObserver: (callback: typeof observe) => {
				observe = callback;
			},
			subscribe: () => () => {},
			trackIrcReply: () => {},
			getLastAssistantMessage: () => ({
				role: "assistant",
				content: [{ type: "text", text: args.finalText }],
				stopReason: "stop",
			}),
			abort: async () => {},
		} as unknown as AgentSession;
		const registry = AgentRegistry.global();
		registry.register({ id: "Parent", displayName: "Parent", kind: "main", session: parent });
		registry.register({ id: "Review", displayName: "Review", kind: "sub", parentId: "Parent", session: child });
		attachIrcWakeTurnMonitor(child, {
			id: "Review",
			agent: { name: "reviewer", description: "Review", systemPrompt: "", source: "bundled" },
			performanceClass: "review",
			maxRuntimeMs: 0,
			softRequestBudget: 0,
			artifactsDir: args.artifactsDir,
			...(args.outputSchema !== undefined ? { outputSchema: args.outputSchema } : {}),
		});
		const finish = observe!([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "Please continue",
				display: true,
				details: { id: "request-1", from: "Parent", message: "Please continue" },
				attribution: "agent",
				timestamp: Date.now(),
			},
		]);
		await finish?.(args.turnError);
	}

	it("replaces the completed artifact when a schema-bound wake turn ends with a valid final", async () => {
		// The completed first run left a PASS artifact. A hub wake then ends
		// with a schema-valid final message (no yield tool call). The valid
		// final is authoritative and must refresh <Review>.md so the parent's
		// agent:// link tracks the latest verdict (issue #9518 follow-up).
		const dir = TempDir.createSync("@pi-irc-artifact-valid-");
		tempDirs.push(dir);
		const artifactPath = path.join(dir.path(), "Review.md");
		await Bun.write(artifactPath, "# PASS\n\nApproved on first review.\n");

		await runWake({
			artifactsDir: dir.path(),
			finalText: JSON.stringify({ approved: false, verdict: "needs_revision" }),
			outputSchema: {
				...REVIEW_SCHEMA,
				properties: { approved: { type: "boolean" }, verdict: { type: "string" } },
			},
		});

		const refreshed = await Bun.file(artifactPath).text();
		expect(JSON.parse(refreshed)).toEqual({ approved: false, verdict: "needs_revision" });
		expect(refreshed).not.toContain("# PASS");
	});

	it("keeps the completed artifact when a chat-only wake completes without a schema final", async () => {
		const dir = TempDir.createSync("@pi-irc-artifact-chat-");
		tempDirs.push(dir);
		const artifactPath = path.join(dir.path(), "Review.md");
		const completedReport = "# Completed report\n\nfull multi-paragraph body\n\nZZEND";
		await Bun.write(artifactPath, completedReport);

		// A conversational wake answering a hub message produces plain prose and
		// is not a schema-bound completion — it must not clobber the artifact.
		await runWake({
			artifactsDir: dir.path(),
			finalText: "Thanks, the report is already complete.",
		});

		expect(await Bun.file(artifactPath).text()).toBe(completedReport);
	});

	it("keeps the completed artifact when a no-schema wake happens to end with JSON-looking text", async () => {
		const dir = TempDir.createSync("@pi-irc-artifact-jsonchat-");
		tempDirs.push(dir);
		const artifactPath = path.join(dir.path(), "Review.md");
		const completedReport = "# PASS\n\nApproved on first review.\n";
		await Bun.write(artifactPath, completedReport);

		// The wake content happens to parse as JSON, but no output schema is
		// bound: a chat-only wake is not a schema-bound completion and must not
		// refresh <id>.md just because its text looks like a structured payload.
		await runWake({
			artifactsDir: dir.path(),
			finalText: JSON.stringify({ approved: true, verdict: "approved" }),
		});

		expect(await Bun.file(artifactPath).text()).toBe(completedReport);
	});

	it("keeps the completed artifact when a schema-bound wake final is invalid", async () => {
		const dir = TempDir.createSync("@pi-irc-artifact-invalid-");
		tempDirs.push(dir);
		const artifactPath = path.join(dir.path(), "Review.md");
		const completedReport = "# PASS\n\nApproved on first review.\n";
		await Bun.write(artifactPath, completedReport);

		// Schema-bound but malformed: the wake failed to produce a valid final,
		// so the authoritative PASS artifact survives untouched.
		await runWake({
			artifactsDir: dir.path(),
			finalText: JSON.stringify({ verdict: "approve" }),
			outputSchema: REVIEW_SCHEMA,
		});

		expect(await Bun.file(artifactPath).text()).toBe(completedReport);
	});

	it("keeps the completed artifact when a wake turn is cancelled even after a valid-looking message", async () => {
		const dir = TempDir.createSync("@pi-irc-artifact-cancel-");
		tempDirs.push(dir);
		const artifactPath = path.join(dir.path(), "Review.md");
		const completedReport = "# PASS\n\nApproved on first review.\n";
		await Bun.write(artifactPath, completedReport);

		// The turn was cancelled (turn error) — a cancelled final must never
		// overwrite the completed run's artifact, even if the last message text
		// would otherwise validate against the schema.
		await runWake({
			artifactsDir: dir.path(),
			finalText: JSON.stringify({ approved: true }),
			outputSchema: REVIEW_SCHEMA,
			turnError: new Error("turn cancelled"),
		});

		expect(await Bun.file(artifactPath).text()).toBe(completedReport);
	});
});
