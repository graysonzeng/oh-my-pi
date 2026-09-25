import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AdaptedCompiledPolicy,
	compileFromWorkflowRequestFields,
	profileIdentityFromWorkflowProfile,
} from "../model-policy/adapters";
import type { CompiledModelPolicyReceiptV1, CompiledModelPolicyV1 } from "../model-policy/types";
import codeReviewerPrompt from "../prompts/workflow/code-reviewer.md" with { type: "text" };
import implementerPrompt from "../prompts/workflow/implementer.md" with { type: "text" };
import planReviewerPrompt from "../prompts/workflow/plan-reviewer.md" with { type: "text" };
import plannerPrompt from "../prompts/workflow/planner.md" with { type: "text" };
import repairPrompt from "../prompts/workflow/repair.md" with { type: "text" };
import type { ToolSession } from "../tools";
import type { WorkflowToolOptimization } from "../tools/workflow-session-fields";
import {
	buildContextLedger,
	type ContextArtifactAdapter,
	type ContextEntry,
	type ContextLedgerV1,
	type ContextOptimizationReceiptV1,
	optimizeContextEntries,
} from "./context-ledger";
import { WorkflowCancelledError, WorkflowPolicyError } from "./errors";
import {
	sha256Hex,
	type ToolOptimizationReceiptV1,
	type ToolOutputArtifactAdapter,
	type WorkflowToolOptimizationResult,
} from "./optimization-receipt";
import { productionPolicyFeatureGates } from "./policy-experiment";
import {
	applyPresentationPolicy,
	formatToolCatalogSummary,
	resolveWorkflowPresentation,
	toolSchemaLocator,
	type WorkflowPresentationPolicy,
} from "./presentation-policy";
import { assemblePrompt, type PromptAssemblyReceiptV1 } from "./prompt-assembly";
import { applyPromptStrategy, buildStablePromptSections } from "./prompt-strategy";
import { enhanceSchemaForProfile, type ToolDescriptor, transformToolsForProfile } from "./schema-enhancer";
import { processToolOutputDetailed } from "./tool-output-manager";
import { isReadonlyWorkflowRole, ToolPolicyFactory, wrapSessionForWorkflowRole } from "./tool-policy";
import type { ModelProfile, WorkflowAgentRequest, WorkflowIsolationControls } from "./types";

/** Sanitize tool name for the middle segment of `${id}.${tool}.log`. */
function sanitizeArtifactToolName(toolName: string): string {
	return toolName.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64) || "tool";
}

/** True when any file in `dir` already claims this numeric artifact id. */
function artifactIdTaken(dir: string, id: string): boolean {
	try {
		return fs.readdirSync(dir).some(f => f.startsWith(`${id}.`));
	} catch {
		return false;
	}
}

/**
 * Highest numeric id among `N.*.log` files, or -1 when dir is empty/missing.
 * Mirrors ArtifactManager.#scanExistingIds so fallback ids share the same space.
 */
function maxExistingArtifactId(dir: string): number {
	try {
		let maxId = -1;
		for (const file of fs.readdirSync(dir)) {
			const match = file.match(/^(\d+)\..*\.log$/);
			if (!match) continue;
			const id = Number.parseInt(match[1], 10);
			if (id > maxId) maxId = id;
		}
		return maxId;
	} catch {
		return -1;
	}
}

/**
 * Allocate a free numeric artifact id without racing resume-session files.
 *
 * When a manager is present: advance allocateId() past any on-disk ids so bare
 * counters left at 0 after resume cannot clobber `0.*.log` (Blocker 1).
 * Without a manager: disk max+1 — always numeric so artifact:// can resolve (Blocker 2).
 */
function allocateFreeArtifactId(dir: string, manager?: { allocateId(): number }): string {
	if (manager) {
		// ponytail: linear skip of taken ids; switch to exclusive alloc if id space thrash matters
		for (let n = 0; n < 100_000; n++) {
			const id = String(manager.allocateId());
			if (!artifactIdTaken(dir, id)) return id;
		}
		throw new Error("artifact id space exhausted");
	}
	return String(maxExistingArtifactId(dir) + 1);
}

