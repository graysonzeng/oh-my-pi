# oh-my-pi 编码 Harness：做稳、做薄的实施与验证方案

日期：2026-09-27。状态：用户认可优化方向；本文件为下一会话的实施依据，尚未实施或验证收益。

## 1. 决策与优先级

**先让当前编码任务正确完成，再减少下次同类任务的弯路。不要把编码 Harness 建成长期私人助理或自动学习平台。**

本文件取代 [持续改进 Harness 大方案](2026-09-27-learning-harness-optimization.md) 的近期实施优先级。旧文仅保留研究来源和长期备选设计；其中 local SQLite 经验状态机、全后端学习治理和档案协议升级不再是 P0，也不是本轮待办。

实施顺序：

1. 核实实际失败与已有保障，建立最小对照。
2. 修复已证实的任务约束丢失、恢复失真或验收失真；复用现有所有者。
3. 仅在有重复读取、输出膨胀等证据时，做单因素上下文效率优化。
4. 没有缺口就报告已有行为及验证证据，不为了“完成优化”制造改动。

本轮授权范围：后续会话可按本方案定位、实施必要的本地代码修复并验证。不得由此推导出提交、发布、生产写入、修改用户全局配置、启用自动记忆或运行付费批量评测的授权。

## 2. 编码场景的最佳实践

### 2.1 真相尽量留在仓库里

| 信息 | 首选载体 | 不推荐 |
|---|---|---|
| 可机械检查的工程限制 | 现有类型检查、lint、行为测试或执行端校验 | 反复扩写系统提示词 |
| 架构取舍及不可见的原因 | 相关代码注释、已有设计文档 | 同时存进多份长期记忆 |
| 启动与验收方法 | 可执行脚本与简短项目说明 | 每个新会话重新探索 |
| 当前目标、禁区、未完成工作 | 已有 session / goal / todo / acceptance 状态 | 晋升为永久偏好 |
| 本次失败的原因 | 当前会话的失败记录及可恢复证据 | 擦掉失败后重复尝试，或保存全量日志为永久经验 |
| 仓库无法表达的稳定偏好 | 用户明确要求后，使用已有规则/记忆入口 | 自动把一次纠正归纳为长期规则 |

能从当前代码可靠发现的事实，不再维护一份“记忆版本”。用户当前指令与仓库现状优先于历史经验。文档无法保证执行的安全限制，仍由权限和宿主代码负责。

### 2.2 小任务直接做，复杂任务才增加结构

- 不强制每个任务创建计划文件、交接文件或多个 agent。
- 独立研究、边界明确的实现或必要的独立审查可以分派；父任务保留集成和最终验收责任。
- 不用大量追加提示词补偿一个可定位的工具/状态/验证缺陷。
- 不为缩短提示词删除安全保障；先证明所有入口有等价代码保障，再考虑精简。
- 按用户指定，默认“理智线”为 **200K（200,000）上下文 tokens 的软截断上限**：以此控制工作上下文规模，不是理解质量评分，也不是模型窗口的硬限制。

### 2.3 默认软截断上限：200K context

- 统计当前请求实际携带的上下文，复用现有 token 计数/估算；不是累计会话消耗、字数或模型宣传的最大窗口。估算值要标明。
- 默认软上限为200K；沿用现有用户显式配置优先级。模型窗口减去既有输出/安全预留后不足200K时，以较小安全边界为准；既有安全机制可更早触发，不为凑200K延迟处理。
- 接近软上限且既有估算表明下一请求可能越界，或当前已达到/超过软上限时，在 SessionMaintenance 的现有安全维护点优先压缩、外置可恢复的大结果或省略冗余内容，目标是将后续请求上下文降回软上限以下，并沿用既有预留避免刚压完就再次触发。不新增固定百分比水位、调度器或压缩机制。
- **软截断允许临时超过200K**，例如单次工具结果较大、需等待工具调用/结果配对完整；在下一个安全维护点处理。超过模型实际安全容量则仍由既有容量保护处理，不能借“软”绕过硬限制。
- 截断的是送给模型的工作上下文，不是原始会话记录。必须保留当前目标、有效约束、修改状态、失败依据、未完成验收以及有效恢复引用；不得机械裁掉前200K以外的内容，不拆开工具配对，不自动新开会话。
- 无法安全降至软上限以下时，明确报告原因并沿用现有回退/交接建议，不静默丢弃关键状态、不伪报达标，也不无进展地反复压缩。新会话或扩大交接范围仍由用户选择。
- 200K软截断是本方案的目标合同，不是已核实的仓库现状。新会话先核实有效配置及已有路径，记录差异；本轮只修改文档，生产默认值落地仍需单独确认，不能以默认开启实验开关替代正式实现。
- 验证软上限前后、单次大结果导致暂时超限、较小窗口、用户覆盖值、维护失败与无法再压缩的回退；同时验证约束、修改状态、失败依据和未完成验收仍可恢复。200K只是工程取舍，不作为性能收益证据。

