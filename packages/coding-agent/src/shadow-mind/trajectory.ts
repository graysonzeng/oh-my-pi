export function serializeTrajectory(messages: readonly { role?: string; content?: unknown }[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			appendText(lines, "USER", message.content);
			continue;
		}
		if (message.role === "assistant") {
			if (!Array.isArray(message.content)) {
				appendText(lines, "REVIEWER", message.content);
				continue;
			}
			for (const block of message.content) {
				if (!block || typeof block !== "object" || isThinkingBlock(block)) continue;
				const item = block as { type?: string; text?: string; name?: string; arguments?: unknown };
				if (item.type === "text" && item.text) lines.push(`REVIEWER: ${item.text}`);
				if (item.type === "toolCall" && item.name) {
					lines.push(`TOOL: ${item.name}(${compactJson(item.arguments)})`);
				}
			}
		}
	}
	return `<reviewer-trajectory>\n${lines.join("\n")}\n</reviewer-trajectory>`;
}

function isThinkingBlock(value: unknown): boolean {
	return Boolean(value) && typeof value === "object" && (value as { type?: string }).type === "thinking";
}

function appendText(lines: string[], label: string, content: unknown): void {
	const text = extractText(content);
	if (text) lines.push(`${label}: ${text}`);
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type?: string; text?: string } => Boolean(item) && typeof item === "object")
		.filter(item => item.type === "text" && typeof item.text === "string")
		.map(item => item.text)
		.join("\n");
}

function compactJson(value: unknown): string {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}
