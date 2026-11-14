# Design: Grok Fast Mode

- Date: 2026-08-20
- Status: Authorized after Gate PASS_WITH_NOTES
- Scope: M
- design_author: grok
- design_author_identity: GrokDesigner
- planned_reviewer: `/subagent-grok`（cursor-grok-4.6-xhigh，只读）。Round-1 Gate 实际 reviewer 即用户指定的 `/subagent-grok`（起草时 planned 为 sol-xhigh-reviewer）；Round-2 Gate 仍为 `/subagent-grok`，verdict=PASS_WITH_NOTES（artifact `docs/superpowers/plans/2026-08-20-grok-fast-mode-subagent-review-round-2.md`）
- implementation_authorization: authorized
- authorization_source: 用户 2026-08-20「/subagent-grok 评审完成后进行实现并验证」。前置设计授权：用户 2026-08-20「grok 是支持 Fast mode。分析下如果添加并设计方案」；随后「可以直接交给 grok-4.6 subagent 作者起草」。Round-2 Covered Revision `d6f4f9f4d4481d7936380da9018867237aced11eeb2821dbcbbaa211f5108649`。本字段由主协调者在 Gate PASS* 后翻转为 authorized；方案正文未改。

当前正文作者仅 `design_author_identity` 对应的单一 grok author。推荐方案仍是独立 `ServiceTierFamily` `"xai"`（方案 A）。Round-2 Design Review Gate = PASS_WITH_NOTES。实现由独立 implementer 执行，不得由 reviewer 改代码。

证据标签：[历史事实]=源码或官方文档直接观察；[推导]=由已确认事实推出；[未验证假设]=尚未验证；[拟议但已确定]=本设计拍板；[拟议验收目标]=实现后必须达到的运营/质量门槛。

事实输入：`docs/superpowers/specs/2026-08-20-grok-fast-mode-facts-brief.md`。本文方案结论由作者提出；不得把 coordinator 未给出的方案写进「已确认事实」。

## 1. 设计目标和范围

### 1.1 要解决的问题

omp Fast mode 是一套已存在的 per-family 旋钮：`/fast`、RPC `set_fast_mode`、settings `tier.*`、session `service_tier_change` 都通过 `ServiceTierFamily` + `ModelControls.setFastMode` 工作，发报走 `shouldSendServiceTier` / `applyOpenAIServiceTier`，是否算「生效」走 `realizesPriorityServiceTier`。[历史事实]

xAI 官方 Priority Processing 与 OpenAI 同名同字段：在 Chat Completions / Responses 请求体加 `service_tier: "priority"`（也可 `"default"`；省略 = 标准调度）。响应回显实际 `service_tier`；仅当回显 `"priority"` 才按 priority 计费（各 token 类型 2×；prompt cache 折扣先于乘数）。文本推理可用；image / video generation 与 Batch API 不可用。文档示例 model 为 `"grok-4.6"`。[历史事实]

但今天 Grok 路径没有 family：`ServiceTierFamily = "openai" | "anthropic" | "google"`，`isOpenAIModelId` 不匹配 `grok-*`，`openrouter` 只认 `anthropic/` / `google/` / `openai/` 前缀。因此 `xai/grok-*`、`xai-oauth/grok-*`、`gateway/grok-4.6`、`openrouter/x-ai/grok-*`、`aimlapi/x-ai/grok-*` 的 `serviceTierFamily === undefined`。`/fast on` 走 `setFastMode` → 无 family → 返回 `false` → 精确文案 `Fast mode is unavailable for the current model.` `shouldSendServiceTier` 对字符串 provider `xai` / `xai-oauth` / `gateway` 落在最终 `return false`，即使会话里硬塞了 map 也不会发报。[历史事实]+[推导]

用户当前模型是 `gateway/grok-4.6`。要解决的是：**在不新建第二套 Fast-mode 引擎的前提下，让支持 xAI Priority Processing 的 Grok 文本路径接入现有 `/fast` / RPC / `tier.*` 合同，并在不适用的代理上 fail-closed，避免谎称已加急。**

### 1.2 成功标准

把 facts brief 的用户可观察标准落成验收条款，不改变语义。[拟议验收目标]

1. 在本设计判定为 **xAI-capable Grok 文本模型** 上（见 §4.3），`/fast on` 不再输出 `Fast mode is unavailable for the current model.`；RPC `set_fast_mode` `{enabled:true}` 不再返回该精确 error 字符串。
2. `/fast off`、`/fast status`、RPC `set_fast_mode`、`get_state.fastModeEnabled` / `fastModeActive` 与现有三家 family 语义对齐：`enabled` = 该 family map 值为 `priority`；`active` = `realizesPriorityServiceTier(effectiveServiceTier(model), model)`（Anthropic 另看 sticky fallback；Grok 无对等 sticky）。`/fast off` 在无 family 时仍 idempotent 成功并输出 `Fast mode disabled.`
3. 打开 Fast mode 后，下一请求在适用的 Chat Completions / Responses（含 Codex Responses 共享的 `applyOpenAIServiceTier`）路径上发出 `service_tier: "priority"`。不发 `default`（省略 = xAI default）；不发 `flex` / `scale`。
4. 非 Grok 模型、Fireworks 独立旋钮、Anthropic `speed: "fast"`、OpenAI / Google 现有 family、GitHub Copilot 排除、Bedrock/Vertex Claude 不 realize、OpenRouter Anthropic 不 realize，行为不回归。
5. 不支持加急的 Grok 代理路径：`serviceTierFamily === undefined`（`/fast on` 失败）或 `enabled === true` 且 `active === false`（允许开关，但不把 `fastModeActive` 打成 true）。禁止「无 family 却已发字段」和「active=true 但本设计认为线上不会加急」。
6. 旧 session 的 `service_tier_change` 若缺第四 key，打开 Grok 时 Fast 默认为关，直到用户 `/fast on` 或设置 `tier.xai`。遗留标量 `serviceTier: "priority"` 迁移不 retroactive 填第四家。

### 1.3 本次范围

- 扩展现有 Fast-mode 所有者，不换引擎：`ServiceTierFamily` / `serviceTierFamily` / `shouldSendServiceTier` / `realizesPriorityServiceTier` / `coerceServiceTierByFamily` / `applyOpenAIServiceTier` / `ModelControls.setFastMode` / `tier.*` / `service_tier_change`。
- 分类规则覆盖：bundled `xai`、`xai-oauth`、`gateway` + Grok id、OpenRouter `x-ai/grok-*`、带 `api.x.ai` 的自定义 OpenAI-compat 中继、以及其他 Grok 代理的 fail-closed。
- 设置合同、持久化 / 迁移、发报、失败路径、计费统计边界、回归、测试与文档。
- 本阶段只设计，不改产品代码。

### 1.4 非目标