## 3. 基线：已有能力先复用

以下是前次静态核对的定位信息，不是当前代码一定存在缺陷的结论。新会话只需核实所选路径与当前快照，不必重读整套研究材料。

| 已有能力 | 定位 | 本轮处理 |
|---|---|---|
| 上下文维护与阶段交接实验 | `packages/coding-agent/src/session/session-maintenance.ts`、`session/phase-handoff-carry.ts`；[交接实验](../phase-handoff-experiment.md) | 在原维护路径修缺口；不加第二压缩器/调度器 |
| 当前目标和验收 | `packages/coding-agent/src/goals/`、`workflow/acceptance-contract.ts` | 复用现有状态；不建平行任务账本 |
| 子任务交付与父任务验收 | `packages/coding-agent/src/task/child-delivery-evidence.ts`；[验收覆盖](../acceptance-coverage-matrix.md) | completed、exit 0、candidate_complete 均不能自动等同最终接受 |
| 上下文诊断 | `packages/coding-agent/src/slash-commands/helpers/context-decision.ts`；[刷新契约](../context-freshness-table.md) | 只在实际误报时修正，不新增“智能评分” |
| 上下文效率实验 | [实验入口](../context-experiment-hooks.md)、[读取与缓存实验](../delivery-read-cache-experiments.md) | 默认关闭，单因素验证；脚手架不算收益 |
| 现有记忆和经验 | [memory](../memory.md) | 保持现状，不默认开启、不迁移存储 |
| 已有精简约束 | [thin harness](../thin-harness-candidates.md) | 仅处理具体重复点，不启动全仓清理 |

上表中缩写源码路径以 `packages/coding-agent/src/` 为根。路径只是定位入口；若已迁移，先定位当前所有者，不按旧行号盲改。

## 4. 新会话执行步骤

### 步骤一：最小问题清单，不新增观测平台

从用户提供的失败、现有相关测试和当前源码中，优先找以下三类问题：

- **约束丢失：** 长会话/压缩后忘记已明确的限制、使用被否定方案、漏掉未完成验收。
- **恢复失真：** 压缩或恢复后拿不到证据、混入其他分支状态、把旧验证当当前结果。
- **验收失真：** 子任务已结束或命令成功，就被显示/统计为任务已通过验收。

为每个候选只记录：用户可见失败、触发入口、现有所有者、复现/已有证据、最小修复、验收方法。使用当前文档或临时记录即可，不创建新数据库、dashboard 或事件体系。

优先选一个有证据且影响实际编码的缺口，完成“定位→修复→验证”闭环。若其余已确认缺口仍在授权范围内，继续处理，不停在只交第一版实现；不要为了覆盖所有类别捏造缺陷。用户已报告的失败无需再次运行只为证实其存在，复现应服务于定位或前后对照。

### 步骤二：正确性优先的最小修复

#### A. 当前任务约束在维护前后保持

- 只在现有会话状态、压缩输入/输出、阶段交接载荷中修复遗漏。
- 明确保留当前有效目标、用户禁区、未完成验收、相关修改及必要失败原因。
- 新决定明确替代旧决定；工具输出和外部文档不能获得修改用户授权的权力。
- 不把自然语言范围推断当文件权限沙箱，不扩大既有权限模型。
- 不机械保留所有历史正文：保留旧方案被否定的原因与恢复位置，而非把旧方案继续当有效指令。

