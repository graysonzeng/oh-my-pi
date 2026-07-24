import { WorkflowPolicyError } from "./errors";
import type { ModelProfile, WorkflowRuntimeKind } from "./types";

/** Fields accepted on ModelProfile but not wired through the structured runner. */
const UNSUPPORTED_RUNTIME_FIELDS = ["toolAliases", "argumentAliases", "maxInputTokens", "maxOutputTokens"] as const;

const KNOWN_RUNTIME_KINDS = new Set<WorkflowRuntimeKind>(["embedded", "codex_cli", "claude_cli"]);

/**
 * Normalize a model profile for workflow use.
 * Omitted runtime resolves to embedded; invalid combinations fail closed.
 */
export function normalizeModelProfile(profile: ModelProfile): ModelProfile {
	const runtime = profile.runtime ?? { kind: "embedded" as const };
	if (!KNOWN_RUNTIME_KINDS.has(runtime.kind)) {
		throw new WorkflowPolicyError("unsupported_runtime_kind", {
			profileId: profile.id,
			runtimeKind: runtime.kind,
			hint: "Supported kinds: embedded, codex_cli, claude_cli",
		});
	}
	if (runtime.kind !== "codex_cli" && runtime.profile !== undefined) {
		throw new WorkflowPolicyError("runtime_profile_only_supported_by_codex_cli", {
			profileId: profile.id,
			runtimeKind: runtime.kind,
		});
	}
	if (runtime.executable !== undefined && !runtime.executable.trim()) {
		throw new WorkflowPolicyError("runtime_executable_must_not_be_empty", { profileId: profile.id });
	}
	// Reject shell metacharacters in executable — binary name or absolute path only.
	if (runtime.executable !== undefined && /[;|&`$()<>\n]/.test(runtime.executable)) {
		throw new WorkflowPolicyError("runtime_executable_must_not_contain_shell_metacharacters", {
			profileId: profile.id,
		});
	}
	return { ...profile, runtime: { ...runtime } };
}

/**
 * Reject profile fields the task/structured-subagent runtime cannot honor.
 * Supported mappings today: thinkingLevel, disabledTools, maxRuntimeMs, contextPolicy, modelPattern, runtime.
 */
export function assertSupportedModelProfile(profile: ModelProfile): void {
	for (const field of UNSUPPORTED_RUNTIME_FIELDS) {
		if (profile[field] !== undefined) {
			throw new WorkflowPolicyError("unsupported_model_profile_field", {
				profileId: profile.id,
				field,
				hint: "Remove unsupported fields or map them through the structured-subagent API first",
			});
		}
	}
	// Normalize to surface invalid runtime combinations; do not require callers to pre-normalize.
	normalizeModelProfile(profile);
}

export class ModelProfileRegistry {
	readonly #profiles = new Map<string, ModelProfile>();

	constructor(profiles: Iterable<ModelProfile> = []) {
		for (const profile of profiles) this.register(profile);
	}

	register(profile: ModelProfile): void {
		const normalized = normalizeModelProfile(profile);
		assertSupportedModelProfile(normalized);
		this.#profiles.set(normalized.id, normalized);
	}

	get(id: string): ModelProfile | undefined {
		return this.#profiles.get(id);
	}

	list(): ModelProfile[] {
		return [...this.#profiles.values()];
	}
}
