import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import { parseModelString } from "../config/model-resolver";
import type { ToolSession } from "../tools";
import { assertSupportedModelProfile, normalizeModelProfile } from "./model-profile-registry";
import type { ModelProfile } from "./types";

/** Last-resort implementer profile id: routes to the calling session's active model. */
export const SESSION_FALLBACK_PROFILE_ID = "main_agent_fallback";

/**
 * Build a complete, provider-neutral implementer profile for the session's active model.
 *
 * The engine registers this as the last legacy-route implementer candidate, so:
 * - availability preflight probes it for real (same physical probe path as static profiles);
 * - resume can re-find it by id (work-package identity checks, artifact hydrate);
 * - code_reviewer independence compares against its vendor lineage, not the transport
 *   provider (aggregator/gateway prefixes fold onto the model family).
 *
 * Deliberately no per-family prompt/tool tuning and no `optimizationProfileId` — this is
 * a degraded last resort, not an audited per-model strategy.
 *
 * Returns `undefined` when the session exposes no model string; callers keep the existing
 * `model_profile_not_found` behavior instead of inventing a route.
 */
export function sessionFallbackImplementerProfile(session: ToolSession | undefined): ModelProfile | undefined {
	if (!session) return undefined;
	const modelString = session.getActiveModelString?.() ?? session.getModelString?.();
	if (!modelString?.trim()) return undefined;
	const parsed = parseModelString(modelString);
	if (!parsed?.id) return undefined;
	const lineage = modelFamilyToken(parsed.id);
	const profile: ModelProfile = {
		id: SESSION_FALLBACK_PROFILE_ID,
		// Lineage (openai/xai/deepseek/...) rather than transport provider (gateway/...):
		// keeps reviewer-independence and strict-identity lineage checks honest.
		vendor: lineage || parsed.provider,
		modelPattern: [modelString],
		roles: ["implementer"],
		promptTemplate: "implementer",
		promptVersion: "1.0",
		toolPolicyId: "scoped-implementation",
		maxRequests: 200,
		maxRuntimeMs: 600_000,
		retryPolicy: { maxAttempts: 1, retryableErrorKinds: [], fallbackProfileIds: [] },
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: false,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 1024 * 1024,
		},
	};
	const normalized = normalizeModelProfile(profile);
	assertSupportedModelProfile(normalized);
	return normalized;
}
