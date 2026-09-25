/**
 * Workflow-only settings ported off the deleted settings-schema module.
 * Declaration order is the settings-panel order within this domain;
 * `config/all-settings.ts` places the domain after session settings.
 */
import { register } from "./registry";
import { SERVICE_TIER_XAI_OPTIONS, SERVICE_TIER_XAI_VALUES } from "./service-tier";

const EMPTY_STRING_ARRAY: readonly string[] = [];
const EMPTY_BOOLEAN_RECORD: Readonly<Record<string, boolean>> = {};
const EMPTY_UNKNOWN_RECORD: Readonly<Record<string, unknown>> = {};
const DEFAULT_WORKFLOW_VERIFICATION_COMMANDS = ["git diff --check", "bun check"] as const;

/** Run advisors when the advisor model matches the active model. Default pauses them. */
export const cfgAdvisorAllowSameModel = register({
	id: "advisor.allowSameModel",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Allow Same Model",
		description:
			"Run advisors when the resolved advisor model is the same as the active model. Off pauses them (status: same model) until the models differ.",
		condition: "advisorEnabled",
	},
});

export const cfgConsultEnabled = register({
	id: "consult.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Consult",
		label: "Enable Consult Tool",
		description:
			"Let the main agent call a stronger model mid-turn for strategic guidance. Independent of the turn-by-turn advisor.",
	},
});

export const cfgConsultModel = register({
	id: "consult.model",
	type: "string",
	default: undefined,
	ui: {
		tab: "model",
		group: "Consult",
		label: "Consult Model",
		description:
			"Optional model pattern for consult. Empty uses modelRoles.advisor, then the slow chain. Never inherits the primary model.",
		condition: "consultEnabled",
	},
});

export const cfgConsultAllowSameModel = register({
	id: "consult.allowSameModel",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Consult",
		label: "Allow Same Model",
		description: "Allow consult when the resolved advisor model is the same as the primary model.",
		condition: "consultEnabled",
	},
});

export const cfgConsultMaxUsesPerTurn = register({
	id: "consult.maxUsesPerTurn",
	type: "number",
	default: 2,
	ui: {
		tab: "model",
		group: "Consult",
		label: "Max Consults Per Turn",
		description: "Successful plus failed consult executes in the current primary turn.",
		condition: "consultEnabled",
	},
});

export const cfgConsultMaxUsesPerSession = register({
	id: "consult.maxUsesPerSession",
	type: "number",
	default: 12,
	ui: {
		tab: "model",
		group: "Consult",
		label: "Max Consults Per Session",
		description: "Cumulative consult executes in this session.",
		condition: "consultEnabled",
	},
});

export const cfgConsultTimeoutMs = register({
	id: "consult.timeoutMs",
	type: "number",
	default: 300_000,
	ui: {
		tab: "model",
		group: "Consult",
		label: "Consult Timeout",
		description:
			"Wall-clock timeout for the entire consult oneshot, including first-token wait and answer generation, in milliseconds. Set to 0 to disable.",
		condition: "consultEnabled",
		options: [
			{ value: "0", label: "Disabled" },
			{ value: "60000", label: "1 minute" },
			{ value: "120000", label: "2 minutes" },
			{ value: "180000", label: "3 minutes" },
			{ value: "300000", label: "5 minutes" },
		],
	},
});

export const cfgConsultFirstEventTimeoutMs = register({
	id: "consult.firstEventTimeoutMs",
	type: "number",
	default: 60_000,
	ui: {
		tab: "model",
		group: "Consult",
		label: "Consult First-Event Timeout",
		description:
			"Timeout waiting for the first model event after consult starts, in milliseconds. Thinking or text counts. Set to 0 to disable.",
		condition: "consultEnabled",
		options: [
			{ value: "0", label: "Disabled" },
			{ value: "30000", label: "30 seconds" },
			{ value: "60000", label: "1 minute" },
			{ value: "120000", label: "2 minutes" },
		],
	},
});

export const cfgConsultMaxTokens = register({
	id: "consult.maxTokens",
	type: "number",
	default: 2048,
	ui: {
		tab: "model",
		group: "Consult",
		label: "Consult Max Output Tokens",
		description: "Hard output token budget passed to the consult oneshot.",
		condition: "consultEnabled",
	},
});

export const cfgConsultMaxFocusChars = register({
	id: "consult.maxFocusChars",
	type: "number",
	default: 2000,
	ui: {
		tab: "model",
		group: "Consult",
		label: "Consult Focus Limit",
		description: "Maximum characters for the optional focus argument.",
		condition: "consultEnabled",
	},
});

