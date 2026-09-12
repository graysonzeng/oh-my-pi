# Design: Per-Model Optimization for oh-my-pi

- Date: 2026-07-25
- Status: Revised (v2.1) — Phase A/B 主路径已实现；availability preflight 设计已通过 Claude review（PASS_WITH_NOTES）
- Scope: L
- design_author: gpt
- prior_revision_author: grok（v2.0；v2.1 availability preflight 由 GPT 起草、主 agent 机械落盘）
- supersedes: 同路径 v1.0（社区调研稿；含重复 §4、过时“未实现”表述与夸大收益）

证据附录：`docs/research/2026-07-25-per-model-optimization-evidence.md`

---

## 0. 执行摘要

**判断**：v1 方向正确（工具输出卫生、repo-map、上下文驱逐、per-model prompt/schema、质量优先路由），但文档已严重落后于代码，且把「CLI 输出压缩」「vendor A/B」「论文完整 CWL」混写成 omp 可承诺的全局收益。

**现状（事实）**：`packages/coding-agent` 已落地类型、默认 profiles、runtime 接线与单测骨架。下一步不是再写一遍 greenfield 实现，而是 **测量 → 修缝 → 小步加深**。

**推荐路径**：方案 A「Stabilize & Measure」（见 §4），并采用方案 V-B「运行级全候选 availability preflight」。质量优先；token/成本为 P1/P2，且必须相对 omp baseline 测量后再调默认路由。

---

## 1. 设计目标与范围

### 1.1 要解决的问题

同一模型下，omp workflow harness 仍可能把噪音工具输出、过长上下文、未适配的 prompt/schema 策略喂给模型，导致：

1. 质量波动（指令遵循差、schema 失败、误读噪音）
2. token/成本浪费（尤其 bash/test/git 类输出）
3. 小窗口模型更容易触顶失败
4. workflow 在执行到具体 stage 后才发现模型、凭证或 CLI runtime 不可用；调用者无法在每次 start/resume 前看到逐 profile 的真实可用性、实际解析模型和延迟

### 1.2 成功标准

| 优先级 | 标准 | 测量方式 |
|--------|------|----------|
| P0 | 固定任务集通过率不低于优化前 baseline；理想 +5pp 内提升 | 同任务集 A/B（optimized on/off 或 strategy 开关） |
| P0 | 关键阶段（plan / code_review）不因自动降级到低质量模型而掉点 | 路由审计日志 + 人工抽检 |
| P1 | **工具输出相关** token 相对 baseline 下降 40%+ | per-tool result bytes/tokens |
| P1 | schema violation 率下降（相对 baseline） | violation / attempts |
| P2 | 单任务 $ 成本下降（相对全 frontier 路由） | pricing × usage；目标量级参考 Cursor Router 的 30–50% enterprise 区间，**非承诺** |
| P0 | 每次 workflow start/resume 在 stage attempt 或状态迁移前完成本次运行候选 profile 的 availability preflight | tool 合同测试 + engine 生命周期测试 |
| P0 | 调用者逐项获得 `available/unavailable/indeterminate`、实际 runtime/provider/model、live probe latency ms 和安全失败分类 | preflight report 合同测试 |
| P0 | required role 无可用路由时不开 attempt、不执行 stage；fallback 可用时显式 degraded | router + engine 集成测试 |

### 1.3 本次范围（v2 文档指导的后续工程）

- 以现有 `ModelProfile` strategy 字段为 SSOT，补齐 **未接线** 缝
- 建立可重复的 token/质量测量 harness
- 强化 bash/test/git 类 summarizer（借鉴 RTK 思想，内建而非依赖外部 proxy）
- 理清 `contextPolicy` vs `contextStrategy`
- 文档与默认路由矩阵与 `default-config.ts` 对齐
- 增加 run-scoped model/profile availability preflight、逐项诊断报告及其失败/降级/成本/安全语义

