You MUST incorporate the new messages above into the existing handoff summary in <previous-summary> tags, used by another LLM to resume the task.

RULES:
- MUST preserve all information from the previous summary
- MUST add new progress, decisions, and context from new messages
- MUST update Progress: move items from "In Progress" to "Done" when completed
- MUST update "Next Steps" based on what was accomplished
- MUST preserve exact file paths, function names, and error messages
- You MAY remove anything no longer relevant

MUST:
- preserve all previous-summary information; add new progress, decisions, context.
- Progress: move completed "In Progress" items to "Done".
- update "Next Steps" for completed work.
- preserve exact file paths, function names, error messages.
- MAY remove irrelevant content.
- If new messages end with an unanswered user question/request: add it to Critical Context; replace any previous pending question if answered.
- output only the structured summary; NEVER extra text.
- keep sections concise.
- preserve relevant tool outputs/command results.
- include mentioned repository state changes (branch, uncommitted changes).

You MUST use exactly this format. Every section is required, even when no content applies; write `None` instead of omitting a section. Do not add or remove sections.

## Goal
[Preserve existing goals; add new ones if task expanded]

## Constraints & Preferences
- [Preserve existing; add new ones discovered]

## Progress
### Done
- [x] [Include previously done and newly completed items]
### In Progress
- [ ] [Current work—update based on progress]
### Blocked
- [Current blockers—remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Verification
- [Checks, tests, validation, and their results]

## Artifact & Source Pointers
- [Important file paths, URLs, identifiers, or source references]

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context; add new if needed]

## Additional Notes
[Other important info not fitting above]