/**
 * Sync artifact adapter for processResult (lossy tool output recovery).
 * processToolOutputDetailed only honors sync saveRaw returns (Promise is ignored),
 * so we stay sync: readdirSync + exclusive create, never invent non-numeric ids.
 */
function createSessionArtifactAdapter(session: ToolSession): ToolOutputArtifactAdapter {
	return {
		saveRaw: (toolName: string, fullText: string): string | undefined => {
			try {
				const manager = session.getArtifactManager?.();
				const dir = manager?.dir ?? session.getArtifactsDir?.() ?? undefined;
				if (!dir) return undefined;

				const safe = sanitizeArtifactToolName(toolName);
				fs.mkdirSync(dir, { recursive: true });

				// wx + retry: exclusive create so concurrent/fallback alloc never overwrites.
				for (let attempt = 0; attempt < 32; attempt++) {
					const id = allocateFreeArtifactId(dir, manager ?? undefined);
					const filePath = path.join(dir, `${id}.${safe}.log`);
					try {
						fs.writeFileSync(filePath, fullText, { encoding: "utf-8", flag: "wx" });
						return id;
					} catch (err) {
						const code = (err as NodeJS.ErrnoException).code;
						if (code === "EEXIST") continue;
						throw err;
					}
				}
				return undefined;
			} catch {
				return undefined;
			}
		},
	};
}
export interface SessionArtifactRecord {
	uri: string;
	sha256: string;
	path: string;
}

