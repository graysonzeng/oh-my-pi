import {
	isMechanicalFlashEligible,
	parseWorkflowMechanicalClass,
	type WorkflowMechanicalClassV1,
} from "../latency/mechanical-class";
import { WorkflowPolicyError } from "./errors";
import type { FindingTracker } from "./finding-tracker";
import { configuredIdentityForProfile } from "./model-profile-registry";
import { SESSION_FALLBACK_PROFILE_ID } from "./session-fallback-profile";
import type {
	ModelIdentityProvenance,
	ModelProfile,
	ReviewFindingV1,
	WorkflowQualityTier,
	WorkflowRole,
} from "./types";

export interface RoutingSkip {
	profileId: string;
	reason:
		| "profile_not_found"
		| "role_mismatch"
		| "unavailable"
		| "excluded"
		| "identity_mismatch"
		| "attestation_missing"
		| "effort_unsupported"
		| "opaque_lineage"
		| "author_lineage_conflict";
	detail?: string;
}

export interface RoutingAudit {
	profileId: string;
	vendor: string;
	reason: string;
	degraded: boolean;
	qualityTier?: WorkflowQualityTier;
	snapshotFingerprint?: string;
	candidateProfileIds?: readonly string[];
	skipped?: readonly RoutingSkip[];
	modelFamily?: string;
	identityProvenance?: ModelIdentityProvenance;
}

export interface RoutingDecision extends RoutingAudit {
	profile: ModelProfile;
}

export interface RouteOptions {
	/** Ordered immutable candidate ids from a quality-route snapshot. */
	preferredProfileIds?: readonly string[];
	qualityTier?: WorkflowQualityTier;
	snapshotFingerprint?: string;
	/** Per-profile preflight/runtime reason for an unavailable candidate. */
	unavailableReasons?: Readonly<Record<string, string>>;
	/** Prefer this vendor when multiple profiles match (legacy router). */
	vendorPreference?: string;
	/** Implementer vendor for legacy diversity checks on code_reviewer. */
	implementerVendor?: string;
	/** Attested implementer lineage for quality-route reviewer independence. */
	implementerModelFamily?: string;
	/** Whether independent review is required (default true for code_reviewer). */
	requireIndependentReview?: boolean;
	/** Opt-in degraded mode allows same-vendor review only on legacy routes. */
	degradedMode?: boolean;
	/** Profile ids that are currently unavailable. */
	unavailableProfileIds?: Iterable<string>;
	/** Profile ids forbidden for this decision (for reviewer diversity). */
	excludedProfileIds?: Iterable<string>;
	/** Prefer a different vendor when one is available (legacy router). */
	avoidVendor?: string;
	/** Attested author lineage that the reviewer must differ from. */
	avoidModelFamily?: string;
	/** Finding used for repair routing. */
	finding?: ReviewFindingV1;
	/** Tracker for repeated/complex escalation. */
	findingTracker?: FindingTracker;
	/** Prefer reasoning repair profile over mechanical. */
	preferReasoningRepair?: boolean;
	/** Caller/deferred evidence for mechanical Flash routing (repair + implementer). */
	mechanicalClass?: WorkflowMechanicalClassV1;
	roleStaticSplitEnabled?: boolean;
	/** Prefer GPT-6-Astra for very-complex implementer work; fall back to Grok 4.6. */
	preferVeryComplexImplementer?: boolean;
}

function profilePatterns(profile: ModelProfile): string[] {
	return Array.isArray(profile.modelPattern) ? profile.modelPattern : [profile.modelPattern];
}

function isFlashProfile(profile: ModelProfile): boolean {
	return (
		profile.vendor === "deepseek" && profilePatterns(profile).some(pattern => pattern.toLowerCase().includes("flash"))
	);
}

function isAstraImplementerProfile(profile: ModelProfile): boolean {
	return (
		profile.vendor === "openai" &&
		profilePatterns(profile).some(pattern => pattern.toLowerCase().includes("gpt-6-astra"))
	);
}

function isGrok46ImplementerProfile(profile: ModelProfile): boolean {
	return (
		profile.vendor === "xai" && profilePatterns(profile).some(pattern => pattern.toLowerCase().includes("grok-4.6"))
	);
}

