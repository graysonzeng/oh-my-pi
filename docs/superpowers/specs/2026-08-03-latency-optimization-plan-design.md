---
title: omp Latency Optimization Plan
Date: 2026-08-03
Status: 修订完成待评审 (round 2)
revision_round: 2
design_author: claude-opus-5 (xhigh)
design_author_identity: LatencyOptimizationPlanDesigner
reviewed_at: 2026-08-04
implementation_authorization: design-only
scope: M（跨 session/workflow 的延迟治理设计；不含实现）
---

# Design: omp Latency Optimization Plan

> 本文是从 round 1 完整稿恢复并按 round 1 集体评审逐项修订后的结构化设计。它只授权设计与评审，不授权修改代码、配置或发布。未来实现必须另获授权，并以 §3 的边界、§5 的顺序和 §6 的验收合同为准。

## 1. Background & Constraints

### 1.1 目标与成功定义

目标不是把所有耗时“隐藏”起来，而是降低普通长会话中可归因、可复现、可回滚的活跃延迟，同时保持方案评审、代码评审、质量门禁与取消语义不退化。

成功必须同时满足：

1. 复用现有 canonical owner；不建立第二套 context、并发、路由、评审、bash、eval 或后台执行引擎。
2. 方向 1/2/3/4/5 各自有独立 arm、开关、snapshot、receipt 与 rollback；组合收益不能冒充单 arm 边际收益。
3. 历史事实、算术上限、推导、未验证假设、拟议验收目标明确分层；没有实验 receipt 的数字不得写成当前能力或已实现收益。
4. A/B 使用同任务配对、随机/交叉顺序、clean-context lineage、non-overlap 执行和双账本；质量退化可立即停止。
5. 核心必做项 1.a、1.c、4.a、4.b 在任何可选模型路由或 eval 迁移实验之前完成并 smoke。

本文证据标签仅使用以下语义：

- `[历史事实]`：来源文件已经记录、可按 manifest 固定版本复核的历史观测或源码能力。
- `[历史事实-当时配置]`：`reviewed_at=2026-08-04` 的本机 effective configuration receipt；不是仓库永久默认。
- `[算术上限]`：给定显式假设后可复算的上限，不是实测收益。
- `[推导]`：由已列事实推得的设计判断，不冒充历史观测。
- `[未验证假设]`：需 A/B 才能确认的因果或质量判断。
- `[拟议验收目标]`：未来实验/发布门槛，不是当前达成状态。

### 1.2 证据底座

| 输入 | 权威范围 | 本文使用方式 |
|---|---|---|
| `docs/long-session-latency-analysis.md` | 2026-08-03 的全量 session 历史分析 | 会话数、活跃耗时、模型/TTFT/工具池、重复 read、compaction、hub/bash/eval 事件 |
| `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md` | round 4 的 Plan B 方向与约束 | 只复用仍与当前源码一致的方向；不继承过时 owner 或算术 |
| `docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md` | round 2 默认能力/缺口信息底座 | 当前默认与 effective 配置、方向 1-5 的边界和 canonical owner |
| `docs/superpowers/plans/2026-08-03-latency-optimization-plan-review.md` | A 的 round 1 独立评审 | Blocking/Major 修订入口 |
| `docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md` | plan review canonical 目标合同 | 单强评审、同评审复审、分歧仲裁；不复制引擎 |
| `docs/superpowers/specs/2026-08-04-proactive-subagent-delegation-design.md` | 普通会话主动委派边界 | task 只做已 scope 切片，完整门禁走 workflow |
| `docs/superpowers/plans/2026-08-04-latency-delegation-docs-collective-subagent-review.md` | 五文档 round 1 集体评审 | 跨文档 blocker 与统一数值/owner 契约 |
| `/Users/sheng/.omp/agent/config.yml` | 2026-08-04 当时本机 effective 配置 | 只作为 dated receipt；explicit 与 default-derived 分列 |
| `packages/coding-agent/src/` | 当前 canonical owner | 验证拟议落点存在；不把设计写成已实现 |

所有 review input 的 SHA-256 见 Appendix A。未列入 manifest 的历史 session 路径、临时分析目录或对话内容不作为 reviewer 必须信任的证据。

### 1.3 Historical latency baseline and quantitative discipline

[历史事实] `docs/long-session-latency-analysis.md:9-26` 记录：886 个 JSONL 中解析出 689 个真实会话，总墙钟 615h，活跃耗时 306.6h。顶层口径是模型生成 + TTFT + 工具执行，不能把墙钟、工具子类和模型子类重复相加。

| 指标 | 数值 | 证据与口径 |
|---|---:|---|
| 模型生成池 | 174.3h | [历史事实] 活跃耗时的 57% |
| TTFT 池 | 92.0h | [历史事实] 活跃耗时的 30% |
| 工具执行 remainder | 40.3h | [推导] `306.6-174.3-92.0`；不是另一个独立历史表行 |
| Sol 请求轮次 | 17,205 | [历史事实] Sol gen 136.9h，avg 29s/轮；TTFT 75.7h，avg 16s/轮 |
| hub 等待 | 21.3h / 3,559 次 | [历史事实] 工具池子类；不得再与工具总量相加为“总活跃” |
| bash | 6.2h / 5,534 次 | [历史事实] 工具池子类，含长尾与失败重跑 |
| eval | 3.7h / 578 次 | [历史事实] 工具池子类；均值按 §2.3 重算 |
| web_search | 3.7h / 285 次 | [历史事实] 工具池子类 |
| read | 19,117 次 | [历史事实] 同一设计文件最多重复读 42 次 |
| compaction | 26 个会话 | [历史事实] 触发点 316-371k tokens，累计压缩 11.5M tokens |

[历史事实] Sol/Luna 的历史 TTFT 为约 16-17s；Flash/Grok 为约 4s。Terra 没有本证据集的实测 TTFT，因此本文不得把 Terra 写成 4s 级模型。

[历史事实] 既有设计记录的平均 prompt 是 **6,176 characters** 与 **9,981 UTF-8 bytes**。字符、字节、token 是不同单位；本文不把二者互换，也不据此虚构精确 token 数。

### 1.4 Dated effective-settings receipt

Receipt：`reviewed_at=2026-08-04`，source=`/Users/sheng/.omp/agent/config.yml:609-644`，full-file SHA-256=`1eb09e44cb35d1a2ad0dda2162c0e711d044e039e9e4c18fba9b070c756bd5f1`。

| 设置 | 2026-08-04 effective 值 | 来源分类 | 设计含义 |
|---|---|---|---|
| `task.agentModelOverrides` | 显式 record（含 scout/designer/task/reviewer） | [历史事实-当时配置] explicit | 本机路由会覆盖 agent frontmatter；不是仓库默认 |
| `task.eager` | `preferred` | [历史事实-当时配置] explicit | 本机已偏好委派；schema 默认仍由 E 的 receipt 单独说明 |
| `task.batch` | `true` | [历史事实-当时配置] explicit | 批量能力已存在；不能再声称“能力不存在” |
| `async.enabled` | `true` | [历史事实-当时配置] explicit | 异步能力已存在；方向 5 是有 parity receipt 的 eval 迁移/重叠，不是新建 async 引擎 |
| `compaction.thresholdPercent` | `70` | [历史事实-当时配置] explicit | 只描述当时本机 control，不冒充 schema 默认 |
| `compaction.idleEnabled` | `true` | [历史事实-当时配置] explicit | 同上 |
| `compaction.idleThresholdTokens` | `200000` | [历史事实-当时配置] default-derived | 本机无显式键；来自 schema 默认 |
| `defaultThinkingLevel` | `high` | [历史事实-当时配置] default-derived | 不据此强行重写各 agent frontmatter effort |
| `modelOptimization.enabled` | `false` | [历史事实-当时配置] default-derived | ordinary-session optimization seam 已存在但未激活 |

Control baseline 必须冻结：代码 revision、effective config hash、schema defaults、prompt hashes、model availability、provider quota、host、agent definition source/hash、workflow route snapshot。实验不得把本机 explicit 值误称为默认，也不得在 treatment 中顺手修改未被测的键。

