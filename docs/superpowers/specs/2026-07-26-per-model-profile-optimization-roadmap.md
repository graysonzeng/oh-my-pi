# ModelProfile 深度优化计划：质量优先的渐进式演进

- 日期：2026-07-26
- 状态：设计方案
- 范围：L
- 设计作者：Claude (Fable-5)
- 基于：近期 per-model 功能开发进展分析与外部最佳实践调研
- 关联文档：
  - `docs/superpowers/specs/2026-07-25-per-model-optimization-design.md`
  - `docs/superpowers/specs/2026-07-25-per-model-optimization-p0-p2-design.md`
  - `docs/research/2026-07-25-per-model-optimization-user-feedback.md`

---

## 0. 执行摘要

### 判断

近期 per-model 优化的主干已经落地（commit e699c6f8b），包括 P0-P2 的核心 seam、ModelProfile 类型系统、默认路由矩阵、工具输出管理和上下文策略。**这不是 greenfield 项目，而是已有系统的测量、补缝与深化阶段。**

### 当前进展（事实）

| 能力域 | 实现状态 | 证据 |
|--------|----------|------|
| ModelProfile 类型与注册表 | ✅ Done | `types.ts`, `model-profile-registry.ts` |
| 质量优先默认路由矩阵 | ✅ Done | `default-config.ts` 8 个目标模型 profile |
| PromptStrategy（style/thinking/roleEmphasis） | ✅ Done | `applyPromptStrategy` 接线 |
| ToolStrategy（truncation/summarization） | ✅ Done | 生产路径经 `session.workflowToolOptimization` |
| ContextStrategy（eviction/repoMap/utilization） | ✅ Done | `applyContextStrategyEviction` |
| OutputStrategy（schema enhancement/strictMode） | ✅ Done | `enhanceSchemaForProfile` |
| Workflow benchmark 骨架 | ✅ Done | `workflow/benchmark/` fixtures + runner |
| Availability preflight 设计 | ✅ Reviewed | 已通过 Claude review（PASS_WITH_NOTES） |

### 关键缺口（Gap Matrix 总结）

| 能力 | 状态 | 影响 |
|------|------|------|
| fewShotPolicy/instructionFormat | Typed-not-wired | P2：未接线字段无收益 |
| retryOnSchemaViolation 统一流程 | Typed-not-wired | P1：配置存在但不生效 |
| maxConcurrentTools | Typed-not-wired | P2：并发控制未实际应用 |
| contextPolicy vs contextStrategy | 语义重叠 | P1：需决策统一路径 |
| read 工具摘要合同 | 质量风险 | **P0**：正文归零破坏工具合同 |
| 端到端测量 harness | Missing | **P0**：无法验证优化收益 |
| Tool optimization receipt | Missing | P1：有损摘要不可恢复 |
| Availability preflight | Missing | P0：运行前无可用性诊断 |
| Stage handoff 确定性 | Missing | P1：跨角色信息丢失 |

### 核心洞察

**来自外部最佳实践和用户反馈的三大共识**：

1. **质量 > 压缩率**：静默有损压缩会通过重试/重读把"省下的 token"吐回去（Claude Code #32099、RTK README 警告）
2. **可恢复 > 激进摘要**：任何丢失的信息必须可一跳恢复（Claude Code #10727、#24976）
3. **分桶测量 > 总数**：system/schema/history/tool-result/cache 必须分开报告才能调优（Aider #2491、Hermes #33002）

**最值得深度打磨的 ModelProfile 维度**（按杠杆排序）：

1. **ToolStrategy**：bash/test/git 输出卫生是最高共识杠杆（RTK 60-90% bash 输出、Kilo #5848）
2. **ContextStrategy.eviction**：role-aware 阶段边界压缩，避免中途静默丢失（Claude Code #28559）
3. **OutputStrategy.retryOnSchemaViolation**：分层修复减少昂贵重试（当前未接线）
4. **PromptStrategy**：per-model style 适配（已接线但可深化 few-shot）

---

## 1. 近期开发进展总结

### 1.1 已落地功能（代码证据）

#### Phase A：类型系统与 Profile 注册（✅ Complete）

```typescript
// packages/coding-agent/src/workflow/types.ts
export interface ModelProfile {
  promptStrategy?: PromptStrategy;      // style/thinking/roleEmphasis
  toolStrategy?: ToolStrategy;          // truncation/summarization/concurrency
  contextStrategy?: ContextStrategy;    // eviction/repoMap/utilization
  outputStrategy?: OutputStrategy;      // schema enhancement/retry
  presentationPolicy?: {...};           // lazy tool/skill loading (P2)
  retryPolicy: {...};                   // fallback chain
}
```

- 8 个目标模型的默认 profile：Fable-5, Opus-4.8, Sonnet-5, GPT-5.6-sol, GPT-5.6-terra, Grok-4.5, GLM-5.2, DeepSeek-v4-pro
- 质量优先路由：plan/review 首选 Fable/Sol，implement 首选 GLM/Grok（成本敏感）
- Fallback chain：每个关键角色至少 2 个候选 profile

#### Phase B：Strategy Seam 接线（✅ Partial）

| Strategy | 实现落点 | 接线状态 |
|----------|----------|----------|
| PromptStrategy | `prepareWorkflowInvocation` → `applyPromptStrategy` | ✅ style/thinking/roleEmphasis |
| ToolStrategy.truncation | `DEFAULT_TRUNCATION_RULES` | ✅ bash/read/grep/test |
| ToolStrategy.summarization | `session.workflowToolOptimization` | ✅ 生产路径 |
| ToolStrategy.aliases | `workflow-alias-wrap` + session fields | ✅ tool/argument aliases |
| ContextStrategy.eviction | `applyContextStrategyEviction` | ✅ CWL-inspired |
| ContextStrategy.repoMap | `repo-map-builder` | ✅ regex（非 tree-sitter） |
| OutputStrategy.schemaEnhancement | `enhanceSchemaForProfile` | ✅ addDescriptions/strictMode |

**未接线字段**（Typed-not-wired）：
- `fewShotPolicy.dynamicSelection`
- `retryOnSchemaViolation.maxRetries`（有类型但无重试环）
- `maxConcurrentTools`（无 runtime 消费）
- `contextPolicy` vs `contextStrategy` 双面均未完整驱动内容选择

#### Phase C：测量与质量门禁（🚧 Partial）

```typescript
// packages/coding-agent/src/workflow/benchmark/
- fixtures.ts          // 固定任务定义
- runner.ts            // A/B 执行器
- types.ts             // BenchmarkCase/Report 合同
```

**已有但待补全**：
- ✅ Attempt 级 usage artifact
- ✅ Routing audit 日志
- ✅ Budget ledger
- ❌ Token 分桶（system/schema/history/tool-result/cache）
- ❌ Duration/latency 分解
- ❌ Retry/fallback 次数统计
- ❌ Compression receipt（原始 bytes → 可见 bytes + recovery URI）
- ❌ Scope metrics（planned vs actual changed files）

