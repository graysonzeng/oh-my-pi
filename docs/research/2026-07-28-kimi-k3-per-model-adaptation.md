# Research: Kimi K3 Per-Model Adaptation

- Date: 2026-07-28
- Scope: whether `packages/coding-agent/` needs per-model adaptation for the newly supported Kimi K3; official capabilities, current-repo coverage, GitHub integration failures, and recent coding-agent user feedback.
- Method: official Moonshot/Kimi documentation first; then reproducible GitHub issues/PRs and recent HN/V2EX/engineering reports for corroboration. Community reports are treated as anecdotes unless independently repeated; protocol changes require official documentation or a reproducible integration failure. URLs accessed 2026-07-28. No live K3 API request was made.

## 1. Conclusion

Kimi K3 **does** need per-model adaptation, but a narrow, evidence-backed one. Six items have direct official documentation support and are not safely handled by a generic OpenAI-compatible policy:

1. **Preserved Thinking is mandatory and always on.** K3 always reasons; the harness must replay the complete assistant message (including `reasoning_content` and `tool_calls`) verbatim on every subsequent request, or — per the official tech blog — "generation quality may become highly unstable." Switching an ongoing session from another model to K3 is explicitly discouraged by Moonshot.
2. **Reasoning effort vocabulary differs from OpenAI.** Top-level `reasoning_effort` accepts only `"low" | "high" | "max"` (default `"max"`); there is no `"medium"`/`"minimal"`/`"xhigh"`. Changing effort mid-session invalidates the prefix cache, so effort should be fixed at session start.
3. **Sampling parameters are frozen.** `temperature=1.0`, `top_p=0.95`, `n=1`, `presence_penalty=0`, `frequency_penalty=0` are fixed; passing other values returns an error. A policy layer must omit them for `kimi-k3`.
4. **Tool-choice surface is K3-specific.** `tool_choice` supports `auto`/`none`/`required` (K3 is the only current Kimi model with `required`), but forcing a specific tool via a function object returns 400 because thinking is always enabled. Parallel tool calls arrive as multiple `tool_calls` in one message and each needs its own `tool` message.
5. **Transport-specific feature matrix.** The first-party surface is OpenAI Chat Completions at `https://api.moonshot.ai/v1` (no Responses API); an Anthropic-compatible endpoint exists at `https://api.moonshot.ai/anthropic` with model id `kimi-k3[1m]`, where Tool Search must be disabled and WebFetch is unsupported. Third-party OpenAI-compatible routers are outside official documentation and must not inherit these assumptions.
6. **Context/cache economics are policy-relevant.** 1M-token context (1,048,576), automatic prefix caching with a >256-prompt-token eligibility threshold, cache-hit input priced at 1/10 of cache-miss ($0.30 vs $3.00 per MTok), and documented rules for what preserves or invalidates the cache prefix.

Conversely, official sources give **no** basis for: a Kimi-specific system-prompt template, a `parallel_tool_calls` parameter, custom stop/logit sampling, or assuming feature parity on third-party routers. Those should not be special-cased.

## 2. Access surfaces: Kimi Code native vs Moonshot API vs third-party routers

Official documentation distinguishes these products and endpoints (all accessed 2026-07-28):

