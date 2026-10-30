import { describe, expect, it } from "bun:test";
import { isShadowReviewQualified } from "@oh-my-pi/pi-coding-agent/shadow-mind/eligibility";

describe("shadow-review eligibility corpus", () => {
	const bundledReviewer = {
		agentName: "reviewer",
		agentShadowReview: "code" as const,
		enabled: true,
		restrictToolNames: false,
	};

	it("starts bundled reviewer with no spawn override when enabled", () => {
		expect(isShadowReviewQualified(bundledReviewer)).toBe(true);
	});

	it("does not start bundled reviewer when spawn is off", () => {
		expect(isShadowReviewQualified({ ...bundledReviewer, spawnShadowReview: "off" })).toBe(false);
	});

	it("does not start bundled reviewer when globally disabled", () => {
		expect(isShadowReviewQualified({ ...bundledReviewer, enabled: false })).toBe(false);
	});

	it("does not start sol-xhigh-reviewer on a design-review prompt without spawn code", () => {
		expect(
			isShadowReviewQualified({
				agentName: "sol-xhigh-reviewer",
				enabled: true,
				restrictToolNames: false,
			}),
		).toBe(false);
	});

	it("starts sol-xhigh-reviewer when spawn is code", () => {
		expect(
			isShadowReviewQualified({
				agentName: "sol-xhigh-reviewer",
				spawnShadowReview: "code",
				enabled: true,
				restrictToolNames: false,
			}),
		).toBe(true);
	});

	it("does not start flash-reviewer, main, or workflow code-reviewer without frontmatter/spawn", () => {
		for (const agentName of ["flash-reviewer", "main", "code-reviewer"]) {
			expect(
				isShadowReviewQualified({
					agentName,
					enabled: true,
					restrictToolNames: false,
				}),
			).toBe(false);
		}
	});

	it("does not start shadow child sessions", () => {
		expect(
			isShadowReviewQualified({
				...bundledReviewer,
				agentDisplayName: "shadow:architecture-review",
			}),
		).toBe(false);
	});

	it("does not start when restrictToolNames is true", () => {
		expect(isShadowReviewQualified({ ...bundledReviewer, restrictToolNames: true })).toBe(false);
	});

	it("does not start when the per-agent kill switch is false even with spawn code", () => {
		expect(
			isShadowReviewQualified({
				agentName: "sol-xhigh-reviewer",
				spawnShadowReview: "code",
				enabled: true,
				agentEnabled: false,
				restrictToolNames: false,
			}),
		).toBe(false);
	});
});