### 1.4 非目标

- 不重写已存在的 truncation / schema-enhancer / prompt style / regex repo-map / eviction 主干
- 不在未测量前承诺「总 token −40~70%」或「准确率 +10~20%」
- 不默认上完整 CWL（episode delimiter + 依赖图）或 tree-sitter PageRank
- 不把外部 CLI（Claude Code / Codex / Grok Build）行为改造成 omp 责任范围之外的兼容层大修
- 不把配置中的 `vendor`、`modelPattern` 或 runtime 默认值冒充 live probe 得到的实际 provider/model
- 不复用或暴露 auth-gateway 的 raw credential 组装路径；workflow probe 只能通过当前 session/runtime 的既有鉴权边界

---

## 2. 背景与约束

### 2.1 产品定位

- **质量第一**：plan / code_review 优先强模型；implement 在可接受质量下再压成本
- **Harness 优势**：同一模型上，靠上下文与工具卫生超过「裸原厂 CLI 默认堆上下文」
- **允许 trade-off**：仅当质量跌幅可测且可接受时，换取显著成本下降（阈值默认：质量跌 >3pp 则回滚该路由/策略）

### 2.2 必须遵守的仓库约束

- Prompts 静态 `.md` + Handlebars；禁止代码内拼 prompt
- 无 `any` / 无 inline import；`bun check` 而非 `tsc`
- coding-agent 禁止 `console.log` 污染 TUI
- Worker / CLI 约定见根 `AGENTS.md`

### 2.3 根因分析

- **不需要**产品故障根因分析。本修订是设计评审 + 证据校正 + 与代码对齐。
- 适用前提：v1 把「调研灵感」写成了「待实现规格」，而实现已大部分完成。

---

## 3. 证据基线（社区 / 学术 / 厂商）

标签：**Fact** / **Vendor claim** / **Secondary** / **Hypothesis**

| 主题 | 结论 | 标签 | 对 omp 的含义 |
|------|------|------|----------------|
| RTK / Kilo #5848 | CLI 输出压缩可砍 **bash 类输出** 60–90%；作者称两周约 89%/10M | Fact + 作者自述 | 优先强化 tool summarizer；**不要**写成总会话 −89% |
| RTK README | 节省会在 system/history/output 中稀释；token≈bytes/4 | Fact | 成功指标拆成 tool / context / total |
| Aider repo-map | 官方 tree-sitter + 图排序；默认 map ~1k tokens | Fact | 现有 regex map 可继续用；升级 tree-sitter 需任务失败证据 |
| CWL arXiv:2606.11213 | 完整 CWL：typed episodes + 依赖图 + 确定性驱逐；论文称 89 任务 / 80M tokens | Fact（论文主张） | 当前 eviction ≠ 完整 CWL；深化前先测量 |
| Cursor Router (~2026-07-22) | A/B 约 60%；enterprise early access 约 30–50% vs all-Opus | Vendor claim | 路由有价值；数字不可直接抄成 omp KPI |
| Fable 5 / Sol / Opus / GLM | 次级评测与博客共识：Fable 偏硬任务；Sol 偏 terminal/agent 成本；GLM 开源强但更费 token | Secondary | 路由矩阵 **测量门禁**；修正 v1 的 128k/20万 等硬编码窗口断言 |
| 「Sonnet 不遵守命令」 | Claude Code 指令忽略跨模型常见（GH issues） | Fact（现象） / Secondary（归因到 Sonnet5） | 不可单独作为 Sonnet 降级证据 |
| GLM「零头价格≈Opus」 | 独立笔记：token 用量可 ~3.3×，净成本约 ~½ Opus | Secondary | 修文案；implement 仍可优先 GLM，但期望值要诚实 |

详细链接见证据附录。

---

## 4. 方案对比

### 4.1 方案 A — Stabilize & Measure（推荐）

