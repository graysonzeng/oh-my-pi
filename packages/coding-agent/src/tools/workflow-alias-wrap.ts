/**
 * Production wrapper for workflow per-model toolAliases / argumentAliases.
 *
 * createTools applies this so the embedded structured-subagent path exposes
 * model-facing parameter names (e.g. file_path) and reverse-maps execute args
 * to internal names (path). Kept out of workflow/tool-optimization so pure
 * workflow unit tests never load pi-ai/schema or pi_natives.
 */
import { type JsonSchemaObject, remapSchemaProperties, reverseArgumentAliases } from "../workflow/schema-enhancer";

/** Session slice used for alias wrap — avoids importing tools/index (cycle). */
export interface WorkflowAliasSession {
	workflowToolOptimization?: {
		toolAliases?: Record<string, string>;
		argumentAliases?: Record<string, Record<string, string>>;
	};
}

/**
 * Convert tool.parameters to a plain JSON Schema object for property remapping.
 * Supports plain JSON Schema and arktype (toJsonSchema). Does not import
 * toolWireSchema / pi-ai (keeps workflow test graph free of pi_natives).
 */
export function parametersToJsonSchema(parameters: unknown): JsonSchemaObject | undefined {
	// arktype schemas are callable functions (typeof === "function"), not plain objects.
	if (parameters == null) return undefined;
	if (typeof parameters !== "object" && typeof parameters !== "function") return undefined;

	const withToJson = parameters as { toJsonSchema?: (opts?: object) => unknown };
	if (typeof withToJson.toJsonSchema === "function") {
		try {
			// Call as method so arktype keeps `this` (destructure would lose it).
			const wire = withToJson.toJsonSchema({
				target: "draft-2020-12",
				fallback: (ctx: { base: unknown }) => ctx.base,
			});
			if (wire && typeof wire === "object") return wire as JsonSchemaObject;
		} catch {
			// fall through to plain-object check
		}
	}

	if (typeof parameters !== "object") return undefined;
	const rec = parameters as JsonSchemaObject;
	if (rec.type === "object" && rec.properties && typeof rec.properties === "object") {
		return structuredClone(rec);
	}

	return undefined;
}

/**
 * Remap tool.parameters property names for the model wire surface
 * (argumentAliases) and reverse-map execute args to internal names.
 * customWireName is set from toolAliases when the tool does not already expose one.
 *
 * Accepts AgentTool (and plain test doubles) via structural typing on name/parameters/execute.
 */
export function wrapAgentToolWithWorkflowAliases<T extends object>(tool: T, session: WorkflowAliasSession): T {
	const opt = session.workflowToolOptimization;
	if (!opt) return tool;

	const record = tool as {
		name: string;
		parameters: unknown;
		customWireName?: string;
		execute: (toolCallId: string, args: unknown, ...rest: unknown[]) => unknown;
	};
	if (typeof record.name !== "string" || typeof record.execute !== "function") return tool;

	const argAliases = opt.argumentAliases?.[record.name];
	const toolAlias = opt.toolAliases?.[record.name];
	if (!argAliases && !toolAlias) return tool;

	// Tool name only — many built-ins already implement customWireName via session.
	if (!argAliases) {
		const existing = record.customWireName;
		if (existing || !toolAlias) return tool;
		return new Proxy(tool, {
			get(target, prop, receiver) {
				if (prop === "customWireName") return toolAlias;
				return Reflect.get(target, prop, receiver);
			},
		}) as T;
	}

	const baseSchema = parametersToJsonSchema(record.parameters);
	const remappedParameters =
		baseSchema !== undefined ? (remapSchemaProperties(baseSchema, argAliases) ?? baseSchema) : record.parameters;
	const profileSlice = { argumentAliases: opt.argumentAliases };
	const toolName = record.name;
	const execute = record.execute;

	return new Proxy(tool, {
		get(target, prop, receiver) {
			if (prop === "parameters") return remappedParameters;
			if (prop === "customWireName") {
				const existing = Reflect.get(target, "customWireName", receiver);
				return existing ?? toolAlias;
			}
			if (prop === "execute") {
				return (toolCallId: string, args: unknown, ...rest: unknown[]) => {
					const raw =
						args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
					const internalArgs = reverseArgumentAliases(toolName, raw, profileSlice);
					return execute.call(target, toolCallId, internalArgs, ...rest);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as T;
}
