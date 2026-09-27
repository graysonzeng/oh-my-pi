# Independent review notes (D1–D8)

Reviewer stance: adversarial pass after implementation, before draft PR.

## Issues found and fixed

1. **Circular type risk** — `NoProgressPauseReason` moved to `goals/state.ts`; `no-progress.ts` re-exports. Avoids state↔no-progress cycle.
2. **Persist typing** — `interactive-mode` now narrows `lastPauseReason` to the union (not bare `string`).
3. **Memory transfer natives pull** — `local-transfer` no longer imports `memories/index` or `@oh-my-pi/pi-utils` barrel (both load natives). Uses `dirs`/`fs-error` subpaths + `memories/storage.normalizeScopeCwd`.
4. **Import scope semantics** — cross-project import correctly conflicts; round-trip test uses same cwd/different agentDir.
5. **No-progress streak** — first comparable observation counts as 1 so threshold=3 pauses on the third identical observation (matches “3 identical observations” fixture wording).
6. **Formatting** — oxfmt on touched TS files; `bun run check:types` clean for coding-agent.

## Residual risks (not bugs)

- Live Hub TUI session still 未验证; inspector Needs me is wired from the projection.
- Live computer platforms / paid A/B / hindsight+mnemopi migrate — 未验证 / 暂缓 per matrix.
- `diagnoseRuleSources` winner heuristic is best-effort over capability snapshots; does not change load order.

## Follow-up increment (this turn)

- ACP `/memory` transfer uses top-level import (no `await import`).
- TUI CommandController handles export / import-preview / import-apply.
- Sharpshooter second seam + transfer CLI helpers.
- D8 `attributeLimiterState` keeps provider / task / job owners separate.

## Verify rerun after fixes

Focused suite rerun after this increment (see matrix). `bun run check:types` in coding-agent must stay clean.