### 1.5 Constraints and non-goals

1. **Context first**：用户授权的核心优先级是上下文体积与并发；不能因模型路由容易实现而反转顺序。
2. **Design only**：本文不改代码、不改配置、不发布；`implementation_authorization` 保持 `design-only`。
3. **Canonical owners only**：禁止虚构 `task-batch.ts`、`session/tool-output-processor.ts`、`performance.contextVolume.truncation.*` 或 `fresh` 参数。
4. **Truncation seam**：ordinary-session truncation/dedupe 必须激活既有 `modelOptimization` seam，并复用 `session/agent-session.ts`、`workflow/tool-output-manager.ts`、`workflow/context-ledger.ts` 的能力。
5. **Concurrency seam**：并发执行降低到 `task/index.ts` + `task/parallel.ts`，或由 workflow `RuntimePort` 执行；不新建 scheduler。
6. **Review seam**：plan review 只走 workflow `prompts/workflow/plan-reviewer.md`；code/patch review 只走 `prompts/agents/reviewer.md`。
7. **Plan-review shape**：永远是一个强 reviewer 初评 → 同 reviewer/identity 精确复审 → 结构化分歧触发仲裁。禁止 N-reviewer any-block 并行投票。
8. **Mechanical target**：方向 2 的目标模型是 Flash。Grok 只作为 4s 历史比较；Luna 是 16-17s 基线；Terra 无实测。
9. **Eval migration honesty**：方向 5 只能把 bridge 门禁迁到 native workflow/task artifact owner，并在存在独立工作时重叠 parent interval；不能宣称 eval work、provider latency 或成本“消失”。
10. **Clean cutover**：未来若实现新 versioned artifact，全部调用方必须迁移；不得留下第二份 ledger、兼容 alias 或不受 owner 管理的 shim。

## 2. Current State, Gaps, and Benefit Quantification

### 2.1 Coverage matrix

| 方向 | 当前能力 | 真正缺口 | Canonical owner |
|---|---|---|---|
| 1. Context-volume pre-management | ordinary session 已可 resolve/apply `modelOptimization`；workflow 有 tool-output manager/context ledger；compaction 已存在 | ordinary seam 默认未启用；重复 read 尚无 branch/provider-view 安全的 prompt-level dedupe 合同 | `config/settings-schema.ts`、`model-optimization/*`、`sdk.ts`、`session/agent-session.ts`、`workflow/tool-output-manager.ts`、`workflow/context-ledger.ts`、`tools/read.ts` |
| 2. Workflow role static split | workflow 已有 `model-router.ts`、`session-config.ts`、`quality-route-snapshot.ts` 和 FindingTracker seam | 缺少 caller-declared/accepted-finding 驱动的 mechanical Flash route arm；不能反向用当前 review 结果选择当前 reviewer | `workflow/model-router.ts`、`workflow/session-config.ts`、`workflow/quality-route-snapshot.ts`、`workflow/finding-tracker.ts` |
| 3. Bash failure-loop control | `tools/bash.ts` 与 `tools/exec/bash-executor.ts` 已执行并返回结果 | 缺少一个 canonical、跨 attempt 可复核但不自动重试的 failure ledger | `tools/bash.ts`、`tools/exec/bash-executor.ts`、现有 session result/event path |
| 4. Concurrency + review coordination | task batch、session semaphore、`task/parallel.ts`、workflow RuntimePort/ArtifactStore/SQLite 已存在 | 缺少 versioned declaration、durable state/receipt、D-compatible plan-review binding | `task/index.ts`、`task/parallel.ts`、`workflow/*` |
| 5. Eval-gate migration/overlap | `tools/eval.ts`、eval bridges、workflow/task artifacts、identity receipt、async/hub lifecycle 已存在 | 缺少 bridge↔native parity receipt、owner mapping、独立工作 overlap 与 truthful blocked-interval accounting | `tools/eval.ts`、`eval/{agent,completion}-bridge.ts`、workflow RuntimePort/ArtifactStore/identity owner |

[推导] 这些是“能力已存在、effective control 或合同未启用/未闭合”，不是五套全新能力。因此设计的杠杆是加深既有 seam，而不是新增旁路。

### 2.2 Root-cause mapping

| 历史根因 | 主要方向 | 次要方向 | 不应声称的效果 |
|---|---|---|---|
| 长上下文推高 TTFT | 1.a、1.c | 2 | 不能承诺所有模型 TTFT 固定为 4s |
| Sol 全程承担机械工作 | 2 | 4 | 不能在无质量 A/B 时把强 reviewer 降级 |
| hub 同步等门禁 | 4 | 5 | 不能用后台化掩盖 plan-review gate |
| bash 失败重跑 | 3 | 5 | 不能自动跳过用户明确要求的 rerun |
| 重复 read/compaction | 1.c、1.a | 3 | 不能以 cache hit 证明 prompt 体积已下降 |
| eval 异模型门禁 | 5 | 4 的 D 合同 | 不能把 578 次历史 eval 都视为可重叠或可迁移到 Flash |

### 2.3 Reproducible arithmetic

1. **Eval historical mean**：
   - [历史事实] 总量 `3.7h / 578 calls`。
   - [推导] `(3.7×3600)/578 = 23.04498s`，报告为 **23.04s/call**。
   - 这只是全语料均值；Aegis 22 次 2.51h 等长尾子集仍可显著更慢。

2. **Mechanical routing TTFT upper bound**：
   - [历史事实] Sol TTFT 池为 75.7h，历史均值约 16s；Flash/Grok 历史约 4s。
   - [未验证假设] 35% Sol TTFT 请求属于可静态声明的 mechanical work，且改走 Flash 不降低质量。
   - [算术上限] `75.7×0.35×(1-4/16) = 19.87125h`，报告为 **19.87h**。
   - 该值不是总活跃耗时的已实现节省，不含 fallback、queueing、cache、provider drift 或错误分类成本。

3. **Prompt-size receipt**：
   - [历史事实] `6,176 chars` 与 `9,981 bytes` 是不同 measurement columns。
   - [推导] UTF-8 bytes 大于 characters 与多字节文本一致，但不能由这两个数反推精确 tokens。

4. **Other directions**：
   - [未验证假设] 1.a/1.c 可降低 prompt bytes 与高 context-bucket TTFT；3 可降低重复失败 attempt；4 可降低 independent work critical path；5 可降低 parent blocked interval。
   - 在 §6 A/B 前不为这些方向给出小时级历史收益；避免把相互重叠的 306.6h 池重复领取。

### 2.4 Why control must be frozen

[推导] 当前本机已经 `task.eager=preferred`、`task.batch=true`、`async.enabled=true`，同时 `modelOptimization.enabled=false`。若 control 不冻结，单次实验会混入委派姿态、并发、模型、优化 profile 与 provider availability 的变化，无法归因。

因此每个 arm 的 control/treatment 必须：

- 使用同一 request/fixture hash、代码 revision、配置 snapshot 和 prompt hash；
- 只翻一个 owner-controlled switch；
- 使用同一模型 availability window，或把 availability 不可比 pair 排除；
- 同一 host/provider 上不重叠执行；
- 各自在 clean context 中启动，不把前一 run 的 reviewer/failure/cache artifact 注入后一 run；
- 保留 canonical interval-union 与 legacy sum 两种互不混算的历史账。

## 3. Authorization and Scope Contract

### 3.1 Future must-implement core

未来获得实现授权后，以下四项是核心必做，必须按 §5 Phase 1 先行：

- **1.a — activate ordinary-session `modelOptimization` seam**：用现有 profile compiler/ordinary gates 管理 tool-output optimization；不新增 truncation config tree。
- **1.c — read-result dedupe with safe view identity**：在 context injection 层去重重复 read；key 必须包含 branch/worktree scope 与 provider-view identity；unknown 时 fail open。
- **4.a — `WorkflowConcurrencyDeclarationV1`**：versioned、strict、durable、可校验的 work-package DAG/ownership/completion 合同。
- **4.b — declaration execution/lifecycle binding**：降低到现有 task batch/semaphore/parallel primitive 或 workflow RuntimePort，完整覆盖 backpressure、cancel/resume、idempotency、join/quorum 与 receipts。

