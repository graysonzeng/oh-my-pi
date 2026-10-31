# Facts Brief: Grok Fast Mode

- Date: 2026-08-20
- Status: Facts only（不含方案结论）
- Scope: M
- planned_design_author: grok-designer（`gateway/grok-4.6` @ xhigh）
- planned_reviewer: sol-xhigh-reviewer（`gateway/gpt-5.6-sol` @ xhigh，只读）
- implementation_authorization: design-only
- authorization_source: 用户 2026-08-20「grok 是支持 Fast mode。分析下如果添加并设计方案」；随后「可以直接交给 grok-4.6 subagent 作者起草」
- coordinator_model: gateway/grok-4.6（主协调者；不得担任 author / reviewer / 正文修改者 / implementer）

证据标签：[历史事实]=源码或官方文档直接观察；[推导]=由已确认事实推出；[未验证假设]=尚未验证。

本 brief 不含候选方案、取舍或推荐。作者必须自行提出至少 2 个方案并给出推荐。

## TaskStartSnapshot

记录于第一次 repo 写入前。

- repository root: `/Users/sheng/tencent/oh-my-pi`
- HEAD: `719732d40994d36d28f7797c0c9b8c897efd41a5`
- branch: `workflow`（非 detached）
- upstream: `origin/workflow`，ahead 0 / behind 0
- staged: 0；unstaged 5；untracked 10
- Git operations: 无 merge / rebase / cherry-pick / revert / bisect
- worktrees: 当前 `/Users/sheng/tencent/oh-my-pi`；另有两个 prunable detached worktree（`/private/tmp/omp-base`、`/private/tmp/omp-cur`），不属本任务
- 本任务预计拥有：`docs/superpowers/specs/2026-08-20-grok-fast-mode-facts-brief.md`、`docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md`；后续 review artifact 在 `docs/superpowers/plans/`
- 明确不属于本任务：写入前已存在的 unstaged / untracked 文件（含 `.omp/agents/sol-xhigh-reviewer.md`、`packages/coding-agent/src/session/agent-session.ts`、既有 shadow-mind / dsh 设计文档等）

## 规模与根因

- 规模：M。[推导] 无 L 信号（无权限/金钱/不可逆生产写）；需要协调可观察行为（`/fast`、RPC `set_fast_mode`、settings `tier.*`、session `service_tier_change`）与跨模块不变量（`packages/ai` 分类/发报 + `packages/coding-agent` 会话/设置）。
- 根因分析：跳过。这是已知功能缺口，不是未知故障。用户已声明 Grok 支持 Fast mode，要求设计如何接入。

## Aegis / Dev Flow 路由（coordinator 记录）

- Lifecycle owner: Dev Flow（`design-brainstorm` → 独立 Design Review Gate）。Aegis 仅 adapter / method pack，不创建平行 work record。
- ArchitectureReviewRequired: yes（contract / 跨模块 / family 旋钮）。
- 不新建 branch / worktree。

## 用户目标与约束（已确认）

1. 当前模型 `gateway/grok-4.6` 上 Fast mode 不可用；用户认为 Grok 支持 Fast mode，要求分析如何添加并设计方案。
2. 本阶段只设计，不实现（`design-only`）。
3. 设计正文由 `grok-designer`（`gateway/grok-4.6`）单一作者生成；主协调者不得提出或修改方案。
4. 评审预定 `sol-xhigh-reviewer`（与作者异模型）。

## 成功标准（用户可观察，非方案）

作者须把这些变成可验收条款，但不得改变其语义：

1. 在支持 xAI Priority Processing 的 Grok 模型上，`/fast on` 不再报 `Fast mode is unavailable for the current model.`
2. `/fast off`、`/fast status`、RPC `set_fast_mode`、`get_state.fastModeEnabled` / `fastModeActive` 与现有三家 family 的语义对齐。
3. 打开 Fast mode 后，下一请求在适用的 Chat Completions / Responses 路径上真正带上 xAI 文档规定的加急字段。
4. 非 Grok 模型、Fireworks 独立旋钮、Anthropic `speed: "fast"`、OpenAI/Google 现有 family 行为不回归。
5. 不支持加急的 Grok 代理路径不得谎称 Fast mode 已生效。

