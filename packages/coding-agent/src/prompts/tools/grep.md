Regex: Rust, then PCRE2. `path`: `;`-separated file/dir/glob/URL; default `.`. Default case-sensitive, gitignore respected; `skip` paginates files.
File-only selector: `src/foo.ts:50-100`; selectors never choose the search root. Literal `\n`/`\\n` enables cross-line. `ssh://` search targets files, not directories.
Start narrow. Broad searches can time out; scope them narrowly or use `glob` first. Independent greps whose patterns and roots are already known MUST share one turn.
{{#if hasFind}}Behavior/unknown symbol → `find`; literals/regex → `grep`.{{/if}}
Handle bounded searches directly.{{#if eagerDelegation}} Broad multi-round exploration → {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}} only when delegation benefits outweigh handoff costs.{{/if}}