#### Phase D：生产接线（✅ Done - commit e699c6f8b）

```bash
$ git show e699c6f8b --stat | head -20
feat(coding-agent): wire P0-P2 per-model optimization into production

 packages/agent/src/agent-loop.ts                   | 268 +++++++-
 packages/coding-agent/src/workflow/engine.ts       | 176 ++++-
 packages/coding-agent/src/workflow/prompt-assembly.ts | 129 ++++
 packages/coding-agent/src/workflow/scope-metrics.ts   | 224 +++++++
 packages/coding-agent/src/workflow/stage-handoff.ts   | 222 +++++++
 packages/coding-agent/src/workflow/structured-output-repair.ts | 352 ++++++++++
 packages/coding-agent/src/workflow/tool-output-manager.ts | 283 ++++++--
```

**关键新增**：
- `optimization-receipt.ts`：工具优化凭证
- `presentation-policy.ts`：惰性 tool/schema 加载
- `prompt-assembly.ts`：稳定前缀构建
- `scope-metrics.ts`：范围遵循度量
- `stage-handoff.ts`：角色边界确定性传递
- `structured-output-repair.ts`：分层 schema 修复

### 1.2 架构决策记录

| 决策 | 理由 | 影响 |
|------|------|------|
| 移除 `codex_cli`/`claude_cli` runtime | 多模型统一走 embedded + provider models | workflow 不再分发到原厂 CLI |
| `contextPolicy` vs `contextStrategy` | Strategy=运行时优化，Policy=产物是否进入 | 需统一消费路径 |
| 质量优先路由 | Plan/review 关键阶段禁止静默降级 | 默认 fail-closed |
| Availability preflight 方案 V-B | 运行级全候选探测 | start/resume 前可见所有 profile 可用性 |

---

## 2. 外部最佳实践调研

### 2.1 工具输出卫生（最高共识杠杆）

#### RTK (Reduce Token Kosts)

**来源**：https://github.com/rtk-ai/rtk

**核心机制**：
- CLI 输出拦截与压缩（npm/pip/docker/git 等常见命令）
- 进度条、spinner、详细日志自动过滤
- 保留关键信号：exit code、error messages、最终结果

**实测收益**：
- bash/CLI 类输出可减少 60-90%（官方声明）
- Kilo discussion #5848：作者称 2 周约 10M tokens / ~89% 节省
- **重要警告（RTK README）**：节省会在 system/history/output 中稀释，不等于账单 -89%

**对 omp 的启示**：
- 优先强化 bash/test/git summarizer（内建，不依赖外部 proxy）
- 成功指标必须拆分：tool-result tokens（P1）vs 总会话 tokens（参考）
- 保留失败诊断完整性：exit code、首个失败块、尾部错误、失败测试名

#### Kilo #5848 用户反馈

**痛点**：
- "测试输出占用大量上下文，但大部分是 passing tests 的重复信息"
- "npm install 的详细日志对 AI 无价值，但占几千行"

**用户期望**：
- 失败优先：只展示失败的测试/步骤
- 摘要优先：200 个测试 pass → "200 tests passed"
- 可展开：需要时能看到完整输出

### 2.2 Repo-map 与代码库导航

#### Aider Repo-map

**来源**：https://aider.chat/docs/repomap.html

**机制**：
- Tree-sitter 符号提取（函数/类/方法签名）
- PageRank 图排序（基于调用/导入关系）
- 默认 budget ~1k tokens

**价值主张**：
- "减少无目标的 read 操作"
- "提供代码库方向感，不替代精确文件读取"

**omp 现状**：
- 当前使用 regex extraction（`repo-map-builder.ts`）
- 设计决策：只有测量证明 regex map 是质量瓶颈时才升级 tree-sitter

### 2.3 上下文驱逐与长会话管理

#### CWL (Conversational Workflow Language)

**来源**：arXiv:2606.11213, https://github.com/Kiz8-Team/pi-cwl

**核心概念**：
- Typed episodes（user query/tool result/agent response 结构化边界）
- 依赖图（episode 间的因果关系）
- 确定性驱逐（基于依赖图的最小保留集）

**论文数据**：
- 89 个顺序任务，~80M tokens
- 准确率无明显下降 vs 独立 session

**omp 现状**：
- `context-evictor` 是 CWL-inspired，但**不是**完整 CWL
- 无 episode delimiter 注解
- 无显式依赖图
- 简化驱逐：保留最近 N 轮 + 用户轮 + persisted artifacts

**设计决策**：完整 CWL 作为方案 B，触发条件是简化 eviction 被证明是质量瓶颈

#### Cursor Router

**来源**：https://cursor.com/blog/router (2026-07-22)

**机制**：
- 三档位：Intelligence / Balance / Cost
- 在线 A/B 测试选择最优模型
- 对用户透明且可覆盖

**收益声明**（Vendor claim）：
- A/B 测试：~60% 成本节省 vs 单一 frontier 模型
- Enterprise early access：30-50% vs all-Opus 定价

**对 omp 的启示**：
- 用户需要显式目标档位（quality_critical / balanced / cost_sensitive）
- 路由应可解释且可覆盖
- **不能**把厂商数字直接当 omp KPI（不同 baseline、不同任务分布）

### 2.4 用户反馈核心痛点（Claude Code GitHub Issues）

| Issue | 主题 | 痛点 | 对 omp 的约束 |
|-------|------|------|---------------|
| #10727 | 压缩可见性 | 自动压缩丢失关键上下文，用户希望预览/批准 | **可恢复 > 激进摘要** |
| #24976 | 多 agent 上下文爆炸 | Subagent 结果占 97.5% 上下文，触硬上限 | Tool/subagent result 需分桶、可文件化 |
| #25388 | 中途压缩 | 任务中途突然压缩，无预警 | **阶段边界压缩**，避免静默 compact |
| #28559 | Role-aware retention | 通用压缩丢失角色关键状态 | Planner/implementer/reviewer 保留策略应不同 |
| #32099 | 重复成本 | 压缩丢掉 subagent 结果 → 重跑付双倍 | **净成本 = 节省 - 返工** |
| Aider #2491 | Token 诊断 | 只看总 token 无法调优 | 需 system/schema/history/tool/cache 分桶 |

**收敛的产品原则**：
1. **质量优先**：省的是无效 token，不是信息
2. **可恢复**：摘要应带 artifact 指针
3. **可见可控**：压缩时机应在阶段边界，对用户可见
4. **分桶测量**：tool/context/total 分开才能调参

---

## 3. ModelProfile 深度优化维度分析

### 3.1 ToolStrategy：最高杠杆维度

#### 为什么优先级最高

