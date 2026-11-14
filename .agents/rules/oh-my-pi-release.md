---
description: "Read for changelog, merge, release, or release-script work."
globs: ["packages/*/CHANGELOG.md", "scripts/release.ts", "scripts/fix-changelogs.ts", ".omp/commands/release.md"]
---

# Changelog, Merge, and Release

Maintainer merge commits MUST use:

```text
Merge PR #<number>: <conventional PR subject> (@<author>)
```

Example: `Merge PR #6386: feat(catalog): add native Meta Model API provider (@eggpeat)`.

## Changelogs

Changelogs live at `packages/*/CHANGELOG.md`. Add entries under `## [Unreleased]` in this order:

1. `### Breaking Changes` (first when present)
2. `### Added`
3. `### Changed`
4. `### Fixed`
5. `### Removed`

- NEVER modify released sections such as `## [0.12.2]`; they are immutable.
- NEVER flag section ordering or formatting during review: `bun run release` invokes `fix-changelogs` to normalize it.
- Internal issue attribution: `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`.
- External contribution attribution: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.

## Release

`.omp/commands/release.md` is the authoritative release procedure. Read and follow it for version selection, preflight, changelog finalization, publishing, CI monitoring, and CI-failure recovery; NEVER maintain a duplicate procedure here.
