import type { AgentSession } from "../session/agent-session";
import { commandConsumed } from "./helpers/parse";
import type { SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

async function formatConsultStatus(session: AgentSession): Promise<string> {
	const state = await session.consultState();
	const parts = [
		`consult: ${state.active ? "active" : "inactive"}`,
		`enabled: ${state.enabled ? "on" : "off"}`,
		state.override ? `override: ${state.override}` : undefined,
		state.model ? `model: ${state.model}` : `model: ${state.error ?? "none"}`,
		state.sameModel ? "same-model: yes" : "same-model: no",
		`credentials: ${state.credentials ? "ok" : "missing"}`,
		`uses: turn ${state.turn} / session ${state.session}`,
	];
	if (state.last) {
		const last = [
			state.last.error ? `last: ${state.last.error}` : "last: ok",
			state.last.model,
			typeof state.last.tokensOut === "number" ? `${state.last.tokensOut} tok out` : undefined,
			typeof state.last.costUsd === "number" ? `$${state.last.costUsd.toFixed(4)}` : undefined,
			state.last.truncated ? "truncated" : undefined,
		].filter(Boolean);
		parts.push(last.join(" · "));
	}
	if (state.sameModel && session.settings.get("advisor.enabled")) {
		parts.push("same model is also the shadow advisor; extra consults add little");
	}
	return parts.filter(Boolean).join(" · ");
}

async function applyConsultToggle(session: AgentSession, enable: boolean): Promise<string> {
	session.settings.override("consult.enabled", enable);
	const applied = await session.setConsultToolEnabled(enable);
	if (enable && !applied) {
		return "Consult is unavailable in this session.";
	}
	return `${enable ? "Consult enabled" : "Consult disabled"} for this session. ${await formatConsultStatus(session)}`;
}

async function applyConsultModel(session: AgentSession, pattern: string): Promise<string> {
	const applied = await session.setConsultModelOverride(pattern);
	if (!applied) {
		return "Consult is unavailable in this session.";
	}
	return `Consult model override: ${pattern}. ${await formatConsultStatus(session)}`;
}

async function clearConsultModel(session: AgentSession): Promise<string> {
	await session.setConsultModelOverride(undefined);
	return `Consult model override cleared. ${await formatConsultStatus(session)}`;
}

async function handleConsultArg(session: AgentSession, arg: string): Promise<string> {
	const lower = arg.toLowerCase();
	if (!arg || lower === "status") return formatConsultStatus(session);
	if (lower === "on") return applyConsultToggle(session, true);
	if (lower === "off") return applyConsultToggle(session, false);
	if (lower === "unset") return clearConsultModel(session);
	return applyConsultModel(session, arg);
}

export const BUILTIN_CONSULT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "consult",
		icon: "advisor",
		description: "Control the mid-turn consult tool for this session",
		acpDescription: "Toggle consult",
		acpInputHint: "[on|off|unset|status|<model>]",
		subcommands: [
			{ name: "on", description: "Enable consult for this session" },
			{ name: "off", description: "Disable consult for this session" },
			{ name: "unset", description: "Clear the session consult model override" },
			{ name: "status", description: "Show consult status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Consult: ${runtime.ctx.session.settings.get("consult.enabled") ? "on" : "off"}`,
		handle: async (command, runtime) => {
			await runtime.output(await handleConsultArg(runtime.session, command.args.trim()));
			return commandConsumed();
		},
		handleTui: async (command, runtime: TuiSlashCommandRuntime) => {
			runtime.ctx.showStatus(await handleConsultArg(runtime.ctx.session, command.args.trim()));
			runtime.ctx.editor.setText("");
		},
	},
];