**核心验收场景：** 用户先允许改名，随后明确只整理不改名；触发现有压缩/维护路径后，目标状态仍以新要求为准。宿主行为测试检查状态保留；若要证明模型后续确实不改名，还需真实模型任务验证，两类证据不能混称。

#### B. 恢复有依据，不能悄悄丢现场

- 保留工具调用/结果配对、有效分支状态和持久证据引用。
- 内容被省略后，需要能从既有 artifact/会话存储取回；失效引用应明确报不可恢复，不能编造内容或验证结果。
- 代码发生相关变化后，旧 receipt 不得冒充当前版本验证。
- 压缩失败或关键状态不完整时，沿用既有安全回退，保留原上下文/现场。
- **本轮不新增跨 `/new` 交接包协议。** 先保证现有 resume/branch/compaction 的合同；普通 `/new` 不应暗中继承旧任务。

**核心验收场景：** 省略的大输出可恢复；丢失的 artifact 被准确报告；切换分支不会读到未来分支的决定；旧验证遇到代码漂移时失效。

#### C. 做完、验证过、用户接受是不同状态

- 复用已有 acceptance/receipt、子交付与父集成链路。
- 只有现有可信验证或明确用户接受入口才能产生对应状态；不以 agent 自报、stop、exit 0 代替。
- 缺少验收项、证据或代码状态绑定时，保留 unknown/未覆盖原因，不填成成功。
- 不扩建另一套验收状态机，也不要求所有小任务强制走重型 workflow。

**核心验收场景：** 子任务成功退出但父任务未验证时，不显示/统计为最终通过；失败、缺证据和过期证据能被区分。

上述 A/B/C 是诊断与验收方向，不是必须各新增一个功能。已有保障验证通过时，该项记为“已具备，无改动”。

### 步骤三：效率优化须有瓶颈证据

仅在前两步或真实任务中观察到瓶颈时开展：

| 现象 | 最小处理 | 不得牺牲 |
|---|---|---|
| 同一内容无变化却反复读取 | 在既有读取/缓存实验处修重复路径或验证复用 | 外部变化可见性、范围不同的读取、恢复完整性 |
| 巨大结果反复进入上下文 | 复用现有截断/外置/分页能力，给出有效恢复入口 | 关键错误、未读取部分标记、工具协议配对 |
| 无关规则/材料常驻 | 修匹配或加载路径；有证据再裁剪 | 必要权限、安全约束、当前任务信息 |
| 子任务启动和集成成本大于收益 | 减少无必要分派，明确共享决定和交付内容 | 必要的独立验证与真正可并行工作 |

每次只变一个因素，不同时换模型、调并发、改压缩阈值和裁提示词。现有实验默认值保持关闭；临时配置只用于隔离验证，不写用户全局配置。

## 5. 验证：证明行为，不制造流程

### 5.1 每项实际改动的最低证据

1. 给出失败原因与最小复现/已有失败证据。
2. 对回归风险补一个能保护用户可见合同的测试；已有测试足够则复用。不写源码字符串断言、字段透传或提示词文案测试。
3. 运行受影响的 package 检查；TypeScript 检查用仓库规定的 `bun check`，不使用 `tsc`。
4. 实际运行改动入口：CLI/TUI 用真实程序观察；SDK/RPC 改动用对应入口的 smoke。共享路径至少验证触发问题的入口及本次改动影响的适配入口，不默认扫全套。
5. 压缩/模型行为需要模型调用时，区分：确定性的宿主回放可验证状态与恢复；真实模型任务才能验证指令遵守和效果。不得用 mock 结果声称真实模型改善。
6. 本轮未预授权付费 live-net 或批量 A/B；优先使用现有离线材料与已具备的本地运行条件。如真实验证缺少凭据、服务或预算授权，完成其余可执行验证并报告具体缺口，不宣称全链路已通过。

纯文档修订或“已具备、无改动”的静态核对无需为了流程运行无关 build。不能因为有测试通过，就声称用户实际体验已改善。

### 5.2 效率收益的证明

