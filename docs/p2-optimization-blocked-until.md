# P2 optimization status — blocked until live evidence

Status board for the revised optimization plan’s **P2** bucket:
model calibration, concurrency tuning, code-intel productization, and
output optimization.

**This delivery documents gates and experiment entry points only.** It does
**not** change production model defaults, concurrency caps, Track E prompts,
or force code-intel productization. No latency wins are claimed.

Upstream program inputs:

- Revised plan (approved next-batch was P0; P2 remains evidence-gated)
- `docs/research/2026-09-09-subagent-harness-next-optimizations.md` §2 P2 + §3
- `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md`
  (ordinary `modelOptimization` seam; concurrency owners)
- `docs/tools/code_intel.md` + native code-intel design
- Continuous sync hygiene: `docs/upstream-sync-hygiene.md`

Stack prerequisites (measurement + safety before tuning): P0 #2, P1-1 #3,
P1-2 #4, P1-3 #5, P1-4 #6 on `workflow`.

## Shared experiment bar (all P2 items)

Unblocks require **all** of:

1. Fixed task set, code snapshot, models/effort, tools, and scorer
2. One primary factor changed per paired run
3. Success rate, first-pass rate, rework, wall time, and cost reported together
4. Failures / timeouts retained in the corpus (no drop-to-win)
5. Sample size labeled — small *n* is screening only, not a merge win
6. Parent final verification / e2e timing available where the claim is
   end-to-end (`parent_final_verification`, `bun run stats:subagents`)

Do **not**: reopen Track C; add Track E prompt rules; set a global 200k
context cap for all models; rebuild the workflow state machine.

---

## Matrix

