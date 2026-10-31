# Subagent Review: harness quality token optimization (round 2)

- Date: 2026-08-23
- Review Artifact: docs/superpowers/plans/2026-08-23-harness-quality-token-optimization-subagent-review.md
- Primary Reviewed Design: docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-design.md
- Reviewed Inputs:

| Path | SHA-256 |
|---|---|
| `docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-design.md` | `a5d46038f1a421ef74ca1dc26a8c7c3659d7bb04ac433796f70f60515de2a061` |
| `docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-facts-brief.md` | `d2bf57e954d70beb09b1dfb468346a6ad99a9c36546e9af059fd90ce70f58756` |

- Reviewed Revision: `faa5ab7e59a819f03372d90837bd2d6edf02503445f2bbc3fe0562cea29b42c0`
- Review Mode: host-native
- Design Author Identity: GrokDesigner
- Design Author Model: gateway/grok-4.6
- Reviewer Identity: SolGateReviewer
- Reviewer Model: gateway/gpt-5.6-sol
- Review Fallback: none
- Implementation Authorization: authorized
- Authorization Source: 用户目标「得出结论后先落地文档文件方案，再进行优化及验证」
- Review Scope: Round-2 独立 Design Review Gate；核对 Round-1 findings 的真实关闭、根因、推荐方案 A、canonical owner、接口/不变量、失败路径、兼容性与验证计划；只读，不实现产品代码。

### Round history

| Round | Verdict | Reviewed Revision | Result |
|---|---|---|---|
| R1 | NEEDS_REVISION | `65e2184d34108b9b89678af670d9fbf336f1ff3d18c48a048ed9f7da4256fd21` | 真实 orca 形状未成为放行门；全 Grok-ID scope 只测 gateway；marker 与字段名单同步证据不足 |
| R2 | PASS_WITH_NOTES | `faa5ab7e59a819f03372d90837bd2d6edf02503445f2bbc3fe0562cea29b42c0` | 四项采纳 finding 已在设计中形成可执行门禁/范围声明 |

Hash check: `shasum -a 256` 复算两个 Reviewed Inputs 与 canonical TAB/LF manifest 均匹配提供 digest。按 normalized path 排序、每行 `path<TAB>sha256`、末尾 LF 的 manifest SHA-256 为 `faa5ab7e59a819f03372d90837bd2d6edf02503445f2bbc3fe0562cea29b42c0`，与 Reviewed Revision 一致。

## 1. 整体结论

- **PASS_WITH_NOTES**
- Round 1 的 MEDIUM-1/2 与 LOW-1/2 均已真实关闭，不是只改措辞：真实 orca 17× 非相邻、分 chunk 夹具进入 §6.1 放行门；锚点分段负例进入 §6.1；行为承诺收窄为 gateway + openai-completions + grok-4.6；命中断言包含 `THINKING_LOOP_ERROR_MARKER`；字段名列表要求本地常量、注释对齐和三字段 table（设计 `:12`, `:38-40`, `:221-224`, `:282-296`）。
- 推荐方案 A 仍复用现有 `isLoopGuardedModel` / `ThinkingLoopDetector` / `TurnRecovery`，没有第二套 detector、idle engine 或 prompt engine。没有发现新的 HIGH 或未闭合 MEDIUM。
- 非 gateway Grok 仍只承诺门真值而不承诺 delta/session 闭环；该边界已在成功标准、承诺分层、失败路径、changelog/验证范围中重复声明，属于透明的已知限制而非遗漏。见 §3 的 note。

## 2. 根因评审

### 2.1 结论

- **根因判断成立且未被修订推翻。** Facts brief `docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-facts-brief.md:44-50` 证明 Grok 未进入已有 loop guard；`:64-72` 证明 suffix-dedup 后仍有 orca 单块同句 3–17 次；`:84-96` 证明字段名 `reasoning_content` 被 session 当作认证签名。设计 `docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-design.md:100-125` 仍正确排除证据不足的 idle/compaction/TUI 根因。
- 主根因与推荐方案一致：开启既有 detector 覆盖句级循环，修正 session 空停谓词处理字段名签名；次根因只剪已证明的 step-by-step 双写和 schema 类型字面量。没有把“长 TTFT”误称为死锁，也没有把 Fast-mode 或 compaction 设计重复纳入本方案。
- [INFERENCE] 历史 jsonl 仍不能证明所有流式阶段的完整重复轨迹；修订后的真实形状 fixture 是合理的可执行代理证据，并且设计明确要求其失败即撤回 Grok 门（设计 `:38`, `:296-297`）。

### 2.2 事实 / 假设边界

