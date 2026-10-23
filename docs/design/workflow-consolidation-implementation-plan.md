# Workflow 架构收敛：背景、落地方案与验收标准

- 日期：2026-09-27。
- 状态：待实施；本文件不是实现完成报告，也不代表已证明性能收益。
- 用途：新会话独立完成实现、验证和结果交付，不依赖原聊天、临时 artifact 或子代理报告。
- 目标：提高一次交付被接受的比例，减少重复调查、重复验证、模型往返和重复输入；同时降低状态复杂度与后续维护成本。
- 决策：优先统一验收事实与预算，再删除重复上下文和执行逻辑，最后收敛引擎职责。不是重写运行时，也不是新增一个调度/分析平台。

## 1. 背景与固定基线

### 1.1 对比点

| 名称 | 固定提交 | 含义 |
| --- | --- | --- |
| main | `7b141199d524b859c357fc89654f10b62b9f3df1` | 本地 17.0.7 快照，也是本次 main/workflow 的 merge-base |
| workflow / 审计 HEAD | `d94b0194b7a303a3fda60401a2488e72dc8d96a4` | 本方案依据的工作分支 |
| 上游集成基座 | `6204b7508014bcdf12d95f0b3fd470905fd99344` | workflow 集成到 18.3.1 系列上游时的第一父提交 |
| 集成提交 | `34ef19064206e72984bb92d1b62cd5c973853d44` | `merge: integrate workflow customizations onto main 18.3.1` |

在上述固定点，`git rev-list --left-right --count main...workflow` 为 `0 11909`。大量历史属于上游升级，不能视为 workflow 设计本身的工作量。

- main/workflow 全仓端点差异：7,971 文件，2,253,947 行新增、479,906 行删除；包含上游升级、生成文件和大规模迁移。
- 仅 `packages/coding-agent/src/workflow` 与 `docs/workflow.md` 的 main 三点差异：75 文件、26,766 行新增。
- `6204b75080 → d94b0194` 的 `packages/agent/src` 与 `packages/coding-agent/src`：411 文件、66,579 行新增、1,693 行删除；用于辅助隔离 workflow 定制，不替换用户要求的 main 基线。

以上是 Git 差异统计，不是复杂度或性能测量。后续会话若 HEAD 改变，应先记录新 HEAD、定位相关增量并复核受影响结论；不要重读全部提交历史。

### 1.2 已有产品契约

本方案延续以下文档，发生冲突时先核对当前源码与用户授权，不静默覆盖：

- [workflow 用户与恢复契约](../workflow.md)
- [delivery-first 优化目标](../delivery-first-optimization-round.md)
- [read dedupe 与 stable-prefix 实验边界](../delivery-read-cache-experiments.md)
- [P2 默认值调整前置条件](../p2-optimization-blocked-until.md)
- [session-history 补充目标](../session-history-optimization-supplement.md)
- [上下文策略实验](../context-strategy-experiment.md)
- [phase-handoff 实验](../phase-handoff-experiment.md)

审计时已有三个未跟踪文件，属于用户已有工作，不是本方案的实现产物，不得删除、覆盖或自动纳入本方案：

- `docs/superpowers/specs/2026-09-13-intelligent-routing-harness-design.md`
- `scripts/session-stats/subagent-thrash.py`
- `scripts/session-stats/test_subagent_thrash.py`

### 1.3 证据边界与已排除误判

此前仅做静态源码审计，未运行测试、生产工作流或付费模型实验。下面源码位置是导航线索，行号会漂移；实现前读取当前符号及调用点。没有实测的时间、token、费用收益均为待验证假设。

不得将以下已排除结论重新写入实现说明：

1. `stats:subagents` 不是死入口。`scripts/session-stats/subagent-report.ts` 实际导入并运行报告代码。
2. 配置的验证命令会加入引擎 Verifier 白名单，不能声称 `bun run lint` 只因不在默认列表就必然被拒绝。
3. 显式 goal complete 路径将 evaluator 的非 blocked 结果映射为 candidate_complete；不能声称 evaluator 返回 continue 必然阻塞用户确认。
4. 子代理 yield ladder 最多三次提醒只在特定未完成路径触发，不是每次 workflow 阶段的固定三倍调用。task 内层没有另一套完整 schema-repair 循环。
5. 默认关闭的实验主要产生维护复杂度，不能直接计为默认 token 成本。
6. `HEAD:dirty` 是身份粒度缺陷；静态审计没有证明实际发生了错误验收事件。

### 1.4 生产默认与实验状态

