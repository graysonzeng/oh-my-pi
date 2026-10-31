# Implementation: grok-fast-mode

- Date: 2026-08-20
- Design Inputs: `docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md`, `docs/superpowers/specs/2026-08-20-grok-fast-mode-facts-brief.md`
- Review Doc: `docs/superpowers/plans/2026-08-20-grok-fast-mode-subagent-review-round-2.md`（Round-1：`docs/superpowers/plans/2026-08-20-grok-fast-mode-subagent-review.md`）
- Status: Completed
- Reviewed Inputs / Revision: Round-2 scheme digest `d6f4f9f4d4481d7936380da9018867237aced11eeb2821dbcbbaa211f5108649`（design `76725eac…` + facts `3bdd04fc…`）
- Current Inputs / Revision: `666ae31ce331ec8d5b5d9d35541ad5d7077308437a00f51338fa23bd2bb709f9`（GCN-1 仅翻授权元数据；facts 未变）
- Gate Coverage: Gate Continuity Note GCN-1
- Implementation Authorization: authorized
- Authorization Source: 用户 2026-08-20「/subagent-grok 评审完成后进行实现并验证」
- Review Mode: host-native
- Design Author Identity / Model: GrokDesigner / grok-4.6
- Reviewer Identity / Model: subagent-grok / cursor-grok-4.6-xhigh
- Implementer Identity / Model: 主协调者（Cursor Grok 4.6）。独立 `implementer` spawn 因 Other Models 额度失败后由主 agent 落地；reviewer 未改产品代码。

## 1. 评审意见处理摘要

- Round-1 HIGH/MEDIUM/LOW 六条全部采纳并写入修订设计后，Round-2 **PASS_WITH_NOTES**。
- Round-2 LOW 1：`getPriorityPremiumRequests` Pick 加可选 `baseUrl` — **采纳并落地**。
- Round-2 LOW 2：字符串 `"gateway"` 不加入 `shouldSend` 白名单 — **采纳并落地**（测试断言 `shouldSendServiceTier("priority", "gateway") === false`）。
- 未把 xAI 计入 Copilot-premium；未扩 OpenAI Responses 2×；未复制 Anthropic sticky。

## 2. 根因前提处理结论（按需）

- 适用性：不适用
- 处理策略：沿用
- 结论：已知功能缺口，不依赖故障根因。

### 2.1 消费的根因评审结论

- NOT_APPLICABLE

### 2.2 本次修订的前提边界

- 已确认事实：family 分类、发报、stamp、迁移行为按当前源码实现。
- 未确认假设：gateway 上游是否剥离 `service_tier`（A/B）；OpenRouter 是否转发（C）；未知代理是否接受字段（D）。
- 对实现的影响：gateway+Grok+OpenAI-compat realize=true 是产品选择；OpenRouter `active=false`。

## 3. 采纳的设计修订

- 独立 `ServiceTierFamily` `"xai"` + `tier.xai`（`none|priority`）。
- `createSubagentSettings` stamp 第四家；`buildServiceTierByFamily` 四个必选参数。
- media 排除 imagine/stt/voice；xai 模型对象 `shouldSend` 先于 openrouter 通用分支且只发 `priority`。
- 遗留 `serviceTier: "priority"` 不填 `tier.xai`。

## 4. 实现摘要

- `packages/ai/src/types.ts`：family / send / realize / coerce / premium Pick。
- `packages/ai/src/providers/openai-shared.ts`：`applyOpenAIServiceTier` 可选 `baseUrl`。
- `packages/coding-agent/src/config/service-tier.ts`、`settings-schema.ts`、`settings.ts` 注释。
- 调用方：`sdk.ts`、`agent-session.ts`、`bench-cli.ts`、`executor.ts` stamp。
- `ExtensionServiceTier<"xai">`、`/fast` 文案、docs（settings/rpc/task/session-switching）、changelogs。
- 测试：`service-tier-premium-requests.test.ts`、`service-tier-migration.test.ts`、`create-subagent-settings.test.ts`、`fast-mode-scope.test.ts`、`bench-auth-fallback.test.ts`。

## 5. 验证结果

- 测试：
  - `bun test packages/ai/test/service-tier-premium-requests.test.ts` → 18 pass, exit 0
  - `bun test packages/coding-agent/test/service-tier-migration.test.ts packages/coding-agent/test/task/create-subagent-settings.test.ts packages/coding-agent/test/fast-mode-scope.test.ts` → 23 pass, exit 0
  - `bun test packages/coding-agent/test/bench-auth-fallback.test.ts` → 11 pass, exit 0
  - Fireworks RPC：`cd packages/coding-agent && bun test test/rpc.test.ts --test-name-pattern "rejects enable but disable preserves Fireworks"` → 1 pass, exit 0。从仓库根目录跑同一文件时 RpcClient 在 ready 前退出（stderr 空），判定为测试启动 cwd 问题，不是本改动合同回归。
- lint/typecheck：
  - `bun run --cwd packages/ai check:types` → exit 0（修过 applyOpenAIServiceTier 测试类型后）
  - `bun run --cwd packages/coding-agent check:types` → exit 0
  - `biome check` 对本改动 15 个 TS 文件 → 无错误
- 构建：未跑 `packages/coding-agent` 二进制构建（本次是类型/设置/发报合同，不改打包入口）。
- 功能验证：单测覆盖 `/fast` 在 xai/gateway Grok 上 enable+active、OpenRouter enable 且 active=false、aimlapi/imagine/stt/copilot 不可用、发报只写 `priority`、子 agent stamp 不泄漏。未对真实 `api.x.ai` 做付费探测（设计明确非合入门槛）。

## 6. 已知限制与后续建议

- `gateway/grok-4.6` 的运行时 `api` 若不是 OpenAI-compat 三集合，family 仍 undefined（[未验证假设 A]）。
- gateway 若剥字段会出现 active=true 但未加急（[未验证假设 B]）；金路径仍是 bundled `xai`/`xai-oauth`。
- 本地 usage.cost 不含 xAI 2× 乘数（设计非目标）。
- 未跑 coding-agent / ai 全量测试套件。

## 7. Handoff

### 7.1 同会话继续

`直接执行 $code-review 或 /code-review`

### 7.2 新会话恢复 prompt

```text
请读取评审文档的 Reviewed Inputs manifest 所列全部设计输入、
评审文档 docs/superpowers/plans/2026-08-20-grok-fast-mode-subagent-review-round-2.md、
实现文档 docs/superpowers/plans/2026-08-20-grok-fast-mode-implementation.md，
以及当前工作区中 Grok Fast Mode / 独立 xai family 的代码变更。
重点核对授权来源、reviewed/current Inputs manifest 与 revision、Gate coverage、author/reviewer/implementer 角色分离、根因前提（如有）、实现结果与验证证据，
使用 $code-review（或 /code-review）进行方案重审及代码审查。
```
