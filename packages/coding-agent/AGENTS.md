# Coding Agent Rules

These rules extend the repository root `AGENTS.md` for `packages/coding-agent/`.

## Worker Host

Workers MUST re-enter the CLI entrypoint; NEVER add standalone worker entry modules.

- `cli.ts` calls `declareWorkerHostEntry()` and dispatches hidden `__omp_worker_<name>` selectors before loading commands.
- Spawn through `workerHostEntry()`:

```ts
import { workerHostEntry } from "@oh-my-pi/pi-utils";

const hostEntry = workerHostEntry();
const worker = hostEntry
	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
```

- CLI hosts reuse `Bun.main`; tests, SDK embedding, and standalone apps use the direct-module fallback.
- New workers MUST add a `cli.ts` selector and retain the fallback.
- Validate worker graph changes with `omp --smoke-test`; add a sibling probe for a distinct graph.

## Logging

NEVER use `console.log`/`error`/`warn`; it corrupts TUI rendering. Use `logger` from `@oh-my-pi/pi-utils`. Logs rotate under `~/.omp/logs/`.

## TUI Sanitization

Sanitize every renderer path, including errors, diffs, and streaming previews.

- Tabs → `replaceTabs()`.
- Width → `truncateToWidth()` / `ui.truncate()` with `TRUNCATE_LENGTHS`.
- Paths → `shortenPath()`.
- Preview limits → `PREVIEW_LIMITS`; NEVER use ad-hoc limits.

Streaming argument changes MUST cover live events and transcript rebuilds through `decodeStreamedToolArgs` / `ToolArgsRevealController`. NEVER merge provider-parsed `arguments` with raw `__partialJson`.

Bash previews MUST preserve preview-only fields through `event-controller.ts`, `ui-helpers.ts`, and `tool-execution.ts`. `ToolExecutionComponent.#buildRenderContext()` MUST render before results exist. Verify live and rebuilt paths.

## Local Install

Updating `omp` on this workstation means building this checkout and following `docs/local-build-install.md`; NEVER use the release installer, Homebrew, or registry unless explicitly requested.

A matching version is insufficient. Verify compiled-binary identity, artifact checksum, installed path, and `omp --smoke-test`. After installation, update the verified baseline with commit, checksum, installed path, backup path, and gates run.
