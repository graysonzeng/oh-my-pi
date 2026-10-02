/**
 * W6 production carry builders — infer natural phase boundaries and semantic
 * retained state from the live session branch (no model summarizer, no 200k
 * global threshold). Pure helpers for SessionMaintenance wiring.
 */
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import {
	PARENT_FINAL_VERIFICATION_MESSAGE_TYPE,
	parseParentFinalVerificationDetails,
} from "../latency/parent-final-verification";
import { collectPendingToolCalls } from "./exit-diagnostics";
import {
	type PhaseHandoffCarriedContext,
	type PhaseHandoffPhase,
	type PhaseHandoffRetainedState,
} from "./phase-handoff-experiment";
import { PHASE_HANDOFF_MAINTENANCE_CUSTOM_TYPE } from "./phase-handoff-maintenance";
import type { SessionEntry } from "./session-entries";
import { getLatestTodoPhasesFromEntries } from "../tools/todo";

const RESEARCH_TOOLS = new Set([
	"read",
	"grep",
	"glob",
	"find",
	"web_search",
	"web_fetch",
	"web_scrape",
	"lsp",
	"codebase_search",
	"search",
	"semantic_search",
]);

const IMPLEMENT_TOOLS = new Set([
	"edit",
	"write",
	"apply_patch",
	"multi_edit",
	"notebook_edit",
	"str_replace",
	"create_file",
]);

const VERIFY_TOOLS = new Set(["test", "verify", "run_tests", "vitest"]);

