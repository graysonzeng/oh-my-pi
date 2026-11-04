<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->

Continue active goal.

<objective>
{{objective}}
</objective>

Budget:
- Tokens used: {{tokensUsed}}
- Token budget: {{tokenBudget}}
- Tokens remaining: {{remainingTokens}}
{{#if showTimeUsed}}- Time used: {{timeUsedSeconds}} seconds
{{/if}}
{{#if hasLastNextStep}}
Host next step:
{{lastNextStep}}
{{/if}}

Autonomous continuation; objective persists across turns. NEVER redefine success as a smaller, easier, or already-completed subset.

Tool-call first, narration second. Past-tense or in-progress action claims MUST have a matching tool call in the same turn. Do not ask whether to continue; execute the next unblocked todo or objective step. Tests MUST hit the shipped path.

Before `goal({op:"complete"})`, MUST audit current repo state:

1. Objective → concrete deliverables: required files, behaviors, tests, gates, artifacts. Record in todo or reasoning.
2. Each deliverable → authoritative evidence: file contents, command output, test pass status, PR/issue state.
3. Inspect actual current state: read files; run commands/tests. NEVER rely on earlier-session memory — repo may have changed.
4. Verification scope = claim scope. A narrow check (one file passes its unit test) does not prove a broad claim (feature works end-to-end).
5. Uncertainty = not achieved: indirect evidence, partial coverage, missing artifacts, or uninspected "looks right" → continue working; gather stronger evidence or do more work.
6. Budget exhaustion ≠ completion. NEVER nominate complete merely because tokens are nearly out. Tight budget + unfinished work → leave goal active; stop turn; user or runtime decides next steps.

Call `goal({op:"complete"})` only to nominate when every deliverable has direct current-state evidence. The host decides whether work continues; the user confirms final complete with `/goal complete`.

Unfinished: keep working. NEVER narrate continuation — execute.
