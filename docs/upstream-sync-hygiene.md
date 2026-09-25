# Upstream sync hygiene (continuous)

Practical checklist for **small-batch** syncs from upstream
[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) into this fork while
preserving workflow customizations (quality routes, gateway, allowlists,
measurement, code-intel, latency experiment surfaces).

This is maintenance hygiene — **not** a latency claim, and **not** an
authorization to merge upstream blindly in the same PR that only documents
the process.

Related: `docs/porting-from-pi-mono.md` covers pi-mono → omp porting. This
doc covers **can1357/oh-my-pi → this fork** on the `workflow` line.

## Why small batches

Large “catch up main” merges bury conflicts in quality routes, tool
allowlists, gateway identity receipts, and measurement producers. Prefer
upstream ranges that touch one package or one concern, then re-run the smoke
gates below before stacking more.

## Remotes and refs

Assume:

| Role | Typical ref |
|---|---|
| Upstream | `https://github.com/can1357/oh-my-pi` (add as `upstream` if missing) |
| Fork default integration | `origin/workflow` |
| Stacked latency work | open PRs on `workflow` (P0–P1-4: #2–#6 and successors) |

```sh
git remote add upstream https://github.com/can1357/oh-my-pi.git  # once
git fetch upstream main
git fetch origin workflow
```

Record the last successfully integrated upstream SHA in the sync PR body
(and optionally update a one-line note at the bottom of this file after a
real sync lands). Do **not** invent a sync SHA in a docs-only PR.

## Preserve list (do not silently drop)

When resolving conflicts or cherry-picks, keep fork behavior unless the sync
PR explicitly retires it:

| Area | Examples / owners |
|---|---|
| Quality routes | `workflow.qualityRoutes`, `defaultQualityTier`, routing audit / identity receipts (`docs/workflow.md`) |
| Gateway | gateway provider models, attestation vs transport identity, live e2e harness notes |
| Allowlists | scoped implement/repair tool sets; write/command path policy (not name-only lists) |
| Measurement | `parent_final_verification`, hub settle / `requestPhaseQueueMs`, `stats:subagents`, latency receipts |
| Experiment surfaces | split P4 advisories vs sonic-effort; context strategy experiment (default **off**); policy-experiment levers (shadow until verified rollout) |
| Parallel / recovery safety | shared-write block/transfer, verify ownership, explainable cancel/merge (`isolationIsTransaction: false`) |
| Code-intel | native `code_intel` tool + `crates/pi-natives` code-intel; do not strip exports during merge repair |
| Local agents / skills | `.omp/agents/*`, `.omp/skills/*`, `.agents/rules/*` when still intentional |
| Prompt policy | Track E thrash remains **no-go** until human attribution (`docs/superpowers/specs/2026-09-13-sol-pi-efficiency-absorption.md`) |

If upstream renames or moves a file that carries any of the above, port the
fork delta onto the new path — do not “accept theirs” and call it done.

## Small-batch procedure

1. **Pick a range** — one release tag, one upstream PR, or a short commit
   list. Prefer ranges that avoid simultaneous churn in `workflow/engine.ts`,
   tool allowlists, and natives exports.
2. **Branch from current stack tip** — usually latest `workflow` (or the
   open stack tip you are extending). Name the branch for the upstream range.
3. **Integrate** — prefer `git cherry-pick` / `git rebase` of the range, or
   `git merge --no-ff` only when the range is already reviewed as a unit.
   Avoid wholesale directory copies.
4. **Conflict drill** (see below) — resolve with the preserve list in hand.
5. **Smoke gates** — run the checklist in [Smoke gates](#smoke-gates).
6. **Focused contracts** — re-run tests for every area you touched
   (workflow, task, latency, code-intel, session-stats).
7. **PR body** — upstream range, conflict notes, preserve confirmations,
   smoke command output summary. Link stacked deps. **No claimed speedups.**

## Conflict drill notes

Practice these resolutions **before** a large catch-up:

### 1) Quality routes vs upstream router defaults

- Symptom: conflict in `workflow` settings schema, `default-config`, or
  engine routing.
- Rule: empty/absent `qualityRoutes` must keep legacy router behavior;
  configured routes stay immutable snapshots with fingerprint on resume.
- Drill: after resolve, run focused workflow quality-route / availability
  tests; confirm `degradedMode: false` still required when routes are set.

### 2) Allowlists / tool policy

- Symptom: conflict in structured-subagent tool sets or bash/path policy.
- Rule: readonly roles stay plan-mode; implement/repair stay scoped; path
  policy at execution beats name-only allowlists.
- Drill: grep for unrestricted `task` spawn on implement/repair profiles;
  run a workflow work-package or policy-bounds focused test.

### 3) Measurement producers

- Symptom: conflict near hub settle fields, final_verify, or session-stats
  scripts.
- Rule: `unknown` stays unknown (no zero-fill); parallel intervals do not
  sum into parent e2e; failures remain in the corpus.
- Drill: `bun run stats:subagents --help` / focused
  `parent-final-verification` + `subagent-report` tests if those files
  moved.

### 4) Natives / code-intel exports

- Symptom: merge “fixes” drop `code_intel` Rust exports or TS bindings.
- Rule: restore exports; never leave a half-linked native symbol.
- Drill: `omp --smoke-test` (worker graph) + focused
  `code-intel-envelope` / index tests when natives changed.

### 5) Experiment defaults

- Symptom: upstream or local edit flips an experiment flag on.
- Rule: `compaction.experiment.enabled` default **false**; policy levers
  stay shadow without verified rollout authority; do not bundle model +
  concurrency + Track E in one sync.
- Drill: settings default assertions / policy-experiment production-boundary
  tests.

## Smoke gates

Run after every non-trivial sync (docs-only sync of this file may skip, but
any code merge must not):

```sh
# Worker host + tiny-model smoke (also used by ci:test:smoke)
bun packages/coding-agent/src/cli.ts --smoke-test
# or, once omp is on PATH from this tree:
omp --smoke-test

# Broader install-oriented smoke used in CI packaging
bun run ci:test:smoke
```

Add focused checks matching the sync surface, for example:

```sh
# Measurement / offline report
bun test packages/coding-agent/test/latency/parent-final-verification.test.ts
bun test scripts/session-stats/subagent-report.test.ts

# Parallel / recovery safety (if task/workflow touched)
cd packages/coding-agent && bun test test/latency/parallel-recovery-safety.test.ts

# Code-intel (if natives or tool touched)
bun test packages/coding-agent/test/tools/code-intel-envelope.test.ts \
  packages/coding-agent/test/tools/code-intel-index.test.ts

# Type / lint when the merge is wide
bun check
```

Live networked A/B and gateway e2e remain **optional and cost-bearing** —
see `docs/workflow.md` “Live multi-model verification”. Do not treat missing
live credentials as a sync failure; record “not run”.

## Explicitly out of scope for a hygiene PR

- Merging upstream in the same change set “because the checklist exists”
- Changing production model defaults, concurrency caps, or Track E prompts
- Reopening Track C / second compaction scheduler
- Claiming latency wins from a clean merge

## Status (this delivery)

| Item | State |
|---|---|
| Checklist + conflict drills + smoke gates | **Shipped** (this doc) |
| Actual upstream merge of `can1357/oh-my-pi` | **Not performed** in the docs PR — wait for a dedicated sync PR with a concrete range |
| Last integrated upstream SHA | _update when a real sync lands_ |
