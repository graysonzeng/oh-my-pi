# Design: omp 长会话性能优化

- Date: 2026-08-03
- Status: Draft (revised, round 4)
- Scope: M
- design_author: deepseek-v4-flash:max（round 1 作者为 gpt-5.6-luna；round 2 按用户指令修订职责移交 deepseek-v4-flash:max，其余流程不变）
- design_author_identity: LongSessionDesignAuthor
- planned_reviewer: gpt-5.6-sol native reviewer agent
- revision_round: 4
- revision_basis: round 1 verdict NEEDS_REVISION（`...-subagent-review.md`：阻塞项 1/2/3 + Notes 1–4）；round 2 verdict NEEDS_REVISION（`...-subagent-review-round-2.md`：usedCalls 单一 durable source 与 branch-aware resume dispatch）；round 3 verdict NEEDS_REVISION（`...-subagent-review-round-3.md`：durable write barrier 与 reconcile 单位不匹配）
- implementation_authorization: design-only
- authorization_source: 用户明确要求“输出为评审用设计文档……不要直接改代码”；round 2 授权：“修订文档从 gpt-5.6-luna 改为 deepseek-v4-flash:max 来进行，其他不变”

## 1. 设计目标和范围

### 1.1 要解决的问题

本设计针对 omp 长会话中模型等待、上下文膨胀、子代理门禁等待、验证失败重跑、桥接式异模型调用和外部搜索造成的墙钟与活跃耗时，提出一条可配置、可 A/B、可独立回滚的最小充分优化路径。

文档中的量化结论使用以下标签，避免把历史观察误写成未来承诺：

- **[历史事实]**：直接来自 `docs/long-session-latency-analysis.md` 或 brief 已核对的当前仓库能力。
- **[算术上限]**：把历史池乘以假设比例得到的数学上限，不是本设计或实现的承诺。
- **[推导]**：由事实和现有控制流得到、仍需要新会话证据确认的判断。
- **[未验证假设]**：必须通过新会话 baseline 或 A/B 检验的前提。
- **[拟议验收目标]**：本设计建议的推广门槛，不表示已经达到。

目标按优先级排列：

1. 缩短新长会话的 P50/P95 活跃耗时、模型 TTFT 和墙钟耗时，并报告按会话数和轮次数归一化的总小时数。
2. 保持质量门禁、异模型独立性、确定性验证、会话一致性和失败可诊断性；性能优化不能把失败改写成成功。
3. 复用当前模型角色/质量层级、compaction、hub、bash、eval 和 web search canonical owner，不建立第二套路由、等待、压缩、缓存或验证引擎。
4. 先以当前有效配置建立新会话 control，再评价历史优化池还剩多少；历史 689 会话只作为背景，不直接作为新增收益分母。

### 1.2 成功标准

以下是**[拟议验收目标]**，需在新会话 A/B 后确认，不能在设计阶段宣称已达到：

- 使用当前配置建立 control，并在相同任务分层、相同模型可用性和相同确定性验证合同下收集 treatment；历史语料能够按原分析方法重算，关键计数和活跃时间在舍入误差内可复现。
- 初始 pilot 每个主要 arm 至少包含 30 个可比且完成的会话；P95 在该阶段只作趋势证据，正式推广建议每个主要 arm 至少 100 个可比会话，或使用预先登记的置信区间替代固定样本数。
- treatment 相对当前 control：P50 活跃耗时/会话降低至少 10%，P95 活跃耗时/会话降低至少 15%，按每 100 个可比完成会话归一化的活跃总小时降低至少 10%。这些是推广目标，不是历史上限的兑现承诺。
- 在 compaction treatment 实际改变上下文桶的轮次中，ctx≥200k 的 TTFT P50/P95 至少下降 10%；若受影响轮次不足以形成稳定估计，则报告“证据不足”而不外推总小时。
- 完成率、确定性 verifier 通过率、独立 review 通过率和最终成功率相对 control 不下降超过 2 个百分点；阻断 finding、repair、返工和重复 read 不得出现超过 10% 的相对上升。
- 任何 reviewer/author 或 implementer/reviewer 的 model lineage 独立性破坏都是立即停止条件；不得用同 transport provider 的字符串差异代替 lineage 证据。
- 配置关闭每一项 treatment 后，下一新会话恢复 control 行为；不得依赖代码回退作为唯一回滚办法。
- 失败结果仍保留 `isError`、退出码、超时状态、artifact 和结构化错误原因；重复失败提示不得硬抑制合法的、经解释的验证重跑。
- 若未来启用搜索合并/缓存候选，freshness、provider、recency、limit 和敏感数据生命周期必须有独立证据；本推荐路径不以搜索缓存收益作为验收前提。

### 1.3 本次范围

- 对历史耗时证据按不重叠时间区间重新定义测量和归因。
- 评审三种可独立评审的候选方案：配置/纪律路径、窄 runtime guardrail 路径、激进编排路径。
- 推荐以现有 canonical owner 为边界的 opt-in 窄 guardrail 路径，并给出分阶段落地顺序、控制流、配置契约、失败路径和回滚。
- 使用现有角色路由和质量层级 seam 做静态角色级模型配置；在没有新会话证据前，不把普通主会话改成按单轮动态换模。
- 使用现有事件驱动 hub 和自动投递，只限制空等长尾并改善调用纪律；不新增事件驱动 hub。
- 使用现有 compaction 执行入口做提前、可解释的阈值选择；不做同一 live session 的 sidecar compaction，也不把压缩改造成真正并行操作。
- 为重复 bash 失败提供 fail-open advisory，为 eval bridge 提供独立 wall-clock/call budget；两者都不伪造成功。
- 设计新会话 baseline、A/B、质量停止条件和不双算的报告方法。

### 1.4 非目标

- 本次不修改生产代码、运行配置、已有文档、发布物或提交记录；仅新增本设计文档。
- 不承诺历史 60% 模型等待削减、21.3h hub 池、3.7h eval 池或任何其他历史算术上限会在新配置中重现。
- 不把历史文档中旧的“`agentModelOverrides` 为空”状态继续当作当前事实；当前 brief 已核对角色覆盖配置，必须从新会话实际 receipt 开始。
- 不实现普通主会话的隐式、按单轮价值猜测的动态模型路由；不让低 TTFT 模型承担未获授权的架构裁决、写入或最终独立 review。
- 不把 `agent()` 改造成异步 API；其内联结果和 isolation merge 语义保持不变。
- 不在 `web_search` 中直接引入没有 freshness、provider、recency、limit key 和生命周期合同的缓存或 in-flight 去重。
- 不通过硬阻断合法验证重跑来掩盖失败；不以新增一个 loop guard、等待轮询器或验证引擎解决问题。
- 不把 eval 中的异模型门禁迁移成未经验证的并行 live-session 语义；模型门禁优先使用 native task/workflow 合同。

## 2. 背景与约束

### 2.1 证据和量化口径

| 项目 | 标签 | 已知量或规则 | 在本设计中的用途 |
| --- | --- | --- | --- |
| 真实会话语料 | [历史事实] | 886 个 JSONL 中解析出 689 个真实会话；活跃耗时 306.6h | 复算历史基线和检查分析脚本口径，不作为新收益分母 |
| 模型生成 | [历史事实] | 174.3h | 指示模型生成是最大历史组成之一 |
| TTFT | [历史事实] | 92.0h；Sol 17,205 轮，TTFT 75.7h | 指示上下文和模型路径需要 baseline |
| Sol 模型等待 | [历史事实] | gen 136.9h、TTFT 75.7h，总 212.6h；平均 gen 29s、TTFT 16s | 仅描述历史池，不代表当前新会话仍全部走该路径 |
| Sol 上下文差异 | [历史事实] | ctx<100k TTFT 15.6s，ctx≥200k 29.1s，≥350k 全语料 51.0s | 支持提前 context maintenance 的设计假设 |
| 模型路由算术 | [算术上限] | 212.6h×60%=127.6h；266.3h×60%=159.8h | 仅作为上限示例，不写成承诺；当前配置可能已提前消耗部分池 |
| 上下文桶差值 | [算术上限] | 每 1,000 个受影响轮次从 29.1s 降到 15.6s，理论节省 3.75h TTFT | 受影响轮次数未统计，不外推总小时 |
| hub | [历史事实] | 21.3h/3,559 次，平均 22s；重点会话平均 1.4m，常见 2–3m | 其中包含真实子代理运行时间，不全视为可消除 |
| hub 比例 | [算术上限] | 若可消除比例为 r，数学量为 21.3h×r | 只用于说明量纲；等待优化不扣除子代理真实运行时间 |
| bash | [历史事实] | 6.2h/5,534 次；E2E 单次 3–5.5m，历史重跑至少 8 次 | 支持失败 advisory 和服务后台化纪律 |
| 重跑 | [算术上限] | 避免 7 次同失败重跑约 21–38.5m，源文档概括约 30m | 不能当作每个新会话必得收益 |
| eval | [历史事实] | 3.7h/578 次；Aegis 2.51h/22 次；最长单次 13.9m | 支持独立 bridge budget；3.7h 不全可消除 |
| web search | [历史事实] | 3.7h/285 次，平均 47s | 合并调用的量纲，不引入未经验证的缓存收益 |
| search 减少次数 | [算术上限] | 减少 N 次的数学量为 47s×N；按命中/合并率 r 可写 3.7h×r | 只有 live freshness 和命中证据后才报告 |
| compaction | [历史事实] | 26 个会话触发，316–371k tokens，累计 11.5M tokens | 支持检查阈值过晚，但压缩 token 数不等于时间节省 |
| read/cache | [历史事实] | read 19,117 次；同一 spec 最多 42 次；cacheRead 命中 95.7% | 说明缓存省钱不等于消除 TTFT；重复 read 需以会话行为验证 |
| 文档单位 | [历史事实] | `wc -m` 6,176 字符；`wc -c` 9,981 UTF-8 字节（round 2 复核：对 `docs/long-session-latency-analysis.md` 实测一致） | 任何复算不得把字符、字节、token 混作同一指标 |

主要活跃耗时必须以事件时间线的**区间并集**为总量：`gen`、`ttft` 和工具执行区间重叠时只计一次。墙钟时间可单独报告用户空闲和夜间挂机，但不是主要活跃耗时指标。子代理实际运行时间如果已经位于父会话工具区间内，不再作为额外节省项相加。

对于干预归因，使用同一任务分层的 control/treatment marginal delta：

- `S_combined = T_control - T_all_treatment` 是组合 arm 的主要结果。
- `S_compaction`、`S_wait`、`S_bash`、`S_eval` 等分别与同一 control 的单功能 arm 比较，只用于说明边际效果，不能把各自节省相加。
- 如果两个干预作用于同一轮 TTFT，使用分层或 factorial arm 报告交互项；提前 compaction 改变 context 后，再使用低 TTFT 模型的效果不能在同一轮重复扣除。
- wait 优化只计算父会话阻塞区间缩短；不会把子代理真实执行时间同时算作 hub 节省和模型节省。
- eval bridge 的 LLM 调用已包含在对应工具区间中；不再把 bridge 时长与模型 gen/TTFT 二次相加。