- 实现代码、CI、catalog 补 `grok-4.6` 条目（bundled `xai` 最新到 `grok-4.5` 不阻塞设计；运行时 id 以 `isGrokModelId` 为准）。[历史事实]
- 把 SKU 名带 `fast` 的模型（`grok-4-fast`、Fireworks `-fast`）等同于 session Fast mode。`grok-4-fast` 仍可以是 xai family 的普通文本模型，`/fast` 是独立旋钮。
- 把 thinking / `reasoning_effort` 当成 Fast mode。
- 为 xAI 复制 Anthropic in-provider sticky fallback（`speed` + beta 去掉并重试、`disabledFeatures: ["priority"]` 清 family）。xAI 文档的失败模式是接受请求并可能回显 `default`，不是 400 拒字。[历史事实]+[拟议但已确定]
- 把 xAI 2× 费率写进 Copilot-premium 计数 `getPriorityPremiumRequests`，或把 `applyOpenAIResponsesServiceTierCost` 的 OpenAI 2× 扩到 `provider === "xai"`。
- 为 image / video / STT / voice / Batch 路径发明 Priority 发报。
- 新建 `providers.xaiTier` 这类第二套 provider-level 旋钮（Fireworks 模式）。Fireworks 被刻意排除出 family，`/fast` 对其不可用；Grok 的目标正好相反。

## 2. 根因分析

根因分析：不需要。理由见 facts brief「规模与根因」——已知功能缺口，不是未知故障。用户已声明 Grok 支持 Fast mode，要求设计如何接入。本节不把方案论证改写成排障报告。

缺口的机制（供方案对照，不是根因调查）：family 分类与 `isOpenAIModelId` 把 Grok 排除在三家旋钮之外，因此 toggle / 发报 / realize 整条链短路。[历史事实]

## 3. 方案对比

主协调者未预选方案。下面三个都是可落地的真实路径，共用同一组所有者，差别在 **family 落点** 与 **未知代理的 fail-closed 程度**。

### 3.1 方案 A — 独立 `xai` family（推荐）

**做法：** `ServiceTierFamily` 增加 `"xai"`。新增 settings `tier.xai`（`none | priority`，默认 `none`），与 Anthropic 档位同构。`/fast` 对当前模型的 xai family 写入 / 清除 `priority`。发报仍走 `applyOpenAIServiceTier` → `params.service_tier`。分类按 §4.3：第一方与 gateway+Grok+OpenAI-compat 为 capable（toggle + send + realize）；OpenRouter `x-ai/grok-*` 为 family + send、realize=false；其余 Grok 代理 fail-closed（无 family）。

**优点：**

- 保持现有不变量：「切换模型时，一家的 priority 不影响另一家」。[历史事实] `types.ts` 对 `ServiceTierByFamily` 的注释即此语义。把 Grok 并进 openai family 会破坏它。
- xAI 只文档化 `default | priority`，独立 family 可以把合法档位收成 `none | priority`，从设置层挡住 `flex/scale`，不必在 openai 的六档里特判。
- `/fast` / RPC / session map 零新引擎：`setFastMode` 已按 `serviceTierFamily(currentModel)` 工作。
- 与 OpenRouter Anthropic 的「有 family、不 realize」模式同构，可表达「开关在、加急未证实」。

**缺点：**

- 第四家要贯穿类型、coerce、settings schema、`buildServiceTierByFamily` 的全部调用方、广播、文档、测试。改动面比方案 B 宽。
- 旧 `service_tier_change` 没有 `xai` key 时，Grok Fast 默认关（见 §4.6）；不是 bug，但已开着「全局 priority」的用户不会自动获得 Grok 加急。

**风险：** gateway 上游是否转发 `service_tier` 未验证。[未验证假设 B] 方案 A 对 `gateway` + Grok + OpenAI-compat **realize=true**（用户主路径，auth-gateway 已转发 `options.serviceTier`）。若某套 gateway 剥字段，会出现「active=true 但上游未加急」。缓解见 §6：验收用第一方 `api.x.ai` 金路径；gateway 剥字段视为实现后缺陷，收紧 realize，而不是设计阶段把用户主路径做成永远 `active=false`。

### 3.2 方案 B — 并入现有 `openai` family，仅按 host+id 发报

**做法：** 不增加 family。`serviceTierFamily` 在 OpenAI-compat + `isGrokModelId` + xAI-capable 主机时返回 `"openai"`。`/fast on` 写 `tier.openai` / map.openai。`shouldSendServiceTier` 对 xAI-capable 模型只发 `priority`（即使 map 里是 `flex/scale` 也不发）。无新 settings 键。

**优点：**

- 改动面最小：多数设置 / 迁移 / coerce 三家扫描不用动。
- 遗留 `serviceTier: "priority"` 已迁移到 openai=priority，Grok 会「自动」吃到 Fast——对只开过全局 priority 的用户更顺。

**缺点：**

- **破坏 per-family 隔离。** 在 Grok 上 `/fast on` 等于把 OpenAI family 打成 priority；切到 `gpt-*` 也会加急。反之，用户只想给 GPT 开 flex 时，Grok 的 map 入口变成 flex：`isFastModeEnabled` 为 false（只认 `=== "priority"`），同时 flex 又不能发给 xAI。Grok Fast 与 OpenAI flex/scale 抢同一个槽。
- xAI 不文档化 `auto|flex|scale`。并入 openai 后，UI 仍展示六档；用户把 `tier.openai` 设成 flex 会以为 Grok 也在用廉价档，实际字段被省略。[未验证假设 E]
- OpenRouter Grok 若也返回 openai family，会与「OpenRouter 只对 `openai/` 前缀回 openai family」的现规则冲突，或被迫让 `x-ai/grok-*` 冒充 openai family，分类可读性变差。

**风险：** 表面省一个 key，把 xAI 的两档合同揉进 OpenAI 六档，后续每个 `isServiceTierForFamily("openai")` 都要记得 Grok 例外。这是第二套规则藏在第一套里，违反「复用所有者、不另起引擎」的精神。

### 3.3 方案 C — 无 family，仅 host+id 发报（否决）

**做法：** 不扩展 `ServiceTierFamily`。在 `applyOpenAIServiceTier` / `shouldSendServiceTier` 里若 `isGrokModelId` 且 host 为 `api.x.ai` 且会话某处为 priority，就发字段。

**否决理由：** `setFastMode` 在 `serviceTierFamily === undefined` 时必须返回 `false` 并发 notice「The current model has no service-tier control for /fast to toggle.」[历史事实] 无 family 则 `/fast on` 仍不可用，直接违反成功标准 1。若再绕过 family 发报，会变成「开关失败但字段已发出」——决策面 5 的反面。Fireworks 才是「独立旋钮、/fast 不可用」；Grok 不能走那条。

### 3.4 推荐与理由

**推荐方案 A：独立 `xai` family，fail-closed 分类，只发 `priority`，不复制 Anthropic sticky，不计 Copilot-premium。**

理由（对应决策面）：

1. Family 落点：独立 `xai`，不并入 openai，不按 Fireworks 另起 provider 旋钮。
2. 分类：第一方 + gateway Grok 文本 + `api.x.ai` 中继为 capable；OpenRouter Grok 可开关但默认不 realize；其他代理无 family。
3. 设置：新增 `tier.xai`；遗留迁移不 retroactive。
4. Wire：只发 `priority`；省略即 default；`flex/scale` 忽略不透传。
5. 三者关系：无 family ⇒ 不发、toggle 失败；有 family 且 realize ⇒ enabled 与 active 同真；有 family 不 realize ⇒ enabled 可真、active 必假。
6. 失败：信 xAI「看回显计费」，omp 的 `active` 仍是 request-side（与 OpenAI Fast 一致）；不 sticky 关 family。
7. 计费：`getPriorityPremiumRequests` 不加 xAI；OpenAI Responses 2× 保持 `provider === "openai"`。
8–10. 回归 / 测试 / 旧 session 缺 key：见 §4–§7。

