# 任务质量、耗时与 token 成本：补齐闭环的实施与验证方案

日期：2026-09-26。状态：**研究完成，供新会话实施；不是收益验收报告。**

代码基线：`b6c485a543f91fbf84b922d7f7bd9be4ff127df4`；包含 `9c0f8c743f55..55f95e618235` 的 Packages 1–5、S0–S4 和本次评审修复。

## 1. 结论与授权边界

**尚未完成“提高任务完成质量，同时降低耗时和 token/费用”的端到端目标。已完成的是一批基础机制、安全修复和实验入口；真实生产接线、任务级验收、可关联观测、成对效果验证与安装生效证据仍有缺口。**

不能用以下替代目标达成：代码合并、测试通过、子代理 completed、schema-valid、读到相同字节、开关注册、离线纯函数的 `applied:true`。

本方案默认决策：先把一次交付的验收与成本算对，接通子交付与验证证据，再按实测瓶颈做单因素实验。保持主代理的委派决定权，不加硬路由分类器、不建第二套调度/记忆/遥测系统，不先全局降模型、降 effort、提并发、缩短超时或统一收紧输出。

本次仅研究并产出方案/脱敏附件；没有修改运行时代码、安装二进制或运行付费实网实验。后续付费 A/B、替换本机安装、生产配置/默认值翻转分别需要明确授权；普通实现请求不自动授权这些动作。

## 2. 当前交付状态：代码存在、生产生效、效果达标分开记

| 能力 | 现在完成的部分 | 还缺什么 | 后续包 |
|---|---|---|---|
| Package 1 成本基线 | JSONL 解析、ordinary/workflow 分组、缺测覆盖、费用部分和保留、验收成本门控 | 普通会话真实验收生产者；任务/attempt 粒度；分支/重复事件归属；新版本样本 | W1、W3 |
| Package 2 子交付证据 | packet 构建/解析、分类器、结果字段透传，settle 不把未查新鲜度的包当可集成 | 稳定生产者；父级以实际工作区/验收合同重分类；观测消费者及效果 | W2 |
| Package 3 分层验证 | workflow 的 slice_local/final_repo 真正按计划运行或复用，失效保护已接通 | 复用发生/拒绝原因/管理开销落盘；普通会话的验证归属与最终 sink；节省实测 | W3 |
| Package 4 A 读去重 | 默认关闭的单因素函数与测试 | 该实验开关无生产消费者；须与现有普通 read-dedupe arm 去重，不另造缓存 | W7 |
| Package 4 B 稳定前缀 | 指纹、顺序分析/规划、A/B 互斥；已修 static→dynamic→static 漏判 | provider 实际序列化观察与受控 apply；缓存写/读与 TTFT 联合验证 | W5 |
| Package 5 模型/effort/并发 | 文档、blocked-until 门及既有配对入口 | 资格数据与授权实网配对；无默认策略优化结论 | W8、W9 |
| S0 凭据/路由早停 | 普通 fallback 与 workflow preflight 接负缓存；owner/session/route/version 隔离；403 不扩大封禁 | env/config/OAuth/轮换账号缺可靠 revision 时安全地不复用缓存；需真实失败回放及可选扩展 | W4 |
| S1 验收就绪与 handoff observe | API、内存计数器、debug 日志 | 普通验收 API 无生产调用方；handoff 观察不能由离线 JSONL 报表关联 | W1、W2、W3 |
| S2 阶段交接/携带上下文减量 | 纯函数 harness；三个保留数组非空时可清 bulkyCarry | 尚无真实 compaction/phase-boundary 接线；非空不等于语义完整 | W6 |
| S3 分页继续读 | read 工具实际调用 compose；stale kwargs 明确报错 | 新版本真实使用回归与往返开销测量；不需要重新实现 | W7、W8 |
| S4 循环/流中断 | 测试现已执行真实恢复方法，验证调度、产物保留和预算耗尽 | 历史有状态故障的全链回放、provider 边界与新版本效果覆盖 | W4、W8 |
| 本机生效 | 已提交修复；源代码检查与定向回归通过 | 当前安装未证明对应此 SHA；版本号不足以证明修复正在运行 | W0 |

“默认关闭”是安全策略，不是缺陷；“入口存在但未接运行时”和“实现已接通但缺效果证据”是不同未完成项。

### 2.1 已核验的关键断点

路径默认相对仓库根；行号以基线为准，后续用 LSP 重新定位，不硬套旧行号。