| 能力 | 审计基线状态 | 本轮处理 |
| --- | --- | --- |
| `latency.arms.readDedupe` | 默认 true；仍受 model optimization、视图身份等条件约束 | 优化真实 eligible 路径，不宣称所有 read 都去重 |
| model optimization 的 output truncation 子开关 | 默认 true；受外层策略与子代理覆盖约束 | 保持行为，合并等价规则 |
| `deliveryExperiment.readDedupe.enabled` | 默认 false；与普通 read dedupe 开关不同 | 保持关闭，不另建缓存 |
| stable-prefix cache 实验 | 默认关闭 | 仅处理维护重复，不宣称默认请求已经获益 |
| context-strategy / compaction 实验 | 默认关闭 | 保持关闭，已存在的普通压缩能力不等于该实验 |
| phase-handoff 实验 | 默认关闭 | 保持关闭；观察脚手架不计为默认 token 成本 |

默认开关来源以当前配置注册为准；新会话必须复核组合条件，不能只看到某个子开关 true 就判定整条功能默认生效。

## 2. 范围、非目标与不变量

### 2.1 实施范围

本文件的 R1–R8 均需处理并给出验收证据。R8 是入口边界和默认值保持，不授权把现有 `/delivery` 改成跳过评审的快速模式。首批必须先完成 R1/R2/R3/R4，不能因为这些收益较大就遗漏后续收敛项。

主要涉及：

- `packages/coding-agent/src/workflow/`
- 直接相关的 `task/`、`session/`、`goals/`、`model-policy/`、`model-optimization/`、配置与 artifact 管理路径
- 必要的 catalog KDL 策略归属调整
- 已有相关测试、用户文档和 `scripts/session-stats/` 离线报告

### 2.2 非目标

- 不重写 AgentLoop，不建立第二个任务调度器、缓存、事件平台或数据库。
- 不扩展到上游全部包的重构，不把 Git 新增行数当清理配额。
- 不提高生产并发，不全局降低模型/effort，不新增任务复杂度分类代理。
- 不开启默认关闭的实验、shadow review 或额外付费评审。
- 不削弱验证、模型身份、工具权限、写入范围和敏感数据保护来换取通过率。
- 不把一次 verifier 成功等同于“用户已接受”或“以后不会返修”。
- 不发布、部署、安装本地二进制、提交或推送 Git；这些需要独立授权。
- 未获明确请求，不修改 CHANGELOG。

### 2.3 必须保留的不变量

1. 模型返回产物，宿主决定状态迁移；模型自评不是验收事实。
2. 严格实现/修复路径仍先隔离捕获，`apply:false` 后由引擎验证身份、patch 和范围，再合并。
3. `prepared → applied` 的持久化与恢复证明不弱化。写入阶段异常不能静默从头再跑。
4. 同一 workflow 只有一个有效 runner owner；取消等待在途合并结果归档后再写终态。
5. 配置选择、本地解析、服务端身份分开记录；恢复保持冻结的路由快照，不能偷偷换模型。
6. 阻断 findings、implementation unresolved、范围违规、缺少可信验证均不能成为 completed。
7. read 优化失败回原文，验证身份未知时不复用旧通过结果。
8. 子代理退出成功、产出 patch、完成局部检查、父代理接受交付是不同事件。
9. 原始内容可恢复且完整性可证明；不能用 mtime/长度代替内容完整性证明。
10. 默认关闭的实验保持关闭；普通任务不因本次重构被强制进入完整 workflow。

## 3. 当前架构与目标架构

### 3.1 当前问题

普通会话、Goal、Workflow 都复用 Task/AgentSession，但各自增加了完成判定、上下文策略和观察记录。Workflow 又在引擎中同时管理路由、评审、合并恢复、费用、历史产物和实验输出。

问题不是层次多本身，而是相同事实有多个解释者、可变状态有多个归属。文件拆小但仍共享全部状态，不会降低复杂度。

### 3.2 目标归属

| 事实或决定 | 唯一归属 | 调用者不应再做什么 |
| --- | --- | --- |
| 当前代码身份 | 现有工作树/verification 内容身份能力 | 自造 `HEAD:dirty` 验收键 |
| 验证记录与有效性 | 收敛后的现有 verification-validity 能力 | 由命令文本或模型文字合成通过证明 |
| 任务累计费用与调用预算 | 共享任务预算账本 | 每层从零计算独立重试预算 |
| 原文保存与恢复 | 现有 ArtifactManager/存储能力 | 重复扫描编号、保存后由多个调用者重复回读 |
| 阶段迁移 | WorkflowEngine 的单一状态迁移入口 | stage、overlay、观察层各自宣布 completed |
| 写入提交与恢复 | 现有合并 seam 收敛后的实现 | 模型重试顺便再次应用 patch |
| 模型固有事实 | catalog/KDL | 多个 TS 模块各自按模型名字推断 |
| 用户角色选择与业务偏好 | workflow 配置及冻结快照 | 把角色偏好伪装成模型固有事实 |
| 实验统计 | 现有观察/离线报告路径 | 再维护一套决定生产状态的镜像状态机 |

