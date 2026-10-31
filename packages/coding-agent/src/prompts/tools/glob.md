Glob files/dirs: `;`-separated paths or internal URLs (`local://*.md`, `omp://**/*.md`); default workspace root. `memory://` globs are supported. `ssh://` has no local path; use `read`.
`gitignore` and `hidden` default true; ignored dotfiles need `gitignore: false`. Newest-first by directory; dirs end `/`.
Independent globs whose patterns are already known MUST share one turn.
{{#ifAny eagerDelegation hasFind}}
{{#if hasFind}}Behavior search → `find`.{{/if}}
{{#if eagerDelegation}}Handle bounded discovery directly. Broad multi-round discovery → {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}} only when delegation benefits outweigh handoff costs.{{/if}}
{{/ifAny}}
