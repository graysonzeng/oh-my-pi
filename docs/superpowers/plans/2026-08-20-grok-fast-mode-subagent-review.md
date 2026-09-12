# Subagent Review: grok-fast-mode

- Date: 2026-08-20
- Review Artifact: docs/superpowers/plans/2026-08-20-grok-fast-mode-subagent-review.md
- Primary Reviewed Design: docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md
- Reviewed Inputs:

| Path | SHA-256 |
|---|---|
| `docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md` | `b6f883ea58e3b849d98e99b134fc1c1216cd1e22fc04ed859c1402b006cfe6a0` |
| `docs/superpowers/specs/2026-08-20-grok-fast-mode-facts-brief.md` | `3bdd04fc97d327ac304c26c48e449b08c55bc10c9421f3ddc9459fa11a307d7c` |

- Reviewed Revision: `29e2291968514b5a27d067f4d7da8c589ad9f739b792ec5d4be5d9747d51d363`
- Review Mode: host-native
- Design Author Identity: GrokDesigner
- Design Author Model: gateway/grok-4.6
- Reviewer Identity: subagent-grok
- Reviewer Model: cursor-grok-4.6-xhigh (user-requested /subagent-grok; planned was sol-xhigh-reviewer)
- Review Fallback: grok-4.6
- Fallback Reason: user 2026-08-20 explicitly invoked `/subagent-grok` instead of planned sol-xhigh-reviewer
- Implementation Authorization: design-only (document); session user later authorized implement-after-review
- Authorization Source: 用户 2026-08-20「grok 是支持 Fast mode。分析下如果添加并设计方案」；随后「可以直接交给 grok-4.6 subagent 作者起草」
- Review Scope: Design Review Gate for independent xai ServiceTierFamily (方案 A)

Hash check: `shasum -a 256` of both files and of the canonical TAB/LF manifest matched the provided digests. Proceeded.

## 1. 整体结论

- **NEEDS_REVISION**
- 方案 A（独立 `xai` family、只发 `priority`、OpenRouter send-but-not-realize、遗留迁移不 retroactive）对照当前源码成立，不需要换 family；但 `createSubagentSettings` 把解析后的 map **只回写三家** `tier.*`，设计漏列该调用点，按原文实现会让 `tier.subagent` 广播在 Grok 上失效或把全局 `tier.xai` 漏进子 agent。

## 2. 根因评审结论

- **适用性：** 跳过 RCA 合适。
- **结论：** 这是已知功能缺口，不是未知故障；facts brief「规模与根因」与设计 §2 一致。
- **理由：** 当前 `ServiceTierFamily` 只有三家（`packages/ai/src/types.ts:145`），`serviceTierFamily` 对 `openrouter` 只认 `anthropic/` / `google/` / `openai/` 前缀（`:188-193`），`isOpenAIModelId` 不匹配 `grok-*`（`packages/catalog/src/identity/family.ts:144-149`），因此 `xai` / `xai-oauth` / `gateway`+Grok / `openrouter`+`x-ai/grok-*` 今日 `family === undefined`。`setFastMode` 无 family 即返回 `false`（`packages/coding-agent/src/session/model-controls.ts:725-733`）。机制已定位，不需要另做排障式 RCA。[历史事实]

## 3. 设计方案评审

### 3.1 需求与方向

用户可观察标准被落成 §1.2 六条，语义与 facts brief 成功标准对齐：capable 路径 `/fast on` 不再不可用；`enabled`/`active` 与现有 family 同构；wire 只发 `priority`；非 Grok / Fireworks / Anthropic / OpenAI / Google 不回归；不支持路径不谎称 `active`；旧 session 缺第四 key 默认关。[拟议验收目标] 对照源码可落地。

非目标正确：不把 `grok-4-fast` SKU 当 session Fast；不复制 Anthropic sticky；不把 xAI 2× 写进 `getPriorityPremiumRequests`；不扩 `applyOpenAIResponsesServiceTierCost` 的 OpenAI 闸门。官方 Priority 声明未超出 facts brief §26（省略≡default、回显计费、文本 Completions/Responses、image/video/Batch 不可用）。[历史事实]

### 3.2 方案合理性 (A vs B vs C; family isolation; send vs realize)

**A vs B vs C 是真对比，不是摆设。**

