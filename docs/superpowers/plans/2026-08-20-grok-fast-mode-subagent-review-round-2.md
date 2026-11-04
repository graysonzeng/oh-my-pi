# Subagent Review: grok-fast-mode (round 2)

- Date: 2026-08-20
- Review Artifact: docs/superpowers/plans/2026-08-20-grok-fast-mode-subagent-review-round-2.md
- Primary Reviewed Design: docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md
- Reviewed Inputs:

| Path | SHA-256 |
|---|---|
| `docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md` | `76725eac2b11b52b734b09006dfbaf5c1be913c49be86e0e6b52feff90c09e18` |
| `docs/superpowers/specs/2026-08-20-grok-fast-mode-facts-brief.md` | `3bdd04fc97d327ac304c26c48e449b08c55bc10c9421f3ddc9459fa11a307d7c` |

- Reviewed Revision: `d6f4f9f4d4481d7936380da9018867237aced11eeb2821dbcbbaa211f5108649`
- Review Mode: host-native
- Design Author Identity: GrokDesigner
- Design Author Model: grok (GrokDesigner；Round-1 记为 gateway/grok-4.6)
- Reviewer Identity: subagent-grok
- Reviewer Model: cursor-grok-4.6-xhigh
- Review Fallback: grok-4.6
- Fallback Reason: user-requested `/subagent-grok` for both rounds
- Implementation Authorization: design-only（评审时文档字段）。本会话用户原话要求 Gate 通过后实现并验证；主协调者在 §6.1 Continuity Note 记录翻字段。
- Authorization Source: 用户 2026-08-20「grok 是支持 Fast mode。分析下如果添加并设计方案」；随后「可以直接交给 grok-4.6 subagent 作者起草」
- Review Scope: Round-2 Design Review Gate（方案 A 局部修订；核对已采纳 findings 是否关闭；不重开 A/B/C）

Hash check: `shasum -a 256` 与 canonical TAB/LF manifest 均匹配提供的 digest。Facts-brief 哈希相对 Round 1 未变。继续评审。

## 1. 整体结论

- **PASS_WITH_NOTES**
- 方案 A 仍成立；Round-1 已采纳的六项都写进了修订正文，且与当前源码一致。没有新的 stamp / shouldSend / 四参 / media-exclude 合同洞。剩两条不改 family/send/realize/migration/wire/stamp 的 LOW。`implementation_authorization` 评审时仍是 design-only。

## 2. 根因评审结论

- **适用性：** 不适用（跳过 RCA 合适）。
- **结论：** NOT_APPLICABLE
- **理由：** facts brief「规模与根因」与设计 §2 仍一致：已知功能缺口，不是未知故障。本轮未出现会推翻该判断的新源码证据。

### 2.1 证据检查

不适用。分类短路仍由当前源码支撑：`ServiceTierFamily` 只有三家（`packages/ai/src/types.ts:145`）；`serviceTierFamily` 对 openrouter 只认 `anthropic/` / `google/` / `openai/`（`:188-193`）；`isOpenAIModelId` 不匹配 `grok-*`（`packages/catalog/src/identity/family.ts:144-149`）；`setFastMode` 无 family 即失败（`packages/coding-agent/src/session/model-controls.ts:725-733`）。[历史事实]

### 2.2 事实 / 假设边界检查

不适用。未验证假设 A–G 仍标为假设；gateway realize=true 仍标为产品选择。

### 2.3 对方案的影响检查

不适用。缺口机制未变，不支持改 family。

## 3. 设计方案评审

### 3.1 需求与方向

§1.2 六条仍与 facts brief 成功标准对齐。非目标未膨胀：不把 `grok-4-fast` SKU 当 session Fast；不复制 Anthropic sticky；不把 xAI 2× 写进 `getPriorityPremiumRequests`；不打开 `applyOpenAIResponsesServiceTierCost` 的 OpenAI 闸门。官方 Priority 声明未超出 facts brief §26。[历史事实]

### 3.2 方案合理性 (A vs B vs C; family isolation; send vs realize)

不重开 A/B/C。当前源码仍支持独立 `xai`：`ServiceTierByFamily` 注释是 per-family 隔离（`types.ts:147-151`）；无 family 则 `/fast on` 必须失败（`model-controls.ts:725-733`）。没有新证据表明 Grok 应并入 openai 或无 family 只发报。

Send vs realize 未倒置：未知代理无 family；OR 有 family、send、不 realize；唯一 fail-open 仍是 gateway+Grok+OpenAI-compat 的 realize=true。遗留 `serviceTier: "priority"` 今日只填三家，设计仍不 retroactive 填 xai。[历史事实]

未引入第二套引擎：toggle 仍走 `setFastMode` / family map；发报仍走 `applyOpenAIServiceTier`；不新增 `providers.xaiTier`。

### 3.3 实现可行性 (call sites, types, tests)