/** xAI / Grok service tier. Legacy unscoped `priority` does not fill this (no retroactive 2×). */
export const cfgTierXai = register({
	id: "tier.xai",
	type: "enum",
	values: SERVICE_TIER_XAI_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Service Tier — xAI",
		description:
			'Processing tier for Grok on xAI-capable hosts (`xai`, `xai-oauth`, gateway Grok, and `api.x.ai` OpenAI-compat relays). `priority` sends `service_tier: "priority"` (xAI Priority Processing). Ignored on OpenRouter for `fastModeActive` unless the host realizes priority.',
		options: SERVICE_TIER_XAI_OPTIONS,
	},
});

export const cfgCodeIntelEnabled = register({
	id: "codeIntel.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "Code Intel",
		label: "Code Intel",
		description: "Enable the code_intel tool for native project understanding without Cursor CCE",
	},
});

export const cfgCodeIntelSemantic = register({
	id: "codeIntel.semantic",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "Code Intel",
		label: "Semantic Index",
		description: "Use the local embedding worker for unverified similar-chunk candidates",
	},
});

export const cfgCodeIntelDepthDefault = register({
	id: "codeIntel.depthDefault",
	type: "enum",
	values: ["auto", "focused", "extended"] as const,
	default: "auto",
	ui: {
		tab: "files",
		group: "Code Intel",
		label: "Default Depth",
		description: "Used when the tool call omits depth. auto infers from relationship words",
		options: [
			{ value: "auto", label: "Auto" },
			{ value: "focused", label: "Focused" },
			{ value: "extended", label: "Extended" },
		],
	},
});

export const cfgCodeIntelMaxIndexFiles = register({
	id: "codeIntel.maxIndexFiles",
	type: "number",
	default: 20000,
	ui: {
		tab: "files",
		group: "Code Intel",
		label: "Max Index Files",
		description: "Upper bound on files scanned into the tags generation snapshot",
	},
});

export const cfgCodeIntelMaxEmbedFiles = register({
	id: "codeIntel.maxEmbedFiles",
	type: "number",
	default: 4000,
	ui: {
		tab: "files",
		group: "Code Intel",
		label: "Max Embed Files",
		description: "Upper bound on files written into the local embedding matrix",
	},
});

export const cfgCodeIntelTimeoutSec = register({
	id: "codeIntel.timeoutSec",
	type: "number",
	default: 30,
	ui: {
		tab: "files",
		group: "Code Intel",
		label: "Timeout (seconds)",
		description: "Per-query budget. Clamped to the code_intel tool range 5–180 seconds",
	},
});

export const cfgToolsPtcMode = register({
	id: "tools.ptc.mode",
	type: "enum",
	values: ["off", "on", "auto"] as const,
	default: "off",
	ui: {
		tab: "tools",
		group: "Execution",
		label: "Programmatic Tool Calling",
		description:
			"Collapse the direct tool surface into eval for any provider. The keep-set is eval, ask, todo, yield, think, checkpoint, rewind, and new_context; other enabled tools run from eval cells via tool.<name>(). 'auto' follows a model's code_mode_only catalog flag. Codex providers.openai-codex.codeMode remains the fallback when this switch is off.",
		options: [
			{
				value: "off",
				label: "Off",
				description: "Leave the full direct tool surface. Codex can still enable Code Mode via its own setting.",
			},
			{
				value: "on",
				label: "On",
				description: "Force programmatic tool calling whenever JS eval is available.",
			},
			{
				value: "auto",
				label: "Auto",
				description: "Enable only when the active model is flagged code_mode_only.",
			},
		],
	},
});

export const cfgToolsPtcDirectTools = register({
	id: "tools.ptc.directTools",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "tools",
		group: "Execution",
		label: "PTC Direct Tools",
		description:
			"Extra tool names to keep directly callable alongside the PTC keep-set. Entries that are not enabled in the session are ignored.",
	},
});

export const cfgGoalHostGateEnabled = register({
	id: "goal.hostGate.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Host Completion Gate",
		description:
			'When true, goal({op:"complete"}) only nominates. Deterministic host checks must pass, then the user confirms with /goal complete. False restores immediate tool completion.',
	},
});

export const cfgGoalHostGateTimeoutMs = register({
	id: "goal.hostGate.timeoutMs",
	type: "number",
	default: 15_000,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Evaluator Timeout",
		description: "Per-request timeout for the advisory goal evaluator, in milliseconds. Set to 0 to disable.",
		condition: "goalHostGateEnabled",
		options: [
			{ value: "0", label: "Disabled" },
			{ value: "15000", label: "15 seconds" },
			{ value: "30000", label: "30 seconds" },
		],
	},
});

