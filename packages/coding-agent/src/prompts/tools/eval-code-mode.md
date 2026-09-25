{{baseDescription}}

Programmatic tool calling is active: this tool is your primary work surface and the direct tool surface is restricted.
Plan multiple operations into ONE cell whenever the next steps are known, calling session tools via `await tool.<name>(args)`;
spawn independent calls without awaiting, then `await Promise.all([…])`. Prefer `tool.*` over host I/O (`fetch`, `fs`, `Bun.file`) so operations flow through the session tool pipeline.
Use `catalog.searchTools(query, { server })` and `catalog.describeTools(names)` to recover schemas that are not listed below.
Reserve separate cells for steps that must inspect earlier results.

bridged tools:
```
{{{catalog}}}
```
{{#if preludeDeclarations}}

{{{preludeDeclarations}}}
{{/if}}
