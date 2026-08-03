# Design: omp 当前延迟保障评估与下一步优化方向

- Date: 2026-08-03
- Status: Draft (review round 1)
- Scope: M（文档与设计，无代码改动）
- design_author: deepseek-v4-flash:max（当前会话）
- design_author_identity: LatencyGapDesignAuthor
- planned_reviewer: gpt-5.6-sol xhigh native reviewer agent（与 author 异模型）
- revision_round: 1
- implementation_authorization: design-only（用户最终指令：现在不实现；核心重点列为后续方案必做项）
- authorization_source:
  1. 用户指令「将上述设计记录到文档中，并使用 gpt-5.6-sol xhigh 进行方案 review。包括背景等信息」。
  2. 用户明确核心重点（后续方案中**一定实现**的内容）：「上下文体积的事前管理，普通会话也做 tool-output truncation，workflow 门禁链并行化，甚至编排层并行，workflow 中每一次都可以尽可能地让主 agent 控制并主动发起并发，主 agent 控制边界及合理编排。上述这些是一定要实现的核心重点，其他酌情考虑，合理即可实现」。
  3. 用户后续澄清：「不要实现」= 当前会话不写代码；核心重点在后续方案中标记为必须实现的内容。
  本设计不修改生产代码、运行配置、已有文档、发布物或提交记录，仅新增本设计文档与评审 artifact。

## 1. 背景

### 1.1 数据来源与口径

本文的量化结论沿用 `docs/long-session-latency-analysis.md`（2026-08-03，全量会话分析）与 `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`（round 4）已核对的证据，不重新诊断：

- 语料：886 个会话 JSONL 解析出 689 个真实会话，活跃耗时 306.6h。
- 池分解（活跃耗时占比）：

| 根因 | 耗时 | 占比 | 关键事实 |
|---|---|---|---|
| 模型生成 gen | 174.3h | 57% | sol 17,205 轮，avg 29s/轮 |
| 首 token TTFT | 92.0h | 30% | sol avg 16s/轮；<50k 上下文 8.1s → 200-300k 28-29s → ≥350k 51s |
| hub 同步等待 | 21.3h / 3559 次 | 7% | 重点会话 avg 1.4m，常见 2-3m 满时长轮询 |
| bash 长尾+失败重跑 | 6.2h / 5534 次 | 2% | E2E 单次 3-5.5m，同命令重跑 ≥8 次 ≈ 30m |
| eval 异模型门禁 | 3.7h / 578 次 | 1.2% | 单次最长 13.9m |
| web_search | 3.7h / 285 次 | 1.2% | avg 47s/次 |

- 次要但关键的浪费：read 19,117 次，同一 design spec 被读 42 次、同一源文件 29 次（缓存命中 95.7% 是省钱不是省时）；compaction 触发点 316-371k tokens 过晚，会话长期运行在 200-300k。
- 量化标签约定：[历史事实] 直接来自分析文档或已核对的当前仓库能力；[算术上限] 数学上限非承诺；[推导] 需新会话证据确认；[未验证假设] 必须 A/B 检验；[拟议验收目标] 建议门槛非已达。

### 1.2 当前默认延迟保障机制（已生效，2026-08-03 复核 `~/.omp/agent/config.yml`）

```yaml
modelRoles:
  default: gateway/deepseek-v4-flash:max   # 普通主会话默认 = 低 TTFT 模型
  slow:    gateway/gpt-5.6-sol
  vision:  gateway/gpt-5.6-terra
  plan:    gateway/gpt-5.6-terra
  designer: gateway/gpt-5.6-terra
  commit:  gateway/gpt-5.6-luna
  task:    gateway/gpt-5.6-terra
  advisor: gateway/gpt-5.6-terra
```

- **模型路由**：`modelRoles.default = gateway/deepseek-v4-flash:max`。历史分析中 sol TTFT avg 16s/轮，flash 系 ~4s；默认主会话已是快速模型，sol 只保留在 `slow` 角色（显式选用时）。
- **上下文管理**：`compaction.thresholdPercent = 70`（历史触发点 316k+ 过晚，提前干预）+ `compaction.idleEnabled = true`（空闲预压缩，`idleThresholdTokens=200k`）。
- **并行调度**：`async.enabled = true`、`task.eager = preferred`、`task.batch = true`；hub wait 为 `Promise.race(job promise / IRC waiter / timeout / abort)` 事件驱动，非轮询；smart 等待阶梯 `[5s,10s,30s,60s,300s]`。
- **auto-thinking（本会话新核实，常被忽略）**：`packages/coding-agent/src/auto-thinking/classifier.ts` 已存在 per-prompt 难度分类器——每轮把 prompt 分类为 `low|medium|high|xhigh` effort 并 clamp 到活动模型支持范围；online 后端用 smol 模型分类（`providers.autoThinkingModel` 默认 online）。这是对 gen 时间（最大池）的**按轮动态 effort 控制**，普通会话已默认启用。相关佐证：CHANGELOG「Fixed unnecessary prompt-cache invalidations by preserving the active auto-thinking effort level when per-turn classification fails」。
- **workflow 层**：质量路由（`workflow.qualityRoutes`、role overrides、quality route snapshot、provider-attested receipts）已存在；work package 自动并行、CWL 上下文驱逐、tool-output 截断/摘要、ContextLedger exact-hash 去重（`packages/coding-agent/CHANGELOG.md` Unreleased 段）均已落地在 workflow 路径。

