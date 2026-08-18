Searches files and internal URLs with Rust regex plus PCRE2 fallback.

<instruction>
- `path`: scope to known files, directories, globs, or internal URLs; separate roots with `;`.
  Line selector on one file (`src/foo.ts:50-100`); selectors never choose search root.
- Start narrow. Unknown target? Inspect the first page, then narrow; paginate only if needed.
- Broad searches can time out; scope them narrowly or use `glob` first.
- `ssh://` search targets files, not directories. Read the directory, then grep selected files.
- Cross-line patterns from literal `\n` or `\\n` in `pattern`.
</instruction>

<critical>
- MUST use this instead of shell `grep`/`rg`.
- Open-ended multi-round search MUST use Task + scout, not chained calls.
</critical>