1. `packages/coding-agent/src/session/agent-session.ts:7387-7401`：`recordParentFinalVerification` 存在；LSP references 仅定义，无仓库内生产调用方。不能在正常 stop 上自动写 passed。
2. `packages/coding-agent/src/workflow/engine.ts:2341-2344`：workflow final_verify 写 `parent_final_verification`，依据 `deliveryOk`，不是任意工具成功。
3. `packages/coding-agent/src/latency/parent-final-verification.ts:17-27`：当前 receipt 只有 status/source/verifiedAtMs，缺任务 episode 和 attempt 关联。
4. `packages/coding-agent/src/latency/delivery-cost-baseline.ts`：目前以父 session 分组为 task 代理，不能准确表达同一会话里的多个用户任务/多个 workflow。已修费用不完整门控，**已知部分和仍保留**；下一轮不得再把缺价任务的已知费用清成 null。
5. `packages/coding-agent/src/task/structured-subagent.ts:873-903`：只抽取 structured output 或文本围栏；packet-only 的 integrate 降为 stale_context。`deliveryEvidence`/`parentIntegrateDecision` 确实附在 result，可能经通用序列化展示给父；缺的是 typed 消费/父级复核链，不是字段完全不可见。
6. `packages/coding-agent/src/task/evidence-handoff-observe.ts:32-72`：内存 snapshot+logger，无法单靠 session JSONL 复算 generate→consume→stale→reuse。
7. `packages/coding-agent/src/workflow/stages/final-verify.ts:68-129`：planner 的 toRun/toReuse 确实控制执行；不是只有计划，没有执行。`countFullRepoRunsAvoided` 尚未形成可读效果链。
8. `docs/delivery-read-cache-experiments.md:23-30`、`docs/phase-handoff-experiment.md:39-45`：明确开关本身不改变 production。不能把这些函数测试当线上收益。
9. `packages/coding-agent/src/latency/credential-route-unavailable.ts:100-142`：无法确认 credential revision 的 source 返回 undefined。未来覆盖更多凭据必须在 auth owner 层解决，不能恢复全局 default scope。
10. `packages/coding-agent/src/session/session-manager.ts:1710-1716,3168-3179`：已有持久化 entry id/parentId，`appendMessage` 返回 entry id；没有现成的业务任务 episode 合同，不代表没有可复用用户消息锚点。
11. `packages/coding-agent/src/session/agent-session.ts:7483-7560`：已有 rollout observation，`sampleUnit:"session"`，落 rollout store；不是完整任务级验收。须复用其关联能力，不能混淆 session 正常退出与任务通过。

## 3. 本机会话证据

附件：[`../../research/2026-09-26-delivery-readiness-evidence.json`](../../research/2026-09-26-delivery-readiness-evidence.json)。包含时间窗、指标定义、脱敏文件 id、每文件内容 SHA-256、输入清单指纹；不保存原始对话正文、密钥或真实项目路径。

### 3.1 本次实测

- 采集于 `2026-09-26T11:11:37.001Z`，选择 `~/.omp/agent/sessions` 中项目目录名包含 `tencent`、整组最大 mtime 在最近 30 天内的会话。
- 排除本研究所在主会话及全部子会话，避免研究过程污染结果；不纳入 `-tmp-*` benchmark 目录。
- **354 主会话 + 906 子会话 = 1,260 JSONL 文件**，解析错误 0，读取期间变动文件 0。
- 记录事件跨度：`2026-08-22T15:45:45.997Z` 至 `2026-09-26T10:14:14.743Z`。这是按组 mtime 选整段历史，不是纯 30 天事件过滤。
- 69,208 条 assistant 记录。它们不是已去重的物理请求/账单记录。

| 观察项 | 实测 | 能说明什么 / 不能说明什么 |
|---|---:|---|
| 显式父级最终验收 | **0 / 354** | 无法计算可信首次通过、任务验收单位成本；不能认定354任务都失败 |
| request-phase queue coverage | **0 / 758** | 不能归因为 provider 排队，也不能凭此调并发 |
| 本地 spawn queue coverage | **98 / 758** | 覆盖不足；与远端排队不是一回事 |
| completion kind | 618 已知 / 140 未知 | completed 475、timeout 29、hard_abort 114；中止不全是产品失败 |
| 明确 workflow 工具调用 | 0 | 该样本不能证明 workflow 路径的收益 |
| task context 中 handoff 标记 | 1 / 491 调用候选 | 不是可靠消费率；正文引用也可能命中，不等于有效包 |
| 名义费用合计 | **6,516.74** | 来自 usage.cost.total，不是账单，不是“成功任务成本” |
| 主会话名义费用占比 | **73.46%** | 值得优先研究主会话；不能推出子代理一定更划算 |
| 前10/20组费用占比 | **38.76% / 53.50%** | 适合选高成本案例做分层回放 |
| 主会话 >200k 输入上下文 | **22.97% 请求，48.72% 主费用** | input+cacheRead+cacheWrite；不是totalTokens，不作为统一压缩阈值 |
| 9月19日起主会话 >200k 的费用占比 | **53.45%** | 上下文成本候选近期仍明显，尚不是可节省比例 |
| read+grep 返回文本占比 | **86.79% 字符量** | 只是证据输入来源，不是重复/可删token比例 |
| 近期 assistant error | 63 | 现行分类器回溯给出44个配置失败候选；历史分类/运行版本未证，不能直接算修复率 |