1. **外部共识最强**：RTK (60-90% bash 输出)、Kilo #5848、Claude Code 多个 issues
2. **立即生效**：不需要改模型、不需要训练，直接减少噪音输入
3. **质量可控**：正确实现下不伤害模型推理（保留关键信号）
4. **omp 已有基础**：`tool-output-manager.ts` 已有 summarizer 骨架

#### 当前实现分析

```typescript
// packages/coding-agent/src/workflow/tool-output-manager.ts
export const DEFAULT_SUMMARIZERS = {
  bash: bashSummarizer,
  read: readSummarizer,
  grep: grepSummarizer,
  test: testSummarizer,
  ls: listSummarizer,
  '*': genericSummarizer,
};
```

**关键问题**（来自用户反馈研究）：
- `readSummarizer` 当前只返回路径、行数、字节数 → **正文归零破坏工具合同**
- 摘要不可恢复 → 模型看不到刚读的文件 → 重复 read 或错误推理
- bash 失败输出可能只保留匹配 `error|fail` 的行 → 丢失 root cause context

#### 深度打磨方向

**P0：可恢复的有损摘要**

```typescript
export interface ToolOptimizationReceiptV1 {
  tool: string;
  transform: 'truncate' | 'summarize' | 'compress';
  originalBytes: number;
  originalLines: number;
  visibleBytes: number;
  visibleLines: number;
  sha256: string;  // 原始输出 hash
  omittedRanges?: Array<{start: number, end: number}>;
  recoveryUri?: string;  // artifact:// URI to full output
  reversible: boolean;
}
```

**合同**：
- 任何丢失正文的 transform 必须先保存原文到 artifact
- 模型可见文本保留 `[Full output: artifact://<id>]`
- Summarizer 必须保留已有 `artifact://` footer（不能二次删除）

**P0：失败诊断完整性**

Bash/test 失败时必须保留：
- Exit code
- 首个失败块（完整 stack trace 或 assertion）
- 尾部错误（最后 N 行）
- 失败测试名
- 可见重现命令

**P1：噪音过滤智能化**

借鉴 RTK 思想，内建识别与压缩：

| 输出类型 | 噪音特征 | 保留策略 |
|----------|----------|----------|
| 测试通过 | 200 passing tests 列表 | "200 tests passed" + 失败明细 |
| npm install | 依赖树、fetch logs | Exit code + final summary + errors |
| Git status | Untracked files 长列表 | 分类计数 + 前 N 个 + "... and X more" |
| Progress bar | `[=====>   ] 67%` | 最终状态或移除 |
| Docker build | Layer hash、cache hits | Final image ID + errors |

**P2：Per-model 截断阈值**

```typescript
// default-config.ts 示例
const glm_implementer_tool: ToolStrategy = {
  outputTruncation: {
    rules: [
      { toolName: 'bash', maxBytes: 3500 },  // GLM 作为 implementer，可承受更多 tool output
      { toolName: 'read', maxBytes: 5500 },
    ],
  },
};

const claude_reviewer_tool: ToolStrategy = {
  outputTruncation: {
    rules: [
      { toolName: 'bash', maxBytes: 4000 },  // Reviewer 更关注精简 diff
      { toolName: 'read', maxBytes: 6000 },
    ],
  },
};
```

**测量指标**：
- Tool-result token 减少率（相对 baseline）
- 重复 read/grep 同一文件次数
- Schema retry 因缺少上下文的比率
- 用户手动展开 artifact 的频率

### 3.2 ContextStrategy：阶段边界智能驱逐

#### 为什么重要

**用户痛点**（Claude Code #25388, #28559）：
- 任务中途静默压缩，无预警
- 通用压缩不区分角色关键状态
- Planner 的决策约束、implementer 的 patch、reviewer 的 findings 不应被同等对待

#### 当前实现分析

```typescript
// contextStrategy 已有 eviction 配置
eviction: {
  enabled: boolean;
  preserveUserTurns: boolean;
  evictPersisted: boolean;
  keepRecentN: number;
}
```

**缺口**：
- 驱逐时机：当前是 token 触顶时触发，不在阶段边界
- 驱逐策略：通用 LRU，不 role-aware
- 可见性：用户看不到驱逐发生和内容

#### 深度打磨方向

**P1：Stage-boundary role-aware handoff**

```typescript
export interface StageHandoffV1 {
  fromStage: WorkflowStatus;
  toStage: WorkflowStatus;
  preservedItems: Array<{
    kind: 'plan' | 'finding' | 'patch' | 'verification';
    artifactId: string;
    summary: string;
    bytes: number;
  }>;
  omittedArtifactIds: string[];
  recoveryUris: string[];
  bytesBeforeHandoff: number;
  bytesAfterHandoff: number;
}
```

**阶段传递策略**（确定性，非模型摘要）：

| From → To | 保留 | 可驱逐 |
|-----------|------|--------|
| Planning → Implement | 目标、约束、非目标、决策、受影响文件、验收标准 | 调研过程、探索性 read |
| Implement → Review | Plan 引用、changed files、patch、commands/tests 结果 | 中间态代码、重复 read |
| Review → Repair | 所有 blocking findings、相关文件/行、失败验证 | 已解决 findings、通过验证 |

**关键原则**：
- 只在 stage 成功结束后构造 handoff
- 不在 stage 中途静默压缩
- P1 阶段不增加模型摘要调用（确定性提取）
- 持久化原 artifact，不删除（可随时恢复）

**P2：Context policy 统一决策**

**当前问题**：`contextPolicy` 与 `contextStrategy` 语义重叠

**决策**（与现有设计对齐）：
- `contextStrategy`：运行时优化（utilization、eviction、repoMap、toolHistory）
- `contextPolicy`：产物是否进入上下文（includePlan/Review/Verification/FullTranscript）
- 冲突时：`contextStrategy.artifactInclusion` 优先于 `contextPolicy.maxArtifactBytes`
- 迁移路径：新配置只写 `contextStrategy.artifactInclusion`；`contextPolicy` 保留只读兼容

**测量指标**：
- Stage handoff 后 context bytes 减少率
- Blocking finding 被错误驱逐的次数（应为 0）
- 用户请求"恢复 plan"或"为什么没有遵循计划"的频率

### 3.3 OutputStrategy：分层 Schema 修复

#### 为什么重要

**问题**：
- Schema violation 时立即发起昂贵的模型重试
- 很多违例可通过确定性修复（去 BOM、提取 JSON、类型转换）
- `retryOnSchemaViolation.maxRetries` 已配置但未接线

#### 当前实现分析

```typescript
// types.ts 已定义
retryOnSchemaViolation?: {
  enabled: boolean;
  maxRetries: number;
  includeErrorInRetry: boolean;
}

// 但当前路径：structured artifact 解析失败 → 直接 WorkflowSchemaError
// 无 profile-aware 重试环
```

