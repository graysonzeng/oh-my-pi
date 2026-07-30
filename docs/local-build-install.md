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

Last updated: 2026-07-30 (Asia/Shanghai).

| Item | Verified value |
|---|---|
| Source commit | `e13a01e6d43e2a2c766ae254f4672c5bf690ceac` plus the current uncommitted quality-gated workflow optimization Phase 0-2 changes |
| Package version | `omp/17.1.8` |
| Artifact | `packages/coding-agent/dist/omp` |
| Installed path | `/Users/sheng/.local/bin/omp` |
| SHA-256 | `3cf6ecd3fc95597a5d530cdcf289428134bbd6a60e0ed510cfcc921082b51326` |
| Native SHA-256 | `b429572e4544ab60e71063a3c8b6ec8bb70f3f1e5adeb4d693a8a9b4a9ba4964` (source and installed cache match) |
| Rollback backup | `/Users/sheng/.local/bin/omp.pre-quality-gated-20260730` |
| Artifact type | signed arm64 Mach-O executable |
| Gates | 192 focused Phase 0-2 tests / 2,020 assertions, full `bun check`, production binary build, all 30 live fixtures materialized with verifier and scope checks, fake CLI pipeline, artifact/install checksum match, installed `omp --smoke-test`; the first real-provider paired A/B exposed and rejected a false-positive gate, and the final bilateral hard-gate rerun was still running when this baseline row was written |

The installed checksum matched the build artifact, and the installed
`omp --smoke-test` returned `smoke-test: ok`. Existing worktree changes were
preserved, no commit or official upgrade command was run, and the previous
installed command remains available at the rollback path above.
