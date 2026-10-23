# Subagent Review: follow-up / worker latency

- Date: 2026-09-06
- Review Artifact: docs/superpowers/plans/2026-09-06-subagent-followup-worker-latency-subagent-review.md
- Primary Reviewed Design: docs/superpowers/specs/2026-09-06-subagent-followup-worker-latency-design.md
- Reviewed Inputs:
  - docs/superpowers/specs/2026-09-06-subagent-followup-worker-latency-design.md — SHA-256 342a56c8ad9780fddb78918508bfc9837fa6c2871d4e246c536531475c398c42
  - docs/superpowers/specs/2026-09-06-subagent-followup-worker-latency-facts-brief.md — SHA-256 191ade018182c152aaf84c1806a1974b9f134af7493f8aaa0e2fe52de9d4e084
- Reviewed Revision: 4d0575e53164dc1f6e392f0f0009855bca47d08f4903148ba9bb1dce971e734d
- Review Mode: host-native
- Design Author Identity: GrokDesignAuthor
- Design Author Model: grok / gateway/grok-4.6
- Reviewer Identity: AstraDesignGate
- Reviewer Model: gateway/gpt-6-astra
- Review Fallback: none
- Fallback Reason: not-applicable
- Implementation Authorization: design-only
- Authorization Source: 用户当前请求是分析近期会话耗时并在已有优化基础上设计完整方案；未授权改产品代码、改本机 ~/.omp 配置或发布。
- Review Scope: 全部两项设计输入、预算入口与冷恢复必要源码；核对量化观测、A/B 选型、五处调用面、预算语义和验收一致性。未运行格式化、lint、build 或产品测试。

## 1. 整体结论
- NEEDS_REVISION
- 一句话结论：A 的每轮共享解析是正确的浅方案，但冷恢复降级范围被低估，且与三类四入口同合同验收冲突；需修正文档合同与测试，不需要升为累计账本 B。

## 2. 根因评审结论（按需）
- 适用性：适用
- 结论：SUPPORTED
- 理由：预算归零是源码事实；167 min 的跨轮归属仍未知，不能证明累计账本必要。

### 2.1 证据检查
- 事实：packages/coding-agent/src/task/executor.ts:2594-2627 的 attach 默认墙钟为 0、请求预算为 0；同文件:2870-2887 的 follow-up 同样归零；:3109-3124 热 install 仅传墙钟。packages/coding-agent/src/task/persisted-revive.ts:183-191 冷 attach 不传墙钟；packages/coding-agent/src/vibe/runtime.ts:1536-1545 跟进轮不传墙钟或 class。
- 事实：两项文件 SHA-256 已重新计算，与 manifest 一致。完整读取两项输入及 /tmp/omp_latency_2026-09-06/summary.md。设计:85-104 的窗口数据与 facts brief 第 2 节及 summary 对应窗口一致：新鲜子活跃 n=234、p50=7.44、p90=31.25、max=167.18、≥60m=4；task counted=156、max=0.01 在 summary 新鲜窗口有来源。
- 未验证：本轮未复跑聚合脚本、未运行质量 fixture，未证明耗时收益或 167 min 的具体 run 边界。

### 2.2 事实 / 假设边界检查
- 设计:137-160 将 167.177 min、60.001 文件墙钟、flash:max 共现与原因明确分开；未把窗口差当因果百分比，未宣称 45–90s / 35% / 36% 收益。
- 事实 brief 第 2.4、5 节明确 completionKind 未解析、单轮/多轮未知。该边界足以支持修已知归零缺口，不足以承诺长尾消失。

### 2.3 对方案的影响检查
- 设计:162-181 推荐 A，不详细展开落败 B；累计仍可超过 1h 的限制明确。无需为未知因果引入第二生命周期或累计账本。

## 3. 设计方案评审

### 3.1 需求与方向
- 设计:18-24、213-230 覆盖全部五处入口。worker 继续使用现有默认 1h/200，不引入更短 ceiling；省略与显式 0 在:197-202 明确区分。
- 独立 Gate、timeout 非 PASS、design-only 停止均保留（设计:35-50、317-338）。

### 3.2 方案合理性
- 最小充分：A 足以消除确认的预算=0；B 没有已确认必要约束。
- 范围纪律：没有重做已落地 class/scout/75% advisory，没有新增模型策略、flag、遥测管道。
- owner：复用 executor monitor、review-performance class 和 persisted-revive，不新建调度器。冷恢复解析合同仍需修订，见 MEDIUM。

### 3.3 实现可行性
- 五处 wiring 与共享 resolver 可在已有 owner 内实现。75% advisory、请求 1.5× 强停与 salvage 保留。
- 设计:255-262、299-304 已列相关测试，但冷路径的测试需要覆盖真实 stub 输入，而非人工注入 review class；否则不能检验当前降级边界。