export const cfgGoalHostGateMaxOutputTokens = register({
	id: "goal.hostGate.maxOutputTokens",
	type: "number",
	default: 512,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Evaluator Max Output Tokens",
		description: "Hard output token budget for the advisory goal evaluator.",
		condition: "goalHostGateEnabled",
	},
});

export const cfgGoalHostGateFalseCompletion = register({
	id: "goal.hostGate.falseCompletion",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal False-Completion Continuation",
		description:
			"When true, a completion claim without shipped verification or with open todos injects a hidden next-turn continuation. Independent of the advisory evaluator.",
		condition: "goalHostGateEnabled",
	},
});

export const cfgGoalGrokOverlayUnload = register({
	id: "goal.grokOverlayUnload",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Unload Grok Numbered Overlay",
		description:
			"When true, ordinary Grok sessions drop numbered/step-by-step overlay instructions. Independent of the goal host gate.",
	},
});

export const cfgWorkflowEnabled = register({
	id: "workflow.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Multi-Model Workflow",
		description: "Enable the multi-model coding workflow tool (start/status/resume/cancel)",
	},
});

export const cfgWorkflowStoragePath = register({
	id: "workflow.storagePath",
	type: "string",
	default: "",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Workflow Storage Path",
		description: "SQLite path for workflow state; empty uses the default workflow.db in cwd",
	},
});

export const cfgWorkflowDegradedMode = register({
	id: "workflow.degradedMode",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Workflow Degraded Mode",
		description: "Allow same-vendor code review when an independent reviewer is unavailable",
	},
});

export const cfgWorkflowRequireIndependentReview = register({
	id: "workflow.requireIndependentReview",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Require Independent Review",
		description: "Require code reviewer vendor to differ from implementer unless degraded mode is on",
	},
});

export const cfgWorkflowMaxBudgetUsd = register({
	id: "workflow.maxBudgetUsd",
	type: "number",
	default: 10,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Workflow Budget (USD)",
		description: "Hard stop when known provider-reported cost reaches this limit",
	},
});

export const cfgWorkflowMaxRepairCycles = register({
	id: "workflow.maxRepairCycles",
	type: "number",
	default: 3,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Max Repair Cycles",
		description: "Bounded repair attempts before the workflow blocks",
	},
});

export const cfgWorkflowConfidenceThreshold = register({
	id: "workflow.confidenceThreshold",
	type: "number",
	default: 0.6,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Review Confidence Threshold",
		description: "Findings below this confidence are advisory for blocking decisions",
	},
});

export const cfgWorkflowIsolationMerge = register({
	id: "workflow.isolationMerge",
	type: "enum",
	values: ["patch", "branch"] as const,
	default: "patch",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Workflow Isolation Merge",
		description: "How implement/repair isolation merges results back",
	},
});

export const cfgWorkflowVerificationCommands = register({
	id: "workflow.verificationCommands",
	type: "array",
	default: DEFAULT_WORKFLOW_VERIFICATION_COMMANDS,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Workflow Verification Commands",
		description:
			"Trusted deterministic checks after implementation (prefer repo checks + focused tests; full suite is opt-in)",
	},
});

export const cfgWorkflowVerificationTimeoutMs = register({
	id: "workflow.verificationTimeoutMs",
	type: "number",
	default: 120_000,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Workflow Verification Timeout (ms)",
		description: "Hard timeout per verification command before the workflow fails the check",
	},
});

export const cfgWorkflowMaxPlanCycles = register({
	id: "workflow.maxPlanCycles",
	type: "number",
	default: 2,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Max Plan Cycles",
		description: "Bounded plan rejection / replan loops before the workflow blocks",
	},
});

export const cfgWorkflowDefaultQualityTier = register({
	id: "workflow.defaultQualityTier",
	type: "enum",
	values: ["balanced", "critical"] as const,
	default: "balanced",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Default Workflow Quality Tier",
		description: "Default quality route selected by workflow.start when quality routes are configured",
	},
});

export const cfgWorkflowQualityRoutes = register({
	id: "workflow.qualityRoutes",
	type: "record",
	default: EMPTY_UNKNOWN_RECORD,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Workflow Quality Routes",
		description: "Ordered model profile ids per workflow role for balanced and critical routes",
	},
});

export const cfgWorkflowProfiles = register({
	id: "workflow.profiles",
	type: "record",
	default: EMPTY_UNKNOWN_RECORD,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Workflow Model Profiles",
		description:
			"Optional model profile map overriding workflow defaults (empty uses built-in planner/reviewer/implementer/repair profiles). Multi-model workflows use the embedded RuntimeAdapter with omp provider models and per-profile strategies; profile.runtime / vendor CLI backends are not supported.",
	},
});

