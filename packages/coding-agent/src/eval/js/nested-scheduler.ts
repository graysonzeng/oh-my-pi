/**
 * Serializes nested eval-bridge tool calls the same way the agent loop
 * serializes a provider-visible batch: exclusive tools wait for every
 * in-flight shared/exclusive nested call, shared tools wait only for the
 * last exclusive one. Failures do not poison later nested calls.
 *
 * Nested execution cannot wait on the parent eval's exclusive slot — that
 * would deadlock — so this gate is independent of the outer agent-loop
 * scheduler.
 */

export type NestedToolConcurrency = "shared" | "exclusive";

export class NestedToolScheduler {
	#lastExclusive: Promise<unknown> = Promise.resolve();
	#shared: Promise<unknown>[] = [];

	run<T>(concurrency: NestedToolConcurrency, fn: () => Promise<T>): Promise<T> {
		const start =
			concurrency === "exclusive" ? Promise.allSettled([this.#lastExclusive, ...this.#shared]) : this.#lastExclusive;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const task = start.then(fn, fn).then(
			value => {
				resolve(value);
				return value;
			},
			error => {
				reject(error);
				throw error;
			},
		);
		const tracked = task.then(
			() => undefined,
			() => undefined,
		);
		if (concurrency === "exclusive") {
			this.#lastExclusive = tracked;
			this.#shared = [];
		} else {
			this.#shared.push(tracked);
		}
		return promise;
	}
}
