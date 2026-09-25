{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Results
`outputSchema` parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline. `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.
Job IDs are process-local and expire roughly five minutes after settlement. Afterward, use the agent ID with `agent://<id>`.
{{/if}}

# Delegation
Handle small, clear work and bounded lookups directly. Delegate only when expected time savings, necessary independent evidence, or specialist capability outweighs handoff costs; honor explicit user requests for agents.
Use most specific agent.{{#if scoutAvailable}} Delegated read-only research uses `scout` only when broad exploration justifies the handoff, not merely because paths are unknown.{{/if}}{{#if sonicAvailable}} Delegated mechanical implementation uses `sonic`; complex implementation, design, or multi-file contracts use `task`.{{/if}} Prefer one agent to investigate + edit. Omit `agent` only for default (`{{defaultAgent}}`); NEVER specify it.
Do not spawn then immediately enter a wait loop; continue other work until blocked. Review/Gate dual-axis MUST be one `tasks[]` batch.
Shared edits need one integration owner{{#if ircEnabled}}; siblings coordinate via `write agent://<id>`{{/if}}. While a subagent job is running, its declared target files are mid-run state and MUST NOT be overwritten until delivery or cancellation. Set interfaces in {{#if batchEnabled}}`context`{{else}}the task{{/if}}. Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.

# Inputs
`name`: CamelCase ≤32, auto-generated if omitted; address agent by name. `outputSchema` overrides agent/session schemas.
{{#if evalToolsEnabled}}`tools`: eval-defined, run in your kernel.
{{/if}}{{#if effortEnabled}}`effort`: `"lo"`|`"med"`|`"hi"` by complexity.
{{/if}}`schemaMode`: default permissive warns after retries; strict fails.
{{#if isolationEnabled}}{{#if applyIsolatedChanges}}`isolated`: worktree; successful changes apply to parent.
{{else}}`isolated`: worktree; changes retained, not applied.
{{/if}}{{/if}}Children start blank;{{#if ircEnabled}} parent IRC arrives after the current tool batch; urgent corrections use interrupt delivery;{{/if}} large payloads via `local://<path>`, NEVER inline.

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Constraints`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}: {{description}}
{{/list}}{{/if}}
