/**
 * Prefix contract for assembled subagent system prompts.
 *
 * Failure mode: task-specific context/peers/worktree splice into the shared
 * role/rules/completion prefix, so same-role siblings no longer share a
 * byte-stable provider prefix; or dynamic/schema/custom-prompt paths drop
 * handoff text, permissions, or the trailing environment block.
 */
import { describe, expect, test } from "bun:test";
import {
	assembleSubagentSystemPrompt,
	renderSubagentSystemPrompt,
} from "@oh-my-pi/pi-coding-agent/task/subagent-prompt";

const PERSONA = "You are the worker agent for mechanical implementation.";
const SCHEMA = {
	properties: {
		status: { enum: ["ok", "blocked"] },
		summary: { type: "string" },
	},
};

function sharedPrefix(left: string, right: string): string {
	const n = Math.min(left.length, right.length);
	let i = 0;
	while (i < n && left.charCodeAt(i) === right.charCodeAt(i)) i++;
	return left.slice(0, i);
}

describe("subagent system prompt prefix contract", () => {
	test("same-role workers with different context share rules/completion and still show each context", () => {
		const left = renderSubagentSystemPrompt({ agent: PERSONA, context: "EVIDENCE-ALPHA-CONFIRMED" });
		const right = renderSubagentSystemPrompt({ agent: PERSONA, context: "EVIDENCE-BETA-CONFIRMED" });
		const shared = sharedPrefix(left, right);

		expect(shared).toContain("§ Role");
		expect(shared).toContain(PERSONA);
		expect(shared).toContain("§ Coop");
		expect(shared).toContain("# Assignment Boundary");
		expect(shared).toContain("# Validation");
		expect(shared).toContain("§ Completion");
		expect(shared).toContain("Giving up is a last resort");
		expect(shared).not.toContain("EVIDENCE-ALPHA-CONFIRMED");
		expect(shared).not.toContain("EVIDENCE-BETA-CONFIRMED");

		expect(left).toContain("EVIDENCE-ALPHA-CONFIRMED");
		expect(right).toContain("EVIDENCE-BETA-CONFIRMED");
		expect(left.indexOf("EVIDENCE-ALPHA-CONFIRMED")).toBeGreaterThan(left.indexOf("§ Completion"));
		expect(right.indexOf("§ Context")).toBeGreaterThan(right.indexOf("§ Completion"));
	});

	test("same-role workers with different peers share the public prefix and keep both rosters", () => {
		const left = renderSubagentSystemPrompt({
			agent: PERSONA,
			ircSelfId: "WorkerA",
			ircPeers: "- `PeerLiveOne` — task (sub, running)",
		});
		const right = renderSubagentSystemPrompt({
			agent: PERSONA,
			ircSelfId: "WorkerB",
			ircPeers: "- `PeerLiveTwo` — task (sub, idle)",
		});
		const shared = sharedPrefix(left, right);

		expect(shared).toContain("§ Completion");
		expect(shared).toContain("# Validation");
		expect(shared).not.toContain("PeerLiveOne");
		expect(shared).not.toContain("PeerLiveTwo");
		expect(left).toContain("PeerLiveOne");
		expect(right).toContain("PeerLiveTwo");
		expect(left).toContain('status:"parked"');
		expect(left.indexOf("# Peers")).toBeGreaterThan(left.indexOf("§ Completion"));
	});

	test("toggling worktree does not rewrite the public prefix and still describes the tree", () => {
		const none = renderSubagentSystemPrompt({ agent: PERSONA });
		const isolated = renderSubagentSystemPrompt({
			agent: PERSONA,
			worktree: "/tmp/isolated-wt-prefix-contract",
		});
		const shared = sharedPrefix(none, isolated);

		expect(shared).toContain("# Validation");
		expect(shared).toContain(
			"NEVER run formatters, linters, or project-wide builds/test suites unless your assignment explicitly instructs it",
		);
		expect(shared).toContain("subject to the assignment's skip-validation instructions");
		expect(shared).toContain("§ Completion");
		expect(shared).not.toContain("/tmp/isolated-wt-prefix-contract");
		expect(none).not.toContain("isolated working tree");
		expect(isolated).toContain("/tmp/isolated-wt-prefix-contract");
		expect(isolated).toContain("You NEVER modify files outside this tree");
		expect(isolated.indexOf("# Working Tree")).toBeGreaterThan(isolated.indexOf("§ Completion"));
	});

	test("plan and schema stay after completion; caller override remains a distinct branch", () => {
		const base = renderSubagentSystemPrompt({ agent: PERSONA });
		const withPlan = renderSubagentSystemPrompt({
			agent: PERSONA,
			planReference: "PLAN-BODY-UNIQUE",
			planReferencePath: "docs/approved-plan.md",
		});
		const withSchema = renderSubagentSystemPrompt({
			agent: PERSONA,
			outputSchema: SCHEMA,
		});
		const withOverride = renderSubagentSystemPrompt({
			agent: PERSONA,
			outputSchema: SCHEMA,
			outputSchemaOverridesAgent: true,
		});

		expect(sharedPrefix(base, withPlan)).toContain("§ Completion");
		expect(withPlan).toContain("PLAN-BODY-UNIQUE");
		expect(withPlan).toContain("docs/approved-plan.md");
		expect(withPlan.indexOf("PLAN-BODY-UNIQUE")).toBeGreaterThan(withPlan.indexOf("§ Completion"));

		expect(sharedPrefix(base, withSchema)).toContain("Giving up is a last resort");
		expect(withSchema).toContain("```ts\nresult: {\n  data: {");
		expect(withSchema).not.toContain("if data is omitted, your last assistant turn becomes the raw final result");
		expect(withSchema).toContain('status: "ok" | "blocked"');
		expect(withSchema.indexOf("Host validation uses exactly this shape")).toBeGreaterThan(
			withSchema.indexOf("§ Completion"),
		);
		expect(base).not.toContain("Host validation uses exactly this shape");
		expect(base).not.toContain("result: {");

		expect(sharedPrefix(withSchema, withOverride)).toContain("For structured results");
		expect(withOverride).toContain("Caller schema overrides agent-native output instructions");
		expect(withSchema).not.toContain("Caller schema overrides agent-native output instructions");
	});

	test("empty context omits the context section without dropping permissions or yield rules", () => {
		const empty = renderSubagentSystemPrompt({ agent: PERSONA, context: "   " });
		expect(empty).not.toContain("§ Context");
		expect(empty).toContain("Explicit skip-validation instructions apply");
		expect(empty).not.toContain("You NEVER modify files outside this tree");
		expect(empty).toContain("Use `type: string` for a terminal result");
		expect(empty).toContain("You NEVER give up due to uncertainty");
	});

	test("worker, review, and explore keep distinct completion contracts", () => {
		const worker = renderSubagentSystemPrompt({ agent: PERSONA });
		const explore = renderSubagentSystemPrompt({ agent: PERSONA, exploreClass: true });
		const review = renderSubagentSystemPrompt({
			agent: "You are the reviewer.",
			reviewClass: true,
			outputSchema: SCHEMA,
		});

		expect(worker).toContain("that message is the result");
		expect(worker).toContain("Do not stop early because of turn count or elapsed time");
		expect(worker).toContain("Reuse confirmed key evidence");
		expect(explore).toContain("Write a compressed final assistant message");
		expect(explore).not.toContain("Do not stop early because of turn count or elapsed time");
		expect(review).toContain("A prose summary is not a passing review");
		expect(review).toContain("Judge from original materials");
		expect(review).not.toContain("Do not stop early because of turn count or elapsed time");
		expect(sharedPrefix(worker, review)).not.toContain("A prose summary is not a passing review");
	});

	test("custom empty default prompt is only the subagent block; otherwise last env block stays last", () => {
		const rendered = renderSubagentSystemPrompt({
			agent: PERSONA,
			context: "CTX-CUSTOM-PATH",
		});
		expect(assembleSubagentSystemPrompt([], { agent: PERSONA, context: "CTX-CUSTOM-PATH" })).toEqual([rendered]);

		const blocks = assembleSubagentSystemPrompt(["kernel-rules", "env-cwd-date"], {
			agent: PERSONA,
			context: "CTX-CUSTOM-PATH",
		});
		expect(blocks[0]).toBe("kernel-rules");
		expect(blocks[2]).toBe("env-cwd-date");
		expect(blocks[1]).toBe(rendered);
		const single = assembleSubagentSystemPrompt(["only-env"], { agent: PERSONA });
		expect(single[0]).toBe(renderSubagentSystemPrompt({ agent: PERSONA }));
		expect(single[1]).toBe("only-env");
	});
});
