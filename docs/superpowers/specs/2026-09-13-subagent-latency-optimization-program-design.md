# Split P4 product-latency experiments

Advisory soft-cap changes and sonic effort ceiling changes are **separate**
experiment surfaces. Do not bundle them into one paired run or one benefit
verdict.

Historical whole-pack smoke (n=5/role) once showed scout +14.2%, reviewer
−33.3%, sonic +45.1% with total wall-clock down but **per-role non-regression
FAIL**. That corpus is context only — not a merge win and not a live retest.

## Surfaces

| Experiment | Allowed source deltas | Roles scheduled |
|---|---|---|
| `advisories` | `src/tools/read.ts`, `src/session/agent-session.ts` | scout, reviewer |
| `sonic-effort` | `src/task/agents.ts` (bundled sonic `maxEffort: medium`) | sonic |

Benefit reporting includes `roleVerdicts` so a single-role regression cannot be
hidden by total wall-clock. Advisories verdicts never stamp
`declaredExperiment: sonic-effort-ceiling`.

## Run (live / networked)

Requires two checkouts that differ only in the declared source deltas, plus
credentials and models for the fixture chains.

```sh
# Advisories only (scout + reviewer)
bun packages/coding-agent/test/task/product-latency-fixture.ts \
  --mode smoke \
  --paired-control /path/to/control \
  --paired-treatment /path/to/advisories-treatment \
  --experiment advisories \
  --output /tmp/p4-advisories-pairs.json

# Sonic effort only
bun packages/coding-agent/test/task/product-latency-fixture.ts \
  --mode smoke \
  --paired-control /path/to/control \
  --paired-treatment /path/to/sonic-effort-treatment \
  --experiment sonic-effort \
  --output /tmp/p4-sonic-effort-pairs.json
```

Optional: `--paired-preflight` to validate source pairs without launching.

Package aliases (same argv):

```sh
bun run test:latency:paired:advisories -- --paired-control ... --paired-treatment ... --output ...
bun run test:latency:paired:sonic-effort -- --paired-control ... --paired-treatment ... --output ...
```

## Judge separately

For each experiment report:

1. Quality / acceptance rate per role (`roleVerdicts`, `acceptanceRates`)
2. Per-role acceptance p50 (`p50AcceptanceMs`) — not only total `elapsedMs`
3. Cost and token non-regression per role
4. Failures and incomplete schedules stay in the corpus (`INCOMPARABLE` / retained errors)

Do not claim live speedups unless you actually ran and recorded the paired
output above.