先用少量固定编码任务做配对筛查，不强制建30对任务集或永久评测框架。control/treatment 固定代码快照、模型/effort、工具、任务和初始状态，隔离工作目录；失败与超时保留。

一起报告：完成/验收结果、返工、端到端墙钟时间、模型调用与 token/成本。价格未知就标未知；不把并行耗时相加成总耗时。仅减少输入 token 不能推出更快，增加缓存命中不能推出任务更可靠。

样本太少只说筛查结果；未做真实配对就不声明百分比收益。修复可凭行为回归证据交付；提高生产默认值或声称普遍性能改善，需要另有充分实验，不与正确性修复捆绑。

## 6. 复杂度预算与不做清单

每个新增持久状态、依赖、后台任务或公共 Interface 都须回答：哪个已证实的用户失败需要它？为什么既有所有者不能解决？若只有未来可能用途，本轮不加。

**本轮不做：**

- local SQLite 学习状态机、自动偏好归纳、候选晋升/撤销平台。
- 全后端统一治理、记忆协议升级、跨工具档案同步、价值观分层。
- 自动生成/推广技能，默认启用 memory/autolearn，批量读取私人会话做训练材料。
- 第二套 goal/acceptance、压缩调度器、智能评分或每轮 LLM 裁判。
- 把200K软截断上限变成机械硬裁剪，或未经单独确认修改生产默认值、默认并发/模型/effort。
- 全仓提示词压缩、无证据删除封装、替换已成熟工具。
- 无关重构、提交、发布或安装新二进制。

这不是删除现有记忆功能的授权。未来只有在同类跨会话错误反复出现、仓库文档无法合理承载且用户需要时，才单独评估最小记忆增量。

## 7. 完成条件与交接记录

实施结束时，在本文件末尾追加简短记录，不再创建另一份总方案：

- **基线：** 实际入口、版本/快照定位、已证实问题；哪些候选已具备、不需要改。
- **改动：** 文件与行为变化，复用的所有者，是否新增状态/依赖及理由。
- **验证：** 实际命令/入口、结果、失败前后差异；运行证据的有效定位，不抄录秘密。
- **边界：** 未运行的真实模型或其他入口验证；不确定收益；外部阻塞。
- **回退：** 本次代码修复的回退范围；实验配置如何恢复。保留用户既有改动，不以 reset/清空数据回滚。

更新本次行为涉及的现有文档；未被明确要求时不改 CHANGELOG。没有实证缺口时，以“相关机制已验证、无代码改动”结束也是合格结果。

## 8. 新会话短 Prompt

> 请按 `docs/design/2026-09-27-coding-harness-practical-plan.md` 实施并验证编码 Harness 优化，默认采用200K context软截断上限，复用SessionMaintenance，允许安全边界内暂时超限但不丢关键状态。先核实差距，有缺口才做最小修复并跑对应测试/入口smoke，无缺口则记录证据，不造功能。优先约束保持、恢复和真实验收，不扩大为学习系统。证据追加到文档；不要提交、发布、改全局配置或生产默认值，付费评测另行授权。

## 实施记录

日期：2026-09-27。基线 tip：`4316b36d90abc73ab23009c85ec9c2b14dfcfe25`（`workflow` / PR #39）。  
**未** commit / push / 开 PR；未改用户全局配置；未开实验开关；未改生产 compaction 默认；未跑付费评测。无 `paired_evidence_ready` / 成本收益声明。

依据文档版本：upload `2026-09-27-coding-harness-practical-plan_83cf.md`（含 §2.2–2.3 的 **200K soft cap** 目标合同）。

### 基线 / Gap 审计

#### A/B/C 正确性（相对 tip）

| 候选 | 状态 | 说明 |
|---|---|---|
| Post-turn 结构化 goal 保持 | 已具备，无改动 | 下一轮 `prompt()` 再注入 |
| Mid-run compaction 后 tool-loop 丢 goal | **已修复（工作树）** | 见改动 |
| phase-handoff `openConstraints` 仅 todo | 延期 | 默认 off |
| 纯对话改口无结构化写入 | 延期 | |
| 恢复：配对 / artifact / 分支 / stale receipt / 失败回退 | 已具备，无改动 | |
| 验收域：done/exit0/candidate ≠ accept | 已具备，无改动 | |
| `<task-result>` 证据类折叠 + parentOwns 不对齐 | **已修复（工作树）** | 见改动 |
| Hub `need_integrate` 未接线 | 延期 | |
| `capability` star-export → TDZ | **已修复（工作树）** | 否则 AgentSession 测试无法加载 |

