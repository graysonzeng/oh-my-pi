import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { ASYNC_RESULT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SHADOW_DIMENSION_IDS, SHADOW_REVIEW_JOB_LABEL } from "@oh-my-pi/pi-coding-agent/shadow-mind";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const SOURCE = "shadow-review-smoke";
const reviewerAgent: AgentDefinition = {
	name: "reviewer",
	description: "test reviewer",
	systemPrompt:
		"Review the assignment. Yield when done. If an async-result with this evidence packet arrives, mention it in explanation.",
	shadowReview: "code",
	tools: ["read", "grep", "glob"],
	source: "bundled",
};

function stringifyContext(context: { systemPrompt?: string[]; messages: unknown[] }): string {
	return `${(context.systemPrompt ?? []).join("\n")}\n${JSON.stringify(context.messages)}`;
}

describe("shadow-review executor smoke", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		unregisterCustomApis(SOURCE);
		vi.restoreAllMocks();
		await AsyncJobManager.instance()?.dispose();
		AsyncJobManager.resetForTests();
		for (const dir of tempDirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	it("fail-open: disabled setting registers no job and still yields", async () => {
		registerMockApi(SOURCE);
		const mock = createMockModel({
			handler: () => ({
				content: [
					{
						type: "toolCall",
						name: "yield",
						arguments: {
							result: { data: { overall_correctness: "correct", explanation: "solo", confidence: 1 } },
						},
					},
				],
			}),
		});
		const orig = sdkModule.createAgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options =>
			orig({ ...options, model: mock.model }),
		);
		const manager = new AsyncJobManager({ maxRunningJobs: 8 });
		AsyncJobManager.setInstance(manager);
		const tempDir = path.join(os.tmpdir(), `pi-shadow-failopen-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const result = await runSubprocess({
			cwd: tempDir,
			agent: reviewerAgent,
			task: "review the fixture patch",
			index: 0,
			id: "FailOpenReviewer",
			modelRegistry,
			authStorage,
			settings: Settings.isolated({ "task.shadowReview.enabled": false }),
		});
		expect(result.error ?? result.stderr ?? "").toBe("");
		expect(result.exitCode).toBe(0);
		expect(manager.getRunningJobs({ ownerId: "FailOpenReviewer" })).toEqual([]);
		authStorage.close();
	});

	it("registers a cohort, delivers one shadow-review async-result, and disposes four children", async () => {
		registerMockApi(SOURCE);
		const yieldExplanations: string[] = [];
		let releaseChildren = () => {};
		const childrenHeld = new Promise<void>(resolve => {
			releaseChildren = resolve;
		});
		const mock = createMockModel({
			handler: context => {
				const blob = stringifyContext(context);
				const toolNames = (context.tools ?? []).map(tool => tool.name);
				if (toolNames.includes("report_to_main")) {
					if (blob.includes("architectural defects")) {
						return {
							content: [
								{
									type: "toolCall",
									name: "report_to_main",
									arguments: { content: "architecture note" },
								},
							],
						};
					}
					return { content: ["NOT_RELEVANT"] };
				}
				const hasShadow = blob.includes("Shadow review evidence");
				const explanation = hasShadow ? "fresh after shadow-review" : "early yield";
				yieldExplanations.push(explanation);
				if (yieldExplanations.length === 1) releaseChildren();
				return {
					content: [
						{
							type: "toolCall",
							name: "yield",
							arguments: {
								result: {
									data: {
										overall_correctness: "correct",
										explanation,
										confidence: 0.9,
									},
								},
							},
						},
					],
				};
			},
		});
		const orig = sdkModule.createAgentSession;
		const childAgentIds: string[] = [];
		const disposeSpies: Array<ReturnType<typeof vi.spyOn>> = [];
		let parentSession: { messages: Array<{ role?: string; customType?: string; details?: unknown }> } | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (options?.isolatedChild) await childrenHeld;
			const created = await orig({ ...options, model: options?.model ?? mock.model });
			if (options?.isolatedChild) {
				expect(options.model?.id).toBe(mock.model.id);
				childAgentIds.push(String(options.agentId));
				disposeSpies.push(vi.spyOn(created.session, "dispose"));
			} else {
				parentSession = created.session;
			}
			return created;
		});
		const manager = new AsyncJobManager({ maxRunningJobs: 8 });
		AsyncJobManager.setInstance(manager);
		const tempDir = path.join(os.tmpdir(), `pi-shadow-smoke-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const result = await runSubprocess({
			cwd: tempDir,
			agent: reviewerAgent,
			task: "review the fixture patch at packages/coding-agent/src/sdk.ts",
			index: 0,
			id: "SmokeReviewer",
			modelRegistry,
			authStorage,
			settings: Settings.isolated({ "task.shadowReview.enabled": true }),
		});

		expect(result.exitCode).toBe(0);
		expect(yieldExplanations[0]).toBe("early yield");
		expect(yieldExplanations.at(-1)).toBe("fresh after shadow-review");
		expect(yieldExplanations.length).toBeGreaterThan(1);
		const lastYield = result.extractedToolData?.yield?.at(-1) as { data?: { explanation?: string } } | undefined;
		expect(lastYield?.data?.explanation).toBe("fresh after shadow-review");
		expect(result.output).toContain("fresh after shadow-review");
		expect(result.output).not.toContain("early yield");

		const expectedChildIds = SHADOW_DIMENSION_IDS.map(id => `SmokeReviewer:shadow:${id}`);
		expect(childAgentIds.sort()).toEqual([...expectedChildIds].sort());
		expect(new Set(childAgentIds).size).toBe(4);
		expect(childAgentIds).not.toContain(MAIN_AGENT_ID);
		expect(disposeSpies).toHaveLength(4);
		for (const spy of disposeSpies) {
			expect(spy).toHaveBeenCalledTimes(1);
		}

		const asyncResults = (parentSession?.messages ?? []).filter(
			message => message.role === "custom" && message.customType === ASYNC_RESULT_MESSAGE_TYPE,
		);
		expect(asyncResults).toHaveLength(1);
		const report = String((asyncResults[0] as { content?: unknown } | undefined)?.content ?? "");
		expect(report).toContain("architecture-review: reported");
		expect(report).toContain("grounded-review: completed_no_finding");
		expect(report).toContain("correctness-review: completed_no_finding");
		expect(report).toContain("completion-review: completed_no_finding");
		const jobs = (asyncResults[0]?.details as { jobs?: Array<{ label?: string }> } | undefined)?.jobs ?? [];
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.label).toBe(SHADOW_REVIEW_JOB_LABEL);
		authStorage.close();
	});
});