所有 usage 字段“存在”不代表真实定价完整：样本有 1,700 条零价格请求记录；其中错误的零费用不能解释为无成本。提供商计价/缓存归一化须在 W1/W5 审计。

### 3.2 历史案例复核

本次比对旧研究附件与新 manifest：以下六个案例文件的完整 SHA-256 **均未变化**，可继续复用旧人工核查结论，但不得冒充新版本运行结果。

- `54004ad2dae12e59`，记录264–274：11次连续凭据失败，首尾相隔13.60分钟；这是等待跨度，不是可直接减掉的节省值。
- `37eaa48f311f899f`、`48487a81c52fb59f`：意图继续读却再次读取相同第一页。
- `c13a8498dd06706e`，调用36/39：offset从1改301而path不变，旧版本仍返回第一页；S3已修，应成为新版本回放fixture而非待重复实现项。
- `a4381212eac40cb0`：相同字节的重读用于样式复核，是不能机械去重的反例。
- `80ede3355d711a6e`：相同检查命令的返回只是 async.running；不能算两次完成验证，也不能据此宣称重复验证浪费。

旧人工报告：[`../../research/2026-09-26-session-history-optimization-supplement.md`](../../research/2026-09-26-session-history-optimization-supplement.md)。严格同视图重读0.94%是**旧样本**数字，本次没有重新计算该指标，不混用分母。

### 3.3 源码与已安装程序不是同一个证据

本次只读探测：`command -v omp` → `~/.local/bin/omp`，版本 `omp/18.3.1`，arm64 Mach-O；mtime `2026-09-25T17:40:18+08:00`，SHA-256 `69d11fcac3c3413d4d46bacc999dfbad5f31e56870ff20afcfa0325d36da131f`。

没有构建、安装或证明该二进制包含 `b6c485a543`。版本/mtime不能唯一映射源码；因此不能说“刚修的功能已在本机生产生效”，也不能把历史记录归为修复后 treatment。

## 4. 统一成功口径与最小数据合同

### 4.1 五种状态必须分开

每个工作包记录：`code_complete` → `runtime_wired` → `mechanism_verified` → `paired_evidence_ready` → `rollout_verified`。

- 未观察到：unknown；证据不足：insufficient；故障/超时/取消单独分类。
- `completed`只表达运行完成，不表达验收通过。
- 成本、耗时、缓存的效果结论必须引用同版本、同任务、同配置和已完成验收。

### 4.2 复用已有 ID，不把 session 偷换成 task

W1拟定的合同（**计划，不是已存在字段**）：

- task episode：复用 `sessionId + rootUserEntryId` 作稳定锚点，保留分支身份；workflow复用 `workflowId`，其运行尝试复用 `attemptId`；子任务复用 taskToolCallId/jobId/agentId。
- 用户一条消息可能包含多个需求，先按一个显式验收合同处理，不增加LLM任务拆分分类器。
- 一个任务的修复/澄清属于同episode的后续attempt；明确新任务或已验收后的新请求开始新episode。若现有入口无法可靠判断边界，要求明确边界/保持unattributed，不能偷偷把每次工具调用当一个任务。
- 只扩展现有验收/观察custom事件，提供version和幂等event id；不扩EvidenceHandoff协议，不另建事件总线。
- 可复用：session entry id、现有rollout cohort event id、workflow运行身份、实际工作区/patch指纹、trusted verifier的terminal receipt。
- 旧记录不回填passed/任务归属；保留legacy session级统计并明确标注。mixed ordinary/workflow按episode拆开；无法拆解的旧混合记录保持unknown，不能强行吸收到workflow。

### 4.3 验收 authority

- 必须来自可识别的trusted verifier执行结果、受控外部验收回调，或显式用户验收；LLM“我做完了”、子包的proven:true、exit0、todo全完成均不够。
- 不预设新增“accept工具”。优先用现有验证sink/扩展hook/交互命令接口接通已有API；不要新增每回合裁判模型调用。
- 验收与工作区快照绑定；后续修改、branch切换、验收合同变化使先前绿灯不能覆盖新结果。
- ordinary改用不进入模型上下文的`appendCustomEntry`记录时，要同步ordinary active-branch读取器；目前其API使用custom_message，不能只改写入不改读取。
- 写入失败不把任务错误判passed；保留可见诊断与观测unknown，不阻断无关用户工作。

