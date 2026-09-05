# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool — questions about its behavior refer to code in `packages/coding-agent/`, not your current session.

Path-matched domain rules under `.agents/rules/` own TypeScript, Bun, prompts, catalog, coding-agent runtime, testing, changelog/release, and local install. Load those when the target path matches; do not copy them here.

## GitHub

Unless user tells you exactly what to write:

- **Never comment on GitHub** (issues, PRs, discussions).
- **Never create issues on GitHub**.

**Prompts**: never build prompts in code (no inline strings, template literals, or concatenation). Prompts live in static `.md` files; use Handlebars for dynamic content. Import them via `import content from "./prompt.md" with { type: "text" }` — not `readFile`.

## Commands

- NEVER commit unless asked.
- Never use `tsc`/`npx tsc` — always `bun check`.
- Never run `cargo test` directly for Rust tests — use `bun run test:rs`. It runs `cargo nextest run` (config: `.config/nextest.toml`) followed by a `cargo test --doc` pass, because nextest does not execute doctests. The doctest pass currently executes nothing (pi-natives is a `cdylib`, which rustdoc skips; pi-builtins' examples are `ignore`d vendored uutils docs) and exists so the first runnable doctest added to a lib crate is actually run.
- Merge commits (maintainer merges of PRs) follow: `Merge PR #<number>: <conventional PR subject> (@<author>)` — e.g. `Merge PR #6386: feat(catalog): add native Meta Model API provider (@eggpeat)`.

## Rust Build Profiles

Profiles live in the root `Cargo.toml`; `.cargo/config.toml` carries the settings Cargo.toml cannot express. Both are committed, so no local `~/.cargo/config.toml` is required.

| Profile | Use |
| --- | --- |
| `dev` | Default. Line tables for our crates, no debuginfo for deps, deps at `opt-level = 2`. |
| `release` | Shipping build: fat LTO, 1 codegen unit, stripped. |
| `local` | Fast local release iteration: thin LTO, 16 codegen units, incremental. |
| `profiling` | `release` codegen with symbols kept, for `perf`/`samply`/Instruments. |
| `ci` | Thin LTO, no debuginfo, stripped. |

**Never set `split-debuginfo = "off"` on a profile that has debuginfo.** On Mach-O the linker never merges DWARF into the executable — it writes a debug map (`N_OSO`) pointing at the `.o` files, and `"unpacked"` is what keeps those files. With `"off"` every backtrace frame in our own crates silently loses `file:line`; the `panicked at foo.rs:3` header still prints (that is `#[track_caller]`, not debuginfo), which makes the loss easy to miss. `ci` may use `"off"` only because it sets `debug = false`.

`embed-metadata = false` (in `.cargo/config.toml`) keeps crate metadata in `.rmeta` instead of duplicating it into every rlib — measured 196 MB → 130 MB on a reqwest-sized graph at identical build times. Its accepted spelling is toolchain-coupled; keep it in sync with `rust-toolchain.toml`.

Rejected, with measurements, so nobody re-litigates them: **sccache** (cannot cache incremental, bin, or proc-macro crates — measured slower than not using it), **mold** (ELF-only; no Mach-O support), and **`panic = "abort"` on `dev`** (Cargo ignores `panic` for the test profile, so the whole dep graph builds twice — 131 MB → 214 MB).
