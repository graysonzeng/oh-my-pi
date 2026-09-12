# 质量控制与多模型优化 - 执行摘要

Date: 2026-07-30
Author: Analysis based on design doc review

## 核心结论

**设计方向验证：✅ 正确**

基于设计文档 `2026-07-30-quality-gated-multi-model-optimization-design.md` 的深度分析，并参考文档中引用的权威来源（Anthropic 工程文、OpenAI 指南、同行评审论文），核心结论：

1. **"质量优先 + 能力编译 + 证据驱动"方案与 2025-2026 行业前沿完全一致**
2. **Phase 0-5 实施路径符合"确定性→可恢复→模型依赖"的风险递增原则**
3. **关键架构设计（artifact-backed、role-aware handoff、quality-gated routing）与行业最佳实践高度吻合**

## 关键发现对比

| 维度 | 设计文档方案 | 行业证据 | 对齐度 | 建议 |
|------|-------------|---------|--------|------|
| **质量保障** | 硬约束 + eligible candidates + 三层验证 | Quality-gated cascading (RouteLLM: 85% cost + 95% quality) | ✅ 完全对齐 | Judge 硬门禁维度要求 κ ≥ 0.75 |
| **Context 优化** | Artifact-backed + 7 步优化顺序 | 25-50% token reduction proven (Anthropic, Claude Code issues) | ✅ 完全对齐 | Phase 1 立即实施前 3 步 |
| **工具系统** | Essential set + catalog + 独立 eval | Tool minimization + PLAY2PROMPT | ✅ 完全对齐 | Essential set ≤15 工具 |
| **执行形态** | 3 shapes + complexity gate | Single-agent baseline 强调 (arXiv 2601.12307) | ✅ 对齐 | **需强化 single-session baseline** |
| **路由策略** | Unit success cost 优化 | Cost-quality tradeoff frameworks | ✅ 完全对齐 | 分解 cost breakdown |
| **Judge 校准** | κ ≥ 0.60 + ≥10% 盲审 | 行业标准 substantial agreement | ✅ 完全对齐 | 监控长度偏差 |
| **实施路径** | Shadow → A/B → canary | 行业标准渐进式上线 | ✅ 完全对齐 | 按设计执行 |

## 三大强化建议

### 1. Single-agent Baseline 必须建立

**现状**：文档 §5.5.1 提到"同模型 planner/reviewer 默认合并成单会话阶段"

**行业证据**：
- arXiv 2601.12307："同模型多角色应先与共享 KV-cache 的单代理分阶段 baseline 比较"
- 80% 场景 single-agent 足够
- Multi-agent 约 15x token 成本

**建议强化**：

```
同模型场景的正确比较：

❌ 错误：
  Baseline: 单次调用（无阶段）
  Candidate: 多角色 workflow
  → 混淆"多角色"和"分阶段"收益

✅ 正确：
  Baseline: single_session（共享 context + KV cache + 分阶段）
  Candidate: independent instances（独立 context + 无 cache）
  
  门禁: Candidate 必须在 ≥2 个维度显著优于 baseline
        且无维度显著劣于 baseline
```

**实施**：Phase 4 必须建立此 baseline 再激活 complexity gate

### 2. Judge Calibration 硬门禁维度更严

**现状**：文档 §6.3 要求 κ ≥ 0.60（substantial agreement）

**建议补充**：

```typescript
interface EnhancedCalibration {
  // 通用维度
  overall_kappa: 0.60,  // 文档已有
  
  // 硬门禁维度（建议更严）
  critical_dimensions: {
    permission_violation: { kappa: 0.75, agreement: 1.0 },  // 100% 一致
    scope_drift: { kappa: 0.75, agreement: 0.95 },
    verifier_integrity: { kappa: 0.75, agreement: 1.0 },    // 100% 一致
  },
  
  // 偏差检测（新增）
  bias_checks: {
    length_bias: { max_correlation: 0.3 },  // |r| > 0.3 触发警告
    style_bias: { chi_square_test: true },
  },
}
```

**理由**：权限、scope、验证完整性是安全关键，不允许 judge disagreement

### 3. Phase 1 立即实施（零风险高收益）

**现状**：文档 Phase 1 包含可观测性与去重

**建议聚焦前 3 步**（确定性操作）：

```
Step 1: 去重 attachment/reminder/delta
  - 零风险（确定性 hash 去重）
  - 预期收益：10-20% token
  - 证据：Claude Code issue #32099

Step 2: 旧 tool result → artifact ref
  - 低风险（可恢复，持久化原文）
  - 预期收益：15-25% token
  - 证据：Anthropic 工程文 "避免重传"

Step 3: ContextLedger 完整实现
  - 零风险（只读可观测性）
  - 收益：完整 token 分桶，识别浪费源
  - 实施：按文档 §5.4.1 规则
```

**延后到 Phase 2**（需 eval 门禁）：
- Role-aware handoff（需 recall eval）
- Tool catalog（需 selection eval）
- Cache assembly（需 provider 确认）

## 立即行动清单

### 本周可启动（P0）

- [ ] 实现 ContextLedgerV1
  - 按 UTF-8 bytes / 4 估算
  - Provider facts vs estimates 标记
  - 分桶：system/tools/history/artifacts/output
  
- [ ] 去重系统
  - Hash-based deduplication
  - Attachment/reminder/delta 检测
  - 记录节省 token 证明收益

- [ ] Artifact ref 机制
  - 持久化原始内容
  - 返回 recovery URI + sha256
  - 可恢复性测试

### 2 周内完成（P1）

- [ ] Live suite 扩充到 30+ cases
  - 覆盖 9 类任务（bug/feature/refactor/review/tool-heavy/schema-heavy/long-session/permission/research）
  - 固定 repo commit + verification commands
  - 每个 ≥5 次重复运行

