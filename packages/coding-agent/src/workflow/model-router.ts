import type { ModelProfile, WorkflowRole } from "./types";

export class ModelRouter {
	readonly #profiles = new Map<string, ModelProfile>();

	constructor(profiles: Iterable<ModelProfile> = []) {
		for (const profile of profiles) this.register(profile);
	}

	register(profile: ModelProfile): void {
		this.#profiles.set(profile.id, profile);
	}

	getProfileForRole(role: WorkflowRole, vendorPreference?: string): ModelProfile | null {
		for (const profile of this.#profiles.values()) {
			if (profile.roles.includes(role) && (!vendorPreference || profile.vendor === vendorPreference)) {
				return profile;
			}
		}
		return null;
	}

	isIndependentReviewRequired(role: WorkflowRole, implementerVendor: string, reviewerVendor: string): boolean {
		return role === "code_reviewer" && implementerVendor === reviewerVendor;
	}
}
