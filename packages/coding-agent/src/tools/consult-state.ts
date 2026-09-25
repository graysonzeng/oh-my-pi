import type { ToolSession } from "./index";
import type { OutputMeta } from "./output-meta";

export interface ConsultDetails {
	model?: string;
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
	truncated?: boolean;
	maxTokens?: number;
	error?: string;
	meta?: OutputMeta;
}
export interface ConsultUsage {
	turn: number;
	session: number;
	last?: ConsultDetails;
}

export function getConsultUsage(session: ToolSession): ConsultUsage {
	session.consultUsage ??= { turn: 0, session: 0 };
	return session.consultUsage;
}

export function resetConsultTurn(holder: { consultUsage?: ConsultUsage }): void {
	if (!holder.consultUsage) return;
	holder.consultUsage.turn = 0;
}

export function resetConsultSession(holder: { consultUsage?: ConsultUsage }): void {
	if (!holder.consultUsage) return;
	holder.consultUsage.turn = 0;
	holder.consultUsage.session = 0;
	delete holder.consultUsage.last;
}

export function recordConsultAttempt(session: ToolSession, last?: ConsultDetails): ConsultUsage {
	const usage = getConsultUsage(session);
	usage.turn += 1;
	usage.session += 1;
	if (last) usage.last = last;
	return usage;
}
