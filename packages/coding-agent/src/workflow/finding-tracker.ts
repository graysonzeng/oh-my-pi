import { createHash } from "node:crypto";
import type { ReviewFindingV1 } from "./types";

export type FindingEscalation = "first_repair" | "reasoning" | "block";

export interface TrackedFinding extends ReviewFindingV1 {
	fingerprint: string;
	repairCycles: number;
}

/**
 * Stable fingerprint + repair-cycle tracking.
 * first repair → second cycle escalates to reasoning → third unresolved cycle blocks.
 */
export class FindingTracker {
	readonly #findings = new Map<string, TrackedFinding>();
	/** fingerprint → number of times observed across repair cycles */
	readonly #cycleCounts = new Map<string, number>();

	static fingerprint(finding: Pick<ReviewFindingV1, "category" | "summary" | "file" | "line">): string {
		const normalized = [
			finding.category,
			(finding.file ?? "").trim().toLowerCase(),
			finding.line ?? "",
			finding.summary.trim().toLowerCase().replace(/\s+/g, " "),
		].join("|");
		return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	}

	add(finding: ReviewFindingV1): TrackedFinding {
		const fingerprint = FindingTracker.fingerprint(finding);
		const existing = this.#findings.get(finding.id);
		const tracked: TrackedFinding = {
			...finding,
			fingerprint,
			repairCycles: existing?.repairCycles ?? 0,
		};
		this.#findings.set(finding.id, tracked);
		return tracked;
	}

	getAll(): TrackedFinding[] {
		return Array.from(this.#findings.values());
	}

	getById(id: string): TrackedFinding | null {
		return this.#findings.get(id) ?? null;
	}

	getOpen(): TrackedFinding[] {
		return this.getAll().filter(f => f.status === "open" || f.status === "in_progress");
	}

	resolve(id: string, status: "resolved" | "rejected" = "resolved"): void {
		const f = this.#findings.get(id);
		if (f) f.status = status;
	}

	/** Record that a repair cycle touched this fingerprint (or finding id). */
	recordRepairCycle(fingerprintOrId: string): FindingEscalation {
		const tracked = this.#findings.get(fingerprintOrId);
		const fingerprint = tracked?.fingerprint ?? fingerprintOrId;
		const next = (this.#cycleCounts.get(fingerprint) ?? 0) + 1;
		this.#cycleCounts.set(fingerprint, next);
		if (tracked) tracked.repairCycles = next;
		// Also bump any finding sharing the fingerprint
		for (const f of this.#findings.values()) {
			if (f.fingerprint === fingerprint) f.repairCycles = next;
		}
		return this.escalationFor(fingerprint);
	}

	/** Cycles already recorded for this fingerprint. */
	cycleCount(fingerprint: string): number {
		return this.#cycleCounts.get(fingerprint) ?? 0;
	}

	/**
	 * True when the same fingerprint has reappeared (seen ≥ 2 times / after first repair).
	 */
	hasRepeated(fingerprint: string): boolean {
		return this.cycleCount(fingerprint) >= 2;
	}

	escalationFor(fingerprint: string): FindingEscalation {
		const n = this.cycleCount(fingerprint);
		if (n >= 3) return "block";
		if (n >= 2) return "reasoning";
		return "first_repair";
	}

	/** Whether any open finding has reached the block threshold. */
	shouldBlock(): boolean {
		for (const f of this.getOpen()) {
			if (this.escalationFor(f.fingerprint) === "block") return true;
		}
		return false;
	}

	/** Whether routing should prefer a reasoning repair profile for this finding. */
	needsReasoningRepair(finding: ReviewFindingV1): boolean {
		const fingerprint = FindingTracker.fingerprint(finding);
		if (this.escalationFor(fingerprint) === "reasoning") return true;
		if (finding.suggestedOwner === "reasoning_repair") return true;
		if (finding.priority === "P0" || finding.priority === "P1") {
			if (
				finding.category === "security" ||
				finding.category === "concurrency" ||
				finding.category === "architecture"
			) {
				return true;
			}
		}
		if (finding.category === "security" || finding.category === "concurrency") return true;
		return false;
	}
}