- **思路**：承认主干已落地；补缝、测 baseline、用数据调 profile/路由；小步加强 summarizer。
- **优点**：风险低、与代码一致、最快产生可辩护收益数字。
- **缺点**：短期不会有「完整 CWL / 真 PageRank」叙事。
- **前提**：能跑固定任务集 + token 计数。

### 4.2 方案 B — Deep CWL + tree-sitter 立刻上

- **思路**：按论文级 episode 图 + tree-sitter/PageRank 重做上下文层。
- **优点**：长期上限高，更接近学术/Aider 完整形态。
- **缺点**：工期与回归面大；可能优化尚未证明是瓶颈的层。
- **前提**：方案 A 证明 regex map / 简化驱逐是质量或 token 瓶颈。

### 4.3 选型结论

选择 **方案 A**。方案 B 列为测量触发的可选 Phase D。

### 4.4 Workflow availability preflight 方案

#### 方案 V-A — 当前路由按需探测

- 只探测当前 stage 的首选 profile；失败后按 router 顺序探测 fallback。
- 优点：模型调用数和启动延迟最低。
- 缺点：不能在执行前逐项报告本次运行所有可能使用的 profile，也不能提前暴露未来必经角色无可用路由。

#### 方案 V-B — 运行级全候选探测（推荐）

- `start`：创建 workflow 后、返回调用者前，对完整运行的可达角色/profile 做 readiness preflight；保持“创建但不执行 stage”的现有语义。
- `resume(singleStep=true)`：只探测本 invocation 实际可能调用的当前 stage profiles；若本步仅做状态迁移或 deterministic verify，则报告 `not_required`，不产生模型调用。
- `resume(singleStep=false)`：探测从当前状态可达的所有模型角色及其 profile 候选；未来分支 profile 标记为 `conditional`。
- 同一次 preflight 内对相同 runtime/model/auth-scope 的物理 probe 去重，结果仍逐 profile 展开。

选择 **V-B**，因为新增需求明确要求“本次运行可能使用的模型/profile”逐项可见。额外延迟和成本通过最小 probe、并发上限、无重试和 invocation 内去重控制。

### 4.5 选型边界

- availability 是时间点诊断，不是后续 stage 成功保证；probe 后到正式调用之间仍存在 TOCTOU。
- 实际 stage 若发生 retryable provider failure，继续使用既有 fallback 机制，并在 routing audit 中记录与 preflight 的偏差。
- `probeOneModel` 仅作为语义参考：最小文本请求、独立 deadline、响应后记录 latency；不得直接复用其 raw API key/catalog candidate 路径。

---

## 5. 当前实现状态（Gap Matrix）

以 `packages/coding-agent/src/workflow/` 为准。

