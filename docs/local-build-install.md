# Local Build and Install

This workstation uses the current repository checkout as the default source for
`omp` updates. Do not use the official curl installer, Homebrew upgrade, or a
registry global upgrade unless the user explicitly asks for an official release.

This is a local developer installation procedure, not the production release
pipeline.

## Build

From the repository root, confirm the worktree state before building. Preserve
unrelated user changes and do not clean untracked files.

```sh
git status -sb
git diff --stat
bun --cwd=packages/coding-agent run check
bun --cwd=packages/coding-agent run build
```

Fresh checkouts should run `bun setup` first. The build output is
`packages/coding-agent/dist/omp`.

## Verify the artifact

Run the compiled artifact before replacing the installed command:

```sh
packages/coding-agent/dist/omp --version
packages/coding-agent/dist/omp --help >/dev/null
packages/coding-agent/dist/omp stats --summary >/dev/null
packages/coding-agent/dist/omp --smoke-test
file packages/coding-agent/dist/omp
codesign -v packages/coding-agent/dist/omp
shasum -a 256 packages/coding-agent/dist/omp
```

The smoke probe is required because it exercises compiled worker dispatch and
embedded stats assets. The version alone may match an official build and does
not prove the artifact came from this checkout.

## Install locally

Keep the previous command as a one-step rollback, validate the staged binary,
then replace the installed path atomically:

```sh
mkdir -p ~/.local/bin
cp -p ~/.local/bin/omp ~/.local/bin/omp.pre-local-build
cp packages/coding-agent/dist/omp ~/.local/bin/.omp.local-build.new
chmod 755 ~/.local/bin/.omp.local-build.new
codesign -v ~/.local/bin/.omp.local-build.new
mv ~/.local/bin/.omp.local-build.new ~/.local/bin/omp
```

If `~/.local/bin/omp` does not exist yet, skip the backup command.

## Verify the installation

```sh
command -v omp
file ~/.local/bin/omp
shasum -a 256 packages/coding-agent/dist/omp ~/.local/bin/omp
omp --version
omp --smoke-test
```

The two checksums must match, and `command -v omp` must resolve to the intended
local path.

## Roll back

```sh
cp ~/.local/bin/omp.pre-local-build ~/.local/bin/omp
omp --version
omp --smoke-test
```

After every build, re-run `git status -sb`. Remove or relocate only artifacts
created by the current build; never delete pre-existing user files.

## Latest verified baseline

Last updated: 2026-09-07 (Asia/Shanghai).

| Item | Verified value |
|---|---|
| Source commit | `8095e3761f` / `8095e3761fbf2d0e412a589fc5bef822e8138b70` (`v15.5.9-13701-g8095e3761f-dirty`). Built from the current `workflow` checkout at this HEAD. The only remaining worktree change after install is this baseline record. An existing merge-conflict comment in `packages/coding-agent/test/task/parallel-spawn-local-bench.test.ts` was resolved to ours (`CALLS_PER_WORKER = 1`) and matched HEAD. A previously staged import split in `packages/coding-agent/test/task/review-metrics-contract.test.ts` was dropped after `bun check` passed on the HEAD import path. |
| Package version | `omp/18.0.5` |
| Artifact | `packages/coding-agent/dist/omp` |
| Installed path | `/Users/sheng/.local/bin/omp` |
| SHA-256 | `6e4a062887883f8c3f45526faec5da8e470e67e46b0dea1fa98e26b38c1b420a` |
| Native SHA-256 | `7af814291cfe4d8b70ee25ac6720c9f06ea22f51e273e19f633659e9615796d5` (embedded `packages/natives/native/pi_natives.darwin-arm64.node`, sentinel `__piNativesV18_0_5`; matches `~/.omp/natives/18.0.5/pi_natives.darwin-arm64.node`) |
| Rollback backup | `/Users/sheng/.local/bin/omp.pre-local-build` (`c97c8a3eab2a6e83f5dba9f5d4edf79daf223fe95b41ff40701e7840a247e2de`, previous `omp/18.0.5` from `0b46267a5a`) |
| Artifact type | adhoc-signed arm64 Mach-O executable |
| Gates | `bun --cwd=packages/coding-agent run check` (biome 3085 files + tsgo) exit 0; production binary build; artifact version/`--help`/`stats --summary`/type/signature/checksum/`--smoke-test`; staged install signature; installed path/type/version/checksum/`--smoke-test`; `bun test test/task/review-metrics-contract.test.ts` 5 pass |

The installed checksum matched the build artifact, both artifact and installed
`--smoke-test` returned `smoke-test: ok`, and the installed command resolved to
`/Users/sheng/.local/bin/omp` (`omp/18.0.5`). The previous installed command
remains available at the rollback path above.
