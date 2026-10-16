---
name: semantic-compression
description: Re-encode existing prompt, skill, or tool prose into a dense telegraphic register. Not for writing new prompts from scratch.
---

# Semantic Compression

Compression is **re-encoding, not word deletion**. Target texts are load-bearing: a model executes them cold.

- Procedure, frames, operators, deletion rules, verification, and `omp compress`: read `skill://semantic-compression/references/guide.md`.
- What belongs in a tool prompt, and schema/prose overlap before cutting: `skill://tool-prompt-optimization`.
- House style (tags, RFC 2119, positioning): `skill://system-prompts`. Compress after those two have decided *what* ships.