### 2.2 已有 canonical owner 和不变量

- **普通会话模型与角色**：模型解析、模型控制、角色模型和 retry/fallback 分别由 `packages/coding-agent/src/config/model-resolver.ts`、`packages/coding-agent/src/session/model-controls.ts`、`packages/coding-agent/src/session/role-models.ts`、`packages/coding-agent/src/session/retry-fallback-chains.ts` 负责。当前普通主会话默认仍沿用 `modelRoles.default`，没有按单轮价值动态换模实现。
- **Workflow 路由**：`packages/coding-agent/src/workflow/session-config.ts`、`quality-route-snapshot.ts`、`model-router.ts`、`engine.ts` 和 `runtime-invocation.ts` 是质量层级、角色路由、快照和执行的 owner。既有 `modelRoles`、`task.agentModelOverrides`、`workflow.qualityRoutes.<tier>.<role>`、`defaultQualityTier` 和 FindingTracker reasoning/mechanical repair 分流是唯一可复用 seam。
- **当前配置事实（round 2 已复核 `~/.omp/agent/config.yml`）**：`task.agentModelOverrides.scout = gateway/deepseek-v4-flash:max`、`task.agentModelOverrides.task = gateway/gpt-5.6-luna:max`、`task.agentModelOverrides.designer = gateway/gpt-5.6-sol:high`、`task.agentModelOverrides.reviewer = gateway/gpt-5.6-sol:xhigh`、`modelRoles.default = gateway/deepseek-v4-flash:max`、`modelRoles.plan = gateway/gpt-5.6-luna:max`、`async.enabled = true`、`task.eager = preferred`、`task.batch = true`、`compaction.thresholdPercent = 70`、`compaction.idleEnabled = true`。`async.pollWaitDuration` 与 `compaction.thresholdTokens` 未显式写入 config 文件，其 effective 值分别来自 schema 默认 `smart` 与 `-1`（`settings-schema.ts:4150-4153,2179-2181`）；baseline receipt 必须区分 explicit value 与 default-derived effective value。这些是当前配置输入，不等同于每次 provider 实际执行的 attestation。
- **默认模型影响（round 2 修正）**：`modelRoles.default` 实际为 `gateway/deepseek-v4-flash:max`（低 TTFT 模型），不是 gpt-5.6-sol。因此“普通主会话不按单轮动态换模”在当前配置下意味着默认主会话已是快速模型；历史 all-Sol 主会话模型池在当前配置下的可路由残余更小。方案 B 的 guardrail 收益方向不变，但 control 必须按 Flash effective config 建立；方案 C 的“主会话动态路由”前提在当前默认下进一步弱化。
- **已有相关路由设计**：`docs/superpowers/specs/2026-08-01-quality-first-model-routing-goal-design.md` 已定义 role/tier、quality route snapshot、lineage independence、provider identity receipt 和 deterministic verification 边界；本设计只能扩展这些 seam，不能另造 router。
- **Compaction**：纯函数 owner 是 `packages/agent/src/compaction/compaction.ts` 的 `resolveThresholdTokens`、`shouldCompact`、`compactionContextTokens`；执行 owner 是 `packages/coding-agent/src/session/session-maintenance.ts`，已有 pre-prompt、mid-turn、post-turn、idle 入口；设置 owner 是 `packages/coding-agent/src/config/settings-schema.ts`。已有 `compaction.thresholdTokens`、`thresholdPercent`、`idleEnabled`、`idleThresholdTokens`、`idleTimeoutSeconds` 和 `snapcompact`。
- **Hub/task/门禁**：`packages/coding-agent/src/tools/hub/index.ts#executeWait` 已用 `Promise.race` 竞争 job promise、IRC waiter、timeout、abort；`packages/coding-agent/src/irc/bus.ts` 的 waiter 由 send 直接 resolve；`job-manager.ts` 已有自动投递、owner sink、重复投递抑制和 smart 阶梯 `[5s,10s,30s,60s,300s]`。不得把当前机制描述为轮询协议，也不得再提出新增事件驱动 hub。
- **Eval**：`packages/coding-agent/src/tools/eval.ts`、`src/eval/completion-bridge.ts`、`agent-bridge.ts`、`bridge-timeout.ts`、`idle-timeout.ts` 是 bridge owner。`withBridgeTimeoutPause` 会在 LLM 调用期间暂停 cell timeout；`agent()` 的内联结果和 isolation merge 语义不可因性能设计而改变。
- **Bash**：`packages/coding-agent/src/tools/bash.ts` → `packages/coding-agent/src/exec/bash-executor.ts` 已返回 `isError`、`exitCode`、`timedOut` 和 artifact 元数据；超时 owner 是 `packages/coding-agent/src/tools/tool-timeouts.ts`，后台服务 owner 是 `packages/coding-agent/src/tools/hub/launch.ts` 和 `packages/coding-agent/src/launch/broker.ts`。`ToolCallLoopGuard` 只比较连续 tool+arguments，不比较失败 fingerprint，也不硬阻断。
- **Web search**：`packages/coding-agent/src/web/search/index.ts`、`provider.ts` 和 `providers/*` 是 owner；`providers/utils.ts` 已有 `SEARCH_HARD_TIMEOUT_MS=60_000`，`providers/public.ts` 只做一次搜索内的跨引擎 URL 去重，没有查询级合并、缓存或 in-flight 去重。
- **Prompt assembly**：工具纪律文件位于 `packages/coding-agent/src/prompts/tools/hub.md`、`bash.md`、`web-search.md`、`eval.md`，系统 prompt 由 `packages/coding-agent/src/system-prompt.ts` 消费 `prompts/system/system-prompt.md`。prompt 只是行为指导，不能替代 runtime 错误语义或质量 gate。

### 2.3 必须遵守的约束

- 所有新增开关默认关闭，且各功能可以单独关闭；配置在会话启动时形成快照，中途不热切换，resume 使用已有不可变 workflow route snapshot。
- route 选择必须区分 configured/local resolution/provider or gateway attestation；缺少 strict identity 证据时不能冒充实际模型成功执行。异模型独立性按 model lineage 判断，不按 transport provider 字符串判断。
- 确定性测试、check、build、smoke 是完成证据；LLM 返回文本、路由成功或 exit code 0 不是完成证据。
- 性能优化失败时必须返回原始失败信息或明确 typed failure；不得吞错、伪造通过、绕过独立 review 或扩大 repair 循环。
- 不允许把当前已实现的事件驱动 hub、自动投递、compaction 入口、角色路由或 loop guard 重复实现成第二套机制。
- 任何质量、freshness、独立性和会话一致性风险优先于未经 live A/B 证实的性能收益。

## 3. 根因分析（按需）

### 3.1 是否需要根因分析

- **不需要重新诊断。** `docs/long-session-latency-analysis.md` 已给出全量会话证据链、统计口径、长会话样本和根因分解；brief 也已核对当前仓库的相关 canonical owner 与已存在机制。
- 本设计只把已有事实转换为可落地的候选方案，并要求用当前配置的新会话 baseline 重新确认残余问题；不重复猜测历史根因，也不把旧配置状态带入新实现。

### 3.2 已确认事实

- [历史事实] 689 个真实会话的活跃耗时主要集中在 Sol gen/TTFT，其次是 hub、bash、eval 和 web search；上下文达到 200k 后 Sol TTFT 明显高于小上下文桶。
- [历史事实] hub wait 当前已经是事件驱动竞争，历史长尾来自模型反复主动 wait、smart 顶值可达 300s，以及真实子代理运行时间，而不是缺少事件通知。
- [历史事实] compaction 只在少数会话发生且触发点偏晚；同一 live session 不支持真正 sidecar compaction，维护会重写活动历史并阻塞会话。
- [当前能力事实] 原生 agent 角色已有 model override，workflow 已有 role/tier route seam；普通主会话没有按单轮价值动态换模。
- [当前能力事实] bash 失败元数据、eval bridge、web search hard timeout 和现有测试入口均已存在，缺少的是窄的 policy/runtime seam，而不是新的底层执行器。

### 3.3 未确认假设

- [未验证假设] brief 所列配置在每一种新会话 host、resume 和 workflow 路径中都实际生效；需要从 route/usage receipt 和 provider attestation 核对。
- [未验证假设] 当前配置已经减少历史全 Sol 池中的一部分可路由轮次；历史 60% 算术上限因此可能显著高估新增可得收益。
- [未验证假设] 在约 200k 前进行上下文维护能降低 TTFT，且不会造成更高的重复 read、返工、遗漏或 compaction 失败率。
- [未验证假设] wait 上限和重复失败 advisory 能改变模型行为而不增加空转调用；若模型不遵守，收益只能来自边界 cap，不能假设提示词自动生效。
- [未验证假设] 10 分钟量级的 eval bridge wall-clock budget 能覆盖合法门禁而不截断高价值评审；Aegis 长尾需要真实样本验证。
- [未验证假设] 角色/质量层级静态路由的 provider-attested identity、effort 和 lineage 在当前 gateway 可稳定取得；仅有本地解析不足以推广。

### 3.4 对设计的影响

- 先做当前配置 baseline，再决定是否扩大模型路由；不能用 689 会话历史总量直接写预计节省小时数。
- 推荐路径只使用现有角色/tier route、compaction、hub、bash 和 eval owner 的窄扩展；不先合并动态单轮换模、异步 eval agent、搜索缓存和 sidecar compaction。
- 由于 hub 已事件驱动，runtime 只需要控制等待上限、重复 wait 诊断和等待状态，不需要建立通知基础设施。
- compaction 必须保持活动历史一致性，任何提前阈值都要通过 context bucket、返工和重复 read 指标验证。
- 所有收益采用 control/treatment 的非重叠区间和边际差，不把模型、compaction、hub、eval 的历史池相加。

## 4. 方案对比

### 4.1 方案 A：现有配置和行为纪律路径

- **核心思路**：只调现有配置和静态操作纪律，不新增长会话 runtime 行为。使用当前 role override、workflow quality route、既有 compaction 字段和既有 `async.pollWaitDuration`，配合已有工具提示中的正确用法；不引入动态主会话换模、失败 fingerprint、eval budget 或搜索缓存。
- **优点**：代码侵入最小；可通过独立配置快照关闭；保留所有现有工具语义；最容易先建立当前配置 control。
- **缺点**：模型是否遵守提示无法保证；`smart` 的等待阶梯和早期 compaction 风险只能通过配置间接控制；对普通主会话历史 Sol gen/TTFT 池的直接杠杆有限；静态提示不提供失败归因。
- **适用前提**：当前 settings profile 能为 A/B 独立加载；route/effort/identity 已经通过 live probe；使用 `compaction.thresholdTokens` 的 arm 能在目标 context window 留出 reserve。

