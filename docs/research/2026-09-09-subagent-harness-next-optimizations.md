# 在近期 subagent 优化基础上的 harness 改进优先级

日期：2026-09-09。源码基线：`3e1f08414d`。性质：研究与实施建议，不是性能达标声明。

## 结论

最值得做的是：用现有记录衡量完成任务的实际成本；减少 worker 重建上下文；检查稳定前缀与实际缓存命中；按独立交付边界减少协调；用失败证据触发有限恢复。不要继续把更短超时、更多代理、更复杂路由当成默认优化。

本轮梳理近期 45 个 commit，核验关键源码，读取官方和社区一手案例。未运行真实模型 A/B，未复算 9 月 7–9 日用户会话，也未改运行时代码或本机配置。历史延迟数字只用于理解背景，不能代表最新版本。原有 `docs/local-build-install.md` 工作区修改保留。

## 1. 已有优化：保留，不重复建设

| 已落地内容 | 提交或当前证据 | 本轮判断 |
|---|---|---|
| 按收益决定是否委派，减少强制流程 | `bb36e36178`、`66cc513a0b` | 已做；下一步验证效果，不再追加同义规则 |
| 精简 worker prompt、普通 IRC 延迟到工具批次后，紧急中断显式化 | `3e1f08414d` | 已做；消息频率和交接成本仍需观测 |
| worker / review 不再强制 yield | `2d1420edc3`、`5fe79c41f8`；`src/task/review-performance.ts` | 已做；不要恢复无条件完成提醒循环 |
| explore/review/worker 预算分级、跟进和恢复合同 | `fa244c3e73`、`2d1420edc3` | 已做；更短 cap 不等于更快完成 |
| shadow 默认关闭、顾问同模型调用自动暂停 | `003c1f1868`、`8095e3761f` | 已有；独立评审是否需要仍由任务风险决定 |
| 工具计时配对、缺测不填零 | `fa660407d9`；`src/task/executor.ts:1850` | 已有请求/工具指标，不另造一套 telemetry |
| 可恢复结构化压缩 | `8189e55df9` | 已有；验证恢复完整性，不重建记忆系统 |
| 普通会话 outcome 关联结构 | `src/latency/rollout-cohort.ts:49` | 已含 verifier、重复 read/grep、fallback、用户纠正等；不是从零补 outcome |
| 本地并发基准 | `test/task/parallel-spawn-local-bench.test.ts:1` | 真实调度路径 + mock provider，仅能验证本地机制，不能证明远端加速 |

路径默认相对 `packages/coding-agent/`。

9 月 6 日事实稿统计的是旧窗口：scout 活跃 p50=3.70 min、p90=13.94 min；review/gate p50=7.28 min、p90=23.95 min。后续完成协议与提示改动发生在该窗口之后，不能把这些数字作为当前缺陷或当前收益。来源：`docs/superpowers/specs/2026-09-06-subagent-followup-worker-latency-facts-brief.md:84`。

## 2. 最值得做的五项

### P0：用现有记录做“完成任务”对照，先把统计口径接起来

**收益：** 避免为更低子任务时长牺牲最终成功率；让后续改动可比较。属于必要的测量工作，本身不承诺用户等待时间下降。

**现有基础：** `SubagentReviewMetrics` 已有 request/tool phases、spawnQueueMs、shadowWaitMs；`executor.ts:4050` 已有 resolve、sessionOpen、createSession、ready、firstChat 分段日志；ordinary observation 已有结果与重复工作字段；workflow benchmark 已有 paired quality gate。

**最小动作：** 先用现有 session/agent/job 标识离线关联这些记录，检查实际字段覆盖率，只补缺失的生命周期边界。输出每个父任务的时间线：委派准备 → 子任务排队/执行 → 结果交付 → 父接受并整合 → 最终验证。保留用户暂停、工具等待、模型等待的区别。

衡量：端到端 p50/p90、最终验证通过率、首次通过率、返工次数、总 token/cost；并列展示启动、TTFT、生成、工具、整合、重复读取。并行分支不能直接相加；只有有因果边的时间线才能计算关键路径。失败和 timeout 单独展示，不能把它们剔除后宣称提速。`requestPhases.queueMs` 当前未被生产者写入，不能视为 provider 排队；`spawnQueueMs` 只是本地 semaphore 排队。`contextTokens` 是 provider totalTokens，不是输入上下文长度。

**验收：** 同一任务、同一模型/effort、同一代码快照、同一验收器的 A/B 可以重现；unknown 不转 passed/0；合成任务不能混成 live 质量证据。复用 `src/workflow/benchmark/runner.ts:529` 的既有判定。

