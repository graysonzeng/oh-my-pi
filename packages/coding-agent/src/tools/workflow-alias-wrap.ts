/**
 * Production wrapper for workflow per-model toolAliases / argumentAliases
 * and catalog transformTools (schema drop / schemaLocator).
 *
 * createTools applies this so the embedded structured-subagent path exposes
 * model-facing parameter names (e.g. file_path) and reverse-maps execute args
 * to internal names (path). Kept out of workflow/tool-optimization so pure
 * workflow unit tests never load pi-ai/schema or pi_natives.
 */
import {
	type JsonSchemaObject,
	remapSchemaProperties,
	reverseArgumentAliases,
	type ToolDescriptor,
} from "../workflow/schema-enhancer";

/** Session slice used for alias wrap — avoids importing tools/index (cycle). */
export interface WorkflowAliasSession {
	workflowToolOptimization?: {
		toolAliases?: Record<string, string>;
		argumentAliases?: Record<string, Record<string, string>>;
		/** Catalog / alias transform applied after tools are built. */
		transformTools?: (tools: ToolDescriptor[]) => ToolDescriptor[];
	};
}

/** Minimal empty object schema when catalog mode drops full parameters. */
const CATALOG_STUB_PARAMETERS: JsonSchemaObject = {
	type: "object",
	properties: {},
	additionalProperties: false,
	description: "Schema omitted (catalog mode). Use schemaLocator to load full schema.",
};

/**
 * Read a property from a tool through a Proxy trap.
 * Always use the real tool instance as Reflect's receiver so class private-field
 * getters (e.g. BashTool `#asyncEnabled`) keep a valid brand. Bind execute methods
 * to that same instance because calling an unbound method through the Proxy would
 * otherwise make the Proxy its `this` receiver and fail the private-field brand check.
 */
function getToolProp(target: object, prop: PropertyKey): unknown {
	const value = Reflect.get(target, prop, target);
	if (prop === "execute" && typeof value === "function") return value.bind(target);
	return value;
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
			get(target, prop) {
				if (prop === "customWireName") return toolAlias;
				return getToolProp(target, prop);
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
		get(target, prop) {
			if (prop === "parameters") return remappedParameters;
			if (prop === "customWireName") {
				const existing = getToolProp(target, "customWireName");
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
			return getToolProp(target, prop);
		},
	}) as T;
}

/**
 * Apply session.workflowToolOptimization.transformTools to real AgentTool objects.
 * - Drops tools not present in transform output (allowlist / presentation filter).
 * - Catalog non-essential: replace parameters with stub schema, surface schemaLocator
 *   on description/summary so the model-facing wire does not ship full JSON schema.
 */
export function applyWorkflowTransformTools<T extends object>(tools: T[], session: WorkflowAliasSession): T[] {
	const transform = session.workflowToolOptimization?.transformTools;
	if (!transform || tools.length === 0) return tools;

	const descriptors: ToolDescriptor[] = [];
	const toolByName = new Map<string, T>();
	for (const tool of tools) {
		const rec = tool as { name?: string; description?: string; parameters?: unknown };
		if (typeof rec.name !== "string") continue;
		toolByName.set(rec.name, tool);
		descriptors.push({
			name: rec.name,
			description: typeof rec.description === "string" ? rec.description : rec.name,
			schema: parametersToJsonSchema(rec.parameters) ?? { type: "object" },
		});
	}

	const transformed = transform(descriptors);
	const out: T[] = [];
	for (const d of transformed) {
		const base = toolByName.get(d.name);
		if (!base) continue;
		// Schema dropped by catalog presentation — stub parameters on the wire.
		if (d.schema === undefined) {
			const locator = typeof d.schemaLocator === "string" ? d.schemaLocator : `xd://tools/${d.name}`;
			const summary = typeof d.description === "string" ? d.description : d.name;
			const desc = `${summary} [schema: ${locator}]`;
			out.push(
				new Proxy(base, {
					get(target, prop) {
						if (prop === "parameters") return CATALOG_STUB_PARAMETERS;
						if (prop === "description") return desc;
						if (prop === "summary") return summary;
						if (prop === "schemaLocator") return locator;
						if (prop === "loadMode") return "discoverable";
						return getToolProp(target, prop);
					},
				}) as T,
			);
			continue;
		}
		// Schema kept — optionally surface customWireName from alias transform.
		if (d.customWireName) {
			out.push(
				new Proxy(base, {
					get(target, prop) {
						if (prop === "customWireName") {
							const existing = getToolProp(target, "customWireName");
							return existing ?? d.customWireName;
						}
						return getToolProp(target, prop);
					},
				}) as T,
			);
			continue;
		}
		out.push(base);
	}
	return out;
}
