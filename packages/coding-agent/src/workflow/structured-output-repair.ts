/**
 * Layered structured-output repair: deterministic extract → budget → model retry → receipt.
 * Does not invent missing fields, guess enums, or coerce types loosely.
 */

import schemaRetryTemplate from "../prompts/workflow/schema-retry.hbs.md" with { type: "text" };
import { sha256Hex } from "./optimization-receipt";

export const SCHEMA_REPAIR_RECEIPT_KIND = "schema_repair_receipt" as const;
export const SCHEMA_REPAIR_RECEIPT_VERSION = 1 as const;

/** Default head+tail chars for previous-output fragment in retry prompts. */
export const SCHEMA_RETRY_FRAGMENT_HEAD = 500;
export const SCHEMA_RETRY_FRAGMENT_TAIL = 500;

export type SchemaRepairFinalStatus = "repaired_layer1" | "repaired_layer3" | "schema_error" | "budget_exhausted";

export interface SchemaRepairAttempt {
	attemptIndex: number;
	/** deterministic_extract | model_retry | validate */
	phase: "deterministic_extract" | "model_retry" | "validate";
	inputSha256: string;
	outputSha256?: string;
	/** Bounded raw / extracted text for debugging (never invents fields). */
	outputPreview?: string;
	ok: boolean;
	error?: string;
}

export interface SchemaViolationRecord {
	attemptIndex: number;
	phase: SchemaRepairAttempt["phase"];
	error: string;
	outputPreview?: string;
}

export interface SchemaRepairReceiptV1 {
	schemaVersion: typeof SCHEMA_REPAIR_RECEIPT_VERSION;
	kind: typeof SCHEMA_REPAIR_RECEIPT_KIND;
	attempts: SchemaRepairAttempt[];
	/** Total model calls made during repair (0 when only deterministic Layer 1). */
	modelCalls: number;
	/** maxRetries from config (additional model calls after first external call). */
	maxRetries: number;
	repaired: boolean;
	/** Semantic summary fields (OBJECTIVE SchemaRepairReceiptV1). */
	totalAttempts: number;
	layer1Success: boolean;
	layer3RetryCount: number;
	finalStatus: SchemaRepairFinalStatus;
	budgetExhausted: boolean;
	/** Which budget dimension blocked retry, when budgetExhausted. */
	budgetExhaustedReason?: "remainingModelCalls" | "remainingCostUsd" | "remainingTimeMs";
	violationHistory: SchemaViolationRecord[];
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
	/**
	 * Bound previous output fragment size (total budget for head+tail when not using defaults).
	 * Prefer head/tail constants; when set alone, uses half for head and half for tail.
	 */
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

/** Zero-width / BOM code points stripped in Layer 1 (format only). */
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Strip UTF-8 BOM and zero-width characters. Pure; no field invention. */
export function stripInvisibleChars(text: string): string {
	let out = text;
	if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
	return out.replace(ZERO_WIDTH_RE, "");
}

/**
 * Bound previous output for retry prompts: head + tail (default 500 + 500).
 * Pure; does not mutate input.
 */
export function boundOutputFragment(
	text: string,
	headChars: number = SCHEMA_RETRY_FRAGMENT_HEAD,
	tailChars: number = SCHEMA_RETRY_FRAGMENT_TAIL,
): string {
	const head = Math.max(0, headChars);
	const tail = Math.max(0, tailChars);
	if (text.length <= head + tail) return text;
	return `${text.slice(0, head)}\n/* …truncated… */\n${text.slice(text.length - tail)}`;
}

/**
 * Extract a single JSON object/array from model text:
 * invisible strip → markdown fence unwrap → first complete JSON value.
 * Returns null when no valid JSON found (no field invention).
 */
export function extractJsonValue(raw: string): { text: string; value: unknown } | null {
	let text = stripInvisibleChars(raw).trim();
	// Fenced block: ```json ... ``` or ``` ... ```
	const fence = text.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
	if (fence) {
		text = fence[1]!.trim();
	} else {
		// Leading/trailing prose + fenced body
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

	// Find first { or [ and parse balanced slice (handles surrounding prose)
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

/**
 * Minimal required-field + type=object validator used when no external AJV is wired.
 * Does not invent fields, coerce types, or guess enums.
 */
export function defaultSchemaValidator(value: unknown, schema: unknown): { ok: true } | { ok: false; error: string } {
	if (schema === undefined || schema === null || schema === true) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) return { ok: true };
		return { ok: false, error: "expected JSON object" };
	}
	if (typeof schema !== "object" || Array.isArray(schema)) return { ok: true };
	const s = schema as {
		type?: unknown;
		required?: unknown;
		properties?: unknown;
		enum?: unknown;
	};
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
		// Property type / enum checks — report only, never coerce.
		if (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) {
			const props = s.properties as Record<string, unknown>;
			const obj = value as Record<string, unknown>;
			for (const [key, propSchema] of Object.entries(props)) {
				if (!(key in obj)) continue;
				const propErr = validatePropertyValue(obj[key], propSchema, key);
				if (propErr) return { ok: false, error: propErr };
			}
		}
	}
	if (Array.isArray(s.enum)) {
		if (!s.enum.includes(value)) {
			return { ok: false, error: `value not in enum: ${JSON.stringify(s.enum)}` };
		}
	}
	return { ok: true };
}

