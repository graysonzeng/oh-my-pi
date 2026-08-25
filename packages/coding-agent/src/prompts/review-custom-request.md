## Code Review Request

Mode: custom instructions.

## Distribution

Use `task`: `agent: "reviewer"`, `tasks` array. Create exactly **1 reviewer task**; assignment MUST include custom instructions.

Use the `task` tool with `agent: "reviewer"`, shared `context`, and a `tasks` array.
Create exactly **1 reviewer task**. Put the custom instructions and referenced evidence in `context`; keep the assignment scoped.
Use `effort: "med"` by default. Only when the custom instructions explicitly target a critical contract boundary—cross-module/public API, persisted schema, authentication/authorization, protocol, compatibility migration, or externally consumed configuration—use `effort: "hi"`; the reviewer agent caps this at `xhigh`.

### Reviewer Instructions

Reviewer MUST:
1. Follow the custom instructions below.
2. Read only referenced files and direct producer/consumer call sites needed to prove a finding; NEVER scan unrelated modules.
3. Use incremental `yield` sections for findings and verdict fields; do NOT call a separate finding tool.

## Custom Instructions

{{instructions}}