仅在至少两个真实调用者需要共享行为时提取公共 module。Interface 应少量、明确，隐藏恢复/失效等复杂实现；不创建只有转发作用的抽象。

## 4. 源码依据与问题清单

路径前缀默认为 `packages/coding-agent/src/`；行号来自审计基线。

| 编号 | 源码依据 | 已确认事实 | 影响 |
| --- | --- | --- | --- |
| E1 | `task/workspace-code-version.ts:11–48`；`task/child-delivery-evidence.ts:558–569` | 不同脏树可能共享 HEAD:dirty，父消费比较该字符串 | 不能充分判定证据新鲜度 |
| E2 | `goals/host-gate.ts:54–71` | bash/eval 文本正则加非 error 被当作验证存在 | 不绑定被验证的代码和最后写入 |
| E3 | `model-policy/completion.ts:447–475`；`workflow/engine.ts:2293–2337`；`workflow/verification-validity.ts:649–660` | 空成功 checks 被补成通过证据，随后引擎按另一套规则拒绝 | 结论不一致，维护容易漏改 |
| E4 | `task/structured-subagent.ts:909–924`；`task/child-delivery-evidence.ts:501–511` | 自动包没有 terminalChecksPassed 且 claimedProven=false | 自动包成功验收路径未接通 |
| E5 | `workflow/budget-ledger.ts:87–121`；`workflow/engine.ts:3542–3637` | usage 缺失不改变已知状态；出现未知后不再累计后续已知费用 | 成本覆盖与预算约束不可靠 |
| E6 | `workflow/runtime-adapter.ts:176–358`；`workflow/engine.ts:3991–4038` | schema retry、profile fallback、gate retry 分层；gate 捕获范围过宽 | 错误归因与重试上限难以理解 |
| E7 | `workflow/context-builder.ts:85–103,193–195`；`workflow/engine.ts:2637–2646,3293–3305` | truncatePlan 原样返回；完整 plan、部分重复字段和 handoff 一起内联 | 交接提取未等于请求压缩 |
| E8 | `workflow/stage-handoff.ts:117–132` | bytesAfterHandoff 只统计摘要字段 | 不能代表最终请求 token 收益 |
| E9 | `workflow/runtime-invocation.ts:459–484` | 连续重复的只读/写策略包装块 | 无谓分配与维护重复 |
| E10 | `task/index.ts:1791–1841`；`task/workpool.ts:611–659` | 重复的结束观察与父消费流程 | 双入口漂移风险 |
| E11 | `workflow/engine.ts:437–470,947–961,4369–4377,4573–4581` | 大量内存状态、手工恢复、全 artifact 加载、重复保存累计路由审计 | 状态耦合与恢复/存储成本 |
| E12 | `session/agent-session.ts:5180–5186,5269–5305` | eligible read 首次可能落盘并回读，命中再次回读校验 | 优化本身有 I/O 与哈希成本 |
| E13 | `model-optimization/default-profiles.ts`；`workflow/default-config.ts` | 模型家族策略和截断构造重复 | 普通会话与 workflow 策略漂移 |
| E14 | `workflow/transitions.ts:3–15` | 进入 workflow 后阶段链固定 | 小任务不能自然享受直接执行成本 |

性能影响尚未测量。E14 是入口产品边界建议，不是授权修改已有 workflow 阶段契约。

## 5. 分步实施方案

### R1：统一代码身份、验证有效性与最终判定（P0）

**目标：** 先证明“验证的是当前代码”，再允许复用；统一事实规则，保留各入口交互。

**实现：**

