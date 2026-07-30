# Research: Per-Model Output Quality Optimization

- Date: 2026-07-28
- Scope: `packages/coding-agent/` ordinary sessions and workflow
- Method: official model/API documentation for capabilities and recommended usage; public forum reports only for repeated failure-mode discovery. Forum reports are not model rankings.

## 1. Conclusion

The next optimization layer should not be a larger family-specific prompt. It should be a **capability-compiled runtime policy**:

1. Preserve provider-native reasoning state losslessly across tool turns.
2. Compile tool schemas and descriptions to each provider/model capability.
3. Route reasoning effort, structured output, sampling, cache, and context by capability, not by a generic OpenAI-compatible surface.
4. Enforce completion and verification in the agent loop; prompts alone do not reliably prevent premature completion.
5. Evaluate each lever independently with live, versioned, provider-specific A/B runs.

Repeated community feedback supports four cross-model failure patterns: long-session instruction drift, premature completion, tool-protocol failures caused by harness/provider/parser mismatches, and narrower safe task boundaries for fast/small models. Counterexamples are common; model brand alone is not a stable causal explanation.

## 2. Repository baseline

### 2.1 Ordinary sessions

- Built-in family profiles exist for Claude, GPT-5/Codex, Grok, GLM, and DeepSeek: `packages/coding-agent/src/model-optimization/default-profiles.ts:51-119`.
- The feature is opt-in and disabled by default: `packages/coding-agent/src/config/settings-schema.ts:4163-4178`.
- Runtime application currently consumes only the prompt block, tool concurrency/conflict settings, and exposes context metadata: `packages/coding-agent/src/model-optimization/runtime-policy.ts:14-65`.
- `outputTruncation` and `resultSummarization` are declared but not consumed on the ordinary-session path; ordinary output remains byte-identical by test contract.
- `SessionContextStrategy` is exposed by a getter but has no ordinary-session consumer: `packages/coding-agent/src/session/agent-session.ts:7266-7269`.
- Gemini optimization is separate: tool descriptions are inlined at session start and Gemini loop guards repair runaway/tool-call failures. This decision is not recomputed after a model switch: `packages/coding-agent/src/config/inline-tool-descriptors-mode.ts:14-27`, `packages/coding-agent/src/sdk.ts:2483-2489`.
- GLM and DeepSeek reuse the Grok prompt template. Gemini, Qwen, Kimi, Minimax, Gemma, MiMo, and GPT-OSS have no ordinary optimization profile despite catalog family classification support.

### 2.2 Workflow

- Workflow has a separate role-specific profile system, stable/dynamic prompt assembly, tool/schema/output policies, context eviction, retry, handoff, receipts, and benchmark scaffolding.
- Stable order is system policy → role policy → tool presentation → skill catalog; dynamic order is assignment → repo map → handoff → history: `packages/coding-agent/src/workflow/prompt-assembly.ts:92-172`.
- Existing benchmark contracts distinguish quality, exact bytes, provider facts, estimates, and unknown values: `packages/coding-agent/src/workflow/benchmark/types.ts:8-223`.
- Existing profiles bundle many changes. This obscures which lever caused improvement or regression.

## 3. Repeated forum feedback

Evidence levels: **strong** = reproducible issue, duplicate/P0, multiple linked reports, or a fix PR; **medium** = detailed single report or multi-user discussion; **weak** = unsupported short opinion. Design implications are inferences, not facts about intrinsic model quality.

### 3.1 Cross-model patterns

