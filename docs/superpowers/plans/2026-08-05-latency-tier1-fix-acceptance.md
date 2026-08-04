# Latency Tier-1 Fix Acceptance

- Date: 2026-08-05
- Package: `packages/coding-agent/`
- Design: `docs/superpowers/plans/2026-08-04-latency-tier1-fix-and-profile-design.md`
- Pilot residual: `docs/superpowers/plans/2026-08-04-latency-tier1-live-pilot-receipt.md`

## Scope delivered

| ID | Acceptance | Status | Evidence |
|---|---|---|---|
| A1 | Two identical bash failures differing only by wall-time share one fingerprint and fire advisory | Pass (unit) | `test/latency/bash-attempt-ledger.test.ts` wall-time case |
| A2 | Ordinary session, opt+profile+readDedupe: second full read → model-visible `context ref` | Pass (integration) | `test/latency/read-dedupe-ordinary-session.test.ts` (sessioned + in-memory) |
| A3 | `gateway/gpt-5.6-luna` / terra / sol / grok gateway ids resolve built-in profiles when enabled | Pass (unit) | `test/model-optimization/profile-resolver.test.ts` gateway production cases |
| A4 | All latency arms remain default-off | Pass | `test/latency/contracts.test.ts` |
| A5 | Targeted tests + no new type errors in touched paths | Pass | Commands below |

## What changed

1. **bash fingerprint**: `normalizeBashFailureExcerpt` strips `Wall time: …` noise so repeated `false` (or other exit≠0 with only wall-time drift) collides and can emit advisory.
2. **built-in profiles**: added `luna` / `terra` / `sol` (priority 10, deterministic truncation only, summarizer off) and expanded `grok` patterns for gateway ids.
3. **read dedupe verify**: `SessionManager.getArtifactContent` verifies path-backed **and** no-session in-memory artifacts; `#verifyReadArtifact` uses content SHA, not path-only.

## Explicit non-claims

- No latency arm default flipped to `true`.
- No ≥30-pair formal savings claim; this is a correctness fix for pilot residuals.
- Live 1-shot optional; unit/integration covers the residual failure modes.

## Verification commands

```bash
cd packages/coding-agent
bun test test/latency/bash-attempt-ledger.test.ts \
  test/latency/read-dedupe.test.ts \
  test/latency/read-dedupe-ordinary-session.test.ts \
  test/latency/read-identity-production.test.ts \
  test/latency/contracts.test.ts \
  test/model-optimization
# Touched-path type filter: no errors under latency|model-optimization|session-manager|agent-session|default-profiles|profile-resolver|read-dedupe
```

## Rollback

```yaml
modelOptimization.enabled: false
latency.arms.readDedupe: false
latency.arms.bashAdvisory: false
```