| 能力 | 状态 | 证据落点 | 备注 |
|------|------|----------|------|
| `PromptStrategy` style + roleEmphasis + thinking | **Done** | `prepareWorkflowInvocation` → `applyPromptStrategy` | |
| `fewShotPolicy` / `instructionFormat` | **Typed-not-wired** | types + default-config only | `applyPromptStrategy` 未读 |
| `ToolStrategy` 截断/摘要 | **Done** | session `workflowToolOptimization` → bash/read/grep | 生产路径靠 session，非 StructuredRunnerRequest 回调 |
| tool/argument aliases | **Done** | `workflow-alias-wrap` + session fields | v1「UNSUPPORTED」过时 |
| `maxConcurrentTools` | **Typed-not-wired** | types + default-config | 无 runtime 消费 |
| `OutputStrategy` schema 增强 / strictMode | **Done** | `enhanceSchemaForProfile`；adapter→`schemaMode` | |
| `retryOnSchemaViolation` / `outputPrefixPrompt` | **Typed-not-wired** | default-config 有值 | schema 失败直接 `WorkflowSchemaError`，无 profile 重试环 |
| `ContextStrategy` eviction / targetUtilization | **Done** | `applyContextStrategyEviction` | CWL-*inspired*；非 episode 图 |
| `contextStrategy.repoMap` | **Partial** | engine `#buildStageContext` → regex `repo-map-builder` | 非 tree-sitter |
| `artifactInclusion.include*` / `toolHistory` | **Typed-not-wired** | 仅 `maxArtifactBytes` 被读 | |
| `contextPolicy.include*` / `includeFullTranscript` | **Typed-not-wired** | ContextBuilder 按 stage 固定拼装 | 与 strategy include* 双面均未驱动内容选择 |
| 默认质量优先 profiles | **Done** | `default-config.ts` | 以代码为 SSOT |
| 端到端 token/质量测量 harness | **Missing** | — | 下阶段主线 |
| 完整 CWL delimiter / tree-sitter PageRank | **Missing** | — | 方案 B |
| start/resume 前 availability preflight | **Missing** | `WorkflowTool` / `WorkflowEngine` 无 probe seam | `start` 当前仅 create；`resume` 直接进入 run loop |
| profile 候选闭包与 required/conditional 分类 | **Missing** | `ModelRouter` 只做单次 resolve | 需复用同一注册顺序和 fallback/diversity 约束 |
| 实际 runtime/provider/model + latency 报告 | **Partial** | stage 结果已有 resolved provider/model | 仅正式执行后可见，无 preflight latency |
| run-scoped unavailable 集合 | **Partial** | `#withProfileFallback` 仅在单 stage 重试内维护 | preflight 结果尚不能驱动后续 stage 路由 |

接线审计补充（scout）：`RuntimeAdapter` 虽把 `processToolResult`/`transformTools` 放进 request，但 `productionRunner` **不**转发给 `runStructuredSubagent`——生产依赖 `session.workflowToolOptimization`。

**数据流（as-is）**：

```
ModelProfile (strategies)
  → prepareWorkflowInvocation
      → injectWorkflowPrompt / applyPromptStrategy
      → enhanceSchemaForProfile
      → applyContextStrategyEviction (+ contextPolicy byte cap)
      → session.workflowToolOptimization.processResult / aliases
  → embedded RuntimeAdapter → runStructuredSubagent (multi-model via provider models)
```

当前数据流中，profile 的 model pattern 在调用前可知，但实际 provider/model 只有 embedded runtime 成功返回后才能确认。Workflow 不再分发到原厂 CLI（`codex_cli` / `claude_cli` 已移除）。

---

## 6. 详细方案（仅剩余增量）

### 6.1 核心思路

把 per-model optimization 从「功能清单」改成 **控制面**：

1. **Strategy 已存在** → 保证每个字段要么接线，要么从公开配置中删除/标记 inert
2. **测量面** → 每个 workflow 产出 tool/context/total token 与通过/失败原因
3. **路由面** → 角色默认矩阵可配置；关键角色禁止静默掉到 T3
4. **加深面** → 只在测量证明瓶颈后升级 map/CWL

### 6.2 `contextPolicy` vs `contextStrategy`（决策）

**默认决策（直到产品另改）**：

- `contextStrategy`：运行时优化（utilization、eviction、repoMap、toolHistory）
- `contextPolicy`：产物是否进入上下文（includePlan/Review/Verification/FullTranscript）+ 兼容旧字段 `maxArtifactBytes`
- **冲突时**：`contextStrategy.artifactInclusion.maxArtifactBytes` 优先于 `contextPolicy.maxArtifactBytes`（与 `runtime-invocation.ts` 现行为一致）
- 后续迁移：新配置只写 `contextStrategy.artifactInclusion`；`contextPolicy` 保留只读兼容一层

### 6.3 工具输出卫生（增量）

在现有 `DEFAULT_SUMMARIZERS` / smart truncate 上：

