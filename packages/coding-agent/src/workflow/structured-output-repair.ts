/**
 * Layered structured-output repair: deterministic extract → validate → optional model retry.
 * Does not invent missing fields, guess enums, or coerce types loosely.
 */

import schemaRetryTemplate from "../prompts/workflow/schema-retry.hbs.md" with { type: "text" };
import { sha256Hex } from "./optimization-receipt";

export const SCHEMA_REPAIR_RECEIPT_KIND = "schema_repair_receipt" as const;
export const SCHEMA_REPAIR_RECEIPT_VERSION = 1 as const;

export interface SchemaRepairAttempt {
	attemptIndex: number;
	/** deterministic_extract | model_retry | validate */
	phase: "deterministic_extract" | "model_retry" | "validate";
	inputSha256: string;
	outputSha256?: string;
	ok: boolean;
	error?: string;
}

export interface SchemaRepairReceiptV1 {
	schemaVersion: typeof SCHEMA_REPAIR_RECEIPT_VERSION;
	kind: typeof SCHEMA_REPAIR_RECEIPT_KIND;
	attempts: SchemaRepairAttempt[];
	/** Total model calls made (0 when only deterministic). */
	modelCalls: number;
	/** maxRetries from config (additional model calls after first). */
	maxRetries: number;
	repaired: boolean;
}

export interface StructuredRepairBudget {
	/** Remaining request budget (model calls). When ≤0, no model retry. */
	remainingModelCalls?: number;
	/** Remaining cost USD; null/undefined = unknown (do not block). */
	remainingCostUsd?: number | null;
	/** Remaining time ms; null/undefined = unknown. */
	remainingTimeMs?: number | null;
}

export type SchemaValidator = (value: unknown, schema: unknown) => { ok: true } | { ok: false; error: string };

export interface StructuredRepairOptions {
	/** Additional model calls after the initial attempt. Total max = 1 + maxRetries. */
	maxRetries: number;
	schema: unknown;
	validate: SchemaValidator;
	/** Optional model re-invoke; receives retry prompt context. */
	retryWithModel?: (prompt: string) => Promise<string>;
	budget?: StructuredRepairBudget;
	/** Bound previous output fragment size injected into retry prompt. */
	maxFragmentChars?: number;
}

export interface StructuredRepairResult {
	ok: boolean;
	value?: unknown;
	error?: string;
	receipt: SchemaRepairReceiptV1;
	/** Final raw text after last attempt. */
	raw: string;
}

/** Strip UTF-8 BOM if present. */
function stripUtf8Bom(text: string): string {
	if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
	return text;
}

/**
 * Extract a single JSON object/array from model text:
 * BOM strip → markdown fence unwrap → first complete JSON value.
 * Returns null when no valid JSON found (no field invention).
 */