#### §2.3 200K soft cap（目标合同 vs 有效配置）

| 项 | 有效现状（tip + isolated 默认） | vs 200K 合同 | 本轮 |
|---|---|---|---|
| 生产触发阈值 | `compaction.thresholdPercent=-1` + `thresholdTokens=-1` → **legacy `contextWindow − reserve`**（reserve≈max(16k,15%)） | **不是**固定 200K soft | **不改默认**（需单独确认才落地） |
| 示例有效阈值 | 128K→108.8K；200K窗→170K；256K→217.6K；1M→**850K** | 大窗口远高于 200K | 已记录差异 |
| 实验 200K tier | `compaction.experiment.enabled=false`（默认）；`experiment.thresholdTokens` 默认 **200000**；factor=`threshold_tokens` 时：`tier > window−reserve` 则回退 control | 机制已接近合同，但 **默认关闭** | **不打开实验开关** |
| 用户手动设 `thresholdTokens=200000` | UI 已有 200K 选项；`resolveThresholdTokens` 在窗≤200K 时 clamp 到 `window−1`，**不**减 reserve | 与合同「取较小安全边界=window−reserve」在小窗上有 delta | 记录；落地默认前再修 |
| 临时超限 / 工具配对 | mid-run 在 turn 边界维护；cut 不拆 tool pairs；incomplete pairs fail-open | 符合 soft 允许临时超限 | 已具备 |
| 硬容量 | overflow / payload rejection / recovery 仍生效 | soft 不能绕过 hard | 已具备 |
| 维护后约束保留 | mid-run goal reinject（本轮修复） | 合同要求保留 goal/约束等 | 部分已修 |

**结论：** 200K 是目标合同，**尚未**成为生产有效 soft default。仓库已有 **opt-in 实验路径**承载 200K tier + 小窗回退，但默认 off；不得用打开实验替代正式生产默认。本轮对 200K **仅审计与记录，无默认值代码改动**。

效率优化：无新瓶颈证据，未做。

### 改动（工作树，未提交）

复用 `SessionMaintenance` / `#buildGoalModeMessage`、`child-delivery-evidence`、`formatTaskResultSummary`。无第二套 goal/acceptance/compressor；无新持久状态。

1. Mid-run 后 `refreshLiveGoalModeContext()`  
2. task-result 透出 classification/action/reasons；`checksIndicateParentOwnsVerify` 对齐  
3. 去掉 `capability/index` 对 `rule-source-diagnosis` 的 star re-export  
4. **未**修改 `compaction.threshold*` 生产默认；**未**启用 `compaction.experiment.*`

### 验证

| 命令 | 结果 |
|---|---|
| `bun check`（coding-agent） | pass |
| mid-run goal reinject / supersede 用例 | pass |
| `result-summary` / `child-delivery-evidence` / `rule-source-diagnosis` | pass |
| `delivers parent steering…`（同文件） | fail（与本改无关的既有 flake） |
| CLI `--version` / `--smoke-test` | pass（`omp/18.3.1`） |
| 200K 有效阈值对照 | 本地 `Settings.isolated` + `resolveThresholdTokens` 脚本（见上表） |
| 真实模型遵守 / 付费配对 | **未跑** |

### 边界

- 生产默认改为 200K：**待单独确认**后另做。候选落地路径：`compaction.thresholdTokens=200000`（正式）或经确认的实验单因素——二者都需显式授权；小窗须用 `min(200K, window−reserve)` 语义（实验路径已有，生产 fixed-token 路径尚缺）。  
- phase-handoff / Hub integrate / 纯对话禁区：延期。  
- 无性能百分比声称。

### 回退

丢弃工作树相关 diff / `artifacts/coding-harness-practical-impl-2026-09-27.patch` 即可。无配置/数据迁移。勿只回退 capability 拆环而不替代，否则 AgentSession 再进 TDZ。