### 4.4 KPI

1. 验收率、首次通过率、返工轮数、已知缺陷漏检/错误接受、用户纠正；同时展示覆盖率。
2. `costPerAcceptedTask = 全部已归属attempt费用 / 验收通过episode数`：包含失败/重试/修复；仅在相关价格完整且分母>0时给值。已知费用部分和始终保留；缺价不填零。
3. token分开报 input/output/cacheRead/cacheWrite；检查provider原始usage如何归一化，避免cache重复相加，不能用totalTokens当输入上下文。
4. 同时报告成功任务wall和全部尝试wall；用户暂停、模型等待、工具等待、本地排队、父级整合分开。task的启动确认不算settle，异步running不算验证完成。
5. 没有因果边只能报observed span/active wall，不能把并行分支累加称critical path或节省时间。
6. 观察/验收/handoff管理自身的请求、token和耗时计入总成本，不能靠新增大量检查把单项指标做漂亮。

## 5. 完整实施清单

### W0 · P0：冻结运行基线与可复现任务集入口

**目的**：分清“代码写了”和“运行了哪个版本”。

- Owner：现有CLI/build入口、session init、workflow benchmark provenance、`docs/local-build-install.md`；先查已有build元信息，能复用就不加第二份。
- 记录源码SHA、dirty指纹、二进制hash、运行形态(source/binary)、配置/工具/schema指纹及实际model/provider/api；没有运行证明就记unverified。
- 冻结对照为`b6c485a543`，处理之前保留当前工作区文档与未跟踪研究文件；不clean、不reset用户改动。
- 先源码/临时构建验收；安装授权后才按既有本机安装规则做原子替换和可回滚备份。新会话不是默认自动部署。

**验收**：source与binary各一次离线代表性链路；compiled worker `--smoke-test`通过；授权安装后hash一致；重启会话后receipt能关联真实build。版本号相同而hash不同不得混成同一实验组。

### W1 · P0：普通任务验收生产者 + 任务级成本闭环

**Owner**：`latency/parent-final-verification.ts`、`latency/delivery-cost-baseline.ts`、`latency/subagent-report.ts`、`session/agent-session.ts`、`session/session-manager.ts`、`workflow/engine.ts`及既有验收入口。

**实施**：

1. 先把§4 episode/attempt/branch/验收authority合同定下来，复用持久化用户entry id，不以非持久的内存计数当业务身份。
2. 普通会话真实验证sink调用已有record API；workflow补关联ID。仅主动启用、已有验收条件时执行验证，不能每个查询都强制full check。
3. 验收receipt携带验收合同/证据引用、codeState和authority，使用既有custom事件及版本兼容解析；元数据不灌入模型上下文。
4. ordinary active-branch与离线解析统一读custom/custom_message。任务未完成、取消、missing receipt保持unknown/failed等真实状态。
5. 聚合按episode和attempt，处理一个session多任务、嵌套子代理、重复入库、分支丢弃、复制历史。能拿到provider response id/entry id时去重，拿不到时报告关联覆盖而非猜测。
6. 保留本次partial cost修复，补cacheWrite聚合、price provenance/unknown提示；零费用error单列，不凭usage有0就声称账单完整。

**行为验证**：正常stop无验收；工具通过但需求不满足不accepted；failed→repair→passed只算一个accepted episode且保留全部费用；同session两任务费用隔离；同session ordinary/workflow不混分母；fork/重复receipt/恢复不重复计费；缺一笔价格时部分和保留、比率null；写入失败不生成绿灯。

**真实冒烟**：使用持久化临时session完成一个有已知失败/修复的任务，跑`stats:subagents --session ... --format json`检查完整链路；不能只测builder字段回显。历史354组继续unknown是正确结果。

### W2 · P0：子交付包生成 → 父级可信复核 → 最小整合

**Owner**：`task/child-delivery-evidence.ts`、`task/structured-subagent.ts`、`task/workpool.ts`、既有task/eval结果通道与worker提示资产。

**实施**：

