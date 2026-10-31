import type { PipelineGateIntent, PipelineGateSubject, PipelineGateVerdict } from "./overlay";

/** Map a stamped Gate verdict + subject onto engine intent. Pure; no I/O. */
export function gateAdapter(verdict: PipelineGateVerdict, subject: PipelineGateSubject): PipelineGateIntent {
	switch (verdict) {
		case "PASS":
		case "PASS_WITH_NOTES":
			return "approve";
		case "NEEDS_REVISION":
			return "replan_counted";
		case "NEEDS_REDESIGN":
			return subject === "plan" ? "replan_exempt" : "block";
		default:
			return "block";
	}
}
