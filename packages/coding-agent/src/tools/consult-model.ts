import type { Api, Model } from "@oh-my-pi/pi-ai";
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

export async function resolveConsultSelection(
	session: ConsultSelectionHost,
	signal?: AbortSignal,
): Promise<ConsultResolution> {
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

	const apiKey = await registry.getApiKey(model, session.getSessionId?.() ?? undefined, { signal });
	const primary = session.getActiveModel?.();
	const sameModel = Boolean(primary && formatModelString(primary) === formatModelString(model));
	if (!apiKey) {
		return { ok: false, error: "no_credentials", model, pattern: resolvedPattern, sameModel };
	}
	if (sameModel && !session.settings.get("consult.allowSameModel")) {
		return { ok: false, error: "same_model", model, pattern: resolvedPattern, sameModel: true };
	}

	return {
		ok: true,
		model,
		thinkingLevel,
		pattern: resolvedPattern ?? formatModelString(model),
		apiKey,
		sameModel,
	};
}