- **否决 C：** `setFastMode` 无 family 必须失败（`model-controls.ts:725-733`）。无 family 只发报会变成「开关失败但字段已发出」，直接违反决策面 5。Fireworks 才是独立旋钮、`/fast` 不可用（`model-controls.ts:684-688` + `rpc.test.ts:345-357`）。[历史事实]
- **否决 B：** `ServiceTierByFamily` 注释就是「一家的 priority 不影响另一家」（`types.ts:147-151`）。并入 openai 会让 Grok `/fast on` 改写 `tier.openai`，切回 `gpt-*` 也加急；`flex/scale` 与 xAI 两档合同抢同一槽。这是第二套规则藏在第一套里。[历史事实]+[推导]
- **推荐 A：** 独立 `"xai"`、`tier.xai` = `none|priority`、复用 `setFastMode` / `applyOpenAIServiceTier`。与 Anthropic 档位同构，不新建 `providers.xaiTier`。family 选择正确，**不是 NEEDS_REDESIGN**。[拟议但已确定]

**Send vs realize 表对照源码：**

| 路径 | 源码机制 | 设计 | 判定 |
|---|---|---|---|
| bundled `xai` / `xai-oauth` | catalog `api` 分别为 `openai-completions` / `openai-responses`，`baseUrl` 含 `api.x.ai`；`applyOpenAIServiceTier` 走 model 对象 | family+send+realize | 成立 |
| `gateway` + Grok + OpenAI-compat | `isOpenAIServiceTierApi` = 三个 OpenAI-compat API（`types.ts:157-159`）；auth-gateway 转发 `options.serviceTier`（`auth-gateway/server.ts:160`） | family+realize | 产品选择；[未验证假设 A/B] 已标明 |
| OpenRouter `x-ai/grok-*` | `shouldSend` 对 provider `openrouter` 发 `flex\|scale\|priority`（`types.ts:228-229`）；`realizes` 白名单只有 openai/google（`:257-259`）；stream 的 `api: "openrouter"` 仍进 Completions/Responses 并调用 `applyOpenAIServiceTier` | family + **send** + **不 realize** | 成立，未倒置 |
| aimlapi / opencode-* | `isOpenAIModelId("grok-4.5")` 为 false → 今日无 family；设计继续 fail-closed | 无 family | 成立；[未验证假设 D] |
| github-copilot / fireworks | `excludesInferredOpenAIServiceTier`（`types.ts:161-165`） | 排除 / 不进 family | 成立 |

**未倒置 fail-closed/fail-open：** 全局 fail-closed 在未知代理；唯一 fail-open 是 gateway+Grok+OpenAI-compat 的 realize=true，设计写成产品选择而非全局策略。OpenRouter 不是「无 family 却发字段」：有 family 才会 `resolveModelServiceTier` 出 `priority`。legacy `serviceTier: "priority"` 今日只填三家（`settings.ts:1751-1756`），不 retroactive 填 xai 与「避免无同意 2×」一致。[历史事实]

**Wire 只发 `priority`：** `applyOpenAIServiceTier` 只写入 `flex|scale|priority`（`openai-shared.ts:331-334`），且从不写 `default`。xai 的 `shouldSend` 收成仅 `priority` 后，不会发 `default`/`flex`/`scale`（OpenRouter 对象路径有例外，见 MEDIUM）。[历史事实]+[推导]

### 3.3 实现可行性 (call sites, types, tests)

**已核对且设计列对的调用点：**

- `buildServiceTierByFamily` 三参：`service-tier.ts:103-111`；调用方 `sdk.ts:3385-3388`、`agent-session.ts:8001-8004`、`bench-cli.ts:810-813`、`executor.ts:866-869`。[历史事实]
- `applyOpenAIServiceTier` 仅三处：`openai-completions.ts:1610`、`openai-shared.ts:3170`、`openai-codex-responses.ts:1494`。[历史事实]
- `Model` **已有** 必填 `baseUrl`（`packages/catalog/src/types.ts:807-828`）。今日 `ServiceTierModel = Pick<Model, "provider" | "api" | "id">`（`types.ts:155`），扩可选 `baseUrl` 合法。`hostMatchesUrl` / `KNOWN_HOSTS.xai.urlMarkers: ["api.x.ai"]`、`providers: ["xai"]` 不含 `xai-oauth`（`hosts.ts:50,74-80`）——必须靠显式 provider 字符串，不能只靠 `modelMatchesHost`。[历史事实]
- `isGrokModelId = /(^|[/.])grok[-.]/i`（`family.ts:92-94`）。bundled `xai` 最新 `grok-4.5`，catalog **无** `grok-4.6` 条目。[历史事实]
- `coerce` 对象扫描三家、标量 `"priority"` 三家（`types.ts:298-313`）；session 恢复走 `coerceServiceTierByFamily`（`session-context.ts:246-247`）。第四 key 必须进 coerce 对象路径，否则 `/fast on` 持久化后 resume 会丢 `xai`。设计已覆盖。[历史事实]
- `getPriorityPremiumRequests` 白名单五家 billing provider（`types.ts:277-289`）；`applyOpenAIResponsesServiceTierCost` `provider !== "openai" return`（`openai-shared.ts:362-368`）。不计 Copilot-premium、不扩 OpenAI 2×：正确。[历史事实]
- Anthropic sticky / `disabledFeatures: ["priority"]` 只清 anthropic（`agent-session.ts:2518-2527`）。不顺手清 xai：正确。[历史事实]
- `/fast` 文案与精确 error：`builtin-registry.ts:572,589-597`；RPC `rpc-mode.ts:1106-1114`；`formatFastModeStatus` 只看 enabled（`:98-100`）。[历史事实]