| Pattern | Independent evidence | Supported conclusion |
|---|---|---|
| Instruction/current-task drift as history grows or after compaction | Codex [#3923](https://github.com/openai/codex/issues/3923); Claude [CLAUDE.md discussion](https://www.reddit.com/r/ClaudeCode/comments/1njm40c/claude_ignores_claudemd_instructions_unless); Gemini [#6474](https://github.com/google-gemini/gemini-cli/issues/6474) and [Google forum](https://discuss.ai.google.dev/t/new-model-levels-fast-thinking-pro-continue-to-be-a-problem-for-long-term-projects/112416) | Reinject active constraints and unresolved state at stage/turn boundaries. More history is not a substitute for state. |
| Premature stop or unverified completion | Codex [#5264](https://github.com/openai/codex/issues/5264), [#6502](https://github.com/openai/codex/issues/6502); Claude [#6159](https://github.com/anthropics/claude-code/issues/6159), [#12369](https://github.com/anthropics/claude-code/issues/12369), [#14947](https://github.com/anthropics/claude-code/issues/14947) | Completion must be a runtime state transition backed by pending-work and verification evidence, not a prompt-only promise. |
| Tool reliability depends on adapter/parser/template | Gemini [#6897](https://github.com/google-gemini/gemini-cli/issues/6897); Grok in Zed [#36994](https://github.com/zed-industries/zed/issues/36994); Qwen [#475](https://github.com/QwenLM/Qwen3-Coder/issues/475); Kimi [discussion](https://www.reddit.com/r/LocalLLaMA/comments/1mdldom/kimi_k2_vs_claude_4_sonnet_unexpected_review); DeepSeek [discussion](https://www.reddit.com/r/LocalLLaMA/comments/1nbslxu/native_tool_calling_support_for_deepseek_v31_just) | Diagnose raw provider payload, channel parsing, chat template, and schema conformance before changing prompts or blaming the model. |
| Fast/small models have narrower safe autonomy | Grok [discussion 1](https://www.reddit.com/r/singularity/comments/1n1uxic/xai_grok_code_fast_1_is_new_in_openrouter), [discussion 2](https://www.reddit.com/r/cursor/comments/1p5v4h2/grokcodefast_in_cursor_lightning_fast_at_writing); Qwen/Kimi/DeepSeek reports below | Route by task risk and scope. Use deterministic file/scope/verification gates for narrow executors. |

### 3.2 Model-family evidence and counterexamples

| Family | Reported failure | Counterexample / boundary | Design implication |
|---|---|---|---|
| GPT/Codex | Instruction decay, incomplete plans, commit recommendation while tests fail | [HN discussion](https://news.ycombinator.com/item?id=46902638) contains both poor agent-mode reports and successful prototype experiences | Persist active contract; bound exploration; runtime stop/verification gate. |
| Claude | CLAUDE.md not treated as an action gate; TodoWrite completion drift; compacted context loses role state | [2000-hour workflow report](https://www.reddit.com/r/ClaudeCode/comments/1q7nhn6/i_spent_2000_hours_coding_with_claude_code_in) reports improvement from hooks, isolation, and visible context | Keep prompt concise; invest in context hygiene, tool descriptions, hooks, and evidence-backed completion. |
| Gemini | Old context can dominate latest turn; repeated invalid MCP tool names; verbosity and long-session drift | [Gemini 3 discussion](https://www.reddit.com/r/GeminiAI/comments/1q991ol/gemini_3_feels_like_a_major_downgrade_from_gemini) includes users reporting better results in VS Code/Godot | Mark latest state explicitly, preserve thought signatures, normalize tool errors, use output limits/structured formats. |
| Grok | Provider/tool compatibility failures; fast model can over-edit or leave partial work | Users report strong narrow refactors and better adherence when given a detailed implementation plan | Route to bounded patches; whitelist scope; require verification; test each provider adapter. |
| Qwen | Missing/malformed native tool tags and streaming parser incompatibility | [Qwen3-Coder local report](https://www.reddit.com/r/LocalLLaMA/comments/1n3ldon/qwen3coder_is_mind_blowing_on_local_hardware) reports reliable Cline tool calls under a matching runtime/config | Use official chat template/parser; treat quantization, KV cache, streaming parser, and model checkpoint as first-class profile inputs. |
| Kimi | Tool calls may appear as text or malformed through some proxy paths | [Long-context report](https://www.reddit.com/r/LocalLLaMA/comments/1m0lyjn/kimi_has_impressive_coding_performance_even_deep) reports correct work around 90k context; native/Anthropic-compatible routes report better tools | Prefer conformance-tested transport; do not infer tool quality from model ID alone. |
| DeepSeek | Tool parsing and parallel-call reliability vary by runtime | [Aider result discussion](https://www.reddit.com/r/LocalLLaMA/comments/1muq72y/deepseek_v31_scores_716_on_aider_nonreasoning_sota) reports strong diff-format editing | Separate edit-format quality from multi-tool autonomy; validate reasoning/tool channels and parser version. |

Additional protocol-level evidence: [LM Studio parser discussion](https://www.reddit.com/r/LocalLLaMA/comments/1riwhcf/psa_lm_studios_parser_silently_breaks_qwen35_tool) aggregates cases where reasoning text is misparsed as tool calls. Raw upstream and parsed events must both be observable.

## 4. Official model/API practices

All official sources accessed 2026-07-28.

### 4.1 OpenAI GPT/Codex

- `reasoning_effort` changes both reasoning depth and willingness to call tools; the documented default is medium. Separate tasks can perform better across multiple turns: [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide).
- Preserve Responses reasoning items with `previous_response_id` or replay them with tool results: [function calling](https://developers.openai.com/api/docs/guides/function-calling).
- Use strict function schemas; use Structured Outputs for final machine-consumed answers: [function calling](https://developers.openai.com/api/docs/guides/function-calling), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
- Define exploration and early-stop criteria; contradictory instructions reduce performance: [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide).
- Prompt cache requires exact common prefixes; static instructions/examples/tools belong first: [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

### 4.2 Anthropic Claude

- Tool descriptions are a primary performance lever: explain what the tool does, when to use or not use it, parameters, limitations, and examples; consolidate related operations and return high-signal fields: [tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).
- Preserve thinking blocks and signatures unchanged across tool/multi-turn interactions: [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking).
- Claude 4.5+ supports native JSON Schema output and strict tools: [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
- Prompt cache ordering is tools → system → messages; changing thinking/effort can invalidate cache: [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
- Prefer simple composable workflows, environment feedback, and stopping conditions: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).

### 4.3 Google Gemini

- Use clear instructions, consistent few-shot examples, decomposition, and aggregation; do not request visible chain of thought from thinking models. Gemini 3.x sampling defaults, especially temperature 1.0, should generally remain unchanged: [prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies).
- `thinking_level` support and semantics vary by model; it cannot be sent with legacy `thinking_budget`: [Gemini 3 guide](https://ai.google.dev/gemini-api/docs/gemini-3).
- Preserve thought signatures; official SDK/stateful interactions handle this automatically, while manual history must replay them: [function calling](https://ai.google.dev/gemini-api/docs/function-calling.md.txt).
- Native schema output and prefix-based implicit caching are available: [structured output](https://ai.google.dev/gemini-api/docs/structured-output.md.txt), [caching](https://ai.google.dev/gemini-api/docs/caching).

### 4.4 xAI Grok

- Grok 4.5 defaults reasoning effort to high and cannot disable reasoning; some generic sampling/stop parameters are incompatible. Multi-agent effort can mean agent count rather than depth: [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning).
- Tool arguments are implicitly strict; streaming function calls arrive as a whole chunk: [function calling](https://docs.x.ai/developers/tools/function-calling).
- Native JSON Schema output is available: [structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).
- Cache affinity uses stable conversation/cache IDs and exact starting messages; long loops benefit from safe checkpoint compaction: [prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching), [Grok 4.5](https://docs.x.ai/developers/grok-4-5).

### 4.5 Qwen and DeepSeek

- Qwen hybrid thinking must follow checkpoint-specific switches and sampling. Official docs warn against greedy decoding in thinking mode; newer Instruct-only/Thinking-only checkpoints differ: [Qwen quickstart](https://qwen.readthedocs.io/en/latest/getting_started/quickstart.html).
- Qwen recommends Hermes-style tools and warns against stopword-based ReAct parsing for reasoning models: [Qwen function calling](https://qwen.readthedocs.io/en/latest/framework/function_call.html).
- DeepSeek thinking tool turns require full `reasoning_content` replay; current effort levels and ignored sampling controls differ from OpenAI: [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode).
- DeepSeek JSON mode is valid-JSON, not full schema constraint, and may return empty content; host validation/retry remains required: [JSON mode](https://api-docs.deepseek.com/guides/json_mode).
- DeepSeek caching is prefix-based and exposes hit/miss usage: [KV cache](https://api-docs.deepseek.com/guides/kv_cache).

## 5. Evidence-backed design constraints

1. **Opaque provider state**: OpenAI reasoning items, Claude thinking signatures, Gemini thought signatures, and xAI/DeepSeek reasoning content must remain provider-native and unedited.
2. **Capability matrix**: model ID selects facts; it must not imply unsupported generic OpenAI-compatible behavior.
3. **Prompt overlay, not prompt fork**: shared task contract + small family overlay; no generic step-by-step instruction for reasoning models.
4. **Tool-surface compiler**: render schema/description/examples per capability and provider, while keeping one semantic tool contract.
5. **Runtime completion gate**: unresolved todo/plan items, missing required artifacts, or absent verification prevent a successful terminal state.
6. **Checkpoint context**: compact at safe stage boundaries; preserve unresolved state, evidence, tool-call/result pairs, and recovery URIs.
7. **Structured-output tiers**: native JSON Schema > strict tool output > valid-JSON + validation > text parse/repair.
8. **Live ablation**: test prompt, tool surface, reasoning effort, context, and output policy independently. Fake-runtime token reduction is not model-quality evidence.

## 6. Limitations

- Forum evidence has selection bias and frequently mixes model, client, provider, parser, model version, quantization, and server routing.
- No public report establishes stable cross-runtime model rankings.
- Official interfaces change rapidly. Capability metadata and conformance probes must version behavior rather than hard-code this document's enum lists indefinitely.
- Specific savings, quality gains, and context failure thresholds remain unverified for oh-my-pi until live paired benchmarks run.
