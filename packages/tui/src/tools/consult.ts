import { Text } from "../components/text";
import type { Component } from "../tui";
import type { Theme } from "../theme/theme";
import { framedToolCard } from "../render/tool-card";
import { renderStatusLine } from "../render/status-line";
import {
	formatErrorDetail,
	formatExpandHint,
	PREVIEW_LIMITS,
	replaceTabs,
	truncateToWidth,
} from "../render/render-utils";
import type { RenderResultOptions, ToolRenderer } from "./renderer";

/** Arguments shown on a pending consult call. */
export interface ConsultRenderArgs {
	focus?: string;
}

/** Result fields the transcript card reads. The tool owns the full details type. */
export interface ConsultRenderDetails {
	model?: string;
	tokensOut?: number;
	truncated?: boolean;
	error?: string;
}

const FOCUS_PREVIEW_WIDTH = 100;
const OUTPUT_LINE_WIDTH = 120;
const RAW_OUTPUT_ARTIFACT_FOOTER_RE = /\[raw output: artifact:\/\/([^\]]+)\]\s*$/;

function focusLine(focus: string, uiTheme: Theme): string {
	return `${uiTheme.fg("dim", "Focus:")} ${uiTheme.fg("accent", truncateToWidth(replaceTabs(focus), FOCUS_PREVIEW_WIDTH))}`;
}

/** Keep the recovery footer out of the collapsed body so expansion can still show it. */
function extractRawOutputFooter(text: string): { body: string; footer?: string } {
	const match = text.match(RAW_OUTPUT_ARTIFACT_FOOTER_RE);
	if (!match || match.index === undefined) return { body: text };
	return {
		body: text.slice(0, match.index).replace(/\n$/, ""),
		footer: match[0].trimEnd(),
	};
}

/** Transcript renderer for `consult`. */
export const consultToolRenderer = {
	mergeCallAndResult: true,
	renderCall(args: ConsultRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const header = renderStatusLine({ icon: "pending", title: "Consult", description: "waiting" }, uiTheme);
		const focus = typeof args.focus === "string" ? args.focus.trim() : "";
		if (!focus) return new Text(header, 0, 0);
		const tree = ` ${uiTheme.fg("dim", uiTheme.tree.last)} ${focusLine(focus, uiTheme)}`;
		return new Text(`${header}\n${tree}`, 0, 0);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ConsultRenderDetails; isError?: boolean },
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

		return framedToolCard(uiTheme, ({ contentWidth }) => {
			const lineWidth = Math.min(OUTPUT_LINE_WIDTH, contentWidth);
			if (result.isError) {
				const bodyLines: string[] = [];
				if (focus) bodyLines.push(focusLine(focus, uiTheme));
				bodyLines.push(formatErrorDetail(outputText || details?.error || "consult failed", uiTheme));
				return {
					header,
					phase: "error",
					borderColor: "error",
					applyBg: false,
					sections: [{ content: bodyLines }],
				};
			}

			const metaParts: string[] = [];
			if (details?.model) metaParts.push(details.model);
			if (typeof details?.tokensOut === "number") metaParts.push(`${details.tokensOut} tok out`);
			if (details?.truncated) metaParts.push("truncated");
			const metaLine = metaParts.length > 0 ? uiTheme.fg("dim", metaParts.join(" · ")) : "";
			if (!outputText) {
				return {
					header,
					headerMeta: metaLine || undefined,
					phase: "success",
					borderColor: "borderMuted",
					applyBg: false,
				};
			}

			const bodyLines: string[] = [];
			if (focus) {
				bodyLines.push(focusLine(focus, uiTheme));
				bodyLines.push("");
			}
			const { body, footer } = extractRawOutputFooter(outputText);
			const outputLines = body.length > 0 ? replaceTabs(body).split("\n") : [];
			const maxLines = options.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
			for (const line of outputLines.slice(0, maxLines)) {
				bodyLines.push(uiTheme.fg("toolOutput", truncateToWidth(line, lineWidth)));
			}
			if (outputLines.length > maxLines) {
				const remaining = outputLines.length - maxLines;
				const hint = formatExpandHint(uiTheme, options.expanded, true);
				bodyLines.push(`${uiTheme.fg("dim", `… ${remaining} more lines`)}${hint ? ` ${hint}` : ""}`);
			} else if (footer && !options.expanded) {
				bodyLines.push(formatExpandHint(uiTheme, false, true));
			}
			const sections: Array<{ content: string[]; separator?: boolean }> = [{ content: bodyLines }];
			if (footer && options.expanded) {
				sections.push({
					separator: true,
					content: [uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(footer), lineWidth))],
				});
			}
			return {
				header,
				headerMeta: metaLine || undefined,
				phase: "success",
				borderColor: "borderMuted",
				applyBg: false,
				sections,
			};
		});
	},
} satisfies ToolRenderer<ConsultRenderArgs, ConsultRenderDetails>;
