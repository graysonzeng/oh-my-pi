import * as fs from "node:fs";
import * as path from "node:path";
import codeReviewerPrompt from "../prompts/workflow/code-reviewer.md" with { type: "text" };
import implementerPrompt from "../prompts/workflow/implementer.md" with { type: "text" };
import planReviewerPrompt from "../prompts/workflow/plan-reviewer.md" with { type: "text" };
import plannerPrompt from "../prompts/workflow/planner.md" with { type: "text" };
import repairPrompt from "../prompts/workflow/repair.md" with { type: "text" };
import type { ToolSession } from "../tools";
import type { WorkflowToolOptimization } from "../tools/workflow-session-fields";
import { WorkflowCancelledError, WorkflowPolicyError } from "./errors";
import type {
	ToolOptimizationReceiptV1,
	ToolOutputArtifactAdapter,
	WorkflowToolOptimizationResult,
} from "./optimization-receipt";
import {
	applyPresentationPolicy,
	resolveWorkflowPresentation,
	type WorkflowPresentationPolicy,
} from "./presentation-policy";
import { assemblePrompt, type PromptAssemblyReceiptV1 } from "./prompt-assembly";
import { applyPromptStrategy } from "./prompt-strategy";
import { enhanceSchemaForProfile, type ToolDescriptor, transformToolsForProfile } from "./schema-enhancer";
import { applyContextStrategyEviction } from "./tool-optimization";
import { processToolOutputDetailed } from "./tool-output-manager";
import { isReadonlyWorkflowRole, ToolPolicyFactory, wrapSessionForWorkflowRole } from "./tool-policy";
import type { ModelProfile, WorkflowAgentRequest, WorkflowIsolationControls } from "./types";

/** Sync artifact adapter for processResult (lossy tool output recovery). */
function createSessionArtifactAdapter(session: ToolSession): ToolOutputArtifactAdapter {
	return {
		saveRaw: (toolName: string, fullText: string): string | undefined => {
			try {
				const manager = session.getArtifactManager?.();
				if (manager) {
					const id = String(manager.allocateId());
					const safe = toolName.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64) || "tool";
					const filePath = path.join(manager.dir, `${id}.${safe}.log`);
					fs.mkdirSync(manager.dir, { recursive: true });
					fs.writeFileSync(filePath, fullText, "utf-8");
					return id;
				}
				const dir = session.getArtifactsDir?.();
				if (!dir) return undefined;
				const id = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
				const safe = toolName.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64) || "tool";
				const filePath = path.join(dir, `${id}.${safe}.log`);
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(filePath, fullText, "utf-8");
				return id;
			} catch {
				return undefined;
			}
		},
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
	/**
	 * Full assembled prompt text (stable prefix + dynamic suffix).
	 * Production runner must send this as the model-facing context body.
	 */
	assembledPromptText: string;
	/** Resolved presentation policy (default direct / disabled). */
	presentationPolicy: WorkflowPresentationPolicy;
	/** Shared receipt log also referenced from session.workflowToolOptimization. */
	optimizationReceipts: ToolOptimizationReceiptV1[];
}

/**
 * Shared workflow-owned preparation before provider-specific execution.
 * Rejects aborted requests and readonly isolation; injects prompts/policy/tools;
 * applies per-model prompt, schema, and tool strategies.
 */
