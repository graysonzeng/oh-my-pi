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

Last updated: 2026-09-03 (Asia/Shanghai).

| Item | Verified value |
|---|---|
| Source commit | `8ff3af0dcb` / `8ff3af0dcbf2fd290e02d1db65c411cc1f4f8c59` (`v17.1.9-3916-g8ff3af0dcb`). Built from the current checkout at this HEAD, including uncommitted `requestModelId` wiring for custom models.yml entries. Unrelated docs, tests, changelog changes, plans, specs, and handoffs were preserved. |
| Package version | `omp/18.0.5` |
| Artifact | `packages/coding-agent/dist/omp` |
| Installed path | `/Users/sheng/.local/bin/omp` |
| SHA-256 | `efeed31ca62fa5beeb0a7ea82915d37213059e2b0ce74562244d3202d180e654` |
| Native SHA-256 | `00b2f04d9983ea6d5ff61782388f320bbaed47433867a0ce6c9355f8c75e6abd` (embedded `packages/natives/native/pi_natives.darwin-arm64.node`, sentinel `__piNativesV18_0_5`; matches `~/.omp/natives/18.0.5/pi_natives.darwin-arm64.node`) |
| Rollback backup | `/Users/sheng/.local/bin/omp.pre-local-build` (`448eeb9d77dfad49dc47627b37fa8f1474d4c92c5b1cd9e13cda326cf3a7cd96`, previous `omp/18.0.5` from `2f8d2b09a5`) |
| Artifact type | adhoc-signed arm64 Mach-O executable |
| Gates | `bun --cwd=packages/coding-agent run check` (biome 3069 files + tsgo) exit 0; production binary build; artifact version/`--help`/`stats --summary`/type/signature/checksum/`--smoke-test`; staged install signature; installed path/type/version/checksum/`--smoke-test`; live `omp --print --model gateway/deepseek-v4-flash` returned `stopReason: stop` with `PONG` |

The installed checksum matched the build artifact, both artifact and installed
`--smoke-test` returned `smoke-test: ok`, and the installed command resolved to
`/Users/sheng/.local/bin/omp` (`omp/18.0.5`). The previous installed command
remains available at the rollback path above.