export function extractJsonValue(raw: string): { text: string; value: unknown } | null {
	let text = stripUtf8Bom(raw).trim();
	// Fenced block: ```json ... ``` or ``` ... ```
	const fence = text.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
	if (fence) {
		text = fence[1]!.trim();
	} else {
		// Leading prose + fenced body
		const innerFence = text.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n```/);
		if (innerFence) {
			text = innerFence[1]!.trim();
		}
	}

	// Direct parse
	try {
		return { text, value: JSON.parse(text) as unknown };
	} catch {
		// fall through
	}

	// Find first { or [ and parse balanced slice
	const startObj = text.indexOf("{");
	const startArr = text.indexOf("[");
	let start = -1;
	if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
	else start = Math.max(startObj, startArr);
	if (start < 0) return null;

	const slice = text.slice(start);
	const extracted = extractBalancedJson(slice);
	if (!extracted) return null;
	try {
		return { text: extracted, value: JSON.parse(extracted) as unknown };
	} catch {
		return null;
	}
}

function extractBalancedJson(text: string): string | null {
	const openCh = text[0];
	if (openCh !== "{" && openCh !== "[") return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return text.slice(0, i + 1);
		}
	}
	return null;
}

/** Minimal required-field + type=object validator used when no external AJV is wired. */
export function defaultSchemaValidator(value: unknown, schema: unknown): { ok: true } | { ok: false; error: string } {
	if (schema === undefined || schema === null || schema === true) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) return { ok: true };
		return { ok: false, error: "expected JSON object" };
	}
	if (typeof schema !== "object" || Array.isArray(schema)) return { ok: true };
	const s = schema as { type?: unknown; required?: unknown; properties?: unknown };
	if (s.type === "object") {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, error: "expected JSON object" };
		}
		if (Array.isArray(s.required)) {
			const obj = value as Record<string, unknown>;
			for (const key of s.required) {
				if (typeof key === "string" && !(key in obj)) {
					return { ok: false, error: `missing required field: ${key}` };
				}
			}
		}
	}
	return { ok: true };
}

/** Render static schema-retry template (Handlebars-lite: {{var}} only). */
export function renderSchemaRetryPrompt(vars: {
	violations: string;
	schemaSummary: string;
	previousOutput: string;
}): string {
	return schemaRetryTemplate
		.replace(/\{\{violations\}\}/g, vars.violations)
		.replace(/\{\{schemaSummary\}\}/g, vars.schemaSummary)
		.replace(/\{\{previousOutput\}\}/g, vars.previousOutput);
}

function schemaSummary(schema: unknown): string {
	try {
		const s = JSON.stringify(schema);
		return s.length > 800 ? `${s.slice(0, 800)}…` : s;
	} catch {
		return String(schema);
	}
}

function budgetAllowsRetry(budget: StructuredRepairBudget | undefined): boolean {
	if (!budget) return true;
	if (typeof budget.remainingModelCalls === "number" && budget.remainingModelCalls <= 0) return false;
	if (typeof budget.remainingCostUsd === "number" && budget.remainingCostUsd <= 0) return false;
	if (typeof budget.remainingTimeMs === "number" && budget.remainingTimeMs <= 0) return false;
	return true;
}

/**
 * Repair structured output.
 * maxRetries = additional model calls after the initial raw (total attempts with model ≤ 1 + maxRetries
 * when retryWithModel is used for retries only; the initial raw is treated as attempt 0 without a model call here).
 *
 * Callers that already spent the first model call should pass that raw here and set maxRetries
 * to the remaining additional budget.
 */
export async function repairStructuredOutput(
	raw: string,
	options: StructuredRepairOptions,
): Promise<StructuredRepairResult> {
	const attempts: SchemaRepairAttempt[] = [];
	const maxRetries = Math.max(0, options.maxRetries);
	const maxFragment = options.maxFragmentChars ?? 2000;
	let modelCalls = 0;
	let currentRaw = raw;

	const tryExtractAndValidate = (
		phase: SchemaRepairAttempt["phase"],
		attemptIndex: number,
	): StructuredRepairResult | null => {
		const inputSha = sha256Hex(currentRaw);
		const extracted = extractJsonValue(currentRaw);
		if (!extracted) {
			attempts.push({
				attemptIndex,
				phase,
				inputSha256: inputSha,
				ok: false,
				error: "no JSON value extracted",
			});
			return null;
		}
		const validation = options.validate(extracted.value, options.schema);
		attempts.push({
			attemptIndex,
			phase: "validate",
			inputSha256: inputSha,
			outputSha256: sha256Hex(extracted.text),
			ok: validation.ok,
			error: validation.ok ? undefined : validation.error,
		});
		if (validation.ok) {
			return {
				ok: true,
				value: extracted.value,
				receipt: {
					schemaVersion: SCHEMA_REPAIR_RECEIPT_VERSION,
					kind: SCHEMA_REPAIR_RECEIPT_KIND,
					attempts,
					modelCalls,
					maxRetries,
					repaired: attemptIndex > 0 || phase === "deterministic_extract",
				},
				raw: currentRaw,
			};
		}
		return null;
	};

	// Attempt 0: deterministic extract + validate (zero model calls).
	const first = tryExtractAndValidate("deterministic_extract", 0);
	if (first?.ok) {
		// repaired=false when raw was already valid JSON without transform noise — still ok.
		const extracted = extractJsonValue(raw);
		const trivial = extracted && extracted.text === stripUtf8Bom(raw).trim();
		first.receipt.repaired = !trivial;
		return first;
	}

	let lastError = attempts[attempts.length - 1]?.error ?? "schema validation failed";

	for (let retry = 1; retry <= maxRetries; retry++) {
		if (!options.retryWithModel) break;
		if (!budgetAllowsRetry(options.budget)) {
			attempts.push({
				attemptIndex: retry,
				phase: "model_retry",
				inputSha256: sha256Hex(currentRaw),
				ok: false,
				error: "budget exhausted before retry",
			});
			break;
		}
		// Check remaining model-call budget before the call.
		const remaining = options.budget?.remainingModelCalls;
		if (typeof remaining === "number" && remaining <= 0) break;

		const fragment =
			currentRaw.length > maxFragment
				? `${currentRaw.slice(0, maxFragment)}\n/* truncated for retry prompt */`
				: currentRaw;
		const prompt = renderSchemaRetryPrompt({
			violations: lastError,
			schemaSummary: schemaSummary(options.schema),
			previousOutput: fragment,
		});
		try {
			currentRaw = await options.retryWithModel(prompt);
			modelCalls++;
			if (options.budget && typeof options.budget.remainingModelCalls === "number") {
				options.budget.remainingModelCalls -= 1;
			}
			attempts.push({
				attemptIndex: retry,
				phase: "model_retry",
				inputSha256: sha256Hex(currentRaw),
				ok: true,
			});
		} catch (err) {
			attempts.push({
				attemptIndex: retry,
				phase: "model_retry",
				inputSha256: sha256Hex(currentRaw),
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
			break;
		}

		const repaired = tryExtractAndValidate("deterministic_extract", retry);
		if (repaired?.ok) {
			repaired.receipt.repaired = true;
			repaired.receipt.modelCalls = modelCalls;
			return repaired;
		}
		lastError = attempts[attempts.length - 1]?.error ?? lastError;
	}

	return {
		ok: false,
		error: lastError,
		receipt: {
			schemaVersion: SCHEMA_REPAIR_RECEIPT_VERSION,
			kind: SCHEMA_REPAIR_RECEIPT_KIND,
			attempts,
			modelCalls,
			maxRetries,
			repaired: false,
		},
		raw: currentRaw,
	};
}

/**
 * Total model call budget for schema path: first call + maxRetries additional.
 * Use when scheduling the initial model invocation + retries.
 */
export function totalSchemaModelAttempts(maxRetries: number): number {
	return 1 + Math.max(0, maxRetries);
}
