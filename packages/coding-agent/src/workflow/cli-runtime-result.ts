import type { Usage } from "@oh-my-pi/pi-ai";
import type { SingleResult } from "../task/types";
import { WorkflowError, WorkflowPolicyError, WorkflowSchemaError } from "./errors";
import { redactSecretsInText } from "./secret-redact";
import type { WorkflowAgentRequest, WorkflowErrorKind } from "./types";

export interface CliUsageLike {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	total_cost_usd?: number;
	// Alternate shapes emitted by some CLIs
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	costUsd?: number;
}

export interface CliFailureInput {
	exitCode?: number;
	status?: number;
	stderr?: string;
	stdout?: string;
	message?: string;
	kindHint?: WorkflowErrorKind;
}

export interface CliSingleResultInput {
	request: WorkflowAgentRequest;
	id: string;
	exitCode: number;
	output: string;
	stderr: string;
	durationMs: number;
	artifact?: unknown;
	usage?: Usage;
	resolvedModel?: string;
	toolCalls?: number;
	error?: string;
	aborted?: boolean;
	patchPath?: string;
	branchName?: string;
}

/** Normalize CLI-emitted token usage; never invent cost when absent. */
export function normalizeCliUsage(source: CliUsageLike | undefined): Usage | undefined {
	if (!source) return undefined;
	const input = Number(source.input_tokens ?? source.inputTokens ?? 0) || 0;
	const output = Number(source.output_tokens ?? source.outputTokens ?? 0) || 0;
	const cacheRead = Number(source.cache_read_input_tokens ?? source.cacheRead ?? 0) || 0;
	const cacheWrite = Number(source.cache_creation_input_tokens ?? source.cacheWrite ?? 0) || 0;
	const totalTokens = Number(source.totalTokens) || input + output + cacheRead + cacheWrite;
	const reportedCost = source.total_cost_usd ?? source.costUsd;
	const totalCost = typeof reportedCost === "number" && Number.isFinite(reportedCost) ? reportedCost : 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
	};
}

function classifyFromStatus(status: number | undefined): WorkflowErrorKind | undefined {
	if (status === undefined) return undefined;
	if (status === 401 || status === 403) return "authentication";
	if (status === 429) return "rate_limit";
	if (status === 402) return "quota";
	if (status === 502 || status === 503 || status === 529) return "provider_transient";
	if (status >= 500) return "provider_transient";
	if (status >= 400) return "provider_permanent";
	return undefined;
}

function classifyFromText(text: string): WorkflowErrorKind | undefined {
	const m = text.toLowerCase();
	if (/auth|unauthorized|login|credential|api.?key|forbidden/.test(m)) return "authentication";
	if (/quota|billing|insufficient.?quota|payment/.test(m)) return "quota";
	if (/rate.?limit|too many requests|429/.test(m)) return "rate_limit";
	if (/timeout|timed out|deadline/.test(m)) return "timeout";
	if (/overloaded|temporarily|retry|502|503|529/.test(m)) return "provider_transient";
	if (/schema|structured|invalid json|parse/.test(m)) return "schema_violation";
	if (/not found|enoent|missing executable|command not found/.test(m)) return "configuration";
	return undefined;
}

/** Prefer parsed status over stderr regex; always redact stderr in the message. */
export function classifyCliFailure(input: CliFailureInput): WorkflowError {
	const redactedStderr = redactSecretsInText((input.stderr ?? "").slice(0, 2000));
	const redactedStdout = redactSecretsInText((input.stdout ?? "").slice(0, 500));
	const baseMessage =
		input.message ?? (redactedStderr || redactedStdout || `CLI exited with code ${input.exitCode ?? 1}`);
	const safeMessage = redactSecretsInText(baseMessage);

	if (input.kindHint) {
		return new WorkflowError(safeMessage, input.kindHint, {
			exitCode: input.exitCode,
			status: input.status,
			stderr: redactedStderr,
		});
	}

	const fromStatus = classifyFromStatus(input.status);
	const fromText = classifyFromText(`${safeMessage}\n${redactedStderr}`);
	const kind = fromStatus ?? fromText ?? "provider_permanent";
	return new WorkflowError(safeMessage, kind, {
		exitCode: input.exitCode,
		status: input.status,
		stderr: redactedStderr,
	});
}