export const cfgWorkflowPresentationOptimizationEnabled = register({
	id: "workflow.presentationOptimization.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Lazy Tool/Skill Presentation",
		description:
			"When enabled, workflow sessions may use catalog-mode tool/skill presentation (short descriptions + xd:// one-hop schema/body load). Default off; enable only after benchmark quality holds.",
	},
});

export const cfgModelOptimizationEnabled = register({
	id: "modelOptimization.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Model",
		label: "Model Optimization",
		description:
			"When enabled, ordinary coding sessions apply model-family prompt/tool/context optimization for the active model. Default on with the wired quality stop (cohort + fired-arm attribution + session-end rollback); behavior-changing profile thresholds stay off until their paired matrix passes. Workflow profiles are unaffected.",
	},
});

export const cfgModelOptimizationProfiles = register({
	id: "modelOptimization.profiles",
	type: "record",
	default: EMPTY_UNKNOWN_RECORD,
	ui: {
		tab: "model",
		group: "Model",
		label: "Model Optimization Profiles",
		description:
			"Optional map of model optimization profiles by id (empty uses built-in claude/gpt-5/grok/glm/luna/terra/sol family profiles). Same id overrides a built-in. Does not accept workflow role profiles.",
	},
});

export const cfgModelOptimizationOutputTruncationEnabled = register({
	id: "modelOptimization.outputTruncation.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Model",
		label: "Tool Output Truncation",
		description:
			"When enabled, ordinary sessions apply model-family tool-output byte/line clamps. Subagents may disable this with frontmatter `output-truncation: false` without changing the family profile.",
	},
});

export const cfgLatencyArmsReadDedupe = register({
	id: "latency.arms.readDedupe",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "Reading",
		label: "Read Result Dedupe",
		description:
			"When enabled with model optimization, repeated same-view read results may be replaced with verified artifact refs in model-visible context. Fail-open on unknown identity. Default on with the wired quality stop; reverts automatically on an attributed quality regression.",
	},
});

export const cfgLatencyArmsContextBudgetTuning = register({
	id: "latency.arms.contextBudgetTuning",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Context Budget Tuning",
		description:
			"Optional profile threshold tuning after ordinary context optimization is active. Default off until long-session paired quality passes.",
	},
});

export const cfgLatencyArmsRoleStaticSplit = register({
	id: "latency.arms.roleStaticSplit",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Workflow Mechanical Flash Route",
		description:
			"When enabled, caller-declared or previously-accepted mechanical workflow work may route to Flash via the frozen quality-route snapshot. Never downgrades plan reviewer. Default off until false-positive and repair-quality paired tests pass.",
	},
});

export const cfgLatencyArmsBashAdvisory = register({
	id: "latency.arms.bashAdvisory",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash Failure Advisory",
		description:
			"When enabled, repeated identical bash failures show a structured advisory from the single attempt ledger. Does not block execution. Low-risk; remains on by default (2026-08-07 gate).",
	},
});

export const cfgLatencyArmsBashBoundedInjection = register({
	id: "latency.arms.bashBoundedInjection",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash Ledger Context Injection",
		description:
			"When enabled, inject a bounded bash attempt-ledger summary into model context on repeated failures. Shares the advisory ledger; does not auto-skip. Low-risk; remains on by default (2026-08-07 gate).",
	},
});

export const cfgLatencyArmsConcurrencyDeclaration = register({
	id: "latency.arms.concurrencyDeclaration",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Concurrency Declaration",
		description:
			"When enabled, accept strict WorkflowConcurrencyDeclarationV1 for DAG/ownership validation. Default off until compatibility/live DAG coverage passes.",
	},
});

export const cfgLatencyArmsConcurrencyExecution = register({
	id: "latency.arms.concurrencyExecution",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Concurrency Declaration Execution",
		description:
			"When enabled, lower validated concurrency declarations onto existing task batch/parallel or workflow RuntimePort. Requires declaration arm. Default off until independent/dependent/cancel-resume quality pairs pass.",
	},
});

export const cfgLatencyArmsEvalGateMigration = register({
	id: "latency.arms.evalGateMigration",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Eval Gate Native Migration",
		description:
			"When enabled and EvalGateParityReceiptV1 is proven, migrate eligible eval gates to native workflow/task owners with optional independent overlap. Default off until a real native cutover plus parity/cancel-resume live proof exists (bridge control is always retained).",
	},
});