核心成功前不得用方向 2、3、5 的可见效果替代它们。1.a、1.c、4.a、4.b 也必须分别有独立 arm，便于精确回滚。

### 3.2 Optional independent experiments

- **1.b** context budget/profile tuning：只有在 1.a 激活并有 receipt 后实验。
- **2** workflow mechanical Flash routing：只改 session-frozen quality route snapshot 中的静态 role/class；不得自动降级 plan reviewer。
- **3** bash failure ledger：单一 owner；先 advisory，再可选 bounded context injection。
- **4.c** D plan-review contract integration：复用 D 的 WorkflowEngine owner，不由 task 自组织复制。
- **5** native eval-gate migration：先证明 bridge/native decision、identity、inline/isolation、cancel 与 artifact parity；仅独立工作可 overlap。

这些方向可以独立失败或回滚，不能绑成一个总开关。

### 3.3 Out of scope

- 新建通用 scheduler、第二 WorkflowEngine、第二 model router、第二 plan-review engine。
- 新建 `task-batch.ts`、`session/tool-output-processor.ts` 或 `performance.contextVolume.truncation.*`。
- 给 `read` 增加语义不清的 `fresh` 参数；cache/dedupe 失效必须来自 view identity/revision。
- 将 task generic reviewer 用作 plan reviewer，或把 workflow plan reviewer 用作 patch/code reviewer。
- N-reviewer any-block、弱 reviewer 多数票、并行 reviewer 投票。
- 把 Terra 写成 4s 实测模型，或把 Luna 写成 mechanical 目标。
- 自动跳过失败命令、自动修改用户命令、隐藏 eval/后台成本、把排队时间记为零。
- 在没有实现授权时修改代码、配置、测试、changelog 或 release note。

### 3.4 Cross-document authority

发生冲突时按以下顺序解释：

1. 当前用户明确合同；
2. D 的 plan-review pipeline canonical contract；
3. E 的 task/workflow boundary；
4. B 的 current/default gap receipt；
5. 本文针对方向 1-5 的集成设计；
6. 旧 round 1 文本仅作历史来源，不覆盖 round 2 修订。

## 4. Detailed File/Module-Level Design

### 4.1 Direction 1 — Context-Volume Pre-Management

#### 4.1.1 Owner and data flow

```text
settings/profile selection
  config/settings-schema.ts
  model-optimization/default-profiles.ts
            │
            ▼
ordinary-session reconcile
  sdk.ts + session/agent-session.ts
            │
            ▼
existing tool-output optimization seam
  workflow/tool-output-manager.ts
  workflow/context-ledger.ts
            │
            ▼
model-visible retained output + receipt
```

[历史事实] `session/agent-session.ts` 已能 resolve/apply active model optimization，`sdk.ts` 已按 `modelOptimization.enabled` 编译 ordinary-session feature gates，workflow 也已有 tool-output manager/context ledger。方向 1 的正确落点是激活和加深这条 seam，而不是创建 `session/tool-output-processor.ts`。

#### 4.1.2 1.a — activation contract

1. 保持 `modelOptimization.enabled` 为唯一普通会话总 gate；新增行为必须作为 versioned profile capability，而不是平行布尔树。
2. profile 必须明确：适用模型/上下文桶、tool-result 处理策略、最大可见 bytes/tokens、artifact retention、fail-open 条件与 receipt version。
3. ordinary-session 与 workflow 可以复用同一 transform/compiler，但各自 session/workflow lifecycle 仍是 authority；不得让 workflow artifact 被 ordinary session 无条件读取。
4. 启用时必须持久/发出既有 `ContextOptimizationReceiptV1` / `ToolOptimizationReceiptV1` owner 的 versioned receipt：原始 hash/bytes、保留 hash/bytes、artifact ref、transform、bucket、profile id、estimate version。
5. profile 不匹配、receipt store 不可用、artifact hash 不可验证或 transform 抛错时 fail open：保留当前完整结果，不吞内容。
6. 停用或 rollback 只关闭此 arm；不得关闭 compaction、read cache 或模型路由的其他 owner。

#### 4.1.3 1.b — context budget tuning

1.b 只能在 1.a receipt 可用后调整 profile threshold。它不是核心先行项，也不得把 `compaction.thresholdPercent=70` 的本机 explicit 值重新定义为 schema 默认。

拟议控制量：

- prompt/context bucket（例如 `<50k`、`50-100k`、`100-150k`、`150-200k`、`200-300k`、`≥300k`）；
- tool-result visible bytes 与 estimated tokens；
- replaceable/immutable artifact eligibility；
- compaction 前后同一 artifact 的 retained reference；
- provider/model profile identity。

[拟议验收目标] context 优化后不能出现 artifact hash 不可恢复、错误 source reference、关键 error 被截断或 review evidence 丢失。

#### 4.1.4 1.c — read dedupe contract

目标是减少模型上下文中相同 provider view 的重复 full payload，不是改变 `read` 的外部语义，也不是避免所有底层 I/O。

**Canonical dedupe key**：

```text
ReadViewKeyV1 = sha256(stableSerialize({
  tool: "read",
  canonicalSource,
  normalizedSelector,
  branchOrWorktreeScope,
  providerViewIdentity,
  contentOrRevisionIdentity,
  rendererVersion,
  outputMode
}))
```

字段合同：

- `canonicalSource`：解析后的本地路径、archive member、internal URI 或规范化 URL；不直接使用用户输入的相对拼写。
- `normalizedSelector`：包含 raw/line-range/table-row/query 等选择器语义；不同 selector 不错误合并。
- `branchOrWorktreeScope`：repo root + worktree/session revision/branch identity。相同路径在不同 branch/worktree 不命中。
- `providerViewIdentity`：URL ETag/Last-Modified/content digest、artifact immutable SHA、archive member/container SHA、数据库 snapshot/revision 或 provider 返回的等价 view id。
- `contentOrRevisionIdentity`：本地 working-tree 内容 digest 或足以检测变化的 revision receipt；不能只用 pathname。
- `rendererVersion`：防止 read formatter/metadata变化后误复用旧可见文本。
- `outputMode`：raw/converted/decoded 等模式必须区分。

**命中行为**：

1. read 工具照常产生当前结果与 source identity；optimization seam 在 model-visible context injection 前查询 `workflow/context-ledger.ts` 的 retained entry。
2. 同 key 且 immutable SHA 可验证时，首次结果保留完整内容；后续结果替换为稳定 artifact/context ref + 当前 selector/view receipt，不重复注入全文。
3. branch、provider view、content identity、selector 或 renderer 任一变化即 miss，并保留新全文。
4. compaction、eviction、model/provider switch、branch/worktree switch 或 session rewind 后必须 reset/reconcile ledger；只有 retained artifact/hash/view 全部可验证时才可延续命中。
5. provider 不给稳定 view identity、工作树状态无法确认、artifact store 不可用、hash 校验失败或 receipt 丢失时 **fail open**，保留全文。
6. 不增加 `fresh` 参数。失效由 source/view identity 决定；调用方不承担隐藏 cache 协议。
7. ledger 必须保留 `originalSha256`、`visibleSha256`、`artifactRef`、original/visible bytes、estimated saved tokens 和 estimate version。
8. 不能复用仅对 attachment/reminder/skill delta 有效的 dedupe 假设来声称 tool-result 已去重；实现必须显式增加 read/tool-result eligible kind 与测试。

#### 4.1.5 Direction 1 verification hooks

- 同文件同 branch、同 selector、内容不变：第二次 model-visible payload 为 ref/摘要且 hash 可恢复。
- 同路径跨 branch/worktree：不得命中。
- URL 相同但 ETag/content 变化：不得命中。
- selector、raw/converted 模式或 renderer version 变化：不得命中。
- compaction/eviction/provider switch/rewind 后 receipt 不完整：不得继承命中。
- provider identity unknown、artifact store failure、hash mismatch：完整 payload fail open。
- error result、security warning、truncation boundary：关键错误不可被“已见过”抑制。

