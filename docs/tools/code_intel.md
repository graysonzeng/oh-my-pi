# code_intel

> Native project understanding. One query returns a `CCE_SEARCH_RESULT` evidence envelope without Cursor CCE.

## Source
- Entry: `packages/coding-agent/src/tools/code-intel.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/code-intel.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/code-intel-envelope.ts` — wire grammar render/parse
  - `packages/coding-agent/src/tools/code-intel-merge.ts` — token extraction and provenance merge
  - `packages/coding-agent/src/tools/code-intel-lsp.ts` — read-only LSP facade including call hierarchy
  - `packages/coding-agent/src/tools/code-intel-index.ts` — generation snapshot lifecycle
  - `packages/coding-agent/src/tools/code-intel-embed.ts` — local-only embedding resolver
  - `crates/pi-natives/src/code_intel.rs` — tags, PageRank, chunks, call-expression capture

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Intent in the user language. 1–20000 characters. Do not guess a directory as a hard filter. |
| `depth` | `auto` \| `focused` \| `extended` | No | Default from `codeIntel.depthDefault` (`auto`). Relationship words deepen `auto` to `extended`. |
| `path` | string | No | Workspace-relative clue. Zero hits expand to the whole workspace. |

## Outputs
- Single text block: a `CCE_SEARCH_RESULT` envelope (`intent`, `coverage`, `evidence`, `gaps`, `confidence`).
- Empty verified evidence renders `NOT_FOUND` under `evidence`.
- `details` records layer success (`grep` / `graph` / `lsp` / `semantic`) and index state (`ready` / `warming` / `disabled` / `unavailable`).
- Approval is always `"read"`. The LSP facade cannot send rename/apply/executeCommand.

## Layers
1. Literal grep of query tokens (`grep-exact`).
2. Identifier tags + PageRank from a committed generation snapshot (`graph-ranked-context` / `syntactic-name-reference`). Call-expression captures may emit `call-expression`.
3. Read-only LSP: workspace/symbol, references, definition, implementation, call hierarchy (`lsp-reference` / `lsp-call`).
4. Optional local embeddings (`semantic-candidate`). Semantic rows never render `calls` / `called by`. English-only BGE does not count as a Chinese-query quality proof.

## Index
Snapshots live at `~/.omp/code-intel/<sha256(canonical project dir)[0..16]>/`. Queries read `CURRENT`. Warm writes `generations/<id>.tmp` then atomically publishes. A crashed `.tmp` directory is never current.

## Errors
- Empty/oversized `query` is a normal tool error, not an envelope.
- Missing natives symbols skip graph/chunk layers and record `native code_intel symbol missing; restart omp after upgrade`.
- Timeout (default 30s, range 5–180) returns the partial envelope plus a timeout gap.
- Remote embedding URLs/models disable the semantic layer. The tool never opens Cursor MCP or remote embedding HTTP.