| Item | Shipped in this PR | Production default change | Blocked until | Experiment entry |
|---|---|---|---|---|
| Upstream sync hygiene | Checklist + drills + smoke gates | N/A (process) | N/A | `docs/upstream-sync-hygiene.md` |
| P2 model / effort calibration | Status + entry points only | **No** | Fresh failure/slow traces + paired role×effort evidence | [§ Model](#1-model--effort-calibration) |
| P2 concurrency caps | Status + entry points only | **No** | Live 1/2/4 concurrency corpus with 429/retry/parent-wait | [§ Concurrency](#2-concurrency-tuning) |
| P2 code-intel productization | Status + entry points only | **No** | Corpus proving scout/read thrash with code_intel as the fix | [§ Code-intel](#3-code-intel-productization) |
| P2 output optimization | Status + entry points only | **No** | Paired proof that output trunc/dedupe cuts e2e without quality drop | [§ Output](#4-output-optimization) |

---

## 1) Model / effort calibration

### What already exists

- Role profiles / quality routes (`docs/workflow.md`)
- Split P4 surfaces: advisories vs sonic-effort
  (`docs/superpowers/specs/2026-09-13-subagent-latency-optimization-program-design.md`)
- Policy experiment ledger (shadow-by-default):
  `packages/coding-agent/src/workflow/policy-experiment.ts`
- Bash attempt ledger (advisory; does not block execution)

### Blocked until

| Gate | Evidence required |
|---|---|
| B-M1 | New-version traces showing **repeated** mechanical vs complex vs review failures (not historical P4 whole-pack %) |
| B-M2 | Paired runs per role with **one** model or effort delta; `roleVerdicts` and cost reported |
| B-M3 | Provider request dump proves effort labels are actually honored (fixed effort models do not count) |
| B-M4 | No Track E prompt changes bundled with the same PR |

### Experiment entry points

```sh
# Sonic effort ceiling only (not advisories)
bun run test:latency:paired:sonic-effort -- \
  --paired-control /path/to/control \
  --paired-treatment /path/to/sonic-effort-treatment \
  --output /tmp/p2-sonic-effort-pairs.json

# Offline coverage of effort fields in existing sessions
bun run stats:subagents -- --since 3d --format json
# or: bun scripts/session-stats/subagent-report.ts --sessions ~/.omp/agent/sessions --since 1w
```

Production path: keep bundled / configured role models unchanged until B-M1–B-M4
pass and a dedicated rollout PR flips defaults with receipts.

### Explicitly not doing now

- Changing default implementer / reviewer / scout models or efforts
- Generalizing “anti-loop” frameworks beyond existing ledgers
- Treating LangChain Terminal Bench numbers as local ranking

---

## 2) Concurrency tuning

### What already exists

- `task.maxConcurrency` semaphore (`packages/coding-agent/src/task/`)
- Provider concurrency wrapper — currently settings-backed for
  `ollama-cloud` only (`provider-concurrency.ts`)
- Workflow work-package plan + declaration-backed caps
- Policy lever `tool_concurrency_ceiling` (production apply still requires
  verified rollout authority; raw active gates fail closed)
- P1-4 shared-write / verify-ownership safety (not a throughput win)

### Blocked until

| Gate | Evidence required |
|---|---|
| B-C1 | Live provider runs at concurrency 1 vs 2 vs 4 on the **same** task set |
| B-C2 | Metrics: successful e2e time, TTFT, 429/retry rate, parent wait / queueMs (not spawn-only) |
| B-C3 | Proof the bottleneck is remote contention or local semaphore saturation — not model think time |
| B-C4 | Any provider-specific limiter extension stays on the existing wrapper (no second scheduler) |

### Experiment entry points

```ts
// Policy lever evaluation stays shadow without rollout authority:
import { evaluatePolicyLever } from "../../src/workflow/policy-experiment";
// lever: "tool_concurrency_ceiling" — see policy-experiment.test.ts
```

```sh
# Local mechanism only (mock provider) — does NOT unblock production caps
bun test packages/coding-agent/test/task/parallel-spawn-local-bench.test.ts
```

Settings knobs to vary in a **paired** live harness (do not land as repo
defaults here): `task.maxConcurrency`, and when evidence names a provider,
that provider’s existing maxConcurrency setting (today: ollama-cloud).

### Explicitly not doing now

- Raising global default concurrency
- Extending provider limiter tables without B-C1–B-C3
- New DAG / coordinator agents for “more parallelism”

---

## 3) Code-intel productization

### What already exists

- Shipped `code_intel` tool + envelope grammar + local-only embeds
  (`docs/tools/code_intel.md`)
- Native graph/tags in `crates/pi-natives`
- Design/plan history under `docs/superpowers/specs/2026-09-02-native-code-intelligence-without-cursor-cce-design.md`

“Productization” here means **defaulting agents/workflows to prefer
code_intel over raw grep/read thrash**, or expanding mandatory surfaces —
not reinventing the tool.

### Blocked until

| Gate | Evidence required |
|---|---|
| B-I1 | Fresh corpus where identical-view / repeated grep-read thrash is **human-attributed** as waste (candidate counts ≠ proof; Track E still no-go) |
| B-I2 | Paired tasks: brief-only explore vs explore-with-code_intel; quality and e2e both reported |
| B-I3 | Envelope `found` / provenance correct on the task anchors (no fake call edges) |
| B-I4 | Sync hygiene: natives exports still present after any upstream merge (`docs/upstream-sync-hygiene.md`) |

### Experiment entry points

```sh
bun test packages/coding-agent/test/tools/code-intel-envelope.test.ts \
  packages/coding-agent/test/tools/code-intel-corpus.test.ts \
  packages/coding-agent/test/tools/code-intel-index.test.ts

# Manual / live: same scout task with and without code_intel in the tool set;
# compare explore turns, duplicate reads, and final verify — record corpus path.
```

### Explicitly not doing now

- Forcing code_intel into every default agent tool list
- Remote embedding / Cursor CCE backends
- Prompt rules that order models to “always call code_intel first”

---

## 4) Output optimization

### What already exists

- Ordinary-session `modelOptimization` seam (default **off** /
  inactive until explicitly enabled in settings)
- Workflow `tool-output-manager` + `context-ledger`
- Read dedupe / advisory soft-caps as separate P4 **advisories** experiment
- Context strategy experiment (P1-3) — compaction factors only; default off
  (`docs/context-strategy-experiment.md`)

### Blocked until

| Gate | Evidence required |
|---|---|
| B-O1 | Audit of real serialized requests shows output/tool bytes dominate TTFT or context pressure |
| B-O2 | Single-factor paired run (truncation **or** dedupe **or** advisory soft-cap — not all three) |
| B-O3 | Quality gate passes; pagination/re-fetch turn count does not erase the win |
| B-O4 | No new `performance.contextVolume.truncation.*` tree; no second tool-output processor |

### Experiment entry points

```sh
# Advisories soft-cap experiment (scout + reviewer) — separate from sonic-effort
bun run test:latency:paired:advisories -- \
  --paired-control /path/to/control \
  --paired-treatment /path/to/advisories-treatment \
  --output /tmp/p2-advisories-pairs.json
```

Activate ordinary `modelOptimization` only behind an explicit local settings
flag for a paired corpus; leave repository defaults untouched until B-O1–B-O4
and a rollout receipt exist.

### Explicitly not doing now

- Enabling `modelOptimization` by default in shipped settings
- Uniformly lowering all tool output caps (“shorter is faster”)
- Bundling output changes with concurrency or model default flips

---

## Scaffolding policy for this PR

| Candidate | Action |
|---|---|
| New runtime hooks / default flips | **Skipped** — no live bottleneck evidence in this run |
| Incomplete experiment harnesses | Prefer documenting entry points; do not invent second harnesses |
| Docs + status matrix | **Shipped** |

If a later PR adds scaffolding, it must include tests that prove **default
behavior is unchanged** (settings off, levers shadow, no prompt edits).

## Done criteria for future P2 runtime PRs

A runtime P2 PR is mergeable only when its description cites the matching
B-* gates with corpus paths (or fail-closed “insufficient sample”) and keeps
failures in the report. Hygiene merges follow `docs/upstream-sync-hygiene.md`
and still do not claim latency wins.