### 4.2 Direction 2 — Workflow Static Role Split to Flash

#### 4.2.1 Target, boundary and canonical owner

目标模型明确为 **Flash**。历史基线是 Sol/Luna 约 16-17s TTFT 与 Flash/Grok 约 4s；Terra 无实测。

本方向只扩展 workflow 已有 role/tier seam：

- `packages/coding-agent/src/workflow/model-router.ts`
- `packages/coding-agent/src/workflow/session-config.ts`
- `packages/coding-agent/src/workflow/quality-route-snapshot.ts`
- `packages/coding-agent/src/workflow/finding-tracker.ts`（只消费已接受 finding，不建立第二 router）

E 的 ordinary task/scout/reviewer stage routing 是独立设计，不是本方向的 owner。generic task 的 `@task`、frontmatter 与 resolver fallback 不因本方向改变。

#### 4.2.2 `WorkflowMechanicalClassV1`

分类必须在 workflow start/session snapshot 时由 caller-declared class、确定性规则，或**先前已接受** ReviewArtifact finding 提供；不得使用当前初评尚未产生的 finding severity 反向选择当前 reviewer。

```text
WorkflowMechanicalClassV1:
  class: deterministic_evidence | mechanical_repair | format_check | none
  evidence: caller declaration | deterministic rule id | accepted finding id
  targetRole: evidence | repair | code_review_experiment
  requestedModelClass: flash | existing
```

Eligibility：

- 输入/输出边界已由已批准 plan/finding/verification contract 固定；
- 只适用于机械 repair、格式检查、独立 deterministic evidence，或另行批准的 code-review 实验；
- 不做架构取舍、权限判断、跨模块 contract、plan review 或仲裁；
- 失败可由 verifier/schema/parent gate 检出；
- 无法证明分类时走强模型保守路径。

#### 4.2.3 Frozen route and rollback

- `role_static_split` 是独立 default-off arm；route profile 顺序、classification schema、candidate identities、prompt/schema hash 写入 session-frozen `QualityRouteSnapshot`。
- target role 解析到 Flash；不可用时按 snapshot 中的既有强 fallback，记录 selected profile、resolved identity/fallback 与 availability，不读取中途变更的 settings。
- plan review 永远遵循 D：单强评审 + 冻结 identity 的同 reviewer 复审 + 条件仲裁；本 arm 不改变 `plan_reviewer`。
- 任一 P0/P1 escape、质量下降 >2pp、返工上升 >10% 或 reviewer/authority work 错分：只关闭 `role_static_split` 并恢复 control snapshot。
- 收益只按本 arm 的配对 delta 报告；19.87h 是条件算术上限，不是 rollout 目标保证。

### 4.3 Direction 3 — One Canonical Bash Failure Ledger

#### 4.3.1 Owner and non-goals

唯一 owner 是现有 `tools/bash.ts` + `tools/exec/bash-executor.ts` + session command result/event path。Plan B 的重跑诊断与本方向共享同一 ledger；不得再建立第二个 tracker、第二份 JSONL 或 prompt-only shadow state。

Ledger 不自动重跑、不自动改命令、不自动跳过用户明确 rerun，也不存储 secret env values。

#### 4.3.2 `BashAttemptLedgerV1`

```text
BashAttemptLedgerV1:
  schemaVersion: 1
  sessionId
  commandFingerprint
  stateFingerprint
  attempts[]:
    attemptId
    startedAt / endedAt
    exitCode | timeout | cancelled
    failureFingerprint
    stdoutDigest / stderrDigest
    cwdIdentity
    changedInputReceipt
  mode: advisory | bounded_injection
```

- `commandFingerprint`：稳定规范化 executable/argv/pipeline 形态 + cwd；quote 等价归一需保守，无法证明等价则视为不同。
- `stateFingerprint`：代码/config revision、相关文件 hash、declared env **name** set、dependency/build artifact receipt；不得记录 secret value。
- `failureFingerprint`：exit class、signal/timeout、稳定 error excerpt digest；输出中时间戳/随机 id 的归一化必须 versioned。
- `changedInputReceipt`：用户或工具修改了何种权威输入，用于区分“相同失败重跑”与“修复后验证”。

#### 4.3.3 Two modes, one ledger

1. **Advisory arm**：第二次同 command+state+failure 时只显示结构化提示，列 prior attempts 与 failure fingerprint；不改变执行。
2. **Bounded-injection arm**：在下一次相关 bash 调用前向 model context 注入有界 ledger 摘要；仍由 agent/用户决定是否 rerun。
3. 两种模式读取同一 `BashAttemptLedgerV1`，各自有独立开关；禁止“Plan B tracker + Direction 3 tracker”并存。
4. state fingerprint 变化、用户明确要求 rerun 或 prior attempt 被取消时不作重复失败阻断。
5. ledger/persistence 不可用时 fail open，执行当前命令并在 receipt 标记 unknown。

#### 4.3.4 Safety and accounting

- 超时、cancel、process exit、output truncation 与 tool error 必须区分；不能把取消算失败。
- 迁移后的 eval/后台 bash 若存在必须用相同 attempt ledger，不能因后台化丢失 exit/result。
- A/B 记录重复 attempt count、time-to-first-new-evidence、interval-union latency 与成功率；不能只数提示出现次数。

### 4.4 Direction 4 — Versioned Concurrency and Review Contract

#### 4.4.1 Canonical execution owners

普通 task batch：

- `packages/coding-agent/src/task/index.ts:697-718`：现有 batch validation/preflight/agent resolution 与 session semaphore owner。
- `packages/coding-agent/src/task/parallel.ts:100-141`：现有 concurrency primitive/semaphore owner。
- `task.maxConcurrency`：现有 session backpressure setting；`0` 的 unlimited 语义必须沿用 owner，不在 declaration 另造冲突默认。

Workflow：

- `WorkflowEngine`、PlanArtifact work packages、ArtifactStore、SQLite store、BudgetLedger、transition owner；
- stage execution 通过既有 `RuntimePort`；不引入 `task-batch.ts` 或旁路 scheduler。

#### 4.4.2 4.a — `WorkflowConcurrencyDeclarationV1`

Declaration 由已批准 PlanArtifact/work packages 或普通会话已 scope task batch 生成；不是新的顶层自然语言 planner。

```text
WorkflowConcurrencyDeclarationV1:
  schemaVersion: 1
  declarationId
  ownerKind: workflow | session_task
  ownerId
  scopeArtifactRef
  scopeArtifactSha256
  revision
  maxConcurrency
  completionPolicy:
    kind: all_required | quorum
    minSuccesses: number | null
  failurePolicy: fail_closed | continue_independent
  cancelPolicy: cascade_dependents | stop_new_work
  units[]:
    id
    assignment
    paths[]
    dependsOn[]
    independentGroup
    isolationScope
    rendezvousId
    mode: read | write
    required: boolean
    idempotencyKey
```

Strict validation：

1. schema version、owner、scope hash、unit IDs、paths、dependencies、group/isolation/rendezvous 必须完整；unknown field fail closed。
2. dependency graph 必须无环；missing dependency、self dependency、duplicate id 拒绝。
3. `independentGroup` 只声明可同时 ready 的候选，不能覆盖 dependency；`rendezvousId` 必须对应合法 join point。
4. write paths 或 `isolationScope` 有重叠、parent/child ownership 不可证明时，不并行；进入 serial/blocked resolution，不用 LLM 猜 merge safety。
5. `quorum` 只允许预声明为独立、可丢弃、非共同 write-commit 的 units；所有 required write units 仍必须成功。
6. `maxConcurrency` 不能绕过 session/provider/workflow budget；effective concurrency 取 declaration、task setting、provider/backpressure 中最小的有界值。
7. `scopeArtifactSha256` 或 revision 漂移时 declaration 失效，必须重新生成；不能继续执行旧计划。
8. declaration 与 unit 状态必须 durable；不能只存在 prompt 文本。

