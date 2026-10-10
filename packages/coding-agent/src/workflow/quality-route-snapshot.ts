import { stableStringify } from "../model-policy/receipt";
import type { WorkflowDefaultConfig } from "./default-config";
import { WorkflowPolicyError } from "./errors";
import { configuredIdentityForProfile, normalizeModelProfile } from "./model-profile-registry";
import { sha256Hex } from "./optimization-receipt";
import type {
	ModelProfile,
	QualityRouteProfileSnapshotV1,
	QualityRouteSnapshotV1,
	WorkflowModelProfile,
	WorkflowQualityTier,
	WorkflowRole,
} from "./types";

const QUALITY_ROUTE_ROLES: readonly WorkflowRole[] = [
	"planner",
	"plan_reviewer",
	"implementer",
	"code_reviewer",
	"repair",
];

/** Optional role: empty route is allowed so arbitration remains default-off. */
const OPTIONAL_QUALITY_ROUTE_ROLES: readonly WorkflowRole[] = ["plan_arbitrator"];

interface QualityRouteSnapshotPayloadV1 {
	schemaVersion: 1;
	qualityTier: WorkflowQualityTier;
	degradedMode: false;
	routes: Readonly<Record<WorkflowRole, readonly string[]>>;
	profiles: readonly QualityRouteProfileSnapshotV1[];
}

function snapshotFingerprint(payload: QualityRouteSnapshotPayloadV1): string {
	return sha256Hex(stableStringify(payload));
}

function freezeDeep<T>(value: T): T {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
	return Object.freeze(value);
}

function cloneProfile(profile: WorkflowModelProfile): WorkflowModelProfile {
	return structuredClone({
		id: profile.id,
		vendor: profile.vendor,
		modelPattern: profile.modelPattern,
		roles: profile.roles,
		optimizationProfileId: profile.optimizationProfileId,
		thinkingLevel: profile.thinkingLevel,
		strictIdentity: profile.strictIdentity,
		promptTemplate: profile.promptTemplate,
		promptVersion: profile.promptVersion,
		toolPolicyId: profile.toolPolicyId,
		toolAliases: profile.toolAliases,
		argumentAliases: profile.argumentAliases,
		promptStrategy: profile.promptStrategy,
		toolStrategy: profile.toolStrategy,
		contextStrategy: profile.contextStrategy,
		outputStrategy: profile.outputStrategy,
		presentationPolicy: profile.presentationPolicy,
		disabledTools: profile.disabledTools,
		maxRequests: profile.maxRequests,
		maxRuntimeMs: profile.maxRuntimeMs,
		maxInputTokens: profile.maxInputTokens,
		maxOutputTokens: profile.maxOutputTokens,
		maxCostUsd: profile.maxCostUsd,
		retryPolicy: profile.retryPolicy,
		contextPolicy: profile.contextPolicy,
	});
}

export function compileQualityRouteSnapshot(
	config: Pick<WorkflowDefaultConfig, "profiles" | "qualityRoutes">,
	qualityTier: WorkflowQualityTier,
): QualityRouteSnapshotV1 {
	const configuredRoutes = config.qualityRoutes[qualityTier];
	if (!configuredRoutes) {
		throw new WorkflowPolicyError("quality_route_not_configured", { qualityTier });
	}
	const profileSnapshots: QualityRouteProfileSnapshotV1[] = [];
	const seenProfiles = new Set<string>();
	const routes = {} as Record<WorkflowRole, readonly string[]>;
	const allRoles: readonly WorkflowRole[] = [...QUALITY_ROUTE_ROLES, ...OPTIONAL_QUALITY_ROUTE_ROLES];
	for (const role of allRoles) {
		const profileIds = configuredRoutes[role];
		const optional = (OPTIONAL_QUALITY_ROUTE_ROLES as readonly string[]).includes(role);
		if (!Array.isArray(profileIds) || profileIds.length === 0) {
			if (optional) {
				routes[role] = [];
				continue;
			}
			throw new WorkflowPolicyError("empty_quality_route_role", { qualityTier, role });
		}
		routes[role] = [...profileIds];
		for (const profileId of profileIds) {
			const configured = config.profiles[profileId];
			if (!configured) {
				throw new WorkflowPolicyError("unknown_quality_route_profile", { qualityTier, role, profileId });
			}
			const profile = normalizeModelProfile(configured);
			if (!profile.roles.includes(role)) {
				throw new WorkflowPolicyError("quality_route_profile_role_mismatch", {
					qualityTier,
					role,
					profileId,
					profileRoles: profile.roles,
				});
			}
			if (profile.strictIdentity !== true) {
				throw new WorkflowPolicyError("quality_route_profile_not_strict", { qualityTier, role, profileId });
			}
			if (seenProfiles.has(profileId)) continue;
			seenProfiles.add(profileId);
			profileSnapshots.push({
				profile: cloneProfile(profile),
				configuredIdentity: configuredIdentityForProfile(profile),
			});
		}
	}
	const payload: QualityRouteSnapshotPayloadV1 = {
		schemaVersion: 1,
		qualityTier,
		degradedMode: false,
		routes,
		profiles: profileSnapshots,
	};
	return freezeDeep({ ...payload, fingerprint: snapshotFingerprint(payload) });
}

function assertSnapshotShape(value: unknown): asserts value is QualityRouteSnapshotV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new WorkflowPolicyError("quality_route_snapshot_invalid");
	}
	const snapshot = value as Partial<QualityRouteSnapshotV1>;
	if (
		snapshot.schemaVersion !== 1 ||
		(snapshot.qualityTier !== "balanced" && snapshot.qualityTier !== "critical") ||
		snapshot.degradedMode !== false ||
		typeof snapshot.fingerprint !== "string" ||
		!snapshot.routes ||
		!Array.isArray(snapshot.profiles)
	) {
		throw new WorkflowPolicyError("quality_route_snapshot_invalid");
	}
	for (const role of QUALITY_ROUTE_ROLES) {
		const ids = snapshot.routes[role];
		if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === "string" && id.length > 0)) {
			throw new WorkflowPolicyError("quality_route_snapshot_invalid_role", { role });
		}
	}
}

export function verifyQualityRouteSnapshot(value: unknown): QualityRouteSnapshotV1 {
	assertSnapshotShape(value);
	const { fingerprint, ...payload } = value;
	const expected = snapshotFingerprint(payload);
	if (fingerprint !== expected) {
		throw new WorkflowPolicyError("quality_route_snapshot_fingerprint_mismatch", {
			expected,
			actual: fingerprint,
		});
	}
	const profilesById = new Map(value.profiles.map(entry => [entry.profile.id, entry]));
	for (const role of QUALITY_ROUTE_ROLES) {
		for (const profileId of value.routes[role]) {
			const entry = profilesById.get(profileId);
			if (!entry?.profile.roles.includes(role) || entry.configuredIdentity.profileId !== profileId) {
				throw new WorkflowPolicyError("quality_route_snapshot_profile_mismatch", { role, profileId });
			}
		}
	}
	return freezeDeep(structuredClone(value));
}

export function qualityRouteProfiles(snapshot: QualityRouteSnapshotV1): ModelProfile[] {
	return snapshot.profiles.map(entry => cloneProfile(entry.profile));
}

export function qualityRouteProfileIds(
	snapshot: QualityRouteSnapshotV1 | undefined,
	role: WorkflowRole,
): readonly string[] | undefined {
	return snapshot?.routes[role];
}
