import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { TodoPhase } from "../tools/todo";
import type { Goal } from "./state";

/** Shipped test/lint/typecheck invocations — not the bare word "test". */
export const VERIFICATION_COMMAND_RE =
	/(?:^|[;&|\n]|&&|\|\|)\s*(?:bun\s+(?:run\s+)?(?:test|check)|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|lint|typecheck)|cargo\s+test|pytest|python\s+-m\s+pytest|go\s+test)\b/i;

export const COMPLETION_CLAIM_RE =
	/\b(?:completed|done|fixed|shipped)\b|all green|ready to merge|测试通过|已完成|全部完成/i;

export type GoalSettleToolRecord = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	resultText: string;
	isError: boolean;
	unpaired: boolean;
};

export type GoalNominationOutcome = "none" | "nominated" | "rejected" | "accepted" | "stale";

export type GoalCompletionSettleSnapshot = {
	turnId: string;
	generation: number;
	assistantText: string;
	stopReason: string;
	tools: GoalSettleToolRecord[];
	goalId: string;
	goalRevision: number;
	nomination: {
		outcome: GoalNominationOutcome;
		nominationId?: string;
	};
	todos: Array<{ phase: string; content: string; status: string }>;
	messages: AgentMessage[];
};

export type GoalHostGateDecision = {
	decision: "continue" | "pass";
	reasons: string[];
	nextStep: string;
};

export function commandLooksLikeVerification(command: string): boolean {
	return VERIFICATION_COMMAND_RE.test(command);
}

export function textLooksLikeCompletionClaim(text: string): boolean {
	return COMPLETION_CLAIM_RE.test(text);
}

export function toolInvocationText(record: GoalSettleToolRecord): string {
	if (record.name === "bash") {
		return typeof record.args.command === "string" ? record.args.command : "";
	}
	if (record.name === "eval") {
		return typeof record.args.code === "string" ? record.args.code : "";
	}
	return "";
}

export function hasSuccessfulVerification(snapshot: GoalCompletionSettleSnapshot): boolean {
	return snapshot.tools.some(
		record =>
			!record.unpaired &&
			!record.isError &&
			(record.name === "bash" || record.name === "eval") &&
			commandLooksLikeVerification(toolInvocationText(record)),
	);
}

export function hasOpenTodos(snapshot: GoalCompletionSettleSnapshot): boolean {
	return snapshot.todos.some(todo => todo.status === "pending" || todo.status === "in_progress");
}

export function hasUnpairedTools(snapshot: GoalCompletionSettleSnapshot): boolean {
	return snapshot.tools.some(record => record.unpaired);
}

export function flattenTodoSnapshot(phases: TodoPhase[] | undefined): GoalCompletionSettleSnapshot["todos"] {
	const todos: GoalCompletionSettleSnapshot["todos"] = [];
	for (const phase of phases ?? []) {
		for (const task of phase.tasks) {
			todos.push({ phase: phase.name, content: task.content, status: task.status });
		}
	}
	return todos;
}

export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("")
		.trim();
}

export function settleTurnMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") return messages.slice(index);
	}
	return [...messages];
}

export function nominationOutcomeForTurn(
	goal: Pick<Goal, "hostGate">,
	turnId: string,
	generation?: number,
): GoalNominationOutcome {
	const gate = goal.hostGate;
	if (!gate) return "none";
	if (gate.pendingVerification) return "nominated";
	if (!gate.turnId || gate.turnId !== turnId) return "none";
	if (generation !== undefined && gate.generation !== undefined && gate.generation !== generation) {
		return "none";
	}
	if (gate.lastDecision === "candidate_complete" || gate.lastDecision === "user_confirmed") {
		return "accepted";
	}
	if (gate.lastDecision === "continue" || gate.lastDecision === "blocked") return "rejected";
	return "none";
}

function resultText(result: ToolResultMessage | undefined): { text: string; isError: boolean; unpaired: boolean } {
	if (!result) return { text: "", isError: false, unpaired: true };
	const text = result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
	return { text, isError: result.isError === true, unpaired: false };
}