#### 深度打磨方向

**P1：统一分层修复流程**

```
原始输出
  ↓
[Layer 1] 确定性清理
  - 去 BOM/零宽字符
  - 提取 Markdown fence 内 JSON
  - 单个完整 JSON object 定位
  ↓ (成功) → Canonical validator
  ↓ (失败)
[Layer 2] Budget 检查
  - Request budget (maxRequests)
  - Cost budget (maxCostUsd)
  - Time budget (maxRuntimeMs)
  ↓ (有余量)
[Layer 3] 模型 retry
  - 注入 violation 描述
  - Schema 摘要
  - 上一输出有界片段或 artifact URI
  - 最多 1 + maxRetries 次总调用
  ↓ (耗尽)
[Layer 4] Schema error with full receipt
```

**关键约束**：
- 确定性修复**不得**补造缺失字段、猜枚举或宽松类型转换
- `maxRetries=0` → 最多 1 次调用（初次）
- `maxRetries=1` → 最多 2 次调用（初次 + 1 retry）
- Retry prompt 移到静态 `.hbs.md`，不在代码内拼接

**Per-model retry 策略调优**

不同模型的 schema 遵循能力不同，应按实测数据调整：

| Profile | 初始 maxRetries | 调优依据 |
|---------|-----------------|----------|
| Claude (Fable/Opus) | 2 | Schema 遵循强，但偶尔 verbose wrapper |
| GPT (Sol/Terra) | 1 | Strict mode 下遵循好，重试边际收益低 |
| Grok | 3 | Schema 遵循相对弱（secondary 反馈），需更多重试 |
| GLM | 2 | 平衡值，待实测调整 |

**测量指标**：
- Schema violation 初次成功率（按模型）
- Retry 后成功率（按 retry 次数）
- 每次成功的平均成本增加
- Layer 1 确定性修复成功率

### 3.4 PromptStrategy：风格适配与 Few-shot

#### 为什么相对优先级较低

1. **已接线基础功能**：style/thinking/roleEmphasis 已生效
2. **边际收益不确定**：Few-shot 可能增加 token 而无质量提升
3. **依赖测量**：必须先有 benchmark 证明某 vendor schema 弱才加 few-shot

#### 当前实现分析

```typescript
// 已接线
- systemPromptTemplate: 'concise-claude' | 'structured-gpt' | 'explicit-grok'
- thinkingPrompt: { enabled, style }
- roleEmphasis: 'light' | 'medium' | 'heavy'

// 未接线（typed-not-wired）
- fewShotPolicy: { enabled, maxExamples, dynamicSelection }
- instructionFormat: 'natural' | 'numbered' | 'xml-tagged'
```

#### 深度打磨方向

**P2：Few-shot 静态库（仅当需要时）**

```typescript
// 仅当 benchmark 显示某 vendor 在 schema/指令遵循上明显弱时
fewShotPolicy: {
  enabled: true,
  maxExamples: 2,
  dynamicSelection: false,  // P2 不做动态检索，用静态库
}

// 示例存放在 prompts/few-shot/plan-artifact-example-1.md
// 仍用 .md 文件，不在代码内拼接
```

**P2：instructionFormat 接线**

根据模型偏好调整指令格式：
- Claude：自然语言（已默认）
- GPT：编号列表（structured-gpt 已用）
- Grok：编号 + 更多显式边界标记

**测量指标**：
- Schema 首次成功率提升
- Instruction following score（需人工或 LLM-as-judge 评估）
- Token 成本增加（few-shot 的代价）

---

## 4. 完整优化方案：四阶段渐进路线

### 4.1 Phase 1：质量底座与测量基础设施（P0）

**目标**：确保优化不伤害质量，建立可重复测量能力

#### 1.1 可恢复的工具输出优化

**任务**：
1. 修复 `read` 摘要合同
   - 移除正文归零式摘要
   - 保留原有 range/offset 和有界截断
   - 所有有损 transform 先保存原文到 artifact
   - 模型可见文本保留 `[Full output: artifact://<id>]`

2. 增强 bash/test summarizer
   - 失败时保留：exit code、首个失败块、尾部错误、失败测试名、重现命令
   - 成功时压缩：200 passing → "200 tests passed"
   - 保留已有 `artifact://` footer（不二次删除）

3. 实现 ToolOptimizationReceiptV1
   - 记录：tool、transform、original/visible bytes/lines、sha256、omitted ranges、recovery URI
   - 接线到 `session.workflowToolOptimization`
   - Artifact 写入通过 adapter 注入（算法层不依赖 storage）

**验收**：
- 所有有损 fixture 的关键事实可直接看到或一跳恢复
- 恢复内容 hash 与 receipt 一致
- 覆盖：成功、失败、timeout、UTF-8、超长单行、多段错误

**工期**：2-3 天

#### 1.2 固定任务 Benchmark 与指标分桶

**任务**：
1. 定义 10+ 固定任务
   - 单文件修复（bug fix）
   - 多文件实现（feature）
   - 调查/规划（research → plan）
   - Code review
   - 长会话（multi-turn implementation）

2. 实现 paired A/B runner
   - Baseline vs optimized 使用相同 case/commit/input
   - 每类至少重复 3 次（LLM 非确定性）
   - 固化：repo commit、任务夹具版本、provider/model 实际解析、profile fingerprint

3. 指标分桶报告
   - **精确测量**：system/tool-schema/history/repo-map/tool-result/context-evicted bytes
   - **Provider 事实**：input/output/cache tokens、cost（若存在）
   - **推算**：明确标注 estimated tokens（bytes/4）
   - **Unknown**：TTFT、queue time 等不可观测字段为 `null`

4. 质量指标
   - 首次通过率、最终通过率
   - Schema retry 次数
   - Provider fallback 次数
   - 工具调用数、重复 read/grep 同一文件
   - Patch 测试通过、范围遵循、无关改动

**验收**：
- Fake runtime paired smoke 可重复
- 真实模型未跑时明确标记 "live quality unknown"
- 报告区分：事实、精确测量、推算、unknown

**工期**：5-7 天

#### 1.3 Availability Preflight 实现

**任务**：
1. 新增 `WorkflowAvailabilityPort`
   - 专用 probe seam，不用正式 `RuntimePort.run()` 伪造
   - 仅 embedded 路径：走真实模型解析与鉴权链
   - 原厂 CLI runtime 已移除，不做 CLI executable probe

2. 候选集合构建
   - 候选真源是 `ModelRouter` profile registry
   - `singleStep=true`：仅当前 invocation 可能调用的角色
   - 完整运行：从当前状态可达的全部角色
     - `required`：确定会经过的角色
     - `conditional`：仅 review changes、repair、循环分支可能进入

3. Probe 执行
   - 最小文本请求、独立 deadline、记录 latency
   - 同一次 preflight 内相同 runtime/model/auth-scope 去重
   - 结果逐 profile 展开

