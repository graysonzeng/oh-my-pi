/**
 * Session-level programmatic tool calling (PTC): collapse the provider-visible
 * tool surface to a control keep-set and expose every other enabled tool
 * through the eval bridge.
 *
 * Codex Code Mode is the provider adapter on top of this resolver: it still
 * emits `tool_namespaces_info` for openai-codex, but activation is no longer
 * Codex-only. `tools.ptc.mode` is the generic switch; the legacy
 * `providers.openai-codex.codeMode` setting remains the Codex fallback when
 * the generic switch is `off`.
 */

export const PTC_KEEP_TOOLS: Record<string, true> = {
	eval: true,
	ask: true,
	todo: true,
	yield: true,
	think: true,
	// checkpoint/rewind results drive session state machinery keyed on the
	// toolResult's toolName (see session/checkpoint-entries.ts); wrapped inside
	// an eval result they are invisible to it, so they must stay direct.
	checkpoint: true,
	rewind: true,
	// Rollover requests likewise depend on the direct toolResult's toolName.
	new_context: true,
	__agent__: true,
	__budget__: true,
	__completion__: true,
	__wait__: true,
	__status__: true,
	__cancel__: true,
	__workpool__: true,
	__catalog_search__: true,
	__catalog_describe__: true,
};

export type PtcMode = "off" | "on" | "auto";
export type PtcDegradedReason = "eval-unavailable" | "eval-js-unavailable";

export interface PtcResolution {
	active: boolean;
	/** User/catalog requested mode after combining generic + Codex settings. */
	requestedMode: PtcMode;
	/** Mode that is actually in force (`off` when degraded). */
	effectiveMode: PtcMode;
	/** Why a requested `on`/`auto` did not activate. */
	degradedReason?: PtcDegradedReason;
	/** Names that remain directly model-visible. All enabled names when inactive. */
	directToolNames: Set<string>;
	/** True when Codex Responses should receive `tool_namespaces_info`. */
	codexNamespaces: boolean;
}

export function resolvePtc(args: {
	provider: string;
	toolMode?: string;
	ptcMode: PtcMode;
	codexMode: PtcMode;
	extraDirectTools?: readonly string[];
	codexExtraDirectTools?: readonly string[];
	enabledToolNames: readonly string[];
	evalTransportAvailable: boolean;
}): PtcResolution {
	const requestedMode =
		args.ptcMode !== "off" ? args.ptcMode : args.provider === "openai-codex" ? args.codexMode : "off";
	const allDirect = new Set(args.enabledToolNames);
	if (requestedMode === "off") {
		return {
			active: false,
			requestedMode,
			effectiveMode: "off",
			directToolNames: allDirect,
			codexNamespaces: false,
		};
	}
	if (!args.enabledToolNames.includes("eval")) {
		return {
			active: false,
			requestedMode,
			effectiveMode: "off",
			degradedReason: "eval-unavailable",
			directToolNames: allDirect,
			codexNamespaces: false,
		};
	}
	if (!args.evalTransportAvailable) {
		return {
			active: false,
			requestedMode,
			effectiveMode: "off",
			degradedReason: "eval-js-unavailable",
			directToolNames: allDirect,
			codexNamespaces: false,
		};
	}
	const autoPreferred = args.toolMode === "code_mode_only";
	const active = requestedMode === "on" || (requestedMode === "auto" && autoPreferred);
	if (!active) {
		return {
			active: false,
			requestedMode,
			effectiveMode: "off",
			directToolNames: allDirect,
			codexNamespaces: false,
		};
	}
	const direct = new Set<string>();
	for (const name of args.enabledToolNames) {
		if (PTC_KEEP_TOOLS[name] === true) direct.add(name);
	}
	for (const name of args.extraDirectTools ?? []) {
		if (args.enabledToolNames.includes(name)) direct.add(name);
	}
	if (args.provider === "openai-codex") {
		for (const name of args.codexExtraDirectTools ?? []) {
			if (args.enabledToolNames.includes(name)) direct.add(name);
		}
	}
	return {
		active: true,
		requestedMode,
		effectiveMode: requestedMode,
		directToolNames: direct,
		codexNamespaces: args.provider === "openai-codex",
	};
}