Round-1 已采纳六项在修订正文中均关闭（stamp、四必选参、media 三前缀、shouldSend 先于 openrouter 且只发 priority、catalog-faithful OR 夹具、ExtensionServiceTier / Pick baseUrl）。对照当前源码：`executor.ts:851-875` 仍只 stamp 三家；`service-tier.ts:103` 仍三必选参；`types.ts:228-229` 仍先匹配 openrouter 通用矩阵；`XAI_NON_CHAT_PREFIXES` 在 `openai-compat.ts:1180`。这些是实现义务，不是新的设计洞。

`createSubagentSettings` 已 export。§7.2 写的 `packages/coding-agent/test/task/create-subagent-settings.test.ts` 今天不存在；实现时新建或并入现有 task 测试即可。

Advisor 走内存 `serviceTierForAllFamilies`，不 stamp settings。

### 3.4 文档质量

修订消掉了 Round-1 的自相矛盾。§1.2.6「直到用户 `/fast on` 或设置 `tier.xai`」比 §4.6 略宽：有 persisted map 且缺 `xai` key 时，改 settings **不会**补第四家。合同以 §4.6 为准。

## 4. 主要发现

### CRITICAL

none

### HIGH

none

### MEDIUM

none

### LOW

**1. `getPriorityPremiumRequests` 的独立 Pick 未列入 baseUrl 扩展清单**

- Spec: 设计 §4.2 点名若干 Pick，未点名 `getPriorityPremiumRequests`
- Source: `packages/ai/src/types.ts:279`
- Impact: 类型对齐，不改 premium=0 合同
- Required revision: 实现时把该 Pick 一并加上可选 `baseUrl`。不必再改设计正文

**2. 字符串 `"gateway"` 的 `shouldSend` 保持 false；telemetry 用字符串 provider**

- Spec: §4.2 为字符串只加 `"xai"` / `"xai-oauth"`
- Source: `packages/agent/src/telemetry.ts:755`；wire 走 model 对象
- Impact: gateway Grok 仍发报；telemetry 可能漏记。不要给字符串 `"gateway"` 开 priority 白名单
- Required revision: 无设计义务

## 5. 修订建议

1. 不必再改设计方案正文。
2. 实现时顺手扩展 `getPriorityPremiumRequests` 的 Pick；telemetry 保持字符串 `"gateway"` fail-closed。
3. Coordinator 将 `implementation_authorization` 翻成 authorized 后进入实现。LOW 不阻塞、不要求再跑 Gate。

## 6. Gate Evidence

- Verdict: **PASS_WITH_NOTES**
- Covered Revision: `d6f4f9f4d4481d7936380da9018867237aced11eeb2821dbcbbaa211f5108649`
- Evidence Summary: 见 reviewer 对照 `types.ts` / `executor.ts` / `service-tier.ts` / `openai-compat.ts` / `extensions/types.ts` / catalog OpenRouter Grok / 三处 `applyOpenAIServiceTier` 调用点。文档评审时 `implementation_authorization: design-only`。

### 6.1 Gate Continuity Notes

- Initial state: none（评审落盘时）。

**GCN-1（主协调者，2026-08-20）** — 非实质变化：仅翻设计文首 `implementation_authorization` / `authorization_source` / Status，方案正文、分类表、发报合同、测试义务未改。author/reviewer/implementer 均未写该元数据。判定：延续 Round-2 Gate，不重审。

| Path | Reviewed SHA-256 | Current SHA-256 |
|---|---|---|
| `docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md` | `76725eac2b11b52b734b09006dfbaf5c1be913c49be86e0e6b52feff90c09e18` | `3b8cc2bb8e0c81c27325ac54fdf3c4587e7c4d45656c27970636aade4d4b618d` |
| `docs/superpowers/specs/2026-08-20-grok-fast-mode-facts-brief.md` | `3bdd04fc97d327ac304c26c48e449b08c55bc10c9421f3ddc9459fa11a307d7c` | unchanged |

- Reviewed Revision: `d6f4f9f4d4481d7936380da9018867237aced11eeb2821dbcbbaa211f5108649`
- Current Inputs Revision: `666ae31ce331ec8d5b5d9d35541ad5d7077308437a00f51338fa23bd2bb709f9`
- Unchanged invariants: 独立 `xai` family；只发 `priority`；OpenRouter send-but-not-realize；遗留迁移不 retroactive；`createSubagentSettings` stamp `tier.xai`；四必选参；media 排除 imagine/stt/voice。
- Coordinator/model: Cursor Grok 4.6 主协调者（非 author / 非 reviewer / 非 implementer）

## 7. 下一步建议

Coordinator 翻授权后进入 design-implement。LOW 不阻塞。

## 8. Handoff

### 8.1 PASS* 且已授权实现

本会话用户 2026-08-20：「/subagent-grok 评审完成后进行实现并验证」。Round-2 Gate = PASS_WITH_NOTES。主协调者消费该授权并委派独立 implementer（不得为 reviewer）。

### 8.2 PASS* 但仅限设计

评审时文档字段为 design-only；由主协调者按用户原话翻字段，不视为方案实质变化。

### 8.3 NEEDS_REVISION / NEEDS_REDESIGN

不适用。
