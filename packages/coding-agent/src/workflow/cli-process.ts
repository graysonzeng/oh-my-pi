import { WorkflowCancelledError, WorkflowError, WorkflowTimeoutError } from "./errors";
import { redactSecretsInText } from "./secret-redact";

/** Hard cap on combined stdout/stderr bytes retained from a CLI process. */
export const CLI_PROCESS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface CliProcessRequest {
	command: string[];
	cwd: string;
	stdin: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	timeoutMs: number;
}

export interface CliProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export type CliProcessRunner = (request: CliProcessRequest) => Promise<CliProcessResult>;

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? String((error as { name?: unknown }).name) : "";
	const message = error instanceof Error ? error.message : String(error);
	return name === "AbortError" || /abort|cancel/i.test(message);
}

async function readBoundedStream(stream: ReadableStream<Uint8Array> | null, label: string): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > CLI_PROCESS_MAX_OUTPUT_BYTES) {
				throw new WorkflowError(
					`CLI ${label} exceeded ${CLI_PROCESS_MAX_OUTPUT_BYTES} bytes`,
					"provider_permanent",
					{
						label,
						bytes: total,
					},
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

function killProcess(proc: ReturnType<typeof Bun.spawn>): void {
	try {
		proc.kill();
	} catch {
		// already exited
	}
}

/**
 * Spawn a CLI without a shell: argv array + stdin pipe.
 * Distinguishes caller cancellation from wall-clock timeout.
 */
export async function runCliProcess(request: CliProcessRequest): Promise<CliProcessResult> {
	if (!request.command.length || !request.command[0]?.trim()) {
		throw new WorkflowError("CLI executable missing from command", "configuration", {
			command: request.command,
		});
	}
	if (request.signal?.aborted) {
		throw new WorkflowCancelledError("CLI process aborted before spawn");
	}

	const started = Date.now();
	const timeoutController = new AbortController();
	const onCallerAbort = () => timeoutController.abort(new DOMException("Aborted", "AbortError"));
	request.signal?.addEventListener("abort", onCallerAbort, { once: true });

	let timedOut = false;
	const timeoutId =
		request.timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					timeoutController.abort(new DOMException("Timeout", "TimeoutError"));
				}, request.timeoutMs)
			: undefined;

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	if (request.env) {
		for (const [key, value] of Object.entries(request.env)) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
	}

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(request.command, {
			cwd: request.cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
	} catch (error) {
		if (timeoutId) clearTimeout(timeoutId);
		request.signal?.removeEventListener("abort", onCallerAbort);
		const message = error instanceof Error ? error.message : String(error);
		if (/enoent|not found|no such file/i.test(message)) {
			throw new WorkflowError(`CLI executable not found: ${request.command[0]}`, "configuration", {
				executable: request.command[0],
				cause: error,
			});
		}
		throw new WorkflowError(message, "configuration", { cause: error });
	}

	const onTimeoutAbort = () => killProcess(proc);
	timeoutController.signal.addEventListener("abort", onTimeoutAbort, { once: true });

	try {
		const stdin = proc.stdin;
		if (stdin && typeof stdin === "object" && "write" in stdin && "end" in stdin) {
			// Bun FileSink API (not Web Streams WritableStream)
			const sink = stdin as { write: (data: string) => number; end: (data?: string | undefined) => number };
			sink.write(request.stdin);
			sink.end();
		}

		const stdoutPromise = readBoundedStream(proc.stdout as ReadableStream<Uint8Array> | null, "stdout");
		const stderrPromise = readBoundedStream(proc.stderr as ReadableStream<Uint8Array> | null, "stderr");
		const exitPromise = proc.exited;

		// Race exit against abort so timeout/cancel can surface promptly.
		const exitCode = await new Promise<number>((resolve, reject) => {
			const onAbort = () => {
				killProcess(proc);
				if (timedOut) {
					reject(new WorkflowTimeoutError("CLI process timed out", { timeoutMs: request.timeoutMs }));
					return;
				}
				reject(new WorkflowCancelledError("CLI process cancelled"));
			};
			if (timeoutController.signal.aborted) {
				onAbort();
				return;
			}
			timeoutController.signal.addEventListener("abort", onAbort, { once: true });
			exitPromise.then(
				code => {
					timeoutController.signal.removeEventListener("abort", onAbort);
					resolve(code ?? 1);
				},
				err => {
					timeoutController.signal.removeEventListener("abort", onAbort);
					reject(err);
				},
			);
		});

		const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

		if (timedOut) {
			throw new WorkflowTimeoutError("CLI process timed out", {
				timeoutMs: request.timeoutMs,
				stderr: redactSecretsInText(stderr).slice(0, 2000),
			});
		}
		if (request.signal?.aborted) {
			throw new WorkflowCancelledError("CLI process cancelled", {
				stderr: redactSecretsInText(stderr).slice(0, 2000),
			});
		}

		return {
			exitCode,
			stdout,
			stderr,
			durationMs: Date.now() - started,
		};
	} catch (error) {
		killProcess(proc);
		if (error instanceof WorkflowError) throw error;
		if (timedOut) {
			throw new WorkflowTimeoutError("CLI process timed out", { timeoutMs: request.timeoutMs, cause: error });
		}
		if (request.signal?.aborted || isAbortError(error)) {
			throw new WorkflowCancelledError("CLI process cancelled", { cause: error });
		}
		const message = error instanceof Error ? error.message : String(error);
		if (/enoent|not found|no such file/i.test(message)) {
			throw new WorkflowError(`CLI executable not found: ${request.command[0]}`, "configuration", {
				executable: request.command[0],
				cause: error,
			});
		}
		throw new WorkflowError(message, "provider_permanent", { cause: error });
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		timeoutController.signal.removeEventListener("abort", onTimeoutAbort);
		request.signal?.removeEventListener("abort", onCallerAbort);
	}
}