#### 4.1.1 文件/模块级改动点

- **仓库源文件**：无新增 runtime 文件改动；不改变 `model-resolver.ts`、`model-router.ts`、`executeWait`、compaction 执行、bash、eval 或 search 语义。
- **运行配置**：按当前已存在的 `task.agentModelOverrides`、`modelRoles.default`、`workflow.defaultQualityTier`、`workflow.qualityRoutes.<tier>.<role>`、`compaction.thresholdTokens`/`thresholdPercent`、`compaction.idleEnabled` 和 `async.pollWaitDuration` 建立 control/treatment；不把未验证模型名硬编码进仓库默认值。
- **行为纪律来源**：使用当前已有 `prompts/tools/hub.md`、`bash.md`、`web-search.md`、`eval.md` 的合同（四个静态资产不改动）；新增纪律只经 `promptPolicy.enabled` 的 gated system block 注入并单独 A/B，不把文字变化和所有 runtime 变化一起归因。

#### 4.1.2 控制流

1. 会话启动时读取当前 settings，记录非 secret 的配置 fingerprint、角色 override、quality tier 和 compaction/wait 值。
2. native task/workflow 在既有 role/tier seam 选择模型；普通主会话继续使用现有 `modelRoles.default`，不按单轮价值猜测。
3. compaction 仍由 `session-maintenance.ts` 的 pre-prompt、mid-turn、post-turn、idle 入口执行；配置 arm 只改变已有阈值选择。
4. hub wait 继续使用现有 job promise/IRC waiter/timeout/abort `Promise.race`；配置可把 smart 改成固定 `1m` 或其他已有值，但 job 完成仍立即返回。
5. bash、eval、web search 都保持原始结果和错误语义；模型依据已有 prompt 先读错误再决定是否重跑、合并查询或转后台服务。

#### 4.1.3 量化预期收益口径

- [历史事实] 该方案可对照 212.6h Sol 模型池、21.3h hub 池、6.2h bash 池和 3.7h search/eval 池，但这些值不表示当前 arm 的可得收益。
- [算术上限] 若历史 Sol 池有 60% 仍可通过静态 role/tier 配置改变，数学上限为 127.6h；由于普通主会话没有动态单轮路由且当前已有 overrides，不能把该数写成 A 的预期节省。
- [拟议验收目标] 先验证 P50/P95 活跃耗时和每 100 会话活跃小时至少达到第 1.2 节目标；如果只有提示遵守率提高而时延不变，应报告方案 A 不足，不把历史池转成收益。

#### 4.1.4 风险和回滚

- 固定较早 `thresholdTokens` 可能在小 context window 中过早压缩，增加重复 read/返工；通过 context-window 分层和 compaction 失败率监控，无法满足质量门槛时关闭该配置 arm。
- 将 `smart` 改成固定 `1m` 可能增加模型再次调用 wait 的次数；保留 auto-delivery 语义并按 wait 次数、timeout 比例评估，不把一次短 timeout 当成 job 完成。
- 静态 role route 可能有 provider identity/effort/lineage 不匹配；配置加载或 live probe 失败时不启用 treatment，不能静默使用相近模型。
- 回滚只恢复该 A/B settings snapshot：`async.pollWaitDuration` 恢复 `smart`、compaction 恢复 control 值、role/quality route 恢复旧列表；不依赖代码 revert。

#### 4.1.5 验收证据和适用前提

- 新会话 receipt 证明当前 role override、实际 provider/gateway attestation、quality tier、compaction threshold 和 wait policy。
- 使用 `packages/coding-agent/test/tools/hub-wait.test.ts`、`async-job-manager.test.ts`、`job-poll-displacement.test.ts` 和 `task/task-batch.test.ts` 的既有合同确认配置没有破坏自动投递和等待语义。
- 运行同任务 control/treatment，输出按区间并集计算的 P50/P95、normalized active hours、TTFT context buckets、wait timeout ratio、重复 read 和最终质量 gate。
- 仅当当前 settings 能够按会话隔离且 provider identity 可复查时适用；否则只能作为 baseline，不进入推广。

### 4.2 方案 B：窄 runtime guardrail 和可观测性路径（推荐候选）

- **核心思路**：保留方案 A 的配置/角色路由边界，并增加少量、独立开关、fail-open 或 typed-failure 的 runtime guardrail：自适应长会话 compaction 目标、现有事件驱动 wait 的上限/重复诊断、bash 失败 fingerprint advisory、eval bridge wall-clock/call budget，以及一次性条件 prompt policy。普通主会话仍不启用按单轮价值动态换模，web search 不增加运行时缓存。
- **优点**：直接控制已确认的空等、同失败重跑、eval 长尾和上下文膨胀；每项可以单独 A/B、关闭和归因；不改变 hub 通知、`agent()` 异步语义或 review 独立性。
- **缺点**：需要跨现有 owner 增加 schema、receipt 和测试；advisory 可能不改变模型行为；早期 compaction 与 eval budget 有真实质量风险；没有动态主模型路由时，不能兑现历史 Sol 池的算术上限。
- **适用前提**：能够在 session settings 中形成不可变 feature snapshot；每个 owner 都能返回明确的 enabled/disabled/fallback reason；实施者能先落可观测性再启用行为开关。

#### 4.2.1 文件/模块级改动点

| 文件/模块 | 设计变更 | 明确不做 |
| --- | --- | --- |
| `packages/coding-agent/src/config/settings-schema.ts` | 增加 `performance.longSession.*` 的严格 schema、默认关闭、范围和互斥校验；保存非 secret 的 feature snapshot | 不把模型名、价格或 provider 排名写进通用默认值 |
| `packages/coding-agent/src/system-prompt.ts`、`packages/coding-agent/src/prompts/system/system-prompt.md` | 仅在 `promptPolicy.enabled` 时向 system prompt 附加一次短的长会话纪律块（auto-delivery、`await:true`、错误先读后重跑、服务走 hub、搜索合并、门禁优先 native workflow），并记录 prompt policy receipt | 不在每轮重复注入长文本，不让 prompt 替代 runtime 合同 |
| `packages/coding-agent/src/prompts/tools/hub.md`、`bash.md`、`web-search.md`、`eval.md` | **不改动**（round 2 修订）：四个静态 tool prompt 资产保持字节不变；纪律内容只经上述 gated system block 注入。Hub 在 constructor 无条件 `prompt.render`（`tools/hub/index.ts:234-235`）；WebSearch 在 class constructor（`web/search/index.ts:314-315`）与 module-level `webSearchCustomTool`（`:339-340`）无条件 render——直接改文件会让 control 会话也变化 | 不修改静态工具 prompt 资产、不声称 hub 缺少事件驱动、不新增 prompt 中的虚假工具 |
| `packages/agent/src/compaction/compaction.ts` | 在现有 `resolveThresholdTokens`/`shouldCompact`/`compactionContextTokens` seam 接受 opt-in 的 session target，并按实际 context window/reserve 做安全裁剪 | 不新增 sidecar compactor，不在后台并行重写同一活动历史 |
| `packages/coding-agent/src/session/session-maintenance.ts` | 在既有 pre-prompt、mid-turn、post-turn、idle 入口消费 compaction snapshot，记录触发来源和 fallback | 不改变 compaction 一致性和失败后的原始状态语义 |
| `packages/coding-agent/src/async/job-manager.ts`、`src/tools/hub/index.ts` | 在现有 smart ladder 上增加可配置最大空等阶梯和重复 wait advisory；job promise/IRC waiter/timeout/abort race 保持不变 | 不新建事件总线、轮询协议或第二个 wait engine |
| `packages/coding-agent/src/tools/bash.ts`、`src/exec/bash-executor.ts`、`src/session/stream-guards.ts` | 复用结构化失败元数据，生成不含 secret 的 per-session failure fingerprint，重复时附加 advisory metadata | 不硬阻断、吞掉 `isError` 或替换现有 `ToolCallLoopGuard` |
| `packages/coding-agent/src/tools/eval.ts`、`src/eval/completion-bridge.ts`、`agent-bridge.ts`、`bridge-timeout.ts`、`idle-timeout.ts` | 增加 opt-in bridge wall-clock 和 session call budget；超限返回 typed failure，保持 inline result/isolation merge | 不把 `agent()` 改异步，不在 budget 超限时伪造门禁通过 |
| 现有模型/Workflow owner | 只使用 `task.agentModelOverrides`、`modelRoles`、`qualityRoutes` 和 route snapshot；验证当前配置残余问题后才调整静态角色 route | 不添加按单轮价值的第二套路由引擎 |
| 已列测试入口 | 补充 schema、compaction、wait、bash、eval、route receipt 和 rollback 的 focused contract tests | 不用测试 exit code 代替 artifact、identity 和质量证据 |

#### 4.2.2 控制流

1. **快照**：会话启动时 settings schema 验证 `performance.longSession`，生成非 secret feature snapshot；所有开关默认关闭。快照的 canonical 持久化走 `SessionManager.appendCustomEntry("omp.longSession.featureSnapshot.v1", …)`（`session-manager.ts:2020-2024`）；resume 由注册的 branch-aware receiver 在 `session_start/switch/branch/tree` lifecycle dispatch 从 active branch 恢复（§5.3.4）。snapshot 缺失/损坏/schemaVersion 不匹配时全部 leaf 回 control 并记录 `snapshot_restore_failed`，绝不静默重读新 settings 覆盖已冻结的 workflow route snapshot。
2. **角色路由**：native task/workflow 仍经现有 `modelRoles`/`task.agentModelOverrides`/`qualityRoutes`；如果配置的 provider attestation、effort 或 lineage 不满足 strict contract，按现有 fallback 或 fail closed，不因性能开关绕过独立 review。普通主会话继续使用原有默认模型。
3. **上下文维护**：当 `compaction.enabled` 时，现有 maintenance 入口调用纯函数 owner。建议初始 `targetTokens=200000`，实际阈值不能超过可用 context window 减 reserve；目标不适配时记录 `baseline_threshold_fallback` 并使用 control，而不是强行压缩。compaction 仍阻塞并重写一致的活动历史。
4. **等待**：当 `asyncWait.enabled` 时，现有 `executeWait` 仍直接 race job promise、IRC waiter、timeout 和 abort；job 完成立即返回。只有没有完成事件时才受 `smartMaxSeconds` 限制；连续 wait 达到 `repeatAdvisoryAfter` 时返回清晰的 pending/advisory 状态，不把 pending 当成功。
5. **bash 失败**：`BashTool.execute` 得到 executor 的结构化结果后，按规范化命令、cwd、退出状态、timedOut 和受控错误摘要生成 fingerprint。第一次失败照常返回；同 fingerprint 再次调用时附加“先检查上次结果/说明重跑理由”的 advisory，仍保留执行机会和原始错误。
6. **eval bridge**：`evalBudget.enabled` 时从每次 eval tool invocation（`EvalTool.execute` 单元）开始计 wall-clock 和调用数；内部 bridge 调用（`completion()`/`agent()`，一个 cell 可有 0..N 次）不单独计数——已在工具区间内，与 §2.1 不双算一致。超过任一预算返回 `eval_budget_exceeded` typed failure，保持 isolation 和未合并状态。模型门禁优先改走 native task/workflow，而不是把 `agent()` 变成异步。
7. **搜索和提示**：web search 不修改静态 tool 资产；纪律（合并可见问题、限制次数、缩小范围）仅在 `promptPolicy.enabled` 时经 gated system block 注入。runtime provider chain、60s hard timeout 和 freshness 语义保持不变。
8. **证据**：每个 feature 的 enabled、snapshot、fallback、advisory、typed failure 和最终 quality receipt 写入现有 session/artifact 途径；`performanceEvent` 以 `SessionManager.appendCustomEntry("omp.longSession.performanceEvent.v1", …)` 追加 started/finished 配对记录（不参与 LLM context），离线 ledger consumer 在 session end 后按 active branch 扫描并 reconcile 构建 non-overlap critical-path ledger（§5.3.4）；不新增平行 metrics store。总耗时按事件区间并集计算。