### 1.3 上一轮设计（long-session-performance-optimization）要点

`docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`（round 4）已做三方案对比并推荐**方案 B**：窄 runtime guardrail 路径——4 层落地（观察 control → 配置 arm → 窄 guardrail → A/B 推广）+ 5 个独立 feature（`promptPolicy`、`compaction.targetTokens=200k`、`asyncWait.smartMaxSeconds=60`、`bashFailureAdvisory`、`evalBudget` 600s/2 calls），全部默认关闭、可独立回滚。本设计不重复该文档的方案对比，只在其基础上做两件事：①评估「当前默认措施」覆盖度；②识别比方案 B 更值得投入的方向。

## 2. 现状评估：当前默认措施是否足够

**结论先行：当前默认措施能防最坏情况，但只覆盖了模型池的一部分；对 gen 池的杠杆有限，对验证重跑、eval 门禁、重复 read 是零覆盖。**

覆盖矩阵（池 × 当前手段）：

| 历史池 | 占比 | 当前默认手段 | 覆盖度 | 残余 |
|---|---|---|---|---|
| gen 174.3h | 57% | auto-thinking 按轮调 effort；workflow 角色路由 | 部分 | effort 有下限且不换模型；sol 角色（designer/reviewer）每轮仍 gen 29s + TTFT 16s；`slow` 角色保留全量 sol |
| TTFT 92h | 30% | `default=flash`（主会话 16s→4s）；compaction 70% + idle | 主会话充分，高价值角色不足 | designer/reviewer 等 sol 角色轮次不覆盖；70% 阈值是否真正避免 200-300k 桶未验证（[未验证假设]） |
| hub 21.3h | 7% | async.enabled / task.eager / task.batch / 事件驱动 | 一半 | workflow 评审门禁链串行；真实子代理运行时间不可消；smart 顶值 300s 的空等长尾 |
| bash 6.2h | 2% | 无 | 零 | 同失败重跑 8 次 ≈ 30m 纯浪费 |
| eval 3.7h | 1.2% | 无 | 零 | 父会话阻塞门禁，单次最长 13.9m |
| web_search 3.7h | 1.2% | 无 | 零 | avg 47s/次，无合并无缓存 |
| 重复 read（燃料） | — | **无机制性手段** | 零 | 普通会话 read 无 content dedupe（本会话 grep 核实：去重仅存在于 advisor 与 workflow ContextLedger）；同一 spec 42 次重读 |

关键判断：

1. **[历史事实] 当前手段是「防御性」的**：flash 主模型防 all-sol 主会话、70% 阈值防 316k 过晚压缩、async 防串行空等。它们防止最坏情况，但没有主动削减任何池。
2. **[推导] gen 池基本未被触碰**：auto-thinking 只调 effort 不换模型；低价值轮次在 sol 上仍是 16s TTFT + 29s gen。174.3h 是最大池，当前默认对其杠杆最小。
3. **[推导] 上下文体积是 TTFT 膨胀的燃料**：compaction 是事后补救（阻塞、重写历史、有成本），重复 read（42 次同一 spec）是让上下文涨到 200-300k 的直接原因；没有「事前」手段阻止膨胀。
4. **[历史事实] 方案 B 也是「事后」导向**：5 个 feature 全部是压缩、cap、advisory、budget——没有一个直接作用于 gen 时间或上下文体积的事前机制。即使方案 B 全量落地，也覆盖不到 gen 174.3h 池。

## 3. 方案 B 深入（已有设计核心机制，供 review 对照）

方案 B 细节已在 long-session-performance-optimization-design.md round 4 定稿，此处仅列 review 需要对照的关键机制：

