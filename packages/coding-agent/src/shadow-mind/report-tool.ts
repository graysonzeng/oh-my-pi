import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "../extensibility/custom-tools/types";

const reportParams = type({ content: "string" });

export interface ReportToMainState {
	reported: boolean;
	content?: string;
	abort?: () => void;
}

export function createReportToMainTool(state: ReportToMainState): CustomTool<typeof reportParams> {
	return {
		name: "report_to_main",
		label: "Report to Main",
		description:
			"Report a concrete finding or completed result to the reviewer and immediately end this Shadow Mind run.",
		parameters: reportParams,
		approval: "read",
		async execute(_toolCallId, params) {
			if (!state.reported) {
				state.reported = true;
				state.content = params.content;
				queueMicrotask(() => state.abort?.());
			}
			return { content: [{ type: "text", text: "Report delivered." }], details: {} };
		},
	};
}