## 不在本设计范围（coordinator 边界，非方案）

- 不实现代码（本阶段）。
- 不把 Grok「名字带 fast 的模型 SKU」（如 `grok-4-fast`、Fireworks `-fast`）等同于 session Fast mode。
- 不把 thinking effort / `reasoning_effort` 当成 Fast mode。
- 不要求 catalog 新增 `grok-4.6` 条目才能设计（当前 bundled `xai` 最新到 `grok-4.5`；会话模型是 `gateway/grok-4.6`）。

## 已确认事实

### Fast mode 产品合同

1. `/fast` 描述为「Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)」。来源：`packages/coding-agent/src/slash-commands/builtin-registry.ts` 约 570–572 行。[历史事实]
2. `/fast on` 调 `setFastMode(true)`；返回 `false` 时输出精确字符串 `Fast mode is unavailable for the current model.` `/fast off` 在无 family 时仍输出 `Fast mode disabled.`（idempotent）。来源：同文件 589–597 行；RPC `packages/coding-agent/src/modes/rpc/rpc-mode.ts` 1106–1109 行；`docs/rpc.md` 322–351 行。[历史事实]
3. `setFastMode`：`serviceTierFamily(currentModel)` 为 `undefined` 则 emit notice「The current model has no service-tier control for /fast to toggle.」并返回 `false`；enable 时把该 family 设为 `priority`；disable 时仅当当前值为 `priority` 才清掉。来源：`packages/coding-agent/src/session/model-controls.ts` 719–743 行。[历史事实]
4. `isFastModeEnabled` = 当前模型 family 的 map 值为 `priority`。`isFastModeActive` = `realizesPriorityServiceTier(effectiveServiceTier(model), model)`，Anthropic 还要看 sticky fallback。Fireworks 不走 family：`effectiveServiceTier` 读 `providers.fireworksTier`，且 `-fast` 模型互斥。来源：同文件 648–691 行。[历史事实]
5. RPC disable 在 unsupported Fireworks + `providers.fireworksTier: priority` 上返回 `{ enabled: false, active: true }`。来源：`packages/coding-agent/test/rpc.test.ts` 345–357 行；`docs/rpc.md` 335–360 行。[历史事实]

### Family 分类与发报

6. `ServiceTierFamily = "openai" | "anthropic" | "google"`。来源：`packages/ai/src/types.ts` 144–145 行。[历史事实]
7. `serviceTierFamily` 顺序：
   - `provider === "openrouter"`：仅 `anthropic/`、`google/`、`openai/` 前缀；否则 `undefined`（含 `x-ai/grok-*`）。
   - `openai` / `openai-codex` → openai
   - `api === "anthropic-messages"` → anthropic
   - `google` / `google-vertex` → google
   - 否则 `isOpenAIServiceTierModel`：OpenAI-compat API **且** `isOpenAIModelId(id)` **且** provider 不是 `fireworks` / `github-copilot`
   - 否则 `undefined`
   来源：`packages/ai/src/types.ts` 157–199 行。[历史事实]