#### 4.2.3 量化预期收益口径

- [历史事实] 方案 B 主要针对 200–300k context 的 TTFT、smart wait 长尾、同失败 E2E 重跑和 eval bridge 长尾；历史对应池分别为模型 TTFT、21.3h hub、6.2h bash 和 3.7h eval。
- [算术上限] compaction 若让某些轮次从 29.1s 桶进入 15.6s 桶，每 1,000 个实际受影响轮次的数学差为 3.75h；受影响轮次数、压缩开销和返工成本未统计，不能外推。
- [算术上限] 若某会话 hub 等待中可减少比例为 r，历史池数学量为 21.3h×r，但子代理真实执行时间不可消除；方案 B 只报告父等待区间的实测 marginal delta。
- [算术上限] 对同一失败 E2E 少重跑 7 次可减少约 21–38.5m 的历史重复命令时间；这不是每个 treatment 会话的保证。
- [拟议验收目标] 方案 B 以第 1.2 节 P50/P95、总小时、质量和回滚目标为唯一推广门槛；单个 guardrail 若只有组件指标改善而总 critical path 不改善，不能把组件池相加宣称成功。

#### 4.2.4 风险和缓解

- **compaction 过早造成遗漏或返工**：按 context window 分层，保存 compaction 触发前后 token、重复 read、repair 和最终 verifier 结果；任一质量 guard 失败立即关闭该 feature，回到已有阈值。
- **wait cap 造成更多主动 wait**：初始只降低 smart 空等上限，不改变完成事件；记录 timeout→下一次 wait 的转移，若轮次数或父工具区间上升则关闭 cap。advisory 不硬阻断。
- **failure fingerprint 误判合法重跑**：fingerprint 只作 advisory，不抑制执行；命令、cwd、输入或显式理由改变时生成新 fingerprint。哈希材料不得包含 token、secret 或完整敏感输出。
- **eval budget 截断合法门禁**：默认关闭；先对历史 13.9m 长尾做分布统计，起始值只作为可调实验参数。超限返回 typed failure，workflow 进入 blocked/fallback，绝不成功收口。
- **prompt 变长反而增加 TTFT**：prompt policy 只注入一次且保持短小；记录 prompt token delta，若新增上下文成本抵消 TTFT 改善则关闭 prompt 开关。
- **角色 route 误用低质量/同 lineage 模型**：严格使用现有 route snapshot、provider attestation 和 lineage 校验；无法证明独立性时 fail closed。
- **跨 owner 配置漂移**：所有 feature 在 session snapshot 中记录；未知字段、越界值或不一致配置在加载时拒绝，不默默采用相近默认。

#### 4.2.5 回滚方式

每个开关是独立 rollback 单元，推荐默认值如下：

```yaml
performance:
  longSession:
    promptPolicy:
      enabled: false
    compaction:
      enabled: false
      targetTokens: 200000
    asyncWait:
      enabled: false
      smartMaxSeconds: 60
      repeatAdvisoryAfter: 2
    bashFailureAdvisory:
      enabled: false
      repeatThreshold: 1
    evalBudget:
      enabled: false
      wallClockSeconds: 600
      callsPerSession: 2
```

`performance.longSession` 只作为配置 namespace，不是新的执行引擎；每个 leaf 由其既有 owner 消费。正式实施时 schema 可按仓库现有 dotted-settings 风格落成等价键，但行为合同必须保持上述独立开关和默认关闭。

- compaction 风险只关闭 `compaction.enabled`，恢复既有 `thresholdTokens`/`thresholdPercent`；不影响 wait、bash 或 eval。
- wait 风险只关闭 `asyncWait.enabled`，恢复现有 `async.pollWaitDuration` 和 smart 阶梯；不影响 hub 自动投递。
- bash advisory 风险只关闭 `bashFailureAdvisory.enabled`，仍保留原始 executor 和 `ToolCallLoopGuard`。
- eval 风险只关闭 `evalBudget.enabled`，恢复原有 bridge timeout-pause 语义；预算失败过的 invocation 不自动伪造重试成功。
- prompt 风险只关闭 `promptPolicy.enabled`，系统 prompt 回到 control；不依赖删除代码才能恢复。
- master namespace 原子关闭语义（round 2 澄清）：`performance.longSession` namespace 缺省或被整体清空时，所有 leaf 因默认 off 而全部采用 control——这就是原子关闭，不新增 root `enabled` 字段；若未来需要运行时 master switch，必须另列 schema 字段、优先级和 rollback tests。紧急关闭时同时记录具体 leaf，以便恢复安全的独立 arm。
- model role/quality route 仍通过已有配置 snapshot 单独回滚；route 失败时使用既有显式 fallback 或 fail closed，不通过关闭质量门禁来“恢复性能”。

#### 4.2.6 验收证据和适用前提

- settings schema 测试证明默认 off、非法值拒绝、每个 leaf 可单独关闭、session snapshot 不随中途 settings 变化漂移。
- compaction focused tests 证明 target、reserve、context window 边界、pre/mid/post/idle 入口和 baseline fallback；历史会话重放证明不会把 summary 当作原文恢复成功。
- `packages/coding-agent/test/tools/hub-wait.test.ts`、`async-job-manager.test.ts`、`job-poll-displacement.test.ts`、`tools/irc.test.ts` 和 `task/task-batch.test.ts` 证明完成事件、timeout、abort、auto-delivery 和重复 advisory 合同。
- `packages/coding-agent/test/bash-failure-result.test.ts`、`bash-execution-clamp.test.ts`、`agent-session-tool-call-loop-guard.test.ts` 证明原始错误保留、超时语义和 advisory 不硬阻断。
- `packages/coding-agent/test/tools/eval-timeout.test.ts`、`eval-agent-progress.test.ts`、`core/eval-workflow-helpers.integration.test.ts` 证明 budget typed failure、进度和 isolation merge 未被破坏。
- route receipt、独立 reviewer lineage、deterministic verify 和 changed-path smoke 必须同时存在；只看模型文本、exit code 或单个组件时延不足以通过。
- 适用前提是新会话能够暴露足够的 session/artifact timing、provider identity 和质量结果；无法取得证据时保留 control，不将未观测项估算成收益。

### 4.3 方案 C：激进编排、动态单轮路由和外部调用优化

- **核心思路**：在现有 role/tier seam 之上扩展普通主会话的显式 turn value/quality tier，按调用者提供的任务合同把低价值工具循环路由到低 TTFT 模型，把高难推理和独立门禁保留给高质量模型；同时改造 workflow/task batch 的可独立切片并行、把 eval 门禁迁出 bridge、增加查询合并/缓存和更强的验证重复抑制。
- **优点**：理论上覆盖历史 Sol gen/TTFT 大池和外部调用池；若任务合同、上下文摘要和供应商身份都可靠，潜在收益高于 A/B。
- **缺点**：改变普通会话模型选择、上下文和异模型独立性契约；并行边界、`agent()` inline/isolation 语义、搜索 freshness、缓存生命周期和重复验证合法性都需要新设计；代码面跨越最大 owner，故障归因难且回滚复杂。
- **适用前提**：已有 route/quality receipt 证明静态角色优化不足；调用者能显式标注质量层级且不依赖 LLM 自猜；provider attestation、cache key、freshness 和任务依赖图均有稳定的可测试合同；任何 live-session compaction 仍保持一致性而不是 sidecar 并行。

#### 4.3.1 文件/模块级改动点

- `packages/coding-agent/src/session/model-controls.ts`、`model-resolver.ts`、`role-models.ts`：增加显式、可审计的普通 turn quality tier/role 选择，不按隐藏启发式猜测“低价值”；所有选择进入现有 routing audit。
- `packages/coding-agent/src/workflow/model-router.ts`、`quality-route-snapshot.ts`、`engine.ts`：把 implementer/resumer/reviewer 的实际 lineage、identity 和依赖快照传递到动态选择；继续禁止同 lineage 独立 review。
- `packages/coding-agent/src/task/task-batch.ts`、workflow stage 入口：只并行没有数据/写入依赖的 read-only 切片；写入、repair、deterministic verify 和 review 依赖保持有序。
- `packages/coding-agent/src/tools/eval.ts`、`completion-bridge.ts`、`agent-bridge.ts`：若要异步化，必须定义 job handle、inline result 兼容、isolation merge 和取消语义；不能直接把当前 `agent()` 改成返回 promise 以外的形态。
- `packages/coding-agent/src/web/search/index.ts`、`provider.ts`、`providers/*` 和 settings schema：定义规范化 query、provider、recency、limit、freshness、TTL、in-flight 生命周期和敏感结果清理后，才可实现合并/缓存。
- `packages/coding-agent/src/tools/bash.ts`、`stream-guards.ts`：若要硬抑制重复失败，必须增加显式用户/模型 override、合法验证重跑识别和 fail-open；当前 advisory 不能直接升级成阻断。
- compaction owner：仍只能通过 `resolveThresholdTokens` 和 session-maintenance 的一致性入口，不允许新增 sidecar live compactor。

#### 4.3.2 控制流

1. session start 编译不可变 turn/quality route snapshot，记录调用者显式 tier、模型候选、lineage 和 identity policy。
2. 每轮先依据已声明的 task class/role 选择 route；没有显式分类、profile 不可用、provider attestation 缺失或 reviewer lineage 冲突时走保守路径或阻断，不能静默降级。
3. 仅将无共享写入和无顺序依赖的 work package 交给现有 task batch；每个子任务保留 artifact、owner 和失败状态，汇合点执行 deterministic verifier。
4. hub 继续使用现有事件驱动 waiter；并行只是减少依赖链中的空等，不是新增 hub。
5. eval 门禁若迁移，先生成可取消的 native task/workflow job，再以显式 artifact/identity receipt 汇合；旧 `agent()` 合同在迁移完成前不能改变。
6. search cache 只有在 freshness key 命中且 provider/recency/limit 合同完全相同才返回；过期、冲突或敏感结果按 miss 处理。
7. 所有结果先经过现有质量/确定性 gate；route 速度快不能绕过 review、tests、check、build 或 smoke。

