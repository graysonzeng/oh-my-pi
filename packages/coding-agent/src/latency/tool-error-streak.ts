/**
 * Consecutive identical tool-error streak (P2 Track R).
 * Advisory only: after N identical (toolName + message digest) failures,
 * append a one-shot model-visible hint. Success clears the streak.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import toolErrorStreakHint from "../prompts/latency/tool-error-streak.md" with { type: "text" };
import { sha256Hex } from "./stable-serialize";

export const TOOL_ERROR_STREAK_THRESHOLD = 3;

const kToolErrorStreak = Symbol("latency.toolErrorStreak");

interface StreakState {
	fingerprint: string;
	count: number;
	advised: boolean;
}

interface SessionWithStreak {
	[kToolErrorStreak]?: StreakState;
}

export function buildToolErrorFingerprint(toolName: string, message: string): string {
	return `${toolName}\0${sha256Hex(message.trim()).slice(0, 16)}`;
}

export function clearToolErrorStreak(session: object): void {
	delete (session as SessionWithStreak)[kToolErrorStreak];
}

/**
 * Record an error result. Returns advisory text once when the streak reaches
 * the threshold; subsequent identical errors stay silent until success or a
 * different fingerprint.
 */
export function noteToolErrorStreak(session: object, toolName: string, message: string): string | undefined {
	const fingerprint = buildToolErrorFingerprint(toolName, message);
	const holder = session as SessionWithStreak;
	const prev = holder[kToolErrorStreak];
	if (!prev || prev.fingerprint !== fingerprint) {
		holder[kToolErrorStreak] = { fingerprint, count: 1, advised: false };
		return undefined;
	}
	prev.count += 1;
	if (prev.count < TOOL_ERROR_STREAK_THRESHOLD || prev.advised) return undefined;
	prev.advised = true;
	return prompt.render(toolErrorStreakHint, { toolName, count: prev.count }).trim();
}