## 4. 详细设计

推荐方案 A 的文件级设计。所有函数名、键名均为现有或本设计明确新增的标识符。

### 4.1 模块与数据流

```text
/fast on|off|status  或  RPC set_fast_mode
        │
        ▼
ModelControls.setFastMode / isFastModeEnabled / isFastModeActive
        │  family = serviceTierFamily(model)   // 现所有者，扩展返回 "xai"
        │  enable  → setServiceTierFamily("xai", "priority")
        │  disable → 仅当当前值为 priority 时清掉
        ▼
ServiceTierByFamily  (openai / anthropic / google / xai)
        │  persist: session-manager.appendServiceTierChange
        │  settings: tier.xai + buildServiceTierByFamily(...)
        ▼
effectiveServiceTier = resolveModelServiceTier(map, model)
        │
        ▼
stream options.serviceTier
        │  auth-gateway.buildStreamOptions 已转发 inbound serviceTier（不改）
        ▼
applyOpenAIServiceTier(params, serviceTier, model)
        │  先 shouldSendServiceTier，再只写 flex|scale|priority
        │  xai family 的 shouldSend 仅对 priority 为 true
        ▼
wire: { "service_tier": "priority" }   // Chat Completions / Responses
        │
        ▼
xAI 响应回显 service_tier: "priority" | "default"
        │  计费以回显为准（官方）
        │  omp fastModeActive 不以单次回显翻转（与 OpenAI 一致）
```

不新增第二套 toggle、不新增 `providers.xaiTier`、不在 Anthropic `speed` 路径上发 Grok 字段。

### 4.2 类型与核心函数（`packages/ai/src/types.ts`）

**改 `ServiceTierFamily`：**

```ts
export type ServiceTierFamily = "openai" | "anthropic" | "google" | "xai";
```

`ServiceTier` 五档字面量不变。xAI 不使用 `auto|flex|scale`；它们可以出现在 openai 槽，不能作为合法 `tier.xai` 设置值。[拟议但已确定]

**新增（同文件，紧挨 `isOpenAIServiceTierModel`）：**

```ts
function isGrokPriorityEligibleId(id: string): boolean {
  if (!isGrokModelId(id)) return false;
  // 对齐 catalog XAI_NON_CHAT_PREFIXES：grok-imagine- / grok-stt- / grok-voice-
  // packages/catalog/src/provider-models/openai-compat.ts:1180
  return !/(^|[/.])grok[-.](imagine|stt|voice)\b/i.test(id);
}

function isXaiServiceTierModel(model: ServiceTierModel): boolean {
  if (excludesInferredOpenAIServiceTier(model.provider)) return false;
  if (!isOpenAIServiceTierApi(model.api)) return false;
  if (!isGrokPriorityEligibleId(model.id)) return false;
  if (model.provider === "xai" || model.provider === "xai-oauth") return true;
  if (model.provider === "gateway") return true;
  if (model.baseUrl && hostMatchesUrl(model.baseUrl, "xai")) return true;
  return false;
}
```

`isGrokModelId` 已为 `/(^|[/.])grok[-.]/i`，覆盖 `grok-*` 与 `x-ai/grok-*`。[历史事实] media 排除与 catalog `XAI_NON_CHAT_PREFIXES` 对齐（`grok-imagine-`、`grok-stt-`、`grok-voice-`），避免 image / STT / voice 被当成 Fast-capable。bundled `models.json` 无这些 id；动态 `/v1/models` 会返回并由 picker 过滤。[历史事实]+[拟议但已确定]

`ServiceTierModel` 今日为 `Pick<Model, "provider" | "api" | "id">`。[历史事实] 为识别「自定义中继但 baseUrl 含 `api.x.ai`」，把该类型扩成 `Pick<Model, "provider" | "api" | "id"> & { baseUrl?: string }`。同一可选 `baseUrl` 必须落到这些独立 Pick，不能只改 `ServiceTierModel`：`resolveModelServiceTier`、`realizesPriorityServiceTier`（`packages/ai/src/types.ts:206-208,251-253`）、`applyOpenAIServiceTier`（`packages/ai/src/providers/openai-shared.ts:329`）。现有只传三字段的测试夹具继续合法（无 baseUrl ⇒ 不靠 URL 命中）。`hostMatchesUrl` / `KNOWN_HOSTS.xai.urlMarkers: ["api.x.ai"]` 已存在，不新造 host 词表。[历史事实]

**`ExtensionServiceTier`**（`packages/coding-agent/src/extensibility/extensions/types.ts:1079-1083`）：今日仅 anthropic → `"priority"`、google → `"flex" | "priority"`，其余落到完整 `ServiceTier`。[历史事实] 增加 `Family extends "xai" ? "priority"`，与 Anthropic 特化同构，避免扩展 API 在类型上允许 `flex`/`scale`。运行时仍由 `isServiceTierForFamily` 拒绝非法档。

**改 `serviceTierFamily` 顺序（在现有顺序上插入，不重排无关分支）：**

1. `provider === "openrouter"`：在现有 `anthropic/` / `google/` / `openai/` 之后增加：`id` 小写以 `x-ai/` 开头 **且** `isGrokPriorityEligibleId(id)` → `"xai"`；否则仍 `undefined`（含 `z-ai/glm-*` 等）。[拟议但已确定]
2. `openai` / `openai-codex` → `"openai"`（不变）
3. `api === "anthropic-messages"` → `"anthropic"`（不变；Bedrock/Vertex Claude 仍是 anthropic family 但不 realize）
4. `google` / `google-vertex` → `"google"`（不变）
5. **新：** `isXaiServiceTierModel(model)` → `"xai"`
6. `isOpenAIServiceTierModel(model)` → `"openai"`（不变；`custom-relay` + `gpt-5.5` 仍 openai）
7. `undefined`

把 xai 检查放在 `isOpenAIServiceTierModel` 之前是安全的：`isOpenAIModelId` 本就不匹配 grok，两谓词不会双命中。[历史事实]+[推导]

`gateway` 不是 bundled generated provider 名；测试里 `provider: "gateway"` 出现过 openai-completions / openai-codex-responses / anthropic-messages。[历史事实] 本设计只在 **Grok id + OpenAI-compat API** 时把 gateway 收进 xai family。`gateway/gpt-*` 继续走 openai family。`gateway` + Grok + `anthropic-messages` 走步骤 3，family=anthropic、realize=false（与 Vertex Claude 相同），**不**谎称 xAI Priority。[拟议但已确定]

`gateway/grok-4.6` 的运行时 `api` 未在本会话 dump。[未验证假设 A] 设计约束：仅当 `api` ∈ `{openai-completions, openai-responses, openai-codex-responses}` 时 capable。三者都已经调用 `applyOpenAIServiceTier`。[历史事实] 若运行时 api 不在此集合，family 为 undefined，`/fast on` 仍不可用——fail-closed，而不是猜一种发报通道。

**改 `shouldSendServiceTier`：** xai 判定必须插在 generic `provider === "openrouter"` 分支 **之前**。Coordinator 已选定这一条，不保留「跟在 OR 之后 / 继承 OR 的 flex|scale|priority 矩阵」两套话。[拟议但已确定]

