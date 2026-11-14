import { describe, expect, it } from "bun:test";
import {
	diagnoseRuleSources,
	formatRuleDiscoveryWarnings,
	formatRuleSourceDiagnosis,
} from "../../src/capability/rule-source-diagnosis";

describe("rule source diagnosis (D5)", () => {
	it("explains same-name first-wins shadowing without changing priority", () => {
		const winner = {
			name: "shared",
			_source: { provider: "project", providerName: "Project", path: "/proj/AGENTS.md" },
		};
		const shadowed = {
			name: "shared",
			_shadowed: true as const,
			_source: { provider: "user", providerName: "User", path: "/home/u/AGENTS.md" },
		};
		const rows = diagnoseRuleSources({ items: [winner], all: [winner, shadowed] });
		expect(rows.some(r => r.status === "winner" && r.path === "/proj/AGENTS.md")).toBe(true);
		const shadow = rows.find(r => r.status === "shadowed");
		expect(shadow?.reason).toContain("first-wins");
		expect(formatRuleSourceDiagnosis(rows)).toContain("shadowed");
	});

	it("marks disabledNames without dumping rule bodies", () => {
		const rows = diagnoseRuleSources({
			items: [],
			all: [{ name: "noisy", _source: { provider: "x", path: "/x.md" } }],
			disabledNames: ["noisy"],
		});
		expect(rows[0]!.status).toBe("disabled");
		expect(formatRuleSourceDiagnosis(rows)).not.toContain("MUST NEVER");
	});

	it("formats discovery warnings once with a count and without inventing coverage", () => {
		expect(formatRuleDiscoveryWarnings([])).toBeUndefined();
		const line = formatRuleDiscoveryWarnings(["[Project] bad frontmatter", "[User] missing applyTo"]);
		expect(line).toContain("Rule discovery warnings (2)");
		expect(line).toContain("bad frontmatter");
	});

	it("suppresses builtin-defaults when builtinRules is false", () => {
		const builtin = {
			name: "default-safety",
			_source: { provider: "builtin-defaults", providerName: "Builtin", path: "builtin:default-safety" },
		};
		const rows = diagnoseRuleSources({ items: [builtin], all: [builtin], builtinRules: false });
		expect(rows[0]!.status).toBe("suppressed");
		expect(rows[0]!.reason).toBe("builtinRules:false");
	});

	it("suppresses agent-scoped rules that do not match agentName", () => {
		const scoped = {
			name: "reviewer-only",
			agents: ["reviewer"],
			_source: { provider: "project", path: "/proj/review.md" },
		};
		const rows = diagnoseRuleSources({ items: [scoped], all: [scoped], agentName: "main" });
		expect(rows[0]!.status).toBe("suppressed");
		expect(rows[0]!.reason).toContain("agents scope");
	});
});
