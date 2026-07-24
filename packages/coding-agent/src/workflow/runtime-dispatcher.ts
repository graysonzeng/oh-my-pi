import { WorkflowError } from "./errors";
import type { RuntimePort, WorkflowAgentRequest, WorkflowAgentResult, WorkflowRuntimeKind } from "./types";

export interface WorkflowRuntimeDispatcherOptions {
	embedded: RuntimePort;
	codexCli: RuntimePort;
	claudeCli: RuntimePort;
}

/**
 * Selects the runtime adapter solely from `profile.runtime.kind`.
 * Never infers runtime from vendor.
 */
export class WorkflowRuntimeDispatcher implements RuntimePort {
	readonly #runtimes: Readonly<Record<WorkflowRuntimeKind, RuntimePort>>;

	constructor(options: WorkflowRuntimeDispatcherOptions) {
		this.#runtimes = {
			embedded: options.embedded,
			codex_cli: options.codexCli,
			claude_cli: options.claudeCli,
		};
	}

	buildRequest(request: WorkflowAgentRequest): WorkflowAgentRequest {
		return this.#runtime(request).buildRequest(request);
	}

	run<TArtifact = unknown>(request: WorkflowAgentRequest): Promise<WorkflowAgentResult<TArtifact>> {
		return this.#runtime(request).run<TArtifact>(request);
	}

	#runtime(request: WorkflowAgentRequest): RuntimePort {
		const kind = request.profile.runtime?.kind ?? "embedded";
		const runtime = this.#runtimes[kind];
		if (!runtime) {
			throw new WorkflowError(`Unknown workflow runtime kind: ${kind}`, "configuration", {
				profileId: request.profile.id,
				runtimeKind: kind,
			});
		}
		return runtime;
	}
}
