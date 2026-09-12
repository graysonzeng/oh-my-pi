---
name: system-prompts
description: Write or edit system prompts and agent definitions. Use when authoring model-facing system prompts. Not for ordinary code, commits, or user replies.
---

# System Prompts

House style: dense, imperative, RFC-keyed.

- Small models (≤2B; tiny/on-device, e.g. LFM2): read `skill://system-prompts/small-models.md`. Several rules invert at that scale.
- Tags, RFC 2119, density, voice, positioning, anti-patterns, checklist, and tool-prompt anatomy: read `skill://system-prompts/references/guide.md`.
- Compressing existing prompt text: `skill://semantic-compression`. Auditing `prompts/tools/` against schema: `skill://tool-prompt-optimization`.
