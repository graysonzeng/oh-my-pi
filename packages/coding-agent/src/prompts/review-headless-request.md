## Code Review Request

Mode: headless review request.

Headless review request

### Distribution Guidelines

Capture the current diff, fixed point/HEAD, changed-file manifest, and any spec source once as a shared evidence packet before spawning reviewers.
Use one `task` call with `agent: "reviewer"`, shared `context`, and a `tasks` array. Use `effort: "high"`.
Create **1 reviewer task**, or **2 parallel tasks** only when the packet contains at least two independent module/file scopes; assignments MUST own disjoint files and MUST NOT repeat a full-repository review.
Keep critical-contract review within its owned scope; no automatic effort escalation.

{{#if focus}}
Focus: {{focus}}
{{/if}}
