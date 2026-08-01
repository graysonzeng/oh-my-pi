---
description: "Read before editing TypeScript; repository type/import/export/privacy conventions."
globs: ["**/*.ts", "**/*.tsx"]
---

# TypeScript

- AVOID `any`; use it only when unavoidable.
- NEVER use `ReturnType<>`; name the actual type.
- NEVER use inline or dynamic imports: no `await import()` or `import("pkg").Type`. Use top-level imports.
- External API types? Inspect `node_modules`; NEVER guess.
- Barrel files SHOULD use `export * from "./module"`, including type-only and single-specifier exports. Star ambiguity? Remove the redundant export path; NEVER preserve duplicates with named re-exports.
- Class internals MUST use ES `#private`; externally accessible members stay bare. NEVER use `private`, `protected`, or `public` on fields or methods, except TypeScript-required constructor parameter properties such as `constructor(private readonly session: ToolSession)`.
- Use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- TypeScript verification MUST use `bun check`; NEVER run `tsc` or `npx tsc`.
