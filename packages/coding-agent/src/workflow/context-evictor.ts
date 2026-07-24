import type { ContextStrategy } from "./types";

export type ContextSegmentType = "user" | "tool" | "assistant" | "artifact";

export interface ContextSegment {
	id: string;
	type: ContextSegmentType;
	/** Effect already persisted (file write, successful command, etc.). */
	persisted: boolean;
	turnIndex: number;
	tokens: number;
	content: string;
}

export interface EvictContextOptions {
	segments: ContextSegment[];
	strategy: Pick<ContextStrategy, "targetUtilization" | "eviction">;
	currentTokens: number;
	maxTokens: number;
}

/**
 * CWL-style structured eviction: keep user turns and recent turns;
 * drop persisted tool segments under utilization pressure.
 * Does not summarize — preserves causal structure of kept segments.
 */
export function evictContext(options: EvictContextOptions): ContextSegment[] {
	const { segments, strategy, currentTokens, maxTokens } = options;
	const eviction = strategy.eviction;
	if (!eviction?.enabled) return segments;

	const targetTokens = Math.floor(maxTokens * strategy.targetUtilization);
	if (currentTokens <= targetTokens) return segments;
	if (segments.length === 0) return segments;

	const maxTurn = Math.max(...segments.map(s => s.turnIndex));
	const recentCutoff = maxTurn - eviction.keepRecentN + 1;

	const toKeep: ContextSegment[] = [];
	for (const seg of segments) {
		if (seg.type === "user" && eviction.preserveUserTurns) {
			toKeep.push(seg);
			continue;
		}
		if (seg.turnIndex >= recentCutoff) {
			toKeep.push(seg);
			continue;
		}
		if (seg.type === "tool" && seg.persisted && eviction.evictPersisted) {
			continue; // drop persisted tool segment
		}
		toKeep.push(seg);
	}

	let keptTokens = toKeep.reduce((sum, s) => sum + s.tokens, 0);
	if (keptTokens <= targetTokens) {
		return sortByTurn(toKeep);
	}

	// Still over target: drop older assistant (and non-user) segments first, oldest first.
	const sorted = [...toKeep].sort((a, b) => a.turnIndex - b.turnIndex);
	const finalKeep: ContextSegment[] = [];
	// Walk newest → oldest when deciding what to keep under budget.
	for (const seg of [...sorted].reverse()) {
		if (seg.type === "user" && eviction.preserveUserTurns) {
			finalKeep.push(seg);
			continue;
		}
		if (seg.turnIndex >= recentCutoff) {
			finalKeep.push(seg);
			continue;
		}
		if (keptTokens > targetTokens && (seg.type === "assistant" || seg.type === "tool" || seg.type === "artifact")) {
			keptTokens -= seg.tokens;
			continue;
		}
		finalKeep.push(seg);
	}

	return sortByTurn(finalKeep);
}

function sortByTurn(segments: ContextSegment[]): ContextSegment[] {
	return [...segments].sort((a, b) => a.turnIndex - b.turnIndex || a.id.localeCompare(b.id));
}

/**
 * Mark tool segments as persisted when content indicates durable side effects.
 */
export function markPersistedSegments(segments: ContextSegment[]): ContextSegment[] {
	return segments.map(seg => {
		if (seg.type !== "tool") return seg;
		const c = seg.content.toLowerCase();
		const isPersisted =
			/\b(write|edit|apply.?patch|replace)\b/.test(c) ||
			(/\bbash\b/.test(c) && /exit\s*code[:\s]+0\b/.test(c)) ||
			seg.persisted;
		return isPersisted ? { ...seg, persisted: true } : seg;
	});
}

/** Rough token estimate (~4 chars/token) for eviction math without a tokenizer. */
export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}
