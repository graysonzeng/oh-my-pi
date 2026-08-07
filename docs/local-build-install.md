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

Last updated: 2026-08-07 (Asia/Shanghai).

| Item | Verified value |
|---|---|
| Source commit | `69857c8f7` / `69857c8f74643bd387a24427a75a26df6a38e0a76` (clean worktree at verify time; tag `v17.1.9`) |
| Package version | `omp/17.1.9` |
| Artifact | `packages/coding-agent/dist/omp` |
| Installed path | `/Users/sheng/.local/bin/omp` |
| SHA-256 | `acc483ff3c22d5ec7183d05911a5280690cb8e24cf6e53fc99ff9a6c5399f1c1` |
| Native SHA-256 | `ee6f860bb77e000879670f4e63944287cdc563b3d608744c8e8307d6b28dd901` (embedded `packages/natives/native/pi_natives.darwin-arm64.node`, sentinel `__piNativesV17_1_9`) |
| Rollback backup | `/Users/sheng/.local/bin/omp.pre-local-build` |
| Artifact type | signed arm64 Mach-O executable |
| Gates | `bun run check:ts` (biome 3982 files + all workspace tsgo) exit 0; full spawn-capable test matrix: agent 477, ai 3795, utils 479, catalog 529, hashline 236, wire, collab-web 75, tui 1403, coding-agent 12190 pass with 4 pre-existing environment-limited failures (status-line symlink ×2, Python runtime completion ×2; RpcClient restart flake 4/4 green on rerun); production binary build; artifact type/signature/version/checksum and `--smoke-test`; installed path/type/version/checksum and `--smoke-test` |

The installed checksum matched the build artifact, both artifact and installed
`--smoke-test` returned `smoke-test: ok`, and the installed command resolved to
`/Users/sheng/.local/bin/omp` (`omp/17.1.9`). The source tree was clean at build
time (commit `69857c8f7`, local tag `v17.1.9`), so the baseline is reproducible
from that commit alone. The previous installed command remains available at the
rollback path above.