export const cfgLatencyArmsProviderHealthBreaker = register({
	id: "latency.arms.providerHealthBreaker",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Provider Health Breaker",
		description:
			"When enabled, skip physical availability probes for workflow profiles that recently failed twice with retryable provider errors (rate_limit, timeout, provider_transient) and treat them as unavailable for 60 seconds. Fail-open when off. Default off until the paired quality matrix passes.",
	},
});

export const cfgLatencyArmsAdaptiveThinkingContext = register({
	id: "latency.arms.adaptiveThinkingContext",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Adaptive Auto-Thinking Context",
		description:
			"When enabled, the existing auto-thinking classifier call receives a bounded trusted envelope (agent role, error count among the 8 most recent tool results, observable context usage percent). No extra model call. Ordinary sessions never invent a deadline. Default off until the paired quality matrix passes.",
	},
});

export const cfgLatencyArmsDshSessionSearch = register({
	id: "latency.arms.dshSessionSearch",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Session Search (DSH A1)",
		description:
			"When true, register session_search so the model can retrieve compacted raw assistant/tool journal on the current branch. Independently rollbackable. Default off until the DSH quality matrix passes. Control is explicit false; never inferred from a missing key.",
	},
});

export const cfgLatencyArmsDshOmitGoalTime = register({
	id: "latency.arms.dshOmitGoalTime",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Omit Goal Time (DSH A2)",
		description:
			"When true, active goal prompts omit timeUsedSeconds so the clock does not force re-injection every turn. EXP-A23 treatment requires this and dshGoalHashShadow both true (dim.a23). Assignment, not this toggle alone, decides treatment vs control. Default off.",
	},
});

export const cfgLatencyArmsDshGoalHashShadow = register({
	id: "latency.arms.dshGoalHashShadow",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Hash Shadow (DSH A3)",
		description:
			"When true, persist versioned adjacent-comparison shadow entries for the canonical final goal-mode string. Usage (tokens/time) does not reset the hash. Default off. EXP-A23 treatment requires this and dshOmitGoalTime both true.",
	},
});

export const cfgLatencyArmsDshHeadlessContinuation = register({
	id: "latency.arms.dshHeadlessContinuation",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Headless Goal Continuation (DSH A4)",
		description:
			'When true, the session may request headless goal continuation. Actual injection also requires goal.continuationModes to include "headless" (array resolver, not a boolean) and the runner capability allowHeadlessGoalContinuation. Independently rollbackable. Default off.',
	},
});

export const cfgTaskProactiveAutoParallel = register({
	id: "task.proactive.autoParallel",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Proactive Auto-Parallel",
		description: "Recommend batching at least 2 independent runnable slices when proactive delegation is enabled",
	},
});

export const cfgTaskProactivePipelineGuidance = register({
	id: "task.proactive.pipelineGuidance",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Proactive Pipeline Guidance",
		description: "Recommend escalating gated delivery to workflow when proactive delegation is enabled",
	},
});

export const cfgTaskProactiveStageRouting = register({
	id: "task.proactive.stageRouting",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Proactive Stage Routing",
		description: "Recommend routing scoped slices through existing task, scout, and reviewer agents",
	},
});

/** Shadow review cohort. Default off so first-yield completion is not blocked. */
export const cfgTaskShadowReviewEnabled = register({
	id: "task.shadowReview.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Reviewer Shadow Review",
		description:
			"When enabled, a qualified code-reviewer spawn runs four read-only Shadow Mind dimensions in parallel and injects their report as an async-result. Default off so first-yield completion is not blocked by the cohort. Quality A/B is not yet complete.",
	},
});

export const cfgTaskShadowReviewAgents = register({
	id: "task.shadowReview.agents",
	type: "record",
	default: EMPTY_BOOLEAN_RECORD,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Shadow Review Per Agent",
		description:
			"Per-agent kill switch for shadow review. Set an agent name to false to skip the cohort even when spawn requests shadowReview: code.",
	},
});

export const cfgTaskQueuedStartupTimeoutMs = register({
	id: "task.queuedStartupTimeoutMs",
	type: "number",
	default: 120_000,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Queued Startup Timeout",
		description:
			"How long a spawn may wait for a task.maxConcurrency permit before failing (ms). 0 disables the guard. Default 2 minutes is a proposed acceptance target; useful when stuck jobs saturate the semaphore.",
		options: [
			{ value: "0", label: "Unlimited" },
			{ value: "30000", label: "30 seconds" },
			{ value: "60000", label: "1 minute" },
			{ value: "120000", label: "2 minutes", description: "Default" },
			{ value: "300000", label: "5 minutes" },
		],
	},
});