**阻塞缺口：** `createSubagentSettings` 在 `buildServiceTierByFamily` 之后把解析 map **只 stamp 三键**（`executor.ts:873-875`）。设计 §4.4 列出了四参 `buildServiceTierByFamily`，并声称 `serviceTierForAllFamilies("priority")` 含 xai 是为了让 `tier.subagent` / advisor / bench 吃到 priority（设计 `:296`），但没写 stamp `snapshot["tier.xai"]`。今日 stamp 用 `?? "none"` 正是为了清掉未广播的 family，避免父 settings 泄漏（同文件 `:873-875`）。漏 stamp 后：`tier.subagent=priority` 的 Grok 子 agent 仍读全局 `tier.xai`（多为 none）；`tier.subagent=flex` 会把父级 `tier.xai=priority` 漏进去。这是合同洞，不是实现细节。[历史事实]+[推导]

`ExtensionServiceTier` 条件类型只有 anthropic/google 特化，其余落到完整 `ServiceTier`（`extensions/types.ts:1079-1083`）。不补 `xai → "priority"` 时，扩展 API 在类型上允许 `flex`；运行时 `isServiceTierForFamily` 会拒。需在修订里点名，不单独升为 HIGH。

§7 测试覆盖分类/send/realize/coerce/迁移/RPC Fireworks 回归，方向对；缺 `createSubagentSettings` 的 `tier.xai` stamp 断言。OpenRouter 夹具 `api: "openai-completions"` 与 catalog `api: "openrouter"` 不一致，因 OR 分支看 provider 不看 api，**不会锁错产品 API**，但应用 catalog-faithful 夹具。

### 3.4 文档质量

结构完整：目标、A/B/C、规范表、决策表、风险、验证、handoff。证据标签使用正确。§4.4 与 §6 对「第四参数默认值 vs 漏改由 TS 逼失败」自相矛盾（见 MEDIUM）。`docs/settings.md:402-406`、`docs/rpc.md:297-351` 引用准确。相关文档 `docs/tools/task.md` 仍写三家 stamp，设计未列，应随 HIGH 一并改。

官方 xAI 声明未超出 brief；未把 2× 写进 omp 成本函数。gateway realize=true 的风险写进了 §6，不是隐瞒。

## 4. 主要发现

### CRITICAL

none

### HIGH

**1. 漏列 `createSubagentSettings` 的第四家 stamp，子 agent 合同按原文会错**

- Spec: `docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md:276-294`、`:296`、`:420-452`
- Source: `packages/coding-agent/src/task/executor.ts:851-875`（`buildServiceTierByFamily` `:866-869` + 只 stamp openai/anthropic/google `:873-875`）；对照现有三家「缺省写 none」的防泄漏模式
- Impact: `tier.subagent=priority` 时 Grok 子 agent 吃不到 xai priority；`flex`/`inherit` 与全局 `tier.xai` 交叉时 fail-open 泄漏。与设计自己写的「子 agent 属于 xai family 时能吃到 priority」冲突。
- Required revision: §4.4 明确 `snapshot["tier.xai"] = subagentTiers.xai ?? "none"`；§7.2 加测试；同步 `docs/tools/task.md` 里三家 stamp 的表述。不要依赖第四参数 default 去「顺便修好」。

### MEDIUM

**2. §4.4 默认第四参与 §6「类型迫使 TS 失败」互相否定**