### P1：worker 接收可用证据，reviewer 保持独立上下文

**收益预期：高，尚未本地量化。** 最直接减少父查一遍、子再查一遍、整合时再查一遍的模型回合。

**当前事实：** `structured-subagent.ts:444` 已传 assignment/context；executor 创建子 session；现有模板还支持 planReference、artifact 引用。没有理由先增加一套交接平台。

**最小动作：** 用现有 `context` + artifact 传：已确认目标与验收、相关路径/符号、必要证据片段及版本、已失败尝试、明确的修改边界和验证归属。子代理对过时或不完整证据重读，其他证据直接复用。父整合只核验本次差异与未决风险。

**新外部信号：** LangChain 2026-09-08 将 subagent 分为 isolated 和 fork：worker 可继承父会话以避免重新搜集，verifier 保持 isolated 避免锚定。官方解释了机制，但没有量化基准。[S1]

**取舍：** 先比较“当前 brief”与“关键证据交接”；只有重复搜集仍占显著比例，再试选择性 fork。完整 fork 增加输入、继承过时判断，并不保证跨模型缓存命中。评审者可共享原始事实、diff、验收标准，不应被迫继承作者的推理与自我评价。权限、文件新鲜度与恢复引用仍须保留。

**验收：** 同任务重复读取与探索轮次下降，首次通过率不下降；能发现父诊断错误、文件已修改和摘要漏约束。少读文件数本身不是成功指标。

### P1：审计实际请求前缀，做缓存友好的小范围组装调整

**收益预期：中到高，取决于实际缓存未命中及 TTFT 占比。** 不是继续盲目缩短所有 prompt。

**具体可验证候选：** `executor.ts:3649` 把 subagent prompt 插入默认 prompt 的最后一块之前。`subagent-system-prompt.md:4` 的 context、plan，以及后续 peer roster、worktree、schema 都可能因任务不同而变化，且部分静态合作/完成规则排在动态 context 后面。因此值得检查稳定内容是否被动态段截断。这里只证明组装顺序存在候选，不证明线上的缓存失效或其收益。

**最小动作：** 比较同模型、同工具集 worker 的 provider 实际序列化请求：公共稳定规则/工具定义前置，任务特定 context、路径、peer roster 和 assignment 后置；不改变指令权限和语义。分开检查首次 sibling 请求的共享前缀与同一子会话后续回合缓存。跨进程/跨会话复用取决于 provider 的缓存作用域、有效期和路由，不能由字符串相同直接断言。

Manus 报告自身输入/输出约 100:1，并强调稳定前缀、确定性序列化和可恢复外部记忆。[S2] 该比例不是 omp 的测量。其“mask, don't remove”依赖能力，不可假设 omp 所有 provider 支持 logits masking；保留现有按需工具机制，先测是否真的扰动前缀。

**验收：** provider usage 实测 cacheRead 与 TTFT 改善；缓存 token 按 provider 统一语义后计算，不能拿 `totalTokens` 当分母；prompt 规则、工具可用性和安全边界不变，质量对照通过。

### P1：减少协调回合，按交付边界并行

**收益预期：高，但委派收益策略刚上线，先观察，再改。** 用已有 task/hub 就能实践。

**最小动作：** 小而有界的任务由父直接完成；可独立检验的研究/修改并行；共享文件或接口变更尽量同一个 owner 一次调查并实现。父只在有新事实、紧急纠正或明确依赖时发消息；复用刚完成子代理的有效上下文处理相关修正。不要再增加协调代理或固定的 scout→author→review→repair 链。

Cursor 的数百代理实验中，共享锁使 20 个代理降到约 2–3 个代理的有效吞吐；额外 integrator 形成瓶颈，删除后更简单。[S3] 这是超大规模项目经验，不是小规模 omp 的加速基准；也不意味着取消父最终整合和必要的独立评审。

**并发调参：** 先在真实 provider 测 1/2/4 等有界并发，观察成功完成的总时长、TTFT、429/重试和父等待；`provider-concurrency.ts:19` 的 provider 专用设置当前只列 ollama-cloud，不能声称所有服务已经有同样限流。只有明确出现远端竞争后，才扩展已有 limiter，不新建调度器。不要直接增大全局并发上限。

**验收：** 委派+消息+整合回合下降，同时没有遗漏验收、同文件覆盖和队列饥饿；当前本地 mock benchmark 继续只报告本地证据。

### P2：只针对重复失败做有限恢复，并按任务校准推理档位

**收益预期：主要改善长尾，必须先有新版本失败轨迹。**