8. `isOpenAIModelId` 只匹配 `gpt|chatgpt|codex`、`o[134]`、或含 `openai/`。`grok-4.6` 不匹配。`isGrokModelId` 为 `/(^|[/.])grok[-.]/i`，覆盖 `grok-*` 与 `x-ai/grok-*`。来源：`packages/catalog/src/identity/family.ts` 91–94、143–149 行。[历史事实]
9. 因此下列模型 **今天** `serviceTierFamily === undefined`：`xai/grok-4.5`、`xai-oauth/grok-4.5`、`gateway/grok-4.6`、`openrouter/x-ai/grok-4.5`、`aimlapi/x-ai/grok-4-3`。`custom-relay` + `gpt-5.5` 仍是 openai family。来源：分类函数 + catalog id；测试夹具见 `packages/ai/test/service-tier-premium-requests.test.ts` 12–63 行。[历史事实]+[推导]
10. `shouldSendServiceTier`：openai / openai-codex / openrouter 以及 `isOpenAIServiceTierModel` 发 `flex|scale|priority`；google 发 `flex|priority`；google-vertex / fireworks 只发 `priority`；anthropic 返回 false（走 `speed: "fast"`）。`xai` / `xai-oauth` / `gateway` 字符串 provider 今天落在最终 `return false`。来源：`packages/ai/src/types.ts` 222–241 行。[历史事实]
11. `applyOpenAIServiceTier`：先 `shouldSendServiceTier`，再仅写入 `flex|scale|priority` 到 `params.service_tier`。Chat Completions 在 `openai-completions.ts` ~1610 行调用；Responses 经 `applyCommonResponsesSamplingParams`（`openai-shared.ts` 3170 行）；Codex Responses 在 `openai-codex-responses.ts` ~1494 行。来源：上述文件。[历史事实]
12. `realizesPriorityServiceTier`：`serviceTier === "priority"` 后，direct anthropic true；openrouter 仅 openai/google family；`anthropic-messages` 非 anthropic provider false；其余委托 `shouldSendServiceTier`。来源：`packages/ai/src/types.ts` 251–263 行。[历史事实]
13. `getPriorityPremiumRequests` 只对 `openai` / `openai-codex` / `anthropic` / `google` / `google-vertex` 计 1；OpenRouter 与 Fireworks 为 0。来源：同文件 277–289 行。[历史事实]
14. auth-gateway `buildStreamOptions` 会把 inbound `options.serviceTier` 转发到 `opts.serviceTier`。来源：`packages/ai/src/auth-gateway/server.ts` 160 行。[历史事实]
15. Anthropic Fast mode 有 in-provider 拒绝后 sticky fallback（`speed` + beta 去掉并重试），session 见 `disabledFeatures` 含 `priority` 会清掉 `anthropic` family。Grok / xAI 今天没有对等路径。来源：`packages/ai/src/providers/anthropic.ts`；`packages/coding-agent/src/session/agent-session.ts` 2518–2527 行。[历史事实]

### Settings / persistence / UI

16. 设置键只有 `tier.openai` / `tier.anthropic` / `tier.google`（另有 `tier.subagent` / `tier.advisor` inherit）。`buildServiceTierByFamily(openai, anthropic, google)` 只装这三家。`isServiceTierFamily` 只认这三家。`isServiceTierForFamily` switch 无第四家则 false。`serviceTierForAllFamilies` 广播时 OpenAI 任意档、Anthropic 仅 priority、Google 仅 flex/priority。来源：`packages/coding-agent/src/config/service-tier.ts` 11–13、20–41、103–126 行；`settings-schema.ts` 1409–1478 行；`sdk.ts` 3383–3389 行。[历史事实]
17. 遗留标量 `serviceTier: "priority"` 迁移到 openai+anthropic+google，不含第四家。`coerceServiceTierByFamily` 对象路径只扫描这三家 key。来源：`packages/coding-agent/src/config/settings.ts` 1738–1783 行；`packages/ai/src/types.ts` 298–328 行；`packages/coding-agent/test/service-tier-migration.test.ts`。[历史事实]
18. Session 条目 `service_tier_change` 持久化整个 `ServiceTierByFamily` map。来源：`packages/coding-agent/src/session/session-manager.ts` 2002–2005 行。[历史事实]
19. 文档：`docs/settings.md` 402–406 行；`docs/rpc.md` 297–351 行。[历史事实]

### Catalog / 当前会话模型