4. 报告合同
   ```typescript
   interface WorkflowAvailabilityReport {
     runId: string;
     timestamp: string;
     profiles: Array<{
       profileId: string;
       role: WorkflowRole;
       status: 'available' | 'unavailable' | 'indeterminate';
       actualProvider?: string;  // 仅成功时
       actualModel?: string;     // 仅成功时
       latencyMs?: number;       // 仅成功时
       errorKind?: string;       // 仅失败时
       errorSummary?: string;    // 仅失败时
     }>;
   }
   ```

5. 生命周期接线
   - `start`：创建后、返回前执行 preflight
   - `resume(singleStep=true)`：仅探测本次可能调用的 profiles
   - `resume(singleStep=false)`：探测可达的所有 profiles
   - Required role 无可用路由时不开 attempt、明确报错

**验收**：
- Tool 合同测试
- Engine 生命周期测试
- Router + engine 集成测试（无可用路由时 fail-closed）

**工期**：3-4 天

**Phase 1 里程碑**：
- ✅ 工具输出有损摘要可恢复
- ✅ 固定任务集 baseline 可重复测量
- ✅ Availability preflight 上线
- ✅ 质量门禁：pass rate ≥ baseline

---

### 4.2 Phase 2：优化流程与输出质量（P1）

**前提**：Phase 1 完成，有 baseline 数据

#### 2.1 Stage-boundary Role-aware Handoff

**任务**：
1. 实现确定性 `StageHandoffV1`
   - 从现有 typed artifacts 提取 preserved items
   - 记录 omitted artifact IDs、recovery URIs、bytes before/after
   - 只在 stage 成功结束后构造
   - 不在 stage 中途静默压缩

2. Per-role 保留策略
   - Planner→Implementer：目标、约束、决策、受影响文件、验收标准
   - Implementer→Reviewer：plan 引用、changed files、patch、commands/tests
   - Reviewer→Repair：blocking findings、相关文件/行、失败验证

3. 持久化与传递
   - P1 不增加模型摘要调用（确定性提取）
   - 持久化原 artifact，不删除
   - Handoff artifact 进入下一 stage context

**验收**：
- Blocking finding、失败 verification、patch 引用不可因预算被裁掉
- 相同输入产生确定性字节输出
- 所有 recovery URI 可读

**工期**：4-5 天

#### 2.2 结构化输出分层修复

**任务**：
1. 统一修复流程
   - Layer 1：确定性清理（去 BOM、提取 fence 内 JSON、定位单个 object）
   - Layer 2：Budget 检查（request/cost/time）
   - Layer 3：模型 retry（最多 `1 + maxRetries` 次）
   - Layer 4：返回含全部 attempt receipt 的 schema error

2. Retry prompt 静态化
   - 移到 `prompts/workflow/schema-retry.hbs.md`
   - 注入：violation、schema 摘要、上一输出有界片段或 artifact URI
   - 不在代码内拼接

3. 确定性修复约束
   - **不得**补造缺失字段
   - **不得**猜枚举值
   - **不得**宽松类型转换

4. 统一 seam
   - Embedded、Codex CLI、Claude CLI 使用同一 validator/repair
   - Per-profile `maxRetries` 生效

**验收**：
- Fenced JSON/BOM/外围说明零模型调用修复
- 语义错误不被伪修复
- `maxRetries=0/1/2` 最多调用 `1/2/3` 次
- 各层成功率分开统计

**工期**：3-4 天

#### 2.3 Scope Adherence Metrics

**任务**：
1. 实现 `ScopeMetricsV1`
   ```typescript
   interface ScopeMetricsV1 {
     plannedFiles: string[];
     changedFiles: string[];
     unplannedFiles: string[];
     forbiddenFiles: string[];
     deletedFiles: string[];
     diffLines: number;
     touchedPackages: string[];
     scopeCreepFindings: Array<{file: string, reason: string}>;
     userCorrections?: number;
     userRollbacks?: number;
     status: 'adhered' | 'warning' | 'violation';
   }
   ```

2. 数据来源
   - Planned files 来自 plan artifact 与 benchmark allowlist
   - Actual changes 来自隔离 worktree git diff（不相信模型自报）
   - Forbidden path 或 readonly write 为 hard violation
   - Unplanned file 默认 warning，由 reviewer 判断必要派生

3. 集成
   - Scope artifact 进入 benchmark quality gate
   - "测试通过但无关改动更多"的 variant 可被区分

**验收**：
- Forbidden path 写入被检测
- Unplanned but necessary files（如生成的 types）不误报
- Scope creep 与 review findings 关联

**工期**：2-3 天

**Phase 2 里程碑**：
- ✅ Stage handoff 信息不丢失
- ✅ Schema retry 流程统一且可测量
- ✅ Scope adherence 可量化
- ✅ Tool-result token 相对 baseline 下降 ≥30%（P1 目标调整）

---

### 4.3 Phase 3：成本与延迟优化（P2）

**前提**：Phase 2 完成，质量指标稳定

#### 3.1 Lazy Tool/Schema/Skill Presentation

**任务**：
1. 复用 `xd://` discovery 协议
   - 不创建第二套 discovery 机制
   - 高频关键工具直接暴露完整 schema
   - 低频工具只给短描述 + `xd://<tool>` 可一跳读取

2. Skill catalog
   - Skill 初始只注入名称/短描述
   - Autoload 或显式读取时加载全文
   - Presentation 顺序稳定

3. `WorkflowPresentationPolicy`
   ```typescript
   presentationPolicy: {
     enabled: boolean;
     mode: 'direct' | 'catalog';
     essentialTools: string[];    // 始终完整 schema
     skillCatalogOnly: boolean;   // Skill 初始只目录
   }
   ```

4. Feature flag
   - 默认关闭
   - Benchmark 质量不退且净 token/延迟改善才考虑默认开启

**验收**：
- Essential tools 完整 schema 可见
- Non-essential tools 可一跳展开
- Restricted workflow child 只看到 allowlist 工具
- Presentation 顺序稳定

**工期**：3-4 天

#### 3.2 Cache-friendly Stable Prefix

**任务**：
1. Prompt assembly receipt
   ```typescript
   interface PromptAssemblyReceiptV1 {
     stableSha256: string;      // 固定部分 hash
     dynamicSha256: string;     // 动态部分 hash
     stableBytes: number;
     dynamicBytes: number;
     sectionOrder: string[];
     providerCacheReadTokens?: number;   // Provider 报告
     providerCacheWriteTokens?: number;  // Provider 报告
   }
   ```

2. 固定顺序
   - Static system prompt
   - Role/profile policy
   - 稳定排序的 tool presentation
   - Skill catalog
   - 动态：assignment/repo-map/handoff/history

