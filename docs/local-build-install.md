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

Last updated: 2026-08-03 (Asia/Shanghai).

| Item | Verified value |
|---|---|
| Source commit | `c588443b43a76f28b17ad66a93cb8fa25d252a53` / `c588443b4` plus the current uncommitted Biome safe fixes required by the package check and this baseline update |
| Package version | `omp/17.1.8` |
| Artifact | `packages/coding-agent/dist/omp` |
| Installed path | `/Users/sheng/.local/bin/omp` |
| SHA-256 | `c996794e7919008d2752260f55198375a0bb2195bbbcb24fbe73f0defb7ddc05` |
| Native SHA-256 | `6c79bfbd95a3626a038c5f21b4d00636a23e32c8480f2b3ff114821e16474c27` (source and installed cache match; sentinel `__piNativesV17_1_8`) |
| Rollback backup | `/Users/sheng/.local/bin/omp.pre-local-build` |
| Artifact type | signed arm64 Mach-O executable |
| Gates | Biome safe fixes for the pre-existing check failures; `bun --cwd=packages/coding-agent run check`; production binary build; artifact version/help/stats/type/signature/checksum and `--smoke-test`; installed path/type/signature/version/checksum and `--smoke-test`; native source/cache checksum |

The installed checksum matched the build artifact, both artifact and installed
`--smoke-test` returned `smoke-test: ok`, and the installed command resolved to
`/Users/sheng/.local/bin/omp`. The worktree started clean; the formatter fixes
and this baseline update remain uncommitted. No commit or official upgrade
command was run, and the previous installed command remains available at the
rollback path above.