1. 追踪 `resolveCurrentWorkspaceCodeVersion`、`resolveParentFinalCodeStateRef` 的所有调用者及持久化消费者。复用现有 `verification-validity.ts` 和工作树 receipt 能力，内容身份覆盖 HEAD、暂存、未暂存和相关未跟踪内容、删除/重命名与执行工作区。
2. 不能用字符串版本简单替换为另一种不透明字符串而不迁移消费者。共享当前已有的代码状态契约，验证侧重算关键字段；身份捕获失败返回 unknown，而非假装 clean HEAD。
3. 验证执行记录携带代码身份、命令、执行目录/范围、执行者、实际结果、验收要求引用。只有宿主观察到的执行事实可生成可信记录；worker 文字、路径形似日志、退出码成功不能自行签发验收。
4. 在验证前后捕获必要状态，检查期间有外部修改时不得为旧检查签发新代码的通过记录。不要对每条工具事件都全仓哈希；按验证/消费边界采集并测量成本。
5. Goal 使用可信记录判断是否覆盖当前变更；命令正则只可辅助识别候选，不可作为通过事实。eval 里仅出现 `bun test` 字符串不算执行。保留未配对工具、开放 TODO 和用户 `/goal complete` 确认语义。
6. 收敛 workflow 的最终判定：阶段产出验证事实，单一纯判定组合 implementation、blocking findings、scope、ownership、code identity、checks。Stage 和 engine 不再有相互矛盾的成功定义。
7. 删除“空 checks 自动补 passed”。无命令且无其他有效检查是 missing evidence / invalid configuration，不是 passed；不要未经授权把显式空配置静默替换为默认。
8. 只有接受者有权签发最终接受记录；普通子代理检查可供覆盖分析，但不能直接冒充 parent-final。

**迁移：** 旧 HEAD:dirty、缺代码身份或无法证明执行者的记录仍可显示，但不可作为可复用验收；旧 workflow 不因迁移静默变 completed。优先兼容读取一次并转入规范表示，不在新热路径长期保留两套判定。涉及已发布持久化字段先查兼容政策。

**验收：**

- A1：同一 HEAD 下编辑 A→验证通过→再次编辑 B，旧记录在普通会话、父消费和 workflow 复用中均失效。
- A2：暂存/未暂存/未跟踪/删除、执行目录或范围改变分别触发必要失效；内容未变时允许复用。
- A3：验证过程中发生修改不能得到有效绿记录；无法读取 VCS/内容时不伪造新鲜度。
- A4：只有命令文本、模型自评、空 checks、全 skipped、worker-only 标记都不能通过最终门禁。
- A5：同一输入只得到一个最终结论；scope violation、开放阻断 finding、implementation unresolved 任一存在都拒绝 completed。
- A6：Goal 的显式用户确认与候选完成语义保持；不因缺少某个命令关键字要求重复跑已经有效的检查。

### R2：接通子交付证据并合并父消费路径（P1，依赖 R1）

**目标：** 有证据的交付能被使用，无证据的交付诚实标记，而不是统一返回重读/回 worker。

**实现：**

1. 确认终检事实生产 seam；优先连接 R1 的实际执行记录，不另建执行器。
2. 自动生成的交付包引用真实 patch、变更路径、验证记录和验收要求。没有终检记录就返回 unverified / checks not run；不得补 `proven:true`。
3. 明确 slice-local、parent-integrate、final-repo 责任：父代理只补缺失或失效的检查。parent-owns-verify 的 checklist 不是 worker 失败，不应反复要求 worker 做父代理负责的终检。
4. 父消费必须重验当前代码状态、范围和写入所有权；`terminalChecksPassed` 不能成为来自任意模型 JSON 的可信后门。
5. task/index 与 workpool 的结束观察和消费流程共用一个已有领域函数；入口仅传标识、上下文和 sink。保留稳定事件 ID、幂等、隔离产物保留与失败日志。
6. 对没有可消费验证记录的包，避免构造冗余证明和重复 VCS 探测；保留模型继续工作真正需要的产物引用与未完成项。

**验收：**

- B1：宿主真实检查通过且版本匹配的交付走到预期消费分支；不依赖测试直接伪造内部 `proven` 字段。
- B2：伪造证明、陈旧代码、越界修改、未释放的共享写入均不能直接整合。
- B3：parent-owns-verify 的子交付只执行父侧必要检查，不陷入回 worker 循环。
- B4：task 与 workpool 对同一语义输入返回同一分类；重复结算不重复写接受事件。
- B5：子进程成功但业务未验证时，输出明确未验证，不显示为用户已接受。

### R3：预算记账与分层重试收敛（P0，可与 R1 独立推进）

**目标：** 未知费用不等于零，也不能让已知费用停止累计；所有重试服从任务级边界。

**实现：**

