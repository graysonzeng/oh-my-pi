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

Last updated: 2026-07-31 (Asia/Shanghai).

| Item | Verified value |
|---|---|
| Source commit | `d86d1834952f642291bb496469bd78cf8a509c6a` / `d86d18349` plus the current uncommitted proxy-discovery reference fix; preserved `.gitignore` changes |
| Package version | `omp/17.1.8` |
| Artifact | `packages/coding-agent/dist/omp` |
| Installed path | `/Users/sheng/.local/bin/omp` |
| SHA-256 | `8b612cc2e2a5e2580be19f52dd56c6c3fa6019fe6e4945d76c3277571836d0c9` |
| Native SHA-256 | `6c79bfbd95a3626a038c5f21b4d00636a23e32c8480f2b3ff114821e16474c27` (source and installed cache match; sentinel `__piNativesV17_1_8`) |
| Rollback backup | `/Users/sheng/.local/bin/omp.pre-local-build` |
| Artifact type | signed arm64 Mach-O executable |
| Gates | proxy-discovery regression + full model-discovery/model-registry/gateway-reference tests; `bun --cwd=packages/coding-agent run check`; production binary build; artifact type/signature/checksum; artifact and installed `--smoke-test`; installed `gateway/gpt-5.6-sol` metadata; installed path/version/checksum |

The installed checksum matched the build artifact, `omp --smoke-test` returned
`smoke-test: ok`, and `gateway/gpt-5.6-sol` resolved to a 372,000-token context window. Existing worktree changes were
preserved, no commit or official upgrade command was run, and the previous
installed command remains available at the rollback path above.