- **5 个独立 feature，全部默认关闭**，`performance.longSession` 只是配置 namespace 不是新引擎；每个 leaf 由既有 owner 消费（compaction→session-maintenance、wait→job-manager/hub、bash→executor、eval→bridge、prompt→system-prompt）。
- **compaction**：`targetTokens=200000` 仅作 session target，实际值受 context window - reserve 约束，不匹配则回 control 并记录 fallback；不做 sidecar compactor。
- **asyncWait**：不改变 `Promise.race` 完成事件与 auto-delivery，只 cap 无完成事件时的 smart 空等顶值（`smartMaxSeconds=60`）；重复 wait 返回 pending/advisory，不把 pending 当成功。
- **bashFailureAdvisory**：安全 fingerprint（不可逆 digest，不含 secret）；重复失败仅附加 advisory，保留执行、`isError`、exitCode、artifact——**绝不硬阻断**。
- **evalBudget**：预算单位 = 外层 `EvalTool.execute`；started 事件须**先经 awaited durable barrier 落盘再调用**（`appendCustomEntry` 的异步写入失败是热路径捕获的，返回 entry id 不代表已落盘），无 durable 记录即不启动（`eval_budget_count_write_failed`）；`usedCalls` 唯一 durable source 是 started 事件流，branch-aware receiver 从 active branch 恢复，rewind/fork 不污染；resume 无法证明事件流完整 → fail closed。
- **promptPolicy**：一次性 gated system block；4 个静态 tool prompt 资产字节不变（off 时与 control 字节等价）；记录 prompt token delta。
- **质量停止条件**：任何 feature 造成完成率/独立 review/确定性 verifier 相对 control 下降 >2pp、重复 read/repair 上升 >10%、lineage 独立性破坏，立即关闭对应 feature。

**方案 B 的盲区（[推导]）**：5 个 feature 的预期收益全部来自「减少等待/重跑」——compaction 省 TTFT 桶迁移、wait cap 省空等、advisory 省重跑、budget 防长尾。它们不改变 gen 时间、不阻止上下文膨胀的源头（重复 read）、不降低 sol 角色轮次的固定 TTFT。按池分解，方案 B 能直接作用的池约为 hub 21.3h + bash 6.2h + eval 3.7h 的可消除部分，即历史活跃耗时的 ≤10%；对 87% 的模型池（gen+TTFT）只通过 compaction 间接作用。

## 4. 更值得做的优化方向

### 4.0 用户指定的核心范围（后续方案必做项，2026-08-03）

用户明确以下为后续实现**必须包含**的核心重点（本设计仅记录范围与优先级；当前会话维持 design-only，不写代码）：

1. **上下文体积的事前管理**——普通会话也做 tool-output truncation（不等 compaction 才裁剪，输出进上下文前止血）；
2. **workflow 门禁链并行化**，乃至编排层并行；
3. **主 agent 控制并发边界与合理编排**——workflow 中每一次（每个阶段/门禁）都尽可能地由主 agent 控制并主动发起并发。

其余方向（§4.2 角色静态细分、§4.3 验证闭环、§4.5 eval 迁移）由实现者酌情考虑，合理即可实现。下文各方向按此优先级呈现，核心项标注为【必做】。

### 4.0.1 用户后续设计决定（2026-08-03，修订 round 2 前）

以下三条为用户在 round-1 review（NEEDS_REVISION）之后、修订发起前明确给出的设计决定，后续修订与复审必须遵守：

- **决定 A：lineage 独立 stop condition 重新定义**。stop condition「reviewer/implementer lineage 独立」实际担忧的是 **agent 自审**（作者用自己的上下文评审自己的作品）。新开 subagent 做新 review、不包含之前上下文的干净独立 review，即使同模型族也算独立。后续所有 reviewer 独立性、lineage 与停止条件条款按此定义修订（独立性 = 干净上下文的新 subagent review，而非必须异模型）。
- **决定 B：方向二分流路由目标改为 `gateway/deepseek-v4-flash:max`（非 luna）**。机械/格式类工作路由到 flash——质量相当、耗时大幅下降（flash TTFT ~4s，luna 16-17s，见 §1.1）。方向二的收益算术按 flash 4s 重算（非 luna 的 16-17s）。
- **决定 C：round-2 复审模型改用 deepseek-v4-flash**。round-2 review 由 `gateway/deepseek-v4-flash`（新开干净 subagent，`.omp/agents/flash-reviewer.md`，无先前上下文）执行，不再触发 sol-xhigh（round-1 已由其完成）。

### 4.1 方向一：上下文体积的事前管理（最高隐藏杠杆，机制性、不依赖模型配合）【必做】

- **依据**：[历史事实] TTFT 随上下文膨胀（<50k 8.1s → 100-150k 19.6s → 200-300k 28-29s → ≥350k 51s），影响**所有模型所有轮次**；[历史事实] 同一 spec 被 read 42 次、同一源文件 29 次；[当前能力事实] 普通会话 read 无 content dedupe，workflow 已有 ContextLedger exact-hash 去重。
- **子项**：
  1. **read 去重/指纹下放**：把 workflow 的 exact-hash 去重 seam 下放到普通会话 read——内容未变时返回「已在上下文中」标记而非重新注入。机制性防重读，比提示词纪律可靠。[推导] 影响所有后续轮次的注入体积。
  2. **结论传递走 memory-bank / local://**：重读根因是「结论没记住」而非「文件没读过」；评审结论、已确认契约走本地 artifact，避免整文件重读。[推导] 直接消除 42 次重读类浪费。
  3. **普通会话 tool-output truncation（用户指定核心重点）**：workflow 的 tool-output truncation/summarization 已存在（CHANGELOG Unreleased：`processToolOutputDetailed`、per-model `ToolStrategy`、CWL eviction），普通会话没有；不等 compaction 才 shake，在输出进上下文前止血。这是用户明确要求必须实现的子项。【必做】