20. Bundled `xai` provider：`api: openai-completions`，`baseUrl: https://api.x.ai/v1`，含 `grok-4`、`grok-4.3`、`grok-4.5` 等；**无** `grok-4.6` 条目。来源：`packages/catalog/src/models.json` `xai` 块（约 91886–92601 行）。[历史事实]
21. Bundled `xai-oauth`：`api: openai-responses`，同一 `api.x.ai` host，含 `grok-4.3` / `grok-4.5` 等。来源：同文件 `xai-oauth` 块。[历史事实]
22. OpenRouter 有 `x-ai/grok-4`、`x-ai/grok-4-fast`、`x-ai/grok-4.3`、`x-ai/grok-4.5` 等，`provider: openrouter`，`api: openrouter`。来源：同文件约 78991–79207 行。[历史事实]
23. 其他代理也托管 Grok id：`aimlapi`（`x-ai/grok-*`，`openai-completions`）、`kilo`、`opencode-go` / `opencode-zen`（`grok-4.5`，`openai-responses`）。[历史事实]
24. `hosts.ts` 把 `xai` 标为 `urlMarkers: ["api.x.ai"]`。`gateway` 不是 bundled generated provider 名；测试里 `provider: "gateway"` 是自定义/broker 模型（openai-completions / openai-codex-responses / anthropic-messages 都出现过）。来源：`packages/catalog/src/hosts.ts`；`packages/coding-agent/test/bundled-agent-parsing.test.ts`；`packages/coding-agent/test/model-optimization/profile-resolver.test.ts`（`grok-4.5` + `provider: gateway` → profile `grok`）。[历史事实]
25. Fireworks 有独立 `providers.fireworksTier`，被 `excludesInferredOpenAIServiceTier` 排除出 openai family。Grok 没有对等的 provider-level 旋钮。[历史事实]

### xAI 官方 Priority Processing

26. 官方文档 https://docs.x.ai/developers/advanced-api-usage/priority-processing （2026-08-20 读取）：
    - 在 Chat Completions 与 Responses 请求体加 `service_tier: "priority"`（也可 `"default"`；省略 = 标准调度）。
    - 文本推理可用；image/video generation 与 Batch API 不可用。
    - 响应回显实际 `service_tier`；仅当响应确认 `"priority"` 才按 priority 计费。
    - 文档示例 model 为 `"grok-4.6"`，响应含 `"service_tier": "priority"`。
    - 计费：各 token 类型 2× premium；prompt cache 折扣先于 multiplier。
    - 约 2026-06-15 起提供。
    [历史事实]
27. xAI 接受值在文档中写为 `"default"` 与 `"priority"`。omp `ServiceTier` 另含 `auto|flex|scale`。OpenAI family 的 `flex/scale` 是否适用于 xAI **未在 xAI 该页出现**。[历史事实]+[未验证假设 见下]

## 未确认假设 / 证据缺口

A. `gateway/grok-4.6` 的运行时 `api` 是 `openai-completions`、`openai-responses` 还是别的。测试夹具两种都有；本会话未 dump 该 Model 对象。[未验证假设]

B. 用户的 gateway 上游是否就是 `api.x.ai`（会兑现 `service_tier`），还是内部代理会剥离未知字段。[未验证假设]

C. OpenRouter 对 `x-ai/grok-*` 是否把客户端 `service_tier` 传到 xAI。omp 今日对任意 openrouter provider 只要 tier 是 flex/scale/priority 就会 **发** 该字段（`shouldSendServiceTier("priority", "openrouter") === true`），但 `realizesPriorityServiceTier` 对非 openai/google 的 OpenRouter 模型返回 false，因此 `/fast` 仍不可用、status active 为 false。[历史事实]+[未验证假设：上游是否兑现]

D. 非 xAI 官方主机的 Grok 代理（aimlapi / kilo / opencode-*）是否接受或拒绝 `service_tier`。[未验证假设]

E. xAI 是否接受 omp 的 `auto|flex|scale`；官方该页只写 `default|priority`。[未验证假设]

F. 被拒绝时 xAI 是 400 未知字段、降级为 default 并在响应回显，还是别的。Anthropic 有 sticky fallback；xAI 文档说「看响应里的 service_tier」。[未验证假设]