- bash：优先保留 exit code、FAIL/ERROR 上下文；压缩通过测试清单与进度条（RTK 同类信号）
- 明确文档：该项优化目标是 **tool-result tokens**，不是总会话承诺
- 可选：提供 settings 开关 `workflow.toolOptimization.enabled`（默认 on）便于 A/B

### 6.4 Schema retry 缝（增量）

- **目标合同**：当 `outputStrategy.retryOnSchemaViolation.enabled` 时，structured artifact 解析失败可按 `maxRetries` 重试，并按 `includeErrorInRetry` 回灌错误
- **实现落点**：统一走 workflow runner / executor 的一处 seam，避免「配置存在但永不读取」
- **验收**：单测伪造 invalid JSON → 重试 N 次 → 最终成功或耗尽；断言读到了 profile 字段

### 6.5 Prompt few-shot（增量，低优先级）

- `fewShotPolicy.dynamicSelection` 今日多为 inert
- 仅当 schema/指令遵循测量显示某 vendor 弱时，再加 **静态** few-shot 库（仍用 `.md`），避免先做复杂检索

### 6.6 模型路由策略（临时，测量门禁）

以 `default-config.ts` 注册顺序/fallback 为真源。设计层只保留意图：

| 阶段 | 首选意图 | Fallback 意图 | 备注 |
|------|----------|---------------|------|
| Planning | Fable 系 / Sol | GLM | 硬推理优先 |
| Plan review | Sol / Fable | GLM | 结构化校验 |
| Implement | GLM / Grok | Terra | 成本敏感；接受更多 token 换单价 |
| Code review | Fable / Sol | GLM | 质量关键，禁止默认 DeepSeek |
| Simple repair | Grok / GLM | Terra | 速度 |
| Complex repair | Sol / Fable | GLM | |
| 超长上下文 | Terra / 大窗 Claude | Grok | 窗口数字以 catalog/provider 为准，不在设计写死 |

**软化 v1 绝对降级**：

- Opus/Sonnet：**可用备选**，不因次级吐槽从 registry 删除
- DeepSeek：默认远离关键路径（稳定性 Secondary 反馈），保留批量/非关键

### 6.7 不在此阶段做的加深项（触发条件）

| 项 | 触发 |
|----|------|
| tree-sitter + 真 PageRank | 固定任务集上 regex map 导致错误文件选择或明显多余 read |
| 完整 CWL delimiter | 长会话质量下降可归因于错误驱逐/摘要幻觉，且简化 eviction 不足 |
| 外部 RTK 依赖 | 内建 summarizer 达不到 tool-token P1，再考虑可选集成 |

### 6.8 Workflow availability preflight

#### 6.8.1 生命周期与原子边界

1. `start` 先创建 workflow id，再执行 readiness preflight，持久化并返回报告；不自动进入 planning。
2. `resume` 恢复 snapshot、budget、artifacts 和 routing context 后，在创建 stage attempt 或执行状态迁移前运行 preflight。
3. preflight 与首次 stage 运行受同一个 runner owner 排他边界保护；并发 resume 不能各自越过诊断门禁。
4. preflight 失败不得创建虚假 attempt。required role 无路由时，workflow 保持原状态并可稍后再次 resume。

#### 6.8.2 候选集合

- 候选真源是当前 engine 使用的 `ModelRouter` profile registry，不另维护模型清单。
- `singleStep=true` 仅包含当前 invocation 可能调用的模型角色。
- 完整运行包含从当前状态可达的全部模型角色；按状态图分为：
  - `required`：本次成功路径确定会经过的角色；
  - `conditional`：仅 review changes、repair 或循环分支可能进入的角色。
- 对每个可达角色包含所有可能因主 profile 不可用、vendor diversity、repair escalation 或 degraded policy 而被选中的 profile。
- 报告按 stage/role 顺序及 profile 注册顺序稳定排序，不受并发完成顺序影响。

#### 6.8.3 Probe seam

