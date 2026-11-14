Managed skill: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; surfaced as a normal skill in future sessions.

Use: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.
User-authored skills separate; tool NEVER edits them.

- `action: "create"` — fails if skill exists.
- `action: "update"` — overwrites body; fails if skill absent.
- `action: "delete"` — fails if skill absent.

`name`: kebab-case (lowercase letters, digits, hyphens).
`description`: one line, ≤160 characters. What the skill does and when it applies; add a "Not for …" exclusion when nearby tasks would otherwise trigger it. Drives discovery; keep it short so it is not diluted in the skill list.
No frontmatter in `body`; generated from `name` and `description`.
