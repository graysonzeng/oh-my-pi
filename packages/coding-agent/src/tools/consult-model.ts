import type { Api, Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { formatModelString, resolveAdvisorRoleSelection, resolveModelOverride } from "../config/model-resolver";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import type { ConfiguredThinkingLevel } from "../thinking";

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

export function resolveConsultModel(session: ConsultSelectionHost): ConsultModelSelection {
	const registry = session.modelRegistry;
	if (!registry) return { ok: false, error: "no_model" };

	const available = registry.getAvailable();
	if (available.length === 0) return { ok: false, error: "no_model" };

	const override = session.getConsultModelOverride?.()?.trim();
	const settingModel = session.settings.get("consult.model")?.trim();
	const pattern = override || settingModel || undefined;

	let model: Model<Api> | undefined;
	let thinkingLevel: ConfiguredThinkingLevel | undefined;
	let resolvedPattern = pattern;

	if (pattern) {
		const resolved = resolveModelOverride([pattern], registry, session.settings);
		model = resolved.model;
		thinkingLevel = resolved.thinkingLevel;
	} else {
		const selection = resolveAdvisorRoleSelection(session.settings, available);
		model = selection?.model;
		thinkingLevel = selection?.thinkingLevel;
		resolvedPattern = formatModelRoleAlias("advisor");
	}

	if (!model) return { ok: false, error: "no_model", pattern: resolvedPattern };

	return {
		ok: true,
		model,
		thinkingLevel,
		pattern: resolvedPattern ?? formatModelString(model),
		sameModel: isConsultSameModel(session, model),
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

	const selection = resolveConsultModel(session);
	if (!selection.ok) return { ok: false, error: "no_model", pattern: selection.pattern };

	const { model, thinkingLevel, pattern } = selection;
	const apiKey = await registry.getApiKey(model, session.getSessionId?.() ?? undefined, { signal });
	// The primary model can switch while the credential lookup is in flight, so
	// the same-model gate is re-evaluated against the CURRENT primary after the
	// await — the pre-call guard for requests racing a model switch.
	const sameModel = isConsultSameModel(session, model);
	if (!apiKey) {
		return { ok: false, error: "no_credentials", model, pattern, sameModel };
	}
	if (sameModel && !session.settings.get("consult.allowSameModel")) {
		return { ok: false, error: "same_model", model, pattern, sameModel: true };
	}

	return {
		ok: true,
		model,
		thinkingLevel,
		pattern,
		apiKey,
		sameModel,
	};
}
