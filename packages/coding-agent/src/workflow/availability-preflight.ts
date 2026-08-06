import { randomUUID } from "node:crypto";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../tools";
import { AVAILABILITY_PROBE_TIMEOUT_MS } from "./availability-adapter";
import {
	type AvailabilityRoleSpec,
	availabilityProbeDedupeKey,
	buildAvailabilityCandidates,
	resolveAvailabilityRoleSpecs,
	rolesMissingProfiles,
	sortAvailabilityCandidates,
} from "./availability-candidates";
import { WorkflowCancelledError, WorkflowPolicyError } from "./errors";
import type { ModelRouter } from "./model-router";
import { redactSecretsInText } from "./secret-redact";
import type {
	AvailabilityScopeStatus,
	ModelProfile,
	WorkflowAvailabilityPort,
	WorkflowAvailabilityProbeResult,
	WorkflowAvailabilityProfileResult,
	WorkflowAvailabilityReport,
	WorkflowRole,
	WorkflowStatus,
} from "./types";

/** Synthetic profile id when a role has zero registry profiles (still appears in report). */
export const MISSING_PROFILE_ID = "(none)";

export const DEFAULT_AVAILABILITY_PER_TARGET_TIMEOUT_MS = AVAILABILITY_PROBE_TIMEOUT_MS;
export const DEFAULT_AVAILABILITY_OVERALL_TIMEOUT_MS = 60_000;
export const DEFAULT_AVAILABILITY_MAX_CONCURRENCY = 4;

/** True only for a timed-out diagnostic profile probe; identity/auth failures remain hard failures. */
export function isDiagnosticAvailabilityTimeout(
	profile: Pick<WorkflowAvailabilityProfileResult, "status" | "errorKind">,
): boolean {
	return profile.status === "unavailable" && profile.errorKind === "timeout";
}

export interface RunAvailabilityPreflightOptions {
	port: WorkflowAvailabilityPort;
	router: ModelRouter;
	workflowId: string;
	operation: "start" | "resume";
	status: WorkflowStatus;
	singleStep: boolean;
	session: ToolSession;
	signal?: AbortSignal;
	maxConcurrency?: number;
	perTargetTimeoutMs?: number;
	overallTimeoutMs?: number;
	/** Override auth-scope segment of the dedupe key (default "default"). */
	authScope?: string;
	/** Optional fixed invocation id for tests. */
	invocationId?: string;
	/** Optional wall clock (ms since epoch) for tests. */
	nowMs?: () => number;
}

/**
 * Build candidates → single-flight probe by runtime/model/auth-scope → expand per profile.
 * Required roles with zero registered profiles are reported unavailable and block the scope.
 */