LangChain 固定 GPT-5.2-Codex，仅改 harness，Terminal Bench 2.0 从 52.8 到 66.5；文章报告全程 xhigh 因超时只得 53.9，高档 high 得 63.6，并尝试规划/验证更高、实现较低的分配。[S4] 这是特定模型和超时任务集，不可套用成本地模型排行或机械采用 xhigh-high-xhigh。

**最小动作：** 按机械执行、复杂实现、独立评审做现有 model/effort 的成对评测。以完成正确任务的总成本选档，不以单 token 价格决定任务模型。若模型的 effort 已被 provider 固定，改标签没有意义，必须核验实际请求。

现有 bash-attempt-ledger 已识别 command+state+failure 相同的失败；本轮不是新增“反循环系统”。只有轨迹证明 edit/search 有未覆盖循环时，扩展现有工具错误反馈：相同输入和状态重复失败时给一次具体纠正，仍无新证据则报告 blocker 或按已有策略升级。文件修改次数不能单独视作无进展，持续合理编辑不能被强停。

**质量边界：** LangChain 的完成前验证提醒有收益，但 omp 刚消除强制 yield；不应照搬无条件 stop-hook 循环。验证归属必须有且只有明确负责人：worker 提供局部证据或将验证显式移交父；父在整合完成后跑必要检查。缺验证是未验证，不可自动变成功。

## 3. 暂时不值得做

- 再缩短 explore/review cap 来追求漂亮时长：可能只是增加 timeout 和重派。
- 默认完整 fork 所有子代理：研究任务无谓复制上下文，评审可能失去独立性。
- 额外的 coordinator/integrator/review-of-review 常驻角色：先证明带来的质量收益超过调用与等待成本。
- 每回合新增一次 LLM 路由/任务复杂度判断：自身有成本，还可能破坏缓存和连续性；优先复用现有分类。
- 因 pi 工具少就移除 omp 的权限、恢复、安全编辑或用户已请求能力：最小工具集是其产品选择，不能自动迁移。[S5]
- 新建第二套 DAG、调度器、memory、观测平台：当前已有足够扩展点。
- 以“越短越好”统一降低工具输出上限：分页往返也消耗模型回合；应比较有界片段与恢复成本。[S6]
- 大改 worker 生命周期来抠启动毫秒：先读 `subagent launch timing`，若真实大头仍是模型分钟级推理，优先级较低。

## 4. 推荐实施顺序与实验

1. 固定当前 HEAD 为基线，抽取新版本有代表性的任务，核对结果/计时/模型/配置覆盖率。初期少量成对任务用于筛选方向，不能用极小样本宣称 p90 改善。
2. 单独验证关键证据交接、稳定前缀布局；保持其余配置相同。分别控制冷/热缓存、provider、模型、effort、仓库快照、工具集和并发；交替运行 A/B 避免时段偏差。
3. 有证据后才做并发与档位调参，优先改配置和已有 owner 的少量代码。
4. 从新版本慢/失败 trace 中选真实循环案例修复，不做泛化反循环框架。

任务至少覆盖：小范围查询（应直接做）、已诊断修复（交接收益）、独立双模块修改（并发收益）、共享接口修改（协调风险）、带已知缺陷的 review（检出率）、过时证据/恢复后继续（上下文保真）。

对速度同时报告：成功任务耗时与所有尝试耗时；对质量报告：验证通过、漏检已知缺陷、错误通过、返工、用户纠正。不要用 schema-valid 或进程正常退出替代正确完成。普通会话覆盖与 workflow fixture 覆盖分开。首轮采用现有 benchmark 的重复次数/质量门；如要报告尾部分位数，需要足够同类真实样本并注明不确定性。

## 5. 已核验一手来源