function validatePropertyValue(value: unknown, propSchema: unknown, key: string): string | undefined {
	if (!propSchema || typeof propSchema !== "object" || Array.isArray(propSchema)) return undefined;
	const ps = propSchema as { type?: unknown; enum?: unknown };
	if (Array.isArray(ps.enum) && !ps.enum.includes(value)) {
		return `field ${key}: value not in enum ${JSON.stringify(ps.enum)}`;
	}
	if (typeof ps.type === "string") {
		const t = ps.type;
		if (t === "string" && typeof value !== "string") return `field ${key}: expected string`;
		if (t === "number" && typeof value !== "number") return `field ${key}: expected number`;
		if (t === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
			return `field ${key}: expected integer`;
		}
		if (t === "boolean" && typeof value !== "boolean") return `field ${key}: expected boolean`;
		if (t === "array" && !Array.isArray(value)) return `field ${key}: expected array`;
		if (t === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) {
			return `field ${key}: expected object`;
		}
		// No string→number coercion ("123" stays invalid for type number).
	}
	return undefined;
}

export interface SchemaRetryPromptVars {
	violation: string;
	schemaTypeName: string;
	schemaFields: string;
	previousOutputPreview: string;
	attemptNumber: number;
	/** @deprecated alias — template prefers `violation` */
	violations?: string;
	/** @deprecated alias — template prefers schemaTypeName + schemaFields */
	schemaSummary?: string;
	/** @deprecated alias — template prefers previousOutputPreview */
	previousOutput?: string;
}

/** Render static schema-retry template (Handlebars-lite: {{var}} only). */
export function renderSchemaRetryPrompt(vars: SchemaRetryPromptVars): string {
	const violation = vars.violation ?? vars.violations ?? "";
	const schemaTypeName = vars.schemaTypeName ?? "object";
	const schemaFields = vars.schemaFields ?? vars.schemaSummary ?? "";
	const previousOutputPreview = vars.previousOutputPreview ?? vars.previousOutput ?? "";
	const attemptNumber = String(vars.attemptNumber ?? 1);
	const schemaSummary = vars.schemaSummary ?? `${schemaTypeName}: ${schemaFields}`;
	return schemaRetryTemplate
		.replace(/\{\{violation\}\}/g, violation)
		.replace(/\{\{violations\}\}/g, violation)
		.replace(/\{\{schemaTypeName\}\}/g, schemaTypeName)
		.replace(/\{\{schemaFields\}\}/g, schemaFields)
		.replace(/\{\{schemaSummary\}\}/g, schemaSummary)
		.replace(/\{\{previousOutputPreview\}\}/g, previousOutputPreview)
		.replace(/\{\{previousOutput\}\}/g, previousOutputPreview)
		.replace(/\{\{attemptNumber\}\}/g, attemptNumber);
}

/** Schema type name for retry prompt (title / $id / type). */
export function schemaTypeName(schema: unknown): string {
	if (schema && typeof schema === "object" && !Array.isArray(schema)) {
		const s = schema as { title?: unknown; $id?: unknown; type?: unknown };
		if (typeof s.title === "string" && s.title.length > 0) return s.title;
		if (typeof s.$id === "string" && s.$id.length > 0) return s.$id;
		if (typeof s.type === "string") return s.type;
	}
	return "object";
}

