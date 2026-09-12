import { describe, expect, it } from "bun:test";
import { resolveArtifactInclusion, withToolHistoryEviction } from "../../src/workflow/artifact-inclusion";
import { ContextBuilder } from "../../src/workflow/context-builder";
import type { ContextStrategy, ModelProfile } from "../../src/workflow/types";
import { planArtifact } from "./helpers";

function profile(
	overrides: Partial<Pick<ModelProfile, "contextPolicy" | "contextStrategy">>,
): Pick<ModelProfile, "contextPolicy" | "contextStrategy"> {
	return {
		contextPolicy: {
			includePlan: true,
			includeReviewFindings: true,
			includeVerification: true,
			includeFullTranscript: false,
			maxArtifactBytes: 10_000,
			...overrides.contextPolicy,
		},
		contextStrategy: overrides.contextStrategy,
	};
}

describe("resolveArtifactInclusion", () => {
	it("prefers contextStrategy.artifactInclusion over contextPolicy", () => {
		const resolved = resolveArtifactInclusion(
			profile({
				contextPolicy: {
					includePlan: true,
					includeReviewFindings: true,
					includeVerification: true,
					includeFullTranscript: false,
					maxArtifactBytes: 10_000,
				},
				contextStrategy: {
					targetUtilization: 0.7,
					artifactInclusion: {
						includePlan: false,
						includeReviewFindings: false,
						includeVerification: true,
						maxArtifactBytes: 2_000,
					},
				},
			}),
		);
		expect(resolved.includePlan).toBe(false);
		expect(resolved.includeReviewFindings).toBe(false);
		expect(resolved.maxArtifactBytes).toBe(2_000);
	});
});

describe("ContextBuilder inclusion flags", () => {
	it("omits plan JSON when includePlan is false", () => {
		const cb = new ContextBuilder();
		const inclusion = resolveArtifactInclusion(
			profile({
				contextStrategy: {
					targetUtilization: 0.7,
					artifactInclusion: {
						includePlan: false,
						includeReviewFindings: true,
						includeVerification: true,
						maxArtifactBytes: 10_000,
					},
				},
			}),
		);
		const plan = planArtifact({ summary: "do thing uniquely" });
		const ctx = cb.buildPlanReviewContext(plan, inclusion);
		expect(ctx).toContain("omitted by profile");
		expect(ctx).not.toContain("do thing uniquely");
	});
});

describe("withToolHistoryEviction", () => {
	it("tightens keepRecentN to toolHistory.maxToolCalls", () => {
		const strategy: ContextStrategy = {
			targetUtilization: 0.7,
			eviction: {
				enabled: true,
				preserveUserTurns: true,
				evictPersisted: true,
				keepRecentN: 12,
			},
			toolHistory: { maxToolCalls: 5, summarizeOld: true },
		};
		const next = withToolHistoryEviction(strategy);
		expect(next?.eviction?.keepRecentN).toBe(5);
	});
});