顺序（其余现有分支不重排）：

1. `if (!serviceTier) return false`（不变）
2. **新（先于 openrouter 通用分支）：** `typeof target !== "string" && target && serviceTierFamily(target) === "xai"` → `return serviceTier === "priority"`。OpenRouter Grok **模型对象**走这条：只发 `priority`；即使 coerce 对象路径读到 `xai: "flex"` / `"scale"` 也不发。
3. **新：** 字符串 provider `"xai"` 或 `"xai-oauth"` → `return serviceTier === "priority"`。
4. 现有：`provider === "openai" || provider === "openai-codex" || provider === "openrouter"` → `flex|scale|priority`。字符串 `"openrouter"` **没有** model 对象时无法分类 family，**保持今日行为**（`shouldSendServiceTier("flex"|"scale"|"priority", "openrouter") === true`）。[历史事实]
5. 现有：`isOpenAIServiceTierModel` / google / google-vertex / fireworks；最终 `return false`。

不要让 xai family 的模型对象落到 openai/openrouter 的 `flex|scale|priority` 矩阵。OpenRouter Grok 一旦 map.xai=`priority`，`resolveModelServiceTier` 给出 `priority`，步骤 2 对模型对象返回 true，字段仍发到 OpenRouter。这是「尽力把 `priority` 放到下一跳」；是否兑现见 realize。字符串 `"openrouter"` 路径不能承担 family 分类。[拟议但已确定]

`applyOpenAIServiceTier` **不改算法**：先 `shouldSendServiceTier`，再仅当 `flex|scale|priority` 写入 `params.service_tier`。[历史事实] xai 只会走到 `priority` 写入。**不**为了 xAI 的 `"default"` 去写 `params.service_tier = "default"`：官方写明省略字段 ≡ default。[历史事实]

调用点保持：

- Chat Completions：`packages/ai/src/providers/openai-completions.ts` ~1610
- Responses：`applyCommonResponsesSamplingParams` → `openai-shared.ts` ~3170
- Codex Responses：`openai-codex-responses.ts` ~1494

**改 `realizesPriorityServiceTier`：** 现逻辑为：非 priority → false；direct anthropic → true；openrouter → 仅 openai/google family；`anthropic-messages` 非 anthropic provider → false；其余委托 `shouldSendServiceTier`。[历史事实]

本设计 **不** 把 openrouter 的 realize 白名单扩成 `xai`。[拟议但已确定] 因此：

| 模型 | family | shouldSend(priority) | realizes | enabled 可真 | active |
|---|---|---|---|---|---|
| `xai/grok-4.5` completions | xai | true | true（委托 shouldSend） | 是 | true |
| `xai-oauth/grok-4.5` responses | xai | true | true | 是 | true |
| `gateway/grok-4.6` + OpenAI-compat | xai | true | true | 是 | true |
| 自定义中继 + grok + baseUrl 含 `api.x.ai` | xai | true | true | 是 | true |
| `openrouter/x-ai/grok-4.5`（模型对象） | xai | true（**xai family 分支，仅 priority**；先于 openrouter 通用分支） | **false**（openrouter realize 白名单未含 xai） | 是 | **false** |
| 字符串 `"openrouter"`（无 model 对象） | 无法分类 | true（`flex\|scale\|priority`，今日行为） | n/a（realize 要 model） | n/a | n/a |
| 字符串 `"xai"` / `"xai-oauth"` | n/a | 仅 `priority` | n/a（realize 要 model） | n/a | n/a |
| `aimlapi/x-ai/grok-*`、`kilo`、`opencode-*` 且 URL 不含 `api.x.ai` | undefined | false（无 resolved tier） | false | 否 | false |
| Fireworks Grok（若存在） | undefined | fireworks 只认 fireworksTier | fireworks 现逻辑 | 否 | 仅 fireworks 旋钮 |
| `github-copilot` + grok | undefined（excludes） | false | false | 否 | false |

这同时满足决策面 5：OpenRouter Grok **模型对象**不会「toggle 失败却已发字段」（有 family 才会 resolve 出 priority；xai 分支对 `priority` 发字段），也不会「active=true 却未证实 OR 转发」，也不会把 coerce 读入的 `xai:"flex"|"scale"` 透传到 OR。[未验证假设 C] 字符串 `"openrouter"` 无法分类 family，不承担这条合同。

**`getPriorityPremiumRequests`：** 不改白名单（仍只 `openai` / `openai-codex` / `anthropic` / `google` / `google-vertex`）。xAI priority 即使 realize 也计 0。该函数注释写明是 Copilot-premium 聚合，OpenRouter / Fireworks 已排除。[历史事实] 用户未要求把 xAI 2× 映射进该计数。[拟议但已确定]

**`coerceServiceTierByFamily`：** 对象路径扫描从 `["openai","anthropic","google"]` 扩为含 `"xai"`。合法值仍是五档 `ServiceTier`；settings 层会把 `tier.xai` 限制为 `none|priority`，但 coerce 对 map 里意外的 `xai: "flex"` 仍会读入——发报时 **xai family 模型对象**的 `shouldSend` 为 false（含 OpenRouter Grok），等于忽略。字符串 `"openrouter"` 无 family 分类，不走这条挡板。标量遗留路径 **不** 把 `"priority"` 扩成含 `xai: "priority"`（见 §4.6）。

### 4.3 分类规则（决策面 1–2、5 的规范表）

判定「xAI-capable Grok 文本模型」= `serviceTierFamily(model) === "xai"` 且 `realizesPriorityServiceTier("priority", model) === true`。

| 路径 | 识别 | family | send priority | realize | 备注 |
|---|---|---|---|---|---|
| bundled `xai` | `provider==="xai"`，catalog `api: openai-completions`，`baseUrl: https://api.x.ai/v1` | xai | 是 | 是 | 含 grok-4 / 4.3 / 4.5 等；id 用谓词而非写死 SKU |
| bundled `xai-oauth` | `provider==="xai-oauth"`，`api: openai-responses`，同一 host | xai | 是 | 是 | SuperGrok OAuth 与 API key 提供方分开，family 相同 |
| `gateway` + Grok id | `provider==="gateway"` 且 OpenAI-compat API 且 `isGrokPriorityEligibleId` | xai | 是 | 是 | 用户主路径；auth-gateway 已转发 `serviceTier` |
| OpenRouter `x-ai/grok-*` | openrouter 前缀分支 | xai | 是（xai family 分支，仅 priority） | **否** | 字段会进 OR 请求；不把 active 打真，直到有证据证明 OR 转发。`flex`/`scale` 对 OR Grok **模型对象**不发 |
| 自定义 OpenAI-compat + `api.x.ai` | 可选 `baseUrl` + `hostMatchesUrl(..., "xai")` + Grok 文本 id | xai | 是 | 是 | 复用 `hosts.ts`，不解析 hostname（与现 marker 语义一致） |
| `aimlapi` / `kilo` / `opencode-go` / `opencode-zen` 等 | Grok id 但非上述 capable 条件 | undefined | 否 | 否 | [未验证假设 D] fail-closed |
| `grok-imagine-*` / `grok-stt-*` / `grok-voice-*` | media 排除，对齐 `XAI_NON_CHAT_PREFIXES` | undefined | 否 | 否 | 官方 Priority 仅文本 Chat Completions / Responses |
| `grok-4-fast` 文本 SKU | 仍是 Grok 文本 id | 按宿主走上一行 | 同宿主 | 同宿主 | SKU 名 `fast` ≠ session Fast mode |