/** Schema field summary: required + property types/enums (bounded). */
export function schemaFieldsSummary(schema: unknown, maxChars = 800): string {
	try {
		if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
			const s = JSON.stringify(schema);
			return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
		}
		const s = schema as {
			required?: unknown;
			properties?: unknown;
			type?: unknown;
		};
		const lines: string[] = [];
		if (typeof s.type === "string") lines.push(`type: ${s.type}`);
		if (Array.isArray(s.required)) {
			lines.push(`required: ${s.required.filter((k): k is string => typeof k === "string").join(", ")}`);
		}
		if (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) {
			for (const [key, prop] of Object.entries(s.properties as Record<string, unknown>)) {
				if (prop && typeof prop === "object" && !Array.isArray(prop)) {
					const p = prop as { type?: unknown; enum?: unknown };
					const bits: string[] = [];
					if (typeof p.type === "string") bits.push(p.type);
					if (Array.isArray(p.enum)) bits.push(`enum=${JSON.stringify(p.enum)}`);
					lines.push(`  ${key}: ${bits.join(" ") || "any"}`);
				} else {
					lines.push(`  ${key}: any`);
				}
			}
		}
		const out = lines.join("\n");
		return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out || JSON.stringify(schema).slice(0, maxChars);
	} catch {
		return String(schema);
	}
}

function schemaSummaryJson(schema: unknown): string {
	try {
		const s = JSON.stringify(schema);
		return s.length > 800 ? `${s.slice(0, 800)}…` : s;
	} catch {
		return String(schema);
	}
}

export function budgetBlockReason(
	budget: StructuredRepairBudget | undefined,
): SchemaRepairReceiptV1["budgetExhaustedReason"] | undefined {
	if (!budget) return undefined;
	if (typeof budget.remainingModelCalls === "number" && budget.remainingModelCalls <= 0) {
		return "remainingModelCalls";
	}
	if (typeof budget.remainingCostUsd === "number" && budget.remainingCostUsd <= 0) {
		return "remainingCostUsd";
	}
	if (typeof budget.remainingTimeMs === "number" && budget.remainingTimeMs <= 0) {
		return "remainingTimeMs";
	}
	return undefined;
}

function previewForReceipt(text: string): string {
	return boundOutputFragment(text, SCHEMA_RETRY_FRAGMENT_HEAD, SCHEMA_RETRY_FRAGMENT_TAIL);
}