#### 4.3.3 量化预期收益口径

- [算术上限] 历史 212.6h/266.3h 模型等待池、21.3h hub、3.7h search/eval 和 6.2h bash 池共同构成理论候选空间，但这些池有配置漂移、真实子代理运行时间和事件重叠，不能相加作为 C 的承诺。
- [算术上限] search 若减少 N 次调用，数学量为 47s×N；只有按 cache key 分层的命中率、freshness 正确率和总 critical path 证据才能转化为实际收益。
- [拟议验收目标] C 必须先在小规模 shadow/A/B 中证明相对 B 的总 P50/P95 和归一化总小时有增量，且质量、lineage、freshness、isolation 和确定性验证不劣化；任何单池收益都不能单独通过。

#### 4.3.4 风险和回滚

- **动态路由质量回归**：高难轮被误送低 TTFT 模型；按显式 tier、artifact quality 和独立 review failure 设硬停止，关闭 turn routing flag 后回到 `modelRoles.default`/现有 role route。
- **并行写入或依赖竞态**：错误的切片边界污染 worktree 或使 finding 丢失；默认只读、隔离和 bounded merge，关闭并行 flag 后恢复串行 workflow。
- **异步 eval 语义不兼容**：调用者拿到 job handle 却期待 inline result；在新 API 和迁移完成前保持 bridge，异步 flag 独立关闭。
- **搜索 stale/泄漏**：TTL 或 key 错误导致错误答案、隐私残留；任何 freshness 错误或敏感结果泄漏都立即关闭 cache，不可用代码回退掩盖。
- **硬抑制合法验证**：同一命令的第二次运行可能是必要的环境修复；只能 advisory 或显式允许，出现一次误抑制即停止硬抑制。
- **回滚复杂**：每个动态 route、parallel、eval、search cache、bash suppression 都必须有独立 flag 和 control receipt；未具备独立开关不得进入实现。

#### 4.3.5 验收证据和适用前提

- route contract、provider attestation、model lineage、quality tier 和 resume snapshot 的 focused tests 与 live fixture。
- 任务依赖图 replay 证明并行与串行结果一致，主 worktree 在失败/取消/identity mismatch 后无污染。
- eval inline/async compatibility、取消、超时、isolation merge 和失败 artifact 的 integration evidence。
- search cache 的 key/freshness/TTL/provider/recency/limit、敏感生命周期和 provider abort/timeout tests。
- 验证重复抑制的 false-positive corpus，尤其是环境修复、服务重启、fixture 重建和确定性重跑。
- 与 B 的同任务 A/B 以 non-overlap critical-path ledger 比较；若不能排除与 compaction、model routing 或 child runtime 的重复归因，C 不通过。

### 4.4 取舍对比表

| 维度 | 方案 A：配置/纪律 | 方案 B：窄 runtime guardrail | 方案 C：激进编排 |
| --- | --- | --- | --- |
| 主要覆盖 | 既有 role/tier、compaction 和 wait 配置；依赖模型遵守纪律 | context、空等、同失败重跑、eval 长尾；保留现有 route/hub 合同 | 普通单轮模型路由、独立切片并行、eval 迁移、search cache |
| 历史池可见性 | 主要只能测静态配置残余 | 能直接测若干可控的残余长尾 | 理论覆盖最大，但历史池不可直接转为收益 |
| 新 runtime 代码 | 无 | 少量跨现有 owner 的 schema、snapshot、advisory/budget | 大量跨 owner contract 和迁移 |
| 质量/一致性风险 | 低到中；提示遵守率未知 | 中；compaction/eval budget 需 guard | 高；动态 route、并行、cache、async 语义均有风险 |
| 失败可诊断性 | 依赖现有结果和 session 记录 | 每项有 snapshot、advisory、fallback、typed failure | 需要全新跨系统审计，归因最难 |
| 回滚 | 配置快照恢复 | 每项 feature 独立关闭，control 可复现 | 必须维护多套独立 flag 和迁移兼容 |
| 与现有 canonical owner 的一致性 | 最高 | 高；不增加第二引擎 | 只有严格限制范围才可保持 |
| 推荐等级 | 适合作为 control 和第一轮低风险 arm | **单一推荐目标** | 仅在 B 的新证据证明残余足够且另行评审后考虑 |

### 4.5 选型结论

- **选择：方案 B。**
- 方案 B 是最小充分路径：它控制已经有证据且可以在现有 owner 内窄扩展的浪费，但不把所有可能优化一次性打包。
- 方案 A 作为 control、配置-only treatment 和回滚基线保留；方案 B 先用 A 的既有配置 seam，再逐项加入 runtime guardrail，便于区分“当前配置已经吃掉的历史收益”和新增代码真实收益。
- 不选择方案 C 作为本轮推荐，因为普通主会话动态单轮路由、异步 eval agent、search cache 和并行依赖图分别改变质量、兼容、freshness 或 isolation 合同；它们的历史算术上限不足以抵消在新会话上未经验证的风险。
- 推荐方案明确**不新增事件驱动 hub**：hub 已是 `Promise.race` + waiter + auto-delivery，B 只改善上限、提示和诊断。
- 推荐方案明确**不做真正并行 live-session compaction**：维护仍由现有 session-maintenance 以一致性优先方式执行。
- 模型路由先限于当前 role/tier 配置和 provider/lineage receipt；若 baseline 证实普通主会话仍是主要残余且质量有可接受显式 tier 合同，再另行提出 C 类设计，不在本设计中隐式扩大范围。

## 5. 详细方案

### 5.1 核心思路

方案 B 的实施分成“可见证据 → 低风险配置 → 窄 runtime guardrail → A/B 推广”四层：

1. **先观察**：用当前配置生成 control snapshot，校验 configured/local/attested model identity、实际 context、tool intervals、failure metadata、review lineage 和质量结果。
2. **再配置**：用已有 role/tier、compaction 字段和 wait 值建立独立 arm；不因历史 all-Sol 计数而默认改普通主会话模型。
3. **再加窄 guardrail**：每个新 leaf 独立关闭，分别控制提前 compaction、空等上限/重复诊断、bash 失败 advisory 和 eval budget；不改变已存在底层协议。
4. **最后推广**：只在组合 critical path、P50/P95、总小时和质量停止条件同时通过时逐步提高 treatment 比例；任何 feature 可单独回滚。

### 5.2 关键数据流 / 控制流

1. `settings-schema.ts` 读取配置并严格验证 `performance.longSession`，拒绝未知/越界值；默认所有 feature off。
2. session start 生成非 secret `LongSessionFeatureSnapshot`，包含每个 feature 的 enabled、参数、配置 fingerprint、source 和 schema version；经 `SessionManager.appendCustomEntry("omp.longSession.featureSnapshot.v1", …)` 持久化到 session 记录（不参与 LLM context），并写入现有 session/artifact receipt。resume 由注册的 branch-aware receiver 在 lifecycle dispatch 从 active branch 恢复，校验失败回 control（§5.3.4）。
3. workflow start/resume 仍由 `quality-route-snapshot.ts` 冻结 role/tier、候选、identity policy 和 lineage；`LongSessionFeatureSnapshot` 不得覆盖它的质量/独立性合同。
4. 模型调用只通过现有 model resolver/router/runtime invocation；local resolution、provider/gateway attestation、effort 和 lineage 分层保存。没有 strict attestation 时按现有规则 unavailable/fail closed。
5. prompt assembly 只在 `promptPolicy.enabled` 时向 system prompt 附加一次短规则；四个静态 tool prompt 资产不改动（off 时 system/tool prompt 与 control 字节等价），system prompt 和 session snapshot 标识注入来源，以便关闭后复现 control。
6. 每次维护入口调用现有 compaction pure function；若 long-session target 与当前 context window/reserve 冲突，回退 control threshold 并记录原因；压缩完成后保持会话历史一致性。
7. 每次 hub wait 继续等待 job promise/IRC waiter/timeout/abort；完成事件优先。无完成事件时使用 feature cap；连续 wait 只得到 pending/advisory，不得被汇总为完成。
8. 每次 bash 结果在原有 structured result 形成后计算安全 fingerprint；重复失败只增加 advisory metadata，原始 `isError` 和 artifact 不变。
9. 每次 eval tool invocation 先经 awaited durable barrier 落盘 counted started 事件（`appendCustomEntry` + flush/等价 durable-append，见 §5.3.4；失败则调用不启动），然后使用 bridge budget；预算命中返回 typed failure，调用者必须显式处理或转到 native workflow，不能自动把失败结果作为 review 通过。
10. session end 由现有记录提供 timing、context、model、tool、failure、compaction、review 和质量数据；离线 ledger consumer（§5.3.4）按 active branch 扫描 `omp.longSession.performanceEvent.v1` 事件并 reconcile，生成 non-overlap critical-path ledger 和单 feature marginal delta（branch 边界显式记录，不跨 branch 相加）。

### 5.3 接口 / 配置 / 数据结构变更

#### 5.3.1 既有配置接口的使用边界

以下字段已经存在，方案 B 不改变其 owner 或基本语义：

```yaml
task:
  agentModelOverrides:
    scout: gateway/deepseek-v4-flash:max
    task: gateway/gpt-5.6-luna:max
    designer: gateway/gpt-5.6-sol:high
    reviewer: gateway/gpt-5.6-sol:xhigh
  eager: preferred
  batch: true

modelRoles:
  default: gateway/deepseek-v4-flash:max
  plan: gateway/gpt-5.6-luna:max

async:
  enabled: true
  pollWaitDuration: smart

compaction:
  thresholdPercent: 70
  thresholdTokens: -1
  idleEnabled: true
```

上例中的值是 round 2 复核 `~/.omp/agent/config.yml` 的当前输入（`async.pollWaitDuration = smart` 与 `compaction.thresholdTokens = -1` 是 schema 默认值而非 config 显式键，receipt 需区分 explicit/default-derived）；实现前必须从新会话 receipt 验证有效性，不能把 local configuration 当作 provider execution proof。`modelRoles.default` 为 `gateway/deepseek-v4-flash:max`（低 TTFT），普通主会话默认即快速模型；route 的新增或变更仍通过现有 `workflow.defaultQualityTier`、`workflow.qualityRoutes.<tier>.<role>` 和 quality route snapshot 完成，不新增 `longSessionRouter`。

#### 5.3.2 新的 opt-in feature 接口