export function prepareWorkflowInvocation(request: WorkflowAgentRequest): PreparedWorkflowInvocation {
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

	const injected = injectWorkflowPrompt(
		request.profile.promptTemplate,
		request.assignment,
		request.context,
		request.profile,
		request.role,
		enhancedSchema,
	);
	const maxBytes = request.profile.contextPolicy?.maxArtifactBytes ?? Number.POSITIVE_INFINITY;
	let context = injected.context;
	const outputPrefix = request.profile.outputStrategy?.outputPrefixPrompt?.trim();
	if (outputPrefix && context) {
		context = `${context.trim()}\n\n${outputPrefix}`;
	} else if (outputPrefix) {
		context = outputPrefix;
	}
	if (context && context.length > maxBytes) {
		context = `${context.slice(0, Math.max(0, maxBytes - 32))}\n/* truncated by contextPolicy */`;
	}

	// Optional repo-map / contextStrategy artifact cap is applied when contextStrategy is present
	// and context already includes a map (stages may inject via ContextBuilder).
	const strategyMax = request.profile.contextStrategy?.artifactInclusion?.maxArtifactBytes;
	if (strategyMax && context && context.length > strategyMax) {
		context = `${context.slice(0, Math.max(0, strategyMax - 32))}\n/* truncated by contextStrategy */`;
	}

	// CWL-style eviction under utilization pressure (production call site for evictContext).
	const evictionBudget =
		request.profile.contextStrategy?.artifactInclusion?.maxArtifactBytes ??
		request.profile.contextPolicy?.maxArtifactBytes ??
		maxBytes;
	context = applyContextStrategyEviction(context, request.profile.contextStrategy, evictionBudget);

	let session = wrapSessionForWorkflowRole(request.session, request.role);
	session = wrapSessionForWorkflowIsolation(session, isolationRequested);

	const policyFactory = new ToolPolicyFactory();
	const policy = policyFactory.getPolicyForRole(request.role);
	if (!policy.readonly) {
		session = {
			...session,
			workflowWritePolicy: {
				repoRoot: request.session.cwd,
				forbiddenPaths: [...policy.forbiddenPaths],
			},
			workflowCommandPolicy: { allowedCommands: [...policy.allowedCommands] },
		};
	}
	const allowedTools = policyFactory.allowedToolsForRole(request.role);
	const disabled = new Set(request.profile.disabledTools ?? []);
	let effectiveTools = allowedTools && disabled.size > 0 ? allowedTools.filter(t => !disabled.has(t)) : allowedTools;

	// Gated presentation policy (default: direct / disabled). Restricted children never
	// discover tools outside the role allowlist — presentation further narrows the surface.
	const presentationPolicy = resolveWorkflowPresentation(request.profile.presentationPolicy);
	if (effectiveTools) {
		const presented = applyPresentationPolicy({
			policy: presentationPolicy,
			allowedToolNames: effectiveTools,
			tools: effectiveTools.map(name => ({ name, summary: name })),
			role: request.role,
		});
		// Catalog mode still lists non-essential tools (with locators); hard filter only drops
		// tools outside the allowlist. Keep presented.toolOrder as the prepared allowlist.
		effectiveTools = presented.toolOrder;
	}

	const toolStrategy = request.profile.toolStrategy;
	// Shared mutable log — live bash/read/grep processResult appends here.
	const optimizationReceipts: ToolOptimizationReceiptV1[] = [];
	const artifactAdapter = createSessionArtifactAdapter(session);

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
		if (!presentationPolicy.enabled || presentationPolicy.mode !== "catalog") return aliased;
		const essential = new Set(presentationPolicy.essentialTools);
		const allow = effectiveTools ? new Set(effectiveTools) : null;
		return aliased
			.filter(t => !allow || allow.has(t.name))
			.map(t => {
				if (essential.has(t.name) || t.essential === true) return t;
				// Catalog: drop full schema; keep name + short description + locator.
				const { schema: _schema, ...rest } = t;
				return {
					...rest,
					description: t.description ?? t.name,
					schemaLocator: `xd://tools/${t.name}`,
				} as ToolDescriptor;
			});
	};

	const toolAliases = {
		...(request.profile.toolStrategy?.toolAliases ?? {}),
		...(request.profile.toolAliases ?? {}),
	};
	const argumentAliases = {
		...(request.profile.toolStrategy?.argumentAliases ?? {}),
		...(request.profile.argumentAliases ?? {}),
	};

	// Prompt assembly receipt on the real prepared path (stable prefix vs dynamic handoff).
	const rolePromptBody = WORKFLOW_PROMPTS[request.profile.promptTemplate]?.trim() ?? "";
	const toolPresentationText = (effectiveTools ?? ["*"]).join(",");
	const assembled = assemblePrompt({
		sections: [
			{
				id: "system_static",
				content: injected.styleMarker ? `style:${injected.styleMarker}` : "",
				stable: true,
			},
			{ id: "role_policy", content: rolePromptBody, stable: true },
			{ id: "tool_presentation", content: toolPresentationText, stable: true },
			{ id: "assignment", content: injected.assignment, stable: false },
			{ id: "handoff", content: context ?? "", stable: false },
		],
		// Provider cache counters not available at prepare time — never invent zeros.
		cacheObservable: false,
	});

	// remainingToolCalls is a hard agent-loop execution budget (skip after N calls).
	// Do NOT map contextStrategy.toolHistory.maxToolCalls here — that field only
	// tightens eviction keepRecentN via withToolHistoryEviction (default 5–15).
	// Hard budget stays null (unlimited) unless an explicit stage budget is added later.
	const remainingToolCalls: number | null = null;

	const workflowToolOptimization: WorkflowToolOptimization = {
		processResult: processToolResult,
		toolAliases: Object.keys(toolAliases).length > 0 ? toolAliases : undefined,
		argumentAliases: Object.keys(argumentAliases).length > 0 ? argumentAliases : undefined,
		maxConcurrentTools: toolStrategy?.maxConcurrentTools,
		remainingToolCalls,
		resourceConflictMode: "conservative",
		transformTools,
		optimizationReceipts,
	};

	// Always install optimization on the session so bash/read/grep honor processResult
	// and customWireName on the real tool path (not only via PreparedWorkflowInvocation helpers).
	// Runner-facing context is the assembled prompt (stable prefix + dynamic handoff),
	// then clamped by contextPolicy.maxArtifactBytes so pre-P2 budget contracts hold.
	let assembledContext = assembled.text || context || "";
	if (assembledContext.length > maxBytes) {
		assembledContext = `${assembledContext.slice(0, Math.max(0, maxBytes - 32))}\n/* truncated by contextPolicy */`;
	}
	if (strategyMax && assembledContext.length > strategyMax) {
		assembledContext = `${assembledContext.slice(0, Math.max(0, strategyMax - 32))}\n/* truncated by contextStrategy */`;
	}
	session = {
		...session,
		workflowToolOptimization,
		workflowAttemptEvidence: {
			promptAssemblyReceipt: assembled.receipt,
		},
	};

	return {
		request,
		assignment: injected.assignment,
		context: assembledContext,
		readonly: readonlyRole,
		isolation,
		isolationRequested,
		allowedTools: effectiveTools ? [...effectiveTools] : undefined,
		session,
		styleMarker: injected.styleMarker,
		outputSchema: enhancedSchema,
		processToolResult,
		processToolResultDetailed,
		transformTools,
		promptAssemblyReceipt: assembled.receipt,
		assembledPromptText: assembledContext,
		presentationPolicy,
		optimizationReceipts,
	};
}
