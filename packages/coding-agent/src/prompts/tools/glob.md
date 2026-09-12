Globs files, directories, and path-backed internal URLs with fast pattern matching.

<instruction>
- `path`: glob, file, directory, or path-backed internal URL; separate targets with `;` (`src/**/*.ts; test/**/*.ts`).
- `memory://` glob patterns are supported. `ssh://` has no local path; use `read`. Other internal URLs accept exact paths only.
- `gitignore` defaults `true`. Set `false` for ignored files such as `.env*`, logs, or build output.
- `hidden` defaults `true`; pair it with `gitignore: false` for ignored dotfiles.
- Independent globs whose patterns are already known MUST share one turn.
</instruction>

<output>
Matches are newest-first and grouped by directory; directories end in `/`.
</output>

{{#if eagerDelegation}}
<avoid>
Handle bounded discovery directly. Broad multi-round discovery → consider {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}} only when delegation benefits outweigh handoff costs.
</avoid>
{{/if}}
