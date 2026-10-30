# Sync upstream `main` into `workflow` (main-as-base)

Recommended, repeatable procedure for absorbing the latest upstream
`can1357/oh-my-pi` `main` into this fork's long-lived integration branch
`workflow` (fork: `graysonzeng/oh-my-pi`). The merge is built on a branch that
starts from `main`, so upstream structure wins by default and conflicts are
resolved by re-applying `workflow` intent on top. Because `main` is the first
parent and `origin/workflow` is merged in, the result keeps `origin/workflow`
as an ancestor and the publish step is a plain fast-forward — no history
rewrite, no force-push.

## 1. Sync fork `main`

```sh
git fetch https://github.com/can1357/oh-my-pi.git main
UP=$(git rev-parse FETCH_HEAD)
git fetch origin
git merge-base --is-ancestor origin/main "$UP"   # must succeed; if the fork has its own main commits, stop and ask
git push origin "$UP:refs/heads/main"             # fast-forward only; quote the refspec (zsh)
```

## 2. Build the new integration branch on `main`

```sh
git status -sb && git stash list
git stash push -u -m sync-main-$(date +%Y%m%d)   # never discard local work
git fetch origin
git switch -c integ/$(date +%Y-%m-%d) origin/main
git merge --no-ff origin/workflow
```

Resolve conflicts:

- Prefer upstream (`main`) structure and APIs; re-apply the `workflow` intent on top.
- Keep both sides' features and tests; never silently drop `workflow`-only logic
  (modelRoles comma fallback chains, edit-failure escalation, task-outcome
  `finalStatus`, the 60% soft cap `thresholdPercent=60`/`thresholdTokens=-1`,
  advisor caps, context-strategy experiment, structured compaction, …).
- Watch for renamed/moved APIs and changed signatures (fix test stubs and call
  sites, not just markers). When the two sides encode contradictory behavior
  (e.g. a main test asserting the opposite of a workflow contract), keep the
  workflow contract, adapt the main test, and record it in the report.
- Regenerate generated artifacts instead of hand-merging them:
  `bun run gen:rpc` (RPC wire schema/SDKs) when `rpc-types.ts` or the wire DSL
  changed; rebuild natives (`bun run build:native`) before running tests.
- Record every conflict file and its resolution in the merge commit message.
- No markers left: `git diff --check` and `git grep -n '^<<<<<<<\|^>>>>>>>'`.

## 3. Verify before pushing

```sh
bun install
bun run build:native
bun check
cd packages/coding-agent && bun test test/model-resolver.test.ts test/retry-fallback.test.ts \
  test/session/edit-failure-escalation*.test.ts test/stats/task-outcome.test.ts \
  test/session/soft-cap-default.test.ts
```

Also run the suites touching conflicted files (`packages/agent/test`,
`packages/ai/test`, `packages/tui/test`, coding-agent `test/session`,
`test/task`, `test/tools`, `test/rpc-wire`, …) and compare any failures against
a clean `origin/main` worktree (`git worktree add --detach /tmp/omp-main origin/main`)
so only merge-introduced failures are fixed. Then build and live-smoke per
[Local Build and Install](local-build-install.md): `--version`, `--help`,
`stats --summary`, `--smoke-test`, plus non-interactive runs with stdin closed
(`omp -p "…" </dev/null`): plain prompt, `@smol`, read+edit fix in a temp git
dir, a `task`/scout subagent, `-c` continue, `omp stats`. Delete temp dirs.

If verification cannot pass after reasonable fixes, do not push; report the blockers.

## 4. Publish (fast-forward only)

```sh
git merge-base --is-ancestor origin/workflow HEAD   # must succeed
git push origin HEAD:refs/heads/workflow             # never --force
git branch -d integ/<date>                            # optional
```

## 5. Update the local checkout and install

```sh
git switch workflow
git merge --ff-only origin/workflow
git stash pop      # report stash conflicts instead of resolving blindly
```

Then follow [Local Build and Install](local-build-install.md): build, verify the
artifact, back up `~/.local/bin/omp` to `~/.local/bin/omp.pre-local-build`,
atomic replace, verify checksums and `--smoke-test`. Rollback:
`cp ~/.local/bin/omp.pre-local-build ~/.local/bin/omp`.

## Report

Upstream sha synced, commits absorbed, conflict files and how each was
resolved, verification results (check/tests/smoke), new `workflow` tip, local
install version + checksum, rollback path, stash restore status.
