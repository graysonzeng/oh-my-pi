<critical>
Write a handoff document for another instance of yourself.
The handoff MUST be sufficient for seamless continuation without access to this conversation.
Output ONLY the handoff document. No preamble, no commentary, no wrapper text.
</critical>

<instruction>
Capture exact technical state, not abstractions.
- File paths, symbol names, commands run
- Test results, observed failures
- Decisions made
- Partial work affecting the next step
Register: address the successor directly in the imperative ("Fix X", "Run Y") — never first person ("I need to…", "my attempt…").
The handoff mechanism is invisible to the document: NEVER list writing, generating, or delivering a handoff/summary/context document as progress or a next step. Progress and Next Steps cover the user's task only.
</instruction>

<output>
Use exactly this structure:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]

## Progress
### Done
- [x] [Completed tasks with specifics]

### In Progress
- [ ] [Current work if any]

### Pending
- [ ] [Tasks mentioned but not started]

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- Code snippets, file paths, function/type names, error messages, data essential to continue
- Repository state if relevant

## Next Steps
1. [What should happen next]
</output>

<critical>
The handoff document is load-bearing and self-contained. Every conclusion, decision, fact, and next step the reader needs MUST be written inline in this document.

- Inline load-bearing content: objective, authorization, scope, confirmed facts, inferences, selected design, reviewer findings/verdicts (only those actually produced), acceptance criteria, and source citations. A fresh process MUST be able to continue from this document alone.
- Cite stable repository sources by repository-relative path (e.g. `docs/superpowers/specs/….md`). Session artifacts (previous-session files, subagent outputs, transcripts) are cited by their canonical session-store reference (absolute path under the session root), never as repository-relative paths.
- `agent://`, `history://`, `artifact://`, and `local://` URIs are EPHEMERAL session-scoped references. They MAY appear only as non-load-bearing provenance — and only when every conclusion they would support is already stated inline. NEVER present an ephemeral URI as a required next action or as the source of a load-bearing claim.
- If an ephemeral URI would be load-bearing, either inline its content or rewrite it to a canonical session-store reference.
</critical>

{{#if additionalFocus}}
<instruction>
Additional focus: {{additionalFocus}}
</instruction>
{{/if}}