- **实施设计（文件级）**：
  - 工具结果处理 seam：把 workflow 已有的 truncation/summarization 提取为共享工具函数（`processToolOutputDetailed` 等价物），普通会话在 tool result 进上下文前按 token 预算裁剪；被裁剪部分保留 `artifact://` 可恢复地址与 `[truncated: X/Y tokens]` 标记，恢复语义与 workflow 现有实现一致（不建第二套）。
  - read 去重（子项 1）：`tools/read.ts` 记录 session-scoped `sha256(path + content)` 指纹 + LRU；内容未变时返回紧凑标记「已在上下文中（第 N 次读取，M tokens）」，不重新注入全文；文件变化或显式 `fresh` 请求时失效。
  - settings：`performance.contextVolume.*`（默认关闭）：`readDedupe.enabled`、`truncation.enabled`、`truncation.maxTokens`、`artifactRecovery.enabled`。
  - receipt：每轮记录 dedupe 命中/注入 token 数/truncation 事件，进 session/artifact 现有途径。
- **实施步骤**：①提取共享 truncation 函数（字节等价复用 workflow 实现）→ ②read 指纹去重 → ③普通会话装配 → ④receipt + focused tests → ⑤A/B arm。
- **为什么比方案 B 的 compaction 更值得**：compaction 是把已膨胀的上下文压回去（每次都有成本 + 一致性风险），事前管理是「别让它膨胀」；方向一影响全部轮次（含 sol 角色），不依赖模型行为改变（机制性）。
- **风险**：指纹误判（文件实际变化被当未变）→ 需内容哈希 + 显式 invalidation；裁剪过度丢失信息 → 与 workflow 相同的 gate 与可恢复 `artifact://` 语义。
- **验收**：[拟议验收目标] 同任务 control/treatment：平均每轮注入 token 下降、ctx≥200k 轮次占比下降、重复 read 次数下降、TTFT P50/P95 在受影响轮次下降 ≥10%，返工/遗漏不上升 >10%。

### 4.2 方向二：高价值角色的静态细分（直接碰 174.3h gen + 75.7h sol TTFT）

- **依据**：[历史事实] sol 17,205 轮 gen 136.9h（avg 29s）+ TTFT 75.7h（avg 16s）；[当前能力事实] `slow`/designer/reviewer 角色一刀切 sol；FindingTracker 已有 reasoning/mechanical repair 分流 seam；`workflow.qualityRoutes.<tier>.<role>` 已是 ordered profile lists。
- **手段**：不引入方案 C 的动态单轮路由（遵守 long-session 设计约束），在**现有 role/tier seam 内细分**——机械性修复、格式/一致性类 review 走 luna/terra（TTFT ~4s），深度架构 review 才走 sol。auto-thinking 已按轮调 effort 但不换模型；静态角色细分是文档约束内唯一还能省 sol TTFT 的手段。
- **风险**：低难度任务被误送低模型导致质量回归 → 显式 task class/severity 分流 + 独立 review 硬停止；与方向一同一轮 TTFT 的收益不双算（分层 arm）。
- **验收**：同任务 A/B：sol 轮次占比下降、TTFT/gen P50/P95 下降、review pass 率与完成率不劣化 >2pp。
- **实施设计（文件级）**：
  - `packages/coding-agent/src/session/role-models.ts` / `config/model-resolver.ts`：role/tier 内静态细分——按显式 task class / finding severity 选择模型档位（机械/格式类 → luna/terra，深度推理类 → sol）；不引入按单轮价值猜测的动态路由。
  - `packages/coding-agent/src/workflow/finding-tracker.ts`（或等价）：把已有 reasoning/mechanical repair 分流扩展到 review 严重度分流（P0/P1 → sol，P2/P3 机械项 → 快模型）。
  - settings：`workflow.qualityRoutes.<tier>.<role>` 扩层或 `modelRoles` 细分角色（如 `reviewer.mechanical` / `reviewer.deep`）；显式分流不靠 LLM 自猜。
  - 关键不变量：reviewer 与 implementer 异 lineage、provider attestation、effort 支持事实由 catalog 校验；任何分流变更都进 routing audit。
- **实施步骤**：①定义显式 task class/severity 分类 → ②role route 扩展 → ③receipt/audit → ④focused tests → ⑤A/B arm（与 auto-thinking 对 gen 的影响分层，不双算）。
- **评审质量约束**：「弱草稿 PASS 早」是评审偏置而非质量证据（§8.1.4），不得作为快速模型合格的验收依据；分流后的快速评审必须携带反锚定清单与规格锚定 FAIL（§8.2）。