#### 4.4.3 4.b — lowering, lifecycle, resume and receipts

```text
declared → ready → running → succeeded | failed | cancelled
                         └→ skipped_dependency

declaration:
  declared → running → converged → committed
                     └→ failed | blocked | cancelled
```

**Lowering**：

- `ownerKind=session_task`：validator 把 ready units 降低为现有 task spawn items；`task/index.ts` 做完整 preflight/agent resolution，`task/parallel.ts` 执行有界 all-settled primitive。
- `ownerKind=workflow`：WorkflowEngine 从已批准 PlanArtifact work packages 创建/恢复 declaration，并通过 RuntimePort 运行 stage/work packages；artifact、budget、transition 仍由 workflow owner 原子提交。
- declaration 不拥有 model selection；task/workflow 各自既有 route owner 解析模型并写 receipt。

**Backpressure**：只有 dependencies satisfied、rendezvous/isolation 条件满足且 budget/permit 可用的 unit 进入 ready/running；排队时间单独记录，不能算作零延迟。provider concurrency 与 session concurrency 都必须生效。

**Cancel/resume/partial failure**：

- cancel 阻止新 unit，并按 `cancelPolicy` 取消 in-flight/依赖 unit；终态不可被后续 callback 覆盖。
- resume 读取 durable declaration/state/attempt receipts；已成功且 idempotencyKey+artifact hash 一致的 unit 不重复执行。
- attempt 已开始但无可信 terminal receipt 时标 unknown/needs-reconciliation，不静默重跑付费工作。
- `continue_independent` 只允许未依赖失败 unit 的 ready set 继续；required failure 最终仍使 declaration failed/blocked。
- scope/revision/hash 漂移 fail closed。

**Join/quorum**：

- `all_required`：所有 required units 成功并到达 rendezvous 后 converged。
- `quorum`：达到 minSuccesses 仅允许结束独立 advisory/read units；required write units 仍全部成功且 merge/commit 验证通过。
- 失败 unit 不能因 child runtime overlap 在 legacy sum 与 canonical ledger 重复计为两份节省。

**Receipts**：declaration fingerprint、group/isolation/rendezvous、unit route identity、started/ended interval、queue interval、dependency snapshot、attempt count、result/artifact hash、cancel reason、budget usage、commit/merge verification。

#### 4.4.4 Plan-review shape and prompt ownership

方向 4 只绑定 D 的形态，不重写 D：

```text
one strong plan reviewer
  → approved: next workflow stage
  → changes_requested: author revises
      → exact same reviewer/profile/runtime identity rereviews
          → approved: next stage
          → structured contradiction/max-cycle dispute: arbitration
  → blocked/missing authority: awaiting human
```

- plan review prompt：`packages/coding-agent/src/prompts/workflow/plan-reviewer.md`。
- code/patch review prompt：`packages/coding-agent/src/prompts/agents/reviewer.md`。
- 初评只有一个强 reviewer；复审 pin 同一 reviewer identity；仲裁使用 D 的第三 lineage/人工 fallback 与 strict receipt。
- 并行只能用于 deterministic checks 或独立 evidence collection，不能产生 N-reviewer any-block 投票。
- task generic reviewer 不能生成 workflow plan-review artifact；E 的 task 轻链遇到 plan review、跨模块 contract、resume/repair/rollback 必须升级到 WorkflowEngine。

#### 4.4.5 Hub wait/message semantics

现有 hub 合同必须原样保留：

- `await:true` 只属于 `op:"send"`，表示等待指定 peer 回复；不能写成通用 job-await 参数。
- `op:"wait"` 是独立 operation，用于等待消息、后台 job 或 process lifecycle；它没有 `await` 参数。
- task/job completion 通过现有 job lifecycle/receipt；不创建 `hub-await` 字段或轮询 scheduler。
- 背景 job 自动 delivery 与 workflow durable resume 是不同 owner；不能互相冒充。

#### 4.4.6 Direction 4 verification hooks

- DAG/cycle/missing-dependency/group/isolation/rendezvous/write-overlap validation。
- task lowering 证明实际走 `task/index.ts` + `task/parallel.ts`，并受 `task.maxConcurrency`/provider limit 约束。
- workflow lowering 证明实际走 RuntimePort/ArtifactStore/SQLite/transition owner。
- cancel before start、cancel in flight、resume after process restart、lost callback reconciliation、partial failure。
- all-required 与受限 quorum；required write 不被 quorum 掩盖。
- exact reviewer rereview identity、仲裁 trigger、plan/code prompt separation、无 N-reviewer voting。
- hub `send await:true` 与 `wait` 的 schema/行为回归。

### 4.5 Direction 5 — Native Eval-Gate Migration and Observable Overlap

#### 4.5.1 Canonical owner and scope

[历史事实] 当前 eval 工具/bridge 与 native workflow/task artifact 是不同执行路径；`async.enabled=true` 只说明异步能力存在，不证明二者 decision、inline/isolation、identity、cancel 或 artifact 语义等价。

方向 5 的 owner：

- source/control：`packages/coding-agent/src/tools/eval.ts`、`packages/coding-agent/src/eval/agent-bridge.ts`、`eval/completion-bridge.ts`；
- target：完整门禁走 WorkflowEngine/RuntimePort/ArtifactStore/identity receipt；已 scope 的轻量 deterministic evidence 才可走 E 允许的 task path；
- execution support：现有 async/hub job/process lifecycle；不新建 background engine。

Plan review 仍只走 D，不能以 eval migration 绕过 single-reviewer/rereview/arbitration。

#### 4.5.2 `EvalGateParityReceiptV1`

```text
EvalGateParityReceiptV1:
  schemaVersion: 1
  sourceBridge
  sourceRequestSha256
  sourceDecisionContract
  sourceInlineIsolationContract
  targetOwner: workflow | task
  targetArtifactRef / sha256
  targetDecision
  targetIdentityReceiptRef
  targetContextReceiptRef
  cancelResumeReceiptRef
  parity: proven | failed | unknown
```

迁移前必须证明：

1. source/target decision enum 与 gate-failure 语义等价；
2. inline、isolation、working-tree ownership 与 allowed tools 不变或有明确批准的差异；
3. runtime model identity/provenance、clean context、prompt/schema hash 可复核；
4. cancel、timeout、budget、retry、resume 与 terminal result 不丢失；
5. target artifact 可由 hash 恢复，且 code/plan reviewer prompt owner不混用。

任一 parity=failed/unknown 时保持 bridge control，不能为了延迟强迁移。

#### 4.5.3 Observable overlap, not disappearance

只有父会话存在与 eval gate **真正独立** 的 ready work 时，native target 才可后台运行/重叠：

- parent 继续的工作必须有不相交 ownership/dependency receipt；需要 gate result 时通过现有 wait/join owner收敛。
- eval active interval、provider latency、queue、tokens/USD、child runtime 全部保留在 additive/interval ledger。
- 只允许报告 parent blocked interval 与 canonical critical-path union 的变化；不得把历史 3.7h eval pool全部当成可消除收益。
- result、stdout/stderr/tool evidence、exit/cancel 必须回到同一 workflow/task/eval receipt 链。

#### 4.5.4 Rollback and verification hooks

- `eval_gate_migration` 独立 default-off；snapshot 固定 source bridge、target owner、route/session/prompt/schema/identity。
- rollback owner=eval/workflow adapter；关闭后恢复现有 bridge，不改变 `agent()` inline/isolation 语义，也不动方向 2/4。
- fixtures 覆盖 approved/changes_requested/blocked 或相应 source decision、timeout、cancel、identity mismatch、artifact mismatch、no-independent-work 和 true-overlap。
- [未验证假设] native migration 在有独立工作时能降低 parent blocked critical path；它不承诺任务 wall-clock、provider latency、eval active work 或成本消失。

## 5. Implementation Phases

> 以下是未来实现顺序，不是当前已执行状态。每一 phase 都需要单独实现授权与 fresh verification output。