新增专用 `WorkflowAvailabilityPort`，不要用正式 `RuntimePort.run()` 伪造 schema artifact：

```text
WorkflowAvailabilityRequest
  profile + role + session + signal
    → embedded availability probe (RuntimeAdapter / provider resolve + auth)
    → WorkflowAvailabilityTargetResult
```

- 仅 **embedded** 路径：走当前 session 的真实模型解析与鉴权链；不得从 `profile.vendor` 推断成功。
- 原厂 CLI runtime（`codex_cli` / `claude_cli`）已从 workflow 移除；不在此做 CLI executable probe。
- `actualProvider`/`actualModel` 只能来自 runtime 响应元数据。成功响应缺少必要身份时结果为 `indeterminate`，不得回填配置值冒充实际值。
- probe prompt 存放于静态 `.md`；不包含用户 request、repo 内容、AGENTS 内容或历史 transcript。

#### 6.8.4 报告合同

每次 start/resume 返回：

```text
WorkflowAvailabilityReport
  invocationId, workflowId, operation, scope, checkedAt
  status: ready | degraded | blocked | not_required
  wallLatencyMs
  targets[]:
    role, requirement: required | conditional
    profileId
    status: available | unavailable | indeterminate
    runtime: embedded
    actualProvider?, actualModel?
    latencyMs
    source: live | shared_live
    failureKind?, safeReason?
    usage?, reportedCostUsd?
```

- `latencyMs` 是该物理 live probe 的单调时钟耗时；共享结果的各 profile 明确标记 `shared_live`。
- 未发出 live probe 的项目不得填写伪造 latency；应使用 `status=indeterminate` 和明确原因。
- tool 文本输出逐项展示 profile、状态、实际 provider/model 和毫秒延迟；结构化 `details` 保留完整报告。

#### 6.8.5 失败与降级

- required role 至少一个合规 profile 可用，且主 profile 可用：`ready`。
- required role 主 profile 不可用但 fallback 可用：`degraded`；将不可用 profile ids 注入本次 run 的 route options。
- required role 无合规 route，或 required target 身份无法确认：`blocked`，不开 attempt、不执行 stage。
- conditional role 全部不可用：报告 warning/degraded，但在该分支真正成为当前 stage 前不阻断。
- authentication、quota、configuration、provider permanent：本次 invocation 标记 unavailable，不重试 probe。
- timeout、rate limit、provider transient：同样不重试 probe；避免 preflight 放大流量，正式 resume 可稍后重新诊断。
- caller abort：取消所有未完成 probe，workflow 状态不因诊断取消而变成 stage failure。

#### 6.8.6 并发、超时与缓存

- 默认 `maxConcurrency=4`、单 target timeout `15_000ms`、整体 timeout `45_000ms`。
- 使用 caller signal、单 target timeout 和整体 timeout 的组合信号。
- 不做跨 start/resume 的正负结果缓存；“每次”均重新获得 live truth。
- 仅在单次 invocation 内按 effective runtime/model/auth-scope single-flight 去重；禁止跨 session 合并，以免混淆凭证和 provider 配置。
- overall timeout 时，未完成 target 统一为 `unavailable/timeout`；required 与 conditional 按上述门禁处理。

#### 6.8.7 成本与安全

- 每个物理 probe 最多输出 32 tokens，无工具、无 repo context、无模型重试。
- probe requests、usage 和 provider 报告的 cost 单独计入 diagnostic metrics；共享 probe 只计费一次。
- 已报告 probe cost 计入 workflow 总成本审计；provider 未返回 cost 时记录 `unknown`，不得按零处理。
- probe 不消耗 profile 的 stage `maxRequests`，避免改变既有 retry 合同，但必须受全局 preflight 请求数、timeout 和取消边界约束。
- workflow 层永不接收或持久化 raw API key、OAuth token、broker row 或完整 CLI stderr。
- 错误先经过 secret redaction，再输出受限的 `failureKind` 与截断后的安全原因；不输出绝对 executable 路径。