export async function runAvailabilityPreflight(
	options: RunAvailabilityPreflightOptions,
): Promise<WorkflowAvailabilityReport> {
	const nowMs = options.nowMs ?? Date.now;
	const wallStart = nowMs();
	const invocationId = options.invocationId ?? `avail_${randomUUID()}`;
	const checkedAt = new Date(wallStart).toISOString();
	const scope = options.singleStep ? "single_step" : "full";
	const registrationOrder = options.router.list().map(p => p.id);

	const roleSpecs = resolveAvailabilityRoleSpecs(options.status, options.singleStep);

	// No model roles in scope (e.g. created→planning transition, verify-only stages).
	if (roleSpecs.length === 0) {
		return {
			workflowId: options.workflowId,
			invocationId,
			operation: options.operation,
			scope,
			checkedAt,
			wallLatencyMs: Math.max(0, nowMs() - wallStart),
			status: "not_required",
			profiles: [],
			usageKind: "diagnostic",
		};
	}

	const rawCandidates = buildAvailabilityCandidates({
		router: options.router,
		status: options.status,
		singleStep: options.singleStep,
		roleSpecs,
	});
	const candidates = sortAvailabilityCandidates(rawCandidates, registrationOrder);
	const missing = rolesMissingProfiles(roleSpecs, candidates);

	const authScope = options.authScope ?? "default";
	const perTargetTimeoutMs = options.perTargetTimeoutMs ?? DEFAULT_AVAILABILITY_PER_TARGET_TIMEOUT_MS;
	const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_AVAILABILITY_OVERALL_TIMEOUT_MS;
	const maxConcurrency = options.maxConcurrency ?? DEFAULT_AVAILABILITY_MAX_CONCURRENCY;

	// Group candidates by physical probe key (first member is the live probe representative).
	const groups = new Map<string, typeof candidates>();
	for (const candidate of candidates) {
		const key = availabilityProbeDedupeKey(candidate.profile, authScope);
		const group = groups.get(key);
		if (group) group.push(candidate);
		else groups.set(key, [candidate]);
	}

	const groupEntries = [...groups.entries()];
	const probeByKey = new Map<string, WorkflowAvailabilityProbeResult>();

	const overallController = new AbortController();
	const overallTimer = setTimeout(
		() => overallController.abort(new Error("availability overall timeout")),
		overallTimeoutMs,
	);
	try {
		await mapPool(groupEntries, maxConcurrency, async ([key, group]) => {
			const head = group[0]!;
			const result = await runPhysicalProbe({
				port: options.port,
				profile: head.profile,
				role: head.role,
				session: options.session,
				callerSignal: options.signal,
				overallSignal: overallController.signal,
				perTargetTimeoutMs,
			});
			probeByKey.set(key, {
				...result,
				errorSummary: result.errorSummary
					? redactSecretsInText(result.errorSummary).slice(0, 500)
					: result.errorSummary,
			});
		});
	} finally {
		clearTimeout(overallTimer);
	}

	const profiles: WorkflowAvailabilityProfileResult[] = [];
	for (const [key, group] of groupEntries) {
		const probe = probeByKey.get(key) ?? {
			status: "indeterminate" as const,
			latencyMs: 0,
			errorKind: "internal",
			errorSummary: "probe result missing",
		};
		// available without runtime identity → indeterminate (never invent from profile config).
		const normalized =
			probe.status === "available" && (!probe.actualProvider || !probe.actualModel)
				? {
						...probe,
						status: "indeterminate" as const,
						actualProvider: undefined,
						actualModel: undefined,
						errorKind: probe.errorKind ?? "missing_identity",
						errorSummary: probe.errorSummary ?? "probe response lacked actual provider/model identity",
					}
				: probe;
		for (let i = 0; i < group.length; i++) {
			const candidate = group[i]!;
			const row: WorkflowAvailabilityProfileResult = {
				profileId: candidate.profile.id,
				role: candidate.role,
				requirement: candidate.requirement,
				status: normalized.status,
				runtime: "embedded",
				source: i === 0 ? "live" : "shared_live",
				usageKind: "diagnostic",
			};
			if (normalized.localProvider) row.localProvider = normalized.localProvider;
			if (normalized.localModel) row.localModel = normalized.localModel;
			if (normalized.attestedProvider) row.attestedProvider = normalized.attestedProvider;
			if (normalized.attestedModel) row.attestedModel = normalized.attestedModel;
			if (normalized.attestedCheckpoint) row.attestedCheckpoint = normalized.attestedCheckpoint;
			if (normalized.identityProvenance) row.identityProvenance = normalized.identityProvenance;
			if (normalized.exactIdentityMatch !== undefined) row.exactIdentityMatch = normalized.exactIdentityMatch;
			if (normalized.effortSupported !== undefined) row.effortSupported = normalized.effortSupported;
			if (normalized.usage) row.usage = normalized.usage;
			if (normalized.reportedCostUsd !== undefined) row.reportedCostUsd = normalized.reportedCostUsd;
			if (normalized.status === "available") {
				row.actualProvider = normalized.actualProvider;
				row.actualModel = normalized.actualModel;
				row.latencyMs = normalized.latencyMs;
			} else {
				// Always record latency for live probes; shared rows reuse the same timing.
				row.latencyMs = normalized.latencyMs;
				if (normalized.errorKind) row.errorKind = normalized.errorKind;
				if (normalized.errorSummary) row.errorSummary = normalized.errorSummary;
			}
			profiles.push(row);
		}
	}

	// Required/conditional roles with zero registry profiles: still report unavailable rows.
	for (const spec of missing) {
		profiles.push(missingProfileRow(spec));
	}

	// Re-sort expanded rows for stable report order (group expansion can re-order roles).
	const profileIndex = new Map(registrationOrder.map((id, i) => [id, i]));
	const roleOrder = new Map(
		(["planner", "plan_reviewer", "plan_arbitrator", "implementer", "code_reviewer", "repair"] as WorkflowRole[]).map(
			(role, i) => [role, i],
		),
	);
	profiles.sort((a, b) => {
		const roleDelta = (roleOrder.get(a.role) ?? 99) - (roleOrder.get(b.role) ?? 99);
		if (roleDelta !== 0) return roleDelta;
		// Missing synthetic rows sort after real profiles for the same role.
		if (a.profileId === MISSING_PROFILE_ID && b.profileId !== MISSING_PROFILE_ID) return 1;
		if (b.profileId === MISSING_PROFILE_ID && a.profileId !== MISSING_PROFILE_ID) return -1;
		return (profileIndex.get(a.profileId) ?? 99) - (profileIndex.get(b.profileId) ?? 99);
	});

	const expectedRequiredRoles = roleSpecs.filter(s => s.requirement === "required").map(s => s.role);
	const { status, blockedRoles } = classifyScopeStatus(profiles, { expectedRequiredRoles });

	const physicalResults = [...probeByKey.values()];
	const usage = aggregateUsage(physicalResults.map(result => result.usage));
	const reportedCostUsd = aggregateReportedCost(physicalResults);
	return {
		workflowId: options.workflowId,
		invocationId,
		operation: options.operation,
		scope,
		checkedAt,
		wallLatencyMs: Math.max(0, nowMs() - wallStart),
		status,
		profiles,
		usageKind: "diagnostic",
		...(usage ? { usage } : {}),
		...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
		...(blockedRoles.length > 0 ? { blockedRoles } : {}),
	};
}

