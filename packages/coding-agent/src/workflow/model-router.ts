import { WorkflowPolicyError } from "./errors";
import type { FindingTracker } from "./finding-tracker";
import type { ModelProfile, ReviewFindingV1, WorkflowRole } from "./types";

export interface RoutingAudit {
	profileId: string;
	vendor: string;
	reason: string;
	degraded: boolean;
}

export interface RoutingDecision extends RoutingAudit {
	profile: ModelProfile;
}

export interface RouteOptions {
	/** Prefer this vendor when multiple profiles match. */
	vendorPreference?: string;
	/** Implementer vendor for diversity checks on code_reviewer. */
	implementerVendor?: string;
	/** Whether independent review is required (default true for code_reviewer). */
	requireIndependentReview?: boolean;
	/** Opt-in degraded mode allows same-vendor review. */
	degradedMode?: boolean;
	/** Profile ids that are currently unavailable. */
	unavailableProfileIds?: Iterable<string>;
	/** Finding used for repair routing. */
	finding?: ReviewFindingV1;
	/** Tracker for repeated/complex escalation. */
	findingTracker?: FindingTracker;
	/** Prefer reasoning repair profile over mechanical. */
	preferReasoningRepair?: boolean;
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
		const unavailable = new Set(options.unavailableProfileIds ?? []);
		const preferReasoning =
			options.preferReasoningRepair ||
			(options.finding && options.findingTracker
				? options.findingTracker.needsReasoningRepair(options.finding)
				: false) ||
			(options.finding ? options.finding.suggestedOwner === "reasoning_repair" : false);

		let candidates = this.#candidates(role, unavailable);

		if (role === "repair" && preferReasoning) {
			const reasoning = candidates.filter(p => p.vendor === "anthropic" || p.vendor === "openai");
			if (reasoning.length > 0) {
				candidates = reasoning;
			}
		}

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
				degraded: false,
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

	#candidates(role: WorkflowRole, unavailable: Set<string>): ModelProfile[] {
		return [...this.#profiles.values()].filter(p => p.roles.includes(role) && !unavailable.has(p.id));
	}

	isIndependentReviewRequired(role: WorkflowRole, implementerVendor: string, reviewerVendor: string): boolean {
		return role === "code_reviewer" && implementerVendor === reviewerVendor;
	}
}