---

## 7. 实施计划（修订后）

### Phase A — 诚实基线与接线审计（约 1 周）

- [x] A1：策略字段 inert 审计表 → 接线或标注 Reserved / 默认关闭 fewShot
- [x] A2：attempt 级持久化 `usage` artifact（usage + toolCalls + strategies 快照）
- [ ] A3：10 个固定任务夹具（简单/中/难），optimized on/off 各跑一轮（可用 fake provider 测接线；真实模型测质量子集）
- [x] 验收：`bun test` workflow 包绿；usage 路径约定 = artifact kind `usage`

### Phase B — 补缝（约 1–2 周）

- [x] B1：接线 `retryOnSchemaViolation`
- [x] B2：bash summarizer 加强（progress/pass 剥离）+ 单测
- [x] B3：`contextPolicy`/`contextStrategy` 优先级 + include* 驱动 ContextBuilder + 测试
- [x] 验收：schema 重试合同测试通过；tool summarizer 合同更新

### Phase C0 — Availability preflight（路由调参前）

- [ ] C0.1：定义 availability request/result/report 与 dedicated runtime probe port
- [ ] C0.2：实现可达角色/profile 候选闭包及 required/conditional 分类
- [ ] C0.3：为 embedded、Codex CLI、Claude CLI 接入最小只读 live probe
- [ ] C0.4：在 start readiness 与 resume run gate 接线；报告返回 caller，并将 unavailable ids 注入 router
- [ ] C0.5：增加 invocation 内 single-flight、并发/timeout/cancel、成本与 secret-redaction 合同测试
- [ ] 验收：required profile 不可用时 attempt 数保持不变；fallback 时报告 degraded 且实际 route 与报告一致
- [ ] 验收：fake runtime 精确断言逐 target actual runtime/provider/model/latency；真实模型 latency 仅在授权 smoke 中采集

### Phase C — 路由与默认值调参（约 1 周，依赖真实模型预算）

- [ ] C1：按 Phase A 报告调整 `default-config` fallback / 角色首选
- [ ] C2：关键角色「禁止静默掉到 T3」策略（显式错误或停在同级）
- [ ] 验收：路由审计符合矩阵；质量 P0 不回退

### Phase D — 可选加深（仅触发）

- tree-sitter map 或完整 CWL（见 §6.7）

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 截断丢掉关键信号 | 任务失败 | smart + preservePatterns；失败夹具回归 |
| 过度驱逐 | 模型失忆 | 保留 user turns + keepRecentN；用量报告含 eviction |
| 把 vendor 数字当 KPI | 错误预期 | 指标必须 omp baseline 相对值 |
| 双配置面漂移 | 行为难解释 | §6.2 优先级 + 测试 |
| 未测就调路由 | 质量回退 | Phase C 门禁 |
| probe 放大启动延迟 | start/resume 体验下降 | 并发 4、invocation 内去重、45s overall deadline |
| probe 产生额外账单/限流 | 成本和可用额度下降 | 32-token 上限、无工具、无重试、独立 diagnostic usage |
| probe 成功后正式调用失败 | 误认为 availability 是保证 | 明确 point-in-time 语义；保留 stage fallback 和 divergence audit |
| 跨 session 缓存污染 | 使用错误凭证结论 | 禁止跨 invocation/session availability cache |
| 错误或 CLI 输出泄露 secret/path | 安全事故 | runtime 内鉴权、统一 redaction、只返回安全分类和 basename |

---

## 9. 成功指标（重写）

**禁止**：把 RTK 89%、Cursor 60%、Aider 4.2× 直接标成 omp 已达成。

