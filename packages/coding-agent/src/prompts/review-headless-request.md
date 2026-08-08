## Code Review Request

### Mode

Headless review request

### Distribution Guidelines

Capture the current diff, fixed point/HEAD, changed-file manifest, and any spec source once as a shared evidence packet before spawning reviewers.
Use one `task` call with `agent: "reviewer"`, shared `context`, and a `tasks` array. Use `effort: "med"` by default.
Create **1 reviewer task**, or **2 parallel tasks** only when the packet contains at least two independent module/file scopes; assignments MUST own disjoint files and MUST NOT repeat a full-repository review.
Only when one owned scope changes a critical contract boundary—cross-module/public API, persisted schema, authentication/authorization, protocol, compatibility migration, or externally consumed configuration—use `effort: "hi"` for that one task; the reviewer agent caps this at `xhigh`.

{{#if focus}}
### Focus

{{focus}}
{{/if}}