### Phase 0 — Freeze control and contracts

1. 固定 repo revision、effective config hash、schema defaults、prompt hashes、model/agent source hashes与 provider availability receipt。
2. 建立 per-arm flags，初始 default-off；不在 Phase 0 改用户全局默认。
3. 冻结 §6 fixture set、pairing/randomization plan、clean-context lineage、interval/cost/quality schema。
4. 实现 versioned receipt/schema validation infrastructure，但 arm off 时不得改变 control behavior。
5. 复核 A/B/C/D/E manifest；任一 peer 文件改变先刷新 hash，再开始实验。

**Exit**：[拟议验收目标] control 可重放；全部 arm 能独立开关；没有功能 treatment 泄漏到 control。

### Phase 1 — Core must-implement first

顺序：

1. **1.a** activate ordinary-session `modelOptimization` seam，先保守 profile + fail-open receipt。
2. **1.c** read dedupe，完成 branch/worktree/provider-view/content/selector/renderer key 与 fail-open。
3. **4.a** `WorkflowConcurrencyDeclarationV1` strict schema、DAG/ownership/isolation/rendezvous validation、durable fingerprint/state。
4. **4.b** lower 到 task existing batch/parallel 或 workflow RuntimePort，补 backpressure/cancel/resume/partial failure/idempotency/join/quorum receipts。

每项先单独 smoke，再做组合 smoke；任何一项失败只回滚该 arm。方向 2/3/5 不得以“并行更快”或“后台不阻塞”替代 Phase 1 exit。

**Exit**：[拟议验收目标] 1.a/1.c/4.a/4.b 的 contract fixtures 全部通过，artifact 可恢复，错误 fail open/fail closed 行为符合 §4，且 control arm 完全可恢复。

### Phase 2 — Independent optional arms

1. 1.b context threshold/profile tuning。
2. Direction 2 workflow static Flash role split。
3. Direction 3 bash ledger：先 advisory，再 bounded injection。
4. Direction 4.c 仅在 D owner 内接入其五个独立 plan-review arms。
5. Direction 5 eval-gate parity/migration/overlap。

每项 pilot ≥30 对；不得在一次 treatment 中同时翻多个方向。若必须测组合，预注册为新的 combined arm，只报告组合效果。

### Phase 3 — Formal evaluation, rollout and retirement

1. 每个通过 pilot 的 arm做 ≥100 对正式实验，或运行预注册固定 CI 与判定区间。
2. 只推广通过质量、成本、合同和 latency criteria 的 arm；失败 arm 保持 off。
3. 推广后保留短期独立 rollback owner 和 receipt；观察期通过后删除实验 scaffolding/重复 control path。
4. clean cutover：迁移全部 caller，删除过时 schema/version adapter；不保留第二 ledger、alias 或 dead prompt。
5. 功能 smoke/A/B 均通过后才写 release note/changelog；本文不预先宣称完成。

## 6. Verification and A/B Contract

### 6.1 Verification layers

#### Direction 1

- 单元：profile gate、receipt schema、read key normalization、branch/provider/content/selector/renderer invalidation、lifecycle reconcile、fail-open。
- 集成：ordinary session 重复 read 后 model-visible payload 缩减但 artifact hash 可恢复；workflow 与 ordinary owner 不串 artifact。
- smoke：启动真实会话，读同文件两次、修改文件再读、切 selector/branch/provider view 再读，观察第二次 dedupe 与变化后 miss。

#### Direction 2

- 单元：strict workflow mechanical class、no-current-review feedback、ineligible strong fallback、frozen route receipt。
- 集成：同 frozen workflow fixture 只改变 `role_static_split`，mechanical repair/evidence 解析到 Flash；plan reviewer route 不变。
- smoke：一个 accepted mechanical finding/deterministic evidence 实际解析到 Flash；一个 architecture/plan-review fixture保持强 route。

#### Direction 3

- 单元：command/state/failure fingerprint、secret redaction、cancel/timeout distinction、state-change reset。
- 集成：同失败命令在同 state 第二次给 advisory；修复输入后 rerun 不误报 stale failure。
- smoke：真实执行一个可控失败命令两次，再修改输入成功；ledger attempt/exit/result 全部可复核。

#### Direction 4

- 单元：strict declaration、DAG/group/isolation/rendezvous/path overlap/quorum/idempotency、state transition。
- 集成：task path 使用现有 preflight/semaphore/parallel；workflow path使用 RuntimePort/artifact/store/transition；cancel/resume across new engine/process。
- smoke：两个独立 work packages 并行、一个依赖 unit 串行；中途 cancel/resume；plan review 走 single strong reviewer + same reviewer rereview + arbitration fixture。

#### Direction 5

- 单元：bridge/native decision parity、inline/isolation、identity/context/artifact receipt、cancel/timeout/resume。
- 集成：完整 gate 迁到 workflow；轻量 evidence 只在 E 边界内走 task；无独立工作时不后台化。
- smoke：真实 eval fixture 分别跑 bridge control/native treatment，证明 parity；有独立 work 时 overlap 后 join，观察真实 result 与 blocked/active intervals。

### 6.2 Independent arms and rollback

| Arm | Control | Treatment | Snapshot/receipt | 独立 rollback |
|---|---|---|---|---|
| `context_optimization` (1.a) | existing modelOptimization off | conservative ordinary profile on | config/profile/compiler hash + optimization receipt | 关闭 1.a gate |
| `read_dedupe` (1.c) | full repeated payload | verified same-view ref replacement | ReadViewKey/ledger/artifact receipt | 关闭 read eligible transform |
| `context_budget_tuning` (1.b) | conservative Phase 1 profile | one threshold/profile delta | profile hash + context bucket | 恢复 Phase 1 profile |
| `role_static_split` (2) | frozen existing workflow route | eligible workflow repair/evidence → Flash | class rule + QualityRouteSnapshot + resolved identity | 恢复 control route snapshot |
| `bash_advisory` (3) | no advisory | same ledger advisory | ledger schema + failure fingerprints | 关闭 advisory |
| `bash_bounded_injection` (3) | ledger advisory only | bounded context injection | injection prompt/hash + same ledger | 关闭 injection，不删 ledger |
| `concurrency_declaration` (4.a) | existing ad hoc task/workflow control | strict declaration/validation | declaration fingerprint/state | 关闭 declaration adapter |
| `concurrency_execution` (4.b) | existing independent task batch / workflow current path | declaration-backed dependency-aware lowering | unit intervals/routes/artifacts | 关闭 execution lowering |
| D `route_sol_xhigh` (4.c) | D frozen control | Sol xhigh route only | D QualityRouteSnapshot | 按 D 回滚 |
| D `anti_anchoring` (4.c) | D frozen control | anti-anchoring prompt fields | plan-review prompt hash | 按 D 回滚 |
| D `spec_evidence` (4.c) | D frozen control | V2 coverage/finding-basis hard gate | schema/receipt version | 按 D 回滚 |
| D `suspicious_pass_escalation` (4.c) | D frozen control | structured escalation | substate policy version | 按 D 回滚 |
| D `arbitration` (4.c) | D frozen control | bounded arbitration/human path | state/route/authority receipt | 按 D 回滚 |
| `eval_gate_migration` (5) | frozen bridge | parity-proven native owner + independent overlap | bridge/route/session/parity/identity receipt | 恢复 bridge |

组合实验必须另有 `combinedArmId`，snapshot 列全部子 arm；触发停止条件时先 fail closed 关闭组合，再逐 arm 重启定位。不得把组合 delta 分摊为单 arm 节省。

### 6.3 Pairing, randomization and clean lineage

