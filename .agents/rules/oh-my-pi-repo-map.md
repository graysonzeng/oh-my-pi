---
description: "Locate package ownership before cross-package or unfamiliar work."
globs: ["packages/**", "crates/**", "python/**"]
---

# Repository Map

| Path | Ownership |
| --- | --- |
| `packages/ai` | Multi-provider LLM client and streaming |
| `packages/catalog` | Bundled model catalog, provider descriptors, identity, classification |
| `packages/agent` | Agent runtime, tool calling, state management |
| `packages/coding-agent` | Main CLI application and default work scope |
| `packages/tui` | Differential-rendering terminal UI library |
| `packages/natives` | Native text, image, and grep bindings |
| `packages/stats` | Local `omp stats` observability dashboard |
| `packages/omptype` | ArkType-compatible schema validation with a lazy JIT runtime |
| `packages/utils` | Shared logger, streams, and temporary-file utilities |
| `crates/pi-natives` | Performance-critical Rust text and grep operations |