- 536k 非 Gemini 校准、Grok 专用误杀率未知、非 gateway 累计快照未知仍被标成事实/未验证假设，而没有升级成已验证结论（设计 `:92-110`；facts brief `:154-166`）。
- 固定 prompt/tool 税和 200k+ transcript 主杠杆边界未改变；设计仍没有削弱 delivery/safety 条款（设计 `:100-125`, `:38-42`）。

## 3. 方案合理性

- **A vs B：合理。** 方案 A 只扩展现有 family gate、修空停解释、剪已证明复述；方案 B 才会引入专用 detector/header/idle 与大面积 prompt/profile 变更（设计 `:145-177`）。在当前证据下选浅方案符合质量优先和复用 owner 的约束。
- **Canonical owner：正确。** `isGrokModelId` 复用 catalog helper（`packages/catalog/src/identity/family.ts:91-94`），stream 继续经 `withGeminiThinkingLoopGuard`，空停仍由 `turn-recovery.ts` 负责；没有第二套 `/grok/i`、第二个 detector 或 compat flag（设计 `:47-54`, `:194-230`）。
- **Scope closure：成立。** 设计现在明确把“所有 `isGrokModelId` 匹配”限制为门真值，而把 stream/TurnRecovery 行为承诺限制为 `provider=gateway` + `api=openai-completions` + grok-4.6（设计 `:38`, `:181-193`, `:265-275`）。`x-ai/grok-4.6` 只做门真值，不再声称 session 闭环。
- **非倒置。** `loopGuard.enabled=false` 与 `PI_NO_THINKING_LOOP_GUARD=1` 仍是全家族 pass-through；不含 grok 的未知代理仍 fail-open；用户 abort 优先（设计 `:238-247`, `:253-264`）。

### 3.1 非阻塞 note

- [INFERENCE] 实际门实现仍会对其他 `isGrokModelId` 匹配返回 true，但设计不为这些路径背书，并禁止 changelog 写成已支持（设计 `:38`, `:181-193`, `:253-264`）。这是可见且有回滚边界的范围选择，不构成 Round-2 finding；后续若要保证这些路径，必须另补 transport/session fixtures 或另开设计。

## 4. 详细设计 / 不变量 / 失败路径

### 4.1 详细设计核对

- Grok 门仍是 `isLoopGuardedModel` 增加 `isGrokModelId(model.id)`；阈值、Gemini header detector、stream 接线和 wire signature assignment 不改（设计 `:194-230`, `:238-247`）。这复用现有 owner，且 catalog helper 的实际实现匹配 bare/provider-namespaced Grok id（`packages/catalog/src/identity/family.ts:91-94`）。
- 空停谓词仍是 session 层的最小改动：三个 OpenAI reasoning field 名视同 unsigned；Claude-like 非字段名签名保留终态；`toolUse` 分支不放宽（设计 `:199-213`, `:238-247`）。
- Prompt 修改继续限制在 `explicit-grok.md` 的双写句和 `task.md` 的 schema 已暴露类型字面量，保留 when/how、batch/flat、Communication / Format Contracts / Available Agents 与安全条款（设计 `:211-230`）。

### 4.2 Round-1 closure 核对

1. **MEDIUM-1 已关闭。** 设计成功标准 `docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-design.md:38-40` 要求真实 orca 17× 非相邻重复、分 chunk `thinking_delta`，以及至少八段、每段新 `CONCRETE_ANCHOR` 的正常推理负例；文件计划 `:221-224` 与质量门 `:282-296` 都把两者列为必须全绿。命不中或误杀会撤回 Grok 门，不再把“先开门、另开设计”当完成态（`:253-264`, `:296-297`）。这是对 R1 真实行为/负例验收缺口的实质关闭。
2. **MEDIUM-2 已关闭。** 设计的承诺分层 `:181-193` 明确只有 gateway + openai-completions + grok-4.6 有 stream/TurnRecovery 闭环承诺；openrouter/xai-oauth/Responses 只测门真值或不承诺闭环，且验证与 changelog 不得写成已支持（`:253-264`, `:319-326`）。这与 facts brief 对非 gateway 累计快照的未知边界一致。
3. **LOW-1 已关闭。** Grok near-dup、back-to-back 和 orca 命中夹具均要求同时断言 `"stream stall"` 与导出的 `THINKING_LOOP_ERROR_MARKER`（设计 `:221-224`, `:282-296`）。
4. **LOW-2 已关闭。** 设计明确不抽共享模块；`turn-recovery.ts` 本地常量必须和 completions 三元素同序，并通过注释指向 `packages/ai/src/providers/openai-completions.ts`；empty-stop 测试用三个字段同一 table（设计 `:221-224`, `:319-326`）。这是已拍板的浅落地取舍，不再重复报 R1 finding。

