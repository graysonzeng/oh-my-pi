# Agent 输出质量与任务耗时优化研究

- 日期：2026-08-26
- 范围：oh-my-pi 的 System Prompt、工具调用、模型路由、上下文工程
- 目标：在不降低任务完成质量的前提下，减少无效重试、重复探索、上下文浪费和 provider 等待时间
- 状态：研究与优化建议；不是已验证的性能收益承诺

## 1. 结论摘要

oh-my-pi 已经具备较成熟的 Prompt 分层、工具调度、模型能力识别、上下文压缩、Memory、优化 receipt 和离线质量门禁。当前最高杠杆不是再建设一套新的 Agent Control Plane，而是：

1. 把已有 Prompt、工具、路由、上下文 receipt 与最终任务结果关联起来，知道什么策略真正提高了 first-pass 成功率。
2. 优先修复已经有用户证据的失败路径：编辑误删、空输出不触发 fallback、rewind 后重复劳动、并行 Agent 文件互相覆盖、长会话 provider 400。
3. 用冻结配置、单变量、成对任务矩阵验证每项优化；质量不退化后再比较墙钟时间。
4. 按“确定性修复 → 自适应策略 → 学习型路由”推进；跨 turn DAG、第二套语义压缩和新学习型 router 暂不进入主线。

以下收益均为预期收益，需要用本项目真实任务 A/B 验证。外部论文和社区反馈用于提出假说，不能代替 oh-my-pi 本地证据。

## 2. 研究方法与证据边界

### 2.1 代码审计范围

- `packages/coding-agent/`
- `packages/agent/`
- `packages/catalog/`
- `packages/snapcompact/`
- `packages/mnemopi/`
- `packages/metaharness/`

### 2.2 外部证据优先级

1. 官方 API、Prompt、Tool Use、Caching、Compaction 文档。
2. 学术论文和公开 benchmark。
3. oh-my-pi 自身 issue、复现记录和代码注释。
4. Hacker News、Reddit、X 等社区反馈。

社区内容只作为个案信号，不作为模型排名或发生率证据。论文中的成本或质量增益不能直接套用到 oh-my-pi。

### 2.3 独立审查

研究分别对 System Prompt、工具调用、模型路由、上下文工程进行了只读审计，并经过独立 reviewer 复核。reviewer 的主要纠偏是：

- 不要把已有 receipt、ContextLedger、lazy tool catalog、auto-thinking 和离线 quality gate 误当成缺失能力。
- 不要新建第二套控制平面；应先把现有 receipt 接到任务 outcome。
- 不要把当前 3% 离线质量门禁当成生产实时熔断器。
- typed trust、跨 turn DAG、学习型 router 等研究方向不能挤掉已知真实缺陷。

## 3. 当前实现基础

| 维度 | 当前基础 | 主要代码位置 |
| --- | --- | --- |
| System Prompt | 静态 Markdown 资产、项目规则和技能注入、上下文去重、模型族 Prompt 策略、workflow 稳定/动态分段与 hash receipt | `packages/coding-agent/src/system-prompt.ts`、`src/workflow/prompt-assembly.ts`、`src/workflow/prompt-strategy.ts` |
| 工具调用 | essential/discoverable/xdev 分层、严格 schema、单批并发、资源冲突、有序回写、输出截断和恢复 artifact、bash failure ledger | `packages/coding-agent/src/tools/`、`packages/agent/src/agent-loop.ts`、`packages/agent/src/types.ts` |
| 模型路由 | catalog 身份/能力/thinking 物化、role/profile 路由、reviewer vendor 多样性、quality route fail-closed、fallback、tiny inference、auto-thinking | `packages/catalog/src/`、`packages/coding-agent/src/workflow/model-router.ts`、`src/auto-thinking/classifier.ts` |
| 上下文工程 | token/message cache、prefix-cache 友好的消息拆分、prune/shake/native/LLM/snapcompact、多级 Memory、ContextLedger | `packages/agent/src/compaction/`、`packages/coding-agent/src/session/`、`packages/snapcompact/`、`packages/mnemopi/` |
| 评测 | workflow benchmark、metaharness、latency arms、3% 离线 quality gate、组合实验 `combinedArmId` | `packages/coding-agent/src/workflow/benchmark/`、`src/latency/arms.ts`、`packages/metaharness/` |

