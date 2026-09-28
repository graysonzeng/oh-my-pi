import { describe, expect, it } from "bun:test";
import {
	attributeSubagentError,
	isTerminalSubagentCredentialFailure,
	shouldKeepAliveSubagent,
} from "@oh-my-pi/pi-coding-agent/task/error-attribution";

describe("attributeSubagentError", () => {
	it("prefixes provider/model so misrouted subagent failures name their transport", () => {
		expect(
			attributeSubagentError("Connect error invalid_argument: Error", {
				provider: "cursor",
				model: "cursor/default",
			}),
		).toBe("[cursor/cursor/default] Connect error invalid_argument: Error");
	});

	it("uses the fallback text when the message is empty", () => {
		expect(attributeSubagentError(undefined, { provider: "anthropic", model: "claude-sonnet-4-5" })).toBe(
			"[anthropic/claude-sonnet-4-5] Subagent failed",
		);
		expect(attributeSubagentError("   ", undefined)).toBe("Subagent failed");
	});

	it("preserves the provider's original error text", () => {
		expect(attributeSubagentError("  first line\nsecond line  ", undefined)).toBe("  first line\nsecond line  ");
	});

	it("returns the bare message when no identity is known", () => {
		expect(attributeSubagentError("boom", undefined)).toBe("boom");
		expect(attributeSubagentError("boom", {})).toBe("boom");
	});

	it("skips the prefix when the message already names the provider", () => {
		expect(
			attributeSubagentError("Cursor stream ended before turnEnded", { provider: "cursor", model: "gpt-5" }),
		).toBe("Cursor stream ended before turnEnded");
	});

	it("attributes with a partial identity", () => {
		expect(attributeSubagentError("boom", { model: "gpt-5" })).toBe("[gpt-5] boom");
		expect(attributeSubagentError("boom", { provider: "openai" })).toBe("[openai] boom");
	});
});

describe("isTerminalSubagentCredentialFailure", () => {
	it("treats auth_unavailable and prepaid billing as dead children", () => {
		expect(
			isTerminalSubagentCredentialFailure(
				"503 auth_unavailable: no auth available (providers=xai, model=grok-4.7; last upstream error: You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok. [WKE=personal-team-blocked:spending-limit]) retry-after-ms=1683000",
			),
		).toBe(true);
		expect(isTerminalSubagentCredentialFailure("503 auth_unavailable: no auth available")).toBe(true);
		expect(isTerminalSubagentCredentialFailure("HTTP 402 Payment Required")).toBe(true);
	});

	it("does not treat a resettable rate limit as a dead child", () => {
		expect(isTerminalSubagentCredentialFailure("429 too many requests. retry-after-ms=2000")).toBe(false);
		expect(isTerminalSubagentCredentialFailure(undefined)).toBe(false);
	});

	it("drops keep-alive when the child cannot take another turn", () => {
		expect(
			shouldKeepAliveSubagent({
				requestedKeepAlive: true,
				errorMessage: "503 auth_unavailable: no auth available",
			}),
		).toBe(false);
		expect(shouldKeepAliveSubagent({ requestedKeepAlive: true, errorMessage: undefined })).toBe(true);
		expect(
			shouldKeepAliveSubagent({
				requestedKeepAlive: false,
				errorMessage: undefined,
			}),
		).toBe(false);
	});
});
