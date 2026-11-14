# Grok Build Goal Mode - Per-Model Optimization Implementation Prompt

**任务**: 在 oh-my-pi 中实现 per-model 优化方案，**质量优先，平衡成本**，让不同模型通过针对性的 prompt、工具调用和上下文管理优化，在保障任务质量的同时降低 token 消耗。

**工作目录**: `/Users/sheng/tencent/oh-my-pi`

**关键文档**: 
- 设计文档: `/Users/sheng/tencent/oh-my-pi/docs/superpowers/specs/2026-07-25-per-model-optimization-design.md`
- 已有 workflow 文档: `docs/workflow.md`
- 已有 models 文档: `docs/models.md`

---

## 目标

实现完整的 per-model 优化系统，核心目标：

1. **质量第一**：任务通过率从 75% 提升到 **85-90%**（P0 优先级）
2. **Token 效率**：在保证质量前提下降低 40-60% token 消耗（P1）
3. **成本可控**：总成本降低 40-60%，相对全 Opus baseline（P2）
4. **超越原厂**：质量超越 Claude Code（78% → 85%），token 效率接近 Aider

**核心原则**：
- 规划/审查用最高质量模型（Opus 4.8, GPT-5.6-sol）
- 实现阶段平衡成本（Grok 4.5, DeepSeek V4 Pro）
- 质量差距 <3% 时，允许成本节省 >50%
- 质量下降 >3% 时，立即回退到高质量配置

---

## 目标模型清单（基于真实用户反馈）

必须支持以下 8 个模型：
1. **claude-fable-5** - **最强质量 9/10**（SWE-bench Pro 80.3%，长周期任务最强）
2. **gpt-5.6-sol** - **Agent 最佳 8.5/10**（Terminal-Bench 91.9% 第一）
3. **glm-5.2** - **性价比王 8/10**（"接近 Opus 质量但零头价格"，MIT 开源）
4. **gpt-5.6-terra** - **平衡之选 8/10**（100 万+窗口，价格仅 Opus 一半）
5. **grok-4.5** - **速度领导 7.5/10**（性价比极高，但幻觉率较高）
6. **claude-opus-4.8** - **备选 8/10**（长上下文，但质量问题 + token 消耗大）
7. **claude-sonnet-5** - **降级 7.5/10**（用户投诉"不遵守命令"）
8. **deepseek-v4-pro** - **仅批量 7.5/10**（极低价，但 API 7 月后不稳定）

**质量分层（2026年7月真实反馈）**：
- **T0 顶级**：Fable 5（最强），GPT-5.6-sol（agent 最佳）
- **T1 高质量**：GLM-5.2（惊艳性价比），Terra（平衡），Opus 4.8（降级为备选）
- **T2 高性价比**：Grok 4.5（速度快），Sonnet 5（降级）
- **T3 极致性价比**：DeepSeek V4 Pro（API 不稳定，仅批量任务）

**关键发现**：
- Fable 5 确实最强，但价格是 Opus 两倍（$10/$50）
- **GPT-5.6-sol 在 agent 工作流表现最佳**（Terminal-Bench 91.9%）
- **GLM-5.2 质量惊艳**，用户评价"无限接近 Fable 5"，价格仅 Opus 零头
- **Opus 4.8 存在质量问题**："bug 率高于 4.7"，"忽略明确指令"
- **Sonnet 5 用户体验差**："不遵守命令"，"陷入无休止的反驳循环"
- **DeepSeek V4 Pro API 7 月后异常**："幻觉增多"，"频繁 400 错误"

---

## 核心优化策略

### 1. 工具输出截断（收益：60-89% token，但不损失关键信息）

**问题**：工具输出是最大 token 浪费源
- 读 500 行文件 → 5000 token，实际只需 10 行
- 测试日志完整累积（通过测试、进度条、冗余格式）

**方案**：
- 实现 smart 截断（**保留错误上下文，避免质量损失**）
- 实现 summarizer（bash → exitCode + errors only）
- 每个工具配置 maxBytes/maxLines

### 2. Per-Model Prompt（节省 15-20%，提升指令遵循）

**差异**：
- Claude Opus/Sonnet：强推理，需简洁 prompt
- GPT：结构化偏好，需明确步骤
- Grok/DeepSeek/GLM：指令遵循弱，需详细说明 + few-shot

### 3. 上下文驱逐（CWL 策略，支持 8000 万 token 会话无质量下降）

**问题**：小窗口模型（Sonnet 20 万）容易爆满

