# D1–D8 Round-2 Independent Review

Adversarial residual notes after round-2 fixes on tip after #37.

## Verdict

P1 counterexamples from the independent review are addressed with failing-then-passing regressions for D4/D1/D2 core paths. Several P2/platform items remain honestly incomplete or blocked.

`paired_evidence_ready=false`.

## What is solid

- **D4 binding**: apply requires `pkg`, binds preview↔package bodies, writes verified package content only.
- **D4 lock**: sharpshooter apply uses `withFileLock(sharpshooterLockPath)` — same stem as consolidation; contention test holds the real lock (natives available).
- **D4 loss reporting**: truncate/eviction surface on save + import `partial`.
- **D4 candidates**: staged to `learned.candidates.md`, not injected via `readLearnedLessons`.
- **D1 episode universe**: matrix includes receipt-less episodes as missing.
- **D1 unknown version**: parser reject + classifier `unknown_receipt_version`.
- **D2 streak**: acceptance revision decoupled from nominate `goalRevision`; code hash omitted from fingerprint; unpaired_tools waits even when mixed.
- **D3**: unfinished is tri-state; unknown does not unlock `new_session` at 95%.
- **D6**: removed false approval/integrate heuristics; overlays required.
- **D7**: Rust asserts mapped global hits for negative origins; TS tautology removed.
- **D8**: no capacity sum across providers; unknown owners not formatted as idle zeros.

## Residual gaps

| Gap | Why |
|---|---|
| `/context` TaskTool semaphore | TaskTool instance not on SlashCommandRuntime; observe API ready, diagnose still marks `task_concurrency` unknown unless caller passes semaphore |
| Live Hub TUI paint | Needs interactive kitty/TUI session — 真实外部阻塞 |
| Live computer multi-screen/Retina/Wayland | Platform live — 真实外部阻塞 |
| Docs-task criteria at goal-complete entry | Out of scope this round; review/manual path already exists in classifier |
| Full `/context` local fingerprint / compression-lane rows | Partial — decision + freshness owner fixed; richer fields deferred |
| Thin-harness deletion | Still Documented only — no evidence-backed module deletes |
| Fail-open end-to-end UI with mocked evaluator | Unit/gate path fixed; full interactive goal-complete e2e not re-run |

## Test quality

- Removed tautology `partial === false \|\| errors.length >= 0` in sharpshooter transfer.
- Removed constant self-test `unverified.toContain("wayland-live")`.
- Kept new counterexample regressions for each reproduced P1.

## What not claimed

- No deliveryExperiment defaults flipped ON.
- No live cost/latency wins.
- No `~/.local/bin/omp` replace / paid A/B.
- No architecture redesign.
