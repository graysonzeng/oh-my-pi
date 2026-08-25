import { ZodError } from "zod";
import { WorkflowSchemaError } from "./errors";

/**
 * Coerce model-supplied timestamps into Zod `.datetime()`-safe ISO-8601 UTC.
 * Live models often omit the `Z` suffix or return locale-ish strings; engine-owned
 * artifact headers must not fail closed on that.
 */
export function coerceIsoDatetime(value: unknown, fallback = new Date().toISOString()): string {
	if (typeof value === "string" && value.trim()) {
		const trimmed = value.trim();
		const ms = Date.parse(trimmed);
		if (!Number.isNaN(ms)) {
			return new Date(ms).toISOString();
		}
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value < 1e12 ? value * 1000 : value;
		const d = new Date(ms);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}
	return fallback;
}

/** Parse model output with Zod; normalize failures to schema_violation for retry/fallback. */
export function parseWorkflowArtifact<T>(schema: { parse(data: unknown): unknown }, data: unknown, label: string): T {
	try {
		return schema.parse(data) as T;
	} catch (error) {
		if (error instanceof ZodError) {
			const summary = error.issues
				.slice(0, 8)
				.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`)
				.join("; ");
			throw new WorkflowSchemaError(`${label} schema validation failed: ${summary}`, {
				issues: error.issues,
			});
		}
		throw error;
	}
}