function preferVeryComplexImplementerCandidates<T extends { profile?: ModelProfile } | ModelProfile>(
	candidates: readonly T[],
	options: Pick<RouteOptions, "preferVeryComplexImplementer">,
	role: WorkflowRole,
	getProfile: (candidate: T) => ModelProfile,
): T[] {
	if (role !== "implementer" || options.preferVeryComplexImplementer !== true) return [...candidates];
	const astra = candidates.filter(candidate => isAstraImplementerProfile(getProfile(candidate)));
	if (astra.length > 0) return astra;
	const grok = candidates.filter(candidate => isGrok46ImplementerProfile(getProfile(candidate)));
	return grok.length > 0 ? grok : [...candidates];
}

function narrowMechanicalFlashCandidates<T extends { profile?: ModelProfile } | ModelProfile>(
	candidates: readonly T[],
	options: Pick<RouteOptions, "mechanicalClass" | "roleStaticSplitEnabled">,
	role: WorkflowRole,
	getProfile: (candidate: T) => ModelProfile,
): T[] {
	if (role !== "repair" && role !== "implementer") return [...candidates];
	// Implementer mechanical split is product routing, not the repair A/B arm.
	const armEnabled = role === "implementer" || options.roleStaticSplitEnabled === true;
	if (!isMechanicalFlashEligible(options.mechanicalClass, armEnabled)) {
		return [...candidates];
	}
	const parsed = parseWorkflowMechanicalClass(options.mechanicalClass);
	if (!parsed) return [...candidates];
	if (role === "repair" && parsed.targetRole !== "repair") return [...candidates];
	if (role === "implementer" && parsed.targetRole !== "implementer") return [...candidates];
	const flash = candidates.filter(candidate => isFlashProfile(getProfile(candidate)));
	return flash.length > 0 ? flash : [...candidates];
}

export class ModelRouter {
	readonly #profiles = new Map<string, ModelProfile>();

	constructor(profiles: Iterable<ModelProfile> = []) {
		for (const profile of profiles) this.register(profile);
	}

	register(profile: ModelProfile): void {
		this.#profiles.set(profile.id, profile);
	}