- 由executor/验证owner基于实际patch、代码版本、terminal检查和write ownership生成可核验字段；worker可提供结论，但不能自己封印passed。
- 使用既有packet/result side channel，显式outputSchema优先级保持，不覆盖用户schema，不强制所有agent写一段长JSON围栏。
- 确定性来源不足时沿用missing/unchecked分类，不编造证据。reviewer只接收原始事实、diff、要求，不继承authorConclusions为结论依据。
- 父级在**当前工作区、已知验收清单、实际freshness**上再次调用分类器；绑定result和父episode，把decision接到父整合提示/受控决策入口。
- packet-only仍不能直接integrate。所谓done_valid只是具备整合条件，不等于最终验收passed，不自动越权合并/删除。
- 过期/缺局部证据退回原worker（上下文仍有效时）或重读必要差异；跨模块合同由父协调，不重新全面调查。

**验收**：真实子任务不靠手工围栏即可返回包；新鲜完备证据可经父重分类变成integrate；stale、缺required acceptance、未释放写权、伪造proven都不误接收；用户schema不变；reviewer能发现作者错误判断；父级必要重读保留。比较总回合/重读/返工和质量，不能把“读文件减少”单独当成功。

### W3 · P0：最小持久化观测 + 验证归属收口

**Owner**：`task/evidence-handoff-observe.ts`、`task/workpool.ts`、现有async lifecycle、`workflow/layered-verification.ts`、`workflow/stages/{implementation-verify,final-verify}.ts`、报表/rollout store。

**实施**：

- 将generate/inspect/reject-stale/reuse、child settled/parent consumed、verify run/reuse/reject及管理开销关联到episode/job/receipt，不仅留模块级计数。
- 用既有custom entry或已有rollout记录，固定一个去重和持久化owner；只在生命周期边界写小摘要，不逐token记日志，不新增模型请求。
- 分层验证继续复用当前planner/validity，不另建检查平台。普通任务明确local evidence与parent final sink的归属，不把worker绿灯当最终验收。
- 保存命令/作用域/代码态/执行者/terminal结果的摘要；复用失败必须给可观察原因。partial reuse必须保留已复用和新运行的全部必要检查结果。
- “全仓检查少跑一次”只有先前terminal green、命令/作用域/代码态满足复用时才计；async.running永远不能计通过。
- 不把统计缺口强补为provider queue；provider不提供队列计时则保持unknown，本地semaphore单列。

**验收**：退出重启仍可复算一次handoff闭环；重复落盘不重复计数；代码/命令/配置/branch变化使复用失效；同快照复用能观察到真实少执行；必要final验证不被跳过；报告观测本身的开销。

### W4 · P1（失败止损优先）：扩大可靠鉴权身份覆盖与有状态故障回放

**Owner**：`packages/ai/src/auth/{cascade,types}.ts`及credential selection owner，`latency/credential-route-unavailable.ts`、`session/turn-recovery.ts`、`workflow/availability-preflight.ts`。

**实施**：

1. 固定既有runtime-key隔离、403模型权限边界和TTL回归，先回放E1与短冷却/transport对照，不调整默认重试次数来制造提速。
2. 对实际使用的auth来源补**已选credential/route的非秘密身份+revision**。selected account不确定、command/env key变化无法观察时继续fail-open；不把“第一个账号”当实际账号，不在日志保存token/hash-of-secret。
3. 从实际解析完成或auth owner的选择事件取revision；refresh/rotate/config更新使旧标记失效。跨进程共享需要先证明同身份和安全持久化必要性，首轮不做。
4. 新session/provider/model/baseUrl/accountAccess/revision隔离；同身份的配置失败可复用，策略拒绝最多约束具体模型/权限域。
5. 将真实stream stall/thinking-loop场景接入AgentSession级回放：副作用工具只执行一次、未完成call可恢复、持久化重开保留结果、重试预算有界。

**验收**：同账号坏凭据链有界；健康账号/新key不被误封；403不阻断健康兄弟；short cooldown和transport能恢复；正常成功清标记；日志脱敏；无法证明身份时仍走正常请求。只有链路时间线支持时才报告失败等待节省，不能把13.60分钟直接算收益。

### W5 · P1：真实请求前缀观察，再做受控缓存优化

**Owner**：`latency/stable-prefix-cache-experiment.ts`、现有prompt/tool组装与`packages/ai`实际provider serializer/response usage边界；模型策略仍归catalog KDL。

**实施**：

- 第一阶段仅观察：真实发送前的segment kind、指纹、字节数、实际provider/api/model、工具/schema/effort身份。默认不保存raw prompt、URL密钥或隐私正文。
- 区分同child后续请求、不同siblings首请求、cold/warm、缓存TTL；不能用客户端字符串相同宣称服务器命中。
- 先核对provider版本与usage归一化：cacheWrite不得丢，cacheRead不跨provider盲算比率，gateway兼容性不能由直连官方文档推定。
- 第二阶段仅在安全装配边界接`planStablePrefixOrder`；保持消息角色、指令优先级、工具可用性、schema和权限，不把`other`段随意搬移。
- 保留A/B互斥；不自动预热或自动发付费流量；`claimedLiveWin:false`的机制receipt不能被改成结果证明。

