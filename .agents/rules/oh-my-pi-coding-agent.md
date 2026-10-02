---
description: "Read for coding-agent workers, shared utilities, logging, or TUI rendering."
globs: ["packages/coding-agent/**", "packages/utils/**", "packages/tui/**"]
---

# Coding Agent Runtime

## Worker Host

Workers MUST re-enter the CLI entrypoint; NEVER add standalone worker entry modules. `cli.ts` calls `declareWorkerHostEntry()` from `@oh-my-pi/pi-utils/env` at startup and dispatches hidden `__omp_worker_<name>` argv selectors before loading commands.

Spawn through `workerHostEntry()` and retain the direct-module fallback:

```ts
import { workerHostEntry } from "@oh-my-pi/pi-utils";

const hostEntry = workerHostEntry();
const worker = hostEntry
	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
```

- CLI hosts—source `cli.ts`, npm `dist/cli.js`, or compiled binary—reuse `Bun.main`; no per-worker compile or bundle entries exist.
- Tests, SDK embedding, and standalone applications receive `null` and use the direct-module fallback.
- New worker kinds MUST add a `cli.ts` selector and retain the fallback.
- `with { type: "file" }` copied raw assets and caused silent compiled-binary worker crashes (#1011, #1027). Literal paths plus extra entrypoints later required spawn literals and two build scripts to stay synchronized (#1150). NEVER restore either design.
- Validate worker graph changes with `omp --smoke-test`. It spawns and pings the stats-sync worker and tiny-model subprocess, and runs in `ci:test:smoke` plus `scripts/install-tests/run-ci.sh` for binary, source-link, and tarball installs. Add a sibling smoke probe when a worker uses a distinct module graph.

## Shared Utilities

Before adding helpers, inspect `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and domain modules beside the callsite. Reuse their VCS, formatting, truncation, path display, image, clipboard, stream, temporary-file, and cache helpers; they preserve timeouts, output caps, non-interactive environments, lock avoidance, caching, and TUI sanitization.

- `src/utils/git.ts` and `src/utils/jj.ts` are the only sanctioned git/jj execution paths. Import their namespaces; NEVER hand-spawn git/jj with Bun Shell or `Bun.spawn`.
- Rendering MUST use centralized `replaceTabs`, `truncateToWidth`, `shortenPath`, and `PREVIEW_LIMITS`, not local string math.
- Missing behavior? Extend the central helper; NEVER fork its logic locally.

## Logging

Code that may run with the TUI, RPC, SDK, workers, or background runtimes MUST NOT call `console.log`, `console.error`, or `console.warn`; they corrupt rendering and protocols. Use:

```ts
import { logger } from "@oh-my-pi/pi-utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs rotate at `~/.omp/logs/omp.YYYY-MM-DD.log`. Standalone CLI commands that exit before entering the TUI MAY use `console.*` or process streams for intentional user output. Keep structured stdout clean. This exception is semantic, never filename-based; shared code MUST use `logger` or an explicit output sink.

## TUI Sanitization

Sanitize every renderer path—success, errors containing file content, diffs, and streaming previews:

- Tabs → `replaceTabs()` from `@oh-my-pi/pi-tui` or `../tools/render-utils`.
- Width → `truncateToWidth()` / `ui.truncate()` with `TRUNCATE_LENGTHS`.
- Paths → `shortenPath()` to replace the home directory with `~`.
- Preview limits → `PREVIEW_LIMITS`; NEVER use ad-hoc numbers.

Streaming argument changes MUST cover live events and transcript rebuilds through `decodeStreamedToolArgs` / `ToolArgsRevealController` in `modes/controllers/tool-args-reveal.ts`. NEVER merge provider-parsed `arguments` with raw `__partialJson`; parsed arguments lag partial JSON.

Bash previews MUST:

- Use raw `partialJson` when parsed arguments have not closed.
- Preserve preview-only fields such as `__partialJson` through `event-controller.ts`, transcript rebuilding in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`.
- Let `ToolExecutionComponent.#buildRenderContext()` render before any result exists.
- Verify both live-streaming and rebuilt-transcript paths.
