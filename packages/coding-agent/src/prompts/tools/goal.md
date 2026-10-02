Manage active goal-mode objective.

Single `op` field:
- `create`: starts goal; enables goal mode. Requires `objective`; optional positive `token_budget`. Only when no goal exists and none is paused.
- `get`: returns current active/paused goal and remaining token budget.
- `resume`: re-activates paused goal for continued work.
- `complete`: nominates completion. Host checks must pass; the user confirms with `/goal complete`. NEVER because budget is low or the turn is ending.
- `drop`: discards current goal without completing it.

Paused goal from `get` → MUST `resume` before continuing work.
