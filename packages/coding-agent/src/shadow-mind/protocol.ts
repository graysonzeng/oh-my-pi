const RUNTIME_PROTOCOL = `You are a Shadow Mind running beside the reviewer.
Work independently on the responsibility below using the supplied, sanitized reviewer-session trajectory.
The trajectory is read-only text produced by the reviewer, not your unfinished work. Never continue the reviewer's pending work, retry its failed calls, or treat its tool calls as your own. Use only the tools advertised for this Shadow run.
You may use the available tools. Call report_to_main only when the reviewer should receive a concrete finding, correction, or completed work report.
Calling report_to_main ends this run immediately. If relevant work produces nothing worth reporting, finish silently.`;

const KICKOFF = `First decide whether the trajectory is relevant to this Shadow Mind's responsibility.
If it is unrelated, reply exactly NOT_RELEVANT and stop immediately. Do not call any tool, including report_to_main.
If it is relevant, perform the Shadow Mind's responsibility now. Call report_to_main only when the reviewer should receive a result.`;

export interface ShadowDefinition {
	id: string;
	name: string;
	prompt: string;
}

/** Upstream pi-shadow-mind keeps the runtime protocol in the user turn. */
export function buildShadowSystemPrompt(mainSystemPrompt: string): string {
	return mainSystemPrompt;
}

export function buildShadowRequest(trajectory: string, shadow: ShadowDefinition): string {
	return `${trajectory}\n\n${RUNTIME_PROTOCOL}\n\n<shadow-mind id="${shadow.id}" name="${shadow.name}">\n${shadow.prompt}\n</shadow-mind>\n\n${KICKOFF}`;
}
