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

Last updated: 2026-08-31 (Asia/Shanghai).

| Item | Verified value |
|---|---|
| Source commit | `aa9b9233af` / `aa9b9233af86d2aff303ad387bc192daa40240af` (worktree dirty only in this baseline doc; `v17.2.12-2482-gaa9b9233af`) |
| Package version | `omp/18.0.5` |
| Artifact | `packages/coding-agent/dist/omp` |
| Installed path | `/Users/sheng/.local/bin/omp` |
| SHA-256 | `949289c296a50bd165ba260559fbd6f600e9cec0f8aeb982487e6792336b32b0` |
| Native SHA-256 | `237fc586419742a606870aaf98ce8affdf6c2c35972a247f3e6a9b11de75adb7` (embedded `packages/natives/native/pi_natives.darwin-arm64.node`, sentinel `__piNativesV18_0_5`) |
| Rollback backup | `/Users/sheng/.local/bin/omp.pre-local-build` |
| Artifact type | adhoc-signed arm64 Mach-O executable |
| Gates | `bun --cwd=packages/coding-agent run check` (biome 3059 files + tsgo) exit 0; production binary build; artifact type/signature/version/checksum and `--smoke-test`; installed path/type/version/checksum and `--smoke-test` |

The installed checksum matched the build artifact, both artifact and installed
`--smoke-test` returned `smoke-test: ok`, and the installed command resolved to
`/Users/sheng/.local/bin/omp` (`omp/18.0.5`). The binary was built from commit
`aa9b9233af` (`v17.2.12-2482-gaa9b9233af`); the only worktree change at verify
time is this baseline document. The previous installed command remains available
at the rollback path above.