| Surface | What it is | Billing | Evidence |
|---|---|---|---|
| Kimi Code (managed) | Moonshot's own coding product; Kimi Code CLI is its terminal agent. OAuth via `/login`; select K3 with `/model`. Kimi Membership includes Kimi Code benefits; "the Kimi Code API is independent from the API service on this platform." | Subscription (Kimi Membership) or Kimi API Platform key | [product-plans](https://platform.kimi.ai/docs/guide/product-plans), [kimi-code-cli](https://platform.kimi.ai/docs/guide/kimi-code-cli), [tech blog availability](https://www.kimi.com/blog/kimi-k3) |
| Kimi Code CLI + Kimi API Platform key | Same CLI, but authenticated with a `platform.kimi.ai` API key (`/login` → "Kimi Platform (API key · platform.kimi.ai)"); loads models available to the account. Provider type `kimi`, default `base_url https://api.moonshot.ai/v1`; capabilities (thinking, vision, tool use) auto-matched by model-name prefix. | Pay-as-you-go | [kimi-code-cli](https://platform.kimi.ai/docs/guide/kimi-code-cli), [Kimi Code providers](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html) |
| Kimi API Platform (Moonshot API) | OpenAI-compatible Chat Completions at `https://api.moonshot.ai/v1`, model id `kimi-k3`. Also an Anthropic-compatible endpoint `https://api.moonshot.ai/anthropic` (documented for Claude Code; model id `kimi-k3[1m]`). No Responses API: Codex CLI needs third-party protocol conversion. | Pay-as-you-go; K3 unlocked after ≥$1 top-up | [api overview](https://platform.kimi.ai/docs/api/overview), [claude-code-kimi](https://platform.kimi.ai/docs/guide/claude-code-kimi), [codex-kimi](https://platform.kimi.ai/docs/guide/codex-kimi), [kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart) |
| Third-party OpenAI-compatible routers | Not documented by Moonshot. Official docs only warn that community switcher tools (e.g. cc-switch) "are not maintained by Kimi, and their presets may differ from the values recommended." Kimi Code CLI imports such vendors as OpenAI-compatible "with a 'guessed' note." | N/A | [claude-code-kimi](https://platform.kimi.ai/docs/guide/claude-code-kimi), [Kimi Code providers](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html) |

Policy implication: capabilities below are verified for the first-party `api.moonshot.ai` surface only. A per-model policy keyed on "kimi-k3" must not silently apply to third-party router deployments of K3 weights (open weights released 2026-07-27 per the [tech blog](https://www.kimi.com/blog/kimi-k3)), where context length, caching, and feature support are operator-defined.

## 3. Verified capabilities and constraints (official evidence)

### 3.1 Reasoning / thinking

- K3 **always reasons**; there is no way to disable thinking ("You can't — K3 always thinks"). Configure effort via top-level `reasoning_effort`: `"low" | "high" | "max"`, default `"max"`. Preserved Thinking is always on. The K2.x `thinking` request parameter does not exist on K3 and must be removed when migrating. — [use-reasoning-effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort), [kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [models-overview](https://platform.kimi.ai/docs/api/models-overview), [use-thinking-models](https://platform.kimi.ai/docs/guide/use-thinking-models)
- **Replay requirement**: "For multi-turn conversations and tool calls, K3 requires the complete assistant message returned by the API to be passed back to `messages` as-is, including `reasoning_content` and `tool_calls`." Copying only `content`/`tool_calls` "drops any returned `reasoning_content` and breaks the context needed by later tool calls." — [use-reasoning-effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort), [use-kimi-k3-to-setup-agent](https://platform.kimi.ai/docs/guide/use-kimi-k3-to-setup-agent)
- **Cache interaction**: "Switching levels invalidates prefix-cache hits. Decide on the `effort` level before the conversation starts and avoid switching it mid-session." — [models-overview](https://platform.kimi.ai/docs/api/models-overview)
- Streaming returns `reasoning_content` deltas before `content` deltas; reasoning tokens count toward the output token limit ("the sum of tokens in `reasoning_content` and `content` must be less than or equal to `max_tokens`"). OpenAI SDKs need `getattr` to read `reasoning_content`. — [use-thinking-models](https://platform.kimi.ai/docs/guide/use-thinking-models), [kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- OpenAI-migration note: top-level `reasoning_effort` is accepted, but the value set is `low`/`high`/`max` — there is no `medium`/`minimal`/`xhigh`. — [models-overview](https://platform.kimi.ai/docs/api/models-overview)
- Launch-state discrepancy: the tech blog (2026-07-16) said "at launch, Kimi K3 will use max thinking effort by default, with low- and high-effort modes to be introduced in subsequent updates"; the platform docs as of 2026-07-28 document all three levels. Treat the docs as current. — [tech blog](https://www.kimi.com/blog/kimi-k3), [use-reasoning-effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort)

### 3.2 Context window and output limits

- Context window: 1M tokens (1,048,576). Pricing table confirms 1,048,576. — [models](https://platform.kimi.ai/docs/models), [chat-k3 pricing](https://platform.kimi.ai/docs/pricing/chat-k3), [claude-code-kimi](https://platform.kimi.ai/docs/guide/claude-code-kimi)
- `max_completion_tokens` defaults to **131072** and can be set up to **1048576**. `max_tokens` is deprecated in favor of `max_completion_tokens`. If input + `max_completion_tokens` exceeds the context window, the API returns `invalid_request_error`. — [kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [api/chat](https://platform.kimi.ai/docs/api/chat)
- Fixed sampling: `temperature=1.0`, `top_p=0.95`, `n=1`, `presence_penalty=0`, `frequency_penalty=0` — "passing any other value returns an error, so do not pass it explicitly." — [models-overview](https://platform.kimi.ai/docs/api/models-overview), [kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- Request timeout: 2 hours, then 504; 429 on rate limit. — [Kimi help: API overview](https://www.kimi.com/help/kimi-api/api-overview)

### 3.3 Tool calling and parallel tool calls

- Standard OpenAI-style `tools` (JSON Schema function definitions); multi-step tool loops; official agent example caps rounds client-side (`MAX_TOOL_ROUNDS = 8`) and fails fast on `finish_reason="length"`. — [use-kimi-api-to-complete-tool-calls](https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls), [use-kimi-k3-to-setup-agent](https://platform.kimi.ai/docs/guide/use-kimi-k3-to-setup-agent)
- **Parallel calls confirmed**: "It supports parallel calls. The Kimi large language model can return multiple `tool_calls` at once… For `tool_calls` that have no dependencies, the Kimi large language model will also tend to call them in parallel." Each call must get its own `tool` message with the matching `tool_call_id`. No `parallel_tool_calls` request parameter appears anywhere in the official docs or the embedded OpenAPI spec. — [use-kimi-api-to-complete-tool-calls](https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls), [api/chat](https://platform.kimi.ai/docs/api/chat)
- `tool_choice`: `"auto"` (default) / `"none"` / `"required"`; only `kimi-k3` supports `"required"` among current Kimi models (K2.6/K2.7-code error on it). Forcing a specific tool with a function object is "currently incompatible with thinking: with thinking enabled, the request returns a 400 error" — since K3 always thinks, the function-object form is unusable on K3. Changing `tool_choice` per request **does not** invalidate the prefix cache. — [use-tool-choice](https://platform.kimi.ai/docs/guide/use-tool-choice), [models-overview](https://platform.kimi.ai/docs/api/models-overview)
- **Dynamic tool loading**: a `system` message carrying a `tools` field (no `content`) injects full tool definitions from that position onward; same schema as top-level `tools`; not server-retained — the client must keep the declaration in history. Official best practice for large tool inventories: declare a `search_tools` meta-tool, force first-turn retrieval with `tool_choice:"required"`, then inject selected tools and revert to `"auto"`. Appending a declaration at the end preserves the cached prefix; removing/modifying an earlier declaration breaks it after the change point. — [use-dynamic-tool-loading](https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading), [kimi-k3-tool-calling-best-practice](https://platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice)
- Tool-schema guidance from the official agent guide: set `additionalProperties: false` and list `required` fields to reduce invalid arguments; keep argument detail in the schema, not the system prompt. — [use-kimi-k3-to-setup-agent](https://platform.kimi.ai/docs/guide/use-kimi-k3-to-setup-agent)

### 3.4 Vision input

- Native image **and** video understanding on `kimi-k3`. `content` must be an array of parts (`text` / `image_url` / `video_url`); serializing the array into a string is explicitly unsupported. — [use-kimi-vision-model](https://platform.kimi.ai/docs/guide/use-kimi-vision-model), [api/chat](https://platform.kimi.ai/docs/api/chat)
- **No public image URLs**: only base64 data URLs or `ms://<file-id>` (Files API upload, `purpose="image"`/`"video"`). — [use-kimi-vision-model](https://platform.kimi.ai/docs/guide/use-kimi-vision-model), [kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- Image formats: jpeg/png/gif/webp/bmp/heic/heif; animated GIF/WebP may be decoded and billed as video. **SVG is rejected** — pass SVG source as text instead. Video: mp4/mpeg/mov/avi/x-flv/mpg/webm/wmv/3gpp. No image-count limit, but request body ≤ 100 MB. Recommended resolution ≤ 4K (image) / ≤ FHD (video); token cost is dynamic (use the estimate-tokens endpoint). — [use-kimi-vision-model](https://platform.kimi.ai/docs/guide/use-kimi-vision-model), [api/estimate](https://platform.kimi.ai/docs/api/estimate)
- Vision requests support multi-turn, streaming, tool calls, JSON Mode, Partial Mode. — [use-kimi-vision-model](https://platform.kimi.ai/docs/guide/use-kimi-vision-model)

### 3.5 Structured output

- `response_format`: `{"type":"json_object"}` (valid JSON, fields unconstrained) and `{"type":"json_schema","json_schema":{"name","strict","schema"}}` (token-level constrained decoding, CFG). `strict: true` recommended; schemas must comply with **MFJS (Moonshot Flavored JSON Schema)**; `walle` CLI provided for static checks. — [response_format](https://platform.kimi.ai/docs/guide/response_format)
- Model-relative standing: "`kimi-k3` reliably supports Structured Output, including nested objects, arrays, and `anyOf`." The *most* stable support (`oneOf`/`$ref`/`additionalProperties: true`) is documented for `kimi-k2.7-code`, so for the most complex schemas live validation against K3 is still advised. Parse only `message.content`, never `reasoning_content`. Truncation shows as `finish_reason="length"` — check it and raise `max_completion_tokens`. Setting `response_format` does not invalidate the prefix cache. — [response_format](https://platform.kimi.ai/docs/guide/response_format)

### 3.6 Context caching

- **Automatic** for all model requests: no cache ID, no TTL, no extra parameters; hits reported via `usage.cached_tokens`. Eligibility threshold: "a new request can hit the prefix cache only when the previous request's prompt tokens exceed 256." Keep long stable prefixes (system prompts, tool definitions) at the front. — [use-context-caching](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api), [kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- Documented invalidation rules: changing `reasoning_effort` **invalidates** the cache; changing `tool_choice` or `response_format` **does not**; appending a dynamic tool declaration at the end **does not**, while editing/removing an earlier declaration does (after the change point). — [models-overview](https://platform.kimi.ai/docs/api/models-overview), [use-tool-choice](https://platform.kimi.ai/docs/guide/use-tool-choice), [response_format](https://platform.kimi.ai/docs/guide/response_format), [kimi-k3-tool-calling-best-practice](https://platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice)
- Pricing: input cache hit $0.30/MTok vs cache miss $3.00/MTok; output $15.00/MTok; flat regardless of context length. Official claim: "the official Kimi API achieves a cache hit rate above 90% in coding workloads" (Mooncake disaggregated inference). — [chat-k3 pricing](https://platform.kimi.ai/docs/pricing/chat-k3), [tech blog](https://www.kimi.com/blog/kimi-k3)

### 3.7 Prompt style / agent-loop guidance

- Official agent guide: system prompt carries role, workflow, and quality boundaries; leave argument detail in tool schemas; bound the loop (`MAX_TOOL_ROUNDS`); return per-tool errors as tool results and continue; treat `finish_reason="length"` as failure, not as a final answer. — [use-kimi-k3-to-setup-agent](https://platform.kimi.ai/docs/guide/use-kimi-k3-to-setup-agent)
- Official K3 limitation (tech blog): "Excessive proactiveness… it may make unexpected decisions on the user's behalf. If your application requires the agent to operate within well-defined boundaries… please impose more explicit behavioral constraints on K3 in the system prompt or in `AGENTS.md`." — [tech blog, Limitations](https://www.kimi.com/blog/kimi-k3)
- The platform's generic prompt best-practices page (clear instructions, delimiters, explicit steps, few-shot, length targets, reference text, decomposition) is not K3-specific; **no K3-specific system-prompt template is published**. — [prompt-best-practice](https://platform.kimi.ai/docs/guide/prompt-best-practice)
- Tool-inventory guidance: don't ship hundreds of tool schemas per request; use `search_tools` + dynamic injection. — [kimi-k3-tool-calling-best-practice](https://platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice)

### 3.8 Access, rate limits, misc constraints

- K3 requires a successful top-up (minimum $1); new-user vouchers cannot be used for K3. Tiered limits: Tier0 ($1) = 1 concurrency / 3 RPM / 500k TPM / 1.5M TPD; up to Tier5 ($3,000) = 1,000 concurrency / 10,000 RPM / 5M TPM. — [kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [limits](https://platform.kimi.ai/docs/pricing/limits), [open-code](https://platform.kimi.ai/docs/guide/open-code)
- Official `web_search` tool "is being updated and is not recommended for use in the near term." — [kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [chat-k3 pricing](https://platform.kimi.ai/docs/pricing/chat-k3)
- Anthropic-compatible endpoint (`https://api.moonshot.ai/anthropic`, model `kimi-k3[1m]`): `ENABLE_TOOL_SEARCH` must be `false` (unsupported, "otherwise tool calls misbehave"); WebFetch unsupported; recommended `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1048576`, `CLAUDE_CODE_EFFORT_LEVEL=max`. — [claude-code-kimi](https://platform.kimi.ai/docs/guide/claude-code-kimi)
- Partial Mode: trailing assistant message with `partial: true` continues from a prefix; `partial` is a message field, not a top-level parameter. — [kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [api overview](https://platform.kimi.ai/docs/api/overview)

## 4. Officially disclosed K3 limitations (tech blog, 2026-07-16)

Quoted from [Kimi K3: Open Frontier Intelligence — Limitations](https://www.kimi.com/blog/kimi-k3):

1. **Sensitivity to thinking history.** "K3 was trained in the preserved thinking history mode. If the agent harness fails to pass back all the historical thinking content as required, or if an ongoing session with another model is switched over to K3, generation quality may become highly unstable. We recommend using a harness with verified compatibility, such as Kimi Code, and avoiding switching to K3 in the middle of a session."
2. **Excessive proactiveness.** Long-horizon training makes K3 "make unexpected decisions on the user's behalf" on minor issues or ambiguous intent; Moonshot asks for "more explicit behavioral constraints on K3 in the system prompt or in `AGENTS.md`."
3. A "noticeable gap in user experience compared with Claude Fable 5 and GPT 5.6 Sol" (vendor-stated; not actionable for policy).

## 5. Not disclosed / unknown from official sources

- `parallel_tool_calls` request parameter: absent from docs and the embedded OpenAPI spec; only model-side parallel emission is documented. Do not send it.
- Maximum number of `tool_calls` per assistant turn, and per-request tool-count limits: not documented.
- Token accounting per effort level (how `low`/`high`/`max` map to reasoning-token budgets): not documented; only "set `reasoning_effort` to `low` to reduce reasoning" guidance.
- Cache TTL/eviction policy beyond "managed automatically," and exact prefix-matching granularity: not documented.
- Image/video token formula: only "dynamic," higher resolution/frame count ⇒ more tokens; estimate-tokens endpoint offered instead.
- `kimi-k3[1m]` naming semantics on the Anthropic endpoint beyond the Claude Code guide (no published parameter/effort mapping for that endpoint; video input via that endpoint undocumented).
- Third-party router / self-hosted behavior for the open K3 weights (vLLM KDA prefix-cache implementation "to be released alongside the model" per the blog): outside platform docs; no official capability guarantees.
- China platform (`platform.moonshot.cn`) parity with the global docs cited here: not verified in this research.
- K3 technical report (architecture/training/eval detail): "to be published"; blog-level claims only as of 2026-07-28.
- No K3-specific system-prompt template, anti-patterns, or sampling alternatives are published; nothing official supports a large family-specific prompt fork.

## 6. Implications for oh-my-pi per-model policy

Repo baseline (from [2026-07-28-per-model-output-quality-evidence](2026-07-28-per-model-output-quality-evidence.md) and the current tree): ordinary sessions have family profiles in `packages/coding-agent/src/model-optimization/default-profiles.ts` with runtime application via `model-optimization/runtime-policy.ts`; a newer `packages/coding-agent/src/model-policy/` layer (compiler, adapters, provider-state, completion) exists; **Kimi currently has no ordinary optimization profile**. The levers below map onto that existing machinery.

### 6.1 Candidate adaptations with official evidence

| # | Adaptation | Official basis (§ above) |
|---|---|---|
| A1 | Provider-state adapter: preserve `reasoning_content` + `tool_calls` verbatim across turns for `kimi-k3`; never reconstruct assistant messages from `content` alone | §3.1 replay requirement; §4 limitation 1 |
| A2 | Session-switch guard: warn or block switching an in-progress session from another family to K3 (quality instability is officially documented) | §4 limitation 1 |
| A3 | Reasoning-effort mapping: expose only `low`/`high`/`max` for K3 (map oh-my-pi's generic levels; no `medium`); pin effort per session — changing it mid-session invalidates the prefix cache | §3.1, §3.6 |
| A4 | Parameter sanitizer: omit `temperature`, `top_p`, `n`, `presence_penalty`, `frequency_penalty` for `kimi-k3` (non-fixed values error) | §3.2 |
| A5 | Tool-choice compiler: allow `auto`/`none`/`required` on K3; never emit function-object `tool_choice` (400 with always-on thinking) | §3.3 |
| A6 | Tool-loop handling: consume multiple `tool_calls` per turn and answer each with its own `tool_call_id`; do not send a `parallel_tool_calls` parameter | §3.3 |
| A7 | Output budgeting: set `max_completion_tokens` deliberately (default 131072, ceiling 1048576); remember reasoning shares the budget; treat `finish_reason="length"` as truncation, not completion | §3.2, §3.1, §3.7 |
| A8 | Context/cache policy: 1M window; keep stable prompt/tool prefix; append-only tool-surface changes; rely on automatic prefix caching (>256-token eligibility); track `usage.cached_tokens` | §3.6 |
| A9 | Vision adapter: base64 or `ms://` file refs only (rewrite public URLs by fetching client-side); reject/inline SVG as text; enforce 100 MB body ceiling | §3.4 |
| A10 | Structured output: `json_schema` + `strict:true` is first-class (CFG-constrained); parse `content` only; keep host-side validation for complex schemas (`oneOf`/`$ref` stability is only documented for k2.7-code) | §3.5 |
| A11 | Transport-aware capability matrix: first-party Chat Completions vs Anthropic endpoint (`kimi-k3[1m]`, Tool Search off, no WebFetch) vs third-party routers (unverified — generic policy, no K3 assumptions) | §2, §3.8 |
| A12 | Small prompt overlay (not a fork): explicit behavioral boundaries/scope constraints for K3's documented "excessive proactiveness"; optional `search_tools`-style dynamic loading if tool inventory grows | §3.7, §4 limitation 2 |
| A13 | Cost/rate awareness: cache-hit pricing is 1/10 of miss; tier-based concurrency/RPM (Tier0 is 1 concurrent / 3 RPM) — backoff and parallelism policy should read account tier rather than assume flat limits | §3.6, §3.8 |
| A14 | Model-id hygiene: `kimi-k3` (API) ≠ `kimi-k3[1m]` (Anthropic endpoint) ≠ `kimi-k2.7-code*` (different constraints, e.g. no `tool_choice:"required"`); keep the K2.x `thinking` parameter out of K3 requests | §2, §3.1, §3.3 |

### 6.2 Items with no official evidence — do NOT special-case

- A `parallel_tool_calls` toggle, custom `stop` sequences, logit/logprob tuning, seed control: not documented for K3.
- Any large Kimi-specific system-prompt template or "family prompt fork": none published; generic prompt best practices only.
- Assuming K3 feature parity (1M context, effort levels, caching, dynamic tools) on third-party OpenAI-compatible routers or self-hosted weights.
- Benchmark-derived routing decisions (excluded by methodology; the blog's benchmark footnotes describe eval harnesses, not API behavior).
- Treating `kimi-k2.7-code`(-highspeed) constraints as K3 constraints (or vice versa) — they differ on `tool_choice`, reasoning control, and context size.

## 7. Limitations of this research

- No live K3 API request was exercised; conclusions combine current official documentation, reproducible third-party integration reports, and local contract/smoke tests.
- Docs are for the global platform (`platform.kimi.ai` / `api.moonshot.ai`); the China platform and third-party deployments were not verified.
- The platform changelog page has no K3-era entries (last entry 2025-04-07), so feature-rollout dates (e.g. when `low`/`high` effort became available) cannot be confirmed from official sources beyond the blog/docs discrepancy noted in §3.1.
- The Anthropic-compatible endpoint is documented only through the Claude Code integration guide; a full endpoint reference was not found.

## 8. GitHub integration evidence

The official matrix above says what K3 should accept. Recent client failures show which gaps matter in practice:

| Signal | Evidence | Repo implication |
|---|---|---|
| Fixed sampling parameters cause request failures | [OpenCode #39214](https://github.com/anomalyco/opencode/issues/39214) reports that sending any temperature value breaks K3; [LiteLLM #33921](https://github.com/BerriAI/litellm/issues/33921) asks for native K3 routing instead of a generic OpenAI-compatible workaround | Mark sampling parameters unsupported for direct Moonshot K3 so generic callers omit them |
| Moonshot MFJS rejects object combiners with sibling constraints | [MoonshotAI/kimi-cli #2531](https://github.com/MoonshotAI/kimi-cli/issues/2531), [OpenClaw #113130](https://github.com/openclaw/openclaw/issues/113130), and the local `normalizeSchemaForMoonshot` reproduction all preserve the rejected root `type` + `anyOf` shape | Distribute compatible object constraints into each branch in the Moonshot schema normalizer |
| Empty or reconstructed reasoning history breaks later turns | [OpenCode #37651](https://github.com/anomalyco/opencode/issues/37651) and [PR #37624](https://github.com/anomalyco/opencode/pull/37624) show later K3 requests returning 400 when empty thinking blocks are replayed incorrectly; the patched session completed 26 steps | Already covered: the Kimi transport preserves `reasoning_content` and filters empty replay blocks; retain regression coverage rather than add a second path |
| Native named effort is required | [OpenCode #37418](https://github.com/anomalyco/opencode/issues/37418) and [PR #37514](https://github.com/anomalyco/opencode/pull/37514) replace budget-token emulation with `low`/`high`/`max` | Already covered by the K3 thinking ladder and request-body tests |
| Kimi tool-call IDs are semantic on self-hosted K2-family parsers | [LiteLLM #34522](https://github.com/BerriAI/litellm/issues/34522) shows that rewriting `functions.<name>:<index>` breaks replay through vLLM/SGLang | Do **not** normalize valid Kimi IDs merely to resemble OpenAI `call_*`; only synthesize missing IDs, as the current transport does |
| Tool-schema names beginning with a digit can fail MFJS | [MoonshotAI/kimi-cli #2531](https://github.com/MoonshotAI/kimi-cli/issues/2531) includes this independent failure | Not applicable to the current MCP bridge: it mints `mcp__<server>_<tool>` names, so no K3-only rewrite is needed |
| Code-mode/catalog tool surfaces work, but may add turns | [OpenClaw #115022](https://github.com/openclaw/openclaw/pull/115022) reports successful direct and catalog K3 runs; the catalog run used six assistant turns versus two direct turns | Correctness evidence only. Benchmark quality, latency, and token cost before enabling dynamic tool search by default |

## 9. Recent coding-agent user feedback

These sources are useful for prioritization, not protocol truth:

- **Repeated signal: strong long-horizon/frontend output, high latency and quota burn.** The [HN launch discussion](https://news.ycombinator.com/item?id=48935342), a [HN coding trial](https://news.ycombinator.com/item?id=48979010), a [repeated-task report](https://news.ycombinator.com/item?id=48961116), and V2EX discussions ([1](https://www.v2ex.com/t/1228376), [2](https://www.v2ex.com/t/1227894), [3](https://www.v2ex.com/t/1227921)) independently describe long waits, large reasoning output, or rapid subscription-quota consumption. One HN-rendering trace exposed 16,658 output tokens, including 13,241 reasoning tokens. These reports agree with always-on reasoning and $15/MTok output pricing, but do not isolate a harness bug.
- **Controlled-enough engineering report:** a [K3 local engineering review](https://www.cnblogs.com/zhchoice/p/21614793/kimi-k3-local-engineering-review) reports a 38-minute autonomous small-product build, followed by an independent rerun of 36 unit tests, five browser tests, typecheck, and build. It also notes over-proactivity and the need for human product judgment. This corroborates Moonshot's own stated limitation; it does not establish that a prompt overlay improves OMP.
- **Mixed coding quality:** individual HN/V2EX reports range from fixing a previously stubborn bug to failing or repeatedly backtracking on routine work. Sample sizes, tasks, providers, and effort levels differ. No source supports a deterministic K3-only routing or prompt rule.
- **Reddit gap:** direct Reddit pages/search were inaccessible (HTTP 403/rate limiting). No Reddit claim is treated as verified.

## 10. Final adaptation decision

### Implement now

1. **Protocol sanitizer:** direct Moonshot K3 advertises sampling parameters as unsupported, preventing callers from sending fixed-value overrides.
2. **MFJS compatibility:** normalize object `anyOf`/`oneOf` plus sibling constraints into a form Moonshot accepts.
3. **Capability facts:** direct Moonshot K3 records native parallel tool emission, native MFJS structured output, exact-prefix automatic caching, and complete reasoning replay. Keep Kimi Code and third-party routers conservative where the first-party contract is not guaranteed.

### Benchmark before changing defaults

1. **Prompt overlay for excessive proactivity/backtracking.** Official and user evidence identifies the behavior, but no A/B result identifies effective wording. Existing generic scope and loop-guard rules already mitigate it.
2. **Dynamic tool search/catalog.** Officially recommended for very large inventories, but external live evidence shows extra turns and no quality comparison. Benchmark against OMP's normal tool set first.
3. **Default effort (`max` → `high` or `low`).** The Moonshot API defaults to `max`; Kimi Code documents `high` on its managed surface. Users can already choose an effort, and changing it mid-session invalidates cache. Do not silently pick a cross-surface default.
4. **K3-specific timeout, retry, or context-eviction profile.** Slow/high-token reports are real but dominated by model reasoning and route capacity. Aggressive eviction can destroy exact-prefix cache value or preserved-thinking context; measure end-to-end tasks first.

### Do not add

- A K3-only duplicate-tool loop guard: the generic guard is already enabled by default.
- Tool-call ID cosmetic rewriting: Kimi-family parsers may depend on the original ID grammar.
- A large K3-specific system-prompt fork, custom sampling knobs, or `parallel_tool_calls` request parameter: no evidence-backed contract supports them.
- K3 capabilities inferred solely from the model ID on OpenRouter, self-hosted, or arbitrary OpenAI-compatible endpoints.