以下是方案 B 的拟议配置合同；字段默认关闭，名称可以按现有 dotted-settings 类型风格落地，但语义、独立开关和边界固定：

```yaml
performance:
  longSession:
    promptPolicy:
      enabled: false
    compaction:
      enabled: false
      targetTokens: 200000
    asyncWait:
      enabled: false
      smartMaxSeconds: 60
      repeatAdvisoryAfter: 2
    bashFailureAdvisory:
      enabled: false
      repeatThreshold: 1
    evalBudget:
      enabled: false
      wallClockSeconds: 600
      callsPerSession: 2
```

字段合同：

- `promptPolicy.enabled`：控制一次性 system prompt 纪律块注入；off 时 system/tool prompt 与 control 字节等价（四个静态 tool prompt 资产不改动）；on 时每次 system prompt 重建（tool-set/host 变化触发）后的最终结果恰有一份 policy、不随轮次累积（见 §6.2）。
- `compaction.targetTokens`：仅在 `compaction.enabled` 时作为 session target；实际值必须受 context window 和 reserve 约束，不能把 200k 当所有窗口的固定承诺。
- `asyncWait.smartMaxSeconds`：仅限制没有完成事件时的 smart 空等顶值；job promise、IRC waiter、abort 和 auto-delivery 不变。`repeatAdvisoryAfter` 只触发说明，不硬阻断。
- `bashFailureAdvisory.repeatThreshold`：达到同一安全 fingerprint 的失败次数后附加 advisory；它不改变执行、退出码、artifact 或 `isError`。
- `evalBudget.wallClockSeconds`：从每次 eval tool invocation 开始计实际 wall-clock，包含内部 bridge 的 LLM 调用与被现有 timeout-pause 暂停的时间；超过后返回 typed failure。
- `evalBudget.callsPerSession`：预算单位 = eval tool invocation（`EvalTool.execute` 单元，与历史 578 次口径一致）；内部 bridge 调用不单独计数。达到上限后拒绝新的 eval tool invocation 并保留可诊断原因。
- 所有参数必须为有限、非负且在 schema 允许范围内；无效配置在 treatment session 启动前拒绝，不静默替换为另一个值。

#### 5.3.3 Runtime receipt 数据

复用现有 session/artifact/routing receipt 途径，新增的字段只描述本次 feature 和证据，不建立平行 metrics store：

```text
longSessionFeatureSnapshot:
  schemaVersion
  configFingerprint
  promptPolicy: { enabled, applied }
  compaction: { enabled, targetTokens, effectiveTokens, source, fallbackReason }
  asyncWait: { enabled, smartMaxSeconds, repeatAdvisoryAfter }
  bashFailureAdvisory: { enabled, repeatThreshold }
  evalBudget: { enabled, wallClockSeconds, callsPerSession }
  # 注：usedCalls 是运行时派生视图，不在 snapshot 中持久化；单一事实来源是 performanceEvent 的 started 事件流（§5.3.4）

performanceEvent:
  eventId              # 事件身份（每个事件唯一）
  invocationId         # 配对锚点：同一 eval tool invocation（EvalTool.execute 单元）的 started/finished 共享
  phase: started | finished
  counted: true        # 仅 started 事件带；finished 事件无此字段（或 false）
  feature
  sessionId
  turnId / toolCallId
  startedAt            # started 事件携带
  endedAt              # finished 事件携带
  outcome: completed | timeout | aborted | pending | advisory | typed_failure | baseline_fallback  # finished 事件携带
  fingerprintKind: none | bash_failure
  contextTokens
  configuredModel / localResolution / providerAttestation
  modelLineage
  qualityTier
```

`providerAttestation` 缺失时保留 `unknown/null`，不能使用 session 当前模型、catalog lookup 或配置字符串填补。bash fingerprint 只保留不可逆 digest 和必要的分类字段，不记录 secret 或完整敏感输出。

#### 5.3.4 Feature snapshot 与 performanceEvent 的持久化/消费 owner（round 3 修订）

canonical persistence 使用现有 session seam `SessionManager.appendCustomEntry(customType, data)`（`packages/coding-agent/src/session/session-manager.ts:2020-2024`）；`CustomEntry` 不参与 LLM context，且契约明确“on reload，extensions 按 customType 扫描并重建内部状态”（`packages/coding-agent/src/session/session-entries.ts:123-136`）。本设计不新建持久化引擎，但必须注册显式消费方——`appendCustomEntry` 只保存值，不会自动路由。

- **customType 约定**：feature snapshot = `omp.longSession.featureSnapshot.v1`（data = §5.3.3 的 `longSessionFeatureSnapshot`）；event = `omp.longSession.performanceEvent.v1`（data = §5.3.3 的 `performanceEvent`，phase=started/finished）。
- **单一 durable source（round 3 定稿，round 4 补 durable barrier）**：`usedCalls` 的唯一事实来源是 **phase=started 且 counted=true 的 performanceEvent 事件流**；snapshot 不携带计数（§5.3.3 已移除 `usedCalls` 字段），不提供第二条计数通道。预算单位 = eval tool invocation（一个 cell 内部 0..N 次 bridge 调用只对应一次 started/finished）。started 事件必须在 eval tool invocation **开始之前**达到可观察的 durable 状态：`appendCustomEntry` 热路径的写入失败是异步捕获的（`session-manager.ts:879-881` 的 `void append(...).catch(err => #noteDiskFailure(err))`），返回 entry id 不代表已落盘；必须使用可观察的 awaited durable barrier（实现阶段提供/使用 `await sessionManager.flush()` 或等价可等待 durable-append API 并暴露 disk-failure 状态）后再开始调用。barrier 失败 → 该 invocation 不启动，返回 `eval_budget_count_write_failed` typed failure（fail closed），保证“无 durable counted 记录即无调用”。
- **Event 生命周期（append-only start/end 配对）**：每次 eval tool invocation 追加两条记录——started（`eventId`、`invocationId`、`startedAt`、`counted=true`）+ finished（同 `invocationId`、`endedAt`、终态 `outcome`）。started 无对应 finished = in-flight/aborted/crash，仍计入预算（预算按“已开始的 eval tool 调用”计数，不能通过崩溃绕过）。finished 事件写入失败不影响计数（started 已落盘），ledger 标记 `event_write_failed`。
- **完整性/缺口检测**：(1) awaited durable barrier 保证调用必先留痕；(2) 离线 ledger consumer 用 session message 流中的 eval tool invocation 记录（message entry 的 tool call/result parts）与 started 事件数 **1:1** 对账——reconcile 单位与外层 eval tool call 相同，内部 bridge 调用不是 reconcile 单位，避免合法 cell（0..N 次内部 bridge）误报 mismatch；不一致 → `ledger_reconcile_mismatch`，对应区间标记不可归因，不得产生预算或收益声明；(3) resume 时若 active branch 的 started 事件扫描失败/无法证明完整 → evalBudget 对该会话 fail closed（`used_calls_unknown`），不把计数重置为 0。
- **Receiver / lifecycle dispatch（round 3 补全）**：新增只读消费模块（实现阶段落为 `packages/coding-agent/src/session/long-session-features.ts`），按仓库已有模式注册 `api.on("session_start" | "session_switch" | "session_branch" | "session_tree")` 触发 rehydrate（参照 `autoresearch/index.ts:248-251`），在 prompt/feature owner 首次消费前完成。rehydrate 从 **active branch** 读取：snapshot 取 active branch 上最新一条 `featureSnapshot.v1`，`usedCalls` 由 active branch 上 started 事件推导；`SessionManager.getBranch()` 返回当前 leaf 路径、`getEntries()` 返回全部 entry（`session-manager.ts:2135-2137,2167-2170`），因此禁止用全 journal 的“最新”值——rewind/branch 后非活动分支的 snapshot 或计数不得污染当前分支；branch switch/rewind 时重新按新 active branch 推导。接收方未注册 → 任何 feature 不得激活（fail closed，`snapshot_consumer_unregistered`）；active branch 无法判定 → 同样 fail closed（`snapshot_branch_ambiguous`）。
- **Resume 校验**：snapshot 缺失/损坏/schemaVersion 不匹配 → 全部 leaf 回 control，追加 `snapshot_restore_failed` 事件；不得把新 settings 覆盖已冻结 snapshot。
- **Ledger consumer 边界**：离线分析（session end 后只读审计，同一 `long-session-features.ts` 或独立只读入口，不参与 runtime 决策）按 active branch 构建 §6.1 的统一 interval ledger 与 non-overlap critical-path；branch/session-end 边界显式记录（每个 branch 单独 ledger，绝不跨 branch 相加）；缺失事件段标记为不可归因，不用插值补齐。
- **[未验证假设]**：`CustomEntry` 在 compaction 后的保留/重建语义须由实现阶段现有 compaction 合同测试确认。若 compaction 截断 custom entries，resume 无法证明事件流完整 → evalBudget fail closed（`used_calls_stream_incomplete`），直到 reconcile 证据恢复；不得依赖第二条计数通道。

### 5.4 错误处理与回退策略

| 失败路径 | 行为 | 回退/停止 |
| --- | --- | --- |
| long-session schema 未知字段、负值或类型错误 | treatment 配置拒绝，报告明确 schema error | 保留上一份有效 control 配置；不自动猜默认 |
| provider/gateway 不可达、attestation 缺失或 identity mismatch | 复用现有 route skip/fallback；strict reviewer 无合格候选时 fail closed | 不换成名字相近模型，不关闭独立 review |
| compaction target 超过窗口可用空间、纯函数异常或维护失败 | 记录 target/effective/fallback；按现有阈值或原始维护错误处理 | 关闭 `compaction.enabled`；不做 sidecar、不丢活动历史 |
| job 尚未完成且 wait cap 到期 | 返回 pending/timeout/advisory，保留 job ownership 和自动投递 | 模型可按明确状态决定下一步；不把 timeout 写成成功 |
| job/IRC waiter 完成 | 立即返回真实结果，不等待 cap | 无额外回退；保持现有 auto-delivery 抑制重复投递 |
| bash fingerprint 计算失败或结果字段缺失 | 原样返回 executor 结果，无 advisory | fail open；不阻断合法命令 |
| 同 fingerprint bash 失败再次调用 | 附加 advisory，保留执行机会、`isError`、exitCode、artifact | 由模型/用户解释并决定；不硬抑制 |
| eval wall-clock/call budget 超限 | 返回 `eval_budget_exceeded` typed failure，保留进度、isolation 和原因 | native workflow 或显式修复路径处理；不伪造 review 通过 |
| prompt policy 文件加载失败 | 记录 `prompt_policy_unavailable`，使用 control prompt | 仅关闭 prompt feature，不影响工具执行 |
| feature snapshot 写入失败 | 记录 `snapshot_write_failed`，该会话全部 leaf 回 control | 不静默采用新 settings 或猜测默认 |
| resume 恢复 snapshot 缺失/损坏/schemaVersion 不匹配 | 全部 leaf 回 control，追加 `snapshot_restore_failed` 事件 | 不重读新 settings 覆盖冻结 snapshot |
| eval tool started 事件写入/durable barrier 失败（调用开始前） | 该 invocation 不启动，返回 `eval_budget_count_write_failed` typed failure | fail closed：无 durable counted 记录即无调用 |
| eval tool finished 事件写入失败 | runtime 行为不变，ledger 标记 `event_write_failed` | 计数不受影响（started 已落盘）；离线把对应区间标记为不可归因 |
| resume 时 receiver 未注册或 active branch 无法判定 | 任何 feature 不得激活（`snapshot_consumer_unregistered` / `snapshot_branch_ambiguous`） | fail closed，不静默忽略 custom entries |
| evalBudget.usedCalls 无法从 active branch started 事件推导或完整性无法证明 | evalBudget 对该会话 fail closed（`used_calls_unknown` / `used_calls_stream_incomplete`） | 不把计数重置为 0；reconcile 证据恢复前不启用 |
| 离线 ledger reconcile 不一致（started 事件数 ≠ 既有 eval tool invocation 记录数） | 对应区间标记 `ledger_reconcile_mismatch`，不可归因 | 不产生预算或收益声明，不补插值 |
| deterministic verify、quality gate 或 independent review 失败 | 保持 unresolved/blocked 状态，进入既有 bounded repair 或停止 | 不能用性能结果覆盖 verifier 结论 |
| treatment 质量停止条件触发 | 立即关闭对应 leaf，保留 control | 分析 non-overlap ledger 后再决定是否重开；不能以历史上限解释失败 |

