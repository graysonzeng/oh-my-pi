import { ZodError, type ZodType } from "zod";
import { WorkflowSchemaError } from "./errors";

/** Parse model output with Zod; normalize failures to schema_violation for retry/fallback. */
export function parseWorkflowArtifact<T>(schema: ZodType<T>, data: unknown, label: string): T {
	try {
		return schema.parse(data);
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