const ARTIFACT_URI_RE = /artifact:\/\/[^\s\]`"')]+/g;
const BULKY_CHAR_FLOOR = 2_000;

export interface PhaseHandoffBoundaryObservation {
	fromPhase: PhaseHandoffPhase;
	toPhase: PhaseHandoffPhase;
	explicitStageComplete?: boolean;
	/** Stable key for idempotent rewrite (same boundary not re-shaken). */
	boundaryKey: string;
}

export interface PhaseHandoffMaintenanceObserveData {
	shadow?: { fromPhase?: unknown; toPhase?: unknown; boundaryDetected?: unknown };
	applied?: unknown;
	shouldRewriteContext?: unknown;
	rewriteApplied?: unknown;
	boundaryKey?: unknown;
	/** False when rewrite was attempted but failed — boundary stays pending. */
	boundaryProcessed?: unknown;
	rewriteSkippedReason?: unknown;
}

function isPhase(value: unknown): value is PhaseHandoffPhase {
	return value === "research" || value === "implement" || value === "verify" || value === "unknown";
}

function phaseFromTodoName(name: string): PhaseHandoffPhase | undefined {
	const lower = name.toLowerCase();
	if (/(research|explor|investigat|understand|diagnos|plan\b)/.test(lower)) return "research";
	if (/(implement|fix|edit|cod(e|ing)|build|writ)/.test(lower)) return "implement";
	if (/(verif|test|review|validat|accept|qa\b)/.test(lower)) return "verify";
	return undefined;
}

function phaseFromToolName(toolName: string, args: unknown): PhaseHandoffPhase | undefined {
	const name = toolName.toLowerCase();
	if (RESEARCH_TOOLS.has(name)) return "research";
	if (IMPLEMENT_TOOLS.has(name)) return "implement";
	if (VERIFY_TOOLS.has(name)) return "verify";
	if (name === "bash" || name === "shell" || name === "run_terminal_cmd") {
		const command = isRecord(args) && typeof args.command === "string" ? args.command.toLowerCase() : "";
		if (/(test|vitest|jest|pytest|bun\s+test|cargo\s+test|npm\s+test|ci\b)/.test(command)) return "verify";
		if (/(git\s+(commit|add|checkout|branch)|mkdir|rm\s|mv\s|cp\s)/.test(command)) return "implement";
		return undefined;
	}
	return undefined;
}

function toolPathFromArgs(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	for (const key of ["path", "file_path", "filePath", "target"] as const) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function walkAssistantToolCalls(
	entries: readonly SessionEntry[],
	visit: (toolName: string, args: unknown, toolCallId: string | undefined) => void,
): void {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isRecord(block) || block.type !== "toolCall") continue;
			const toolName = typeof block.name === "string" ? block.name : "";
			if (!toolName) continue;
			const toolCallId = typeof block.id === "string" ? block.id : undefined;
			visit(toolName, block.arguments, toolCallId);
		}
	}
}

/** Infer the current delivery phase from recent tool / todo signals. */
export function inferPhaseHandoffPhase(entries: readonly SessionEntry[]): PhaseHandoffPhase {
	const phases = getLatestTodoPhasesFromEntries([...entries]);
	// Prefer an explicitly in-progress todo phase over later pending phases.
	for (let i = phases.length - 1; i >= 0; i--) {
		const phase = phases[i]!;
		if (!phase.tasks.some(t => t.status === "in_progress")) continue;
		const mapped = phaseFromTodoName(phase.name);
		if (mapped) return mapped;
	}
	for (let i = 0; i < phases.length; i++) {
		const phase = phases[i]!;
		if (!phase.tasks.some(t => t.status === "pending" || t.status === "blocked")) continue;
		const mapped = phaseFromTodoName(phase.name);
		if (mapped) return mapped;
	}

	let last: PhaseHandoffPhase | undefined;
	walkAssistantToolCalls(entries, (toolName, args) => {
		const mapped = phaseFromToolName(toolName, args);
		if (mapped) last = mapped;
	});
	return last ?? "unknown";
}

/** Prior phase immediately before the current tip (for first observation). */
export function inferPriorPhaseHandoffPhase(
	entries: readonly SessionEntry[],
	current: PhaseHandoffPhase,
): PhaseHandoffPhase {
	if (current === "unknown") return "unknown";
	const ordered: PhaseHandoffPhase[] = ["research", "implement", "verify"];
	const currentIdx = ordered.indexOf(current);
	if (currentIdx <= 0) return "unknown";

	const sequence: PhaseHandoffPhase[] = [];
	walkAssistantToolCalls(entries, (toolName, args) => {
		const mapped = phaseFromToolName(toolName, args);
		if (mapped) sequence.push(mapped);
	});
	for (let i = sequence.length - 1; i >= 0; i--) {
		const candidate = sequence[i]!;
		if (candidate !== current && ordered.indexOf(candidate) === currentIdx - 1) {
			return candidate;
		}
	}
	return ordered[currentIdx - 1]!;
}

/** Read last *successfully processed* toPhase from phase_handoff_maintenance entries. */
export function readLastObservedPhaseHandoff(entries: readonly SessionEntry[]):
	| {
			toPhase: PhaseHandoffPhase;
			boundaryKey?: string;
			rewriteApplied: boolean;
	  }
	| undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== PHASE_HANDOFF_MAINTENANCE_CUSTOM_TYPE) continue;
		const data = entry.data as PhaseHandoffMaintenanceObserveData | undefined;
		// Failed rewrite leaves the boundary pending — skip so fromPhase does not
		// advance (research→implement must not become implement→implement).
		if (data?.boundaryProcessed === false) continue;
		if (data?.rewriteSkippedReason === "shake_failed_open") continue;
		const toPhase = isPhase(data?.shadow?.toPhase) ? data.shadow.toPhase : undefined;
		if (!toPhase) continue;
		return {
			toPhase,
			boundaryKey: typeof data?.boundaryKey === "string" ? data.boundaryKey : undefined,
			rewriteApplied: data?.rewriteApplied === true || data?.applied === true,
		};
	}
	return undefined;
}

/** Whether this boundary already consumed a rewrite (idempotent). */
export function phaseHandoffRewriteAlreadyApplied(entries: readonly SessionEntry[], boundaryKey: string): boolean {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PHASE_HANDOFF_MAINTENANCE_CUSTOM_TYPE) continue;
		const data = entry.data as PhaseHandoffMaintenanceObserveData | undefined;
		if (data?.boundaryKey === boundaryKey && data.rewriteApplied === true) return true;
	}
	return false;
}

function todoExplicitStageComplete(entries: readonly SessionEntry[]): boolean {
	const phases = getLatestTodoPhasesFromEntries([...entries]);
	if (phases.length < 2) return false;
	// A completed earlier phase with an active later phase is an explicit stage complete signal.
	for (let i = 0; i < phases.length - 1; i++) {
		const earlier = phases[i]!;
		const later = phases[i + 1]!;
		const earlierDone =
			earlier.tasks.length > 0 && earlier.tasks.every(t => t.status === "completed" || t.status === "abandoned");
		const laterActive = later.tasks.some(t => t.status === "in_progress" || t.status === "pending");
		if (earlierDone && laterActive) return true;
	}
	return false;
}

/**
 * Durable id for the branch entry that introduced `toPhase` after `fromPhase`.
 * Collapses same-named phase transitions across distinct task instances.
 */
export function resolvePhaseHandoffBoundaryEntryId(
	entries: readonly SessionEntry[],
	toPhase: PhaseHandoffPhase,
): string {
	if (toPhase === "unknown") {
		const last = entries[entries.length - 1];
		return last && "id" in last && typeof last.id === "string" ? last.id : `tip:${entries.length}`;
	}
	let lastMatchId: string | undefined;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry || entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isRecord(block) || block.type !== "toolCall") continue;
			const toolName = typeof block.name === "string" ? block.name : "";
			if (!toolName) continue;
			const mapped = phaseFromToolName(toolName, block.arguments);
			if (mapped === toPhase) {
				lastMatchId = typeof entry.id === "string" ? entry.id : `entry:${i}`;
			}
		}
	}
	if (lastMatchId) return lastMatchId;
	const tip = entries[entries.length - 1];
	return tip && "id" in tip && typeof tip.id === "string" ? tip.id : `tip:${entries.length}`;
}

/**
 * Resolve from/to phase for a maintenance-boundary observation.
 * Uses prior *processed* custom entry when present; otherwise reconstructs prior from history.
 * Boundary key includes a durable entry id so distinct tasks with the same named
 * phases (research→implement) do not collapse under one idempotency key.
 */
export function resolvePhaseHandoffBoundaryObservation(
	entries: readonly SessionEntry[],
): PhaseHandoffBoundaryObservation {
	const toPhase = inferPhaseHandoffPhase(entries);
	const last = readLastObservedPhaseHandoff(entries);
	const fromPhase = last?.toPhase ?? inferPriorPhaseHandoffPhase(entries, toPhase);
	const explicitStageComplete = todoExplicitStageComplete(entries) && fromPhase !== toPhase ? true : undefined;
	const boundaryEntryId = resolvePhaseHandoffBoundaryEntryId(entries, toPhase);
	const boundaryKey = `${fromPhase}->${toPhase}#${boundaryEntryId}`;
	return { fromPhase, toPhase, explicitStageComplete, boundaryKey };
}

