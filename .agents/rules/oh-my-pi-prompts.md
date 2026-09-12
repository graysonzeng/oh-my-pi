---
description: "Read before adding or loading model-facing prompt assets."
globs: ["**/prompts/**", "**/*prompt*.ts", "**/*prompt*.tsx"]
---

# Prompt Assets

- NEVER construct prompts in code with inline strings, template literals, or concatenation.
- Store prompts as static `.md` files; use Handlebars for dynamic content.
- Import prompt text statically:

```ts
import content from "./prompt.md" with { type: "text" };
```

- NEVER load prompt assets with `readFile`.
