import type { ReviewFindingV1 } from "./types";

export class FindingTracker {
	private findings: Map<string, ReviewFindingV1> = new Map();

	add(finding: ReviewFindingV1) {
		this.findings.set(finding.id, finding);
	}

	getAll(): ReviewFindingV1[] {
		return Array.from(this.findings.values());
	}

	getById(id: string): ReviewFindingV1 | null {
		return this.findings.get(id) || null;
	}

	resolve(id: string, status: "resolved" | "rejected") {
		const f = this.findings.get(id);
		if (f) f.status = status;
	}

	// escalation for repeated findings
	hasRepeated(_fingerprint: string): boolean {
		return false; // simplified
	}
}
