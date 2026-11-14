---
name: tool-prompt-optimization
description: Audit existing prompts/tools/*.md vs the tool JSON schema. Use when measuring overlap before deleting prompt lines. Not for new system prompts.
---

# Tool Prompt Optimization

Prompt/schema overlap is a prune *candidate*, never an automatic delete.

- Probe command, inputs, interpretation, caveats, and tool-prompt anatomy: read `skill://tool-prompt-optimization/references/guide.md`.
- Builtin shortcut (this repo): `bun .omp/skills/tool-prompt-optimization/scripts/probe-builtin.ts --tool <name> [--show]`.
- Writing a new system prompt or agent definition: `skill://system-prompts`. Re-encoding already-approved prose: `skill://semantic-compression`.
