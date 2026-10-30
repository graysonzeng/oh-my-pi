# ModelProfile 深度优化计划 - 执行摘要

**日期**：2026-07-26
**状态**：方案完成，待评审
**完整文档**：`2026-07-26-per-model-profile-optimization-roadmap.md` (1444 行)

---

## 一句话结论

**近期 per-model 优化主干已落地，下阶段是测量、补缝与深化：先建立可恢复的工具输出优化和端到端测量体系（P0），再逐步深化流程质量（P1）和成本延迟（P2），用数据驱动而非臆断。**

---

## 当前状态（事实）

### ✅ 已完成（commit e699c6f8b）
- ModelProfile 类型系统与 8 个目标模型配置
- PromptStrategy/ToolStrategy/ContextStrategy/OutputStrategy 四大策略接线
- 质量优先路由矩阵（plan/review 首选 Fable/Sol，implement 首选 GLM/Grok）
- Workflow benchmark 骨架
- Availability preflight 设计通过评审

### ⚠️ 关键缺口
1. **read 工具正文归零破坏合同**（P0 质量风险）
2. **端到端测量 harness 缺失**（无法验证优化收益）
3. **有损摘要不可恢复**（用户反馈核心痛点）
4. **Schema retry 配置未接线**（有类型但无重试环）
5. **Stage handoff 信息丢失**（跨角色压缩不智能）

---

## 外部最佳实践（调研结论）

### 最高共识杠杆：工具输出卫生
- **RTK**：bash/CLI 输出可减少 60-90%（作者自述 2 周 ~10M tokens / 89%）
- **警告**：节省会在 system/history 中稀释，**不等于账单 -89%**
- **启示**：优先强化 bash/test/git summarizer，内建而非依赖外部 proxy

### 用户核心痛点（Claude Code GitHub Issues）
1. **质量 > 压缩率**：静默有损压缩通过重试吐回 token（#32099）
2. **可恢复 > 激进摘要**：丢失信息必须可一跳恢复（#10727, #24976）
3. **阶段边界压缩**：中途静默 compact 无预警（#25388）
4. **Role-aware retention**：不同角色保留策略应不同（#28559）
5. **分桶测量**：只看总 token 无法调优（Aider #2491）

### 收敛的产品原则
1. 省的是无效 token，不是信息
2. 可恢复 / 可解释
3. 分桶测量（tool/context/total 分开）
4. 质量优先门禁（pass rate 掉 >3pp → 回滚）

---

## 优化方案：四阶段渐进路线（6-8 周）

### Phase 1：质量底座（Week 1-2，P0）
**目标**：确保优化不伤害质量，建立可重复测量能力

#### 关键任务
1. **可恢复的工具输出优化**
   - 修复 read 摘要合同（移除正文归零）
   - 实现 ToolOptimizationReceiptV1（记录原始 bytes、recovery URI）
   - 增强 bash/test summarizer（保留失败诊断完整性）

2. **固定任务 Benchmark**
   - 定义 10+ 固定任务（单文件修复、多文件实现、规划、review、长会话）
   - Paired A/B runner（每类 ≥3 次重复）
   - 指标分桶：system/schema/history/tool-result/cache 分开报告

3. **Availability Preflight**
   - 运行前模型可用性探测
   - 逐 profile 报告：available/unavailable/indeterminate + 实际 provider/model + latency

**验收**：
- ✅ 有损摘要 100% 可恢复
- ✅ Baseline 数据可重复测量
- ✅ Preflight 生命周期测试通过
- ✅ 质量门禁：pass rate ≥ baseline

**工期**：2 周

---

### Phase 2：优化流程（Week 3-4，P1）
**目标**：提升输出质量，减少无效 token

#### 关键任务
1. **Stage-boundary Role-aware Handoff**
   - Planner→Implementer：保留目标、约束、决策、受影响文件
   - Implementer→Reviewer：保留 plan 引用、patch、tests 结果
   - Reviewer→Repair：保留所有 blocking findings、失败验证
   - 阶段边界触发（不中途静默压缩）

2. **结构化输出分层修复**
   - Layer 1：确定性清理（去 BOM、提取 JSON）
   - Layer 2：Budget 检查
   - Layer 3：模型 retry（最多 1 + maxRetries 次）
   - Retry prompt 静态化（`.hbs.md`）

3. **Scope Adherence Metrics**
   - 记录 planned vs actual changed files
   - 检测 unplanned/forbidden/deleted files
   - 进入 benchmark quality gate

