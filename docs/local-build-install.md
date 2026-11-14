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

Last updated: 2026-11-14 (Asia/Shanghai).

| Item | Verified value |
|---|---|
| Source commit | `4160ee7cb4` (branch `fix/grok-edit-failures`, one commit on top of `workflow` `ea1bc3dd48`). Built from worktree `/Users/sheng/tencent/oh-my-pi-wt-grok-edit` because the main `workflow` checkout holds unrelated uncommitted changes. |
| Package version | `omp/18.18.0` |
| Artifact | `packages/coding-agent/dist/omp` |
| Installed path | `/Users/sheng/.local/bin/omp` |
| SHA-256 | `7dac0045afd6eb8629a5d6186366e37428dfb65f55b31a5205e6a5478c0c9e0b` |
| Native SHA-256 | `1135eecf45c15bbf3d33c570b625d9b043a6b7b0d14cb7f2d6540c46c72222c3` (`packages/natives/native/pi_natives.darwin-arm64.node`, rebuilt with `bun --cwd=packages/natives run build`, `local` profile) |
| Rollback backup | `/Users/sheng/.local/bin/omp.pre-local-build.20261114-grok-edit` (`13112fa27e6fe0e1fff7a8d72abbf5aea7110fbe08d138fcd7de53c8ad2f04b7`, previous `omp/18.18.0` installed 2026-11-13) |
| Artifact type | adhoc-signed arm64 Mach-O executable |
| Gates | `bun --cwd=packages/coding-agent run check` exit 0; root `bun check` exit 0; `cargo nextest run -p pi-edit` 439 passed; 6 related TS test files 54 pass; production binary build; artifact version/`--help`/`stats --summary`/type/signature/checksum/`--smoke-test`; staged install signature; installed path/type/version/checksum/`--smoke-test`; installed `omp -p` read with `path=README.md:3, limit=2, offset=0` returned content instead of the stale-pagination error |

The installed checksum matched the build artifact, both artifact and installed
`--smoke-test` returned `smoke-test: ok`, and the installed command resolved to
`/Users/sheng/.local/bin/omp` (`omp/18.18.0`). The previous installed command
remains available at the rollback path above.