/** CLI profiles require one exact model id (no wildcards, no multi-candidate arrays). */
export function parseExactCliModel(modelPattern: string | string[]): string {
	if (Array.isArray(modelPattern)) {
		if (modelPattern.length !== 1) {
			throw new WorkflowPolicyError("cli_runtime_requires_exact_single_model", {
				modelPattern,
				hint: "CLI profiles use one exact model id; multi-candidate fallbacks belong to workflow profiles",
			});
		}
		return parseExactCliModel(modelPattern[0]!);
	}
	const model = modelPattern.trim();
	if (!model) {
		throw new WorkflowPolicyError("cli_runtime_model_empty", {});
	}
	if (model.includes("*") || model.includes("?")) {
		throw new WorkflowPolicyError("cli_runtime_rejects_wildcard_model", {
			model,
			hint: "CLI profiles require an exact model identifier",
		});
	}
	return model;
}

export function createCliSingleResult(input: CliSingleResultInput): SingleResult {
	const structuredOutput =
		input.artifact !== undefined && !input.error && !input.aborted && input.exitCode === 0
			? { status: "valid" as const, data: input.artifact, source: "caller" as const, mode: "strict" as const }
			: input.error
				? {
						status: "invalid" as const,
						error: input.error,
						source: "caller" as const,
						mode: "strict" as const,
					}
				: undefined;

	return {
		index: 0,
		id: input.id,
		agent: input.request.role,
		agentSource: "bundled",
		task: input.request.assignment,
		assignment: input.request.assignment,
		exitCode: input.exitCode,
		output: input.output,
		stderr: redactSecretsInText(input.stderr),
		truncated: false,
		structuredOutput,
		durationMs: input.durationMs,
		tokens: input.usage?.totalTokens ?? 0,
		requests: 1,
		toolCalls: input.toolCalls,
		usage: input.usage,
		resolvedModel: input.resolvedModel,
		error: input.error ? redactSecretsInText(input.error) : undefined,
		aborted: input.aborted,
		patchPath: input.patchPath,
		branchName: input.branchName,
	};
}

export function createCliFailureSingleResult(request: WorkflowAgentRequest, error: unknown): SingleResult {
	const message = error instanceof Error ? error.message : String(error);
	return createCliSingleResult({
		request,
		id: `cli-fail-${request.attemptId}`,
		exitCode: 1,
		output: "",
		stderr: message,
		durationMs: 0,
		error: message,
	});
}

/** Parse JSON artifact payload; throw schema_violation on invalid JSON. */
export function parseCliJsonArtifact(raw: string, label: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new WorkflowSchemaError(`${label} is empty`);
	}
	try {
		return JSON.parse(trimmed) as unknown;
	} catch (error) {
		throw new WorkflowSchemaError(`${label} is not valid JSON`, {
			cause: error,
			preview: redactSecretsInText(trimmed.slice(0, 200)),
		});
	}
}

/** Local revalidation against optional JSON Schema when a validator is available. */
export function assertCliArtifactShape(artifact: unknown, outputSchema: unknown | undefined): void {
	if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
		throw new WorkflowSchemaError("CLI structured output must be a JSON object");
	}
	if (outputSchema === undefined || outputSchema === null || outputSchema === true) return;
	// Lightweight required-field check when schema exposes required[]
	if (typeof outputSchema === "object" && !Array.isArray(outputSchema)) {
		const schema = outputSchema as { required?: unknown; type?: unknown };
		if (schema.type === "object" && Array.isArray(schema.required)) {
			const obj = artifact as Record<string, unknown>;
			for (const key of schema.required) {
				if (typeof key === "string" && !(key in obj)) {
					throw new WorkflowSchemaError(`CLI structured output missing required field: ${key}`, {
						field: key,
					});
				}
			}
		}
	}
}
