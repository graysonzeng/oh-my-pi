import type { ShadowDimensionStatus } from "./types";

export const SHADOW_REVIEW_OBSERVATION_TYPE = "shadow-review-observation";

export interface ShadowReviewObservation {
	sessionId: string;
	arm: "treatment";
	agent: string;
	dimensionStatuses: ShadowDimensionStatus[];
	wallMs: number;
	findingFingerprints: string[];
	startedAt: string;
	endedAt: string;
}

const WINDOW = 20;
const recent: ShadowReviewObservation[] = [];
let processSkip = false;

export function resetShadowReviewObservationStateForTests(): void {
	recent.length = 0;
	processSkip = false;
}

export function recordShadowReviewObservation(entry: ShadowReviewObservation): void {
	recent.push(entry);
	if (recent.length > WINDOW) recent.splice(0, recent.length - WINDOW);
	if (shouldTripStop(recent)) processSkip = true;
}

export function shouldSkipShadowReviewRegistration(): boolean {
	return processSkip;
}

export function tripShadowReviewStop(reason: string): void {
	processSkip = true;
	void reason;
}

function shouldTripStop(window: ShadowReviewObservation[]): boolean {
	if (window.length < WINDOW) return false;
	const slice = window.slice(-WINDOW);
	const uncovered = slice
		.flatMap(entry => entry.dimensionStatuses)
		.filter(status => status === "timeout" || status === "error");
	const total = slice.reduce((sum, entry) => sum + entry.dimensionStatuses.length, 0);
	if (total > 0 && uncovered.length / total > 0.25) return true;
	return false;
}