### 5.5 风险与缓解

- **历史基线和当前配置不一致**：所有新会话先写 effective settings、route receipt 和 provider attestation；历史数据只作背景和算术上限，不能直接用于承诺。
- **上下文维护节省 TTFT 但增加压缩成本**：把 compaction runtime、上下文桶 TTFT、重复 read、repair 和 verifier 作为同一 arm 的完整 ledger；若 critical path 没有改善就不推广。
- **提示词本身增加上下文**：只注入一次、限制篇幅、单独测 prompt token delta；如果 prompt 成本抵消收益则关闭 `promptPolicy`。
- **等待上限与真实并行度混淆**：父会话等待和子代理执行分别记录；只报告父时间减少，绝不声称消除了子代理真实运行时间。
- **模型路由质量或独立性不确定**：静态 role/tier 变更必须经过 live probe、identity receipt 和 lineage 检查；普通主会话动态 route留在候选 C。
- **会话一致性**：feature snapshot 和 workflow route snapshot 均在 start 时冻结；resume 不读取新的参数覆盖既有 snapshot。
- **观测不足**：若 provider attestation、session timing、quality outcome 或 failure category 缺失，结论标记“未验证”，只保留 control，不用插值填补。

### 5.6 分阶段实施步骤

以下步骤是给后续实现者的无代码设计顺序；每个阶段在前一阶段的证据通过后才开启下一阶段。

1. **建立 control 和历史复算合同**
   - 固定当前 effective settings 的非 secret fingerprint：`modelRoles.default = gateway/deepseek-v4-flash:max`、`modelRoles.plan = gateway/gpt-5.6-luna:max`、四个 `task.agentModelOverrides`、workflow quality tier、compaction、async、task eager/batch（round 2 已复核 `~/.omp/agent/config.yml`；`async.pollWaitDuration = smart`、`compaction.thresholdTokens = -1` 标为 default-derived，receipt 区分 explicit/default-derived）。
   - 复跑历史分析口径，确认 689、306.6h、组件计数和字符/字节单位；任何舍入差异单独标记。
   - 为新会话生成统一事件 ledger：assistant gen/TTFT、tool interval、hub waiter outcome、compaction、bash failure fingerprint、eval budget、model identity、quality gate。
   - 定义 control/treatment arm、session sampling、任务分层、结束条件和 P50/P95/总小时报表；本阶段不启用任何新 feature。

2. **落 settings schema 和 receipt，但保持 off**
   - 在 `settings-schema.ts` 增加方案 B 的独立字段和严格校验；在 session config/receipt 中保存 snapshot；所有默认值关闭。
   - 先验证 settings 关闭时 route、compaction、wait、bash、eval 和 prompt 行为与 control 一致。
   - 添加能证明开关隔离、非法配置拒绝和 snapshot 稳定性的 focused tests；不进行推广。

3. **实现 prompt policy 和配置-only arm**
   - 在 `system-prompt.ts` 的现有构造 seam 条件附加短 policy（可引用 `prompts/system/system-prompt.md` 的 gated 资产）；**不改动** `prompts/tools/hub.md`、`bash.md`、`web-search.md`、`eval.md` 四个静态资产（round 2 修订，保证 off 会话字节等价）。
   - 以方案 A 的现有 `async.pollWaitDuration`、compaction 设置和已验证 role/tier route 建立独立 arm；不改变 runtime 错误语义。
   - 先比较 prompt token delta、wait 调用次数、上下文 bucket 和质量；没有关键路径改善则关闭 prompt/config arm。

4. **实现 compaction target guardrail**
   - 在 `packages/agent/src/compaction/compaction.ts` 接入 target/reserve/window 边界，在 `session-maintenance.ts` 的既有入口记录来源和 fallback。
   - 以 compaction-only arm 测量 TTFT、压缩耗时、重复 read、返工、repair 和 verifier；不与 route/其他 feature 的节省相加。
   - 任一 compaction 质量停止条件触发即关闭 `performance.longSession.compaction.enabled`，恢复 control threshold。

5. **实现 wait cap 和重复 advisory**
   - 在 `job-manager.ts`/`tools/hub/index.ts` 复用现有 waiter race 和 auto-delivery，只增加 smart 空等顶值、pending outcome 和 repeat advisory。
   - 用已完成 job、未完成 job、abort、IRC send、timeout 和连续 wait 场景做 focused tests；确认不把 pending/timeout 误记完成。
   - 以 wait-only arm 计算父 blocked interval、轮次数和子代理实际运行时间，按 non-overlap 口径决定是否推广。

6. **实现 bash failure advisory**
   - 在 `bash.ts`/executor 结果边界生成安全 fingerprint，沿用现有 loop guard 和 structured result；重复失败只 advisory。
   - 覆盖同失败重复、修改命令后重试、超时、服务命令、artifact 缺失和合法验证重跑；禁止硬阻断。
   - 以 bash-only arm 比较同 fingerprint 重跑次数、失败总时长、成功率和误 advisory；不把省下的工具时间与模型时间重复计算。

7. **实现 eval bridge budget**
   - 在 `eval.ts`、completion/agent bridge 和 timeout owner 中增加 wall-clock/call budget；保持 `agent()` inline result、progress 和 isolation merge。
   - 覆盖预算内完成、wall-clock 超限、调用数超限、abort、provider 错误和 workflow fallback；typed failure 必须可复查。
   - 以 eval-only arm 比较长尾、budget error、门禁质量和 native workflow 转移；任何独立性或完成率回归即关闭。

8. **组合 arm、推广与持续回滚**
   - 只有各单 feature arm 通过后才组合 B；组合结果使用 `S_combined` 和事件区间并集作为唯一主要收益，不将单 feature delta 相加。
   - 先小比例 canary，再按预注册质量和 P50/P95/总小时目标逐级扩大；每一级均保留 control 和每个 feature 的配置回滚开关。
   - 如果组合 arm 只减少组件时间但 critical path、质量或失败率不改善，停止推广并回到 control；不为达到历史上限扩大范围。
   - 方案 C 的动态单轮路由、async eval agent、search cache、硬失败抑制和任何 live-session sidecar compaction 不属于本阶段；需要另一个设计和独立 review。

## 6. 验证计划

### 6.1 历史复算和当前 baseline

- 使用 `docs/long-session-latency-analysis.md` 已定义的会话过滤、tool interval、模型等待、活跃耗时和 compaction 事件口径复算历史语料；确认关键事实在舍入范围内一致。
- 在新会话 control 中记录当前 settings snapshot、任务类型、model configured/local/attested identity、contextTokens、quality tier、tool intervals、失败结果和最终完成状态。
- 将历史 689 会话与新 control 明确分离；若当前 `task.agentModelOverrides`、workflow route 或 provider 实际执行已经改变，报告历史池不可直接迁移。
- 将 `gen`、`ttft`、tool、hub parent wait、child execution、eval bridge、search provider 和 compaction 维护都映射到统一 interval ledger；使用 token、字符、字节各自的单位，不把 6,176 字符或 9,981 字节当成 token（round 2 复核：`wc -m`/`wc -c` 对 `docs/long-session-latency-analysis.md` 实测分别为 6,176 与 9,981，来源可复查）。

### 6.2 Focused contract verification

- **Settings/route**：默认关闭、非法值拒绝、session snapshot 固定、role/tier route 不漂移、provider attestation 和 lineage receipt 区分 configured/local/attested；reviewer 不得因同 transport provider 被误判独立。
- **Snapshot/event 持久化**：`appendCustomEntry` 写读 round-trip；branch-aware receiver 在 `session_start/switch/branch/tree` 从 active branch rehydrate（覆盖 rewind/fork/非活动分支不污染、receiver 未注册 fail closed、restore 顺序）；snapshot 损坏/缺失/schemaVersion 不匹配回 control；started/finished 配对（含 crash/abort 场景）与写前 awaited durable barrier（flush/disk-failure 暴露，1 个 eval 单元内含 0..N 次内部 bridge 调用时 started/finished 仍 1:1）；`usedCalls` 从 active branch started 事件推导；事件流完整性失败 fail closed；离线 reconcile 单位 = 外层 eval tool call（1:1）与 branch/session-end 边界。
- **Compaction**：纯函数 target/reserve/window 边界、pre-prompt/mid-turn/post-turn/idle 入口、失败和 baseline fallback；验证 compaction 后历史一致性、重复 read 和返工。
- **Hub/wait**：使用 `packages/coding-agent/test/tools/hub-wait.test.ts`、`async-job-manager.test.ts`、`job-poll-displacement.test.ts`、`tools/irc.test.ts`、`task/task-batch.test.ts`，覆盖 event completion、auto-delivery、timeout、abort、pending 和 repeat advisory。
- **Bash**：使用 `packages/coding-agent/test/bash-failure-result.test.ts`、`bash-execution-clamp.test.ts`、`agent-session-tool-call-loop-guard.test.ts`，覆盖结构化失败、超时、fingerprint、同失败 advisory、修改命令和合法重跑。
- **Eval**：使用 `packages/coding-agent/test/tools/eval-timeout.test.ts`、`eval-agent-progress.test.ts`、`core/eval-workflow-helpers.integration.test.ts`，覆盖 wall-clock/call budget、progress、abort、typed failure、inline result 和 isolation。
- **Prompt**：验证 feature off 时 system/tool prompt 与 control 字节等价（四个静态 tool prompt 资产未被改动）；feature on 时每次 system prompt 重建（tool-set/host 变化触发）后的最终结果恰有一份 policy、不累积；记录 prompt token delta。
- **Smoke**：运行真实 changed-path scenario：长上下文 maintenance、已完成/未完成 hub job、同失败 bash、超时 eval、独立 workflow review 和配置关闭恢复 control。必须读取最终 artifacts/receipts，不只看测试 exit code。