- Spec: 设计 `:276-285` vs `:413`
- Source: 今日三参、无 default（`service-tier.ts:103`）。TS 对少传必选参数会失败；`xai: string = "none"` 后三参调用继续编译。
- Impact: 漏改调用方时 live map 的 xai 静默为 none，正是 §6 要防的洞；default 拆掉了那条缓解。
- Required revision: 第四参 **不要** default；或明确「default 只作迁移期安全带，仍须 grep 全调用方 + stamp」。不能两头说。

**3. media 排除比 catalog 非 chat 前缀少 `grok-stt-`**

- Spec: 设计 `:176-180`、`:261`
- Source: `packages/catalog/src/provider-models/openai-compat.ts:1178-1180`、`:1268`（`XAI_NON_CHAT_PREFIXES = grok-imagine- | grok-stt- | grok-voice-`）。bundled `models.json` 无这些 id；动态 `/v1/models` 会返回并由 picker 过滤。
- Impact: 自定义/未过滤的 `grok-stt-*` 会被当成 xai-capable 文本 Fast。[拟议但已确定] 的「非文本不进 family」不完整。
- Required revision: 排除与 catalog 三前缀对齐（正则或复用等价谓词），§7.1 加 `grok-stt-*` 夹具。

**4. OpenRouter Grok 的 `shouldSend` 分支顺序会让 `flex|scale` 穿透**

- Spec: §4.2 把 xai 分支放在现有 openrouter 分支 **之后**，并「保持」OR 对 `flex|scale|priority` 为 true（设计 `:213-218`）；§4.5 又说 xai family 的 `shouldSend` 对 flex/scale 为 false（`:328`）
- Source: `types.ts:228-229` 对任意 `provider === "openrouter"` 先返回 true（含 scale）
- Impact: 若 coerce 读到 `xai: "flex"`（对象路径允许五档，`types.ts:303-307`），OR Grok 会发未文档化的 `flex`/`scale`。settings 层挡住大部分路径，但 wire 合同自相矛盾。
- Required revision: 对象且 `serviceTierFamily === "xai"` 时 **先于** openrouter 通用分支只允许 `priority`；或把 OR 明确写成「继承 OR 的 flex|scale|priority 矩阵」并改 §4.5。选一个，不要两套话。

### LOW

**5. OpenRouter 测试夹具 `api` 与 catalog 不一致**

- Spec: 设计 `:430`
- Source: catalog OpenRouter Grok 为 `provider: openrouter`, `api: openrouter`；OR 分类看 provider（`types.ts:188-193`），`isOpenAIServiceTierApi` **不含** `"openrouter"`（`:157-159`）
- Impact: 不锁错产品 API；若有人误把 Grok 只走 `isXaiServiceTierModel`（要求 OpenAI-compat api），生产 OR 会无 family 而测试仍绿。
- Required revision: §7.1 增加 `m("openrouter", "openrouter", "x-ai/grok-4.5")`（可保留 completions 夹具作对照）。

**6. 扩展 API 与若干 Pick 类型未点名**

- Spec: 未写 `ExtensionServiceTier`；只扩 `ServiceTierModel`
- Source: `extensions/types.ts:1079-1083`；`applyOpenAIServiceTier` / `resolveModelServiceTier` / `realizesPriorityServiceTier` 使用独立 `Pick<Model, "provider" | "api" | "id">`（`openai-shared.ts:329`、`types.ts:206-208,251-253`）。运行时完整 `Model` 仍带 `baseUrl`（`catalog/src/types.ts:828`），自定义 `api.x.ai` 中继在会话路径可工作。
- Impact: 扩展 TS 过宽；自定义中继的 URL 命中在类型层不可见。
- Required revision: `ExtensionServiceTier<"xai"> = "priority"`；上述 Pick 与 `ServiceTierModel` 一同允许可选 `baseUrl`。

## 5. 修订建议

1. **保留方案 A。** 不要并入 openai，不要无 family 只发报。
2. **补全第四家贯穿清单：** `createSubagentSettings` stamp、`serviceTierForAllFamilies`、`coerce` 对象扫描、`isServiceTierFamily` / `isServiceTierForFamily`、四参 `buildServiceTierByFamily`（不要用 default 掩盖漏改）、schema `tier.xai`、session coerce 往返。
3. **消掉 §4.4 / §4.5 / §4.2 的 shouldSend 顺序矛盾；** media 排除对齐 `grok-stt-`；OR 测试夹具用 catalog `api: "openrouter"`。
4. **§7.2 增加** `createSubagentSettings`：`priority` 广播 → `tier.xai=priority`；`flex` 广播 → `tier.xai=none`（即使父 settings 为 priority）。
5. 修订后重跑 Design Review Gate；**本 Gate 未通过前不得按该设计实现。** 会话里「审完再实现」是 coordinator 上下文，不改变文档的 `implementation_authorization: design-only`。