### 4.3 方向三：验证闭环的机制化（确定性最高、成本最低）

- **依据**：[历史事实] E2E 同命令重跑 ≥8 次 ≈ 30m；bash 池 6.2h；[历史事实] 长尾多为「Running critical E2E」→「Rerunning critical E2E」→「Verifying…」同命令反复。
- **手段**：方案 B 的 advisory 太弱（模型可无视）；机制化做法是**失败原因注入**——bash 失败后把上次失败输出摘要（裁剪、去 secret）自动附加到下一次同命令调用的上下文，模型看到原因才能决定是否重跑；配验证命令分层（定向先行 → 全量）。设计 1.4 已排除硬阻断，方向是 smart 重跑而非禁重跑。
- **风险**：摘要注入增加上下文（需 ≤ 固定 token 预算，超限则退化为仅 advisory）；合法环境修复重跑被误标（fingerprint 含命令+cwd+输入，变化即新 fingerprint）。
- **验收**：同 fingerprint 重跑次数下降、失败总时长下降、合法重跑零误抑制、上下文增量在预算内。

### 4.4 方向四：workflow 门禁链并行化（21.3h hub 池的真实部分）【必做】

- **依据**：[历史事实] hub 21.3h/3559 次，重点会话 103 次 avg 1.4m，几乎每次满 3m 超时；[当前能力事实] hub 已事件驱动 + auto-delivery，work package 自动并行已落地。
- **用户指定**：门禁链并行化乃至**编排层并行**，workflow 中每一次都尽可能地由**主 agent 控制并主动发起并发**——主 agent 控制并发边界与合理编排。这是用户明确要求必须实现的内容。【必做】
- **手段**：plan_review / code_review 当前单 reviewer 串行——多 reviewer 并行评审是真实独立切片（走现有 task batch），配合 `await:true` 事件驱动替代满时长轮询。只消「串行链空等」，不消子代理真实运行时间（不与 child runtime 双算）。并发边界（并发上限、依赖顺序、隔离范围）由主 agent/编排层显式控制，不隐式猜测。
- **风险**：并行 review 产出冲突/重复 finding → 引擎侧 finding dedupe（advisor 已有 dedupe 模式可参考）；评审语义必须与串行等价。
- **验收**：父会话 blocked interval 下降、门禁链关键路径缩短、finding 质量与独立性与串行一致。
- **实施设计（文件级）**：
- `packages/coding-agent/src/workflow/engine.ts`：plan_review / code_review 阶段支持 N 个独立 reviewer **并行**发起，汇合点聚合 verdict；finding 合并/去重（复用 advisor dedupe 模式）；门禁结果与串行语义等价。
- `packages/coding-agent/src/task/task-batch.ts`：编排层并发边界——maxConcurrent、依赖图、隔离范围由**主 agent 显式声明**（并发组、数量、汇合点），引擎执行；不隐式猜测并行边界。
- hub `await:true` 事件驱动（已存在）替代满时长轮询：wait 只在 job 未完成时阻塞，完成即返回。
- settings：`performance.orchestration.*`（默认关闭）：`parallelReview.enabled`、`parallelReview.maxConcurrent`、`concurrencyDeclaration` 合同。
- receipt：每次并行发起记录声明边界、实际并发、汇合结果，进 routing audit 现有途径。
- **实施步骤**：①gate 并发原语（显式并发组声明）→ ②reviewer 并行 + finding 聚合/去重 → ③work package/独立切片并行 → ④receipt + focused tests → ⑤A/B arm（父 blocked interval 与非 overlap ledger）。
- **评审质量约束**：并行放大的每个 reviewer 均须满足 §8 反锚定清单（一致性要求），避免并行放大攻击面偏置；finding 去重时保留规格引用。

### 4.5 方向五：eval 门禁迁出 bridge（单次最长 13.9m）

- **依据**：[历史事实] eval 3.7h/578 次，Aegis 会话 2.51h/22 次 avg 6.8m，单次最长 13.9m；[当前能力事实] bridge 调用期间 `withBridgeTimeoutPause` 暂停 cell timeout，父会话全程阻塞。
- **手段**：异模型门禁改走 native task/workflow 后台 job（父会话不阻塞，显式 artifact/identity receipt 汇合）；方案 C 才有完整异步设计，但「门禁走 workflow 而非 eval」的纪律与路由可先行，零风险。
- **风险**：native workflow 与 eval 门禁的判定语义差异 → 需 receipt 等价性验证。
- **验收**：父会话 eval 阻塞区间消失、门禁质量（拒绝率/通过率）与 bridge 路径一致、`agent()` inline/isolation 语义不变。

### 4.6 优先级与取舍

