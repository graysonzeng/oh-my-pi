import { Text } from "../components/text";
import type { Component } from "../tui";
import type { Theme } from "../theme/theme";
import {
	createCachedComponent,
	Ellipsis,
	formatCount,
	formatErrorMessage,
	renderStatusLine,
	replaceTabs,
	shortenPath,
	truncateToWidth,
} from "../render";
import type { RenderResultOptions, ToolRenderer } from "./renderer";

/** Arguments shown on a pending code_intel call. */
export interface CodeIntelRenderArgs {
	query?: string;
	depth?: string;
	path?: string;
}

/** Result fields the transcript card reads. The tool owns the full details type. */
export interface CodeIntelRenderDetails {
	error?: string;
	found?: boolean;
	coverage?: string;
	evidenceCount?: number;
	confidence?: string;
}

/** Transcript renderer for `code_intel`. */
export const codeIntelToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: CodeIntelRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.depth) meta.push(`depth:${args.depth}`);
		if (args.path) meta.push(replaceTabs(shortenPath(args.path)));
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Code Intel",
				titleColor: "toolTitle",
				description: replaceTabs(args.query || "?"),
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: CodeIntelRenderDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: CodeIntelRenderArgs,
	): Component {
		if (result.isError || result.details?.error) {
			return new Text(formatErrorMessage(result.details?.error, uiTheme), 1, 0);
		}
		const details = result.details;
		const body = replaceTabs(result.content?.find(block => block.type === "text")?.text ?? "");
		const meta = [
			details?.coverage ?? "focused",
			formatCount("evidence", details?.evidenceCount ?? 0),
			details?.confidence ?? "low",
		];
		if (args?.path) meta.push(replaceTabs(shortenPath(args.path)));
		const header = renderStatusLine(
			{
				icon: details?.found ? "success" : "warning",
				title: "Code Intel",
				titleColor: "toolTitle",
				description: args?.query ? replaceTabs(args.query) : undefined,
				meta,
			},
			uiTheme,
		);
		return createCachedComponent(
			() => options.expanded,
			width => {
				const lines = options.expanded ? body.split("\n") : body.split("\n").slice(0, 6);
				return [header, ...lines.map(line => uiTheme.fg("toolOutput", line))].map(line =>
					truncateToWidth(line, width, Ellipsis.Omit),
				);
			},
			{ paddingX: 1 },
		);
	},
} satisfies ToolRenderer<CodeIntelRenderArgs, CodeIntelRenderDetails>;
