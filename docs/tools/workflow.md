# workflow

> Runs the persisted multi-stage coding workflow. The separate `workflow-bench` command measures fixed cases against the same production workflow path.

## Source

- Tool entry: `packages/coding-agent/src/workflow/workflow-tool.ts`
- Benchmark command: `packages/coding-agent/src/commands/workflow-bench.ts`
- Benchmark runner: `packages/coding-agent/src/workflow/benchmark/`

## Inputs

The model-facing tool accepts `start`, `status`, `resume`, and `cancel` operations. `start` requires a request; the remaining stateful operations require a workflow id.

The user-facing benchmark command accepts:

| Flag | Description |
| --- | --- |
| `--case` | Comma-separated fixed case ids. `simple-bug-fix` aliases `bugfix-null-deref`. |
| `--variant` | `baseline`, `optimized`, or `both`. |
| `--repetitions` / `--reps` | Minimum repetitions per selected case. |
| `--mode` | `fake` by default; `live` is the credentialed production-workflow path. |
| `--provider`, `--model` | Required explicit model identity for live mode. |
| `--output` | Writes the scorecard, comparison report, gate, and full report. |
| `--json` | Emits a machine-readable summary. |

## Outputs

`workflow-bench` reports paired quality and performance metrics with provenance. Provider counters are marked `provider_fact`, locally measured values are `exact`, byte-derived token approximations are `estimate`, and unavailable observations remain `unknown`.

Fake mode always reports `liveQualityUnknown=true`. It is an offline smoke for report and optimization plumbing, not evidence of live model quality.

Live mode reports `liveQualityUnknown=false` only after it has created a fixture git workspace, invoked the real coding-agent workflow tool, executed the case's trusted `verificationCommands`, and checked the resulting git diff against `allowedPaths`.

## Flow

1. Select the fixed suite, resolve case aliases, variants, and repetitions.
2. Fake mode injects the deterministic fake runtime.
3. Live mode creates a disposable fixture repository and a real headless coding-agent session.
4. The session starts and resumes the production `workflow` tool until a terminal state.
5. Live mode independently runs the case verification commands and checks changed-file scope.
6. The runner builds the scorecard, comparison rows, and quality gate without changing production profiles.

## Modes / Variants

Offline smoke:

```bash
bun run workflow-bench --case simple-bug-fix --variant baseline --repetitions 3
bun run workflow-bench --case simple-bug-fix --variant optimized --repetitions 3
```

Credentialed live workflow benchmark:

```bash
bun run workflow-bench --mode live --provider <provider-id> --model <model-id> \
  --case simple-bug-fix --variant baseline --repetitions 3 --output .agent-artifacts/workflow-bench
```

A single-variant report is intentionally gate-inconclusive but exits successfully when its runs complete. A paired run returns a failing command exit code when the quality gate fails.

## Side Effects

- Fake mode only writes files when `--output` is provided.
- Live mode makes provider requests, consumes quota, creates temporary fixture repositories, runs trusted fixture commands, and may write normal workflow/session artifacts.
- Neither mode edits bundled default profiles or production routing configuration.

## Limits & Caps

- Live fixture support is explicit. Unsupported fixture ids fail closed instead of being scored synthetically.
- Repetitions are at least the case's fixed minimum.
- Live workflow resume attempts are bounded.
- Verification commands come from fixed case descriptors; model-proposed commands are not executed by the benchmark harness.

## Errors

- Unknown suite, case, variant, or mode values fail before execution.
- Live mode requires both `--provider` and `--model`.
- Missing credentials, unavailable models, a missing workflow tool, non-terminal workflows, verification failures, and out-of-scope diffs produce failed live runs rather than synthetic passes.

## Notes

- Do not compare fake pass rates with live quality. The fake runtime exists to keep CI deterministic.
- Keep provider secrets in the existing coding-agent auth/config stores or environment. The command prints only provider/model identifiers, never credential values.