3. 避免不稳定元素
   - Workflow ID、attempt ID 不进入 stable prefix
   - 时间戳、随机 artifact ID 不进入
   - 实时 budget 不进入

4. 测量
   - Hash 相同不等于 provider cache 命中
   - 真实收益仅由重复 benchmark 判定（需多次运行相同任务）

**验收**：
- 相同 profile/task 的 stable prefix hash 一致
- Provider cache metrics 正确收集（若可用）
- Stable/dynamic 分界清晰

**工期**：2-3 天

#### 3.3 依赖与预算感知并发

**任务**：
1. 复用 agent loop 的 shared/exclusive scheduler
   ```typescript
   interface ToolSchedulingPolicy {
     maxConcurrentTools: number;
     remainingToolCalls?: number;
     remainingStageTimeMs?: number;
     resourceConflictMode: 'serialize' | 'fail';
   }
   ```

2. 并发规则
   - Exclusive 保持现有屏障语义
   - Shared 仅在 cap 内且无资源写冲突时并发
   - 同路径 write/edit/patch 和可能修改工作区的 bash 不并发
   - 只读相同资源可并发，结果按原 tool-call 顺序写回

3. 预算管理
   - 启动 batch 前预留 tool-call budget
   - Abort/skip 必须释放 reservation
   - 不构建通用 DAG，不跨 turn 推断隐式依赖

**验收**：
- Cap=1/2/N 正确限制并发
- Shared→exclusive→shared 转换正确
- 同文件写操作串行
- Budget 只剩一次调用时正确处理
- Abort 释放 reservation

**工期**：3-4 天

**Phase 3 里程碑**：
- ✅ Lazy loading 减少初始 prompt size
- ✅ Cache hit rate 提升（相同任务重复运行）
- ✅ Tool 并发提升吞吐（不伤质量前提）
- ✅ 单任务成本相对 baseline 下降（方向性，不承诺具体百分比）

---

### 4.4 Phase 4：深化与自适应（触发式）

**触发条件**：Phase 1-3 数据证明需要

#### 4.1 完整 CWL（仅当简化 eviction 是瓶颈）

**触发条件**：
- 长会话质量下降可归因于错误驱逐/摘要幻觉
- 简化 eviction 导致关键依赖被错误删除
- Benchmark 证明 episode delimiter + 依赖图有显著收益

**任务**：
- Episode delimiter 注解
- 依赖图构建（user query → tool → response）
- 基于依赖图的确定性驱逐

**工期**：10+ 天（大重构）

#### 4.2 Tree-sitter + PageRank Repo-map

**触发条件**：
- Regex map 导致错误文件选择或明显多余 read
- Benchmark 对比 regex vs tree-sitter 有质量差异

**任务**：
- Tree-sitter 符号提取
- PageRank 图排序
- 与现有 repo-map 接口对齐

**工期**：5-7 天

#### 4.3 在线学习路由（产品决策）

**触发条件**：
- 离线 scorecard 稳定运行 3+ 个月
- 显式档位（quality_critical/balanced/cost_sensitive）已验证
- 产品决定启用自适应路由

**任务**：
- 实时反馈收集（质量、成本、延迟）
- 模型能力档位映射自动更新
- Fallback guard（质量下限保护）

**工期**：20+ 天（需 A/B 测试基础设施）

**Phase 4 特点**：
- 非必须项，触发式深化
- 每项需独立立项评估
- 不在 P0-P2 承诺范围

---

## 5. 成功标准与测量体系

### 5.1 质量门禁（P0 - 必须满足）

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| 任务通过率 | ≥ baseline（不得下降） | 固定任务集 A/B，≥3 次重复 |
| 关键阶段质量 | Plan/code_review 不因降级掉点 | 路由审计 + 人工抽检 |
| 信息召回 | 有损摘要的关键事实可一跳恢复 | Receipt 完整性测试 |
| Blocking finding 保留 | Review→Repair handoff 不丢 | Stage handoff 合同测试 |
| Availability preflight | 每次 start/resume 前完成 | 生命周期集成测试 |

**退出机制**：单变量 paired benchmark 的 pass rate 下降 >3pp → 回滚该优化

### 5.2 优化效果指标（P1/P2）

#### Token 优化（分桶报告）

| Token 桶 | P1 目标 | P2 目标 | 测量依据 |
|----------|---------|---------|----------|
| Tool-result | -30% ~ -50% | -40% ~ -60% | Per-tool bytes before/after |
| Context (stage) | -20% ~ -40% | -30% ~ -50% | Stage handoff bytes reduction |
| Schema/system | 稳定或微降 | -10% ~ -20% (lazy loading) | Prompt assembly receipt |
| Total session | 方向性下降 | -25% ~ -45% | 精确测量 + 推算 |

**重要**：不承诺总会话固定百分比；RTK/Cursor Router 数字不可直接迁移

#### 质量提升指标

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| Schema violation 率 | -30% ~ -50% | Violation / attempts |
| 重复 read 同一文件 | -20% ~ -40% | Tool call 去重统计 |
| Scope creep (无关改动) | -30% ~ -50% | Scope metrics 违规文件数 |
| User correction/rollback | 方向性下降 | 需用户交互数据（长期） |

#### 成本与延迟

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| 单任务成本 | 方向性下降 | Pricing × usage；baseline 对比 |
| Provider cache hit | +20% ~ +40% (P3) | Cache read tokens / total input |
| TTFT (首 token 延迟) | 稳定或微降 | Provider metadata（若可用） |
| 并发工具吞吐 | +30% ~ +60% (P3) | Wall time vs serial baseline |

### 5.3 测量基础设施要求

#### Benchmark Runner 必须提供

```typescript
interface BenchmarkReport {
  // 固化上下文
  suiteVersion: string;
  repoCommit: string;
  timestamp: string;

  // 每个 case
  cases: Array<{
    caseId: string;
    variant: 'baseline' | 'optimized' | string;
    repetition: number;

    // 质量
    passed: boolean;
    testsPassed: number;
    testsFailed: number;
    scopeStatus: 'adhered' | 'warning' | 'violation';

    // Token（精确测量）
    systemBytes: number;
    schemaBytes: number;
    historyBytes: number;
    repoMapBytes: number;
    toolResultBytes: number;
    contextEvictedBytes: number;

    // Token（推算或 provider 报告）
    estimatedInputTokens: number;   // 标注为 estimated
    providerInputTokens?: number;   // 若可用
    providerOutputTokens?: number;
    providerCacheReadTokens?: number;

    // 成本与延迟
    costUsd?: number;
    durationMs: number;
    ttftMs?: number;
    modelTimeMs: number;
    toolTimeMs: number;

    // 优化凭证
    toolOptimizationReceipts: ToolOptimizationReceiptV1[];
    stageHandoffs: StageHandoffV1[];
    schemaRetries: number;
    providerFallbacks: number;

    // 实际运行环境
    resolvedProvider: string;
    resolvedModel: string;
    profileId: string;
  }>;

  // 汇总
  summary: {
    baselinePassRate: number;
    optimizedPassRate: number;
    qualityDelta: number;  // 正值=提升，负值=下降
    tokenReductionPct: number;
    costReductionPct?: number;
  };
}
```