function collectArtifactLocators(entries: readonly SessionEntry[]): string[] {
	const found = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === PARENT_FINAL_VERIFICATION_MESSAGE_TYPE) {
			const parsed = parseParentFinalVerificationDetails(entry.data);
			for (const ref of parsed?.evidenceRefs ?? []) {
				if (ref.startsWith("artifact://")) found.add(ref);
			}
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
				for (const match of block.text.matchAll(ARTIFACT_URI_RE)) {
					found.add(match[0]!);
				}
			}
		}
	}
	return [...found];
}

function collectModificationState(entries: readonly SessionEntry[]): string[] {
	const paths = new Set<string>();
	walkAssistantToolCalls(entries, (toolName, args) => {
		if (!IMPLEMENT_TOOLS.has(toolName.toLowerCase())) return;
		const path = toolPathFromArgs(args);
		if (path) paths.add(`edited ${path}`);
	});
	return [...paths];
}

function collectOpenConstraints(entries: readonly SessionEntry[]): string[] {
	const phases = getLatestTodoPhasesFromEntries([...entries]);
	const out: string[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "pending" || task.status === "in_progress" || task.status === "blocked") {
				const blocker = task.blocker ? ` (blocked: ${task.blocker})` : "";
				out.push(`[${phase.name}] ${task.content}${blocker}`);
			}
		}
	}
	return out;
}