- **[S1] LangChain，2026-09-08，Organizing Context in a Multi-Agent Harness**：https://www.langchain.com/blog/organizing-context-in-a-multi-agent-harness 。本轮读到正文；fork/isolated 的设计案例，无速度百分比。
- **[S2] Manus / Yichao Ji，2025-07-18，Context Engineering for AI Agents**：https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus 。正文已核验；生产经验及产品自身数据，作者明确不是普适真理。
- **[S3] Cursor / Wilson Lin，2026-01-14，Scaling long-running autonomous coding**：https://cursor.com/blog/scaling-agents 。正文已核验；数百代理长期工程实验，包含共享锁和 integrator 反例；不能用代码行数代替正确性。
- **[S4] LangChain / Vivek Trivedy，2026-02-17，Improving Deep Agents with harness engineering**：https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering 。正文已核验；固定模型 Terminal Bench 2.0 厂商实验，公开 trace 链接；本轮没有独立复跑。
- **[S5] Mario Zechner，2025-11-30，What I learned building an opinionated and minimal coding agent**：https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ 。作者社区一手经验，正文已核验；小 prompt/工具、上下文可见性与简单循环，不能据此移除已有保护。
- **[S6] Anthropic，2025-09-11，Writing effective tools for agents — with agents**：https://www.anthropic.com/engineering/writing-tools-for-agents 。正文已核验；强调可验证真实任务、工具输出的相关性、token/调用次数/错误联合评价。
- **[S7] OpenAI / Ryan Lopopolo，2026-02-11，Harness engineering**：https://openai.com/index/harness-engineering/ 。已核验知识地图、机械化约束、agent 可读取验证环境的段落；团队案例估算不是 omp 的因果收益。不照搬其长时任务和反复 review 流程。
- **[S8] Anthropic，2025-06-13，How we built our multi-agent research system**：https://www.anthropic.com/engineering/multi-agent-research-system 。正文已核验；内部研究评测提升 90.2%，复杂查询并行研究耗时最多减少 90%，但多代理约消耗聊天的 15 倍 token，且明确多数编码任务可并行部分更少。这些数字分属不同口径，不能作为 omp 收益。
- **[S9] Cognition / Walden Yan，2025-06-12，Don’t Build Multi-Agents**：https://cognition.com/blog/dont-build-multi-agents 。正文已核验；强调交接丢失隐含决策与并行决策冲突，是作者工程观点和解释性案例，不是受控性能实验。文中 Claude Code 描述仅适用于当时版本。

### X/Twitter 原帖与社区反馈

两条原帖均由 read 工具通过 Nitter 镜像取得正文，未使用登录态；正文观点与上述作者官方博客互证。镜像评论不能证明社区普遍意见，也不引用其点赞/浏览数作可信度依据。

| 原帖 | 核验内容 | 对 omp 的启示 |
|---|---|---|
| [Anthropic，2025-06-13](https://x.com/AnthropicAI/status/1933630785879507286) | 宣布并行 Research 工程文章；返回的回复中有人担忧代理如何处理相互矛盾的结论，以及引用控制质量 | 调研可以并行，但来源/引文准确性必须作为最终验收，代理数量不能替代证据 |
| [Walden Yan，2025-06-12](https://x.com/walden_yan/status/1933264183837282558) | 分享 Cognition 的 agent 原则；作者在回复中说并行只读问题较小，并对主代理汇总多来源的模式作出推测 | 独立只读研究与共享状态代码修改需要不同拆分；不能把反对多代理的标题当作全面禁用 subagent 的依据 |

这是可核验的一手讨论，并非近期 X 舆情普查。本轮较新且直接相关的证据来自 2026-09-08 LangChain 正文；没有找到并核验足以量化当前 omp 速度的近期 X 案例。

上述分歧并不支持一刀切：Anthropic 的收益来自宽度优先、相互独立的研究；Cognition 的担忧来自交接信息丢失和隐含决策冲突；LangChain 的 worker fork / verifier isolated 正好提供按任务关系选择的折中。建议维持默认精简交接，选择性继承证据，对共享修改少拆分。

### 本次研究中的一个实际失败样本

外部资料 scout 在 600000 ms 上限退出，completionKind=timeout，没有完整研究报告；Main 从保留的历史中取得来源线索，再直接核验原文。该单次事件不是产品基准，不能推出通用根因或耗时占比。但它说明“hard cap 生效”与“按时交付有用结果”是不同指标。可在现有输出保留/恢复能力上验证：有截止期限的研究先形成最小可交付证据，资料足够后收口；耗时网络调用失败时保留已完成来源与未核验缺口，避免末尾才集中写报告。不为此恢复强制 yield 或增加周期性汇报回合。

## 6. 验证范围

本轮验证是文档与证据核验：提交记录、关键生产者/字段/提示组装、基准模式与质量门、外部原文。未执行产品测试或实网 benchmark，因为没有产品行为变更。最终建议是可实验的优先级，不是声称已经实现这些优化。

## 7. 后续实施

用户已授权首批实施。当前代码、回归修复、194项相关测试、离线采样、本地mock并发验证与实网资格失败边界，见 `docs/superpowers/plans/2026-09-09-subagent-harness-next-optimizations-implementation.md`。只落地离线报告、关键证据交接和稳定前缀；完整fork及并发/effort/cap自动调整未启用。真实端到端/缓存收益仍未验证。