1. 在现有 BudgetLedger 扩展最少必要字段：已知费用下界、费用覆盖/未知次数、明确区分的阶段调用与 provider 请求数。profile 的累计独立更新，不能受其他 profile 费用未知影响。
2. 保持总费用语义诚实：存在未知部分时 total 仍为 unknown/null，同时显示 known lower bound。已知下界达到限额必须停止下一次外部调用。
3. `usage` 缺失的真实外部调用计入未知覆盖；本地预校验失败不得伪装成已发生的付费请求。错误结果尽量携带已观察到的 usage，结束失败也计账。
4. 追踪实际 provider 请求的既有统计 seam，不能把一次多轮子代理执行错计为一个 provider 请求。引入 attempt/request 幂等键避免成功、异常和恢复路径重复收费。
5. 共享任务剩余预算进入 profile fallback、schema retry、gate retry及子代理的相关调用路径。使用既有模型响应/调用 hooks，不新建通用调度器。
6. gate retry 仅捕获可恢复的解析错误；取消、预算耗尽、身份冲突、权限/配置问题保留原始类别，不再次启动整条 gate。既有允许的 provider fallback 仍由唯一层负责。
7. schema 修复优先修复输出封装；如写入已经发生，必须复用捕获产物或明确阻断，不能为修复 JSON 再做一次不受控实现/合并。
8. 不偷偷改变旧 `maxRequests` 的公开含义。若现有字段混淆阶段与 provider 调用，先明确兼容映射或引入清楚的新字段，文档解释计数单位。未配置的全局时限/请求上限不自行加入拍脑袋默认值；已有明确限制必须跨层生效。

**迁移：** 旧账本 `costKnown=false` 不可恢复成已知零；不能从未知总额反推出精确费用。存在可证明 usage 时可重建下界；否则记录 coverage gap。resume 不能重置已消耗预算。

**验收：**

- C1：费用依次为已知 1、未知、已知 2，已知下界为 3，总额仍未知；profile 之间互不污染。
- C2：缺 usage、schema 失败、provider 失败但有 usage、取消后的部分 usage 分别正确归属，且不会重复计数。
- C3：共享剩余预算不足时内外层均不再调用；恢复后仍保持这一结果。
- C4：解析错误可以有界重试；身份/预算/权限错误不被转成 gate_parse_failed，也不重新跑一整条 gate。
- C5：写产物已捕获后的结构化输出失败不重复应用 patch；不把模型重试作为恢复写入的替代。
- C6：tool-free final 正常结束不产生额外 yield 提醒；实际触发提醒/异步收尾时仍受共享限制，不丢未交付结果。

### R4：消除完整计划与交接摘要的重复（P1）

**目标：** 在最终请求中每类必要事实只出现一次，完整原文仍可恢复。

**实现：**

1. 使用已有 ContextBuilder、stage handoff 和 artifact inclusion，不增加新的上下文平台。
2. 小计划保留完整计划表示，删除额外重复的 acceptance/verification 展开与同义 handoff；大计划使用角色需要的确定性字段投影和原文引用。
3. 先按现有配置预算决定表示；没有可靠阈值证据时不引入按模型名字猜测的阈值。
4. 硬约束、验收标准、阻断 findings、当前未完成项必须完整传达。不能将固定 500 字符截断作为这些字段唯一来源；过大时分片/可恢复引用并明确未内联部分。
5. 区分持久化审计对象和模型可见对象：schema 元数据、哈希、重复来源列表等只有模型实际需要时才进入提示。
6. 使用现有静态 prompt 文件与模板机制；不要在 TS 中新增模型指令字符串。避免为去重做一次新的 LLM 总结。
7. 测量最终 assembly 或 provider 请求边界；`bytesAfterHandoff` 若保留，明确是提取字段字节数，不代表整条请求 token。

**验收：**

- D1：小计划、大计划、修复轮次的最终请求不再同时含完整计划和同义交接副本。
- D2：所有验收项/阻断项都保留语义且可定位；长约束超过旧摘要上限仍不丢失。
- D3：原文引用通过实际 artifact resolver 可读取并校验；持久化失败安全回退原始上下文。
- D4：使用冻结 fixture 对比最终请求字节和现有 tokenizer 的估计 token；只报告实际结果，不把对象内部缩减比例当 wire 节省。
- D5：工具限制、严格模型身份、稳定前缀语义和输出 schema 没有被去重削弱。

### R5：减少 read 去重的重复工作（P1，复用 R1/R4 的身份与 artifact 经验）

**目标：** 保留重复输入减少能力，降低优化本身的本地开销，不新增缓存层。

**实现：**

1. 先明确 originalText、visibleText、持久化内容的字节关系；只有摘要覆盖完全相同字节时才能复用上游哈希。
2. 在既有 ArtifactManager 的保存/验证 Interface 中返回可复用的内容身份，不由每个调用者重复扫描编号、写入后回读。
3. 优先复用已有原文 artifact。确有需要保存才能保证恢复时仍保存；不能以“延迟保存”名义让原文丢失或保留无界内存。
4. 命中完整性检查集中归属：明确 artifact 不可变性契约；如果存储不能证明未被外部改写，保留必要的重新校验。不要直接降级为只检查长度/mtime。
5. 实验选择配置按设置版本缓存或在 disabled 时早退，不新增一套 ReadViewKey/命中表。
6. 已有重复读取提醒如需合并，先核对触发范围：本地/远端、子代理/父会话、不同 selector 不能误判。只删等价重复路径，不以统一阈值改变未测量行为。

