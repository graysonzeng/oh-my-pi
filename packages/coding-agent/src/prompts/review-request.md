## Code Review Request

### Mode

{{mode}}

### Review Evidence Snapshot

Snapshot ID: `sha256:{{snapshotId}}`
{{#if snapshotRef}}Captured full diff: `{{snapshotRef}}` (content-addressed by the snapshot ID).{{else}}Captured full diff: embedded below.{{/if}}

The mode, changed-file manifest, captured diff artifact or inline diff, previews, and additional instructions below are one immutable evidence packet. Every reviewer MUST assess this same snapshot. If the target changes, stop and recapture `/review`; NEVER mix later workspace state into this review.

### Changed Files ({{len files}} files, +{{totalAdded}}/-{{totalRemoved}} lines)

{{#if files.length}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{else}}
_No files to review._
{{/if}}
{{#if excluded.length}}
### Excluded Files ({{len excluded}})

{{#list excluded prefix="- " join="\n"}}
`{{path}}` (+{{linesAdded}}/-{{linesRemoved}}) — {{reason}}
{{/list}}
{{/if}}

### Distribution Guidelines

Use one `task` call with `agent: "reviewer"`, a shared `context`, and a `tasks` array. Put the snapshot ID, captured diff reference, manifest, and instructions in `context` once; task assignments contain only the review axis and owned files.
{{#when agentCount "==" 1}}Create exactly **1 reviewer task**.{{else}}Spawn exactly **{{agentCount}} reviewer agents** in parallel.{{/when}}

Every routine reviewer task MUST use `effort: "med"`.
If and only if the diff changes a critical contract boundary—cross-module/public API, persisted schema, authentication/authorization, protocol, compatibility migration, or externally consumed configuration—designate exactly one of the existing tasks as the critical-contract reviewer and use `effort: "hi"`; the reviewer agent caps this at `xhigh`. NEVER add a duplicate full-scope reviewer.
{{#if multiAgent}}
Partition files into non-overlapping ownership groups:
- Same directory/module → same agent
- Related implementation and tests → same agent
- Critical contract producer, schema, and direct consumer/dispatch point → the one critical-contract agent
- Every file belongs to exactly one task; tasks MUST NOT repeat a full-repository review
{{/if}}

### Reviewer Instructions

Reviewer MUST:
1. Focus ONLY on assigned files, plus direct producer/consumer or dispatch call sites required to prove a finding
2. {{#if snapshotRef}}MUST read the full captured diff from `{{snapshotRef}}` and filter it to assigned files; NEVER rerun VCS for patch content{{else}}{{#if skipDiff}}{{diffInstruction}}{{else}}MUST use the captured diff below (NEVER re-run git diff){{/if}}{{/if}}
3. {{contextInstruction}}
4. Treat snapshot ID `sha256:{{snapshotId}}` as immutable; report stale or missing evidence instead of expanding scope
5. Use incremental `yield` sections for findings and verdict fields; do NOT call a separate finding tool

{{#if skipDiff}}
### Diff Previews

_Full diff is frozen at `{{snapshotRef}}`. Showing first ~{{linesPerFile}} lines per file for assignment planning._

{{#list files join="\n\n"}}
#### {{path}}

{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}

### Diff

<diff>
{{rawDiff}}
</diff>
{{/if}}

{{#if additionalInstructions}}
### Additional Instructions

{{additionalInstructions}}
{{/if}}