export function buildGoalCompletionSettleSnapshot(input: {
	turnId: string;
	generation: number;
	assistant: AssistantMessage;
	messages: readonly AgentMessage[];
	todos: TodoPhase[] | undefined;
	goal: Pick<Goal, "id" | "hostGate">;
	nominationOutcome?: GoalNominationOutcome;
	excludeToolCallIds?: Iterable<string>;
}): GoalCompletionSettleSnapshot {
	const settleMessages = settleTurnMessages(input.messages);
	const excludeToolCallIds = new Set(input.excludeToolCallIds ?? []);
	const resultsById = new Map<string, ToolResultMessage>();
	for (const message of settleMessages) {
		if (message.role !== "toolResult") continue;
		resultsById.set(message.toolCallId, message);
	}

	const tools: GoalSettleToolRecord[] = [];
	const seen = new Set<string>();
	for (const message of settleMessages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const call = block as ToolCall;
			if (seen.has(call.id)) continue;
			seen.add(call.id);
			const result = resultsById.get(call.id);
			const resolved = resultText(result);
			if (excludeToolCallIds.has(call.id)) continue;
			const op = call.arguments && typeof call.arguments === "object" ? call.arguments.op : undefined;
			if (call.name === "goal" && op === "complete" && resolved.unpaired) continue;
			tools.push({
				id: call.id,
				name: call.name,
				args: call.arguments ?? {},
				resultText: resolved.text,
				isError: resolved.isError,
				unpaired: resolved.unpaired,
			});
		}
	}

	return {
		turnId: input.turnId,
		generation: input.generation,
		assistantText: extractAssistantText(input.assistant),
		stopReason: input.assistant.stopReason,
		tools,
		goalId: input.goal.id,
		goalRevision: input.goal.hostGate?.goalRevision ?? 0,
		nomination: {
			outcome: input.nominationOutcome ?? nominationOutcomeForTurn(input.goal, input.turnId, input.generation),
			nominationId: input.goal.hostGate?.nominationId,
		},
		todos: flattenTodoSnapshot(input.todos),
		messages: settleMessages,
	};
}

export function evaluateGoalHostGate(snapshot: GoalCompletionSettleSnapshot): GoalHostGateDecision {
	const reasons: string[] = [];
	if (hasUnpairedTools(snapshot)) {
		reasons.push("unpaired_tools");
	}
	if (hasOpenTodos(snapshot)) {
		reasons.push("open_todos");
	}
	if (!hasSuccessfulVerification(snapshot)) {
		reasons.push("missing_verification");
	}
	if (reasons.length === 0) {
		return {
			decision: "pass",
			reasons,
			nextStep: "Host checks passed. Ask the user to confirm with /goal complete.",
		};
	}
	const nextStep = reasons.includes("open_todos")
		? "Close or rewrite open todos against current repo evidence, then verify the shipped path."
		: reasons.includes("unpaired_tools")
			? "Finish in-flight tool calls before nominating complete."
			: "Run the shipped test/lint path and keep working from current repo evidence.";
	return { decision: "continue", reasons, nextStep };
}

export function looksLikeFalseCompletion(snapshot: GoalCompletionSettleSnapshot): boolean {
	if (snapshot.nomination.outcome !== "none") return false;
	if (snapshot.tools.some(record => record.name === "goal" && record.args.op === "complete")) {
		return false;
	}
	if (snapshot.stopReason === "error" || snapshot.stopReason === "aborted") return false;
	if (!textLooksLikeCompletionClaim(snapshot.assistantText)) return false;
	return hasOpenTodos(snapshot) || !hasSuccessfulVerification(snapshot);
}

export function falseCompletionNextStep(snapshot: GoalCompletionSettleSnapshot): string {
	if (hasOpenTodos(snapshot)) {
		const open = snapshot.todos.find(todo => todo.status === "pending" || todo.status === "in_progress");
		return open
			? `Continue the open todo "${open.content}". Do not claim completion.`
			: "Close open todos against current evidence. Do not claim completion.";
	}
	return "Run the shipped test/lint path against current repo evidence. Do not claim completion.";
}
