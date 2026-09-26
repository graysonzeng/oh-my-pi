import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
export type { AgentProgress, SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
export type { SubagentRequestPhase, SubagentToolPhase } from "./review-performance";
export {
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
export type {
	SubagentProgressPayload,
	SubagentLifecyclePayload,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { type BaseType, type } from "@oh-my-pi/omptype";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { $env } from "@oh-my-pi/pi-utils";

import type { AgentSessionEvent } from "../session/agent-session";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { SubagentCompletionKind } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import type { ChildDeliveryEvidenceV1, ParentIntegrateDecision } from "./child-delivery-evidence";
import type { SubagentReviewMetrics } from "./review-performance";

export type { SubagentCompletionKind };

/** Live activity of a subagent, evidenced by real execution events observed by the run monitor. */
export type AgentActivityPhase = "working" | "model" | "thinking" | "responding" | "tool";

declare module "@oh-my-pi/pi-tui/tools/task" {
	interface TaskItem {
		/** Request a code-review shadow cohort (`code`) or force it off. */
		shadowReview?: "code" | "off";
	}
	interface TaskParams {
		/** Request a code-review shadow cohort (`code`) or force it off. */
		shadowReview?: "code" | "off";
	}
	interface AgentProgress {
		/** Originating parent `task` tool call id. */
		taskToolCallId?: string;
		activityPhase?: AgentActivityPhase;
		lastActivityAtMs?: number;
		reviewMetrics?: SubagentReviewMetrics;
	}
	interface SingleResult {
		/** Number of tool calls executed across the run when counted; omit when unknown. */
		toolCalls?: number;
		/**
		 * Terminal provenance. Successful 1.5× forced-yield is `budget_stop` even when
		 * `status`/`exitCode` still look completed. Timeout and grace budget abort
		 * outrank a still-true `budgetStopRequested`.
		 */
		completionKind?: SubagentCompletionKind;
		reviewMetrics?: SubagentReviewMetrics;
		/**
		 * Child→parent delivery evidence packet when extracted from structured
		 * yield / fence. Undefined when the child did not produce one.
		 */
		deliveryEvidence?: ChildDeliveryEvidenceV1;
		/**
		 * Parent integrate classifier decision for this child result. Set by
		 * `runStructuredSubagent` so workpool/task paths that only keep
		 * `execution.result` still receive the classification.
		 */
		parentIntegrateDecision?: ParentIntegrateDecision;
	}
}

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** Payload emitted on TASK_SUBAGENT_EVENT_CHANNEL */
export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

// Keep this explicit: ArkType serializes `unknown` as a boolean subschema, which llama.cpp grammars reject.
const outputSchemaInputSchema = type("object | boolean | string | null");
// Coarse per-spawn thinking effort; must stay in sync with TASK_EFFORTS in ../thinking.
const effortRule = '"lo" | "med" | "hi"' as const;

export const taskItemSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"shadowReview?": '"code" | "off"',
	"+": "delete",
});
const taskItemSchemaIsolated = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"isolated?": "boolean",
	"shadowReview?": '"code" | "off"',
	"+": "delete",
});

export const taskSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"isolated?": "boolean",
	"shadowReview?": '"code" | "off"',
	"+": "delete",
});
const taskSchemaNoIsolation = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"shadowReview?": '"code" | "off"',
	"+": "delete",
});
const taskSchemaBatch = type({
	context: "string",
	tasks: taskItemSchemaIsolated.array(),
	"+": "delete",
});
const taskSchemaBatchNoIsolation = type({
	context: "string",
	tasks: taskItemSchema.array(),
	"+": "delete",
});
const ALL_TASK_SCHEMAS = [taskSchema, taskSchemaNoIsolation, taskSchemaBatch, taskSchemaBatchNoIsolation] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskSchema = typeof taskSchema;
/** Active task tool parameter schema for the current isolation / batch flags */
export type TaskToolSchemaInstance = DynamicTaskSchema | BaseType;

const TASK_AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const taskSchemaCache = new Map<string, BaseType>();

function taskAgentSchemaRule(defaultAgent: string): string {
	const trimmed = defaultAgent.trim();
	if (TASK_AGENT_NAME_PATTERN.test(trimmed)) {
		return `string = '${trimmed}'`;
	}
	return "string";
}

function createTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	defaultAgent: string;
	effortEnabled: boolean;
	evalToolsEnabled: boolean;
}): BaseType {
	const agent = taskAgentSchemaRule(options.defaultAgent);
	const effortField = options.effortEnabled ? { "effort?": effortRule } : {};
	const toolsField = options.evalToolsEnabled ? { "tools?": "string[]" } : {};
	if (options.batchEnabled) {
		if (options.isolationEnabled) {
			const item = type.raw({
				"name?": "string",
				agent,
				task: "string",
				...effortField,
				"outputSchema?": outputSchemaInputSchema,
				"schemaMode?": '"permissive" | "strict"',
				...toolsField,
				"isolated?": "boolean",
				"shadowReview?": '"code" | "off"',
				"+": "delete",
			});
			return type.raw({
				context: "string",
				tasks: item.array(),
				"+": "delete",
			});
		}
		const item = type.raw({
			"name?": "string",
			agent,
			task: "string",
			...effortField,
			"outputSchema?": outputSchemaInputSchema,
			"schemaMode?": '"permissive" | "strict"',
			...toolsField,
			"shadowReview?": '"code" | "off"',
			"+": "delete",
		});
		return type.raw({
			context: "string",
			tasks: item.array(),
			"+": "delete",
		});
	}
	if (options.isolationEnabled) {
		return type.raw({
			"name?": "string",
			agent,
			task: "string",
			...effortField,
			"outputSchema?": outputSchemaInputSchema,
			"schemaMode?": '"permissive" | "strict"',
			...toolsField,
			"isolated?": "boolean",
			"shadowReview?": '"code" | "off"',
			"+": "delete",
		});
	}
	return type.raw({
		"name?": "string",
		agent,
		task: "string",
		...effortField,
		"outputSchema?": outputSchemaInputSchema,
		"schemaMode?": '"permissive" | "strict"',
		...toolsField,
		"shadowReview?": '"code" | "off"',
		"+": "delete",
	});
}

/** Build the task wire schema for the current settings and spawn policy. */
export function getTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	effortEnabled?: boolean;
	/** Advertise the `tools` field for eval-defined tools (`eval.tools.enabled`, default on). */
	evalToolsEnabled?: boolean;
	defaultAgent?: string;
}): TaskToolSchemaInstance {
	const defaultAgent = options.defaultAgent ?? "task";
	const effortEnabled = options.effortEnabled ?? false;
	const evalToolsEnabled = options.evalToolsEnabled ?? true;
	if (defaultAgent === "task" && !effortEnabled && evalToolsEnabled) {
		if (options.batchEnabled) return options.isolationEnabled ? taskSchemaBatch : taskSchemaBatchNoIsolation;
		return options.isolationEnabled ? taskSchema : taskSchemaNoIsolation;
	}
	const key = `${options.isolationEnabled ? "iso" : "flat"}:${options.batchEnabled ? "batch" : "single"}:${effortEnabled ? "effort" : "default"}:${evalToolsEnabled ? "tools" : "notools"}:${defaultAgent}`;
	const cached = taskSchemaCache.get(key);
	if (cached) return cached;
	const schema = createTaskSchema({ ...options, effortEnabled, evalToolsEnabled, defaultAgent });
	taskSchemaCache.set(key, schema);
	return schema;
}

/**
 * Whether an agent at `taskDepth` may still spawn children — i.e. it currently
 * holds the `task` tool. Mirrors the task-tool availability gate;
 * `maxRecursionDepth < 0` disables the cap entirely.
 */
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
	return maxRecursionDepth < 0 || taskDepth < maxRecursionDepth;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Maximum provider reasoning effort this agent may use, including caller overrides and fallback models. */
	maxEffort?: Effort;
	output?: unknown;
	blocking?: boolean;
	autoloadSkills?: string[];
	/** When `false`, the agent's `read` tool returns verbatim file content instead of structural summaries. */
	readSummarize?: boolean;
	/** When `false`, the spawned session does not apply model-family tool-output truncation. */
	outputTruncation?: boolean;
	/** Prewalk hand-off for the spawned session: `true` = switch to the default prewalk target at the first edit/write, string = custom target model pattern. */
	prewalk?: boolean | string;
	/** Opt-in code-review shadow cohort. Only `"code"` is recognized. */
	shadowReview?: "code";
	/** Advisor for spawned sessions of this agent: `true` = advise with the default advisor-role model, string = advise with that model pattern (optional `:level` suffix). Absent/`false` = no advisor. */
	advisor?: boolean | string;
	source: AgentSource;
	filePath?: string;
}