### 3.1 重要限定

- 完整的 `PromptAssemblyReceipt` 和 `ContextLedger` 主要存在于 workflow 路径，不能等同于普通交互会话已经全面覆盖。
- 普通会话已有 `OrdinaryDecisionReceiptV1` 和 latency arms，但当前证据不足以证明它们已经与最终任务 outcome 全面关联。
- 现有 3% quality gate 是离线 suite 比较器，不是 live router 的实时熔断机制。
- `system-prompt.md` 源文件约 18.6 KB；抽样核心 Prompt/工具描述源文件约 43.9 KB。源文件大小不等于运行时 token，也不代表这些内容全部同时注入，但说明后续规则增加必须测量，而不能只凭直觉。

## 4. 外部研究得到的共同结论

### 4.1 Prompt 不是越长越好

Anthropic 的 Context Engineering 指南建议使用“足以说明行为的最小信息集合”：过于模糊无法指导模型，过于具体和冗长则会产生脆弱规则和维护负担。OpenAI 与 Anthropic 的模型指南都强调长上下文中的 re-grounding、结构化分区和基于 eval 的迭代。

对应 oh-my-pi 的含义：

- 不应继续通过增加 MUST/NEVER 来修复确定性 runtime bug。
- 每条规则应绑定真实 failure case。
- 不同模型族应分别评测，不假定同一 Prompt 对 Claude、GPT、Gemini、DeepSeek 都最优。

### 4.2 工具接口本身会显著影响 Agent 表现

Anthropic 的工具设计文章和 SWE-agent 论文都指出：清晰的工具边界、参数定义、错误回复和 Agent-Computer Interface 会直接改变工具成功率。OpenAI 的 Tool Search 进一步表明，大量工具可以延迟加载，避免把所有 schema 一次放入上下文。

对应 oh-my-pi 的含义：

- 重点不是增加更多工具，而是让模型能明确判断“何时用、何时不用、失败后怎么修”。
- essential/discoverable/xdev 已经存在，应继续复用，而不是再建设第二套目录。
- provider schema 和 wire 差异应由确定性适配层处理，不应让模型猜。

### 4.3 长上下文不等于可靠记忆

“Lost in the Middle”显示，相关信息位于长上下文中部时，模型表现可能明显下降。Anthropic 和 OpenAI 的 Compaction/Prompt Caching 文档也把上下文管理视为质量、成本和延迟之间的权衡。

对应 oh-my-pi 的含义：

- compaction 摘要格式合法，不代表关键文件、symbol、测试结果和未决问题没有丢失。
- 应保留机器可检查的 evidence ledger。
- 文件内容未变化时应引用已有 artifact，而不是重复注入全文。

### 4.4 路由必须理解任务阶段和失败历史

RouteLLM 证明了强弱模型动态选择可能降低成本，但这类收益依赖训练数据、任务分布和评测方法。HN 的模型路由讨论指出，透明代理 router 可能破坏 Prompt Cache 和 Agent 已有的“探索、计划、实现、review、失败升级”控制循环。

对应 oh-my-pi 的含义：

- 先做能力过滤、错误分类和 provider 健康，再讨论 learned router。
- 路由需要知道当前角色、任务阶段、此前失败原因和工具需求。
- 不增加每 turn 独立分类调用；优先扩展现有 auto-thinking 和 mechanical classification。

## 5. 用户反馈和真实失败信号

