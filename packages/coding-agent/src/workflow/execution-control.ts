/**
 * Thin execution-control entry for workflow model calls (Batch 1 F1).
 *
 * Identity layers:
 *   stageAttemptId
 *     └─ invocationId — unique per real re-execution
 *          └─ providerRequestId — unique per transport within that invocation
 *
 * Reuse identity only when redelivering the same call's result.
 * Creating a new model call must mint a new invocationId.
 *
 * Gate parse-retry, schema repair, and profile fallback share this budget +
 * deadline gate; error categories stay in gate-retry / adapter / engine.
 */
import { randomUUID } from "node:crypto";

/** Why a new model invocation is being prepared. */
export type ExecutionInvocationKind = "initial" | "schema_repair" | "gate_parse_retry" | "profile_fallback";

export interface ExecutionIdentity {
	/** Persistable stage attempt id from WorkflowStore.beginAttempt. */
	stageAttemptId: string;
	/** Unique per real model re-execution (not reusable across new calls). */
	invocationId: string;
}

export interface ExecutionWindowInput {
	kind: ExecutionInvocationKind;
	/** Wall-clock start of the enclosing control window (stage / adapter run). */
	startedAtMs: number;
	/** Absolute max runtime for this control window; omitted = no deadline. */
	maxRuntimeMs?: number;
	nowMs?: number;
	/** Shared budget gate — false means stop before minting/launching. */
	canSpend: () => boolean;
}

export interface PrepareExecutionInvocationInput extends ExecutionWindowInput {
	stageAttemptId: string;
	/**
	 * Only for redelivery / settlement of an already-launched call.
	 * Must not be supplied when creating a new paid model call.
	 */
	reuseIdentity?: ExecutionIdentity;
}

export type ExecutionWindowResult =
	| {
			action: "proceed";
			/** Remaining wall-clock budget to carry into the next call, when capped. */
			remainingRuntimeMs?: number;
			kind: ExecutionInvocationKind;
			elapsedMs: number;
	  }
	| {
			action: "stop";
			reason: "budget" | "deadline";
			kind: ExecutionInvocationKind;
			elapsedMs: number;
	  };

export type PrepareExecutionInvocationResult =
	| {
			action: "proceed";
			identity: ExecutionIdentity;
			remainingRuntimeMs?: number;
			kind: ExecutionInvocationKind;
	  }
	| {
			action: "stop";
			reason: "budget" | "deadline";
			kind: ExecutionInvocationKind;
			elapsedMs: number;
	  };

/** Mint a unique invocation id for one real model re-execution under a stage attempt. */
export function mintInvocationId(stageAttemptId: string, kind: ExecutionInvocationKind = "initial"): string {
	const safeStage = stageAttemptId.trim() || "stage";
	return `inv_${kind}_${safeStage}_${randomUUID()}`;
}

/**
 * Mint a provider transport id unique within an invocation.
 * Prefer a stable ordinal when redelivering the same transport settle;
 * otherwise include a UUID so distinct transports never collide.
 */
export function mintProviderRequestId(
	invocationId: string,
	ordinal: number,
	options?: { supplied?: string; redelivery?: boolean },
): string {
	const supplied = options?.supplied?.trim();
	if (supplied) return supplied;
	if (options?.redelivery) return `ord:${ordinal}`;
	return `prov_${invocationId}_${ordinal}_${randomUUID()}`;
}

/**
 * Shared budget + deadline gate for gate retry / schema repair / profile fallback.
 * Does not classify errors — callers keep gate/schema/provider categories.
 */
export function checkExecutionWindow(input: ExecutionWindowInput): ExecutionWindowResult {
	const now = input.nowMs ?? Date.now();
	const elapsedMs = Math.max(0, now - input.startedAtMs);
	const maxRuntime = input.maxRuntimeMs;
	if (typeof maxRuntime === "number" && maxRuntime > 0 && elapsedMs >= maxRuntime) {
		return { action: "stop", reason: "deadline", kind: input.kind, elapsedMs };
	}
	if (!input.canSpend()) {
		return { action: "stop", reason: "budget", kind: input.kind, elapsedMs };
	}
	const remainingRuntimeMs =
		typeof maxRuntime === "number" && maxRuntime > 0 ? Math.max(1, maxRuntime - elapsedMs) : undefined;
	return { action: "proceed", remainingRuntimeMs, kind: input.kind, elapsedMs };
}

/**
 * Budget/deadline gate plus identity mint (or explicit redelivery reuse).
 * RuntimeAdapter uses this before every real model launch.
 */
export function prepareExecutionInvocation(input: PrepareExecutionInvocationInput): PrepareExecutionInvocationResult {
	const window = checkExecutionWindow(input);
	if (window.action === "stop") return window;
	const identity =
		input.reuseIdentity &&
		input.reuseIdentity.stageAttemptId === input.stageAttemptId &&
		input.reuseIdentity.invocationId.trim().length > 0
			? input.reuseIdentity
			: {
					stageAttemptId: input.stageAttemptId,
					invocationId: mintInvocationId(input.stageAttemptId, input.kind),
				};
	return {
		action: "proceed",
		identity,
		remainingRuntimeMs: window.remainingRuntimeMs,
		kind: input.kind,
	};
}

/** Whether two identities refer to the same stage attempt + invocation (redelivery-safe). */
export function sameExecutionIdentity(a: ExecutionIdentity | undefined, b: ExecutionIdentity | undefined): boolean {
	if (!a || !b) return false;
	return a.stageAttemptId === b.stageAttemptId && a.invocationId === b.invocationId;
}