> 测试覆盖说明（round 2）：所列测试文件“入口存在”不等于“已覆盖新合同”——例如 `bash-execution-clamp.test.ts` 当前主要测 TUI 字符宽度、`core/eval-workflow-helpers.integration.test.ts` 受 `PI_PYTHON_INTEGRATION=1` 环境 gate。实施时必须按本节的 observable contract 为每个新行为补充 focused tests，不能把文件存在当作 budget/advisory 证据。

### 6.3 新会话 A/B 和指标

每个 arm 都必须保留相同 control、相同任务分层和相同 deterministic verification 合同：

- **主要指标**：P50/P95 active critical-path time per session、P50/P95 active time per 100 turns、normalized active hours per 100 comparable completed sessions，以及 raw total active hours（raw total 仅作规模报告）。
- **模型指标**：按 model configured/local/attested、context bucket `<100k`、`100–200k`、`≥200k` 和实际 route tier 分层的 TTFT/gen；没有 attestation 的样本不冒充目标模型样本。
- **等待指标**：hub parent blocked interval、wait call count、completion-before-timeout ratio、timeout/pending ratio、child job actual runtime；child runtime 不从 wait 节省中重复扣除。
- **上下文指标**：tokens before/after compaction、maintenance runtime、context bucket 转移、重复 read、repair/finding、最终质量；压缩 token 数不是时延收益。
- **验证指标**：bash 同 fingerprint 次数、失败总时长、显式合法重跑、服务 foreground blocking、eval bridge p50/p95、budget exceeded、native workflow fallback；advisory 不等于 suppressed。
- **质量指标**：完成率、deterministic verifier pass、独立 review pass、blocking finding、repair 次数、返工率、最终 unresolved 状态、会话一致性和 artifact 完整性。
- **A/B 方法**：先做单 feature arm，再做组合 arm；组合 arm 只使用 `S_combined`。如使用 factorial arm，报告 `T00/T10/T01/T11` 和 interaction，不把四个时间差相加。

### 6.4 质量守卫和停止条件

以下是**[拟议验收目标/停止门槛]**，不是已观察结果：

- treatment 完成率、最终成功率或 deterministic verifier pass 相对 control 下降超过 2 个百分点：停止相应 feature。
- author/reviewer 或 implementer/reviewer 的 model lineage 独立性、provider identity receipt、scope 或 isolation 证据缺失：立即停止并 fail closed。
- compaction 后重复 read、repair 或返工相对 control 上升超过 10%，或发现历史一致性问题：关闭 compaction feature。
- wait cap 导致 wait call count、pending loop 或父 blocked critical path 上升：关闭 wait feature；不能用历史 21.3h 上限解释该回归。
- bash advisory 出现任何实际执行被错误抑制的合法验证重跑：本推荐路径必须保持 advisory-only；如果实现变成 hard block，立即停止。
- eval budget 导致合法独立门禁被静默跳过、结果被伪造或 isolation merge 被绕过：立即停止 eval feature。
- 如果未来 C 类 search cache 试验产生任何 freshness/provider/recency 错误或敏感结果生命周期违规：立即关闭 cache，不进入 B 推广。
- treatment P50/P95 或 normalized total hours 没有达到第 1.2 节目标时，不得以组件池算术上限宣称完成；可以保留为未达目标的实验结果。
- 所有 feature off 不能恢复 control 行为或 receipt 不可证明配置关闭：停止 rollout，修复回滚路径后再试。

### 6.5 不双算的审计证据

每次报告必须同时附：

1. normalized path + interval ledger，显示每个可计时区间的 owner、起止时间、是否与其他区间重叠。
2. control/treatment 配置 fingerprint、session feature snapshot 和 route/identity receipt。
3. 单 feature marginal delta、组合 `S_combined` 和可能的 interaction；明确哪些 historical upper bound 仅为背景。
4. hub parent wait 与 child execution 的分离、eval bridge 与内部模型调用的包含关系、compaction 与 model route 对同一 TTFT 的分层。
5. 原始失败 artifact、advisory/typed failure 和最终质量结果；任何缺失证据标记为未验证，不用推测补齐。

## 7. 关键决策摘要

- 选择方案 B 作为唯一推荐：先 baseline，再以现有 canonical owner 上的独立 feature guardrail 逐项 A/B，最后才组合推广。
- 普通主会话不在本设计中启用按单轮价值动态换模；当前 `modelRoles.default` 已是 `gateway/deepseek-v4-flash:max`（低 TTFT），历史 all-Sol 主会话池残余更小，必须先按 Flash effective control 重新测量残余后才能决定是否另行设计。
- 现有 `modelRoles`、`task.agentModelOverrides`、`workflow.qualityRoutes`、quality route snapshot 和 provider/lineage receipt 是唯一模型路由 seam；不新增 router。
- 现有 hub 已事件驱动并自动投递；只增加 smart 空等上限、pending/advisory 和观测，不新增事件驱动 hub或轮询器。
- compaction 通过现有纯函数和 session-maintenance 入口提前、可配置地触发；不做真正 sidecar compaction，不牺牲活动历史一致性。
- bash 重复失败只做 fail-open advisory；eval 只增加独立 wall-clock/call budget，超限为 typed failure；`agent()` inline/isolation 语义不变。
- web search 在推荐路径只做提示纪律和可观测性，不引入没有 freshness/生命周期合同的查询缓存或合并运行时。
- 所有开关默认关闭并可独立回滚；质量、独立性、确定性验证、会话一致性和可诊断失败优先于未验证时延收益。
- 历史值、算术上限、推导、未验证假设和拟议验收目标必须分开呈现；任何组件收益不得与重叠组件相加。

## 8. Handoff

### 8.1 同会话继续

宿主原生路径：按当前宿主规则触发与 `deepseek-v4-flash:max` 异模型的只读 `gpt-5.6-sol native reviewer agent`；不得通过 shell 启动模型 CLI。评审输入集合仅为 `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`；round 4 review artifact 写入 `docs/superpowers/plans/2026-08-03-long-session-performance-optimization-subagent-review-round-4.md`（round 1–3 artifact 保留原文件；repo 已有 round-N 评审惯例）。round 4 是完整 Design Review Gate 重审（NEEDS_REVISION 后重新执行），不是 Gate Continuity Note。本设计的 `implementation_authorization` 为 `design-only`，无论 verdict 为 PASS 还是 PASS_WITH_NOTES，评审后都必须停止在设计阶段，不得进入实现。

shared-worker 路径：本设计不采用 shared-worker；若宿主原生 reviewer 不可用，应报告缺少与 `deepseek-v4-flash:max` 异模型的只读 Design Review，而不是通过 shell 启动模型 CLI 或改用同模型自审。

### 8.2 新会话恢复 prompt

```text
请读取完整设计输入集合（仅 docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md），对每个输入使用 repo-relative POSIX path；若输入在 repo 外则使用 canonical absolute path。读取文件原始 bytes，按 normalized path 排序，生成 path + lowercase SHA-256 的 `Reviewed Inputs` manifest，并将每行按 UTF-8 `<path>\t<sha256>\n` 序列化；对这些行连接后的 UTF-8 bytes 计算 `reviewed_revision`。这是 pre-review handoff，禁止伪造尚不存在的 SHA-256、manifest 或 reviewed_revision。

从设计文档元数据读取 design_author、design_author_identity、planned_reviewer、implementation_authorization 和 authorization_source；round 4 修订内容作者为 deepseek-v4-flash:max（与 reviewer 异模型），必须使用起草前选定且异模型的只读 gpt-5.6-sol native reviewer agent。不得通过 shell 启动模型 CLI，不得由作者自审；round 4 review artifact 必须完整持久化到 docs/superpowers/plans/2026-08-03-long-session-performance-optimization-subagent-review-round-4.md（round 1 完整持久化于 docs/superpowers/plans/2026-08-03-long-session-performance-optimization-subagent-review.md，round 2 于 docs/superpowers/plans/2026-08-03-long-session-performance-optimization-subagent-review-round-2.md，round 3 于 docs/superpowers/plans/2026-08-03-long-session-performance-optimization-subagent-review-round-3.md）。review artifact 必须记录 review_mode=host-native、实际 author/reviewer native agent identity 与 model、Reviewed Inputs manifest、reviewed_revision、authorization_source、可复查证据和最终 verdict。

宿主原生路径按当前宿主规则触发 gpt-5.6-sol native reviewer agent。shared-worker 路径不适用；若 native reviewer 不可用则停止并报告缺少异模型 Gate，不得通过 shell 启动模型 CLI。评审必须覆盖设计目标/范围/约束、三方案比较、单一推荐、canonical owner 复用、控制流、配置接口、失败路径、量化口径、历史事实与算术上限的区分、不双算规则、A/B baseline、质量停止条件和独立回滚。文档包含“根因分析（按需）”章节；请核对其“不需要重新诊断”的判断、引用证据与候选方案是否一致，不要重新编造根因或当前配置事实。

评审结论必须且只能是 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一，并附可复查证据。NEEDS_REVISION 时回到当前设计文档修订；NEEDS_REDESIGN 时回到 design-brainstorm 重新比较方案；两者在重新通过前都不得实现。正文发生任何目标、范围、关键决策、接口/数据流、错误行为、风险或验收义务的实质变化，必须重新执行完整 Design Review Gate；不确定、遗漏输入、角色未分离或无法看到完整 diff 时也必须重审。只有格式、拼写、链接、证据引用或不改变语义的 handoff/metadata 澄清，才可由未参与 author、reviewer、正文修改或 implementation 的主协调者记录覆盖全部输入 manifest 的 Gate Continuity Note；该 Note 必须包含 reviewed/current manifest 与 revision、变化范围、未变不变量和理由，且不改变 verdict 或授权。

本任务的 implementation_authorization=design-only；round 1 authorization_source=用户明确要求“输出为评审用设计文档……不要直接改代码”；round 2 授权=用户“修订文档从 gpt-5.6-luna 改为 deepseek-v4-flash:max 来进行，其他不变”（仍 design-only）。即使 verdict 为 PASS 或 PASS_WITH_NOTES，也必须在 review artifact 完成后停止在设计阶段；不得继续 design-implement，不得修改仓库、发布、提交或扩大授权。若后续用户另行授权实现，必须在新的权威指令下重新检查 authorization、current Inputs manifest 与 Gate continuity，再进入独立实现流程。
```
