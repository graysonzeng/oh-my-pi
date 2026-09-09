/**
 * Production assembly for subagent system prompts.
 *
 * Stable role/rules/completion first; task-specific context, plan, worktree,
 * peers, and schema after. Inserted before the default prompt's last
 * environment block so cwd/date stay last.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import "../config/prompt-templates";
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };

export interface SubagentSystemPromptInput {
	agent: string;
	context?: string;
	planReference?: string;
	planReferencePath?: string;
	worktree?: string;
	outputSchema?: unknown;
	outputSchemaOverridesAgent?: boolean;
	ircPeers?: string;
	ircSelfId?: string;
	exploreClass?: boolean;
	reviewClass?: boolean;
}

export function renderSubagentSystemPrompt(input: SubagentSystemPromptInput): string {
	return prompt.render(subagentSystemPromptTemplate, {
		agent: input.agent,
		context: input.context?.trim() ?? "",
		planReference: input.planReference ?? "",
		planReferencePath: input.planReferencePath ?? "",
		worktree: input.worktree ?? "",
		outputSchema: input.outputSchema,
		outputSchemaOverridesAgent: input.outputSchemaOverridesAgent === true,
		ircPeers: input.ircPeers ?? "",
		ircSelfId: input.ircSelfId ?? "",
		exploreClass: input.exploreClass === true,
		reviewClass: input.reviewClass === true,
	});
}

export function assembleSubagentSystemPrompt(defaultPrompt: string[], input: SubagentSystemPromptInput): string[] {
	const subagentPrompt = renderSubagentSystemPrompt(input);
	return defaultPrompt.length === 0
		? [subagentPrompt]
		: [...defaultPrompt.slice(0, -1), subagentPrompt, defaultPrompt[defaultPrompt.length - 1]];
}