`KNOWN_HOSTS.xai.providers` 今日只有 `["xai"]`，不含 `xai-oauth`。[历史事实] 因此 `xai-oauth` 必须靠 provider 字符串命中，不能只靠 `modelMatchesHost(..., "xai")`。本设计用显式 `provider === "xai" \|\| provider === "xai-oauth"`，不把 `xai-oauth` 塞进 hosts 词表（hosts 的 provider 列表还有别的 wire 用途，超出 Fast mode）。URL marker `api.x.ai` 仍覆盖 xai-oauth 的 baseUrl，供自定义中继使用。

### 4.4 设置合同（`packages/coding-agent/src/config/service-tier.ts` 等）

**新增：**

```ts
export const SERVICE_TIER_XAI_VALUES = ["none", "priority"] as const;
```

与 Anthropic 同构。`isServiceTierFamily` 增加 `"xai"`。`isServiceTierForFamily` switch 增加 `case "xai": values = SERVICE_TIER_XAI_VALUES`。`ExtensionServiceTier` 的 xai 特化见 §4.2。

**`buildServiceTierByFamily`：** 今日三必选参数只装 openai/anthropic/google，无 default。[历史事实] 改为 **四个必选** 位置参数（**不要** `xai: string = "none"`。有 default 时三参调用继续编译，live map 的 xai 会静默成 none，正是要防的洞）：

```ts
export function buildServiceTierByFamily(
  openai: string,
  anthropic: string,
  google: string,
  xai: string,
): ServiceTierByFamily
```

漏改的调用方在编译期失败。实现必须改完清单上每一个调用方，不能靠 default 当安全带。已知调用方：

- `packages/coding-agent/src/sdk.ts` ~3385–3388（session 初始 map）
- `packages/coding-agent/src/session/agent-session.ts` ~8001–8004（无 `service_tier_change` 时回落到 settings）
- `packages/coding-agent/src/cli/bench-cli.ts` ~810–813
- `packages/coding-agent/src/task/executor.ts` ~866–869（`createSubagentSettings` 的 inherit-path：`inheritedServiceTier === undefined` 时用 settings 组装父 map）

全部改为传入 `settings.get("tier.xai")`（bench 用 `runtime.settings?.get("tier.xai") ?? "none"`，与现有三家 `?? "none"` 同形）。`createSubagentSettings` 的 inherit-path **必须**把第四参 `tier.xai` 传进 `buildServiceTierByFamily`，否则 `tier.subagent=inherit` 且无 live session map 时第四家进不了 inheritedTiers。

**`createSubagentSettings` stamp（阻塞合同，不是实现细节）：** 今日在 `resolveSubagentServiceTier` 之后只回写三键，并用 `?? "none"` 清掉未广播的 family，避免父 settings 泄漏（`packages/coding-agent/src/task/executor.ts:851-875`）。[历史事实] 第四家必须同样 stamp：

```ts
snapshot["tier.openai"] = subagentTiers.openai ?? "none";
snapshot["tier.anthropic"] = subagentTiers.anthropic ?? "none";
snapshot["tier.google"] = subagentTiers.google ?? "none";
snapshot["tier.xai"] = subagentTiers.xai ?? "none";
```

漏 stamp 的后果：`tier.subagent=priority` 时 Grok 子 agent 仍读全局 `tier.xai`（多为 none），广播失效；`tier.subagent=flex` 会把父级 `tier.xai=priority` 漏进子 agent。不要依赖第四参 default 去「顺便修好」。

**`serviceTierForAllFamilies`：** `priority` 时额外 `out.xai = "priority"`。`flex` 不写 xai。OpenAI 任意档、Anthropic 仅 priority、Google 仅 flex/priority 的现语义不变。这样 `tier.subagent` / `tier.advisor` / `omp bench --service-tier priority` 在子 agent 模型属于 xai family 时能吃到 priority——**前提是 stamp 把 `tier.xai` 写回 snapshot**。

**`settings-schema.ts`：** 在 `tier.google` 与 `tier.subagent` 之间插入 `tier.xai`：

- type enum，`values: SERVICE_TIER_XAI_VALUES`，default `"none"`
- UI tab `model` / group `Sampling` / label `Service Tier — xAI`
- description：Processing tier for Grok on xAI-capable hosts (`xai`, `xai-oauth`, gateway Grok, and `api.x.ai` OpenAI-compat relays). `priority` sends `service_tier: "priority"` (xAI Priority Processing). Ignored on OpenRouter for `fastModeActive` until forwarding is verified; omitted on other Grok proxies.

**UI options：** `SERVICE_TIER_XAI_OPTIONS`：None = omit（标准调度）；Priority = xAI Priority Processing（premium token rate，以响应回显为准）。

**`docs/settings.md`：** 在 `tier.google` 行后增加 `tier.xai` 行，与 schema 描述一致。

**`docs/tools/task.md`：** 今日 spawn 步骤写 `tier.openai`/`tier.anthropic`/`tier.google` 经 `tier.subagent` 再解析（约第 95 行）。[历史事实] 改为四家 stamp：`tier.openai`/`tier.anthropic`/`tier.google`/`tier.xai` 都经 `tier.subagent` 再解析并写回 snapshot（缺省 `"none"`）。

**`docs/session-switching-and-recent-listing.md`：** 今日 resume 写 service tier 回落到 `tier.openai`/`tier.anthropic`/`tier.google`（约第 182 行）。[历史事实] 无 persisted `service_tier_change` 时改为四键 settings（含 `tier.xai`；`"none"` 仍 unset）。

**不改 RPC 协议。** `set_fast_mode` / `get_state` 字段集合不变；只是 Grok capable 模型上 `enabled/active` 从「永远不可用」变成与三家对齐。`docs/rpc.md` 在 `set_fast_mode` 节补一句：xAI-capable Grok 文本模型走 family `xai`，enable 失败仍用同一精确 error 字符串；OpenRouter Grok 成功 enable 时可能 `enabled: true, active: false`。

**`/fast` 文案：** `packages/coding-agent/src/slash-commands/builtin-registry.ts` description 从

`Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)`

改为同时点名 xAI：

`Toggle priority service tier (OpenAI/xAI service_tier=priority, Anthropic speed=fast)`

`formatFastModeStatus` 仍只看 `isFastModeEnabled()`（on/off），不看 active。与今日一致。[历史事实]

### 4.5 Wire 合同（决策面 4）

xAI 接受值文档为 `"default"` 与 `"priority"`；省略 ≡ default。[历史事实] omp `applyOpenAIServiceTier` 从不写 `default`/`auto`。[历史事实]

[拟议但已确定]

- Fast mode on：发且只发 `service_tier: "priority"`。
- Fast mode off / `tier.xai=none`：省略字段，不发 `"default"`。少一个与 OpenAI 发报函数分叉的分支，且与官方「省略=default」等价。
- `flex` / `scale`：凡 `serviceTierFamily(target) === "xai"` 的 **模型对象**（含 OpenRouter Grok），`shouldSend` 为 false；忽略，不拒绝整个请求，不透传。避免对未文档化取值赌 400。[未验证假设 E] 这与 §4.2 同一条：xai family 检查先于 generic openrouter 分支。字符串 `"openrouter"` 无 model 对象时仍可对 `flex|scale|priority` 为 true（无法分类 family），不与上条矛盾。
- 不在 xAI 路径上暴露独立的 `default` 设置档。用户要标准调度就 `none` / `/fast off`。