### 3.4 文档质量
- 推荐方案接口、非目标和授权边界清晰；未为 B 撰写第二套详细实现。
- 冷恢复的成功标准、数据可得性与风险说明不一致，这是影响实现验收的合同问题，而非篇幅或风格问题。

## 4. 主要发现

### CRITICAL
- 无。

### HIGH
- 无。

### MEDIUM
- **P2：冷恢复 class 丢失不限于 spawn-only review，当前验收会误判覆盖完成。** 触发：任一依赖 agent frontmatter `shadowReview: code` 的非 floor 名 agent 经冷恢复。设计 docs/superpowers/specs/2026-09-06-subagent-followup-worker-latency-design.md:228-230、274-276 将已知降级仅描述为 spawn-only review；但冷路径只向 resolver 提供 `ref.displayName`。源码 packages/coding-agent/src/task/persisted-revive.ts:177-191 创建的 wakeAgent stub 没有 shadowReview；packages/coding-agent/src/task/review-performance.ts:115-123 明确 frontmatter 与 spawn flag 都能独立决定 review。因此 frontmatter-only review 也确定会失去 class 输入，并可能退为 worker，默认由 30 min/80 放宽为 1h/200，75% advisory 不再挂载。设计:31-35、223-225、259-261 同时要求三类四入口同合同，未给此类情况验收例外。修复：保留 A；明确冷恢复只能按现存证据重解析，完整列出 frontmatter/spawn 输入丢失及原 caller override 无法恢复的边界；若允许这些降级，修改成功标准并在真实 stub 冷路径测试中锁定结果；若要求原 class/override 保真，则说明最小必要的来源恢复方式，不得用手工传 class 的 resolver 单测冒充冷恢复覆盖。

### LOW
- 无独立发现。

## 5. 修订建议
- 原 author 修正冷恢复合同与验收例外，不能仅把 spawn-only 字样扩成所有情况而保留全入口同 class 的无条件承诺。
- 增加冷恢复案例：非 floor 名 + frontmatter code、非 floor 名 + spawn code、名字命中 floor/explore、原显式 0 与省略的可恢复性。明确哪些是保持原值、哪些只能重新按当前 settings 解析。
- 不改变 A/B 结论，不增加累计账本，不重做已落地机制。修订后重新进行独立 Gate。

## 6. Gate Evidence
- Verdict: NEEDS_REVISION
- Covered Revision: 4d0575e53164dc1f6e392f0f0009855bca47d08f4903148ba9bb1dce971e734d
- Evidence Summary: 两项输入完整读取且当前字节 hash 一致；五处预算归零/缺参已对照源码；量化窗口与 facts/summary 一致。唯一阻断为冷恢复 class 丢失边界与验收矛盾，非 A 选型失败。Shadow architecture/completion timeout，grounded/correctness 因其运行无法读取 brief 未完成实质覆盖；不作 PASS、也不转成设计 finding。本 Gate 为独立人工阅读结论。

### 6.1 Gate Continuity Notes
- Initial state: none
- 后续仅由未参与 author/reviewer/正文修改/implementation 的主协调者追加，覆盖全部输入 manifest/revision、变化范围及判定理由。

## 7. 下一步建议
- 返回设计修订并重新执行 Gate；仍为 design-only，不进入实现。
- 理由：需先消除冷恢复保证与实际可用输入的矛盾。PASS 后也必须停止，新的权威用户授权才可实施。

## 8. Handoff

### 8.1 PASS* 且已授权实现
- 不适用：本次未通过且仅授权设计，不生成实现 handoff。

### 8.2 PASS* 但仅限设计
- implementation_authorization=design-only：即使后续 PASS 也停止，不生成 design-implement handoff；只有新的权威用户指令可改变授权。

### 8.3 NEEDS_REVISION / NEEDS_REDESIGN
**同会话继续**
回到 design-brainstorm，由原 author 修订冷恢复合同与验收，再执行独立 Design Review Gate；主协调者不修改设计正文，不得实现。

**新会话恢复 prompt**
```text
请阅读 docs/superpowers/specs/2026-09-06-subagent-followup-worker-latency-design.md、对应 facts-brief.md，以及 docs/superpowers/plans/2026-09-06-subagent-followup-worker-latency-subagent-review.md。由原 author 修订冷恢复 class/override 信息缺失的合同与真实入口验收，保留 A 和 design-only；主 agent 只协调。重新计算完整 Reviewed Inputs manifest/revision 并执行独立 Gate，通过前不得实现，通过后也因 design-only 停止。
```