**验收**：
- ✅ Handoff 关键信息不丢失
- ✅ Schema retry 统一流程上线
- ✅ Tool-result token 相对 baseline -30%+（P1 目标）

**工期**：2 周

---

### Phase 3：成本延迟（Week 5-6，P2）
**目标**：在质量稳定前提下优化成本与延迟

#### 关键任务
1. **Lazy Tool/Schema/Skill Presentation**
   - 复用 xd:// 协议
   - Essential tools 完整 schema，non-essential 短描述 + 可一跳展开
   - Feature flag 默认关闭

2. **Cache-friendly Stable Prefix**
   - 固定顺序：static system → role policy → tool presentation → 动态 assignment/history
   - Prompt assembly receipt（stable/dynamic SHA + bytes）

3. **依赖与预算感知并发**
   - 复用 agent loop scheduler
   - 同路径 write 串行，只读可并发
   - Budget 预留机制

**验收**：
- ✅ Lazy loading 减少初始 prompt size
- ✅ Cache hit rate 提升（相同任务重复运行）
- ✅ 单任务成本方向性下降

**工期**：2 周

---

### Phase 4：深化（触发式，按需）
- **完整 CWL**：仅当简化 eviction 是质量瓶颈
- **Tree-sitter repo-map**：仅当 regex map 导致错误文件选择
- **在线学习路由**：离线 scorecard 稳定运行 3+ 月后

---

## 成功标准

### P0 质量门禁（必须满足）
- 任务通过率 ≥ baseline（不得下降）
- 关键阶段不因降级掉点
- 有损摘要关键事实可一跳恢复
- Blocking finding 不被错误驱逐

### P1 优化指标
- Tool-result token：-30% ~ -50%
- Context (stage)：-20% ~ -40%
- Schema violation 率：-30% ~ -50%
- 重复 read 同一文件：-20% ~ -40%

### P2 成本延迟
- 单任务成本：方向性下降
- Cache hit rate：+20% ~ +40%
- 并发工具吞吐：+30% ~ +60%

**不承诺**：
- ❌ 总会话 token 固定百分比（-40~70%）
- ❌ 成本绝对值（模型定价变化快）
- ❌ 与厂商数字（Cursor Router 30-60%）直接对比

---

## 关键风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 有损摘要丢失关键信息 | **P0 可恢复合同** + 关键事实召回测试 |
| Stage handoff 驱逐 blocking finding | 确定性提取 + 合同测试保证不丢 |
| Benchmark 任务集不代表真实场景 | 多样化任务类型 + 长期收集真实案例 |
| 用户期望总会话 -70% | 诚实文档，只承诺 tool-result P1 目标 |

---

## 立即行动（Week 1）

**优先级 1**：
- [ ] 修复 read 摘要合同（正文归零破坏工具合同）
- [ ] 实现 ToolOptimizationReceiptV1
- [ ] 定义 10+ 固定任务集

**优先级 2**：
- [ ] 增强 bash/test summarizer（保留失败诊断完整性）
- [ ] 实现 paired A/B runner 骨架

---

## 最值得深度打磨的 ModelProfile 维度

### 1. ToolStrategy（最高杠杆）★★★★★
- **为什么**：外部共识最强、立即生效、质量可控
- **如何**：可恢复摘要 + 失败诊断完整性 + 噪音过滤智能化
- **收益**：Tool-result token -30%~60%

### 2. ContextStrategy（阶段边界智能驱逐）★★★★☆
- **为什么**：用户痛点（中途静默压缩、role 不区分）
- **如何**：Stage-boundary handoff + per-role 保留策略
- **收益**：Context bytes -20%~50% + 关键信息不丢失

### 3. OutputStrategy（分层 Schema 修复）★★★☆☆
- **为什么**：减少昂贵模型重试
- **如何**：确定性清理 → budget 检查 → 模型 retry
- **收益**：Schema violation -30%~50% + retry 成本下降

### 4. PromptStrategy（风格适配）★★☆☆☆
- **为什么**：已接线基础功能，边际收益不确定
- **如何**：Few-shot 静态库（仅当测量证明需要）
- **收益**：Schema 首次成功率提升（需实测）

---

## 下一步

1. **技术评审**：本方案提交团队评审（完整文档 + 本摘要）
2. **资源分配**：Week 1-2 专人投入，不被其他任务打断
3. **启动 Phase 1**：从修复 read 摘要合同开始
4. **周度同步**：每周五复盘进度与质量门禁

---

**完整方案**：`docs/superpowers/specs/2026-07-26-per-model-profile-optimization-roadmap.md`
**问题咨询**：见完整文档 §10 总结与行动建议