**验收**：实际序列化请求证明静态前缀稳定；tool/schema/role未变；static→dynamic→tools被识别；请求usage、TTFT、写缓存费用和总任务费用一起报告。命中率提高但总完成成本/质量变差则不推广。

### W6 · P1：阶段性交接接入真实上下文维护

**Owner**：`session/phase-handoff-experiment.ts`、`session/agent-session.ts`、既有structured compaction/restore、artifact恢复入口。

**实施**：

- 先shadow判定自然边界（研究→实现→验证或已明确完成的子阶段），不每回合让模型额外总结，不强制200k全局阈值。
- 保留“未决约束、验收合同、修改/branch状态、未完成工具、失败尝试、必要artifact与恢复定位”；不是只检查三个数组非空。
- 厚输出外置但可恢复；对保留内容引用绑定版本与可用性。不能删除provider要求完整回放的reasoning/tool配对，也不能压掉未完成副作用。
- treatment调用现有compaction/context rewrite owner，幂等、有失败回退；不造第二份会话记忆。开关关闭时生产上下文完全沿旧路径。
- 把压缩本身的调用、费用、重读与缓存破坏计入总成本。

**验收**：长会话跨阶段后仍遵守早期约束；中断重启可恢复；过时artifact需重读；未完成tool-call配对不丢；missing required state回退；开启S2不同时开A/B或改模型并发。只有任务质量不下降且总完成开销改善才考虑推广。

### W7 · P1/P2：读取契约收口与去重实验去重建设

**Owner**：`tools/read.ts`、`tools/read-selector.ts`、现有ReadViewKey/普通read-dedupe arm、`latency/read-dedupe-experiment.ts`。

- S3不重写，加入真实调用层的下一页locator、raw/范围/旧kwargs/stale kwargs/不同视图/变更后读取回放。
- 先明确已有`latency.arms.readDedupe`与`deliveryExperiment.readDedupe`各自职责；实验A作为已有策略的受控选择层，不并行建设另一张缓存表或重复输出处理器。
- 同version+view才可复用，权限/来源变化、恢复缺页、必要独立复核均允许重读；确需当前原文时有完整恢复入口。
- 观测的是减少重复传输和后续恢复回合；一次reuse不必减少一次tool调用。验收不能预先假设“reuse=true就toolCalls下降”。
- read+grep字节量大不等于多余；全局禁重读和固定缩短输出继续不做。

**验收**：原E2/E3拿到目标页；反例E4仍能复核；同视图复用减少provider可见重复字节且不增加净恢复开销；stale/不同selector不误复用。收益小则保持实验入口，不强推默认。

### W8 · P0贯穿 / 交付前硬门：任务质量评测与单因素成对验证

**Owner**：现有`workflow/benchmark/{runner,types,live-runtime,report}.ts`、`test/task/product-latency-fixture.ts`、现有ordinary rollout cohort和paired corpus，不另建benchmark平台。

**固定任务集至少覆盖八类**：

1. 小范围查询：应直接做，不能靠额外代理刷“更全面”。
2. 已诊断局部修复：测证据交接减少重复调查。
3. 两个独立模块：测真并行收益和整合成本。
4. 同文件/共享接口：测所有权保护与过拆分风险。
5. 带已知缺陷的独立review：测漏检与错误接受，不能只看代码测试green。
6. 长会话跨阶段：测早期约束、artifact恢复、上下文与缓存权衡。
7. auth/transport/thinking-loop+已完成写入：测恢复保真与长尾。
8. 多episode/分支/重复receipt/价格缺失：测指标可信度与幂等。

**执行层次**：

- L0：离线确定性/故障回放，覆盖真实状态转换，不测源码字符串或builder常量回显。
- L1：本地真实CLI/AgentSession/workpool/compiled worker链路，provider用受控本地fixture；只证明机制，不计live收益。
- L2：已授权的小样本paired screen；先固定少量代表任务筛方向，之后扩到20–50个真实失败/常见任务，并按任务重复运行。数字是起步规模，不是统计充分性的保证。
- L3：同类、足量新版本自然样本和有授权的paired数据；p90等尾指标必须给样本数/区间，不足时写insufficient。

**每对仅改变一个因素**：A读复用、B前缀、S2上下文、model、effort、concurrency不能混在同一delta。固定代码快照、工具/schema、验收器、预算、任务和账户/route条件；交替AB/BA，控制冷/热缓存，不保留前次trial工作目录带来的答案泄漏。