async function runPhysicalProbe(options: {
	port: WorkflowAvailabilityPort;
	profile: ModelProfile;
	role: WorkflowRole;
	session: ToolSession;
	callerSignal?: AbortSignal;
	overallSignal: AbortSignal;
	perTargetTimeoutMs: number;
}): Promise<WorkflowAvailabilityProbeResult> {
	if (options.callerSignal?.aborted) throw new WorkflowCancelledError("Availability preflight cancelled");
	if (options.overallSignal.aborted) return timeoutProbeResult("availability overall timeout");
	const startedAt = performance.now();

	const targetController = new AbortController();
	const targetTimer = setTimeout(
		() => targetController.abort(new Error("availability target timeout")),
		options.perTargetTimeoutMs,
	);
	const signals = [options.overallSignal, targetController.signal];
	if (options.callerSignal) signals.push(options.callerSignal);
	const signal = AbortSignal.any(signals);
	const {
		promise: aborted,
		resolve: resolveAborted,
		reject: rejectAborted,
	} = Promise.withResolvers<WorkflowAvailabilityProbeResult>();
	const onAbort = () => {
		if (options.callerSignal?.aborted) {
			rejectAborted(new WorkflowCancelledError("Availability preflight cancelled"));
			return;
		}
		resolveAborted(
			timeoutProbeResult(
				options.overallSignal.aborted ? "availability overall timeout" : "availability target timeout",
				performance.now() - startedAt,
			),
		);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([
			options.port.probe({
				profile: options.profile,
				role: options.role,
				session: options.session,
				signal,
				timeoutMs: options.perTargetTimeoutMs,
			}),
			aborted,
		]);
	} catch (error) {
		if (options.callerSignal?.aborted) throw new WorkflowCancelledError("Availability preflight cancelled");
		if (options.overallSignal.aborted || targetController.signal.aborted) {
			return timeoutProbeResult(
				options.overallSignal.aborted ? "availability overall timeout" : "availability target timeout",
				performance.now() - startedAt,
			);
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			status: "unavailable",
			latencyMs: performance.now() - startedAt,
			errorKind: "internal",
			errorSummary: message,
		};
	} finally {
		clearTimeout(targetTimer);
		signal.removeEventListener("abort", onAbort);
	}
}

function timeoutProbeResult(reason: string, latencyMs?: number): WorkflowAvailabilityProbeResult {
	return {
		status: "unavailable",
		...(latencyMs === undefined ? {} : { latencyMs }),
		errorKind: "timeout",
		errorSummary: reason,
		reportedCostUsd: null,
	};
}