/** Persist immutable bytes into the session ArtifactManager namespace and verify them by readback. */
export async function persistSessionArtifact(
	session: ToolSession,
	content: string,
	kind: string,
	expectedSha256 = sha256Hex(content),
): Promise<SessionArtifactRecord | null> {
	const manager = session.getArtifactManager?.() ?? null;
	const dir = manager?.dir ?? session.getArtifactsDir?.() ?? null;
	if (!dir) return null;
	await fs.promises.mkdir(dir, { recursive: true });
	const safeKind = sanitizeArtifactToolName(kind);
	for (let attempt = 0; attempt < 64; attempt++) {
		const allocated = manager ? await manager.allocatePath(safeKind) : null;
		const id = allocated?.id ?? allocateFreeArtifactId(dir);
		const filePath = allocated?.path ?? path.join(dir, `${id}.${safeKind}.log`);
		let handle: fs.promises.FileHandle | undefined;
		try {
			handle = await fs.promises.open(filePath, "wx");
			await handle.writeFile(content, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			const immutableSha256 = sha256Hex(await fs.promises.readFile(filePath, "utf8"));
			if (immutableSha256 !== expectedSha256) {
				await fs.promises.rm(filePath, { force: true });
				return null;
			}
			return { uri: `artifact://${id}`, sha256: immutableSha256, path: filePath };
		} catch (error) {
			await handle?.close().catch(() => undefined);
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
			return null;
		}
	}
	return null;
}

function createSessionContextArtifactAdapter(session: ToolSession): ContextArtifactAdapter | null {
	if (!session.getArtifactManager?.() && !session.getArtifactsDir?.()) return null;
	const storedPaths = new Map<string, string>();
	const removeStoredPath = async (uri: string): Promise<void> => {
		const filePath = storedPaths.get(uri);
		if (!filePath) return;
		storedPaths.delete(uri);
		await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
	};
	return {
		async persist(entry, sha256) {
			const stored = await persistSessionArtifact(session, entry.content, `context-${entry.kind}`, sha256);
			if (!stored) throw new Error("context artifact persistence failed");
			storedPaths.set(stored.uri, stored.path);
			return { uri: stored.uri, sha256: stored.sha256 };
		},
		async verify(uri, sha256) {
			let filePath = storedPaths.get(uri);
			if (!filePath && /^artifact:\/\/\d+$/.test(uri)) {
				const id = uri.slice("artifact://".length);
				filePath = (await session.getArtifactManager?.()?.getPath(id)) ?? undefined;
				if (!filePath) {
					const dir = session.getArtifactsDir?.();
					const file = dir ? (await fs.promises.readdir(dir)).find(name => name.startsWith(`${id}.`)) : undefined;
					if (dir && file) filePath = path.join(dir, file);
				}
			}
			if (!filePath) return false;
			try {
				const verified = sha256Hex(await fs.promises.readFile(filePath, "utf8")) === sha256;
				if (!verified) await removeStoredPath(uri);
				return verified;
			} catch {
				await removeStoredPath(uri);
				return false;
			}
		},
	};
}

export async function optimizeWorkflowRequestContext(request: WorkflowAgentRequest): Promise<{
	request: WorkflowAgentRequest;
	receipts: ContextOptimizationReceiptV1[];
}> {
	if (!request.contextEntries?.length) return { request, receipts: [] };
	const artifact = createSessionContextArtifactAdapter(request.session);
	if (!artifact) return { request, receipts: [] };
	const optimized = await optimizeContextEntries(request.contextEntries, artifact);
	return {
		request: { ...request, contextEntries: optimized.entries },
		receipts: optimized.receipts,
	};
}

/** Versioned workflow role prompts keyed by ModelProfile.promptTemplate. */
export const WORKFLOW_PROMPTS: Readonly<Record<string, string>> = {
	planner: plannerPrompt,
	"plan-reviewer": planReviewerPrompt,
	implementer: implementerPrompt,
	"code-reviewer": codeReviewerPrompt,
	repair: repairPrompt,
};

/**
 * Split a prepared context blob into dynamic assembly sections without inventing content.
 * Recognizes optional markdown markers for repo-map and history; everything else is handoff.
 * Missing markers leave those sections empty (skipped by assemblePrompt).
 */
export function splitDynamicContextSections(context: string): {
	repoMap: string;
	history: string;
	handoff: string;
} {
	const text = context.trim();
	if (!text) return { repoMap: "", history: "", handoff: "" };

	// Prefer explicit section headers when stages inject them; otherwise whole body is handoff.
	const repoMapRe = /(?:^|\n)(##\s*Repo(?:\s*map)?\b[^\n]*\n[\s\S]*?)(?=\n##\s|\s*$)/i;
	const historyRe = /(?:^|\n)(##\s*(?:Conversation\s*)?History\b[^\n]*\n[\s\S]*?)(?=\n##\s|\s*$)/i;

	let repoMap = "";
	let history = "";
	let remainder = text;

	const repoMatch = remainder.match(repoMapRe);
	if (repoMatch?.[1]) {
		repoMap = repoMatch[1].trim();
		remainder = remainder.replace(repoMatch[0], "\n").trim();
	}
	const historyMatch = remainder.match(historyRe);
	if (historyMatch?.[1]) {
		history = historyMatch[1].trim();
		remainder = remainder.replace(historyMatch[0], "\n").trim();
	}

	return { repoMap, history, handoff: remainder };
}

/**
 * Inject static role prompt into the request sent to the runner.
 * When profile.promptStrategy is set, applies per-model style template (concise/structured/explicit).
 */
export function injectWorkflowPrompt(
	promptTemplate: string,
	assignment: string,
	context?: string,
	profile?: Pick<ModelProfile, "promptStrategy">,
	role?: WorkflowAgentRequest["role"],
	outputSchema?: unknown,
): { assignment: string; context?: string; styleMarker?: string | null } {
	const template = WORKFLOW_PROMPTS[promptTemplate]?.trim();
	if (!template) return { assignment, context, styleMarker: null };

	if (profile?.promptStrategy && role) {
		const applied = applyPromptStrategy({
			profile,
			role,
			rolePrompt: template,
			context: context?.trim() ? `## Context\n${context}` : undefined,
			assignment,
			outputSchema,
		});
		return { assignment, context: applied.context, styleMarker: applied.styleMarker };
	}

	const ctx = context?.trim() ? `${template}\n\n## Context\n${context}` : template;
	return { assignment, context: ctx, styleMarker: null };
}

/**
 * When workflow write stages request isolation but global task.isolation.mode is "none",
 * override to "auto" so production workflow is not dead on open.
 */
export function wrapSessionForWorkflowIsolation(session: ToolSession, isolationRequested: boolean): ToolSession {
	if (!isolationRequested) return session;
	const settings = session.settings;
	if (!settings?.get) return session;
	const current = settings.get("task.isolation.mode" as never) as string | undefined;
	if (current && current !== "none") return session;
	return {
		...session,
		settings: {
			...settings,
			get: (key: never) => {
				if ((key as string) === "task.isolation.mode") return "auto";
				return settings.get(key);
			},
		} as ToolSession["settings"],
	};
}

/** Provider-neutral prepared invocation shared by embedded and CLI adapters. */
export interface PreparedWorkflowInvocation {
	request: WorkflowAgentRequest;
	assignment: string;
	context?: string;
	readonly: boolean;
	isolation?: WorkflowIsolationControls;
	isolationRequested: boolean;
	allowedTools?: string[];
	session: ToolSession;
	/** Non-null when a per-model style template was applied. */
	styleMarker?: string | null;
	/** Schema after outputStrategy enhancement (may equal request.outputSchema). */
	outputSchema?: unknown;
	/** Apply toolStrategy truncation/summarization to a tool result string. */
	processToolResult: (toolName: string, output: string, args?: unknown) => string;
	/**
	 * Detailed optimization result (text + receipt). Production live path writes
	 * the same receipts onto session.workflowToolOptimization.optimizationReceipts.
	 */
	processToolResultDetailed: (toolName: string, output: string, args?: unknown) => WorkflowToolOptimizationResult;
	/** Remap tool descriptors with profile aliases for the model wire surface. */
	transformTools: (tools: ToolDescriptor[]) => ToolDescriptor[];
	/** Prompt assembly receipt for this invocation (always produced). */
	promptAssemblyReceipt: PromptAssemblyReceiptV1;
	/** Versioned per-request context bucket ledger; provider facts merge after response. */
	contextLedger: ContextLedgerV1;
	/**
	 * Full assembled prompt text (stable prefix + dynamic suffix).
	 * Production runner must send this as the model-facing context body.
	 */
	assembledPromptText: string;
	/** Resolved presentation policy (default direct / disabled). */
	presentationPolicy: WorkflowPresentationPolicy;
	/** Shared receipt log also referenced from session.workflowToolOptimization. */
	optimizationReceipts: ToolOptimizationReceiptV1[];
	/** Tool policy id actually applied (named override or role default). */
	resolvedToolPolicyId: string;
	/**
	 * Capability-compiled policy (shadow by default). Does not replace role
	 * allowlist / presentation / existing profile execution.
	 */
	compiledPolicy?: CompiledModelPolicyV1;
	/** Deterministic receipt for the compiled policy. */
	compiledReceipt?: CompiledModelPolicyReceiptV1;
}

interface PreparedContextOptimization {
	receipts: readonly ContextOptimizationReceiptV1[];
}

/**
 * Shared workflow-owned preparation before provider-specific execution.
 * Rejects aborted requests and readonly isolation; injects prompts/policy/tools;
 * applies per-model prompt, schema, and tool strategies.
 */
export function prepareWorkflowInvocation(
	request: WorkflowAgentRequest,
	contextOptimization: PreparedContextOptimization = { receipts: [] },
): PreparedWorkflowInvocation {
	if (request.signal?.aborted) {
		throw new WorkflowCancelledError("aborted before runtime call");
	}

	const readonlyRole = isReadonlyWorkflowRole(request.role);
	if (readonlyRole && request.isolation?.requested) {
		throw new WorkflowPolicyError("readonly_role_isolation_forbidden", {
			role: request.role,
			hint: "planner/plan_reviewer/code_reviewer cannot request isolation",
		});
	}

	const isolation = readonlyRole ? undefined : request.isolation;
	const isolationRequested = isolation?.requested === true;

	const enhancedSchema = enhanceSchemaForProfile(request.outputSchema, request.profile);

	// Stable style + role (no assignment / stage handoff) for cache-friendly prefix.
	const rolePromptBody = WORKFLOW_PROMPTS[request.profile.promptTemplate]?.trim() ?? "";
	const stableParts = buildStablePromptSections({
		profile: request.profile,
		role: request.role,
		rolePrompt: rolePromptBody,
		outputSchema: enhancedSchema,
	});
	const styleMarker = stableParts.styleMarker;

	// Dynamic-only body: stage handoff / repo notes from the request — never re-inject style or role.
	const dynamicContext = request.context?.trim() ?? "";
	const outputPrefix = request.profile.outputStrategy?.outputPrefixPrompt?.trim();
	// outputPrefix is profile-stable but short; keep it with role policy rather than dynamic body.
	const rolePolicyWithPrefix = [stableParts.rolePolicy, outputPrefix].filter(Boolean).join("\n\n");

	let session = wrapSessionForWorkflowRole(request.session, request.role);
	session = wrapSessionForWorkflowIsolation(session, isolationRequested);

	const policyFactory = new ToolPolicyFactory();
	const rolePolicy = policyFactory.getPolicyForRole(request.role);
	// Honor profile.toolPolicyId when it names a known policy id; otherwise keep role default.
	const namedPolicyId = request.profile.toolPolicyId?.trim();
	let policy = rolePolicy;
	if (namedPolicyId && namedPolicyId !== rolePolicy.policyId) {
		if (
			namedPolicyId === "readonly-planning" ||
			namedPolicyId === "readonly-review" ||
			namedPolicyId === "readonly-default"
		) {
			policy = { ...policyFactory.getPolicyForRole("planner"), policyId: namedPolicyId };
		} else if (namedPolicyId === "scoped-repair") {
			policy = policyFactory.getPolicyForRole("repair");
		} else if (namedPolicyId === "scoped-implementation") {
			policy = policyFactory.getPolicyForRole("implementer");
		}
	}
	const resolvedToolPolicyId = policy.policyId;
	// A named readonly policy on a write role must still force readonly wrap
	// (readonly-planning/review/default are the only ids that change surface).
	if (!policy.readonly) {
		session = {
			...session,
			workflowWritePolicy: {
				repoRoot: request.session.cwd,
				forbiddenPaths: [...policy.forbiddenPaths],
			},
			workflowCommandPolicy: { allowedCommands: [...policy.allowedCommands] },
		};
	} else if (namedPolicyId && namedPolicyId !== rolePolicy.policyId) {
		// Named readonly policy on a write role must still force readonly wrap.
		session = wrapSessionForWorkflowRole(session, "planner");
	}
	if (!policy.readonly) {
		session = {
			...session,
			workflowWritePolicy: {
				repoRoot: request.session.cwd,
				forbiddenPaths: [...policy.forbiddenPaths],
			},
			workflowCommandPolicy: { allowedCommands: [...policy.allowedCommands] },
		};
	} else if (namedPolicyId && namedPolicyId !== rolePolicy.policyId) {
		// Named readonly policy on a write role must still force readonly wrap.
		session = wrapSessionForWorkflowRole(session, "planner");
	}
	const allowedTools: readonly string[] | undefined = policy.readonly
		? policyFactory.allowedToolsForRole("planner")
		: policy.allowedTools.length === 1 && policy.allowedTools[0] === "*"
			? undefined
			: policy.allowedTools;
	const disabled = new Set(request.profile.disabledTools ?? []);
	let effectiveTools =
		allowedTools && disabled.size > 0 ? allowedTools.filter((t: string) => !disabled.has(t)) : allowedTools;

	// Capability compile (shadow by default). Role allowlist already computed;
	// compiler never expands it. Existing profile/presentation/schema stay authoritative.
	const productionFeatureGates = productionPolicyFeatureGates(
		request.modelPolicyFeatureGates,
		request.policyExperimentReceipt,
	);
	const adaptedPolicy: AdaptedCompiledPolicy = compileFromWorkflowRequestFields({
		// plan_arbitrator reuses the plan-reviewer adapter/task-class surface.
		role: request.role === "plan_arbitrator" ? "plan_reviewer" : request.role,
		assignment: request.assignment,
		allowedToolIds: effectiveTools,
		outputSchema: enhancedSchema,
		profileIdentity: profileIdentityFromWorkflowProfile(request.profile),
		model: request.model,
		modelFacts: request.modelFacts,
		sessionPolicyState: request.sessionPolicyState,
		modelPolicyFeatureGates: productionFeatureGates,
		semanticTools: request.semanticTools,
		turnOrStageId: `${request.workflowId}:${request.attemptId}:${request.role}`,
	});

	// Settings gate: workflow.presentationOptimization.enabled (default false).
	// When true, catalog mode can enable without hand-editing every profile.
	const settingsEnabled =
		request.session.settings?.get?.("workflow.presentationOptimization.enabled" as never) === true;

	// Gated presentation policy (default: direct / disabled). Restricted children never
	// discover tools outside the role allowlist — presentation further narrows the surface.
	const presentationPolicy = resolveWorkflowPresentation(request.profile.presentationPolicy, {
		settingsEnabled,
	});

	// Skill catalog: only when presentation optimization is enabled.
	// Feature-off must not read/inline skill bodies into skill_catalog (default path stays lean).
	// Feature-on: autoload skills get full body in the prompt; others get name+desc+xd://skills locator;
	// readable bodies land in presentationSkillBodies for one-hop xd://skills expand.
	const sessionSkills = (
		request.session as {
			skills?: Array<{ name: string; description?: string; filePath?: string; content?: string }>;
		}
	).skills;
	const autoloadSet = new Set(presentationPolicy.autoloadSkills);
	const presentationSkillBodies = new Map<string, string>();
	const skillInputs =
		sessionSkills?.map(s => {
			const isAutoload = autoloadSet.has(s.name);
			let body: string | undefined;
			if (presentationPolicy.enabled) {
				// Prefer in-memory content; otherwise load SKILL.md for autoload / expand catalog.
				body = typeof s.content === "string" && s.content.length > 0 ? s.content : undefined;
				if (!body && typeof s.filePath === "string" && s.filePath.length > 0) {
					try {
						if (fs.existsSync(s.filePath)) {
							body = fs.readFileSync(s.filePath, "utf-8");
						}
					} catch {
						body = undefined;
					}
				}
				if (body !== undefined) presentationSkillBodies.set(s.name, body);
			}
			return {
				name: s.name,
				summary: s.description?.trim() || s.name,
				// Body only supplied when feature is on; policy decides surface vs expand-map only.
				body,
				autoload: isAutoload,
			};
		}) ?? [];

	let presentedSkillsText = "";
	if (effectiveTools) {
		const presented = applyPresentationPolicy({
			policy: presentationPolicy,
			allowedToolNames: effectiveTools,
			tools: effectiveTools.map(name => ({ name, summary: name })),
			skills: skillInputs,
			role: request.role,
		});
		// Catalog mode still lists non-essential tools (with locators); hard filter only drops
		// tools outside the allowlist. Keep presented.toolOrder as the prepared allowlist.
		effectiveTools = presented.toolOrder;
		presentedSkillsText = presented.skillPresentationText;
		// Ensure presented autoload bodies are registered for expand even if file load failed earlier.
		for (const sk of presented.skills) {
			if (sk.body) presentationSkillBodies.set(sk.name, sk.body);
		}
	}

	const toolStrategy = request.profile.toolStrategy;
	// Shared mutable log — live bash/read/grep processResult appends here.
	const optimizationReceipts: ToolOptimizationReceiptV1[] = [];
	const artifactAdapter = createSessionArtifactAdapter(session);
	const presentationToolSchemas = new Map<string, unknown>();

	const processToolResultDetailed = (
		toolName: string,
		output: string,
		args?: unknown,
	): WorkflowToolOptimizationResult => {
		const detailed = processToolOutputDetailed(output, toolName, toolStrategy, args, artifactAdapter);
		if (detailed.receipt) {
			optimizationReceipts.push(detailed.receipt);
			if (session.workflowToolOptimization) {
				session.workflowToolOptimization.lastOptimizationReceipt = detailed.receipt;
			}
		}
		return detailed;
	};

	const processToolResult = (toolName: string, output: string, args?: unknown) =>
		processToolResultDetailed(toolName, output, args).text;

	const transformTools = (tools: ToolDescriptor[]) => {
		const aliased = transformToolsForProfile(tools, request.profile);
		// Always capture full schemas for expand (even in direct mode — no harm).
		for (const t of aliased) {
			if (t.schema !== undefined) presentationToolSchemas.set(t.name, t.schema);
		}
		if (!presentationPolicy.enabled || presentationPolicy.mode !== "catalog") {
			// Direct: stable name order, full schemas retained.
			return [...aliased].sort((a, b) => a.name.localeCompare(b.name));
		}
		const essential = new Set(presentationPolicy.essentialTools);
		const allow = effectiveTools ? new Set(effectiveTools) : null;
		return (
			aliased
				// Never drop yield: structured children require it to terminate even when
				// the role allowlist was authored without an explicit yield entry.
				.filter(t => t.name === "yield" || !allow || allow.has(t.name))
				.map(t => {
					if (t.name === "yield" || essential.has(t.name) || t.essential === true) return t;
					// Catalog: drop full schema; keep name + short description + locator.
					const { schema: _schema, ...rest } = t;
					const oneLine = t.description ?? t.name;
					const locator = toolSchemaLocator(t.name);
					return {
						...rest,
						description: formatToolCatalogSummary(t.name, oneLine),
						schemaLocator: locator,
					} as ToolDescriptor;
				})
				.sort((a, b) => a.name.localeCompare(b.name))
		);
	};

	const toolAliases = {
		...(request.profile.toolStrategy?.toolAliases ?? {}),
		...(request.profile.toolAliases ?? {}),
	};
	const argumentAliases = {
		...(request.profile.toolStrategy?.argumentAliases ?? {}),
		...(request.profile.argumentAliases ?? {}),
	};

	// Prompt assembly on the real prepared path (stable prefix vs dynamic handoff).
	// Fixed order: system → role/policy → tools → skills | assignment → repo-map → handoff → history.
	// Unstable runtime ids (workflowId, attemptId), wall-clock, and live budget stay out of sections.
	// Stable tool presentation: name-sorted comma list (presentation policy already ordered tools).
	const toolNames = [...(effectiveTools ?? ["*"])].sort((a, b) => a.localeCompare(b));
	const toolPresentationText = toolNames.join(",");
	// Split dynamic-only body: style/role must NOT appear here (they live in stable sections only).
	const { repoMap, history, handoff: handoffRaw } = splitDynamicContextSections(dynamicContext);
	const handoff = handoffRaw && !/^##\s/m.test(handoffRaw.trimStart()) ? `## Context\n${handoffRaw}` : handoffRaw;
	const explicitContextEntries = request.contextEntries ?? [];
	const explicitContextText = explicitContextEntries
		.map(entry => entry.content)
		.filter(Boolean)
		.join("\n\n");
	const historyWithExplicitEntries = [history, explicitContextText].filter(Boolean).join("\n\n");
	const assembled = assemblePrompt({
		sections: [
			{
				id: "system_static",
				// Full style template body (stable vars only) — not a tiny marker.
				content: stableParts.systemStatic,
				source: `workflow-style:${stableParts.styleMarker || "default"}`,
				authority: "system",
				stable: true,
			},
			{
				id: "role_policy",
				content: rolePolicyWithPrefix,
				stable: true,
				source: `workflow-role:${request.role}`,
				authority: "developer",
			},
			{
				id: "tool_presentation",
				content: toolPresentationText,
				stable: true,
				source: "workflow-tool-presentation",
				authority: "tool",
			},
			{
				id: "skill_catalog",
				content: presentedSkillsText,
				stable: true,
				source: "workflow-skill-catalog",
				authority: "developer",
			},
			{
				id: "assignment",
				content: request.assignment,
				stable: false,
				source: "workflow-request.assignment",
				authority: "user",
			},
			{
				id: "repo_map",
				content: repoMap,
				stable: false,
				source: "dynamic-context.repo_map",
				authority: "tool",
			},
			{
				id: "handoff",
				content: handoff,
				stable: false,
				source: "dynamic-context.handoff",
				authority: "developer",
			},
			{
				id: "history",
				content: historyWithExplicitEntries,
				stable: false,
				source: "dynamic-context.history",
				authority: "tool",
			},
		],
		// Provider cache counters not available at prepare time — never invent zeros.
		// RuntimeAdapter merges usage.cacheRead/cacheWrite after the model responds.
		cacheObservable: false,
	});
	const ledgerEntries: ContextEntry[] = [
		{ id: "system_static", bucket: "system_static", kind: "other", content: stableParts.systemStatic },
		{ id: "role_policy", bucket: "role_policy", kind: "other", content: rolePolicyWithPrefix },
		{ id: "tool_schema", bucket: "tool_schema", kind: "tool_delta", content: toolPresentationText },
		{ id: "skill_catalog", bucket: "skill_catalog", kind: "skill_delta", content: presentedSkillsText },
		{ id: "assignment", bucket: "assignment", kind: "other", content: request.assignment },
		{ id: "repo_map", bucket: "repo_map", kind: "other", content: repoMap },
		{ id: "handoff", bucket: "handoff", kind: "other", content: handoff },
		{ id: "history", bucket: "history", kind: "other", content: history },
	];
	ledgerEntries.push(...explicitContextEntries.map(entry => ({ ...entry })));
	const contextLedger = buildContextLedger({
		requestId: `${request.workflowId}:${request.attemptId}:${request.role}`,
		provider: adaptedPolicy.modelFacts.identity.provider,
		model: adaptedPolicy.modelFacts.identity.model,
		api: adaptedPolicy.modelFacts.identity.api,
		entries: ledgerEntries,
		artifactRefs: contextOptimization.receipts.map(receipt => receipt.artifactRef),
		optimizationReceipts: contextOptimization.receipts,
	});

	// remainingToolCalls is a hard agent-loop execution budget (skip after N calls).
	// Do NOT map contextStrategy.toolHistory.maxToolCalls here — that field only
	// tightens eviction keepRecentN via withToolHistoryEviction (default 5–15).
	// Prefer explicit toolStrategy.remainingToolCalls; otherwise unlimited (null).
	const remainingToolCalls: number | null =
		typeof toolStrategy?.remainingToolCalls === "number" ? toolStrategy.remainingToolCalls : null;
	const remainingStageTimeMs: number | null =
		typeof toolStrategy?.remainingStageTimeMs === "number" ? toolStrategy.remainingStageTimeMs : null;
	// Only set conflict mode when scheduling is opted in via maxConcurrent / budget /
	// explicit mode — avoid forcing toolScheduling on every structured subagent.
	const resourceConflictMode = toolStrategy?.resourceConflictMode;

	const compiledConcurrencyCeiling =
		adaptedPolicy.receipt.leverGates["compiler.active"] === true &&
		adaptedPolicy.receipt.activeLever === "tool_concurrency_ceiling"
			? adaptedPolicy.compiledPolicy.tools.maxConcurrentTools
			: undefined;
	const profileConcurrency = toolStrategy?.maxConcurrentTools;
	const maxConcurrentTools =
		typeof compiledConcurrencyCeiling === "number"
			? typeof profileConcurrency === "number"
				? Math.min(profileConcurrency, compiledConcurrencyCeiling)
				: compiledConcurrencyCeiling === 1
					? 1
					: undefined
			: profileConcurrency;
	const workflowToolOptimization: WorkflowToolOptimization = {
		processResult: processToolResult,
		toolAliases: Object.keys(toolAliases).length > 0 ? toolAliases : undefined,
		argumentAliases: Object.keys(argumentAliases).length > 0 ? argumentAliases : undefined,
		maxConcurrentTools,
		remainingToolCalls,
		remainingStageTimeMs,
		resourceConflictMode: resourceConflictMode ?? "serialize",
		transformTools,
		optimizationReceipts,
		presentationAllowedTools: effectiveTools ? [...effectiveTools] : undefined,
		presentationToolSchemas,
		presentationSkillBodies,
	};

	// Always install optimization on the session so bash/read/grep honor processResult
	// and customWireName on the real tool path (not only via PreparedWorkflowInvocation helpers).
	// Runner-facing context is exactly the assembled prompt measured by the receipt and ledger.
	const assembledContext = assembled.text || dynamicContext || "";
	session = {
		...session,
		workflowToolOptimization,
		workflowAttemptEvidence: {
			promptAssemblyReceipt: assembled.receipt,
			contextLedger,
		},
	};

	return {
		request,
		assignment: request.assignment,
		context: assembledContext,
		readonly: readonlyRole,
		isolation,
		isolationRequested,
		allowedTools: effectiveTools ? [...effectiveTools] : undefined,
		session,
		styleMarker,
		outputSchema: enhancedSchema,
		processToolResult,
		processToolResultDetailed,
		transformTools,
		promptAssemblyReceipt: assembled.receipt,
		contextLedger,
		assembledPromptText: assembledContext,
		presentationPolicy,
		optimizationReceipts,
		resolvedToolPolicyId,
		compiledPolicy: adaptedPolicy.compiledPolicy,
		compiledReceipt: adaptedPolicy.receipt,
	};
}
