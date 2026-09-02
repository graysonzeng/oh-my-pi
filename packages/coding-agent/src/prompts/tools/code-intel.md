Project understanding for unknown locations, call edges, ownership, and cross-module relationships. Returns one CCE_SEARCH_RESULT evidence envelope.

<instruction>
- Default first search for unknown location / call chain / ownership / data flow. Known exact path+symbol → `read` or `lsp` instead.
- `query` states intent in the user's language. Do not guess a directory as a hard filter; `path` is only a clue.
- `depth`: omit or `auto` (relationship words deepen). `focused` locates and stops. `extended` is at most two verified hops.
- Evidence kinds: `exact` (literal name), `reference` (LSP / verified call-expression), `source-read` (graph/name tags), `semantic` (unverified similarity).
- `calls` / `called by` appear ONLY from LSP call hierarchy or a verified call-expression. Semantic hits and identifier tags are never call edges.
- Tests, logs, builds, git, and external docs are out of scope.
</instruction>

<critical>
- Treat only envelope evidence lines as facts. Prose in `intent`/`gaps` is not a proven call edge.
- `NOT_FOUND` means the layers searched found no verified evidence. Read `gaps` before concluding absence.
- Do not install Cursor, open MCP, or retry this query as a Cursor context-engine call.
- Broad multi-round exploration after a focused miss → {{#if scoutAvailable}}Task + scout,{{else}}Task,{{/if}} not chained `code_intel`.
</critical>