Image/video/STT/voice/Batch：本设计不在那些 API 上调用 `applyOpenAIServiceTier` 的新入口；media id 已按 `XAI_NON_CHAT_PREFIXES` 从 family 排除。若错误模型被分类，仍只有 OpenAI-compat 文本路径会写字段。

### 4.6 持久化与迁移（决策面 3、10）

**Settings 遗留标量：** `settings.ts` ~1751–1756 把 `serviceTier: "priority"` 迁到 openai+anthropic+google，**不**增加 `setTier("xai", "priority")`。[拟议但已确定] 理由：那次迁移的语义是「当时存在的三家」；retroactive 填第四家会让从未用过 Grok、也未同意 xAI 2× 费率的配置突然在第一次切到 Grok 时发 priority。`service-tier-migration.test.ts` 现断言三家；保持断言，并 **新增** 一条：`tier.xai` 在遗留 `priority` 迁移后仍为 `"none"`。

**`coerceServiceTierByFamily` 标量 `"priority"`：** 今日返回 `{openai,anthropic,google: priority}`。[历史事实] **不**加 xai。对象路径则接受已持久化的 `xai` key，便于新 session 往返。

**Session `service_tier_change`：** 已持久化整个 map。[历史事实] 旧条目缺 `xai` key 时，`resolveModelServiceTier` 对 Grok 得到 `undefined` → Fast 关。`agent-session.ts` 在 `hasServiceTierEntry` 时用 persisted map，否则用 `buildServiceTierByFamily`（含新的 `tier.xai`）。[历史事实] 因此：

- 有旧 map、无 xai key、settings `tier.xai=priority`：**不以 settings 补第四家**（现逻辑就是 persisted 全量覆盖）。用户需在该 session `/fast on` 一次。这是成功标准 6。[拟议但已确定]
- 无 map 的新 session：读四键 settings。
- `/fast on` 之后 map 含 `xai: "priority"`，后续往返正常。

不写数据迁移脚本去改写历史 JSONL。Rollback = 去掉 family 扩展后，coerce 会丢掉未知 key `xai`（对象扫描不再认识它），旧三家不受损。

### 4.7 失败与降级（决策面 6）

对照 Anthropic（**只对照，不复制**）：Anthropic 在 `speed: "fast"` 被拒（400 `speed` / 429 extra usage）时 in-turn 去掉 speed+beta 重试，把 `providerSessionState.fastModeDisabled=true`，assistant `disabledFeatures` 含 `priority` 时 session 清掉 anthropic family。[历史事实]

xAI 官方：请求被接受；响应回显实际档位；仅回显 `"priority"` 时按 priority 计费；无容量时可以是 `"default"`。[历史事实] 这与 OpenAI「可能降级、回显权威、成本乘数看回显」同类，而 `isFastModeActive` 对 OpenAI **也不**看上一轮回显。[历史事实]+[推导]

[拟议但已确定]

1. **不**为 xAI 做 in-provider sticky retry，**不**发明 `disabledFeatures: ["priority"]` 的 Grok 分支，**不**在 `agent-session.ts` ~2518 的 anthropic 清 family 逻辑里顺手清 xai。
2. `isFastModeActive` 对 xai family：`realizesPriorityServiceTier(...)` 即为 active。无 Anthropic 那种 fallback 二次检查。
3. 若 OpenAI-compat 响应里已经能读到 `service_tier` 回显（Responses 路径今日把它传进 `applyOpenAIResponsesServiceTierCost`，但该函数 `provider !== "openai"` 直接 return），**不要**用回显去关 Fast mode。允许后续在日志里记录回显；本设计不把「单轮 default 回显」做成产品状态机。
4. 若 xAI 对未知值 `flex/scale` 返回 400：[未验证假设 E/F] 本设计根本不发送这些值，故不依赖该行为。
5. 未知代理 fail-closed（无 family），避免 400 未知字段打爆会话。
6. OpenRouter 转发未验证：send 但不 realize，用户看到 enabled 与 active 分叉——与「direct Anthropic sticky 期间 enabled=true, active=false」以及「OpenRouter Anthropic 永不 realize」同一 RPC 形状。[历史事实]

Fail-open 仅一处：`gateway` + Grok + OpenAI-compat 的 realize=true（§3.1 风险）。这是对用户主路径的产品选择，不是全局 fail-open。

### 4.8 计费统计（决策面 7）

- `getPriorityPremiumRequests`：xAI 计 0。不要把 xAI 2× 假装成 Copilot premium request。
- `applyOpenAIResponsesServiceTierCost`：保持 `model.provider !== "openai" return`。[历史事实] 即使 xai-oauth 走 Responses 且回显 `priority`，也不套 OpenAI 2× 表。xAI 账单在 xAI 侧按回显收取；omp 本地 catalog 单价若未含乘数，session cost **可能低估**。本设计把「为 xAI 做回显乘数」列为非目标，避免在未核对 catalog 单价语义时双重计算或算错。[拟议但已确定]
- OpenRouter 若转发并加价，继续走 `applyOpenRouterReportedCost`（已有、按 OR 回报），与 family 无关。

### 4.9 `ModelControls` / RPC / slash command

`packages/coding-agent/src/session/model-controls.ts`：

- `isFastModeEnabled` / `setFastMode` / `toggleFastMode` / `effectiveServiceTier` **算法不改**。family 一旦能返回 `"xai"`，toggle 自动打到第四槽。
- `setFastMode(true)` 里 Anthropic 清 sticky 的分支保持 `family === "anthropic"` 专用；xai 不进入。
- Fireworks 仍走 `providers.fireworksTier`，在 `effectiveServiceTier` 最前，不进 family。[历史事实] 回归点。

RPC `rpc-mode.ts` ~1106–1114：不改。enable 且 `setFastMode` false → 精确 error。disable 无 family 仍 success。Fireworks 用例 `{enabled:false, active:true}` 保持。

### 4.10 文档与测试（决策面 8–9）

见 §7。实现阶段改这些文件，本阶段不动产品代码。

## 5. 关键决策