| 反馈 | 用户可观察的问题 | 优化含义 |
| --- | --- | --- |
| [#9717 DeepSeek v4 Flash 误用 edit](https://github.com/can1357/oh-my-pi/issues/9717) | 大块编辑吃掉结构、错误恢复重复失败、最终重写整个文件 | edit 应 fail-closed；大编辑分段；错误结果不能提供未经验证的“原样重发”内容 |
| [#9523 empty stop 不进入 fallback](https://github.com/can1357/oh-my-pi/issues/9523) | 同模型重试耗尽后终止，而不是切换模型 | 明确定义空输出的 fallback eligibility |
| [#9748 rewind 后重复读取和重复回答](https://github.com/can1357/oh-my-pi/issues/9748) | 重复探索、重复 checkpoint、多个答案 | 保留已完成 span、读取路径和已交付回复的短 provenance marker |
| [#9747 并行 Agent 文件所有权](https://github.com/can1357/oh-my-pi/issues/9747) | 主 Agent 把运行中子 Agent 的中间状态误判成失败并覆盖文件 | 明确 in-flight ownership；完成或取消前不得覆盖目标文件 |
| [#9638 Gemini 长会话 400](https://github.com/can1357/oh-my-pi/issues/9638) | 会话后续请求持续失败 | 基于 rejected request 对比做 provider payload RCA，不能先假定只是上下文太长 |
| [HN：LLM Agent Tool Loop](https://news.ycombinator.com/item?id=43998472) | 不同模型的并行工具和主动调用倾向差异明显 | 工具策略需要按模型族评测 |
| [HN：模型路由讨论](https://news.ycombinator.com/item?id=48688700) | 外置 router 可能破坏缓存、失败升级和 Agent 控制循环 | 路由必须接收角色、阶段和失败历史 |
| [Reddit：Compaction 后失忆](https://www.reddit.com/r/ClaudeAI/comments/1rrkv0h/how_are_you_guys_managing_context_in_claude_code/) | 摘要丢失变量名、错误和设计决策 | 压缩需要事实清单和恢复引用 |
| [Karpathy：Context Engineering](https://x.com/karpathy/status/1937902205765607626) | 过多或不相关上下文会增加成本并可能降低表现 | 优化重点应从单条 Prompt 扩展到完整上下文工作集 |

## 6. 建议变更

## 6.1 第一类：修复直接造成返工的失败路径

### 变更

1. 模型连续返回无可交付内容时，让 capped empty stop 进入明确的 fallback chain。
2. `edit` 无法证明目标唯一且安全时不落盘；错误必须明确说明是否有任何修改已经发生。
3. rewind 后保留已完成 span、已读取路径、已交付回复和 checkpoint ID 的短 marker。
4. 子 Agent 运行期间，其声明的目标文件视为 in-flight owned；主 Agent 不得用中间磁盘状态判断结果，更不得覆盖。
5. 长会话 provider 400 必须比较最后一次成功请求和第一次失败请求，按 message、tool schema、thought signature、call ID、effort、context size 分类。

### 预期优势

- 输出质量：高。减少误删、半成品、重复回答和错误恢复。
- 延迟：高。减少重复探索、同模型无效重试和并行写入冲突。

### 适用场景

- 长时间编码任务。
- 多 Agent 并行修改。
- 多 provider 或工具兼容性差异明显的模型。
- 发生空响应、长会话 400 或 edit 重复失败时。

### 优先级

最高，应当首先完成。

## 6.2 第二类：把现有运行记录关联到最终结果

### 变更

复用已有 Prompt、Context、Tool、Route、Ordinary receipt，补齐关联字段：

- session/turn/task/attempt ID；
- model、provider、effort、role；
- Prompt stable/dynamic hash；
-工具策略和 context strategy；
- fallback 和错误类别；
-最终 verifier outcome；
-是否需要用户纠正、回滚或重复实现；
-端到端 wall-clock。

不创建新的平行 receipt 格式。workflow 和普通会话分别标记覆盖范围，不能把 workflow 数据当成全产品事实。

### 预期优势

- 输出质量：间接但关键。能识别真正提高 first-pass 成功率的策略。
- 延迟：间接但关键。能区分时间浪费在模型、工具、重试、压缩还是检索。

### 适用场景

所有生产使用和后续优化实验。没有 outcome join 时，不应上线 learned router 或自动策略优化。

### 优先级

最高，与第一类同步推进。

## 6.3 第三类：精简 System Prompt

### 变更

1. 为现有 Prompt 增加离线 linter：检查重复 RFC 2119 规则、互相冲突的 MUST/NEVER、未解析 Handlebars、同义段落重复、动态值进入稳定前缀。
2. 每条规则绑定真实 failure case；删除规则时按段落做单变量消融。
3. Claude、GPT、Gemini、DeepSeek 分别评测 Prompt 密度和结构。
4. 在 receipt 中记录 section source、hash、authority、static/dynamic 和 token 估算；这些调试信息默认不注入模型。
5. 普通会话复用 workflow 的稳定前缀/动态尾原则。provider cache hit 只相信 provider usage counter。
6. 对 README、issue、tool result、网页和 MCP 返回中的伪指令做 AgentDojo/InjecAgent 风格评测；只有 delimiter/trust 提示在正常任务和攻击任务上都通过时才进入生产 Prompt。

### 预期优势

- 输出质量：中到高。减少规则冲突、机械执行和忽略用户目标。
- 延迟：中。减少输入 token，提高缓存命中并缩短 TTFT。

### 适用场景

- System Prompt、项目规则和 skills 较多。
- 模型经常遵守一条规则却违反另一条更重要的规则。
- 同一要求在多个 Prompt 层重复出现。

### 不建议

不要一次性重写整个 Prompt，也不要仅凭“看起来更简洁”上线。

## 6.4 第四类：稳定前缀与动态尾

### 变更

固定内容保持稳定顺序和格式：

- System Prompt；
-工具定义；
-长期项目规则；
-角色说明。

动态内容放在末尾：

-当前任务；
-最新文件和工具结果；
-当前进度；
-本轮用户输入。

workflow 已有对应 assembly；普通会话应复用现有 append-only context、delta split 和 receipt，而不是新建并行实现。

### 预期优势

- 输出质量：中。固定规则更稳定，不易被动态内容打乱。
- 延迟：高。支持 Prompt Cache 的 provider 可以减少重复计算。

### 适用场景

- 长会话。
- 同一项目连续执行多个任务。
- System Prompt 和工具 schema 较大。
- 使用支持 Prompt Cache 的 OpenAI、Anthropic 等 provider。

## 6.5 第五类：工具按需加载与结构化错误

### 变更

1. 保持 read、edit、bash、glob、task 等核心工具 essential。
2. browser、GitHub、图片、调试器和大量 MCP 工具继续通过 discoverable/xdev 按需加载。
3. 支持 OpenAI `tool_search` 的模型可实验 provider-native deferred loading；其他模型继续现有 xdev。
4. 统一工具错误类别：`validation`、`permission`、`not_found`、`conflict`、`transient_provider`、`timeout`、`partial_side_effect`、`verification_failed`。
5. 参数错误返回字段路径、期望类型、是否可重试、重试时必须改变什么、是否已产生副作用。
6. 将 bash failure fingerprint 扩展到 read/edit/grep/MCP，但保持 advisory/fail-open，不自动 skip 合法重试。
7. 工具结果继续双轨：模型看到结构化摘要和受限原文，TUI/artifact 保存完整输出和 hash。

### 预期优势

- 输出质量：高。减少选错工具、schema 错误和重复失败。
- 延迟：中到高。减少工具 schema token 和无意义修复轮次。

### 适用场景

- 安装了大量 MCP 或扩展工具。
- 模型经常在相似工具之间选错。
- provider 对 JSON Schema、parallel calls 或 wire ordering 支持不一致。

### 不建议

不要重建第二套工具目录，也不能让核心工具被错误地延迟加载。

## 6.6 第六类：压缩时保留事实清单

### 变更

不增加第二个 LLM 摘要器，而是在当前 compaction 输出周围增加确定性 fidelity validator。事实清单至少包含：

-用户目标；
-已做决策；
-读取和修改的文件；
-关键 symbols；
-运行过的命令与结果；
-未解决错误；
-恢复 artifact/hash。

同时把 workflow 已有的 read-view/hash/artifact 能力扩展到普通会话：文件未变化时引用旧 artifact，文件变化后使旧缓存失效。

### 预期优势

- 输出质量：高。减少压缩后忘记变量名、文件、测试结果和未完成事项。
- 延迟：高。减少重复读取、重复注入和重新探索。

### 适用场景

- 长会话。
- 跨多个文件的任务。
- 经历多次 compaction。
- 中断、branch 或 checkpoint 恢复。
- 大量 read/grep/bash 输出。

## 6.7 第七类：模型路由先判断“能否完成”，再判断“谁更快”

### 变更

1. 能力硬过滤：tool calling、vision、context、thinking effort、structured output 不满足时，候选不进入评分。
2. 修复 empty-stop 等 fallback 语义；deterministic 4xx 和 schema 错误不能在相同模型上盲目重试。
3. 扩展已有 route/identity/ordinary receipt 与 outcome 的关联，不新增 RouteDecisionReceipt。
4. P2 再增加 provider health：近期 429、5xx、timeout、TTFT、P95、成功率和带 TTL 的 circuit breaker。
5. 扩展现有 auto-thinking：使用任务角色、工具失败次数、上下文使用率和 deadline；不增加每 turn 独立分类调用。
6. 规则路由顺序保持为：能力与身份 gate → 角色/任务评分 → provider 健康和失败升级 → 可选 learned router shadow。
7. learned router 只有在积累足够本地 outcome 数据后才进入 shadow/canary，不直接影响生产结果。

### 预期优势

- 输出质量：高。避免把任务交给不支持所需能力的模型。
- 延迟：高。简单任务可用快模型，故障 provider 可及时绕开。

### 适用场景

- 配置多个模型或 provider。
- 探索、实现、review 的任务性质不同。
- provider 偶尔限流或故障。

### 不适用

只有一个模型和一个 provider 时，复杂路由收益有限。

## 6.8 第八类：每次只上线一个优化变量

### 变更

复用现有 latency arms 和 `combinedArmId`：

1. baseline；
2. 只改 Prompt；
3. 只改工具；
4. 只改路由；
5. 只改上下文；
6. 单变量通过后，再运行明确登记的组合实验。

### 预期优势

- 输出质量：高。可以准确发现哪项改动造成质量下降。
- 延迟：中。避免上线无效或负收益的复杂策略。

### 适用场景

所有行为变化和默认值调整。

## 7. 推荐实施顺序

### P0：真实失败与观测闭环

1. 将 workflow/ordinary/tool/context/route receipt 关联到最终 outcome。
2. 建立真实 issue replay suite：#9523、#9717、#9748、#9747、#9638。
3. 修复 edit fail-closed 和 empty-stop fallback。
4. 明确 in-flight file ownership 和 rewind provenance。
5. 普通会话记录 wall-clock、tool calls、重复 read/grep、fallback、用户纠正。

### P1：确定性质量保护

1. Prompt linter、来源/section 元数据、单变量消融。
2. 工具错误 taxonomy 与 provider schema preflight。
3. 当前 compaction 的 evidence fidelity validator。
4. 普通会话稳定前缀、动态尾和内容 hash 去重。

### P2：自适应选择

1. provider health/circuit breaker。
2. 基于现有 essential/discoverable/xdev 的按需工具发现。
3. 扩展现有 auto-thinking/mechanical classification。
4. lost-middle 数据支持后再启用 relevance packing。
5. 测量 Mnemopi precision/freshness 后再决定 memory gate。

### P3：仅实验

1. RouteLLM 风格 learned router。
2. 跨 turn 工具 DAG。
3. contextual bandit 或自动策略学习。

P3 只有在 P0-P2 积累足够 outcome 数据后才有可靠训练和验证基础。

## 8. 实验与指标

### 8.1 基础设施

复用：

- `packages/coding-agent/src/workflow/benchmark/`
- `packages/metaharness/`
- `packages/coding-agent/src/latency/arms.ts`
-现有 Prompt/Context/Optimization receipt

### 8.2 实验约束

- 普通实验只激活一个 lever。
- 组合实验必须注册 `combinedArmId` 和 child arms。
- 每个模型 × provider × task class 使用冻结 repo snapshot 和相同任务。
- 现有代码要求行为变化 arm 使用至少 30 个成对任务矩阵；该数字是最低门槛，最终样本量应由实际波动和统计功效决定。
- 使用多个 seed 和 bootstrap confidence interval，不只报告平均值。
- 当前 3% gate 仅用于离线冻结臂比较，不能直接变成 live router 熔断器。

### 8.3 实验矩阵

| 实验 | Baseline | Treatment | 主质量指标 | 时延/成本指标 |
| --- | --- | --- | --- | --- |
| Prompt | 当前模型族 Prompt | 单段消融、动态尾、来源 delimiter | first-pass success、指令违例、注入成功率 | 输入 token、cache hit、TTFT、wall time |
| Tools | 当前目录和错误回复 | lazy tool、结构化错误、edit fail-closed | schema valid、postcondition pass、恢复成功率 | tool calls、修复 turn、queue/run P95 |
| Routing | 当前 role/profile 路由 | capability+health、现有 auto effort 调优 | verified success、fallback 后成功率 | TTFT、total wall、cost/task |
| Context | 当前 prune/shake/compact | fidelity validator、hash 去重、re-grounding |事实/文件/symbol recall、最终 patch pass |压缩耗时、峰值 token、重复读取数 |
| Failure replay | 当前代码 | 单个缺陷修复 | issue reproduction 不再触发 |浪费 turn、重试数、恢复时间 |

### 8.4 指标层级

主指标：

- `first-pass verified success`：无需用户纠正即可通过任务指定 verifier。

辅助质量指标：

- user correction rate；
- rework/rollback count；
-错误工具参数率；
-重复失败率；
- postcondition pass；
- compaction fact recall；
- prompt injection attack success rate。

时延指标：

-端到端 wall-clock P50/P95；
- TTFT；
-模型推理、工具 queue/run、compaction、检索、重试分段耗时；
-无效调用和重复读取占比。

上下文与成本指标：

-各 section 输入 token；
- cache read/write；
-上下文峰值；
- tool-result retained ratio；
- reasoning/output token；
- cost per verified task。

## 9. 明确不建议当前实施的方案

1. 不创建第二套 Control Plane、receipt、tool catalog 或 compaction pipeline。
2. 不通过增加更多 MUST/NEVER 掩盖确定性 runtime bug。
3. 不把信任/provenance 调试元数据默认全部渲染进 Prompt。
4. 不增加每 turn 的独立难度分类模型调用。
5. 不因重复失败自动跳过工具；保持 advisory/fail-open。
6. 不在根因未知时用“更频繁压缩”处理 provider 400。
7. 不把论文或外部 benchmark 的降本比例当成本项目收益承诺。
8. 不把当前 3% 离线门禁当作生产实时熔断器。
9. 不在缺少本地 outcome 数据时直接上线 learned router。
10. 不在现有单批工具调度之上立即增加跨 turn DAG。

## 10. 关键来源

### 10.1 官方文档与论文

- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic, [Writing tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Anthropic, [Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- Anthropic, [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- OpenAI, [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- OpenAI, [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- OpenAI, [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- OpenAI, [Compaction](https://developers.openai.com/api/docs/guides/compaction)
- Ong et al., [RouteLLM](https://arxiv.org/abs/2406.18665)
- Liu et al., [Lost in the Middle](https://arxiv.org/abs/2307.03172)
- Yang et al., [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793)
- Wallace et al., [The Instruction Hierarchy](https://arxiv.org/abs/2404.13208)
- Debenedetti et al., [AgentDojo](https://arxiv.org/abs/2406.13352)
- Zhan et al., [InjecAgent](https://arxiv.org/abs/2403.02691)

### 10.2 社区与用户反馈

- Andrej Karpathy, [Context Engineering](https://x.com/karpathy/status/1937902205765607626)
- Hacker News, [The unreasonable effectiveness of an LLM agent loop with tool use](https://news.ycombinator.com/item?id=43998472)
- Hacker News, [Smart model routing directly in Claude, Codex and Cursor](https://news.ycombinator.com/item?id=48688700)
- Reddit, [Claude Code context/compaction feedback](https://www.reddit.com/r/ClaudeAI/comments/1rrkv0h/how_are_you_guys_managing_context_in_claude_code/)
- oh-my-pi issues: [#9717](https://github.com/can1357/oh-my-pi/issues/9717)、[#9523](https://github.com/can1357/oh-my-pi/issues/9523)、[#9748](https://github.com/can1357/oh-my-pi/issues/9748)、[#9747](https://github.com/can1357/oh-my-pi/issues/9747)、[#9638](https://github.com/can1357/oh-my-pi/issues/9638)

## 11. 相关项目文档

- `docs/research/2026-07-28-per-model-output-quality-evidence.md`
- `docs/research/2026-07-28-conversation-token-cost-optimization.md`
- `docs/superpowers/specs/2026-07-30-quality-gated-multi-model-optimization-design.md`
- `docs/superpowers/specs/2026-08-01-quality-first-model-routing-goal-design.md`
- `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`

## 12. 验收标准

本研究文档转为实施计划时，应满足：

1. 每项行为变化绑定一个可复现 failure 或明确 benchmark case。
2. 每项变化指定唯一 owner、现有扩展点和非目标。
3. 先定义 verifier 和主质量指标，再实现优化。
4. 单变量实验通过后才能进入组合实验。
5. 质量结论只针对明确的模型、provider、任务集和代码版本。
6. 所有收益报告同时包含质量、墙钟时间和重复工作指标。