**验收：**

- E1：同源同版本同视图可去重；不同 selector、provider view、内容、分支/工作树不得错用引用。
- E2：artifact 删除、损坏、保存失败、压缩后重建均保持安全回退或失效，不产生悬空证明。
- E3：首次不重复 read、连续重复 read、长文件、恢复读取分别测量哈希次数、保存/读取次数、壁钟与最终输入大小。
- E4：在可复用同字节摘要的路径实际减少一次或多次冗余处理；未消除的检查说明保留原因，不为达到次数指标删除安全校验。
- E5：实验默认关闭行为不变；普通去重和截断开关仍按现有条件生效。

### R6：收敛策略来源与明确重复代码（P1）

**实现：**

1. 删除 runtime-invocation 连续重复的 readonly/write 包装；保留工具 getter/private-field receiver 语义。
2. 合并相同的截断规则构造、默认验证命令与常见内容身份实现；先复用已有中央工具，避免新增万能 helpers 文件。
3. 模型固有身份/兼容事实与模型条件策略按仓库约定进入 catalog/KDL；普通会话与 workflow 消费相同的解析事实。
4. 用户角色映射、质量档位、fallback 顺序仍由业务配置和冻结快照决定，不借迁移擅自修改模型选择。
5. 普通/Workflow 策略确实不同的字段保留显式覆盖；删除的是相同规则的重复解释，不强求所有策略数值相同。
6. 旧调用入口全部迁移，废弃内部别名与过渡 re-export 不永久保留；公开配置和持久化格式按仓库兼容政策处理。
7. KDL 修改须通过现有生成入口更新 rules.json，不能手改生成文件。

**验收：**

- F1：普通会话与 workflow 的共有策略来自同一来源；用户覆盖优先级不变。
- F2：配置选择和实际工具 allowlist、只读限制、禁用工具行为保持；未知模型安全退回中性策略。
- F3：冻结 quality route 恢复后不因当前默认值改变而换模型/effort。
- F4：受影响入口通过相关行为检查和 `bun check`；没有以源文本包含某 import/函数名替代行为验证。

### R7：引擎状态、持久化与观察层收敛（P1，依赖前述契约稳定）

**实现：**

1. 将当前状态归成一份明确的运行快照，区分可从存储恢复的权威字段与可丢弃缓存。resume 不再靠分散字段逐个 reset 来保证隔离。
2. 按真实职责分离阶段执行、最终决定、写入提交与持久化。优先利用已有 stages/RuntimePort/VerifierPort/WorkflowStore，不再增加平行 coordinator 或 service locator。
3. legacy 与 DevFlow 的差异用明确策略输入驱动同一迁移入口；保留各自已发布语义，不为统一强行删除 grill/仲裁/冻结路由。
4. 路由审计改为增量记录；恢复读取当前必要 artifact 索引，历史观察数据按需读取。原始大内容仍由现有 artifact store 保存。
5. 快照和状态迁移在现有 SQLite 事务/版本比较纪律下完成。外部文件保存先完成并可验证，再持久化引用；恢复处理孤儿文件和缺失产物，不制造“记录已通过、文件不存在”。
6. 只移动确无生产决定职责的观察计算到离线路径。默认关闭的 phase-handoff/context-strategy/stable-prefix 实验保持关闭。
7. 不把历史报告能力误删为死代码。清理没有消费者的收据前使用 LSP/实际数据流证明，再选择删除或接入一个真实消费点；不能靠新增若干测试假装接通产品。
8. 现有文件内容格式升级采用版本化读取/迁移；旧活动 workflow、失败/取消终态、prepared/applied 恢复必须有兼容策略。禁止清库重来。

**验收：**

- G1：同一引擎对象/不同引擎对象恢复均无上一任务的 requirements、profile、artifact ref 或预算泄漏。
- G2：状态迁移前后崩溃、artifact 写入前后崩溃、合并前后崩溃可恢复或明确阻断，不重复写入。
- G3：双 runner、cancel 与 merge 竞争、forceUnlock 的既有安全纪律保持。
- G4：新的路由记录不重复写全量历史；恢复不必加载与当前决定无关的全部观察产物。
- G5：旧格式 fixture 可读取或有清楚的不可复用原因；不能把未知/损坏记录升级成成功。
- G6：用实际接口运行恢复 smoke，而不只测试 stage 状态字符串。