## 6. Gate Evidence

- Verdict: **NEEDS_REVISION**
- Covered Revision: `29e2291968514b5a27d067f4d7da8c589ad9f739b792ec5d4be5d9747d51d363`
- Evidence Summary:
  - Family 现状三家：`packages/ai/src/types.ts:145,186-199`
  - `/fast` 无 family 失败：`model-controls.ts:725-733`；文案 `builtin-registry.ts:572,591`
  - OpenRouter send vs realize：`types.ts:228-229,257-259`；catalog `api: "openrouter"`；stream 仍走 `applyOpenAIServiceTier`
  - 发报函数与调用点：`openai-shared.ts:326-334,3170`；`openai-completions.ts:1610`；`openai-codex-responses.ts:1494`
  - Gateway 转发：`auth-gateway/server.ts:160`
  - 迁移不填第四家（今日）：`settings.ts:1751-1756`；测试 `service-tier-migration.test.ts:43-47`
  - 子 agent 只 stamp 三家：`executor.ts:873-875`
  - hosts / grok id / Model.baseUrl：`hosts.ts:50,74-80`；`family.ts:92-94,144-149`；`catalog/src/types.ts:828`
  - Copilot-premium / OpenAI 2× 闸门：`types.ts:277-289`；`openai-shared.ts:362-368`
  - 官方 Priority 未超出 facts brief §26；设计未把 2× 写进 omp 成本

### 6.1 Gate Continuity Notes

- Initial state: none

## 7. 下一步建议

作者修订设计文档（至少补上 HIGH #1 与 MEDIUM #2–4），重跑独立 Design Review Gate。**不要实现。** 通过后，coordinator 可依据会话里后来的「审完再实现」授权进入实现；该授权不在当前设计正文里，也不能当作本次 Gate 已通过。

## 8. Handoff

### 8.1 PASS* 且已授权实现

不适用（本轮 verdict 为 NEEDS_REVISION）。

### 8.2 PASS* 但仅限设计

不适用。

### 8.3 NEEDS_REVISION / NEEDS_REDESIGN

**同会话继续**

回到 design 文档修订（保留方案 A），由 author subagent 按已采纳 finding 修订，并重新执行 Design Review Gate。Gate 通过前不得实现。

**新会话恢复 prompt**

```text
请阅读设计文档 docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md
和评审文档 docs/superpowers/plans/2026-08-20-grok-fast-mode-subagent-review.md，
根据 verdict NEEDS_REVISION 由 author subagent 修订完整设计（保留独立 xai family / 方案 A）；主 agent 只协调，不写设计正文。
修订完成后重新执行 Design Review Gate（本次用户指定 /subagent-grok），未通过前不得实现。
用户已声明评审通过后实现并验证；该授权在 Gate PASS* 之前不得消费。
```

## Coordinator classification（主协调者，非 reviewer 正文）

主协调者对照源码后的采纳判定（供 author 修订，不改变 reviewer verdict）：

| Finding | 判定 | 理由 |
|---|---|---|
| HIGH 1 createSubagentSettings stamp | **采纳** | 已读 `executor.ts:873-875`，只 stamp 三家；`?? "none"` 是防泄漏。漏 stamp 会破坏 `tier.subagent` 广播与隔离。 |
| MEDIUM 2 第四参 default | **采纳** | 已读 `service-tier.ts:103` 三必选参。选「第四参不要 default」，用 TS 逼改调用方。 |
| MEDIUM 3 grok-stt- | **采纳** | 已读 `openai-compat.ts:1180` `XAI_NON_CHAT_PREFIXES`。排除对齐 imagine/stt/voice。 |
| MEDIUM 4 shouldSend 顺序 | **采纳** | 已读 `types.ts:228-229`。选定：对象且 `serviceTierFamily === "xai"` 时先于 openrouter 通用分支，只允许 `priority`。OR 字符串 provider 无 model 对象时保持现行为（无法分类 family）。 |
| LOW 5 OR 夹具 api | **采纳** | catalog-faithful；不改变产品合同。 |
| LOW 6 ExtensionServiceTier / Pick baseUrl | **采纳** | 与 anthropic/google 特化同构；Pick 与 ServiceTierModel 一并允许可选 baseUrl。 |