	list(): ModelProfile[] {
		return [...this.#profiles.values()];
	}

	getProfileForRole(role: WorkflowRole, vendorPreference?: string): ModelProfile | null {
		try {
			return this.resolve(role, { vendorPreference }).profile;
		} catch {
			return null;
		}
	}

	/**
	 * Resolve a profile for the role with fallback chain, diversity, and repair escalation.
	 * Throws WorkflowPolicyError when independent review is required and no alternate vendor exists.
	 */
	resolve(role: WorkflowRole, options: RouteOptions = {}): RoutingDecision {
		if (options.preferredProfileIds) return this.#resolveQualityRoute(role, options);
		const unavailable = new Set([...(options.unavailableProfileIds ?? []), ...(options.excludedProfileIds ?? [])]);
		const preferReasoning =
			options.preferReasoningRepair ||
			(options.finding && options.findingTracker
				? options.findingTracker.needsReasoningRepair(options.finding)
				: false) ||
			(options.finding ? options.finding.suggestedOwner === "reasoning_repair" : false);

		let candidates = this.#candidates(role, unavailable);
		if (options.avoidVendor) {
			const diverse = candidates.filter(profile => profile.vendor !== options.avoidVendor);
			if (diverse.length > 0) candidates = diverse;
		}

		if (role === "repair" && preferReasoning) {
			const reasoning = candidates.filter(p => p.vendor === "anthropic" || p.vendor === "openai");
			if (reasoning.length > 0) {
				candidates = reasoning;
			}
		}

		candidates = narrowMechanicalFlashCandidates(candidates, options, role, profile => profile);
		candidates = preferVeryComplexImplementerCandidates(candidates, options, role, profile => profile);

		if (role === "repair" && !preferReasoning) {
			const mechanical = candidates.filter(p => p.vendor === "xai");
			if (mechanical.length > 0) candidates = mechanical;
		}

		if (options.vendorPreference) {
			const preferred = candidates.filter(p => p.vendor === options.vendorPreference);
			if (preferred.length > 0) candidates = preferred;
		}

		// Vendor diversity for code review
		const requireIndependent = options.requireIndependentReview ?? role === "code_reviewer";
		if (requireIndependent && role === "code_reviewer" && options.implementerVendor) {
			const diverse = candidates.filter(p => p.vendor !== options.implementerVendor);
			if (diverse.length > 0) {
				const profile = diverse[0]!;
				return {
					profile,
					profileId: profile.id,
					vendor: profile.vendor,
					reason: `independent_code_review vs implementer vendor ${options.implementerVendor}`,
					degraded: false,
				};
			}
			if (!options.degradedMode) {
				throw new WorkflowPolicyError("independent_reviewer_unavailable", {
					implementerVendor: options.implementerVendor,
					role,
				});
			}
			// Degraded: allow same vendor with audit flag
			const profile = candidates[0];
			if (!profile) throw new WorkflowPolicyError("model_profile_not_found", { role });
			return {
				profile,
				profileId: profile.id,
				vendor: profile.vendor,
				reason: "degraded_same_vendor_review",
				degraded: true,
			};
		}

		// Preferred primary among all role profiles (including unavailable) for fallback messaging
		const allForRole = [...this.#profiles.values()].filter(p => p.roles.includes(role));
		const preferredPrimary = allForRole[0];
		const primary = candidates[0];
		if (!primary) throw new WorkflowPolicyError("model_profile_not_found", { role, unavailable: [...unavailable] });

		const reasonBase = preferReasoning && role === "repair" ? "complex_or_repeated_finding" : `role:${role}`;
		// Prefer reasoning over mechanical: treat as intentional routing, not availability fallback
		if (preferReasoning && role === "repair") {
			return {
				profile: primary,
				profileId: primary.id,
				vendor: primary.vendor,
				reason: reasonBase,
				degraded: false,
			};
		}
		if (preferredPrimary && preferredPrimary.id !== primary.id) {
			return {
				profile: primary,
				profileId: primary.id,
				vendor: primary.vendor,
				reason: `fallback_from:${preferredPrimary.id}`,
				// Session-model last resort is a degraded route, not a quality tier.
				degraded: primary.id === SESSION_FALLBACK_PROFILE_ID,
			};
		}

		// Walk explicit fallback ids from primary when it is unavailable (candidates empty of primary)
		if (preferredPrimary && unavailable.has(preferredPrimary.id)) {
			for (const fallbackId of preferredPrimary.retryPolicy.fallbackProfileIds) {
				if (unavailable.has(fallbackId)) continue;
				const fallback = this.#profiles.get(fallbackId);
				if (fallback?.roles.includes(role)) {
					return {
						profile: fallback,
						profileId: fallback.id,
						vendor: fallback.vendor,
						reason: `fallback_from:${preferredPrimary.id}`,
						degraded: false,
					};
				}
			}
		}

		return {
			profile: primary,
			profileId: primary.id,
			vendor: primary.vendor,
			reason: reasonBase,
			degraded: false,
		};
	}

	#resolveQualityRoute(role: WorkflowRole, options: RouteOptions): RoutingDecision {
		if (options.degradedMode) {
			throw new WorkflowPolicyError("quality_route_degraded_mode_forbidden", {
				qualityTier: options.qualityTier,
			});
		}
		const candidateProfileIds = [...(options.preferredProfileIds ?? [])];
		if (candidateProfileIds.length === 0) {
			throw new WorkflowPolicyError("empty_quality_route_role", { role, qualityTier: options.qualityTier });
		}
		const unavailable = new Set(options.unavailableProfileIds ?? []);
		const excluded = new Set(options.excludedProfileIds ?? []);
		const skipped: RoutingSkip[] = [];
		let candidates: Array<{ profile: ModelProfile; modelFamily: string }> = [];
		const authorModelFamily =
			options.avoidModelFamily ?? (role === "code_reviewer" ? options.implementerModelFamily : undefined);
		for (const profileId of candidateProfileIds) {
			const profile = this.#profiles.get(profileId);
			if (!profile) {
				skipped.push({ profileId, reason: "profile_not_found" });
				continue;
			}
			if (!profile.roles.includes(role)) {
				skipped.push({ profileId, reason: "role_mismatch" });
				continue;
			}
			if (excluded.has(profileId)) {
				skipped.push({ profileId, reason: "excluded" });
				continue;
			}
			if (unavailable.has(profileId)) {
				const detail = options.unavailableReasons?.[profileId];
				const reason = detail?.includes("identity_mismatch")
					? "identity_mismatch"
					: detail?.includes("attestation") || detail?.includes("missing_identity")
						? "attestation_missing"
						: detail?.includes("effort")
							? "effort_unsupported"
							: "unavailable";
				skipped.push({ profileId, reason, detail });
				continue;
			}
			let modelFamily: string | null;
			try {
				modelFamily = configuredIdentityForProfile(profile).modelFamily;
			} catch (error) {
				modelFamily = null;
				skipped.push({
					profileId,
					reason: "opaque_lineage",
					detail: error instanceof Error ? error.message : String(error),
				});
			}
			if (!modelFamily) continue;
			if (authorModelFamily && modelFamily === authorModelFamily) {
				skipped.push({ profileId, reason: "author_lineage_conflict", detail: authorModelFamily });
				continue;
			}
			candidates.push({ profile, modelFamily });
		}
		candidates = narrowMechanicalFlashCandidates(candidates, options, role, candidate => candidate.profile);
		candidates = preferVeryComplexImplementerCandidates(candidates, options, role, candidate => candidate.profile);
		const selected = candidates[0];
		if (!selected) {
			throw new WorkflowPolicyError(
				authorModelFamily ? "independent_reviewer_unavailable" : "model_profile_not_found",
				{
					role,
					qualityTier: options.qualityTier,
					authorModelFamily,
					candidateProfileIds,
					skipped,
				},
			);
		}
		const primaryId = candidateProfileIds[0];
		return {
			profile: selected.profile,
			profileId: selected.profile.id,
			vendor: selected.profile.vendor,
			reason: selected.profile.id === primaryId ? `quality_route:${role}` : `fallback_from:${primaryId}`,
			degraded: false,
			qualityTier: options.qualityTier,
			snapshotFingerprint: options.snapshotFingerprint,
			candidateProfileIds,
			skipped,
			modelFamily: selected.modelFamily,
			identityProvenance: "configured",
		};
	}

	/** Resolve an optional plan arbitrator without changing the plan-review route. */
	resolvePlanArbitrator(
		options: {
			avoidModelFamilies?: readonly string[];
			unavailableProfileIds?: Iterable<string>;
			allowDegradedFallback?: boolean;
		} = {},
	): RoutingDecision {
		const unavailable = new Set(options.unavailableProfileIds ?? []);
		const avoided = new Set(options.avoidModelFamilies ?? []);
		const candidates = this.list()
			.filter(profile => profile.roles.includes("plan_arbitrator"))
			.filter(profile => !unavailable.has(profile.id))
			.filter(profile => options.allowDegradedFallback === true || profile.vendor !== "anthropic")
			.flatMap(profile => {
				try {
					const modelFamily = configuredIdentityForProfile(profile).modelFamily;
					if (!modelFamily || avoided.has(modelFamily)) return [];
					return [{ profile, modelFamily }];
				} catch {
					return [];
				}
			})
			.sort((left, right) => (left.profile.vendor === "xai" ? -1 : right.profile.vendor === "xai" ? 1 : 0));
		const selected = candidates[0];
		if (!selected) {
			throw new WorkflowPolicyError("plan_arbitrator_unavailable", {
				avoidedModelFamilies: [...avoided],
				allowDegradedFallback: options.allowDegradedFallback === true,
			});
		}
		return {
			profile: selected.profile,
			profileId: selected.profile.id,
			vendor: selected.profile.vendor,
			reason: selected.profile.vendor === "xai" ? "plan_arbitrator:xai_lineage" : "plan_arbitrator:fallback",
			degraded: selected.profile.vendor === "anthropic",
			modelFamily: selected.modelFamily,
			identityProvenance: "configured",
		};
	}

	#candidates(role: WorkflowRole, unavailable: Set<string>): ModelProfile[] {
		return [...this.#profiles.values()].filter(p => p.roles.includes(role) && !unavailable.has(p.id));
	}

	isIndependentReviewRequired(role: WorkflowRole, implementerVendor: string, reviewerVendor: string): boolean {
		return role === "code_reviewer" && implementerVendor === reviewerVendor;
	}
}