### R8：保持轻重任务入口边界，补全离线验证说明（P2）

**目标：** 防止此次重构反而扩大流程；为后续成本比较提供可用证据。

**实现：**

1. 明确普通任务继续直接使用现有会话/工具，显式 `/delivery` 或 workflow 调用保持完整流程；不增加自动复杂度模型、不跳过已有强制评审。
2. 让两类入口共享 R1/R3 的事实模型，但不将普通会话包装成另一个 workflow。
3. 扩展现有 `stats:subagents` 需要的兼容解析，保留历史 JSONL 可读与 unknown 覆盖率。
4. 区分已验证、父代理已接受、用户已接受、之后返修/漏检。不能在 final_verify 通过时自动宣称 falseAccept=false；后验质量需要独立事实。
5. 若某质量指标无可信生产者，报告 unknown 和覆盖缺口，不造数据，也不以此推断整条统计链无用。
6. 编写直接执行与完整 workflow 的离线/受控比较说明；生产模式切换、模型/effort/并发默认值修改和付费配对实验均为单独授权项，不是本轮完成条件。

**验收：**

- H1：普通任务不会自动多出 planning/review 模型调用；显式 workflow 的阶段与恢复契约不变。
- H2：已有离线 CLI 能处理新旧记录，任务数、接受事件、缺失费用不重计、不零填。
- H3：报告清楚区分工程行为验证完成与实时质量/费用收益未验证。
- H4：默认开关矩阵和运行文档与实现一致，不把未启用实验写成已优化生产。

## 6. 执行顺序与协作约束

| 阶段 | 工作 | 退出条件 |
| --- | --- | --- |
| 0 | 固定当前基线；读取相关规则、当前符号和已有测试；确认共享记录格式 | 路径与调用者明确，不全仓重审 |
| 1 | R1 + R3 | 验收身份与预算核心回归通过 |
| 2 | R2 + R4 | 可用交付包与无重复上下文闭环通过 |
| 3 | R5 + R6 | read 成本优化与策略去重通过，默认值不变 |
| 4 | R7 | 持久化、取消、合并恢复 smoke 通过 |
| 5 | R8；整体验证；更新受影响说明 | 本文件验收矩阵有完整结果 |

实现时可以因真实依赖调整阶段内顺序，但不可悄悄删除工作项。没有用户要求时不为形式化并行强行拆 agent；有足够独立工作才分派。共同编辑 engine.ts、AgentSession 或记录 schema 时必须有单一集成负责人。

主代理先确定共享契约再分派；子任务不得各自修改同一契约、另加缓存或自行运行全仓检查。每批稳定后统一验证，不把构建/测试放在并行编辑过程中反复执行。

## 7. 验证策略与完成标准

### 7.1 开始实现前

- 使用当前 repo instructions；TS/Bun、coding-agent、测试、catalog/KDL、prompt 规则按目标路径加载。
- 用 LSP 查改动导出符号的引用；测试路径先 glob，不猜测文件名。
- 用户已有改动保留；若同一区域变化，重新读取并适配，不 reset/clean。
- 不依据本文件行号盲改；如果某问题已被其他改动修复，以当前行为证据关闭该项，不重复实现。

### 7.2 必须验证的行为

| 场景 | 核心断言 | 类型 |
| --- | --- | --- |
| 代码变化与检查复用 | 旧验证不得覆盖新脏状态；未变化可复用 | 回归测试 + 临时仓库 smoke |
| 子交付消费 | 真实终检可消费；伪造/缺证据不能接受 | 合同测试 + task/workpool 集成路径 |
| 费用未知与重试 | 已知下界持续累计；失败不丢账；跨层预算不重置 | 确定性测试 + 实际适配器调用路径 |
| 输出格式失败且已有 patch | 不重复执行/应用写操作 | 临时仓库故障注入 smoke |
| 最终 prompt | 无重复，必须约束与恢复引用完整 | 实际 assembly 输出对比 |
| read 去重 | 身份隔离、损坏回退、完整性保持 | 实际 read/artifact 路径 smoke |
| 恢复与取消 | 单 runner、prepared/applied、终态、取消竞争安全 | 存储重开 + 故障注入 |
| 新旧离线记录 | 接受/费用不重计，unknown 保留 | 既有报告入口离线运行 |

永久测试只保护真实行为、状态转换、边界和回归。禁止 source-grep、常量复读、mock echo、只检查“不抛异常”或非空；不用 `mock.module()` 污染全局。可注入受控 runner 证明宿主协议，但不得声称其证明真实模型质量。

### 7.3 命令与运行限制