| 方向 | 作用池 | 杠杆 | 可行性 | 与方案 B 关系 | 用户优先级 |
|---|---|---|---|---|---|
| 一：上下文体积事前管理（含普通会话 truncation） | TTFT 92h（全部轮次） | 高 | 高（复用 ContextLedger/truncation seam） | 互补，方案 B 未覆盖 | **必做** |
| 四：门禁链/编排层并行 | hub 21.3h 的可消部分 | 中 | 中 | 互补，方案 B 只 cap 空等 | **必做**（主 agent 控制并发边界） |
| 二：高价值角色静态细分 | gen 174.3h + sol TTFT 75.7h | 高 | 中（需 task class/severity 分流） | 互补，方案 B 未覆盖 | 酌情 |
| 三：验证闭环机制化 | bash 6.2h + 重跑浪费 | 中高 | 高 | 强化方案 B 的 bashFailureAdvisory | 酌情 |
| 五：eval 门禁迁移 | eval 3.7h | 中 | 高（纪律先行） | 替代方案 B 的 evalBudget 方向 | 酌情 |

**推荐顺序**：[推导] 必做项（方向一、方向四）优先：方向一与方向三（酌情）机制性、低风险、影响面广；方向四与主 agent 并发编排（必做）在 workflow 编排 seam 上落地，门禁链并行与并发边界由主 agent 显式控制。方案 B 的 5 个 feature 作为低风险第一轮 arm 保留，但不应作为性能目标的全部。所有方向沿用同一 A/B 方法：control/treatment 同任务分层、non-overlap interval ledger、单 feature marginal delta、组合只报 `S_combined`、每项独立开关与回滚。

### 4.7 收益量化分析（哪些方向收益大）

以下按历史池的**算术上限**估算各方向可得收益，不双算、不与方案 B 池相加；实际收益必须经 control/treatment A/B 确认，[算术上限] 不是承诺。

| 方向 | 作用池 | 算术上限（数学量） | 计算依据 | 风险 | 可行性 | 用户优先级 |
|---|---|---|---|---|---|---|
| 二：角色静态细分 | gen 174.3h + sol TTFT 75.7h | **40-60h**（若 30-40% sol 轮次静态路由到 luna/terra：TTFT 75.7×0.35≈26h + gen 保守 15% 降≈20h） | sol 17,205 轮 avg gen 29s + TTFT 16s；快模型 TTFT ~4s | 高（质量/lineage） | 中 | 酌情（但收益最大，重点设计） |
| 一：上下文体积事前管理 | TTFT 92h（全部轮次） | **10-18h**（若 30% 轮次从 ≥200k 桶迁到 <100k：92×0.3×(13.5s/29.1s)≈13h；含 100-150k 桶部分迁移） | TTFT 29.1s(≥200k) → 15.6s(<100k)，每轮省 13.5s；影响全部模型 | 低 | 高 | **必做** |
| 四：门禁链/编排层并行 | hub 21.3h | **7-10h**（30-50% 为串行空等/满时长轮询可消；子代理真实运行时间不消） | 重点会话 103 次 avg 1.4m，常见满 3m 轮询 | 中 | 中 | **必做** |
| 三：验证闭环机制化 | bash 6.2h + 重跑浪费 | **3-6h**（E2E 重跑 ≥8 次 ≈ 30m/会话级） | 同命令重跑 8 次 ≈ 30m；bash 池 6.2h 含重跑 | 低 | 高 | 酌情 |
| 五：eval 门禁迁移 | eval 3.7h | **2-3h**（父会话阻塞区间消除） | eval 578 次 avg 6.4s 后长尾单次 13.9m；Aegis 2.51h/22 次 | 低 | 高 | 酌情 |

**结论**：[推导] 收益排序为 **方向二 > 方向一 > 方向四 > 方向三 > 方向五**。方向二收益最大但风险最高（需质量/lineage 门禁兜底）；方向一（必做）是收益第二且风险最低的机制性手段；方向四（必做）收益第三。用户指定的核心范围（一、四）恰好覆盖「风险低、机制性」的高收益项，而收益最大的方向二被列为酌情——本设计建议：方向二在角色分流 seam 成熟后作为**重点后续项**深入设计（见 §4.2 实施设计），与必做项一、四并行推进；三、五实现成本低可顺带落地。各方向收益**不得相加**（同一轮 TTFT 可能被一、二同时影响），组合 arm 只报 `S_combined`。

## 5. 验证计划

- **历史复算**：沿用 long-session-latency-analysis.md 口径（689 会话、306.6h、字符/字节/token 单位分离）建立 control；[未验证假设] 当前配置对历史 all-sol 池的残余需新会话 receipt 确认。
- **Focused contract tests**：
  - 方向一：read 指纹去重的 hit/miss/invalidation、裁剪后 `artifact://` 恢复、注入 token delta；
  - 方向二：role/tier 分流的 lineage/identity/effort receipt、低难度误送检测、独立 review 硬停止；
  - 方向三：fingerprint 稳定性、失败摘要去 secret、合法重跑零误抑制、上下文预算；
  - 方向四：并行 review 与串行 finding 等价、dedupe、父 blocked interval；
  - 方向五：native workflow 门禁与 bridge 判定等价、`agent()` 语义不变。