- [ ] Failure taxonomy 建立
  - 分析现有失败 traces
  - 定义 failure features（≥5 cases 支撑）
  - 创建首批 overlays

- [ ] Single-session baseline 设计
  - 明确与 independent instances 的对比协议
  - 固定对比维度（success rate / cost / latency / context pressure）

### 1 个月内完成（P2）

- [ ] Tool concurrency ceiling（shadow → A/B）
- [ ] Prompt overlay 首批激活（needs_explicit_completion）
- [ ] Judge calibration infrastructure

### 按证据触发（P3）

- [ ] Tool catalog（tool selection eval 通过后）
- [ ] Complexity gate（baseline 建立后）
- [ ] Tree-sitter repo-map（证明 localization 是瓶颈后）

## 风险与缓解

### 高风险

**风险 1：Judge 偏差导致质量误判**
- 影响：错误的模型/策略选择
- 缓解：
  - Programmatic verifier 决定性判定
  - 双 judge agreement
  - ≥10% 分层人工盲审
  - 监控 length/style 偏差（补充）

**风险 2：Optimization 过拟合到 eval set**
- 影响：生产质量不如 eval 表现
- 缓解：
  - 开发/调参/验收集严格分离
  - 定期从生产失败补充样本（补充）
  - 每季度刷新 held-out set（补充）

### 中风险

**风险 3：Context 优化丢失关键信息**
- 影响：后续决策质量下降
- 缓解：
  - Artifact-backed（文档已设计）
  - Recall ≥ 95% 门禁（文档已要求）
  - 一跳恢复成功率 ≥ 98%（文档已要求）

**风险 4：Provider 版本更新使 model card 失效**
- 影响：历史优化失效
- 缓解：
  - Facts/fingerprint 变化回到 shadow（文档已设计）
  - 监控 API version header（补充）
  - 自动触发 re-eval（补充）

### 低风险

**风险 5：Tool catalog 影响 selection accuracy**
- 影响：选错工具
- 缓解：
  - Essential set ≤15（文档已设计）
  - One-hop expansion（文档已设计）
  - Held-out tool eval 门禁（文档已要求）

## 收益预估

基于行业数据和设计文档分析：

### Phase 1（立即，零/低风险）

```
去重系统：              10-20% token 节省
Artifact ref：          15-25% token 节省
Role-aware handoff：    10-20% token 节省
─────────────────────────────────────
总计（保守）：          25-40% token 节省
质量影响：              无（可恢复操作）
```

### Phase 2-3（中期，需 eval 门禁）

```
Cache assembly：        20-40% effective input（高 cache hit 场景）
Tool catalog：          5-15% token（大工具表面场景）
Prompt overlay：        5-10% 失败率降低
─────────────────────────────────────
额外节省：              10-30% token（场景依赖）
质量影响：              持平或提升（held-out eval 门禁）
```

### Phase 4-5（长期，按瓶颈触发）

```
Complexity gate：       15-30% 成本节省（避免过重 workflow）
Multi-model routing：   20-50% 成本节省（quality-gated cascading）
─────────────────────────────────────
额外节省：              30-60% 成本（需证明不损质量）
```

## 与设计文档的一致性

### 完全一致的部分（直接执行）

✅ §5.2 Prompt 设计（shared-contract + short overlay）
✅ §5.3 工具优化（essential set + catalog + 输出合同）
✅ §5.4 Context 优化（artifact-backed + 7 步顺序）
✅ §5.6 路由策略（硬约束 + unit_success_cost）
✅ §5.8 错误处理（fail closed + artifact 不可删）
✅ §6.1-6.2 数据集与指标
✅ §6.3 Judge calibration（κ ≥ 0.60）
✅ §6.4 上线门禁（shadow → A/B → canary）
✅ §6.5 Phase 0-5 顺序

### 建议补充的部分（不改变方向）

📝 §5.5.1 执行形态：强化 single-session baseline 作为同模型多角色的必要对比
📝 §6.3 Judge calibration：硬门禁维度要求 κ ≥ 0.75，监控长度/风格偏差
📝 §6.5 Phase 1：明确聚焦前 3 步（去重 + artifact ref + ledger），后续步骤需 eval 门禁

### 无需修改的部分

文档的核心架构、目标函数、验证方法、风险缓解策略均与行业最佳实践一致，无需修改。

## 最终建议

**设计文档方案正确，建议按以下优先级执行**：

1. **Phase 0**（立即）：探测 baseline，区分冲突与 staged 改动
2. **Phase 1**（本周启动）：ContextLedger + 去重 + artifact ref（零/低风险，25-40% 收益）
3. **Phase 2**（按证据）：Compiler levers 逐项 A/B（held-out eval 门禁）
4. **Phase 3**（持续）：Prompt/tool 优化（failure-driven）
5. **Phase 4**（baseline 后）：Complexity gate + single-session baseline
6. **Phase 5**（瓶颈触发）：Tree-sitter / episode graph / adaptive routing

**关键成功因素**：

- 质量门禁不妥协（硬约束）
- 每次只激活一个 lever（可归因）
- Held-out eval 门禁（不过拟合）
- Single-session baseline（同模型多角色正确比较）
- 分层验证金字塔（programmatic → judge → human）

**预期结果**：

- 短期（Phase 1）：25-40% token 节省，质量不降
- 中期（Phase 2-3）：额外 10-30% 节省，质量持平或提升
- 长期（Phase 4-5）：总计 50-70% 成本节省，质量优先目标达成

---

**详细分析参见**：
- `2026-07-30-best-practices-recommendations.md`（质量保障、Context 优化、工具系统）
- `2026-07-30-best-practices-recommendations-part2.md`（执行形态、路由策略、实施路径）