**方案**：
- 保留：用户回合 + 最近 N 轮
- 驱逐：已持久化动作（文件已写入）
- **避免摘要压缩**（会丢失因果结构，影响质量）

### 4. Repo-Map（借鉴 Aider，节省 30-40%，保持代码理解）

**原理**：
- tree-sitter 提取符号（函数、类签名）
- PageRank 对文件重要性排序
- 只发送 top-k 完整内容，其余用符号签名

---

## 质量保障措施

1. **测试覆盖率 >80%**：每个优化功能必须有单元测试
2. **质量门禁**：Phase 4 验证，质量下降 >3% 则回退
3. **保守截断**：smart 策略保留所有错误上下文
4. **独立审查**：code_review 阶段使用不同模型交叉验证
5. **Fallback 机制**：低质量模型失败自动降级到高质量模型

---

## 实施计划

### Phase 1: 基础设施（2 周）

**新建**：tool-output-manager.ts, schema-enhancer.ts  
**修改**：types.ts, model-profile-registry.ts  
**任务**：截断、summarizer、schema 增强、启用别名、单元测试

### Phase 2: Prompt 和 Context（3 周）

**新建**：3 个 prompt 模板、context-evictor.ts、repo-map-builder.ts  
**修改**：context-builder.ts, package.json  
**任务**：per-model prompt、上下文驱逐、repo-map、单元测试

### Phase 3: Runtime 集成（2 周）

**修改**：runtime-adapter.ts, default-config.ts  
**任务**：集成全部策略、配置 8 个 profiles、端到端测试

### Phase 4: 真实验证（1 周）

**任务**：准备测试任务、baseline 测量、optimized 测量、**质量门禁**、对比

---

## 模型选择矩阵（基于真实用户反馈）

| 阶段 | 首选 | Fallback 1 | Fallback 2 | 原因 |
|------|------|-----------|-----------|------|
| Planning | **Fable 5** | **GPT-5.6-sol** | GLM-5.2 | Fable 长周期最强，Sol agent 第一 |
| Plan Review | **GPT-5.6-sol** | **Fable 5** | GLM-5.2 | Sol 结构化验证强（91.9%） |
| Implementation | **GLM-5.2** | Grok 4.5 | Terra | GLM "接近 Opus 但零头价格" |
| Code Review | **Fable 5** | **GPT-5.6-sol** | GLM-5.2 | **质量最关键** |
| Simple Repair | Grok 4.5 | GLM-5.2 | Terra | 速度 + 成本 |
| Complex Repair | **GPT-5.6-sol** | **Fable 5** | GLM-5.2 | Sol "跟进更好" |

**为什么 Opus/Sonnet/DeepSeek 降级？**
- **Opus 4.8**：用户反馈"bug 率高于 4.7"，"忽略明确指令"，token 消耗大
- **Sonnet 5**：投诉"不遵守命令"，"陷入无休止的反驳循环"
- **DeepSeek V4 Pro**：7 月后"API 异常，幻觉增多"，仅用于批量非关键任务

**推荐配置（你的定位 - 平衡质量和成本）**：
```
Planning: Fable 5（最强推理）
Plan Review: GPT-5.6-sol（结构化验证第一）
Implementation: GLM-5.2（接近 Opus 质量，零头价格）
Code Review: Fable 5（质量关键）
Simple Repair: Grok 4.5（速度 + 性价比）
成本：~35-45%（相对全 Opus），质量接近顶级
```

---

## 验收标准

**Phase 4 质量门禁（必须满足）**：
- ✅ 任务通过率 ≥ baseline（目标 +5-10%）
- ✅ 质量评分 ≥ baseline - 0.3/10
- ✅ Token 节省 40-60%
- ✅ 至少 2 个任务对比原厂 CLI 质量有优势

**如果不满足**：回退到质量优先配置（全 Opus/Sonnet）

---

## 实施规则

- **TDD**：先写测试，再实现
- **质量优先**：任何优化导致质量下降 >3%，立即回退
- **渐进式**：按 Phase 顺序执行
- **测试隔离**：使用 fake provider，禁止调用真实模型
- **Token 预算**：Phase 1-3 各 50-80K token

---

## 停止条件

遇到以下情况停止并报告：
1. 现有 workflow 接口实质性变更
2. 同一测试连续两次修复无效
3. tree-sitter 集成失败且无降级方案
4. **优化导致质量下降 >3% 且无法修复**
5. 需要修改核心 provider 层（超出范围）

---

**开始实施**: 完整阅读设计文档后，从 Phase 1 Task 1.1 开始。记住：**质量第一，token 效率第二，成本第三**。