### 4.3 不变量与失败路径

- 不变量继续覆盖 Gemini/DeepSeek 门和阈值不变、未知模型行为、两个既有 kill switch、Claude 签名、OpenAI wire 字段、`thinking_delta` commit、header guard、retry/cook 上限及通用 redirect（设计 `:238-247`）。
- 失败路径新增了正确的放行门语义：真实 orca fixture 不 abort 或锚点负例误杀，都直接视为本方案未完成并撤回 Grok 门；不得调 Gemini/DeepSeek 数字或偷偷接 header-runaway（设计 `:253-264`, `:296-297`）。
- 兼容性边界清楚：旧 transcript 不改写，新的字段名 thinking-only stop 才改变重试解释；无 API/settings/schema 退役（设计 `:267-275`）。

## 5. 验证计划

- §6.1 现在是明确的放行门，不是建议性附录：门真值覆盖 gateway and namespaced Grok id；命中覆盖 near-dup、back-to-back 和真实 orca 17×；负例覆盖 `distinctReasoning()` 与八段新 anchor 分段推理；空停覆盖三字段 table、Claude-like signed stop、text/toolCall、retry cap；session 覆盖仅 gateway/grok-4.6；prompt/schema/changelog 契约均列出（设计 `:278-318`）。
- §6.2 仍只在质量全绿后做 token 证据，且不把长会话总量当本 PR 门槛（设计 `:306-318`）。
- Implementer 的执行顺序也遵守门禁：先空停 table，再 guard 夹具和负例；orca 不 abort 即停止，不进入 session/prompt/changelog 后续（设计 `:319-348`）。

## 6. Findings

### HIGH

- None. 未发现错误 owner、第二套 engine、wire contract 破坏、倒置 fail-open/fail-closed、abort 泄漏或必须阻塞实现的 P1 问题。

### MEDIUM

- None. Round-1 MEDIUM-1/2 均已由可执行 scope/fixture/release gate 关闭；当前未发现新的 P2。

### LOW

- None. Round-1 LOW-1/2 已由显式 marker 断言和本地三字段同步契约关闭；非 gateway 未验证范围已作为明确 note，而非遗漏。

## 7. 是否可实现

- **可实现：是。** 方案 A 的模块、调用点、失败路径、兼容策略和验证夹具均已明确；实现只需在既有 AI/session/prompt owner 上落地，不需要新 engine、迁移或 settings key。
- `implementation_authorization=authorized`，且本轮 Gate 为 `PASS_WITH_NOTES`；可在本 artifact manifest 与设计输入保持一致的前提下，由未参与 author/reviewer 的独立 implementer 执行，再按 §6.1 → §6.2 验证。非 gateway Grok 路径不得在实现或 changelog 中被扩写为已支持。

## Gate Continuity Notes

Coordinator: Main (not author/reviewer/implementer of design content). Model: gateway/grok-4.6.

Reviewed Inputs (R2, unchanged):

| Path | SHA-256 |
|---|---|
| `docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-design.md` | `a5d46038f1a421ef74ca1dc26a8c7c3659d7bb04ac433796f70f60515de2a061` |
| `docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-facts-brief.md` | `d2bf57e954d70beb09b1dfb468346a6ad99a9c36546e9af059fd90ce70f58756` |

Current Inputs: same as Reviewed Inputs. `reviewed_revision` still `faa5ab7e59a819f03372d90837bd2d6edf02503445f2bbc3fe0562cea29b42c0`.

Change: none to design inputs. Implementation executed Option A’s fail-closed branch after §6.1 item 2.3 (orca 17× non-adjacent chunked short sentence) did **not** abort under current `ThinkingLoopDetector` thresholds. Per design `:296-320`, the Grok `isLoopGuardedModel` branch was **not** added.

Unchanged decisions / invariants / acceptance:

- Empty-stop field-name signatures (`reasoning_content` / `reasoning` / `reasoning_text`) retry; Claude-style `"nonempty"` stays terminal.
- Prompt cuts only: overlay step-by-step double-write; `task.md` schema enum literals. Delivery/safety and `system-prompt.md` untouched.
- Gemini/DeepSeek loop-guard thresholds, header-runaway, empty-completion-retry commit-on-thinking_delta, Fast-mode, compaction, idle 300s unchanged.
- Non-gateway Grok stream/session loop handling remains unpromised.

This note does not change the R2 verdict or implementation authorization.

