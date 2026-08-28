Searches files/internal URLs: Rust regex, PCRE2 fallback.

<instruction>
- `path`: scope to known files, directories, globs, or internal URLs; separate roots with `;`.
  Line selector on one file (`src/foo.ts:50-100`); selectors never choose search root.
- Start narrow. Unknown target? Inspect the first page, then narrow; paginate only if needed.
- Broad searches can time out; scope them narrowly or use `glob` first.
- Independent greps whose patterns and roots are already known MUST share one turn.
- `ssh://` search targets files, not directories. Read the directory, then grep selected files.
- Cross-line patterns from literal `\n` or `\\n` in `pattern`.
</instruction>

<critical>
- MUST use instead of shell `grep`/`rg`.
- Open-ended multi-round search MUST use {{#if scoutAvailable}}Task + scout,{{else}}Task,{{/if}} not chained calls.
</critical>