1. **Pair**：同一 request/fixture SHA、输入 artifact SHA、code revision、parent model、agent source/hash、model availability、provider/host class、budget、`task.batch`/`async` snapshot，各运行 control 与仅一个 treatment arm。
2. **Randomization**：每对随机或交叉平衡先后顺序，避免时间趋势只落在 treatment。
3. **Non-overlap**：同一 host/provider/quota pool 的 control/treatment execution interval 不重叠；若 CI 并行必须证明资源隔离并记录 availability。
4. **`lineage=clean-context`**：每个 run 新 session/runtime；只注入冻结 request/requirements/artifacts，不注入前一 run 的聊天、review conclusion、bash advisory、dedupe ledger、model cache decision 或 treatment label。
5. **Blind quality review**：人工/独立质量评审不见 arm/control 标签；只看冻结输入、输出、verification evidence。
6. **Sample size**：[拟议验收目标] pilot 每 arm ≥30 对；正式每 arm ≥100 对，或预注册固定 CI 集、置信区间与判定规则。
7. availability、receipt 或 lineage 不可比的 pair 排除并报告原因；不得补 0、插值或重新配对到更有利样本。

### 6.4 Double ledger and no double-counting

#### Canonical interval-union ledger

每个 run 记录 parent、全部 descendants、tool/runtime、queue 和 review intervals 为半开区间 `[startedAt, endedAt)`：

- **active critical-path accounting**：对 declared active intervals 做 union，重叠并发时间只计一次。
- **blocked accounting**：parent 等待 child/result 的 blocked interval 单列；eval overlap 只能影响这一项，不能删除 child active interval。
- **control/treatment**：分别成账，不跨 arm union，不把同一 shared interval分配给多个方向。
- **non-overlap experiment ledger**：记录 control 与 treatment 没有共享 host/provider execution interval，或记录已证明的资源隔离。

#### Legacy sum ledger

把 parent/child/request/tool duration 直接相加，只用于复算历史 `gen/TTFT/tool` 或旧报告口径。它不能与 canonical union 相加，也不能用来声称并行节省。

#### Additive cost ledger

requests、tokens、USD、toolCalls、spawned agents、artifact bytes、provider charges按 parent + 完整子树相加；成本不做 interval union。未知 cost 报 unknown，不填 0。

报告至少给出：control/treatment canonical union、legacy sum、blocked interval、queue interval、critical path、requests/tokens/USD、quality result、receipt completeness。任何“节省”必须指明使用哪本账。

### 6.5 Quality, contract and cost stop conditions

以下均为 [拟议验收目标]；任一触发即停止并回滚致因 arm，不等待统计显著性补救严重合同违规：

1. 完成率、盲化人工通过率或 mandatory correctness 相对 control **下降 >2 percentage points**。
2. revision/repair/rework rate 相对 control **上升 >10%**。
3. 任一归因于 treatment 的 **P0/P1 escape**。
4. 错误 source/view dedupe、artifact hash 不可恢复、关键 error 被截断：立即关闭 1.a/1.c。
5. workflow role 错分 plan/security/contract/reviewer work，或 route snapshot/identity 漂移：立即关闭方向 2。
6. bash ledger 自动阻止明确 rerun、泄露 secret、把 changed state 当重复失败：立即关闭方向 3 对应 arm。
7. write ownership overlap、dependency/commit 违规、cancel 后继续写、resume 重复付费执行：立即关闭 4.a/4.b。
8. plan review identity 漂移、missing receipt、N-reviewer voting、plan/code prompt 混用：按 D fail closed并关闭对应 D arm。
9. eval bridge/native decision、inline/isolation、identity、artifact、cancel/resume 任一 parity 失败，或把实际 eval 成本从总账移除：立即关闭方向 5。
10. requests/tokens/USD P50 >1.5× control 或 P95 >2× control，且 canonical interval-union median latency 改善 <10%：停止对应 arm。
11. spawned-agent count P95 >2× control、provider/host 排队导致 P95 latency 恶化或预算 hard cap：停止对应并发/委派 arm。

### 6.6 Acceptance metrics by direction

| 方向 | Primary latency metric | Required quality/contract evidence |
|---|---|---|
| 1 | prompt visible bytes/tokens、context bucket、TTFT、canonical union | artifact recovery、dedupe precision/lifecycle、fail-open、error preservation |
| 2 | workflow role TTFT/model interval、fallback/queue | static class provenance、frozen route/identity、quality delta、no reviewer downgrade |
| 3 | repeated identical-failure attempts、time-to-new-evidence | no false suppression、secret redaction、state-change correctness |
| 4 | critical path、queue、parallel overlap、blocked interval | DAG/isolation/rendezvous/idempotency/cancel/resume/commit、D review contract |
| 5 | eval parent blocked interval、time-to-decision/result consumption | bridge/native parity、identity/artifact/cancel、no hidden active work/cost |

PASS 只能证明预注册合同在样本内成立；不能证明全局最优，也不能把 `[未验证假设] PASS 早` 当模型路由依据。

## 7. Handoff

### 7.1 Round 2 review contract

- Reviewer：`gateway/gpt-5.6-sol` @ xhigh，独立 `sol-xhigh-reviewer`，读取 Appendix A 全部输入。
- Review mode：review-first；只允许对本目标文档 A 做 minimal direct fixes，不改 B/C/D/E、代码、配置或其他文档。
- Reviewer 必须核对：round 1 Blocking 1-5、Major A/B/双账本/manifest、canonical owners、plan-review shape、数值与单位、B/D/E 跨文档边界。
- Quantitative checks：689 sessions、306.6h、174.3/92.0/40.3 顶层分解、17,205 Sol rounds、75.7h Sol TTFT、19.87h、23.04s、6,176 chars、9,981 bytes。
- Verdict 只能是 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN，并以修复后的 A 为准。

### 7.2 Implementation handoff gate

实现者开始前必须同时拥有：

1. 本文最终 reviewer verdict 与 whole-file SHA-256；
2. 明确的实现授权，不再是 `design-only`；
3. 冻结的 control/config/code/prompt/agent/model availability receipt；
4. Phase 0 A/B protocol；
5. D 的 plan-review contract、E 的 task/workflow boundary和 B 的 direction owner map；
6. 单独的 rollback owner 与验证命令/真实 smoke 场景。

缺任一项不得把设计状态改成“实施中”。未来实现 scope 首先是 1.a/1.c/4.a/4.b；方向 2/3/5 不能抢跑。

### 7.3 Reviewer checklist

- [ ] frontmatter 完整且 `implementation_authorization=design-only`。
- [ ] §1-§7 均存在，方向 1-5 均有文件级 owner 与合同。
- [ ] current config 按 explicit/default-derived 分开，reviewed_at=2026-08-04。
- [ ] 无 `task-batch.ts`、`tool-output-processor.ts`、`performance.contextVolume.truncation.*`、`fresh`。
- [ ] Direction 1 激活 `modelOptimization`，read key 含 branch/provider view，unknown fail open。
- [ ] Direction 2 目标 Flash并复用 workflow model-router/route snapshot；不以 current review 结果选 current reviewer。
- [ ] Direction 3 只有一个 bash ledger。
- [ ] Direction 4 declaration 含 group/isolation/rendezvous并映射现有 task/runtime owner；hub await 语义正确。
- [ ] plan review 是单强评审 + 同评审复审 + 仲裁，plan/code prompt 分离，D 五 arms 独立。
- [ ] Direction 5 先做 bridge/native parity，只报告 blocked/critical-path delta，不承诺 eval work/成本消失。
- [ ] Phase 1 先做 1.a/1.c/4.a/4.b。
- [ ] A/B 有独立 arm、clean-context、non-overlap、≥30/≥100 或 CI、双账本、质量/成本 stop。
- [ ] Appendix A 无占位符，全部 hash 可复算。

## Appendix A: Reviewed Inputs Manifest (Round 2)

Manifest 使用 lowercase SHA-256。除 A 自身外，值为 reviewer 对当前完整文件 bytes 的直接 SHA-256。A 的 row 使用可复现 canonical self-hash：仅把本 row 的 64-hex digest 字段替换为 64 个 ASCII `0`，其余 bytes 不变，再对完整 A 计算 SHA-256；这样避免不可能的 whole-file self-reference。最终 whole-file SHA-256 由 reviewer 在报告中另列。

