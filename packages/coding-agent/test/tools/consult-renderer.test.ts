import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { consultToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/consult-renderer";
import { PREVIEW_LIMITS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";

const ARTIFACT_URI = "artifact://88421";
const RECOVERY_FOOTER = `[raw output: ${ARTIFACT_URI}]`;

beforeAll(async () => {
	await initTheme();
});

async function uiTheme() {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	return theme!;
}

function bodyLine(index: number): string {
	return `consult-line#${index}#`;
}

function oversizedConsultOutput(bodyCount: number): string {
	const body = Array.from({ length: bodyCount }, (_, i) => bodyLine(i + 1)).join("\n");
	return `${body}\n${RECOVERY_FOOTER}`;
}

function renderConsult(text: string, expanded: boolean, theme: Theme): string {
	return sanitizeText(
		consultToolRenderer
			.renderResult(
				{
					content: [{ type: "text", text }],
					details: { model: "gpt-5.4", tokensOut: 48, truncated: true },
				},
				{ expanded, isPartial: false },
				theme,
				{ focus: "lock the recovery path" },
			)
			.render(200)
			.join("\n"),
	);
}

describe("consultToolRenderer recovery footer", () => {
	it("keeps the artifact URI in the expanded view after capping the body", async () => {
		const theme = await uiTheme();
		const bodyCount = PREVIEW_LIMITS.OUTPUT_EXPANDED + 5;
		const rendered = renderConsult(oversizedConsultOutput(bodyCount), true, theme);

		expect(rendered).toContain(ARTIFACT_URI);
		expect(rendered).toContain(bodyLine(1));
		expect(rendered).toContain(bodyLine(PREVIEW_LIMITS.OUTPUT_EXPANDED));
		expect(rendered).not.toContain(bodyLine(PREVIEW_LIMITS.OUTPUT_EXPANDED + 1));
		expect(rendered).not.toContain(bodyLine(bodyCount));
		expect(rendered).toContain(`${bodyCount - PREVIEW_LIMITS.OUTPUT_EXPANDED} more lines`);
		expect(rendered).not.toContain("Expand");
	});

	it("hides the recovery footer in the collapsed view and still offers expand", async () => {
		const theme = await uiTheme();
		const bodyCount = PREVIEW_LIMITS.OUTPUT_EXPANDED + 5;
		const rendered = renderConsult(oversizedConsultOutput(bodyCount), false, theme);

		expect(rendered).toContain("Expand");
		expect(rendered).toContain(bodyLine(1));
		expect(rendered).toContain(bodyLine(PREVIEW_LIMITS.OUTPUT_COLLAPSED));
		expect(rendered).not.toContain(bodyLine(PREVIEW_LIMITS.OUTPUT_COLLAPSED + 1));
		expect(rendered).not.toContain(ARTIFACT_URI);
		expect(rendered).not.toContain(RECOVERY_FOOTER);
	});

	it("still surfaces a sanitized footer when the expanded body fits the line cap", async () => {
		const theme = await uiTheme();
		const rendered = renderConsult(`${bodyLine(1)}\n${RECOVERY_FOOTER}`, true, theme);

		expect(rendered).toContain(bodyLine(1));
		expect(rendered).toContain(ARTIFACT_URI);
		expect(rendered).not.toContain("more lines");
	});
});
