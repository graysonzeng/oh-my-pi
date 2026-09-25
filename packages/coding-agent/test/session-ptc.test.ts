import { describe, expect, test } from "bun:test";
import { EVAL_AGENT_BRIDGE_NAME } from "../src/eval/agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME } from "../src/eval/budget-bridge";
import { EVAL_CATALOG_DESCRIBE_BRIDGE_NAME, EVAL_CATALOG_SEARCH_BRIDGE_NAME } from "../src/eval/catalog-bridge";
import { EVAL_COMPLETION_BRIDGE_NAME } from "../src/eval/completion-bridge";
import { EVAL_CANCEL_BRIDGE_NAME, EVAL_STATUS_BRIDGE_NAME, EVAL_WAIT_BRIDGE_NAME } from "../src/eval/handle-bridge";
import { EVAL_WORKPOOL_BRIDGE_NAME } from "../src/eval/workpool-bridge";
import { resolvePtc } from "../src/session/ptc";

const ENABLED = [
	"eval",
	"ask",
	"todo",
	"yield",
	"think",
	"checkpoint",
	"rewind",
	"new_context",
	"read",
	"bash",
	"edit",
	"mcp__gmail_search",
];

describe("resolvePtc", () => {
	test("tools.ptc.mode on activates for a non-Codex provider when JS eval is available", () => {
		const r = resolvePtc({
			provider: "anthropic",
			ptcMode: "on",
			codexMode: "off",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(r.active).toBe(true);
		expect(r.effectiveMode).toBe("on");
		expect(r.degradedReason).toBeUndefined();
		expect(r.directToolNames.has("eval")).toBe(true);
		expect(r.directToolNames.has("new_context")).toBe(true);
		expect(r.directToolNames.has("read")).toBe(false);
		expect(r.codexNamespaces).toBe(false);
	});

	test("tools.ptc.mode off keeps the Codex auto path for code_mode_only models", () => {
		const r = resolvePtc({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			ptcMode: "off",
			codexMode: "auto",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(r.active).toBe(true);
		expect(r.codexNamespaces).toBe(true);
		expect([...r.directToolNames].sort()).toEqual([
			"ask",
			"checkpoint",
			"eval",
			"new_context",
			"rewind",
			"think",
			"todo",
			"yield",
		]);
	});

	test("auto stays inactive without a catalog preference even when JS eval is available", () => {
		expect(
			resolvePtc({
				provider: "anthropic",
				ptcMode: "auto",
				codexMode: "off",
				enabledToolNames: ENABLED,
				evalTransportAvailable: true,
			}).active,
		).toBe(false);
	});

	test("auto follows code_mode_only for any provider", () => {
		const r = resolvePtc({
			provider: "openai",
			toolMode: "code_mode_only",
			ptcMode: "auto",
			codexMode: "off",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(r.active).toBe(true);
		expect(r.codexNamespaces).toBe(false);
	});

	test("on degrades to the full direct surface when JS eval is unavailable", () => {
		const r = resolvePtc({
			provider: "anthropic",
			ptcMode: "on",
			codexMode: "off",
			enabledToolNames: ENABLED,
			evalTransportAvailable: false,
		});
		expect(r.active).toBe(false);
		expect(r.degradedReason).toBe("eval-js-unavailable");
		expect(r.directToolNames).toEqual(new Set(ENABLED));
	});

	test("on degrades when eval is not in the enabled set", () => {
		const r = resolvePtc({
			provider: "anthropic",
			ptcMode: "on",
			codexMode: "off",
			enabledToolNames: ["read", "bash"],
			evalTransportAvailable: true,
		});
		expect(r.active).toBe(false);
		expect(r.degradedReason).toBe("eval-unavailable");
	});

	test("generic extra direct tools do not receive Codex extras on a non-Codex provider", () => {
		const r = resolvePtc({
			provider: "anthropic",
			ptcMode: "on",
			codexMode: "off",
			extraDirectTools: ["read"],
			codexExtraDirectTools: ["bash", "missing"],
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(r.directToolNames.has("read")).toBe(true);
		expect(r.directToolNames.has("bash")).toBe(false);
		expect(r.codexNamespaces).toBe(false);
	});

	test("Codex extras apply only for openai-codex", () => {
		const r = resolvePtc({
			provider: "openai-codex",
			ptcMode: "on",
			codexMode: "off",
			extraDirectTools: ["read"],
			codexExtraDirectTools: ["bash"],
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(r.directToolNames.has("read")).toBe(true);
		expect(r.directToolNames.has("bash")).toBe(true);
		expect(r.codexNamespaces).toBe(true);
	});

	test("reserved eval bridge names stay direct", () => {
		const reserved = [
			EVAL_AGENT_BRIDGE_NAME,
			EVAL_BUDGET_BRIDGE_NAME,
			EVAL_COMPLETION_BRIDGE_NAME,
			EVAL_WAIT_BRIDGE_NAME,
			EVAL_STATUS_BRIDGE_NAME,
			EVAL_CANCEL_BRIDGE_NAME,
			EVAL_WORKPOOL_BRIDGE_NAME,
			EVAL_CATALOG_SEARCH_BRIDGE_NAME,
			EVAL_CATALOG_DESCRIBE_BRIDGE_NAME,
		];
		const r = resolvePtc({
			provider: "anthropic",
			ptcMode: "on",
			codexMode: "off",
			enabledToolNames: ["eval", "read", ...reserved],
			evalTransportAvailable: true,
		});
		expect([...r.directToolNames]).toEqual(["eval", ...reserved]);
	});

	test("Codex codeMode on does not activate for a non-Codex provider", () => {
		expect(
			resolvePtc({
				provider: "anthropic",
				ptcMode: "off",
				codexMode: "on",
				enabledToolNames: ENABLED,
				evalTransportAvailable: true,
			}).active,
		).toBe(false);
	});
});