function aggregateUsage(usages: Array<WorkflowAvailabilityProbeResult["usage"]>): Usage | undefined {
	const observed = usages.filter((usage): usage is Usage => usage !== undefined);
	if (observed.length === 0) return undefined;
	const aggregate = observed.reduce(
		(total, usage) => ({
			input: total.input + usage.input,
			output: total.output + usage.output,
			cacheRead: total.cacheRead + usage.cacheRead,
			cacheWrite: total.cacheWrite + usage.cacheWrite,
			totalTokens: total.totalTokens + usage.totalTokens,
			cost: {
				input: total.cost.input + usage.cost.input,
				output: total.cost.output + usage.cost.output,
				cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
				cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
				total: total.cost.total + usage.cost.total,
			},
			reasoningTokens: sumOptional(total.reasoningTokens, usage.reasoningTokens),
			premiumRequests: sumOptional(total.premiumRequests, usage.premiumRequests),
			orchestration: {
				input: sumOptional(total.orchestration?.input, usage.orchestration?.input),
				cacheRead: sumOptional(total.orchestration?.cacheRead, usage.orchestration?.cacheRead),
				output: sumOptional(total.orchestration?.output, usage.orchestration?.output),
			},
			cttl: {
				ephemeral5m: sumOptional(total.cttl?.ephemeral5m, usage.cttl?.ephemeral5m),
				ephemeral1h: sumOptional(total.cttl?.ephemeral1h, usage.cttl?.ephemeral1h),
			},
			server: {
				webSearch: sumOptional(total.server?.webSearch, usage.server?.webSearch),
				webFetch: sumOptional(total.server?.webFetch, usage.server?.webFetch),
			},
		}),
		{
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	);
	if (aggregate.reasoningTokens === undefined) delete aggregate.reasoningTokens;
	if (aggregate.premiumRequests === undefined) delete aggregate.premiumRequests;
	if (Object.values(aggregate.orchestration ?? {}).every(value => value === undefined)) delete aggregate.orchestration;
	if (Object.values(aggregate.cttl ?? {}).every(value => value === undefined)) delete aggregate.cttl;
	if (Object.values(aggregate.server ?? {}).every(value => value === undefined)) delete aggregate.server;
	return aggregate;
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
	return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function aggregateReportedCost(results: WorkflowAvailabilityProbeResult[]): number | null | undefined {
	if (results.length === 0) return undefined;
	let total = 0;
	for (const result of results) {
		if (result.reportedCostUsd === undefined || result.reportedCostUsd === null) return null;
		total += result.reportedCostUsd;
	}
	return total;
}

/** Report row when a role is in scope but no ModelProfile is registered for it. */
export function missingProfileRow(spec: AvailabilityRoleSpec): WorkflowAvailabilityProfileResult {
	return {
		profileId: MISSING_PROFILE_ID,
		role: spec.role,
		requirement: spec.requirement,
		status: "unavailable",
		runtime: "embedded",
		usageKind: "diagnostic",
		errorKind: "configuration",
		errorSummary: `no model profile registered for role ${spec.role}`,
	};
}

/** Fail-closed gate for resume: required role with zero available routes. */
export function assertRequiredRolesAvailable(report: WorkflowAvailabilityReport): void {
	if (report.status !== "blocked") return;
	const roles = report.blockedRoles ?? [];
	const roleList = roles.length > 0 ? roles.join(", ") : "unknown";
	// Embed role names in the reason so callers/tools surface them without inspecting details.
	throw new WorkflowPolicyError(`required_role_unavailable: ${roleList}`, {
		roles,
		role: roles[0],
		summary: `required role unavailable: ${roleList}`,
	});
}

export function classifyScopeStatus(
	profiles: WorkflowAvailabilityProfileResult[],
	options?: {
		/**
		 * Required roles that must have a usable route even if no profile rows exist yet.
		 * When omitted, required roles are inferred only from present profile rows.
		 */
		expectedRequiredRoles?: readonly WorkflowRole[];
	},
): {
	status: AvailabilityScopeStatus;
	blockedRoles: WorkflowRole[];
} {
	const expectedRequired = options?.expectedRequiredRoles ?? [];
	if (profiles.length === 0 && expectedRequired.length === 0) {
		return { status: "not_required", blockedRoles: [] };
	}

	const requiredRoles = new Set<WorkflowRole>([
		...profiles.filter(p => p.requirement === "required").map(p => p.role),
		...expectedRequired,
	]);
	const blockedRoles: WorkflowRole[] = [];
	let degraded = false;

	for (const role of requiredRoles) {
		const rows = profiles.filter(p => p.role === role && p.requirement === "required");
		// Zero rows for a required role ⇒ no route (missing registry profiles).
		if (rows.length === 0) {
			blockedRoles.push(role);
			continue;
		}
		const available = rows.filter(p => p.status === "available");
		if (available.length === 0) {
			if (rows.some(isDiagnosticAvailabilityTimeout)) {
				degraded = true;
				continue;
			}
			blockedRoles.push(role);
			continue;
		}
		// Primary = first in stable order for this role.
		const primary = rows[0];
		if (primary && primary.status !== "available") {
			degraded = true;
		}
	}

	if (blockedRoles.length > 0) return { status: "blocked", blockedRoles };

	// Conditional-only failures → degraded warning, not blocked.
	const conditionalFailed = profiles.some(p => p.requirement === "conditional" && p.status !== "available");
	if (degraded || conditionalFailed) return { status: "degraded", blockedRoles: [] };

	return { status: "ready", blockedRoles: [] };
}

/** Empty report when preflight is skipped (no port/session). */
export function skippedAvailabilityReport(options: {
	workflowId: string;
	operation: "start" | "resume";
	singleStep: boolean;
	reason?: string;
}): WorkflowAvailabilityReport {
	return {
		workflowId: options.workflowId,
		invocationId: `avail_skip_${randomUUID()}`,
		operation: options.operation,
		scope: options.singleStep ? "single_step" : "full",
		checkedAt: new Date().toISOString(),
		wallLatencyMs: 0,
		status: "not_required",
		profiles: [],
		usageKind: "diagnostic",
	};
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
	if (items.length === 0) return;
	const limit = Math.max(1, Math.min(concurrency, items.length));
	let next = 0;
	const workers = Array.from({ length: limit }, async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			await fn(items[index]!);
		}
	});
	await Promise.all(workers);
}