| 决策 | 选项 | 选择 | 理由 | 回滚 |
|---|---|---|---|---|
| Family 落点 | 独立 xai / 并入 openai / 无 family 只发报 | **独立 `xai`** | 保持 per-family 隔离；档位可收成 none\|priority；`/fast` 自动工作 | 去掉第四 union 成员与 `tier.xai`；coerce 丢弃未知 key |
| Family 名 | `xai` vs `grok` | **`xai`** | 与 `hosts.ts`、`tier.openai` 的 vendor 命名、provider `xai`/`xai-oauth` 一致；grok 是 SKU 族 | 无（未实现前可改名；实现后改名等于新 family） |
| OpenRouter `x-ai/grok-*` | 无 family / family+realize / family+send 不 realize | **family + send，realize=false** | OR 已对 priority 发 `service_tier`；转发未验证，不能把 active 打真 | 证实转发后只把 openrouter realize 白名单加上 xai |
| shouldSend 分支顺序 | xai family 对象先于 OR 通用 / 跟在 OR 之后并继承 flex\|scale\|priority | **模型对象且 `serviceTierFamily === "xai"` 时先于 openrouter 通用分支，仅 `priority`**；字符串 `"openrouter"` 保持 `flex\|scale\|priority`；字符串 `"xai"` / `"xai-oauth"` 仅 `priority` | 挡住 coerce 读入的 `xai:flex/scale` 打到 OR Grok；无 model 对象无法分类 family | 若证实 OR 接受 flex，再开缺口 |
| gateway + Grok | 无 family / family 不 realize / family+realize | **family+realize**（须 OpenAI-compat API） | 用户主路径；auth-gateway 已转发 serviceTier | 若剥字段，把 gateway 从 `isXaiServiceTierModel` 拿掉或 realize=false |
| 其他代理 | fail-open 发报 / fail-closed | **fail-closed**（除非 baseUrl 命中 `api.x.ai`） | [未验证假设 D] 避免 400 与谎称 active | 对已证实的代理把 provider 加入 `isXaiServiceTierModel` |
| `tier.xai` | 新键 / 复用 openai | **新键 `none\|priority`** | 与 Anthropic 同构；挡住 flex/scale | 删除 schema 键；迁移层忽略 |
| 遗留 `serviceTier: "priority"` | retroactive 填 xai / 不填 | **不填** | 避免无同意的 2×；迁移测试保持三家 | 若产品要「全局 priority 含 Grok」，再加一次性迁移并改测试 |
| 旧 session 缺 `xai` key | settings 补齐 / 保持关 | **保持关** | 尊重 persisted map 全量覆盖的现逻辑 | 用户 `/fast on` |
| Wire `default` | 显式发 / 省略 | **省略** | 官方省略≡default；`applyOpenAIServiceTier` 本就不写 default | 若 xAI 日后要求显式 default，再在 shouldSend 开缺口 |
| Wire `flex/scale` | 忽略 / 拒绝请求 / 透传 | **忽略** | 未出现在 xAI 该页；透传赌 400；拒绝会误伤广播 flex 的子 agent | 证实接受后再纳入 values |
| 失败降级 | Anthropic sticky / 只信回显关 Fast / request-side active | **request-side active，不 sticky** | xAI 失败模式是降级计费不是拒请求；与 OpenAI Fast 一致 | 若出现稳定 400，再考虑一次性去掉字段的 in-turn retry（仍不必清 family） |
| `getPriorityPremiumRequests` | 计 1 / 计 0 | **0** | Copilot-premium 语义；xAI 不是那五家 billing provider | 产品若要「priority 次数」另做 xAI 计数，不混进该函数 |
| OpenAI Responses 2× | 扩到 xai / 不扩 | **不扩** | 函数已故意限定 `provider==="openai"`，防止代理回显污染成本 | 需要时写 `applyXaiResponsesServiceTierCost`，不要打开 openai 闸门 |
| Fireworks / Copilot / Bedrock Vertex Claude / OR Anthropic | 顺带整理 / 冻结 | **冻结现行为** | 分类顺序把 xai 插在 openai-inferred 之前、openrouter 前缀之内，不碰这些分支 | 回归测试锁死 |

## 6. 风险与缓解

| 风险 | 证据标签 | 缓解 |
|---|---|---|
| `gateway/grok-4.6` 的 api 不是 OpenAI-compat，family 仍 undefined，用户主路径 `/fast` 依旧不可用 | [未验证假设 A] | 实现后用真实 Model 对象测一次；若 api 不在三集合，先补分类或记录为环境限制，而不是改 Anthropic/Google 通道发 xAI 字段 |
| 用户 gateway 上游剥离 `service_tier`，active=true 但未加急 | [未验证假设 B] | 金路径验收走 bundled `xai`/`xai-oauth` + `api.x.ai`；gateway 作为「应转发」路径。剥字段时收紧 realize，不改 family 模型 |
| OpenRouter 不转发，用户觉得「开了 Fast 没变快」 | [未验证假设 C] | `active=false` 是诚实信号；RPC/文档写明。证实后只改 realize 白名单 |
| aimlapi 等若其实支持字段，fail-closed 显得功能缺失 | [未验证假设 D] | 按 provider 白名单扩 `isXaiServiceTierModel`，不默认发 |
| 误发 `flex/scale` 导致 400 | [未验证假设 E/F] | settings 与 shouldSend 双层挡住 |
| 并非所有 Grok SKU / 账号都有 Priority entitlement | [未验证假设 G] | 官方页未按 SKU 拆权；omp 不在 toggle 前做 entitlement 探测。xAI 会回显 default 并按标准价计费，不需要 sticky 关 Fast |
| 第四家漏改 `buildServiceTierByFamily` 调用方，settings `tier.xai` 写了但不进 live map | [推导] | 四个必选参数、无 default；漏改调用方编译失败。调用方清单见 §4.4 |
| `createSubagentSettings` 漏 stamp `tier.xai`，子 agent 吃不到广播或漏进父级 `tier.xai` | [历史事实]+[推导] | stamp `snapshot["tier.xai"] = subagentTiers.xai ?? "none"`；inherit-path 把 `tier.xai` 传入 `buildServiceTierByFamily`；§7.2 锁死 priority/flex 两例 |
| `ServiceTierModel` 无 baseUrl，自定义 `api.x.ai` 中继识别不到 | [历史事实] | 可选 baseUrl；无则仍可靠 provider `xai`/`xai-oauth`/`gateway` |
| 本地 usage.cost 不含 xAI 2×，用户低估花费 | [历史事实]+[拟议但已确定] | 文档声明；不在本次用错误乘数「修正」 |
| 回归破坏 Fireworks `/fast` 不可用但 `active` 可真 | [历史事实] | 现成 `rpc.test.ts` 用例必须继续绿 |

## 7. 验证计划

本阶段不跑产品测试。实现阶段的最小充分验证如下。[拟议验收目标]

### 7.1 单测 — `packages/ai/test/service-tier-premium-requests.test.ts`

在现有夹具旁增加（名称可调整，语义不可少）：

```ts
const xai = m("xai", "openai-completions", "grok-4.5");
const xaiOauth = m("xai-oauth", "openai-responses", "grok-4.5");
const gatewayGrok = m("gateway", "openai-completions", "grok-4.6");
const orGrokCompletions = m("openrouter", "openai-completions", "x-ai/grok-4.5");
const orGrok = m("openrouter", "openrouter", "x-ai/grok-4.5"); // catalog-faithful
const aimlGrok = m("aimlapi", "openai-completions", "x-ai/grok-4-3");
const grokImagine = m("xai", "openai-completions", "grok-imagine-image");
const grokStt = m("xai", "openai-completions", "grok-stt-example");
const grokVoice = m("xai", "openai-completions", "grok-voice-example");
```

断言：

