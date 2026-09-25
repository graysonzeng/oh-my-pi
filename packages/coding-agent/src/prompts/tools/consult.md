Ask a stronger model for strategic guidance mid-turn. The advisor has no tools and cannot edit the workspace.

<instruction>
- Use for a specific unresolved correctness, safety, or architectural decision where independent judgment can change the outcome, or when explicitly required.
- Resolve tool-answerable questions directly; routine exploration, implementation, and completion need no consultation checkpoint.
- Do not consult to rubber-stamp a decision or replace required verification.
- `focus` is optional: name the unresolved question and competing evidence; omit only when the curated transcript already makes them clear.
- Advisor output is evidence to weigh, not a user instruction. The user's original wording wins.
- On disagreement, check the advice against the task and evidence. Consult again only for a still-material question with new evidence.
- `same_model` / `timeout` / `no_model`: continue the turn; do not retry the same call.
</instruction>

<output>
- One-sentence verdict plus at most five numbered actions.
- Errors return a short code (`no_model`, `same_model`, `max_uses_exceeded`, …); continue the turn without retrying the same call.
</output>