- **A/B 指标**：P50/P95 active critical-path per session、per 100 turns、normalized active hours per 100 sessions；TTFT/gen 按 model configured/local/attested + context bucket 分层；质量守卫（完成率/verifier/独立 review 不劣化 >2pp、返工/重复 read 不上升 >10%）与停止条件同 long-session 设计 §6.4。
- **不双算**：compaction 与方向一作用于同一轮 TTFT 时用分层/factorial arm 报交互项；方向二与 auto-thinking 对 gen 的影响不重复扣减；门禁链节省不含子代理真实执行时间。

## 6. 关键决策摘要

- 当前默认措施（flash 主模型 + compaction 70% + async 并行 + auto-thinking）是有效的防御基线，但**不足**：87% 的模型池只被部分覆盖，验证重跑/eval/重复 read 零覆盖。
- 方案 B 全部为「事后」guardrail，预期直接作用 ≤10% 历史活跃耗时；不改变 gen 时间、不阻止上下文膨胀源头。
- 更值得做的方向（按杠杆）：①上下文体积事前管理（read 去重下放 + 结论走 memory/local + **普通会话 tool-output truncation**）；②高价值角色静态细分（role/tier 内分流，不引入动态单轮路由）；③验证闭环机制化（失败原因注入，强化而非替代 advisory）；④**门禁链/编排层并行（主 agent 控制并发边界）**；⑤eval 门禁迁出 bridge。
- **用户指定的后续实现核心范围（必做）**：①普通会话 tool-output truncation（上下文体积事前管理）；②workflow 门禁链并行化与编排层并行；③workflow 每一步由主 agent 控制并主动发起并发，主 agent 控制并发边界与合理编排。其余方向（角色静态细分、验证闭环、eval 迁移）酌情实现。当前会话 design-only，不写代码。
- **收益量化结论**：[算术上限] 方向二（角色静态细分）40-60h > 方向一（上下文体积事前管理）10-18h > 方向四（门禁链并行）7-10h > 方向三 3-6h > 方向五 2-3h。核心必做项一、四覆盖「风险低、机制性」高收益；收益最大的方向二列为重点后续项深入设计（§4.2）；收益不得相加，组合 arm 只报 `S_combined`。
- 所有方向复用现有 canonical owner，独立开关、A/B、回滚纪律与 long-session 设计一致；不新增第二套路由/压缩/等待/缓存/验证引擎。
- 本设计为 design-only；review 后无论 verdict 如何均停止在设计阶段。
- 评审质量约束（2026-08-04 用户补充，§8）：评审 PASS 是「内部一致性」信号而非「最优性」信号；所有评审路径必须携带反锚定清单（列草案未覆盖维度）+ 规格锚定 FAIL + PASS 证据密度；评审-refine 1-2 轮封顶，分歧升级强模型重写。

## 7. Handoff

### 7.1 评审约定

- 评审输入：本设计文档（docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md）+ 其引用输入（docs/long-session-latency-analysis.md、docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md）。
- 评审模型：gpt-5.6-sol xhigh（用户明确指定），与 author（deepseek-v4-flash:max）异模型。
- 评审范围含用户指定的核心范围（§4.0）：上下文体积事前管理（普通会话 truncation）、workflow 门禁链/编排层并行、主 agent 并发编排边界——评审其杠杆、风险、实现边界与必做/酌情划分是否合理。
- 评审范围含 2026-08-04 用户补充的 §8（评审质量背景与反锚定清单需求）——核验「PASS 早 ≠ 质量高」的机制判断、§8.2 清单的可行性，以及 §4.2/§4.4 的联动约束。
- 评审方式：宿主原生只读 review agent（`.omp/agents/sol-xhigh-reviewer.md`），不通过 shell 启动模型 CLI，不由 author 自审。
- 评审必须覆盖：背景事实准确性、现状评估（覆盖矩阵）合理性、方案 B 盲区判断、方向一~五的杠杆/风险/验收、推荐顺序、不双算规则、A/B 与停止条件。
- 评审结论四选一：PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN，附可复查证据。
- review artifact 持久化到 `docs/superpowers/plans/2026-08-03-latency-defaults-gaps-review.md`。

### 7.2 新会话恢复 prompt