- 类型检查使用项目规定的 `bun check`，不使用 `tsc`。
- 相关现有测试稳定后执行一次；测试命令、preload 和隔离方式从当前 package scripts/测试规则获取，不凭记忆拼路径。
- 如改 KDL，运行 `bun run gen:compat` 并验证生成结果；只在确实需要时运行 models 生成。
- 报告入口可先用 `bun scripts/session-stats/subagent-report.ts --help` 确认当前参数，再对受控 fixture 运行。不得扫描或外传私有会话内容来凑 benchmark。
- 非平凡源码改动必须有实际 changed-path smoke。无需付费模型即可先验证 deterministic verifier、存储恢复、read、assembly、真实适配器加受控 provider；明确不覆盖真实模型质量。
- 实时模型调用、付费配对实验、安装和部署都需要独立授权。授权缺失不阻塞无网络工程验证，但阻止声称生产性能胜出。

### 7.4 度量方法

复用已有统计脚本与临时 smoke 输出，不建立永久 benchmark 平台。固定任务 fixture、代码快照、配置、模型/effort（若获授权）与检查命令；每次只改变一个主要因素。

记录：

- 正确交付/验收通过率及定义；
- 失败与重试费用、已知费用下界和未知覆盖率；
- 任务端到端 wall time，以及父集成/等待/验证分项；
- 实际 provider 请求数与输入、输出、cache tokens；
- 重复检查、read 命中和恢复读取次数；
- 最终请求字节/估计 token 与 provider 实报 token 的区别；
- artifact 保存/读取和内容哈希次数。

不把并行时长相加当 e2e，不把 cache 命中推断为服务器实际计费，不把 handoff 对象尺寸当 wire 大小。不设置未经测量的“必须快 30%”验收线。工程验收要求安全合同不退化并删除可证明的冗余；真实质量不下降与经济收益需要独立配对证据。

### 7.5 最终交付必须包含

1. R1–R8 与 A1–H4 的结果矩阵：通过 / 不适用并说明 / 阻塞；每项引用测试、smoke 或源码契约证据。
2. 实际修改文件、公共契约变更、删除的重复路径和旧数据兼容方式。
3. 执行过的命令和结果、失败前后比较；未运行项明确列出。
4. 默认值保持情况、恢复风险和可回退方式。
5. 性能测量表；没有真实配对数据就明确“工程优化已验证，实时质量/费用收益未验证”。
6. 更新 `docs/workflow.md` 等真正受影响文档；无明确请求不改 changelog，不提交 Git。

不能仅以编译通过、所有 mock 通过、产出统计收据或第一批完成宣称整个方案完成。

## 8. 主要风险与回退原则

| 风险 | 应对 |
| --- | --- |
| 共享代码身份造成全仓哈希热路径 | 仅在验证/消费边界采集；复用现有内容身份；测量额外成本，不能弱化证明 |
| 统一门禁漏掉旧检查 | 先列现有安全不变量；新判定覆盖全部，而非仅调用 isValidDeliveryEvidence |
| 费用字段迁移把 unknown 变 0 | 保留 unknown 和覆盖缺口；旧账本不能推断的部分不补数 |
| 修 JSON 时再次修改工作树 | 捕获产物与输出封装分离；写入事务状态不随解析重试重置 |
| handoff 去重误删硬约束 | 使用字段级投影；硬约束完整；长输入与恢复路径验收 |
| 文件与 SQLite 引用不同步 | 先保存可校验内容后记录引用；恢复可识别缺失与孤儿；不通过删库解决 |
| 重构引擎扩大变更面 | 先稳定合同再逐职责迁移；单一状态归属；不新增平行引擎 |
| 默认关闭实验被误当热路径而删除 | 开关矩阵与调用证据先行；保留既有离线入口 |

回退使用本次改动的精确逆向变更或既有 feature gate；不得 reset 用户工作。持久化变更必须说明旧程序能否读取，必要时先保存受控测试数据库副本验证迁移；不得直接操作用户真实会话数据库。

## 9. 新会话短 prompt

```text
请按 docs/design/workflow-consolidation-implementation-plan.md 完整实现并验证 R1–R8。先核对当前 HEAD、用户已有改动及文档中的源码依据；遵守仓库规则，复用现有模块，先统一验收证据和预算，再处理交付包、重复上下文、read 成本、策略与引擎收敛。逐项完成验收矩阵和实际 changed-path smoke，不只给方案或完成第一批就停止。不改模型/effort/并发默认值，不开启实验，不做付费模型调用、安装部署或 Git 提交。保留旧数据恢复与安全检查；更新受影响文档。最终列出改动、实际验证、验收结果、测量与未验证风险；没有实时配对证据不得宣称生产质量或成本收益。
```