- `serviceTierFamily`：xai / xaiOauth / gatewayGrok = `"xai"`；orGrok 与 orGrokCompletions = `"xai"`；aimlGrok = `undefined`；grokImagine / grokStt / grokVoice = `undefined`；现有 openai/anthropic/google/fireworks/custom-relay gpt 不变；`openrouter` + `z-ai/glm-4.7` 仍 undefined。
- `shouldSendServiceTier("priority", xai|xaiOauth|gatewayGrok)` true；`("flex"|"scale"|"default"|"auto", xai)` false。
- `shouldSendServiceTier("priority", orGrok)` 与 `("priority", orGrokCompletions)` 均为 true（xai family 分支，不是 openrouter 通用矩阵）。
- `shouldSendServiceTier("flex"|"scale", orGrok)` 与 `("flex"|"scale", orGrokCompletions)` 均为 false。
- `shouldSendServiceTier("flex"|"scale"|"priority", "openrouter")` 仍 true（字符串 provider，无 model 对象）。
- `shouldSendServiceTier("priority", "xai"|"xai-oauth")` true；`("flex"|"scale", "xai"|"xai-oauth")` false。
- `shouldSendServiceTier("priority", aimlGrok)` false。
- `realizesPriorityServiceTier("priority", xai|xaiOauth|gatewayGrok)` true；orGrok 与 orGrokCompletions 均为 false；aimlGrok false。
- `getPriorityPremiumRequests("priority", xai|xaiOauth|orGrok)` 0。
- `coerceServiceTierByFamily("priority")` 仍只有三家；`coerceServiceTierByFamily({xai:"priority"})` 保留 xai。
- 回归：Fireworks undefined family；github-copilot 排除；vertexClaude family=anthropic 但不 realize；orAnthropic 不 realize。

带 `baseUrl: "https://api.x.ai/v1"` 的自定义 provider + grok id：family=`xai`。无该 URL 的自定义 + grok：undefined。

### 7.2 设置 / 迁移

- `service-tier-migration.test.ts`：遗留 `serviceTier: "priority"` → openai/anthropic/google=priority，**xai=none**。
- schema：`tier.xai` 默认 none；非法 `flex` 不能作为该键值。
- `serviceTierForAllFamilies("priority")` 含 xai；`("flex")` 不含 xai。
- `createSubagentSettings`（该函数已 export；文件 `packages/coding-agent/test/task/create-subagent-settings.test.ts`）：
  - 父 settings `tier.xai=none`，`tier.subagent=priority` → snapshot `tier.xai=priority`。
  - 父 settings `tier.xai=priority`，`tier.subagent=flex` → snapshot `tier.xai=none`（即使父级为 priority，也不得泄漏）。
  - inherit-path：`tier.subagent=inherit`、`inheritedServiceTier === undefined`、父 `tier.xai=priority` → `buildServiceTierByFamily` 第四参为父 `tier.xai`，snapshot `tier.xai=priority`。

### 7.3 合同 / 集成（实现阶段，非本设计执行）

- `ModelControls.setFastMode(true)` 在 xai/gateway Grok 夹具上返回 true；aimlGrok 返回 false 且 notice 文案不变。
- RPC：Grok capable enable → `{enabled:true, active:true}`；OpenRouter Grok → `{enabled:true, active:false}`；Fireworks 旧用例不变。
- 对 mock Chat Completions / Responses：Fast on 时 body 含 `"service_tier":"priority"`；Fast off 时字段缺席（不是 `"default"`）。
- 不要求对真实 `api.x.ai` 做付费探测才能合入；合入门槛是 mock 发报 + 分类测试。金路径手工探测列为发布前建议，不是单元门槛。

### 7.4 文档

- `docs/settings.md`：`tier.xai` 行。
- `docs/rpc.md`：Grok / OpenRouter Grok 的 enabled vs active。
- `docs/tools/task.md`：四家 `tier.*` 经 `tier.subagent` stamp。
- `docs/session-switching-and-recent-listing.md`：无 persisted map 时回落含 `tier.xai`。
- `/fast` description 含 xAI。
- 不把「SKU 名 fast」写进 Fast mode 文档。

### 7.5 明确不测

- 不测 xAI 账号 entitlement、真实 TTFT。
- 不测 image/video/STT/voice/Batch 发 `service_tier`（id 已按 `XAI_NON_CHAT_PREFIXES` 排除）。
- 不测把 thinking effort 当 Fast。
- 不改、不扩 Anthropic sticky 测试去覆盖 Grok。
- 不测 OpenAI 2× 成本函数对 xai 的行为以外的「应该为 1×」：现有 `provider !== "openai" return` 已保证；加一条 xaiOauth 调用后 cost 不变即可。

## 8. Handoff

### 8.1 同会话继续

宿主原生路径：`按 subagent-delegation 触发只读 /subagent-grok（cursor-grok-4.6-xhigh；Round-1 即用户指定该 reviewer，下一轮 Gate 仍走同一路径）。`

本工作授权为 design-only。Round-1 Gate 为 `NEEDS_REVISION`；本修订关闭已采纳 findings 后必须重跑 Gate。会话用户后来说实现放在 review 之后，不改变文档义务：在新的权威实现授权出现前，且 Gate 尚未 `PASS` / `PASS_WITH_NOTES` 时，不得 `design-implement`。作者不得把 `implementation_authorization` 翻成 authorized。

### 8.2 新会话恢复 prompt

```text
请读取完整设计输入集合（docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md 与 docs/superpowers/specs/2026-08-20-grok-fast-mode-facts-brief.md；facts brief 是结构化设计输入，必须列入 Reviewed Inputs），生成按 normalized path 排序的 path + SHA-256 `Reviewed Inputs` manifest，并计算 `reviewed_revision`；pre-review handoff 不伪造 digest。设计元数据：design_author=grok；design_author_identity=GrokDesigner；implementation_authorization=design-only；authorization_source=用户 2026-08-20「grok 是支持 Fast mode。分析下如果添加并设计方案」；随后「可以直接交给 grok-4.6 subagent 作者起草」。Round-1 Gate artifact=docs/superpowers/plans/2026-08-20-grok-fast-mode-subagent-review.md，verdict=NEEDS_REVISION；本修订保留方案 A 并关闭该 artifact 中 coordinator 已采纳的 findings。
使用用户指定的只读 /subagent-grok（cursor-grok-4.6-xhigh；Round-1 实际 reviewer 即此路径，起草时 planned 为 sol-xhigh-reviewer）执行独立 Design Review；将完整 review artifact 持久化到 docs/superpowers/plans/2026-08-20-grok-fast-mode-subagent-review.md。按宿主记录 review_mode=host-native、author/reviewer native agent_id、model、verdict、授权来源与证据。
若文档包含根因分析，请一并核对根因判断、证据与设计方案是否一致。
评审结论必须为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一，并附可复查证据；禁止作者自审。
NEEDS_REVISION 时回到当前设计文档修订；NEEDS_REDESIGN 时回到 design-brainstorm 重做方案；正文变更后均须重新执行 Gate，且在通过前不得实现。
PASS/PASS_WITH_NOTES 后，current Inputs manifest 等于 reviewed manifest 或存在覆盖全部输入的有效 Gate Continuity Note，且 implementation_authorization=authorized，才继续 design-implement；design-only 必须停止。会话用户后来说实现放在 review 之后，该授权在 Gate PASS* 之前不得消费，作者不得自行翻成 authorized。
Review 后输入变化由未参与 author/reviewer/正文修改/implementation 的主协调者按 handoff 规则分类；非实质变化持久化覆盖完整 manifest 的 Gate Continuity Note，实质、不确定、遗漏输入或角色未分离时重跑 Gate。
```