| 指标 | Baseline | 目标 | 优先级 |
|------|----------|------|--------|
| 任务通过率 | 测量后填入 | ≥ baseline；争 +5pp | P0 |
| 人工/自动质量分 | 测量后填入 | 不下降 | P0 |
| Tool-result tokens | 测量后填入 | −40%+ | P1 |
| Schema violation 率 | 测量后填入 | 相对下降 | P1 |
| $/任务 vs 全 frontier | 测量后填入 | 方向性下降 | P2 |
| start/resume preflight 覆盖率 | 0 | 100% | P0 |
| required role 无路由后的 stage/attempt 启动数 | 测量后填入 | 0 | P0 |
| availability 报告身份完整率 | 测量后填入 | required targets 100%；否则 blocked | P0 |
| preflight wall latency | live smoke 后填入 | p50/p95 仅报告，不预设虚假目标 | P1 |
| diagnostic requests/tokens/cost | live smoke 后填入 | 逐 invocation 可审计；unknown 不记零 | P1 |

若任一质量 P0 回退超阈值（默认 3pp），回滚对应 strategy/路由变更。availability P0 任一违反则禁止启用执行门禁。

---

## 10. 开放问题（有默认，无 TBD）

| 问题 | Owner | 默认直到另决 |
|------|-------|--------------|
| 真实模型评测预算与任务集所有权 | 实现者 / 用户 | 先 fake+小样本真实；扩样需确认 |
| 是否允许依赖可选外部 RTK | 实现者 | 默认否，先内建 |
| Fable/GLM 官方 context 上限以谁为准 | catalog 维护 | `@oh-my-pi/pi-catalog` / provider 元数据，设计不写死 |
| start 是否自动执行 planning | 产品 | 默认否；保持 create-only，只增加 readiness report |
| availability 是否跨 invocation 缓存 | 产品 | 默认否；每次 start/resume live probe，仅 invocation 内去重 |
| 身份缺失但请求成功是否放行 | runtime 维护 | required target 默认 `indeterminate` 并阻断，不用配置值冒充 |
| conditional role 全不可用是否阻断 | workflow 维护 | 默认只 degraded/warn；分支成为当前 stage 后重新 probe 并门禁 |
| live probe timeout/concurrency | workflow 维护 | 默认 15s/target、45s overall、并发 4 |
| peer design gate | 主 agent | v2.1 已按 `author=gpt` 由 Claude 他审，结论 `PASS_WITH_NOTES`；实现需吸收 diagnostic usage 与 TOCTOU notes |

---

## 11. 参考资料

1. RTK: https://github.com/rtk-ai/rtk  
2. Kilo discussion: https://github.com/Kilo-Org/kilocode/discussions/5848  
3. Aider repo map: https://aider.chat/docs/repomap.html  
4. CWL: https://arxiv.org/abs/2606.11213  
5. Cursor Router: https://cursor.com/blog/router  
6. GLM-5.2: https://z.ai/blog/glm-5.2  
7. Claude Code instruction issues: https://github.com/anthropics/claude-code/issues/2901  
8. 仓内实现：`packages/coding-agent/src/workflow/{types,runtime-invocation,default-config,tool-output-manager,schema-enhancer,context-evictor,repo-map-builder,prompt-strategy}.ts`

---

## 12. 与 v1 的主要变更清单

1. 纠正「未实现 / UNSUPPORTED aliases」——改为 Gap Matrix  
2. Token 收益改为 **分项 + 待测**；删除不可辩护的总会话百分比承诺  
3. CWL / tree-sitter 降为可选加深  
4. 删除重复崩溃的 §4 profile 墙；默认配置以代码为准  
5. 软化模型排行榜绝对化措辞；修正 GLM/Fable 窗口与成本叙事  
6. 实施计划从「造轮子」改为「审计接线 + 测量 + 补缝」  
7. 方案对比明确推荐 Stabilize & Measure  
8. v2.1 新增 start/resume availability preflight：全候选 live probe、逐 profile 身份/延迟报告、路由门禁及成本安全语义

---

**文档结束（v2.1）**