function buildReceipt(params: {
	attempts: SchemaRepairAttempt[];
	modelCalls: number;
	maxRetries: number;
	repaired: boolean;
	layer1Success: boolean;
	finalStatus: SchemaRepairFinalStatus;
	budgetExhausted: boolean;
	budgetExhaustedReason?: SchemaRepairReceiptV1["budgetExhaustedReason"];
}): SchemaRepairReceiptV1 {
	const violationHistory: SchemaViolationRecord[] = params.attempts
		.filter(a => !a.ok && a.error)
		.map(a => ({
			attemptIndex: a.attemptIndex,
			phase: a.phase,
			error: a.error!,
			outputPreview: a.outputPreview,
		}));
	return {
		schemaVersion: SCHEMA_REPAIR_RECEIPT_VERSION,
		kind: SCHEMA_REPAIR_RECEIPT_KIND,
		attempts: params.attempts,
		modelCalls: params.modelCalls,
		maxRetries: params.maxRetries,
		repaired: params.repaired,
		totalAttempts: params.attempts.length,
		layer1Success: params.layer1Success,
		layer3RetryCount: params.modelCalls,
		finalStatus: params.finalStatus,
		budgetExhausted: params.budgetExhausted,
		budgetExhaustedReason: params.budgetExhaustedReason,
		violationHistory,
	};
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
	const fragmentHead =
		options.maxFragmentChars !== undefined
			? Math.floor(Math.max(0, options.maxFragmentChars) / 2)
			: SCHEMA_RETRY_FRAGMENT_HEAD;
	const fragmentTail =
		options.maxFragmentChars !== undefined
			? Math.ceil(Math.max(0, options.maxFragmentChars) / 2)
			: SCHEMA_RETRY_FRAGMENT_TAIL;
	let modelCalls = 0;
	let currentRaw = raw;
	let layer1Success = false;
	let budgetExhausted = false;
	let budgetExhaustedReason: SchemaRepairReceiptV1["budgetExhaustedReason"];

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
				outputPreview: previewForReceipt(currentRaw),
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
			outputPreview: previewForReceipt(extracted.text),
			ok: validation.ok,
			error: validation.ok ? undefined : validation.error,
		});
		if (validation.ok) {
			if (attemptIndex === 0) layer1Success = true;
			const finalStatus: SchemaRepairFinalStatus = modelCalls === 0 ? "repaired_layer1" : "repaired_layer3";
			return {
				ok: true,
				value: extracted.value,
				receipt: buildReceipt({
					attempts,
					modelCalls,
					maxRetries,
					repaired: true,
					layer1Success: modelCalls === 0 ? true : layer1Success,
					finalStatus,
					budgetExhausted: false,
				}),
				raw: currentRaw,
			};
		}
		return null;
	};

	// Attempt 0: deterministic extract + validate (zero model calls).
	const first = tryExtractAndValidate("deterministic_extract", 0);
	if (first?.ok) {
		const extracted = extractJsonValue(raw);
		const cleaned = stripInvisibleChars(raw).trim();
		const trivial = extracted && extracted.text === cleaned;
		// repaired=false when raw was already clean valid JSON without transform noise.
		first.receipt.repaired = !trivial;
		first.receipt.layer1Success = true;
		first.receipt.finalStatus = "repaired_layer1";
		return first;
	}

	let lastError = attempts[attempts.length - 1]?.error ?? "schema validation failed";

	for (let retry = 1; retry <= maxRetries; retry++) {
		if (!options.retryWithModel) break;

		const block = budgetBlockReason(options.budget);
		if (block) {
			budgetExhausted = true;
			budgetExhaustedReason = block;
			attempts.push({
				attemptIndex: retry,
				phase: "model_retry",
				inputSha256: sha256Hex(currentRaw),
				outputPreview: previewForReceipt(currentRaw),
				ok: false,
				error: `budget exhausted before retry: ${block}`,
			});
			break;
		}

		const fragment = boundOutputFragment(currentRaw, fragmentHead, fragmentTail);
		const prompt = renderSchemaRetryPrompt({
			violation: lastError,
			schemaTypeName: schemaTypeName(options.schema),
			schemaFields: schemaFieldsSummary(options.schema),
			schemaSummary: schemaSummaryJson(options.schema),
			previousOutputPreview: fragment,
			attemptNumber: retry,
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
				outputPreview: previewForReceipt(currentRaw),
				ok: true,
			});
		} catch (err) {
			attempts.push({
				attemptIndex: retry,
				phase: "model_retry",
				inputSha256: sha256Hex(currentRaw),
				outputPreview: previewForReceipt(currentRaw),
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
			break;
		}

		const repaired = tryExtractAndValidate("deterministic_extract", retry);
		if (repaired?.ok) {
			repaired.receipt.repaired = true;
			repaired.receipt.modelCalls = modelCalls;
			repaired.receipt.layer3RetryCount = modelCalls;
			repaired.receipt.finalStatus = "repaired_layer3";
			repaired.receipt.layer1Success = false;
			return repaired;
		}
		lastError = attempts[attempts.length - 1]?.error ?? lastError;
	}

	const finalStatus: SchemaRepairFinalStatus = budgetExhausted ? "budget_exhausted" : "schema_error";
	return {
		ok: false,
		error: lastError,
		receipt: buildReceipt({
			attempts,
			modelCalls,
			maxRetries,
			repaired: false,
			layer1Success: false,
			finalStatus,
			budgetExhausted,
			budgetExhaustedReason,
		}),
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

/** Build remaining budget snapshot from profile limits and usage so far. */
export function budgetFromProfileUsage(params: {
	maxRequests?: number;
	maxCostUsd?: number;
	maxRuntimeMs?: number;
	/** Model invocations already spent (including the first). */
	usedRequests: number;
	usedCostUsd?: number | null;
	/** Elapsed wall time for this repair cycle. */
	elapsedMs?: number | null;
}): StructuredRepairBudget {
	const remainingModelCalls =
		typeof params.maxRequests === "number" ? Math.max(0, params.maxRequests - params.usedRequests) : undefined;
	const remainingCostUsd =
		typeof params.maxCostUsd === "number" && typeof params.usedCostUsd === "number"
			? Math.max(0, params.maxCostUsd - params.usedCostUsd)
			: typeof params.maxCostUsd === "number" && params.usedCostUsd == null
				? undefined
				: undefined;
	// When maxCostUsd is set and used is known, compute remainder; when used unknown, do not block.
	const costRemaining =
		typeof params.maxCostUsd === "number" && params.usedCostUsd != null
			? Math.max(0, params.maxCostUsd - params.usedCostUsd)
			: undefined;
	const timeRemaining =
		typeof params.maxRuntimeMs === "number" && params.elapsedMs != null
			? Math.max(0, params.maxRuntimeMs - params.elapsedMs)
			: undefined;
	return {
		remainingModelCalls,
		remainingCostUsd: costRemaining ?? remainingCostUsd,
		remainingTimeMs: timeRemaining,
	};
}