#### 对比报告格式

Benchmark runner 输出清晰对比：

```markdown
## Task: multi-file-feature-implementation (repetition 3/3)

| Metric | Baseline | Optimized | Delta |
|--------|----------|-----------|-------|
| **Quality** |
| Pass rate | 87% | 89% | +2pp ✅ |
| Tests passed | 45/50 | 47/50 | +2 |
| Scope violations | 2 | 0 | -2 ✅ |
| **Token (measured)** |
| Tool-result bytes | 125,430 | 68,240 | -46% ✅ |
| Context bytes | 89,200 | 64,100 | -28% ✅ |
| Total estimated tokens | ~53,600 | ~33,100 | -38% ✅ |
| **Provider (actual)** |
| Input tokens | 51,234 | 32,890 | -36% |
| Cache read tokens | 0 | 12,340 | +12k |
| Output tokens | 8,450 | 8,620 | +2% |
| Cost | $2.34 | $1.52 | -35% ✅ |
| **Performance** |
| Duration | 245s | 238s | -3% |
| Schema retries | 3 | 1 | -2 ✅ |
| Tool calls | 67 | 58 | -13% ✅ |
| Duplicate reads | 8 | 3 | -63% ✅ |
```

**判断**：✅ 通过（质量不退、token/成本明显下降）

---

## 6. 风险与缓解

### 6.1 质量风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 有损摘要丢失关键信息 | 中 | 高 | **P0 可恢复合同**；关键事实召回测试 |
| Stage handoff 驱逐 blocking finding | 低 | 高 | 确定性提取；合同测试保证不丢 |
| 激进截断导致模型误判 | 中 | 中 | A/B 门禁；保留失败诊断完整性 |
| Schema retry 耗尽 budget | 低 | 中 | Budget 检查在 retry 前；per-profile 调优 |

### 6.2 工程风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Benchmark 任务集不代表真实场景 | 中 | 中 | 多样化任务类型；长期收集真实案例 |
| Provider token/cost 报告不可用 | 高 | 低 | 用 estimated + 明确标注；不阻塞实施 |
| 不同模型 baseline 差异大 | 高 | 中 | Per-profile paired 对比；不跨模型比 |
| 优化收益模型间差异大 | 高 | 低 | 分别报告；不追求统一百分比 |

### 6.3 产品风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 用户期望总会话 -70% | 中 | 中 | 诚实文档；只承诺 tool-result P1 目标 |
| 压缩可见性需求未满足 | 中 | 中 | Phase 2 stage handoff 提供边界可见性 |
| 路由降级未被察觉 | 低 | 高 | Availability preflight + routing audit |
| 成本节省不及预期 | 高 | 低 | 方向性目标；不承诺固定百分比 |

---

## 7. 依赖与前置条件

### 7.1 代码依赖

| 组件 | 状态 | 需求 |
|------|------|------|
| `workflow/types.ts` | ✅ | ModelProfile 完整类型 |
| `workflow/model-profile-registry.ts` | ✅ | Profile 注册与规范化 |
| `workflow/default-config.ts` | ✅ | 8 个目标模型 profiles |
| `workflow/tool-output-manager.ts` | ✅ | Summarizer 骨架 |
| `workflow/benchmark/` | ✅ | Fixtures + runner 骨架 |
| `agent/src/agent-loop.ts` | ✅ | Tool scheduling seam |

### 7.2 基础设施依赖

| 需求 | 状态 | 备注 |
|------|------|------|
| 固定测试 repo（多种规模） | 🚧 | 需准备或复用现有 |
| Provider credentials（8 个模型） | △ | 按可用性测试；unavailable → skip |
| Artifact storage | ✅ | 已有 workflow artifact 系统 |
| Usage tracking | ✅ | 已有 attempt usage artifact |

### 7.3 团队技能依赖

| 技能 | 需求级别 | 备注 |
|------|----------|------|
| TypeScript + Bun | 熟练 | 项目标准栈 |
| Workflow 架构理解 | 熟悉 | 需读既有 engine/runtime 代码 |
| LLM 行为调优经验 | 了解 | Prompt/schema 适配 |
| 统计 A/B 测试 | 了解 | Benchmark 结果解读 |

---

## 8. 实施时间线与里程碑

### 8.1 总体时间线

```
Phase 1 (P0)：质量底座           [Week 1-2]  ████████░░░░░░░░░░░░
Phase 2 (P1)：优化流程           [Week 3-4]  ░░░░░░░░████████░░░░
Phase 3 (P2)：成本延迟           [Week 5-6]  ░░░░░░░░░░░░░░░░████
Phase 4 (触发式)：深化           [按需]      ░░░░░░░░░░░░░░░░░░░░

总计：6-8 周完成 P0-P2；Phase 4 触发式启动
```

### 8.2 详细里程碑

#### Week 1-2: Phase 1（质量底座）

**Week 1**
- Day 1-2：修复 read 摘要合同 + 实现 ToolOptimizationReceiptV1
- Day 3-4：增强 bash/test summarizer + 可恢复性测试
- Day 5：定义 10+ 固定任务集

**Week 2**
- Day 1-3：实现 paired A/B runner + 指标分桶
- Day 4-5：Availability preflight 实现
- 里程碑验收：
  - ✅ 所有有损摘要可恢复
  - ✅ Baseline 数据可重复测量
  - ✅ Preflight 生命周期测试通过

#### Week 3-4: Phase 2（优化流程）

**Week 3**
- Day 1-3：Stage-boundary handoff 实现
- Day 4-5：Per-role 保留策略 + 持久化

**Week 4**
- Day 1-2：结构化输出分层修复
- Day 3-4：Scope adherence metrics
- Day 5：Phase 2 benchmark run + 验收
- 里程碑验收：
  - ✅ Handoff 信息完整性测试通过
  - ✅ Schema retry 统一流程上线
  - ✅ Tool-result token -30%+ (P1 目标)

#### Week 5-6: Phase 3（成本延迟）

**Week 5**
- Day 1-2：Lazy tool/schema/skill presentation
- Day 3-4：Cache-friendly stable prefix
- Day 5：Prompt assembly receipt 实现

**Week 6**
- Day 1-3：依赖与预算感知并发
- Day 4-5：Phase 3 benchmark run + 最终验收
- 里程碑验收：
  - ✅ Lazy loading 减少初始 prompt
  - ✅ Cache hit rate 数据收集
  - ✅ 单任务成本方向性下降

### 8.3 关键决策点

