export type DeliveryId = string;
export type DeliveryState = "submitted" | "accepted" | "running" | "settled";
export type SettleOwner = "hidden-next-turn" | "queued-user";

export type ScheduleAccepted = {
	status: "accepted";
	deliveryId: DeliveryId;
	settleOwner: SettleOwner;
	attempt: number;
};

export type ScheduleSkip = {
	status: "skip";
	deliveryId: DeliveryId;
	phase: "pre-accept" | "post-accept";
	reason:
		| "aborted"
		| "stale-generation"
		| "preflight"
		| "acp-defer"
		| "disposed"
		| "capability"
		| "arm-off"
		| "cap"
		| "already_settled";
};

export type ScheduleError = {
	status: "error";
	deliveryId: DeliveryId;
	phase: "pre-accept" | "post-accept";
	reason: "prompt-failed" | "persist-failed" | "invariant";
	retryable: boolean;
};

export type ScheduleDecision = ScheduleAccepted | ScheduleSkip | ScheduleError;

export type HiddenNextTurnKind = "headless-goal" | "queued-user";

interface DeliveryRecord {
	state: DeliveryState;
	kind: HiddenNextTurnKind;
	settleOwner: SettleOwner;
	attempt: number;
	emittedNonterminal: boolean;
	emittedTerminal: boolean;
	generation: number;
}

export const HEADLESS_GOAL_CONTINUATION_CAP = 20;

export class HiddenNextTurnScheduler {
	readonly #sessionId: string;
	readonly #deliveries = new Map<DeliveryId, DeliveryRecord>();
	#seq = 0;
	#openNonterminal: DeliveryId | undefined;

	constructor(sessionId: string) {
		this.#sessionId = sessionId;
	}

	mint(kind: HiddenNextTurnKind): DeliveryId {
		this.#seq += 1;
		return `dlv:${this.#sessionId}:${kind}:${this.#seq}`;
	}

	submit(input: {
		kind: HiddenNextTurnKind;
		generation: number;
		resumeDeliveryId?: DeliveryId;
		skip?: ScheduleSkip["reason"];
		error?: Extract<ScheduleError, { status: "error" }>["reason"];
		retryable?: boolean;
	}): ScheduleDecision {
		if (input.resumeDeliveryId) {
			const existing = this.#deliveries.get(input.resumeDeliveryId);
			if (!existing || existing.state === "settled") {
				return {
					status: "skip",
					deliveryId: input.resumeDeliveryId,
					phase: "pre-accept",
					reason: "already_settled",
				};
			}
			if (input.skip) {
				const skip: ScheduleSkip = {
					status: "skip",
					deliveryId: input.resumeDeliveryId,
					phase: existing.emittedNonterminal ? "post-accept" : "pre-accept",
					reason: input.skip,
				};
				if (skip.phase === "pre-accept") existing.state = "settled";
				return skip;
			}
			existing.attempt += 1;
			existing.state = "accepted";
			return {
				status: "accepted",
				deliveryId: input.resumeDeliveryId,
				settleOwner: existing.settleOwner,
				attempt: existing.attempt,
			};
		}

		const deliveryId = this.mint(input.kind);
		const settleOwner: SettleOwner = input.kind === "queued-user" ? "queued-user" : "hidden-next-turn";
		const record: DeliveryRecord = {
			state: "submitted",
			kind: input.kind,
			settleOwner,
			attempt: 1,
			emittedNonterminal: false,
			emittedTerminal: false,
			generation: input.generation,
		};
		this.#deliveries.set(deliveryId, record);
		if (input.skip) {
			record.state = "settled";
			return { status: "skip", deliveryId, phase: "pre-accept", reason: input.skip };
		}
		if (input.error) {
			record.state = "settled";
			return {
				status: "error",
				deliveryId,
				phase: "pre-accept",
				reason: input.error,
				retryable: input.retryable === true,
			};
		}
		if (this.#openNonterminal) {
			record.state = "settled";
			return { status: "error", deliveryId, phase: "pre-accept", reason: "invariant", retryable: false };
		}
		record.state = "accepted";
		return { status: "accepted", deliveryId, settleOwner, attempt: 1 };
	}

	markNonterminal(deliveryId: DeliveryId): boolean {
		const record = this.#deliveries.get(deliveryId);
		if (!record || record.state === "settled") return false;
		record.emittedNonterminal = true;
		record.state = "running";
		this.#openNonterminal = deliveryId;
		return true;
	}

	onSkip(deliveryId: DeliveryId, skip: ScheduleSkip): ScheduleSkip {
		const record = this.#deliveries.get(deliveryId);
		if (!record) return { ...skip, phase: "pre-accept" };
		if (record.state === "settled") return { ...skip, reason: "already_settled", phase: "pre-accept" };
		const phase = record.emittedNonterminal ? "post-accept" : "pre-accept";
		if (phase === "pre-accept") record.state = "settled";
		return { ...skip, deliveryId, phase };
	}

	onError(deliveryId: DeliveryId, err: ScheduleError): ScheduleError {
		const record = this.#deliveries.get(deliveryId);
		if (!record) return { ...err, phase: "pre-accept" };
		const phase = record.emittedNonterminal ? "post-accept" : "pre-accept";
		if (phase === "pre-accept") record.state = "settled";
		return { ...err, deliveryId, phase };
	}

	finalSettle(deliveryId: DeliveryId, _reason: ScheduleSkip["reason"] | "completed" | "error"): boolean {
		const record = this.#deliveries.get(deliveryId);
		if (!record || record.state === "settled") return false;
		if (!record.emittedNonterminal) {
			record.state = "settled";
			return false;
		}
		record.state = "settled";
		record.emittedTerminal = true;
		if (this.#openNonterminal === deliveryId) this.#openNonterminal = undefined;
		return true;
	}

	unsettledNonterminals(): DeliveryId[] {
		const ids: DeliveryId[] = [];
		for (const [id, record] of this.#deliveries) {
			if (record.emittedNonterminal && record.state !== "settled") ids.push(id);
		}
		return ids;
	}

	record(deliveryId: DeliveryId): DeliveryRecord | undefined {
		return this.#deliveries.get(deliveryId);
	}
}
