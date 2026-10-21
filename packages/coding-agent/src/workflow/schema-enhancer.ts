import type { ModelProfile, OutputStrategy } from "./types";

/** Minimal JSON-schema object shape we enhance (not full draft validation). */
export interface JsonSchemaObject {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchemaObject>;
	items?: JsonSchemaObject;
	required?: string[];
	enum?: unknown[];
	examples?: unknown[];
	additionalProperties?: boolean;
	strict?: boolean;
	[key: string]: unknown;
}

export interface ToolDescriptor {
	name: string;
	description?: string;
	/** Wire name exposed to the model (provider custom tool name). */
	customWireName?: string;
	schema?: JsonSchemaObject;
	[key: string]: unknown;
}

/**
 * Enhance a JSON schema for models that need richer descriptions / examples / strict mode.
 */
export function enhanceSchemaForProfile(
	schema: unknown,
	profile: Pick<ModelProfile, "outputStrategy"> | OutputStrategy | undefined,
): unknown {
	const strategy =
		profile && "outputStrategy" in profile ? profile.outputStrategy : (profile as OutputStrategy | undefined);
	const enhancement = strategy?.schemaEnhancement;
	if (!enhancement || !schema || typeof schema !== "object") return schema;

	let enhanced = structuredClone(schema) as JsonSchemaObject;

	if (enhancement.addDescriptions) {
		enhanced = addDetailedDescriptions(enhanced);
	}
	if (enhancement.addExamples) {
		enhanced = addInlineExamples(enhanced);
	}
	if (enhancement.strictMode) {
		enhanced = {
			...enhanced,
			additionalProperties: false,
			strict: true,
		};
	}

	return enhanced;
}

function addDetailedDescriptions(schema: JsonSchemaObject): JsonSchemaObject {
	if (schema.type === "object" && schema.properties) {
		const properties: Record<string, JsonSchemaObject> = {};
		for (const [key, prop] of Object.entries(schema.properties)) {
			const base = { ...prop };
			if (!base.description) {
				base.description = generateDescription(key, base);
			}
			properties[key] = base.type === "object" ? addDetailedDescriptions(base) : base;
		}
		return { ...schema, properties };
	}
	return schema;
}

function generateDescription(key: string, prop: JsonSchemaObject): string {
	const typeDesc = Array.isArray(prop.type) ? prop.type.join(" or ") : (prop.type ?? "value");
	return `The ${key} field (${typeDesc})`;
}

function addInlineExamples(schema: JsonSchemaObject): JsonSchemaObject {
	if (schema.type === "object" && schema.properties) {
		const examples: Record<string, unknown> = {};
		for (const [key, prop] of Object.entries(schema.properties)) {
			examples[key] = generateExample(prop);
		}
		return { ...schema, examples: [examples] };
	}
	return schema;
}

function generateExample(prop: JsonSchemaObject): unknown {
	if (prop.enum?.length) return prop.enum[0];
	const t = Array.isArray(prop.type) ? prop.type[0] : prop.type;
	switch (t) {
		case "string":
			return "example";
		case "number":
			return 42;
		case "integer":
			return 1;
		case "boolean":
			return true;
		case "array":
			return [generateExample(prop.items ?? {})];
		case "object":
			return {};
		default:
			return null;
	}
}

/**
 * Remap object-schema property names using aliases (internal → wire).
 * Also remaps `required` entries when present.
 */
export function remapSchemaProperties(
	schema: JsonSchemaObject | undefined,
	aliases: Record<string, string>,
): JsonSchemaObject | undefined {
	if (schema?.type !== "object" || !schema.properties) return schema;

	const remapped: Record<string, JsonSchemaObject> = {};
	for (const [oldKey, prop] of Object.entries(schema.properties)) {
		const newKey = aliases[oldKey] ?? oldKey;
		remapped[newKey] = prop;
	}

	const required = schema.required?.map(key => aliases[key] ?? key);

	return {
		...schema,
		properties: remapped,
		...(required ? { required } : {}),
	};
}

/**
 * Apply profile toolAliases / argumentAliases onto tool descriptors for the model wire surface.
 * Internal tool name stays as `name`; `customWireName` carries the alias when set.
 */
export function transformToolsForProfile(
	tools: ToolDescriptor[],
	profile: Pick<ModelProfile, "toolAliases" | "argumentAliases" | "toolStrategy">,
): ToolDescriptor[] {
	const toolAliases = {
		...(profile.toolStrategy?.toolAliases ?? {}),
		...(profile.toolAliases ?? {}),
	};
	const argumentAliases = {
		...(profile.toolStrategy?.argumentAliases ?? {}),
		...(profile.argumentAliases ?? {}),
	};

	return tools.map(tool => {
		const alias = toolAliases[tool.name];
		const argAliases = argumentAliases[tool.name];
		const schema = argAliases ? remapSchemaProperties(tool.schema, argAliases) : tool.schema;
		return {
			...tool,
			customWireName: alias ?? tool.customWireName,
			schema,
		};
	});
}

/**
 * Map wire argument keys back to internal names after model tool call.
 */
export function reverseArgumentAliases(
	toolName: string,
	args: Record<string, unknown>,
	profile: Pick<ModelProfile, "argumentAliases" | "toolStrategy">,
): Record<string, unknown> {
	const aliases = profile.argumentAliases?.[toolName] ?? profile.toolStrategy?.argumentAliases?.[toolName];
	if (!aliases) return args;

	const reverse = new Map<string, string>();
	for (const [internal, wire] of Object.entries(aliases)) {
		reverse.set(wire, internal);
	}

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		out[reverse.get(key) ?? key] = value;
	}
	return out;
}
