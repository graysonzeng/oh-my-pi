import type { Api, Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import {
	formatModelString,
	resolveAdvisorRoleSelection,
	resolveConfiguredModelPatterns,
	resolveModelOverride,
} from "../config/model-resolver";
import { cfgConsultModel } from "../config/workflow-settings";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

export interface ConsultSelectionHost {
	settings: Settings;
	modelRegistry?: {
		getAvailable(): Model<Api>[];
		getApiKey(model: Model<Api>, sessionId?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
	};
	getConsultModelOverride?: () => string | undefined;
	getActiveModel?: () => Model<Api> | undefined;
	getSessionId?: () => string | null | undefined;
}

export type ConsultResolveError = "no_model" | "no_credentials" | "same_model";

export type ConsultResolution =
	| {
			ok: true;
			model: Model<Api>;
			thinkingLevel?: ConfiguredThinkingLevel;
			pattern: string;
			apiKey: string;
			sameModel: boolean;
			fallbacks?: Array<{ model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel }>;
	  }
	| {
			ok: false;
			error: ConsultResolveError;
			model?: Model<Api>;
			pattern?: string;
			sameModel?: boolean;
	  };

/**
 * Network-free consult model selection: override/`consult.model` pattern or the
 * advisor role, resolved against the registry without touching credentials.
 * Shared by the execute path, the activation/reconcile path, and the
 * tool-registration gate so a same-model pause never performs an API-key
 * lookup or any other I/O.
 */
export type ConsultModelSelection =
	| {
			ok: true;
			model: Model<Api>;
			thinkingLevel?: ConfiguredThinkingLevel;
			pattern: string;
			sameModel: boolean;
	  }
	| { ok: false; error: "no_model"; pattern?: string };

function resolveConsultCandidates(session: ConsultSelectionHost): {
	pattern?: string;
	candidates: Array<{ model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel }>;
} {
	const candidates: Array<{ model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel }> = [];
	const registry = session.modelRegistry;
	if (!registry) return { candidates };

	const available = registry.getAvailable();
	if (available.length === 0) return { candidates };

	const override = session.getConsultModelOverride?.()?.trim();
	const settingModel = cfgConsultModel.get(session.settings)?.trim();
	const pattern = override || settingModel || formatModelRoleAlias("advisor");
	for (const entry of resolveConfiguredModelPatterns([pattern], session.settings)) {
		const { model, thinkingLevel } = resolveModelOverride([entry], registry, session.settings);
		if (model && !candidates.some(candidate => modelsAreEqual(candidate.model, model))) {
			candidates.push({ model, thinkingLevel });
		}
	}
	if (!override && !settingModel && candidates.length === 0) {
		const selection = resolveAdvisorRoleSelection(session.settings, available);
		if (selection) candidates.push(selection);
	}
	return { pattern, candidates };
}

export function resolveConsultModel(session: ConsultSelectionHost): ConsultModelSelection {
	const { pattern, candidates } = resolveConsultCandidates(session);
	const selection =
		(!session.settings.get("consult.allowSameModel") &&
			candidates.find(candidate => !isConsultSameModel(session, candidate.model))) ||
		candidates[0];
	if (!selection) return { ok: false, error: "no_model", pattern };

	return {
		ok: true,
		...selection,
		pattern: pattern ?? formatModelString(selection.model),
		sameModel: isConsultSameModel(session, selection.model),
	};
}

/**
 * Whether the resolved consult model equals the session's active primary
 * model. Compares the resolved provider + id via {@link modelsAreEqual} — the
 * same identity rule used across the codebase, never a guess at proxy-rewritten
 * underlying identity.
 */
export function isConsultSameModel(session: ConsultSelectionHost, model: Model<Api>): boolean {
	const primary = session.getActiveModel?.();
	return Boolean(primary && modelsAreEqual(primary, model));
}

/**
 * Whether the consult tool may be activated for this session: the consult
 * model must resolve, and it must not equal the active primary model unless
 * `consult.allowSameModel` is enabled. Network-free — the shared same-model
 * gate used by tool registration, reconcile, and auto-pause decisions.
 */
export function isConsultActivationAllowed(session: ConsultSelectionHost): boolean {
	const selection = resolveConsultModel(session);
	// An unresolvable consult model is NOT a same-model pause: preserve the
	// original behavior (tool stays registered/active; the call-time guard
	// reports `no_model`). Only a confirmed same-model without
	// `consult.allowSameModel` removes the entry.
	if (!selection.ok) return true;
	return !(selection.sameModel && !session.settings.get("consult.allowSameModel"));
}

export async function resolveConsultSelection(
	session: ConsultSelectionHost,
	signal?: AbortSignal,
): Promise<ConsultResolution> {
	const registry = session.modelRegistry;
	if (!registry) return { ok: false, error: "no_model" };

	const { pattern, candidates } = resolveConsultCandidates(session);
	let failure: ConsultResolution | undefined;
	for (const [index, { model, thinkingLevel }] of candidates.entries()) {
		const apiKey = await registry.getApiKey(model, session.getSessionId?.() ?? undefined, { signal });
		// The primary can switch during credential lookup; gate against its current identity.
		const sameModel = isConsultSameModel(session, model);
		if (!apiKey || (sameModel && !session.settings.get("consult.allowSameModel"))) {
			failure ??= { ok: false, error: apiKey ? "same_model" : "no_credentials", model, pattern, sameModel };
			continue;
		}
		return {
			ok: true,
			model,
			thinkingLevel,
			pattern: pattern ?? formatModelString(model),
			apiKey,
			sameModel,
			...(index + 1 < candidates.length ? { fallbacks: candidates.slice(index + 1) } : {}),
		};
	}
	return failure ?? { ok: false, error: "no_model", pattern };
}
