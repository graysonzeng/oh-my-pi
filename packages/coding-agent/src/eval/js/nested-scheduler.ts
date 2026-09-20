/**
 * Serializes nested eval-bridge tool calls the same way the agent loop
 * serializes a provider-visible batch: exclusive tools wait for every
 * in-flight shared/exclusive nested call, shared tools wait only for the
 * last exclusive one. Failures do not poison later nested calls.
 *
 * Nested execution cannot wait on the parent eval's exclusive slot — that
 * would deadlock — so this gate is independent of the outer agent-loop
 * scheduler. Host tool-call messages lose AsyncLocalStorage across the
 * worker hop; callers pass {@link NestedToolScheduler.runningTokens} captured
 * when the child eval run starts so descendants skip ancestor slots only.
 */

export type NestedToolConcurrency = "shared" | "exclusive";

/** Identity of one scheduler admission; never equal across calls. */
export type NestedToolToken = symbol;

export interface NestedToolRunOptions {
	signal?: AbortSignal;
	/** Tokens of ancestor executions this call is nested under. */
	ancestors?: ReadonlySet<NestedToolToken>;
}

interface TrackedCall {
	token: NestedToolToken;
	promise: Promise<unknown>;
}

function abortReason(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	const error = new Error("This operation was aborted");
	error.name = "AbortError";
	return error;
}

export class NestedToolScheduler {
	#idle: TrackedCall = { token: Symbol("nested-idle"), promise: Promise.resolve() };
	#lastExclusive: TrackedCall = this.#idle;
	#shared: TrackedCall[] = [];
	#running = new Set<NestedToolToken>();

	/** Tokens whose `fn` has started and not yet settled. */
	runningTokens(): ReadonlySet<NestedToolToken> {
		return this.#running;
	}

	run<T>(concurrency: NestedToolConcurrency, fn: () => Promise<T>, options: NestedToolRunOptions = {}): Promise<T> {
		const token = Symbol("nested-tool");
		const ancestors = options.ancestors ?? new Set<NestedToolToken>();
		const signal = options.signal;
		const waitFor: Promise<unknown>[] = [];
		if (!ancestors.has(this.#lastExclusive.token)) waitFor.push(this.#lastExclusive.promise);
		if (concurrency === "exclusive") {
			for (const shared of this.#shared) {
				if (!ancestors.has(shared.token)) waitFor.push(shared.promise);
			}
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const tracked = Promise.withResolvers<void>();
		const call: TrackedCall = { token, promise: tracked.promise };
		let started = false;
		let settled = false;

		const finish = (error?: unknown): void => {
			if (settled) return;
			settled = true;
			this.#running.delete(token);
			if (concurrency === "shared") this.#shared = this.#shared.filter(entry => entry.token !== token);
			if (error !== undefined) reject(error instanceof Error ? error : new Error(String(error)));
			tracked.resolve();
		};

		const abortQueued = (): void => {
			if (started) return;
			finish(abortReason(signal));
		};

		if (signal?.aborted) {
			abortQueued();
			return promise;
		}
		if (signal) signal.addEventListener("abort", abortQueued, { once: true });

		const gate = waitFor.length > 0 ? Promise.allSettled(waitFor) : Promise.resolve();
		void gate.then(
			async () => {
				if (settled || signal?.aborted) {
					abortQueued();
					return;
				}
				started = true;
				signal?.removeEventListener("abort", abortQueued);
				this.#running.add(token);
				try {
					const value = await fn();
					if (!settled) {
						settled = true;
						this.#running.delete(token);
						if (concurrency === "shared") this.#shared = this.#shared.filter(entry => entry.token !== token);
						resolve(value);
						tracked.resolve();
					}
				} catch (error) {
					finish(error);
				}
			},
			error => finish(error),
		);

		if (concurrency === "exclusive") {
			this.#lastExclusive = call;
			this.#shared = [];
		} else {
			this.#shared.push(call);
		}
		return promise;
	}
}