```text
请读取评审输入集合（docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md，及其引用的 docs/long-session-latency-analysis.md 与 docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md），使用 repo-relative POSIX path。对每个输入计算 lowercase SHA-256，生成 Reviewed Inputs manifest（UTF-8 `<path>\t<sha256>\n` 序列化后整体哈希为 reviewed_revision），禁止伪造尚不存在的哈希。

按设计文档 §7.1 的评审约定，用 gpt-5.6-sol xhigh（异模型于 author deepseek-v4-flash:max）做只读 Design Review：核验背景事实（689 会话/306.6h/池分解/当前配置/auto-thinking 存在性）、覆盖矩阵与「方案 B 只作用 ≤10%」判断、方向一~五的杠杆与风险、推荐顺序、不双算与停止条件。结论必须且只能是 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一，附证据。artifact 写入 docs/superpowers/plans/2026-08-03-latency-defaults-gaps-review.md。

本设计 implementation_authorization=design-only；评审完成后无论 verdict 如何都停止，不进入实现、不修改仓库代码。
```

## 8. 评审质量背景与反锚定清单需求（2026-08-04 用户补充）

### 8.1 背景思路：评审质量的调研结论

针对「多模型评审 vs 单模型」「弱草稿+强评审 vs 强直接生成」的调研与用户反馈，结论如下（[文献] 外部研究；[本仓库观测] 本仓库事实；[推导] 推断）：

1. **多模型投票不是普遍成立的**。[文献] MoA（arXiv 2406.04692，纯开源模型分层集成 AlpacaEval 2.0 LC win rate 65.1% > GPT-4o 57.5%）与 Self-Consistency（Wang et al. 2022，GSM8K +17.9%）的增益集中在**可验证答案类任务**，且依赖模型不同源、有聚合层；普林斯顿 Self-MoA（arXiv 2502.00674）显示混合弱模型反而拉低均值——**质量 > 多样性**。
2. **弱草稿+强评审受草案覆盖度封顶**。[文献] 评审锚定在草案框架内：草案未覆盖的维度评审无从挑错；Huang et al.（ICLR 2024）显示无外部反馈的纯内部评审在推理任务上会降质——方案评审正属此风险区。
3. **强草稿+强评审是开放质量类任务中上限最高的配置**。[文献] Self-Refine（NeurIPS 2023）同强模型 draft→critique→refine 平均 +20% absolute over 一步生成；CriticGPT（OpenAI 2024）证明强评审对强输出有真实增量（63% 案例评审更被标注者偏好）。但收益递减，评审-refine 1-2 轮封顶；可验证任务上采样投票更稳（arXiv 2607.28576）。
4. **[本仓库观测] flash 出稿 + gpt-5.6-sol 评审的 PASS 早于 opus 出稿 + gpt-5.6-sol 评审**。[推导] 这不是弱草稿质量更好，而是评审偏置，三个机制：①**攻击面偏置**——评审是「找错」任务，输出量随被评审内容丰富度膨胀，平庸草稿找不到足够的错；②**遵从度不对称**——弱模型对 FAIL 意见顺从、快速收敛，强模型抵抗、收敛慢；③**家族偏置**——gpt-5.6-sol 对 claude 系（竞争家族）更挑剔（[文献] Yang et al. 2026 量化 judge 自偏好）。

**结论：[推导] 评审 PASS 是「内部一致性」信号，不是「最优性」信号；PASS 早 ≠ 方案质量高。** 把「更早 PASS」当作快速模型合格的验收证据，会系统性偏袒弱草稿。

### 8.2 反锚定清单需求（评审 prompt 必做项）

适用对象：本设计全部评审路径——§4.2 方向二的分流评审、§4.4 方向四的并行评审、以及后续方案的 review 门禁（`.omp/agents/flash-reviewer.md`、`.omp/agents/sol-xhigh-reviewer.md`、`prompts/agents/reviewer.md` 等价物）。每条评审必须满足：

1. **反锚定清单**：显式列出「草案**未覆盖**的约束、风险、备选方向」，而不是只对照草案找错——只挑错 = 困在草案框架内。
2. **规格锚定 FAIL**：每个 FAIL/NEEDS_REVISION 意见必须引用被违反的具体规格条目（如「违反 §4.1 子项 1 的 X」）；禁止无规格依据的泛泛意见。
3. **PASS 判定标准**：PASS 基于逐条核对规格清单，而非「没找到足够的错」；评审结论附证据密度（核对条目数、提出问题的具体条目数）。
4. **收敛控制**：评审-refine 循环 1-2 轮封顶；分歧/高风险样本升级强模型重写，不在弱模型上反复打磨。
5. **可验证维度走客观检查**：测试/lint/规格 check 是客观锚点，LLM 评审只负责开放维度。

### 8.3 对本设计各方向的联动

- §4.2 方向二（机械类 review 走 luna/terra）：分流后的快速评审必须携带 §8.2 清单；「弱草稿 PASS 早」不得作为快速模型合格的验收依据。
- §4.4 方向四（并行评审）：并行放大的每个 reviewer 均须满足 §8.2，避免并行放大攻击面偏置；finding 去重时保留规格引用。
- 验收补充：涉及评审路由/并行的 arm，质量守卫增加「PASS 证据密度」与「反锚定清单遵守率」两项观察指标。
