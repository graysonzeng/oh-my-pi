---
description: "Read for pi-catalog imports, model metadata, generation, or resolver changes."
globs: ["packages/catalog/**", "packages/**/*.ts", "packages/**/*.tsx"]
---

# Catalog

## Import Boundary

- Import catalog values—bundled models, thinking helpers, identity, descriptors, manager, cache—from `@oh-my-pi/pi-catalog/<module>`; NEVER from `@oh-my-pi/pi-ai`.
- `@oh-my-pi/pi-ai` re-exports only model/effort types used by its signatures (`Model`, `Api`, `ThinkingConfig`, `Effort`, …). Type-only imports of those types remain valid.

## Generated Model Data

- NEVER edit `packages/catalog/src/models.json` directly. It is generated from models.dev, provider discovery, and OpenCode documentation.
- Resolution rules and per-ID overrides belong in the relevant resolver, including `packages/catalog/src/provider-models/openai-compat.ts` and `createOpenCodeApiResolution`'s override map.
- Provider defaults, discovery factories, and flags belong in `CATALOG_PROVIDERS` at `packages/catalog/src/provider-models/descriptors.ts`.
- Premium multipliers, Codex pricing fallbacks, fallback models, and post-processing belong in `packages/catalog/scripts/generate-models.ts`.
- Thinking policies belong in `packages/catalog/src/model-thinking.ts` (`applyGeneratedModelPolicies`). Family/version parsing belongs in `packages/catalog/src/identity/classify.ts`.
- Regenerate with `bun run gen:models`; include `models.json` with its source change.
- Regression tests MUST target the resolver or descriptor, not bundled JSON, so upstream metadata changes do not invalidate them.