**必要结果**：验收率/first-pass/rework/漏检/误接受/用户纠正、all-attempt cost、成功与所有尝试wall、四类token、TTFT、recovery round-trips、handoff/verify管理开销。失败、超时、不可用、人工取消都保留并分层，不能删失败样本赢指标。

**推广门**：安全/副作用/关键约束零已知回归；质量不因成本下降而放宽；预先登记质量非劣界限与停止规则，默认不接受观测样本质量下降。报告配对差值和任务级不确定性；置信不足就不改默认，不能把screen写成p90已改善。

### W9 · P2 / 条件项：模型、effort、并发与默认推广

依赖W1–W3可观测、相关W5–W7数据、W8质量门；继续遵守现有B-M*/B-C*/B-I*/B-O*。

- 模型/effort按机械实现、复杂实现、独立review分层，一次只改一项。验证actual model/effort而非requested label，固定effort模型不计“调档实验”。
- 并发只有出现本地semaphore或远端竞争证据才试1/2/4；不得把provider queue unknown改成0。provider策略进现有owner/KDL，不加第二scheduler。
- code-intel默认优先或额外prompt规则，必须有新语料人工归因和paired质量证据；目前有工具不等于应该强制每次调用。
- 所有默认翻拨单独提交并携带效果/回滚receipt；灰度范围、停止条件、最大实验花费先确定。研究/实现不等于获准运行付费pairs或改本机配置。

**验收**：匹配gate的证据齐、授权齐、负向case通过、回滚恢复旧行为；否则结论就是blocked/insufficient，不算实现失败，也不得声称整体目标完成。

## 6. 顺序、分工和交付边界

依赖顺序：

```text
W0 基线身份 + W8 任务/验收集定义
    → W1 任务验收与费用归属
    → W2 子交付闭环 + W3 持久化观测/验证归属
    → W4 失败止损（可先独立回放，依赖身份合同后扩覆盖）
    → W5 前缀observe；W6阶段交接shadow；W7读契约回放
    → 分别启用单因素treatment并执行W8配对
    → W9按匹配gate决定是否试验/推广
```

- 第一交付批建议W0/W1/W2/W3及W8离线基准：这是当前最高优先的闭环，不用等全部实验做完才产出可验收结果。
- 第二批优先W4可靠失败止损和W5真实前缀observe，再做W6；W7已有S3继续回放，新的去重treatment排在证据之后。
- 第三批仅在证据允许时做W9，不为凑“全部完成”强行解锁。
- 同一个`agent-session.ts`、`subagent-report.ts`或auth公共合同由单一owner集成；不可让多个agent同时改。W1先定关联合同，W2/W3才能独立实现。
- 每个切片调查+实现+局部行为验证保持一个owner；父级统一最终验证。不要为流程启动固定scout→author→review→repair链或空等轮询。

## 7. 新会话验证命令与结果记录

以下是已存在入口，不代表本次研究执行过这些新方案：

```sh
# 先固定身份和用户已有改动
 git rev-parse HEAD
 git status --short

# 变更区域定向测试；实际新增测试也加入同一批
 bun test packages/coding-agent/test/latency/delivery-cost-baseline.test.ts \
   packages/coding-agent/test/latency/acceptance-metric-readiness.test.ts \
   packages/coding-agent/test/task/child-delivery-evidence.test.ts \
   packages/coding-agent/test/task/evidence-handoff-observe.test.ts \
   packages/coding-agent/test/task/workpool.test.ts \
   packages/coding-agent/test/workflow/layered-verification.test.ts \
   packages/coding-agent/test/workflow/verification-validity.test.ts \
   packages/coding-agent/test/session/credential-route-unavailable-recovery.test.ts \
   packages/coding-agent/test/session/thinking-loop-stream-interrupt-fixtures.test.ts \
   packages/coding-agent/test/tools/read-pagination-fidelity.test.ts
 bun check

# 生产形态：对真实新生成的受控会话JSONL核验，而不是只构造receipt对象
 bun scripts/session-stats/subagent-report.ts --session /path/to/controlled-parent.jsonl --format json

# 既有配对分析入口；必须先有受控corpus，禁止自动产生付费流量
 bun run test:latency:paired:advisories -- \
   --paired-control /path/to/control --paired-treatment /path/to/treatment --output /tmp/advisories-pairs.json
 bun run test:latency:paired:sonic-effort -- \
   --paired-control /path/to/control --paired-treatment /path/to/treatment --output /tmp/sonic-effort-pairs.json
```

