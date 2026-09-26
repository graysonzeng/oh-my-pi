/**
 * Credential / route unavailable early-fail (history supplement S0).
 *
 * Distinguishes config failures (invalid key, auth_unavailable, missing model)
 * from short cooldown (rate/usage limits) and transport blips. Only config
 * failures enter the process-local unavailable registry so siblings sharing the
 * same probe/route key skip futile identical requests. Unknown stays
 * conservative (no registry write). Does not global-enable
 * `provider_health_breaker` and does not invent account-permission guesses.
 */
import * as AIError from "@oh-my-pi/pi-ai/error";
import { redactSecretsInText } from "../workflow/secret-redact";

export const CREDENTIAL_ROUTE_CONFIG_UNAVAILABLE_TTL_MS = 10 * 60_000;
export const CREDENTIAL_ROUTE_UNAVAILABLE_SUMMARY = "credential/route unavailable (known config failure)";

export type CredentialRouteFailureClass = "config_unavailable" | "short_cooldown" | "transport_blip" | "unknown";

export interface CredentialRouteFailureInput {
	/** Workflow probe / runtime error kind when already classified. */
	errorKind?: string;
	errorMessage?: string;
	errorStatus?: number;
	errorId?: number;
}

export interface CredentialRouteUnavailableEntry {
	failureClass: "config_unavailable";
	errorKind?: string;
	/** Redacted user-visible reason; never raw secrets. */
	errorSummary: string;
	notedAtMs: number;
	openUntilMs: number;
}

export function buildCredentialRouteKey(parts: {
	provider?: string;
	modelId?: string;
	authScope?: string;
	/** Prefer provider scope for shared-key auth failures across models. */
	providerScoped?: boolean;
}): string {
	const scope = parts.authScope?.trim() || "default";
	const provider = (parts.provider ?? "").trim().toLowerCase() || "*";
	if (parts.providerScoped) return `provider|${provider}|${scope}`;
	const model = (parts.modelId ?? "").trim().toLowerCase() || "*";
	return `route|${provider}|${model}|${scope}`;
}

/**
 * Classify a failure for early-fail policy. Message/AIError UsageLimit wins over
 * a probe `errorKind` of `authentication` (adapters often label "401 Insufficient
 * balance" as auth because status 401 matches first). Does not guess org/plan
 * permissions beyond AuthFailed / UsageLimit / permanent-billing already owned
 * by `@oh-my-pi/pi-ai/error`.
 */
export function classifyCredentialRouteFailure(input: CredentialRouteFailureInput): CredentialRouteFailureClass {
	const message = input.errorMessage ?? "";
	const id =
		typeof input.errorId === "number" && input.errorId !== 0
			? input.errorId
			: AIError.classify({
					message,
					status: input.errorStatus,
				});
	// auth_unavailable wrapping permanent billing means no usable auth remains for
	// that route — treat as config, not a short cooldown.
	if (AIError.isPermanentBillingFailureText(message) && /\bauth[_ ]?unavailable\b/i.test(message)) {
		return "config_unavailable";
	}
	// UsageLimit (including rotatable 401 Insufficient balance) stays on the
	// sibling-rotate / wait path — not a sticky config-unavailable mark. Check
	// before trusting structured authentication kinds from probe adapters.
	if (AIError.is(id, AIError.Flag.UsageLimit)) return "short_cooldown";

	const kind = input.errorKind?.trim().toLowerCase();
	if (kind === "authentication" || kind === "configuration" || kind === "identity_mismatch") {
		return "config_unavailable";
	}
	if (kind === "rate_limit" || kind === "quota") return "short_cooldown";
	if (kind === "timeout" || kind === "provider_transient") return "transport_blip";

	if (AIError.isPermanentBillingFailureText(message)) return "config_unavailable";
	if (AIError.is(id, AIError.Flag.AuthFailed)) return "config_unavailable";
	if (AIError.is(id, AIError.Flag.Transient) || AIError.is(id, AIError.Flag.Timeout)) {
		return "transport_blip";
	}
	return "unknown";
}

/** True when the failure should stop identical same-route retry/fallback chains. */
export function isConfigCredentialRouteUnavailable(input: CredentialRouteFailureInput): boolean {
	return classifyCredentialRouteFailure(input) === "config_unavailable";
}

/** Bound + redact stored summaries so raw secrets never persist in the registry. */
function boundSummary(summary: string | undefined, fallback: string): string {
	const raw = (summary ?? "").trim() || fallback;
	return redactSecretsInText(raw).slice(0, 500);
}

export class CredentialRouteUnavailableRegistry {
	readonly #nowMs: () => number;
	readonly #ttlMs: number;
	readonly #entries = new Map<string, CredentialRouteUnavailableEntry>();

	constructor(options: { nowMs?: () => number; ttlMs?: number } = {}) {
		this.#nowMs = options.nowMs ?? Date.now;
		this.#ttlMs = options.ttlMs ?? CREDENTIAL_ROUTE_CONFIG_UNAVAILABLE_TTL_MS;
	}

	isUnavailable(routeKey: string): boolean {
		return this.#expireIfNeeded(routeKey) !== undefined;
	}

	get(routeKey: string): CredentialRouteUnavailableEntry | undefined {
		return this.#expireIfNeeded(routeKey);
	}

	/**
	 * Record a config-unavailable outcome. Cooldown/transport/unknown are ignored
	 * so brief faults do not block healthy recovery.
	 */
	noteFailure(routeKey: string, input: CredentialRouteFailureInput): CredentialRouteUnavailableEntry | undefined {
		if (classifyCredentialRouteFailure(input) !== "config_unavailable") return undefined;
		const now = this.#nowMs();
		const entry: CredentialRouteUnavailableEntry = {
			failureClass: "config_unavailable",
			errorKind: input.errorKind,
			errorSummary: boundSummary(input.errorMessage, CREDENTIAL_ROUTE_UNAVAILABLE_SUMMARY),
			notedAtMs: now,
			openUntilMs: now + this.#ttlMs,
		};
		this.#entries.set(routeKey, entry);
		return entry;
	}

	clear(routeKey: string): void {
		this.#entries.delete(routeKey);
	}

	clearAll(): void {
		this.#entries.clear();
	}

	#expireIfNeeded(routeKey: string): CredentialRouteUnavailableEntry | undefined {
		const entry = this.#entries.get(routeKey);
		if (!entry) return undefined;
		if (this.#nowMs() >= entry.openUntilMs) {
			this.#entries.delete(routeKey);
			return undefined;
		}
		return entry;
	}
}

let sharedRegistry: CredentialRouteUnavailableRegistry | undefined;

/** Process-local shared registry for cross-sibling / cross-engine early fail. */
export function sharedCredentialRouteUnavailableRegistry(): CredentialRouteUnavailableRegistry {
	sharedRegistry ??= new CredentialRouteUnavailableRegistry();
	return sharedRegistry;
}

/** Test-only reset of the process-local singleton. */
export function resetSharedCredentialRouteUnavailableRegistryForTests(): void {
	sharedRegistry?.clearAll();
	sharedRegistry = undefined;
}