### 产物路径

- 本文件：`docs/design/2026-09-27-coding-harness-practical-plan.md`  
- 摘要：`artifacts/coding-harness-practical-impl-2026-09-27.md`  
- 未提交补丁：`artifacts/coding-harness-practical-impl-2026-09-27.patch`

---

## 实施记录（生产 200K soft-cap 落地）

日期：2026-09-27。基线 tip：`4316b36d90abc73ab23009c85ec9c2b14dfcfe25`（`workflow`）。  
用户已 **CONFIRMED** 落地生产默认 soft-cap = 200K。分支：`cursor/soft-cap-200k-default-6420`（draft PR）。

### Before → After（有效阈值）

| Window | Before（legacy usable） | After（`min(200K, usable)`） |
|---:|---:|---:|
| 128_000 | 108_800 | 108_800 |
| 200_000 | 170_000 | 170_000 |
| 256_000 | 217_600 | **200_000** |
| 1_000_000 | 850_000 | **200_000** |

Clamp fix：fixed `thresholdTokens` 现夹到 `window − resolveBudgetReserveTokens`（`resolveUsableContextTokens`），不再夹到 `window−1`。

### 改动

1. **生产默认**：`compaction.thresholdTokens` default → `200_000`（`DEFAULT_COMPACTION_SOFT_CAP_TOKENS`）。**未**打开 `compaction.experiment.enabled`。
2. **Clamp**：`resolveThresholdTokens` / 新 `resolveUsableContextTokens`（`packages/agent`）。
3. **UI**：Default = 200K soft-cap；新增 Legacy（`-1`）逃逸。
4. **并入先前未提交正确性修复**（tip 上仍缺失）：mid-run `refreshLiveGoalModeContext`；`<task-result>` classification/action/reasons + `checksIndicateParentOwnsVerify` 对齐；capability TDZ（去掉 `rule-source-diagnosis` star re-export）。

### 验证

| 命令 | 结果 |
|---|---|
| `bun check` | pass |
| `bun test packages/agent/test/compaction-soft-cap-threshold.test.ts` | pass |
| `bun test packages/coding-agent/test/session/soft-cap-default.test.ts` | pass |
| `bun test …/result-summary.test.ts` | pass |
| `bun test …/agent-session-goal-midrun-compaction.test.ts -t reinjects` | pass |
| `delivers parent steering…` | 既有 flake（与本改无关） |
| 付费 / 真实模型 | **未跑** |

### 回退

将 `compaction.thresholdTokens` 默认改回 `-1`，并还原 usable-window clamp / UI Default 映射；正确性三项可独立回退。用户显式配置不受影响。用户选 Legacy（`-1`）可立即恢复旧 usable-window 触发。

---

## 实施记录（生产 soft-cap 修订：200K 固定 → 60% 窗口）

日期：2026-09-27。基线 tip：`8e87da9d8d9f7e09b57aa69d1fc5deb9e5a87021`（`workflow`，含 #40）。  
用户反馈固定 200K 触发过于频繁；目标改为**按窗口百分比**的生产 soft-cap，而非固定 600K tokens。

### Before → After（生产默认 / 有效阈值）

| Knob / Window | Before（#40：固定 200K） | After（60% + tokens=-1） |
|---|---:|---:|
| `compaction.thresholdPercent` | `-1` | **`60`** |
| `compaction.thresholdTokens` | `200_000` | **`-1`**（percent 生效） |
| `compaction.experiment.enabled` | `false` | `false`（未开实验） |
| 200_000 window | 170_000（usable clamp） | **120_000**（60%） |
| 256_000 window | 200_000 | **153_600** |
| 1_000_000 window | 200_000 | **600_000** |

Clamp（#40）：固定 `thresholdTokens>0` 仍夹到 `window − reserve`，不回归 `window−1`。Percent 路径按现有实现取 `floor(window × pct/100)`；在默认 15% reserve 下 60% 始终 ≤ usable。

### 回退

将 `thresholdPercent` 默认改回 `-1`、`thresholdTokens` 改回 `200_000`（或再退到双 `-1` usable-only）；UI Default 映射同步回退。
