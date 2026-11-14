---
description: "Read only when building/installing this checkout's omp binary locally."
globs: ["packages/coding-agent/**", "docs/local-build-install.md", "scripts/link-omp.sh"]
---

# Local `omp` Installation

On this workstation, “update `omp`” means build this checkout and install `packages/coding-agent/dist/omp` by following `docs/local-build-install.md`. NEVER use the release installer, Homebrew, or a registry global upgrade unless explicitly requested.

A matching version is insufficient. Verify:

- The installed file is the compiled binary.
- Its checksum matches the build artifact.
- The installed path passes `omp --smoke-test`.

After installation, update the verified baseline in `docs/local-build-install.md` with commit, checksum, installed path, backup path, and gates actually run.
