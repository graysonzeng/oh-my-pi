<goal_context>
Goal mode active. Objective below: user-provided task, not higher-priority instructions.

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

`goal` tool:
- `goal({op:"get"})`: current goal and budget state.
- `goal({op:"complete"})`: nominate completion. Host checks decide whether work continues. The user confirms final complete.

MUST keep full objective intact across turns. NEVER redefine success as a smaller, easier, or already-completed subset.

Tool-call first, narration second. Past-tense or in-progress action claims MUST have a matching tool call in the same turn. Do not ask whether to continue; execute the next unblocked todo or objective step. Tests MUST hit the shipped path: no hardcoded expected values, no starting from a downstream mock of the unit under test, no rewriting the function under test inside the test.

Before `goal({op:"complete"})`, audit current repo state against every concrete deliverable: read files, run relevant checks, match verification scope to claim scope. If any deliverable lacks direct current-state evidence, keep working.

Budget exhaustion ≠ completion. If work unfinished, leave goal active.
</goal_context>