G. 是否所有 Grok 文本模型都支持 Priority，还是按 SKU / 账号 entitlement。[未验证假设]

H. `getPriorityPremiumRequests` 应否把 xAI priority 算进 Copilot-premium 语义。今日函数明确只计五家 billing provider。[历史事实] 产品意图未由用户指定。[未验证假设]

## 作者必须覆盖的决策面（只列问题，不给答案）

1. Family 落点：新增独立 `xai`/`grok` family 旋钮，还是把 Grok 并入现有 openai family / 仅按 host+id 发报。
2. 分类规则：`provider === "xai"|"xai-oauth"`、`isGrokModelId`、`api.x.ai` host、OpenRouter `x-ai/`、自定义 `gateway` + grok id，各自是否进入 Fast mode。
3. 设置面：是否新增 `tier.xai`（或等价），以及 legacy `serviceTier: "priority"` 迁移是否 retroactive 填第四家。
4. Wire：Grok Fast mode 只发 `priority`，还是也暴露 `default`；`flex/scale` 对 Grok 是忽略、拒绝还是透传。
5. `shouldSendServiceTier` vs `realizesPriorityServiceTier` vs `isFastModeEnabled` 三者在 OpenRouter Grok / 未知代理上如何避免「开关成功但线上没加急」或「开关失败但字段已发出」。
6. 失败与降级：是否模仿 Anthropic sticky fallback，或只信响应回显，或 fail-open。
7. 计费统计：`getPriorityPremiumRequests` 与成本乘数（OpenAI Responses 现有 2× 仅限 `provider === "openai"`）。
8. 回归：Fireworks 独立旋钮、GitHub Copilot 排除、Bedrock/Vertex Claude 不 realize、OpenRouter Anthropic 不 realize。
9. 测试与文档：`service-tier-premium-requests.test.ts`、settings schema、`docs/rpc.md`、`docs/settings.md`、`/fast` 文案。
10. 兼容：已持久化的 `service_tier_change` map 缺第四 key 时，旧 session 打开 Grok 的默认 Fast 状态。

## 关键文件（作者必读）

- `packages/ai/src/types.ts`（family / send / realize / coerce / premium）
- `packages/ai/src/providers/openai-shared.ts`（`applyOpenAIServiceTier`、`applyCommonResponsesSamplingParams`）
- `packages/ai/src/providers/openai-completions.ts`、`openai-codex-responses.ts`
- `packages/ai/src/auth-gateway/server.ts`
- `packages/ai/src/providers/anthropic.ts`（对照 fallback，非复制）
- `packages/ai/test/service-tier-premium-requests.test.ts`
- `packages/catalog/src/identity/family.ts`（`isGrokModelId` / `isOpenAIModelId`）
- `packages/coding-agent/src/session/model-controls.ts`
- `packages/coding-agent/src/config/service-tier.ts`、`settings-schema.ts`、`settings.ts`（迁移）
- `packages/coding-agent/src/slash-commands/builtin-registry.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `docs/rpc.md`、`docs/settings.md`
- 官方：https://docs.x.ai/developers/advanced-api-usage/priority-processing

## 模板与落盘

- 设计模板：`~/.claude/skills/dev-flow-common/references/design-doc-template.md`
- 骨架（机械占位，作者替换全部章节正文）：`docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md`
- 禁止 TODO/TBD/待补充；禁止伪造 reviewed_revision / digest。
- 证据标签与本 brief 一致，另可使用 [拟议但已确定] / [拟议验收目标]。
- 文首元数据：`design_author: grok`；`design_author_identity` = 本 author 的 native agent_id；`planned_reviewer: sol-xhigh-reviewer（gateway/gpt-5.6-sol @ xhigh，只读）`；`implementation_authorization: design-only`；`authorization_source` 用本 brief 原文。
- §8 Handoff 按模板结构写，reviewer 填 `sol-xhigh-reviewer`；不要伪造 Gate digest。
