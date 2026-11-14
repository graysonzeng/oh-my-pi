# Research: Per-Model Optimization Evidence Review

**Date**: 2026-07-25  
**Scope**: Evidence check for `docs/superpowers/specs/2026-07-25-per-model-optimization-design.md`  
**Method**: Primary/official docs preferred; secondary blogs labeled.

## Summary

v1 design correctly identifies **tool-output noise**, **repo-map**, **structured eviction**, and **model routing** as levers — but overstates savings as whole-session facts, misstates implementation status (much already shipped), and conflates simplified heuristics with full CWL.

## Verified claims

### CLI output compression (RTK)

- **Fact**: [RTK](https://github.com/rtk-ai/rtk) filters/compresses command outputs; project claims 60–90% reduction on bash/CLI payloads.
- **Fact**: [Kilo discussion #5848](https://github.com/Kilo-Org/kilocode/discussions/5848) relays author claim of ~10M tokens / ~89% over ~2 weeks.
- **Fact (RTK README caveat)**: Measured savings are on tool/CLI output; not identical to total bill; absolute tokens estimated as bytes/4.
- **Implication for omp**: Prioritize bash/test/git summarizers + smart truncation; do not promise 40–70% total without baseline.

### Aider repo-map

- **Fact**: [Aider repomap docs](https://aider.chat/docs/repomap.html) — tree-sitter symbols + graph ranking; default map budget ~1k tokens.
- **Inference**: Useful for orientation under tight budgets; agentic search (Claude Code style) may win on large/changing repos.
- **omp status**: `repo-map-builder.ts` uses regex extraction today (not tree-sitter).

### Structured context eviction (CWL)

- **Fact**: [arXiv:2606.11213](https://arxiv.org/abs/2606.11213) — CWL with typed episodes, dependency graph, deterministic eviction; paper reports 89 sequential tasks / ~80M tokens without measurable accuracy drop vs isolated sessions.
- **Fact**: Reference impl [pi-cwl](https://github.com/Kiz8-Team/pi-cwl) requires agent delimiter annotations.
- **Inference**: omp's `context-evictor` is CWL-*inspired*, not full CWL.

### Cursor Router

- **Vendor claim**: [Cursor Router announcement](https://cursor.com/blog/router) (~2026-07-22) — online A/B ~60% savings vs single frontier default; early-access enterprise 30–50% vs all-Opus pricing.
- **Fact**: Modes Intelligence / Balance / Cost; Teams/Enterprise availability per changelog.
- **Caveat**: Vendor-measured; treat as directional.

## Model feedback (provisional / secondary)

| Claim in v1 | Evidence status |
|-------------|-----------------|
| Fable 5 strongest for hard coding | Secondary consensus (SWE-bench Pro lead cited); price premium |
| GPT-5.6-sol Terminal-Bench lead | Vendor/secondary charts; METR reward-hacking caveats in secondary writeups |
| Opus 4.8 should be demoted | Contested — some agencies still prefer for production |
| GLM-5.2 ≈ Opus at fraction cost | Z.ai/open-weights strong; independent notes ~3.3× more tokens → net ~½ Opus, not "零头"; context often **1M** not 128k |
| Sonnet 5 uniquely ignores instructions | Weak — Claude Code instruction-ignore spans models ([#2901](https://github.com/anthropics/claude-code/issues/2901), [#3377](https://github.com/anthropics/claude-code/issues/3377)) |
| Fable 5 = 200k context | Conflicts with secondary ~1M citations — **need primary docs** |

## Competitive positioning (inference)

Quality-first routing + tool-output hygiene + light repo-map is a credible omp differentiator. Claiming "surpass Claude Code accuracy by +10–20%" without omp baseline measurement is premature.

## Sources

1. https://github.com/rtk-ai/rtk  
2. https://github.com/Kilo-Org/kilocode/discussions/5848  
3. https://aider.chat/docs/repomap.html  
4. https://arxiv.org/abs/2606.11213  
5. https://cursor.com/blog/router  
6. https://z.ai/blog/glm-5.2  
7. https://github.com/anthropics/claude-code/issues/2901  
