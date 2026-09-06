import { describe, expect, it } from "bun:test";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

type ProactiveDelegationFlags = Pick<
	BuildSystemPromptOptions,
	"taskProactiveAutoParallel" | "taskProactivePipelineGuidance" | "taskProactiveStageRouting" | "taskIrcEnabled"
>;

async function renderDelegationPrompt(
	options: ProactiveDelegationFlags & { eagerTasks?: boolean; model?: string } = {},
): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: process.cwd(),
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["task", "workflow"],
		workspaceTree: { ...EMPTY_TREE, rootPath: process.cwd() },
		eagerTasks: true,
		...options,
	});
	return systemPrompt.join("\n\n");
}

describe("proactive delegation guidance", () => {
	it("defaults all proactive delegation flags to false", () => {
		expect(getDefault("task.proactive.autoParallel")).toBe(false);
		expect(getDefault("task.proactive.pipelineGuidance")).toBe(false);
		expect(getDefault("task.proactive.stageRouting")).toBe(false);
	});

	it("toggles auto-parallel guidance independently", async () => {
		const rendered = await renderDelegationPrompt({ taskProactiveAutoParallel: true });

		expect(rendered).toContain("Auto-parallelize only real width.");
		expect(rendered).toContain("at least 2 independent runnable slices");
		expect(rendered).not.toContain("Escalate complete gated delivery to workflow.");
		expect(rendered).not.toContain("Route through existing agents.");
	});

	it("toggles pipeline guidance independently", async () => {
		const rendered = await renderDelegationPrompt({ taskProactivePipelineGuidance: true });

		expect(rendered).not.toContain("Auto-parallelize only real width.");
		expect(rendered).toContain("Escalate complete gated delivery to workflow.");
		expect(rendered).not.toContain("Route through existing agents.");
	});

	it("toggles stage routing guidance independently", async () => {
		const rendered = await renderDelegationPrompt({ taskProactiveStageRouting: true });

		expect(rendered).not.toContain("Auto-parallelize only real width.");
		expect(rendered).not.toContain("Escalate complete gated delivery to workflow.");
		expect(rendered).toContain("Route through existing agents.");
		expect(rendered).toContain("Mechanical implementation");
		expect(rendered).toContain("`sonic`");
	});

	it("renders the shared proactive blocks for Codex eager mode", async () => {
		const rendered = await renderDelegationPrompt({
			model: "openai/gpt-5.6-codex",
			taskProactiveAutoParallel: true,
			taskProactivePipelineGuidance: true,
			taskProactiveStageRouting: true,
		});

		expect(rendered).toContain("Proactive multi-agent delegation is active.");
		expect(rendered).toContain("Auto-parallelize only real width.");
		expect(rendered).toContain("Escalate complete gated delivery to workflow.");
		expect(rendered).toContain("Route through existing agents.");
	});

	it("gates every proactive block behind eagerTasks", async () => {
		const rendered = await renderDelegationPrompt({
			eagerTasks: false,
			model: "openai/gpt-5.6-codex",
			taskProactiveAutoParallel: true,
			taskProactivePipelineGuidance: true,
			taskProactiveStageRouting: true,
		});

		expect(rendered).toContain(
			"Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask",
		);
		expect(rendered).not.toContain("Auto-parallelize only real width.");
		expect(rendered).not.toContain("Escalate complete gated delivery to workflow.");
		expect(rendered).not.toContain("Route through existing agents.");
	});

	it("preflights and reuses an exact late reviewer when IRC is available", async () => {
		const rendered = await renderDelegationPrompt({ taskIrcEnabled: true });

		expect(rendered).toContain("a mandatory end-stage gate after substantial independent work");
		expect(rendered).toContain("fallback or identity mismatch as failed readiness");
		expect(rendered).toContain("launch that exact reviewer early");
		expect(rendered).toContain("NEVER a greeting or synthetic ping");
		expect(rendered).toContain("wake that same idle/parked agent");
		expect(rendered).toContain("cancel or ignore any late loser");
		expect(rendered).not.toContain("No continuation channel");
	});

	it("does not claim reviewer reuse without IRC", async () => {
		const rendered = await renderDelegationPrompt();

		expect(rendered).toContain("never claim that a successful probe reserves or reuses a reviewer");
		expect(rendered).not.toContain("Reuse the checked reviewer");
		expect(rendered).not.toContain("wake that same idle/parked agent");
	});

	it("does not render the old unconditional default-to-parallel guidance", async () => {
		const rendered = await renderDelegationPrompt();

		expect(rendered).not.toContain("Default to parallel for complex changes.");
	});
});
