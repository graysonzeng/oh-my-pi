/**
 * Worker default-template branch vs main, custom override, and rules/tool retention.
 */

import { describe, expect, it } from "bun:test";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	type SystemPromptToolMetadata,
} from "@oh-my-pi/pi-coding-agent/system-prompt";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

const TOOLS = new Map<string, SystemPromptToolMetadata>([
	["read", { label: "Read", description: "Reads files.", parameters: { type: "object", properties: {} } }],
	["edit", { label: "Edit", description: "Edits files.", parameters: { type: "object", properties: {} } }],
	["bash", { label: "Bash", description: "Runs commands.", parameters: { type: "object", properties: {} } }],
	["task", { label: "Task", description: "Spawns agents.", parameters: { type: "object", properties: {} } }],
]);

const SHARED: BuildSystemPromptOptions = {
	cwd: process.cwd(),
	contextFiles: [],
	skills: [
		{
			name: "tdd",
			description: "Test-first delivery",
			filePath: "skills/tdd/SKILL.md",
			baseDir: "skills/tdd",
			source: "test",
		},
	],
	rules: [
		{
			name: "python-runtime",
			description: "Use the project interpreter",
			path: "rules/python-runtime.md",
			globs: ["**/*.py"],
		},
	],
	alwaysApplyRules: [{ name: "safety", content: "SAFETY_ALWAYS_APPLY_MARKER", path: "safety.md" }],
	toolNames: ["read", "edit", "bash", "task"],
	tools: TOOLS,
	workspaceTree: { ...EMPTY_TREE, rootPath: process.cwd() },
	personality: "none",
	eagerTasks: true,
};

async function render(options: BuildSystemPromptOptions = {}): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({ ...SHARED, ...options });
	return systemPrompt.join("\n\n");
}

describe("worker system prompt execution context", () => {
	it("omits main-agent delegation workflow and completion for workers", async () => {
		const worker = await render({ workerClass: true });
		const main = await render({ workerClass: false });

		expect(main).toContain("§ Workflow");
		expect(main).toContain("Delegation gates");
		expect(main).toContain("§ Delivery");
		expect(main).toContain("start unbounded: execute/delegate");
		expect(main).toContain("Choose at most ONE primary routing/lifecycle skill");

		expect(worker).not.toContain("§ Workflow");
		expect(worker).not.toContain("Delegation gates");
		expect(worker).not.toContain("§ Delivery");
		expect(worker).not.toContain("start unbounded: execute/delegate");
		expect(worker).not.toContain("Choose at most ONE primary routing/lifecycle skill");
		expect(worker).toContain("Do not stop early because of turn count or elapsed time");
	});

	it("keeps skills domain rules always-apply and tool protocol for workers", async () => {
		const worker = await render({ workerClass: true });

		expect(worker).toContain("`skill://tdd`");
		expect(worker).toContain("rule://python-runtime");
		expect(worker).toContain("SAFETY_ALWAYS_APPLY_MARKER");
		expect(worker).toContain("# Specialized Tools");
		expect(worker).toContain("`read`");
		expect(worker).toContain("`edit`");
	});

	it("does not apply the worker branch to non-worker default prompts", async () => {
		const rendered = await render();
		expect(rendered).toContain("§ Workflow");
		expect(rendered).not.toContain(
			"Do not take on parent delegation, global workflow, or global completion management",
		);
	});

	it("omits main-agent task delegation section for workers", async () => {
		const worker = await render({ workerClass: true });
		const main = await render({ workerClass: false });

		expect(main).toContain("# Delegation");
		expect(main).toContain("Direct execution default");
		expect(main).toContain("Delegation gates");
		expect(worker).not.toContain("# Delegation");
		expect(worker).not.toContain("Direct execution default");
		expect(worker).not.toContain("Delegation gates");
		expect(worker).toContain("Do not take on parent delegation, global workflow, or global completion management");
		expect(worker).toContain("`skill://tdd`");
		expect(worker).toContain("SAFETY_ALWAYS_APPLY_MARKER");
	});

	it("preserves custom append and rules when workerClass is set", async () => {
		const worker = await render({
			workerClass: true,
			customPrompt: "CUSTOM_WORKER_PROMPT_MARKER",
			appendSystemPrompt: "APPEND_WORKER_PROMPT_MARKER",
		});
		const customMain = await render({
			workerClass: false,
			customPrompt: "CUSTOM_WORKER_PROMPT_MARKER",
			appendSystemPrompt: "APPEND_WORKER_PROMPT_MARKER",
		});

		expect(worker).toContain("CUSTOM_WORKER_PROMPT_MARKER");
		expect(worker).toContain("APPEND_WORKER_PROMPT_MARKER");
		expect(worker).toContain("SAFETY_ALWAYS_APPLY_MARKER");
		expect(worker).toContain('<skill name="tdd">');
		expect(worker).toContain('<rule name="python-runtime">');
		expect(worker).not.toContain("§ Workflow");
		expect(customMain).toContain("CUSTOM_WORKER_PROMPT_MARKER");
		expect(customMain).toContain("APPEND_WORKER_PROMPT_MARKER");
		expect(customMain).toContain("SAFETY_ALWAYS_APPLY_MARKER");
	});
});