| Week | 决策点 | 判断标准 | Go/No-Go |
|------|--------|----------|----------|
| Week 2 末 | Phase 1 → Phase 2 | Baseline 可重复 + 质量门禁通过 | 必须 Go |
| Week 4 末 | Phase 2 → Phase 3 | Tool-result token -30%+ + pass rate ≥baseline | Pass rate < baseline → 回滚 |
| Week 6 末 | Phase 3 完成 | 总体目标达成 + 无 P0 退化 | 可上线 |
| Week 6+ | 触发 Phase 4 | 测量证明需要 + 独立立项 | 产品决策 |

---

## 9. 长期演进方向

### 9.1 从静态配置到能力档位

**当前**（静态）：
```typescript
// 按模型 ID 硬编码 profile
profiles: [
  { id: 'claude_planner', modelPattern: ['claude-fable-5', ...] },
  { id: 'gpt_planner', modelPattern: ['gpt-5.6-sol', ...] },
]
```

**未来**（能力档位）：
```typescript
// 按能力档位定义要求
capabilities: {
  quality_critical: {
    minBenchmarkScore: 85,
    maxCostUsd: null,  // 不设上限
    maxLatencyMs: null,
    allowDegradation: false,
  },
  balanced: {
    minBenchmarkScore: 75,
    maxCostUsd: 1.5,
    maxLatencyMs: 180_000,
    allowDegradation: true,
  },
  cost_sensitive: {
    minBenchmarkScore: 65,
    maxCostUsd: 0.5,
    maxLatencyMs: null,
    allowDegradation: true,
  },
}

// 模型 → 档位的映射由 benchmark 数据驱动
modelCapabilityMap: {
  'claude-fable-5': ['quality_critical', 'balanced'],
  'gpt-5.6-sol': ['quality_critical', 'balanced'],
  'glm-5.2': ['balanced', 'cost_sensitive'],
}
```

**收益**：
- 模型版本更新时不需要重写所有 profile
- 新模型上线后跑 benchmark 自动归类
- 用户可显式选择档位而非模型 ID

### 9.2 从离线 Benchmark 到在线反馈

**当前**（离线）：
- 固定任务集
- 开发者手动运行
- 结果用于调整默认配置

**未来**（在线）：
- 真实用户任务采样
- 自动收集质量/成本/延迟
- 周度聚合报告
- 异常检测与告警

**触发条件**：
- 离线 benchmark 稳定运行 3+ 月
- 用户同意数据收集
- 产品决策启用

### 9.3 从单次优化到持续学习

**Phase 1-3**（本方案）：
- 一次性优化
- 固定策略
- 手动调优

**Phase 4+**（长期）：
- 持续测量
- 策略自适应
- 异常自动回滚

**示例**：
```typescript
// 自动调整 tool truncation 阈值
if (duplicateReadRate > 0.3 && passRate >= baseline) {
  profile.toolStrategy.outputTruncation.rules[0].maxBytes *= 1.2;
  scheduleRevalidation();
}
```

---

## 10. 总结与行动建议

### 10.1 核心洞察

1. **per-model optimization 不是 greenfield**
   - 主干已落地（commit e699c6f8b）
   - 这是测量、补缝与深化阶段

2. **质量 > 压缩率**
   - 外部一致反馈：有损压缩会通过重试吐回 token
   - 可恢复合同是 P0，不是 nice-to-have

3. **分桶测量 > 总数承诺**
   - Tool-result、context、total 必须分开
   - RTK 89%、Cursor Router 30-60% 不可直接当 omp KPI

4. **最高杠杆维度：ToolStrategy**
   - Bash/test/git 输出卫生
   - 外部共识最强（RTK、Kilo、Claude Code issues）
   - 立即生效，质量可控

### 10.2 立即行动（Week 1）

**优先级 1**：
- [ ] 修复 `read` 摘要合同（正文归零破坏工具合同）
- [ ] 实现 `ToolOptimizationReceiptV1`
- [ ] 定义 10+ 固定任务集

**优先级 2**：
- [ ] 增强 bash/test summarizer（保留失败诊断完整性）
- [ ] 实现 paired A/B runner 骨架

### 10.3 成功定义

**6-8 周后应达成**：
- ✅ 质量门禁：任务通过率 ≥ baseline
- ✅ Tool-result token 相对 baseline 下降 30%+
- ✅ 有损摘要 100% 可恢复
- ✅ Stage handoff 关键信息不丢失
- ✅ Availability preflight 上线
- ✅ 端到端测量体系建立

**不承诺**：
- ❌ 总会话 token 固定百分比（-40~70%）
- ❌ 成本绝对值（模型定价变化快）
- ❌ 与厂商数字（Cursor Router）直接对比

### 10.4 下一步

1. **技术评审**：本方案提交团队评审，确认范围与时间线
2. **资源分配**：确保 Week 1-2 有专人投入（不被其他任务打断）
3. **启动 Phase 1**：从修复 read 摘要合同开始
4. **周度同步**：每周五复盘进度与质量门禁

---

## 附录 A：术语表

| 术语 | 定义 |
|------|------|
| ModelProfile | 包含 prompt/tool/context/output 四大策略的模型配置 |
| ToolStrategy | 工具输出截断、摘要、别名、并发控制 |
| ContextStrategy | 上下文驱逐、repo-map、utilization 管理 |
| OutputStrategy | Schema 增强、retry 策略 |
| Stage handoff | 阶段边界的确定性信息传递 |
| Availability preflight | 运行前的模型可用性探测 |
| Tool optimization receipt | 有损摘要的凭证（原始 bytes、recovery URI） |
| Paired A/B | 相同任务在两种配置下重复运行对比 |
| Quality gate | 质量门禁：pass rate 不得低于 baseline |
| Token bucket | Token 分桶：system/schema/history/tool-result/cache |

## 附录 B：参考文献

1. RTK (Reduce Token Kosts): https://github.com/rtk-ai/rtk
2. Kilo discussion #5848: https://github.com/Kilo-Org/kilocode/discussions/5848
3. Aider repo-map: https://aider.chat/docs/repomap.html
4. CWL paper: arXiv:2606.11213
5. Cursor Router: https://cursor.com/blog/router
6. Claude Code issues: #10727, #24976, #25388, #28559, #32099
7. Aider issue #2491: Token breakdown request
8. 内部设计文档：
   - `docs/superpowers/specs/2026-07-25-per-model-optimization-design.md`
   - `docs/superpowers/specs/2026-07-25-per-model-optimization-p0-p2-design.md`
9. 内部研究文档：
   - `docs/research/2026-07-25-per-model-optimization-user-feedback.md`
   - `docs/research/2026-07-25-per-model-optimization-evidence.md`

---

**文档完成**

- 日期：2026-07-26
- 作者：Claude (Fable-5)
- 审核状态：待评审
- 下一步：提交技术评审 → 确认资源 → 启动 Phase 1
