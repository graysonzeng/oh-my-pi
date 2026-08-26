import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { framedBlock, renderStatusLine } from "../tui";
import type { ConsultDetails } from "./consult-state";
import { formatErrorDetail, formatExpandHint, PREVIEW_LIMITS, replaceTabs, truncateToWidth } from "./render-utils";

interface ConsultRenderArgs {
	focus?: string;
}

interface ConsultRendererResult {
	content: Array<{ type: string; text?: string }>;
	details?: ConsultDetails;
	isError?: boolean;
}

const FOCUS_PREVIEW_WIDTH = 100;
const OUTPUT_LINE_WIDTH = 120;

function focusLine(focus: string, uiTheme: Theme): string {
	return `${uiTheme.fg("dim", "Focus:")} ${uiTheme.fg("accent", truncateToWidth(replaceTabs(focus), FOCUS_PREVIEW_WIDTH))}`;
}

export const consultToolRenderer = {
	renderCall(args: ConsultRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const header = renderStatusLine({ icon: "pending", title: "Consult", description: "waiting" }, uiTheme);
		const focus = typeof args.focus === "string" ? args.focus.trim() : "";
		if (!focus) return new Text(header, 0, 0);
		const tree = ` ${uiTheme.fg("dim", uiTheme.tree.last)} ${focusLine(focus, uiTheme)}`;
		return new Text(`${header}\n${tree}`, 0, 0);
	},

	renderResult(
		result: ConsultRendererResult,
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: ConsultRenderArgs,
	): Component {
		const details = result.details;
		const success = !result.isError;
		const header = renderStatusLine(
			success
				? {
						icon: "success",
						title: "Consult",
						description: details?.model ?? "",
					}
				: {
						icon: "error",
						title: "Consult",
						description: details?.error ?? "error",
					},
			uiTheme,
		);
		const focus = typeof args?.focus === "string" ? args.focus.trim() : "";
		const outputText = result.content.find(content => content.type === "text")?.text?.trimEnd() ?? "";

		if (result.isError) {
			return framedBlock(uiTheme, width => {
				const bodyLines: string[] = [];
				if (focus) bodyLines.push(focusLine(focus, uiTheme));
				bodyLines.push(formatErrorDetail(outputText || details?.error || "consult failed", uiTheme));
				return {
					header,
					sections: [{ lines: bodyLines }],
					state: "error",
					borderColor: "error",
					applyBg: false,
					width,
				};
			});
		}

		const metaParts: string[] = [];
		if (details?.model) metaParts.push(details.model);
		if (typeof details?.tokensOut === "number") metaParts.push(`${details.tokensOut} tok out`);
		if (details?.truncated) metaParts.push("truncated");
		const metaLine = metaParts.length > 0 ? uiTheme.fg("dim", metaParts.join(" · ")) : "";

		if (!outputText) {
			return new Text(metaLine ? `${header}\n${metaLine}` : header, 0, 0);
		}

		return framedBlock(uiTheme, width => {
			const bodyLines: string[] = [];
			if (focus) {
				bodyLines.push(focusLine(focus, uiTheme));
				bodyLines.push("");
			}
			const outputLines = replaceTabs(outputText).split("\n");
			const maxLines = options.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
			for (const line of outputLines.slice(0, maxLines)) {
				bodyLines.push(uiTheme.fg("toolOutput", truncateToWidth(line, OUTPUT_LINE_WIDTH)));
			}
			if (outputLines.length > maxLines) {
				const remaining = outputLines.length - maxLines;
				const hint = formatExpandHint(uiTheme, options.expanded, true);
				bodyLines.push(`${uiTheme.fg("dim", `… ${remaining} more lines`)}${hint ? ` ${hint}` : ""}`);
			}
			return {
				header,
				headerMeta: metaLine || undefined,
				sections: [{ lines: bodyLines }],
				state: "success",
				borderColor: "borderMuted",
				applyBg: false,
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
