/**
 * Active wall-clock from assistant timestamps.
 * Sorts the sequence and sums adjacent gaps of at most 10 minutes.
 * Gaps larger than 10 minutes are park / keep-alive and are excluded.
 * Returns undefined when the caller should exclude the sample (< 2 timestamps).
 * Pure: no I/O, no JSONL parsing.
 */
const ACTIVE_WALL_MAX_GAP_MS = 10 * 60 * 1000;

export function computeActiveWallMs(assistantTimestamps: readonly number[]): number | undefined {
	if (assistantTimestamps.length < 2) return undefined;
	const sorted = assistantTimestamps.slice().sort((a, b) => a - b);
	let activeMs = 0;
	for (let i = 1; i < sorted.length; i++) {
		const gapMs = sorted[i]! - sorted[i - 1]!;
		if (gapMs <= ACTIVE_WALL_MAX_GAP_MS) activeMs += gapMs;
	}
	return activeMs;
}