function collectAcceptanceBasis(entries: readonly SessionEntry[]): string[] {
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PARENT_FINAL_VERIFICATION_MESSAGE_TYPE) continue;
		const parsed = parseParentFinalVerificationDetails(entry.data);
		const items = parsed?.acceptanceContract?.items ?? [];
		for (const item of items) out.push(item);
	}
	if (out.length > 0) return out;
	const phases = getLatestTodoPhasesFromEntries([...entries]);
	for (const phase of phases) {
		if (!phaseFromTodoName(phase.name) || phaseFromTodoName(phase.name) === "verify") {
			for (const task of phase.tasks) {
				if (task.status === "pending" || task.status === "in_progress" || task.status === "completed") {
					out.push(`[${phase.name}] ${task.content}`);
				}
			}
		}
	}
	return out;
}

function collectFailedAttempts(entries: readonly SessionEntry[]): string[] {
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.isError !== true) continue;
		const toolName = typeof entry.message.toolName === "string" ? entry.message.toolName : "tool";
		const toolCallId = typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : "?";
		let preview = "";
		if (Array.isArray(entry.message.content)) {
			for (const block of entry.message.content) {
				if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
					preview = block.text.slice(0, 160).replace(/\s+/g, " ").trim();
					break;
				}
			}
		}
		out.push(`${toolName}:${toolCallId}${preview ? ` ${preview}` : ""}`);
	}
	return out;
}

function collectBulkyCarry(entries: readonly SessionEntry[]): string[] {
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.isError === true) continue;
		const toolName = typeof entry.message.toolName === "string" ? entry.message.toolName : "tool";
		const toolCallId = typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : "?";
		let chars = 0;
		if (Array.isArray(entry.message.content)) {
			for (const block of entry.message.content) {
				if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
					chars += block.text.length;
				}
			}
		}
		if (chars < BULKY_CHAR_FLOOR) continue;
		out.push(`${toolName}:${toolCallId}~${chars}ch`);
	}
	return out;
}

/**
 * Build semantic carried retain + bulky candidates from the live branch.
 * Declares optional recovery fields so missing recovery fails closed for treatment.
 */
export function buildPhaseHandoffCarriedFromBranch(entries: readonly SessionEntry[]): PhaseHandoffCarriedContext {
	const pending = collectPendingToolCalls(entries);
	const incompleteTools = pending.map(call => {
		const id = call.toolCallId ?? "?";
		const path =
			isRecord(call.args) && typeof call.args.path === "string"
				? ` path=${call.args.path}`
				: isRecord(call.args) && typeof call.args.command === "string"
					? ` cmd=${call.args.command.slice(0, 80)}`
					: "";
		return `${call.toolName}:${id}${path}`;
	});

	const retained: PhaseHandoffRetainedState = {
		openConstraints: collectOpenConstraints(entries),
		modificationState: collectModificationState(entries),
		acceptanceBasis: collectAcceptanceBasis(entries),
		incompleteTools,
		failedAttempts: collectFailedAttempts(entries),
		artifactLocators: collectArtifactLocators(entries),
	};

	return {
		bulkyCarry: collectBulkyCarry(entries),
		retained,
	};
}

/** True when incomplete tool-call pairs must block rewrite (fail open). */
export function phaseHandoffHasIncompleteToolPairs(retained: PhaseHandoffRetainedState): boolean {
	return (retained.incompleteTools?.length ?? 0) > 0;
}