| Input | SHA-256 | Role |
|---|---|---|
| `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md` | `6c2c110646d074947e380adfb3e8c29235c1e2407e68d84aa5e81e67fba483d3` | A，round 2 restored design；canonical self-hash |
| `docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md` | `7970a19125a3d3c33c79561fe583d4c6d1b78651b33c12c12927dbecd179237d` | B，round 2 current/default gaps |
| `docs/superpowers/plans/2026-08-03-latency-optimization-plan-review.md` | `dc17a2976ee5f0aaa0c00cb080def13970f166b11948ba133e4c127879867eec` | C，round 2 review artifact |
| `docs/superpowers/specs/2026-08-04-plan-review-pipeline-design.md` | `91504fac740d8b1b37df43333fbb64f0733bb128652555f3df98323909fd900e` | D，plan-review pipeline |
| `docs/superpowers/specs/2026-08-04-proactive-subagent-delegation-design.md` | `5e0228fa6073aab711cac544dd549440ed0ef0570351a07ba9372ae70d517437` | E，task/workflow boundary |
| `docs/long-session-latency-analysis.md` | `0fd71c4dc5ad665b65118f0d80381ee5800360c31b72ca0800715218e3048089` | Quantitative evidence base |
| `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md` | `42f8e15a22ae2c22f62be233200b2b2dcafd373b67f348303c60e56f39c269b9` | Prior Plan B design |
| `docs/superpowers/plans/2026-08-04-latency-delegation-docs-collective-subagent-review.md` | `d07eeeba8319d5094c0b3b75f1a35ecf9e0f27665450f2e382daf1efa0a4bea9` | Round 1 collective review |
| `/Users/sheng/.omp/agent/config.yml` | `1eb09e44cb35d1a2ad0dda2162c0e711d044e039e9e4c18fba9b070c756bd5f1` | Dated effective-settings receipt |

若 B/C/D/E 在并行 reviewer 批次中于本 manifest freeze 后发生变化，批次 coordinator 必须先更新对应 row，再重算 A canonical self-hash 与 whole-file SHA-256；旧 hash 不得保留为“输入快照”而不注明。

## Appendix B: Round 1 Findings Closure (Round 2 Revision)

### Blocking 1 — Control baseline: CLOSED

- §1.4 固定 `reviewed_at=2026-08-04` 与 config full-file hash。
- explicit：`task.agentModelOverrides`、`task.eager=preferred`、`task.batch=true`、`async.enabled=true`、`compaction.thresholdPercent=70`、`compaction.idleEnabled=true`。
- default-derived：`idleThresholdTokens=200000`、`defaultThinkingLevel=high`、`modelOptimization.enabled=false`。
- §2.4/§6.3 要求 config/code/prompt/model availability snapshot 与 clean-context/non-overlap 配对。

### Blocking 2 — Direction 1 canonical owner: CLOSED

- §4.1 激活现有 `modelOptimization` seam，落点为 `sdk.ts`、`session/agent-session.ts`、`workflow/tool-output-manager.ts`、`workflow/context-ledger.ts`、`tools/read.ts`。
- 1.c key 明确包含 branch/worktree、provider-view、content/revision、selector、renderer/output mode，并在 compaction/eviction/provider switch/rewind 后 reconcile。
- unknown view/hash/store failure fail open；无 `fresh`；无 `session/tool-output-processor.ts`；无 `performance.contextVolume.truncation.*`。

### Blocking 3 — Direction 4 versioned contract: CLOSED

- §4.4 定义 strict `WorkflowConcurrencyDeclarationV1`、DAG/paths/group/isolation/rendezvous、state transitions、join/quorum、backpressure、partial failure、cancel/resume、idempotency、receipts。
- lowering 明确到 `task/index.ts:697-718` + `task/parallel.ts:100-141` 或 workflow RuntimePort；无 `task-batch.ts`。
- hub `await:true` 只用于 `op:"send"`；`op:"wait"` 保持独立 operation。

### Blocking 4 — Plan-review shape: CLOSED

- §4.4.4 与 D 一致：一个强 reviewer 初评、同 profile/runtime identity 复审、结构化分歧仲裁/人工 fail-closed。
- plan prompt=`prompts/workflow/plan-reviewer.md`；code/patch prompt=`prompts/agents/reviewer.md`。
- 明确禁止 N-reviewer any-block，并限定并行只做 deterministic checks/evidence；§6.2 保留 D 五个独立 arms。

### Blocking 5 — Benefit labels and arithmetic: CLOSED

- §2.3 把 35% mechanical share 标为 `[未验证假设]`。
- `75.7×0.35×(1-4/16)=19.87125h` 标为 `[算术上限]`，统一报告 19.87h。
- eval 重算为 `(3.7×3600)/578=23.04s`。
- Flash/Grok≈4s、Sol/Luna≈16-17s、Terra 无实测；mechanical target=Flash。
- 其他方向不再虚构小时级收益。

### Major — A/B discipline, double ledger and manifest: CLOSED

- §6.2 每个 feature 独立 arm/switch/snapshot/rollback；D 五 arms分列；组合另记 combined arm。
- §6.3 同任务配对、随机/交叉、`lineage=clean-context`、control/treatment non-overlap、pilot≥30/正式≥100或预注册 CI。
- §6.4 canonical interval-union 与 legacy duration sum 双账本分离；requests/tokens/USD 使用 additive cost ledger。
- §6.5 质量 stop 包含下降 >2pp、返工 >10%、P0/P1 escape，并补合同/成本 hard stop。
- Appendix A 包含 A/B/C/D/E、两份 evidence/design 与 collective review；无 selector、绝对 session 路径或未解释占位符。

## Appendix C: Arithmetic and Unit Receipts

```text
Active top-level pools:
  174.3h gen + 92.0h TTFT + (306.6 - 174.3 - 92.0)h tools
  = 174.3 + 92.0 + 40.3
  = 306.6h

Mechanical routing conditional upper bound:
  75.7h × 0.35 × (1 - 4/16)
  = 75.7 × 0.35 × 0.75
  = 19.87125h
  → 19.87h

Eval historical mean:
  (3.7h × 3600s/h) / 578
  = 13,320 / 578
  = 23.0449827s
  → 23.04s

Prompt-size units:
  6,176 characters
  9,981 UTF-8 bytes
  characters ≠ bytes ≠ tokens
```

## Appendix D: Canonical Owner and Negative-Name Check

| Concern | Canonical owner | Explicitly prohibited alternative |
|---|---|---|
| ordinary context optimization | `modelOptimization` + `session/agent-session.ts` + shared workflow tool-output/context ledger seam | `performance.contextVolume.truncation.*`, `session/tool-output-processor.ts` |
| read dedupe invalidation | branch/worktree/provider-view/content/selector/renderer identities + lifecycle reconcile | `fresh` parameter |
| workflow static role split | workflow `model-router.ts` + `session-config.ts` + `quality-route-snapshot.ts` | second router; generic task rewrite; current-review feedback routing |
| task concurrency | `task/index.ts` + `task/parallel.ts` + existing semaphore/settings | `task-batch.ts`, second scheduler |
| workflow concurrency | PlanArtifact/work packages + WorkflowEngine/RuntimePort/ArtifactStore/SQLite | task self-built workflow state machine |
| bash retry evidence | one `BashAttemptLedgerV1` in existing bash/session result owner | Plan B tracker plus Direction 3 tracker |
| plan review | workflow `plan-reviewer.md`, one strong reviewer → same reviewer rereview → arbitration | N-reviewer any-block, task reviewer adapter |
| code/patch review | `prompts/agents/reviewer.md` | workflow plan-review schema |
| eval migration/overlap | existing eval bridges → parity-proven workflow/task owner + existing async/hub lifecycle | second eval engine; hidden/unowned background job; erased eval interval |

Round 2 restoration is complete: frontmatter, §§1-7, directions 1-5, Phase 0-3, verification/A/B, handoff, manifest, arithmetic receipts and round 1 closure are present. Final acceptance depends on the independent reviewer verifying the post-repair bytes and reporting the final SHA-256.
