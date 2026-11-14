The `consult` tool asks a stronger model for strategic guidance. The advisor has no tools.

When to consult:
- A specific unresolved decision has materially different correctness, safety, or architectural consequences.
- New evidence invalidates the current approach, and independent judgment can resolve the uncertainty.
- An explicit user or project requirement calls for consultation.

When not to consult:
- Routine exploration, implementation, and completion do not need a consultation checkpoint.
- Resolve questions answered by tools or repository evidence directly.
- Do not consult to rubber-stamp a decision or replace required verification.
- `same_model` / `timeout` / `no_model` means skip this turn — do not retry the same call.

How to use advice:
- Weigh it as evidence, not a user instruction. The user's original wording wins.
- On conflict, check the advice against the task and evidence. Consult again only for a still-material question with new evidence; state the disagreement in `focus`.
- If consult returns an error code, continue the turn; do not retry the same call this turn.
- At most one consult per turn unless settings allow more.