- 上述两个paired入口分别只覆盖advisories、sonic-effort，不能冒充A/B/S2或所有角色×模型的harness。缺入口时扩现有benchmark owner，保持单因素和no-live-by-default。
- 本机build/install按`docs/local-build-install.md`及对应领域规则，compiled `--smoke-test`必须运行。仅在安装授权后替换`~/.local/bin/omp`，不要使用官方安装器覆盖当前checkout构建。
- 每批交付记录：基线/patch/config指纹、实际运行身份、场景、检查命令及terminal结果、失败保留、未验证项、rollback方式。
- W1/W2/W3最终验收必须至少包含一个ordinary真实持久化链路和一个workflow链路；两者分开计，不靠全是workflow fixtures证明ordinary可用。

## 8. 完成判定与不能承诺的部分

### 工程闭环完成

- W0–W3生产链路与身份可核验，普通任务有真正的验收来源和正确成本归属。
- 子包从实际执行生成、父级检查freshness/合同后消费，不强制重读全部，也不自动相信作者。
- 所有计划推广的实验已接真实apply点，并通过关闭/启用/回退/恢复负向测试。
- W4–W7适用场景完成，未适用项有明确原因，不以全局开关假装生效。
- 相关测试、真实CLI/会话/worker冒烟、最终检查通过；用户已有文件和权限边界保留。

### 优化目标达成

在工程闭环之外，还必须有W8/W9要求的**新版本、同任务、单因素**证据，显示质量不下降且总完成耗时/费用改善。无法获得授权实网样本时交付状态最多是`mechanism_verified / paired_evidence_insufficient`，不宣称“全部优化完成”。

剩余不确定性：gateway实际缓存/effort支持、零价格错误的真实账单成本、provider queue可观察性、任务边界的产品交互、自然样本数量、对不同任务类型的迁移收益。不得用历史统计消除这些不确定性。

## 9. 外部一手资料及适用边界

- [Anthropic：Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)，本次读取：区分task/trial/transcript/outcome，使用真实结果与回归/能力两类评测；20–50真实问题是起步建议，不是可靠尾分位数的保证。不照搬其示例中的特定工具调用顺序断言。
- [OpenAI：Prompt caching 当前指南](https://developers.openai.com/api/docs/guides/prompt-caching)，本次读取：实际rendered prefix、tool/schema/effort、cache write/read与保留期依模型变化；新旧模型语义不同。**官方直连接口能力不等于本机gateway必然支持**，实施时以锁定版本和真实请求/usage验证。
- [OpenAI：Prompt Caching 201](https://developers.openai.com/cookbook/examples/prompt_caching_201)，当前页面显式限定适用于GPT-5.6之前；本方案不把其固定128-token增量/缓存键经验扩成所有模型的策略。
- 本仓前序研究：`docs/research/2026-09-09-subagent-harness-next-optimizations.md`、`docs/research/2026-09-26-session-history-optimization-supplement.md`。旧版本/厂商收益数字仅作机制线索，不当本机收益。

## 10. 新会话启动交接

建议把以下内容作为新会话的执行请求（这是人类交接清单，不是仓库内新增系统提示资产）：

> 以`b6c485a543f91fbf84b922d7f7bd9be4ff127df4`为研究基线，执行`docs/superpowers/plans/2026-09-26-delivery-quality-cost-completion-plan.md`。先核对当前HEAD和用户已有改动，不重做整批评审。第一批完成W0/W1/W2/W3及W8离线任务集，补通普通验收、episode成本归属、子交付父复核和持久化观测；后续按依赖推进W4–W7。复用现有owner，验证真实状态转换与持久化CLI链路，保持unknown/费用部分和语义。不自动运行付费pairs、不替换本机安装、不改默认模型/effort/并发；W9依据授权和gate单独推进。最终分别报告工程完成、运行接通、机制验证和效果证据，不能把开关/测试通过当性能达标。

### 需保留的工作区内容

本研究开始时已有未提交：`docs/delivery-read-cache-experiments.md`、`docs/session-history-optimization-supplement.md`、`scripts/session-stats/README.md`；已有未跟踪：`docs/superpowers/specs/2026-09-13-intelligent-routing-harness-design.md`、`scripts/session-stats/subagent-thrash.py`、`scripts/session-stats/test_subagent_thrash.py`。本方案不覆盖它们，也不把未跟踪routing草案中的更紧cap/强制流程自动当授权需求。

本次新增只有本方案与脱敏研究附件；尚未提交。上一轮290项联合回归、本次提交前49项成本相关回归及`bun check`通过，是**基线质量证据**，不是本方案W0–W9已实现的证明。
