# Design Review — Subagent 生命周期可观测性（Design Review Gate）

- **review_mode**: host-native
- **reviewed_inputs**:
  - `docs/design/subagent-lifecycle-observability.md` — SHA-256 `c18dec1a1b9e380fecd6730ab51c22c30175e0e4564b92738ff7f646884290f3`
- **reviewed_revision**: `fff3dd7878bcd7cf53383afae287d44cd91ea51d1a6dd36f143d83ca90421094`（normalized manifest 的 SHA-256）
- **design_author**: `SubagentLifecycleDesign` — gateway/claude-opus-5（xhigh）
- **reviewer**: `LifecycleDesignReview` — Sol XHigh Design Reviewer — gateway/gpt-5.6-sol（xhigh thinking effort）
- **verdict**: **NEEDS_REVISION**
- **authorization_source**: 用户在本会话明确要求 "sol-xhigh-reviewer 发起评审"（2026-08-04）
- **date**: 2026-08-04

---

## 评审结论（verdict）

**NEEDS_REVISION**

> 设计的现状梳理大体可靠，§3.2 对"父代理周期探测"的评价诚实，§4 也比较了 A/B/C 三个方案；P0/P1 方向总体复用 AsyncJobManager、TaskTool semaphore、HubTool 和 AgentRegistry，符合"小而无聊"的增量原则。但当前稿存在多项 Blocking/Major 问题：staleness 仍依赖模型再次调用 wait，诊断帧会被现有 TUI 当作普通 useless poll 隐藏，queued/running 指标语义会把已运行任务误报为排队，queued-timeout 竞态未闭合，运行超时状态/错误契约与代码不符，P3 恢复方案缺少 owner/generation/exactly-once ledger，且四个示例单测及测试路径多数不可执行或未覆盖真实契约。因此不能进入实现。

## 已确认优势（confirmed_strengths）

- §2.1 对 in-process AsyncJobManager、task.maxConcurrency=32 的 per-session semaphore、queued=true、hub wait 的 FIRST-settled race、smart poll ladder、snapshot 字段缺口、AgentRef.lastActivity、stream/tool timeout、soft request budget、maxRuntimeMs=0、queued cancel、spawn failure、missing-yield、delivery retry/dead-letter/retention、abort+salvage 的描述，整体与给定 verified brief 一致。
- §3.2 明确指出 LLM 无时钟纪律、父代理自身也可能阻塞，故 periodic probing 只能作为决策兜底而不能成为检测主机制；这一评价满足原始 ask。
- §4 实际比较了 3 个候选方案，并说明选择方案 A 的复用面与增量阶段；"至少两个替代方案"和"incrementally shippable"形式要求已满足。
- P0/P1 的设置均保留 0 作为单项禁用开关，具备基本的独立回退入口；但上线纪律与质量 stop conditions 仍需补全，见 Finding 11。

---

## Findings（全文，来自 reviewer 输出）

```json
{
  "verdict": "NEEDS_REVISION",
  "summary": "设计的现状梳理大体可靠，§3.2 对“父代理周期探测”的评价诚实，§4 也比较了 A/B/C 三个方案；P0/P1 方向总体复用 AsyncJobManager、TaskTool semaphore、HubTool 和 AgentRegistry，符合“小而无聊”的增量原则。但当前稿存在多项 Blocking/Major 问题：staleness 仍依赖模型再次调用 wait，诊断帧会被现有 TUI 当作普通 useless poll 隐藏，queued/running 指标语义会把已运行任务误报为排队，queued-timeout 竞态未闭合，运行超时状态/错误契约与代码不符，P3 恢复方案缺少 owner/generation/exactly-once ledger，且四个示例单测及测试路径多数不可执行或未覆盖真实契约。因此不能进入实现。",
  "confirmed_strengths": [
    "§2.1 对 in-process AsyncJobManager、task.maxConcurrency=32 的 per-session semaphore、queued=true、hub wait 的 FIRST-settled race、smart poll ladder、snapshot 字段缺口、AgentRef.lastActivity、stream/tool timeout、soft request budget、maxRuntimeMs=0、queued cancel、spawn failure、missing-yield、delivery retry/dead-letter/retention、abort+salvage 的描述，整体与给定 verified brief 一致。",
    "§3.2 明确指出 LLM 无时钟纪律、父代理自身也可能阻塞，故 periodic probing 只能作为决策兜底而不能成为检测主机制；这一评价满足原始 ask。",
    "§4 实际比较了 3 个候选方案，并说明选择方案 A 的复用面与增量阶段；“至少两个替代方案”和“incrementally shippable”形式要求已满足。",
    "P0/P1 的设置均保留 0 作为单项禁用开关，具备基本的独立回退入口；但上线纪律与质量 stop conditions 仍需补全，见 Finding 11。"
  ],
  "findings": [
    {
      "id": 1,
      "severity": "高",
      "axes": ["契约完整性", "内部一致性", "风险与验证"],
      "section": "§4.1、§4.2、§5.2.3、§7.2 Scenario 3",
      "title": "staleness 检测并非 machine-owned，且单次 wait 无法在阈值到达时返回",
      "evidence": [
        "设计在 docs/design/subagent-lifecycle-observability.md:117 称“wait loop 成为 primary detector”，但 §5.2.3 仅在 race 前做一次检查（:432、:454-468）。",
        "现有 HubTool 在 packages/coding-agent/src/tools/hub/index.ts:390-456 先解析 poll window，再由 Promise.race 等待 job/message/window；默认 async.pollWaitDuration=\"smart\"（config/settings-schema.ts:4150-4153），首档为 5s（async/job-manager.ts:16）。",
        "因此一个调用 wait 时尚未 stale 的 job，会先在 5s/10s/... poll window 返回；不会在 2min 或 10min 阈值到达时由该调用返回。设计 Scenario 3 的“观察 2min 后返回”“Wait 在 ~2min 返回”（文档 :1079、:1082）不可由所示控制流实现。",
        "[推导] 对已经 stale 的 job，每次 wait 都会在 race 前立即返回同一诊断；没有 per-job episode/cooldown/ack 状态，可能形成忙循环并阻止正常等待其他 job/message。"
      ],
      "problem": "wall-clock 和 queued timeout 是确定性的，但 P1 staleness/parent-awareness 仍要求 LLM 重新发起 wait，直接违反“检测不能依赖 LLM 记得 poll”。“push in wait loop”与实际 one-shot pre-check 不符。",
      "required_fix": "不能只保留 pre-race check。应选择并写清一个真正 machine-owned 的实现：例如由 AsyncJobManager/每个 job 持有 staleness deadline 并向 owner sink 投递一次结构化诊断，或让一次 hub wait 在内部跨 poll window 持续到 job/message/staleness/显式 timeout，且不得让普通 poll leg先于 staleness deadline终止。必须定义优先级（buffered message、settled job、staleness、普通 poll/abort）、每个 stale episode 的去重/再提醒规则和不干预时的继续等待方式，并用 fake clock 测试“调用 wait 时尚未 stale，随后跨阈值”。"
    },
    {
      "id": 2,
      "severity": "高",
      "axes": ["内部一致性", "风险与验证", "遗漏"],
      "section": "§5.2.3、§5.3.3、§5.4.3",
      "title": "诊断帧会被现有 useless/displacement/TUI 路径吞掉，并绕过 canonical delivery suppression",
      "evidence": [
        "设计仅通过“不设置 useless”宣称诊断可见（docs/...md:538、:726），但现有 isWaitingPollDetails 只检查 jobs 全为 running 且无 cancelled，完全不识别 diagnostic（tools/hub/jobs.ts:45-49）。",
        "ToolExecutionComponent 会把命中该谓词的 hub 结果作为可替换 wait block（modes/components/tool-execution.ts:81-83）；sealed poll renderer 又会删除所有 running rows，并在全删后返回空组件（tools/hub/jobs.ts:530-538）。所以全为 running 的 staleness diagnostic 仍会被移位/渲染为空。",
        "现有 canonical buildJobResult 会对已结算 rows 调 manager.acknowledgeDeliveries，防止 snapshot 与 async-result 重复投递（tools/hub/jobs.ts:183-200）。设计新增 buildDiagnosticJobResult（文档 :490-538）没有调用该逻辑；若显式 ids 同时包含 settled 与 stale-running job，helper 的模型文本也没有 completed section。"
      ],
      "problem": "“not useless”不是只省略一个字段即可成立；现有判定和 renderer 都会按普通 still-running poll 处理。另起一个 result builder 还复制并遗漏了 buildJobResult 的 exactly-once 语义。",
      "required_fix": "扩展 canonical buildJobResult/CoordinationDetails，而不是建立第二个结果构造器；isWaitingPollDetails 必须显式在 diagnostic 存在时返回 false，jobsRenderResult 必须保留并高亮 diagnostic 的 running rows。继续复用 acknowledgeDeliveries、completed/running sections、agent roster 和 owner scoping。新增 job-poll-displacement.test.ts、job-renderer-preview.test.ts 覆盖“诊断不被替换、不渲染为空、settled row 不重复投递、message/settled job 优先级不回归”。"
    },
    {
      "id": 3,
      "severity": "高",
      "axes": ["内部一致性", "事实保真", "风险与验证"],
      "section": "§5.1.2、§5.2.2、§5.2.3、§5.3.3、§6.2、§6.4、§6.5",
      "title": "queuedForMs 的历史值与当前 phase 混用，会把已运行的 task 误诊为“仍在排队”；无首个 progress 的 job 又永远不 stale",
      "evidence": [
        "设计规定 runningStartedAt 一旦存在，queuedForMs 永久等于 runningStartedAt-startTime，同时 running job 也可有 idleForMs（文档 :226-233、:393-418；Test 2 在 :956-966 明确期望二者同时存在）。",
        "所有 async task job 都以 queued:true 注册并在拿到 permit 后 markRunning（task/index.ts:1085-1118、:1211-1213），因此几乎每个正在运行的 task 都会带历史 queuedForMs。",
        "诊断和 TUI 都用“queuedForMs 是否存在”作为首要分支（文档 :500-503、:674-678），会隐藏 idleForMs/agentIdleForMs，并把 stuck-running task 显示为 semaphore saturation。",
        "§6.4 声称 lastProgressAt undefined 时 fallback 到 durationMs（文档 :856），但 §5.2.3 实际代码在无 lastProgressAt 时直接 return false（:463-468）。这使“启动后从未产生首个 progress”的 hung provider/setup path 只剩 1h wall-clock，而无 10min staleness 诊断。",
        "§6.2 称 registry cross-check 可“减少误判”（:830），但触发逻辑只看 job.lastProgressAt；agentIdleForMs 仅在触发后显示 warning（:868）。§6.5 又要求两指标“最终一致”（:872），但两者来自不同事件路径，没有该不变量。"
      ],
      "problem": "同一字段同时承载“当前排队时长”和“历史启动延迟”，而 renderer 以字段存在性推断 phase，语义不闭合；风险章节承诺的 fallback 也未进入详细设计。",
      "required_fix": "将 queuedForMs 定义为仅在 job.queued===true 时存在；若确需保留历史启动延迟，另设 startupDelayMs，而不要复用 queuedForMs。running job 的 idle 基线应为 now-(lastProgressAt ?? runningStartedAt ?? startTime)。diagnostic 应携带明确 per-job reason/phase，而不是靠 snapshot 字段存在性猜测。agentIdleForMs 只能标为辅助上下文，除非定义了真实组合判定；删除“最终一致”验收。分别测试 current queued、已启动且曾排队、无首个 progress、正常持续 progress 四种状态。"
    },
    {
      "id": 4,
      "severity": "高",
      "axes": ["风险与验证", "事实保真"],
      "section": "§5.2.4、§6.3、§7.1 Test 4",
      "title": "queued-startup timeout 的取消/permit 竞态未定义，示例测试也未触达真实 semaphore",
      "evidence": [
        "设计用 AbortSignal.any 合并 runSignal/queuedAbort，再靠 error.message.includes(\"semaphore saturated\") 分类，并声称“优先捕获 timeout error”（文档 :568-609）。AbortSignal.any 是 first-abort-wins；当前 Semaphore 会按 signal.reason reject（task/parallel.ts:137-177、:218-222），该代码没有独立的 timeout cause token、时间顺序或 acquire-resolve 同时发生后的检查。",
        "设计 Test 4 用 new AsyncJobManager({maxRunningJobs:1}) 的直接 manager.register blocker 占位（文档 :1015-1024），但真实排队门禁是 TaskTool 的 session-scoped task.maxConcurrency semaphore。现有契约测试通过同一个 TaskTool、task.maxConcurrency=1 证明第二个 task queued（test/task/task-spawn.test.ts:151-179）。",
        "TaskTool async execute 会立即返回 jobId，而不是等后台 job 失败（task-spawn.test.ts:108-136）；设计却立即检查 result.details.results[0].exitCode/error（文档 :1034-1035），不会观察到后台 timeout。"
      ],
      "problem": "边界时刻可能被错误归因为 timeout/cancel，或 permit 已获准却仍继续/错误释放；没有证明 onSettled 只调用一次、batch aggregate 不悬挂、permit 不泄漏。",
      "required_fix": "用不可混淆的 timeout reason/token 和明确 first-cause 规则；acquire 返回后再次检查 timeout/cancel 状态，若 deadline 已先到且拿到 permit，必须释放且绝不进入 executor；timer 清理放入 finally。测试必须复用 task-spawn.test.ts 的真实 session semaphore：同一 TaskTool、maxConcurrency=1，await 返回的 job.promise 后检查 job.status/errorText/delivery。增加四个竞态测试：permit-before-timeout、timeout-before-permit、cancel-before-timeout、timeout/cancel 与 release 同 tick；全部断言 executor 未误启动、无 permit leak、onSettled exactly once。"
    },
    {
      "id": 5,
      "severity": "高",
      "axes": ["事实保真", "内部一致性", "契约完整性"],
      "section": "§5.4.2、§7.2 Scenario 1、§4.1 P2",
      "title": "runtime timeout 的 AsyncJob 状态、错误文本和可恢复语义与现有代码不符",
      "evidence": [
        "设计称现有错误文本为 “[abort_reason: timeout] Subagent exceeded wall-clock limit (...)” 且 Job 状态为 aborted（文档 :707-716、:1053-1055）。",
        "AsyncJob.status 实际只有 running|completed|failed|cancelled（async/job-manager.ts:30-33）。executor 的进度状态会设为 aborted，错误原因实际为 “Subagent runtime limit exceeded (task.maxRuntimeMs=...)”（task/executor.ts:1163-1164、:2160）；TaskTool 将 singleResult.aborted 视为 resultFailed 并抛 TaskJobError（task/index.ts:1164-1190），最终 AsyncJobManager 将 job.status 设为 failed（async/job-manager.ts:258-261）。",
        "现有 wall-clock 契约测试也断言 runtime-limit reason，而不是设计中的 abort_reason 格式（test/task/executor-wall-clock.test.ts:96-112）。",
        "verified brief 明确 signal/terminate/wall-clock-timeout 是 terminal；只有 budget-stop/keepAlive 可 resume。设计 §4.1 把 cancel、keep-alive/revive resume 并列，容易暗示 timeout/cancel 后仍可原地恢复。"
      ],
      "problem": "把 AgentProgress/SingleResult 的 aborted 与 AsyncJob 的 failed/cancelled 混为一个状态，并引用不存在的“现有错误文本”；实现者按文档会引入未设计的状态枚举迁移。",
      "required_fix": "优先保留现有契约：AsyncJob=failed、AgentProgress/SingleResult.aborted=true、errorText/task-summary 中携带实际 runtime-limit reason；Scenario 1 检查 errorText/abortReason 和 agent:// output，而不是“job status aborted”。若确实要新增 AsyncJob.status=\"aborted\"，必须显式设计 AsyncJob、JobSnapshot、AsyncJobSnapshotItem、所有 render/status switch、cancel semantics、SDK/types/tests 的完整迁移。另明确 timeout/cancel terminal，resume 仅适用于 budget-stop 或 parked/idle live agent。"
    },
    {
      "id": 6,
      "severity": "高",
      "axes": ["事实保真", "向后兼容", "遗漏"],
      "section": "§5.2.3、§5.3.1、§5.4.4、§5.5.4",
      "title": "所示 HubTool/CoordinationDetails 改法会破坏统一 messaging+jobs 契约",
      "evidence": [
        "设计在 #executeWait 开头对 !manager 直接报错（文档 :443-444），并在 §5.5.4 一方面称这是“已有逻辑”，另一方面又称无 manager 环境“不报错”（:795-803），文内自相矛盾。",
        "实际统一 wait 在无 manager/无 running jobs 时保留 pure message wait 或 nothing-to-wait 语义（tools/hub/index.ts:371-383），不能因为新增 job staleness 而使 SDK/messaging-only host 失败。",
        "设计的 CoordinationDetails 片段把 op 收窄为 wait|cancel|jobs、jobs 改为必填，并把 cancel status 写为 aborted|not_found（文档 :623-626）。实际类型支持完整 HubOp，jobs 可选，CancelStatus 为 cancelled|not_found|already_completed（tools/hub/types.ts:16-19、:55、:80-90）。§5.4.4 的 already_settled（文档 :736）也不是现有名称。"
      ],
      "problem": "这不是 additive extension；按文档实现会破坏 send/inbox/list/message-only wait、现有 renderer/parser 和 cancel contract。",
      "required_fix": "只在实际 CoordinationDetails 上新增 optional diagnostic；保留 op:HubOp、jobs?:JobSnapshot[]、现有 messaging 字段和 CancelStatus。#executeWait 的 staleness 分支必须仅在 manager 且有 watched running jobs 时启用；无 manager 继续走 message wait。统一术语为 cancelled/already_completed，或另行设计并迁移全链路。增加 messaging-only、SDK no-manager、from-only wait 回归测试。"
    },
    {
      "id": 7,
      "severity": "高",
      "axes": ["事实保真", "canonical owner", "契约完整性", "遗漏"],
      "section": "§1.1、§3.1、§6.6、§8 Phase 3",
      "title": "parked-parent 恢复把“通知丢失”误写为“结果永久丢失”，且 artifact scan 缺少 durable delivery ledger、owner/generation 和 exactly-once 语义",
      "evidence": [
        "设计多处称 5min 后 result lost/永久丢失，且 agent:// 只在 retention window 内可读（文档 :84、:878-883）。",
        "task executor 已把 raw output 写入 <artifactsDir>/<id>.md（task/executor.ts:2124-2127）；agent:// 从 session lineage 和 AgentRegistry retained sessionFile 的 artifacts dir 读取这些文件（internal-urls/agent-protocol.ts:4-7、:37-44、:73；registry-helpers.ts:36-46）。model-facing async contract 也明确 job row 5min 后仍可用 agent:///history://（prompts/tools/task-async-contract.md:1）。因此通常丢的是自动完成通知/内存 job row，不是已落盘 output/transcript 本身。",
        "resumeDeliveries 仅删除 suppressed set 中的 id，并要求当前 #jobs 仍有 completed/failed row（async/job-manager.ts:392-400）；它并不能恢复已经 dead-lettered、evicted 或跨进程的 delivery。",
        "AgentSession 有 asyncDeliveryEpoch 防止旧 job-id 结果注入新会话代际（session/agent-session.ts:507-515），并在 session transition 中 cancel/evict/clear 旧 owner 结果（:1651-1680）。设计的“scan artifacts dir + re-enqueue”没有 ownerId、session/epoch、job generation、settledAt、ack/dead-letter 状态，无法区分已交付、已由 hub snapshot 消费、真正 dead-letter、同名旧 job 或其他 owner。",
        "Phase 3 又新增 <jobId>.result.json（文档 :1196-1198），与既有 .md output、.jsonl transcript、AsyncJob row 并列，形成未定义 canonical owner 的第二结果持久化引擎。"
      ],
      "problem": "artifact 目录扫描无法实现安全的 exactly-once replay，可能重复投递或把上一会话/其他 owner 的旧结果注入当前 transcript；同时核心目标把 P3 recovery 列为必须结果，但 §8 又标 optional。",
      "required_fix": "二选一并在 §1/§8 一致化：若 parked-parent replay 非本次必交付，删除“核心目标/永久丢失”表述，明确 P0-P2 只保证 live-owner 自动通知和 output/history 可追溯；若保留为核心，则设计一个 canonical、durable、owner-scoped delivery receipt/dead-letter ledger，至少包含 owner session identity/epoch、job generation/id、agentId、settledAt、payload reference、delivery/ack state，复用现有 .md/.jsonl 作为内容源而非复制结果。明确 park/revive hook、跨进程行为、retention/privacy/cleanup、hub snapshot ack 与 replay exactly-once，并添加 park→complete→revive、already-delivered、already-acknowledged、owner-id reuse、process restart 测试。"
    },
    {
      "id": 8,
      "severity": "高",
      "axes": ["事实保真", "证据纪律", "风险覆盖"],
      "section": "§1.3、§4.1、§5.1.3、§5.5、§6.1、§6.3、§9.3",
      "title": "默认值被错误描述为向后兼容/有数据支持；若干 current-capability 声明为假",
      "evidence": [
        "把 task.maxRuntimeMs 默认从 0 改为 3600000，并新增默认自动失败的 queued timeout，显然改变老 session 未显式配置时的运行语义；但文档称“不改变生命周期语义”“向后兼容”“migration none required (additive)”（文档 :31、:120、:171、:755-760）。这可以是有意的默认行为迁移，但不是 additive/backward-compatible。",
        "“1 hour 覆盖 99% 正常任务”（文档 :270、:815）、“120s 排队意味着前方有 stuck jobs；正常 busy 不会触发”（:841）、“parked parent 少见/时机窗口窄”（:883）都没有来源，属于 [未验证假设]。文档自己在 :1252 承认缺少 subagent p95 数据。",
        "§4.1 称 “reportProgress already stamps progress”（文档 :110），但现有 AsyncJobManager.reportProgress 仅保存 latestDetails/调用 onProgress，没有时间戳（async/job-manager.ts:221-224）；时间戳正是本设计要新增的行为。",
        "§6.1 称 eval bridge 已支持 caller 的 per-call maxRuntimeMs override，并拟扩展为 task agent:{name,maxRuntimeMs}（文档 :814）。实际 eval agent schema没有 maxRuntimeMs 且桥接层固定传 maxRuntimeMs:0（eval/agent-bridge.ts:23-26、:157-159）；task agent 目前是 string，TaskItem/TaskParams 也没有该字段（task/types.ts:114-145、:286-299）。该 mitigation 未出现在详细设计、phase、prompt 或测试中。"
      ],
      "problem": "默认 auto-abort/auto-fail 是高影响行为变更，却用无数据的“99%/正常 busy”作保证；风险缓解又依赖不存在的 per-call API。",
      "required_fix": "把 3600000/120000/600000 明确标为 [拟议验收目标]，把 99%、rare、healthy-minute 等改为 [未验证假设] 或删除；补充基线运行时/排队分布与 rollout gate。把 §5.5 改为“schema migration 无需数据转换，但存在 intentional default behavior change”。per-agent override 要么从 mitigation 删除，要么完整设计为现有 TaskItem/TaskParams 的 additive top-level/per-item 字段（而不是改变 agent:string 形状），覆盖 batch/flat schema、prompt、executor forwarding 和测试。将“reportProgress already stamps”改为“现有 callback 是新增 timestamp 的 canonical hook”。"
    },
    {
      "id": 9,
      "severity": "高",
      "axes": ["风险与验证", "事实保真"],
      "section": "§7.1、§7.2、§7.3",
      "title": "四个示例单测及回归命令不足以作为实现证据，多个测试本身不可运行或只测 plumbing",
      "evidence": [
        "Test 1 在 manager.register 的 callback 同步首段访问尚未初始化的 const jobId（文档 :898-924）。AsyncJobManager 会在 this.#jobs.set 之前立即调用 run（async/job-manager.ts:233-266），因此存在 TDZ/查不到 job 的问题；且它先 reportProgress 后 markRunning，不符合真实 task 启动顺序。",
        "Test 2 通过 manager[\"#jobs\"] 注入（文档 :960）；#jobs 是 ECMAScript private field（async/job-manager.ts:135），字符串下标无法访问。",
        "Test 3 只手工 backdate 一个已经 stale 的 job（文档 :991-1004），无法发现 Finding 1 的核心 bug——wait 运行期间跨阈值；Bun.sleep(Number.POSITIVE_INFINITY)（:986）也不如可控 deferred 稳定。",
        "Test 4 的错误见 Finding 4。",
        "§7.1 指定 async/__tests__/...、tools/hub/__tests__/...，§7.3 又执行 packages/coding-agent/src/**/__tests__/（文档 :893、:1124-1126）；本仓库 canonical tests 位于 packages/coding-agent/test，例如 async-job-manager.test.ts、tools/hub-wait.test.ts、task/task-spawn.test.ts、job-renderer-preview.test.ts、job-poll-displacement.test.ts。",
        "Scenario 1/Phase 0 要人工等待 1h/2h（文档 :818、:1146），而已有 executor-wall-clock.test.ts 用 50ms/30ms 覆盖同一 observable contract（:96-112、:119-122），长时间人工等待不是可重复门禁。"
      ],
      "problem": "当前四个“unit tests”不能证明新增 observable contract；其中至少 Test 2 不可实现，Test 4 不触达目标路径，Test 3 会让错误的 pre-check-only 实现通过。",
      "required_fix": "把验证计划映射到现有测试所有者：async-job-manager.test.ts（timestamp/markRunning，用 deferred/fake clock）、tools/hub-wait.test.ts（跨阈值、FIRST/message priority、owner scoping、no-manager）、job-poll-displacement.test.ts 与 job-renderer-preview.test.ts（diagnostic 可见）、task/task-spawn.test.ts（真实 semaphore timeout/races）、task/executor-wall-clock.test.ts（默认/短阈值、TaskTool→AsyncJob status）。测试必须断言 observable state/result/delivery，而非私有 map 或源码文本。回归命令改为实际 test files/目录，并加入 Settings 默认迁移加载测试。"
    },
    {
      "id": 10,
      "severity": "中",
      "axes": ["内部一致性", "遗漏"],
      "section": "§1.2、§1.3、§5.3.2-§5.3.3、§5.5.3、§6.5、§8",
      "title": "字段/phase 命名及用户可见 surface 未统一",
      "evidence": [
        "§1.2 把 snapshot 字段列为 queuedForMs、idleForMs、lastProgressAt（文档 :24），但 §5.1.2/§8 实际 snapshot 字段是 queuedForMs、idleForMs、agentIdleForMs（:209-215、:1158）；lastProgressAt 是 AsyncJob 内部字段。",
        "§1.3 写 watchdog 可选 P3（文档 :30），§4/§8 则为 P4（:114、:1207）。",
        "TUI 示例把 stale 阈值硬编码为 600000（文档 :677），会在用户把 async.stalenessThresholdMs 改为 5min/20min 时显示错误；而实际 renderer 已使用 formatStatusIcon/theme/truncate helpers，新增裸 emoji/自建 Text row 也不符合现有 renderer 结构。",
        "Gallery fixture 写成 tools/hub/__tests__/fixtures.ts (if exists)（文档 :766-768），实际 hub_jobs fixture 位于 packages/coding-agent/src/cli/gallery-fixtures/agentic.ts:364-416。",
        "直接用户 surface `/jobs` 使用独立 AsyncJobSnapshotItem，只含 id/type/status/label/startTime（session/agent-session-types.ts:50-56；modes/controllers/command-controller.ts:486-517、:1424-1432），设计只覆盖 hub tool renderer；若“让人类理解状态”包含 `/jobs`，该路径仍不可见。",
        "task-async-contract.md:1 仍是模型关于 async delivery/retention 的 canonical 摘要；设计只列 hub.md，没有说明 queued auto-fail、diagnostic、terminal timeout 与 no-poll 关系。"
      ],
      "problem": "实现者无法从文档确定 lastProgressAt 是否属于 wire snapshot、watchdog 是 P3 还是 P4，以及配置阈值如何进入 renderer；真实 gallery、slash command 和 task prompt 所有者遗漏。",
      "required_fix": "统一字段表和 phase 编号；renderer 使用 diagnostic.thresholdMs/per-row reason 与现有 theme helpers，不硬编码 600000。把 gallery 路径改为 cli/gallery-fixtures/agentic.ts，并列出 renderer snapshot tests。明确 `/jobs` 是否在 scope：若是，扩展 AsyncJobSnapshotItem/getAsyncJobSnapshot/renderJobLine；若否，在非目标中说明。同步 prompts/tools/task-async-contract.md，避免一份 prompt 说“不需 poll”而另一份暗示 periodic wait 是主要检测。"
    },
    {
      "id": 11,
      "severity": "中",
      "axes": ["风险与验证", "A/B discipline", "证据纪律"],
      "section": "§6、§8、§9.2-§9.3",
      "title": "上线观测只有“记录触发频率”，缺少可判定的质量 stop conditions、去重 ledger 与单变量回滚计划",
      "evidence": [
        "文档仅在 §9.2 写“记录 staleness/timeout 触发频率”（docs/...md:1246），并以“稳定 2 weeks 后决定 P4”（:1222）作为决策点；没有 denominator、false-positive proxy、cohort、版本/阈值指纹或停止阈值。",
        "P0 同时启用 maxRuntime default 和 queued timeout，若故障率变化无法归因；staleness diagnostic 又可能重复返回，同一 job 可被多次计数。",
        "文档保留三个 0-disable 开关，这是积极基础，但没有说明分开 canary/rollback、配置变更区间、控制/处理组可比性，亦无 non-overlap interval ledger，无法用线上数据回答 §9.3 的 1h vs 2h、5min vs 20min。"
      ],
      "problem": "默认值尚无基线数据，却计划直接默认开启；仅计数触发次数会双计 stale episode，也不能区分真实 hang、合法慢任务和配置导致的 queue failure。",
      "required_fix": "为每项功能独立 rollout：先 shadow/diagnostic，再单项 canary，再默认开启；事件至少记录 job/owner generation、phase、configured threshold、observed duration、trigger episode id、后续 outcome/intervention，按每 job 每 episode 去重。定义控制/处理的非重叠时间或稳定 cohort、配置版本指纹、质量 stop conditions（例如 queued-timeout rate、diagnostic 后无干预仍正常完成率、timeout 后有有效 salvage 比率、错误投递/重复投递为零）以及每个 setting 的独立 rollback。不要用单一“2 weeks”替代验收标准。"
    },
    {
      "id": 12,
      "severity": "低",
      "axes": ["canonical owner", "遗漏"],
      "section": "§4.1 方案 B、§8 Phase 4",
      "title": "应明确现有 Advisor Watchdog 不是 subagent 生命周期终止器",
      "evidence": [
        "仓库已有 advisor/watchdog.ts，但其职责是加载 WATCHDOG/advisor prompt/config；advisor/transcript-recorder.ts:37-39 明确 advisor 是 passive reviewer。verified brief 也明确该子系统不能终止 subagent。",
        "设计使用“watchdog”一词并另拟 SubagentWatchdog，但未写明不得复用 advisor owner。"
      ],
      "problem": "名称相近，实施时可能把生命周期控制放进被动 review subsystem，造成错误 canonical owner。",
      "required_fix": "在方案 B/P4 加一句：现有 advisor/watchdog.ts 仅为被动审阅配置/提示，不是候选执行 owner；若未来实现，owner 必须仍在 async/task lifecycle，并通过 AsyncJobManager cancel/abort+salvage canonical path 执行。"
    }
  ],
  "must_change_to_clear_needs_revision": [
    "解决 Findings 1-3：给出真正 machine-owned 的 staleness 触发机制、诊断优先级/去重规则、canonical build/TUI integration，以及无首 progress/current queue phase 的精确定义。",
    "解决 Finding 4：补齐 queued-timeout 的 cause precedence、permit/cancel race、exactly-once settlement 和无泄漏测试。",
    "解决 Findings 5-6：按现有代码统一 AsyncJob/AgentProgress 状态、实际 timeout 文本、HubOp/CoordinationDetails/CancelStatus 和 no-manager messaging semantics。",
    "解决 Finding 7：要么把 parked-parent replay 从本次核心交付移出并纠正“结果永久丢失”，要么提供 owner+generation+ack 的 durable delivery ledger 与完整 revival/exactly-once 验证；不得只扫描 artifacts 或新增第二结果真源。",
    "解决 Findings 8-9：把默认值标为拟议目标而非已验证事实，删除/补证 99% 等断言；重写四个测试到仓库真实 test owners，并覆盖跨阈值、TUI、race、owner scoping、delivery suppression。",
    "解决 Findings 10-11 的一致性与 rollout 门禁：统一字段/phase/path/prompt surface，定义可复现的指标、去重、质量 stop conditions 和独立 rollback。",
    "所有高严重度 finding 必须关闭；中严重度中的字段/phase/path 错误及 rollout stop conditions 也必须在同一修订中关闭，方可转为 PASS 或 PASS_WITH_NOTES。"
  ],
  "review_scope": "已完整读取 docs/design/subagent-lifecycle-observability.md 全文（工具显示 1262 行，9 节），并只读 spot-check 了上述代码与测试 anchors；未修改任何文件，未运行测试（本任务为设计门禁，证据来自文档与工作树源码契约）。",
  "reviewer_identity": "LifecycleDesignReview — Sol XHigh Design Reviewer",
  "model": "gateway/gpt-5.6-sol（xhigh thinking effort）"
}
```

---

## Gate 结论

**NEEDS_REVISION** → 回到 design-brainstorm：由同一 author（`SubagentLifecycleDesign` / gateway/claude-opus-5）修订设计文档，关闭全部高严重度 findings 及指定的中严重度问题后，重新跑本 Gate（同一 reviewer）。

---

## 第二轮复审（2026-08-04，修订版 e4f03df3…）

- **reviewed_input**: `docs/design/subagent-lifecycle-observability.md`（1551 行）— SHA-256 `e4f03df30bc2bdcfdd3b8c8b319263f67bf29aa5982653e477841070f01c165a`
- **reviewed_revision**: `e61f46882da24e1b0fa5f2d3a3ad14b8854c0e13b58cbac19c17a6d3d7615f59`
- **reviewer**: `LifecycleDesignReview` — gateway/gpt-5.6-sol（xhigh）
- **verdict**: **NEEDS_REVISION**（第二轮）

**闭合状态**：F3/F7/F8/F12 基本关闭；F5 大体关闭。**未闭合**：F1、F2、F4、F6、F9、F11（全部为高/中严重度，详见下）。

### 未闭合 findings（第二轮全文）

**F1（高，§5.2.1、§8 Phase 1）— AsyncJobManager staleness timer 配置、注册顺序、episode 与 delivery seam 未到可实现程度**
1. 文档用 `this.#settings.get("async.stalenessThresholdMs")`（:431、:452、:481），但 AsyncJobManagerOptions 只有 onJobComplete/maxRunningJobs/retentionMs，constructor 不持有 Settings（job-manager.ts:64-77、:159-162）。未定义 threshold 是构造级/owner 级/register 级，也未定义 settings 运行时变更如何重排 timer。
2. :412-413 在 queued job 上 `#startStalenessMonitor`，其内部先 `this.#jobs.get(jobId)`（:427-429）；当前 register 在 run IIFE 启动后才 `this.#jobs.set(id, job)`（job-manager.ts:233-266），修订片段未声明移动该语句 → queued monitor no-op；同步 markRunning/reportProgress 也可能在入表前 no-op。
3. :508、:514 使用不存在的 `#resolveOwnerSink` 与 `sink.deliverStalenessEvent`；现有 canonical sink 是函数 `AsyncJobDeliverySink(jobId,text,job?)`（registerDeliverySink/#resolveDeliverySink，job-manager.ts:64、:454-457、:751-753）。未定义 typed lifecycle-event union、sink 接口或 AgentSession registration contract。
4. episode key 用 `jobId:epochMinute`（:424-425、:471-474），“progress 清除旧 episode”只在 prose（:647-648），代码没有 delete；timer 回调后不从 #stalenessTimers 删除；settle/cancel/evict/dispose/job-id reuse cleanup 未定义。Set 会增长，同一分钟复用 job id 会错误抑制新 generation。
5. delivery 在 episode set 写入后 fire-and-forget；sink 失败只 log（:506-515），无现有 completion delivery 的 retry/backoff → 瞬时失败即永久丢失本 episode。
**Required fix**：明确唯一 seam（AsyncJobRegisterOptions 传入冻结 staleness policy/deadline 或 owner-scoped threshold provider + typed AsyncJobLifecycleEvent union；若 manager 持 Settings 须写 constructor/SDK wiring、owner 差异、动态订阅语义）；job 先入 #jobs 再启动 run/timer（或 monitor 直接持 job 引用）；episode 用 per-job generation/last-progress generation，投递成功后标记、progress 时 reset、settle/cancel/evict/dispose 时清理；结构化事件复用/显式扩展 canonical retryable delivery queue，不调用不存在的 sink method。

**F2（高，§5.2.3、§5.3.2、§7 Scenario 3）— 主动 staleness 事件没有 waitable race leg；hub wait 仍不能跨阈值返回；proactive delivery 与 wait 消费缺 exactly-once 仲裁**
1. 文档 priority 为 buffered message > settled job > staleness > poll > abort（:584-589），但 racePromises 中没有 staleness promise；仍只 `Promise.race(racePromises)`（:617-631），其他 leg 结束后才 popPendingStalenessEvent。
2. owner sink 语义是把 completion 放入 YieldQueue，idle flush 后作 follow-up turn 注入（session/async-job-delivery.ts:1-9；agent-session.ts:1211-1217）；向 pending/yield queue 写入不会 resolve 当前正在执行的 hub tool call。
3. 默认 smart poll 首档 5s（settings-schema.ts:4150-4153；job-manager.ts:16），Scenario 3“保持等待约 2min 返回”（:1315-1318）不成立；即使 timeoutMs=0，当前片段也没有 event promise 唤醒 race。
4. priority 列表写“FIRST wins”又写固定优先级，但 Promise.race 只按时间先后；无 post-wake arbitration；job 已完成后 pending queue 残留 stale event 未处理。
5. 同一事件可能被 proactive owner follow-up 与 hub wait 的 popPendingStalenessEvent 双消费；无 watch/ack/suppression 规则，无法证明不重复不丢失。
6. 主动投递的 staleness event 未定义 model-facing custom message/template/renderer；复用 async-result 会把非终态诊断混入“完成结果”语义并可能错误触发现有 yield invalidation。
**Required fix**：增加真实 waitable channel（如 `AsyncJobManager.subscribeLifecycleEvents(ownerId, watchedIds)` 返回 promise+unsubscribe，加入 race；或 AgentSession 暴露可等待的 staleness bus）；任一 leg 唤醒后做显式 post-wake arbitration（buffered message → settled jobs → 仍有效的 stale event → poll window → abort）；一个 stale episode 只能由 active hub waiter 或 proactive YieldQueue 之一消费，复用 watch/ack generation，消费时 job 已 settled 则丢弃；无 active waiter 路径定义独立 nonterminal lifecycle diagnostic message/template；补测试：无 wait 时主动 follow-up、wait 跨阈值、同 tick completion/stale 与 message/stale、wait 消费后不 auto-inject、auto-inject 后 wait 不重复。

**F4（高，§5.2.4、§6.3、§7 Test 4）— queued-timeout 伪代码自捕获、非法状态字段、漏 onSettled、permit owner 问题**
1. post-acquire timeout 分支先 progress.status="failed"、onSettled(true)，再 throw new TaskJobError（:697-712），该 throw 在同一 try 内被下面 catch 捕获；TaskJobError 无 QUEUED_TIMEOUT_TOKEN → 进入 Other abort 分支，timeout 分类被覆盖。
2. Other abort 写 progress.aborted=true（:733-736），但 AgentProgress 只有 status 字段（pending|running|completed|failed|aborted，task/types.ts:396-402），没有 aborted 字段 → 无法类型检查。
3. cancel-before-timeout 的 Other abort 分支没有 progress.status="aborted" 也没有 onSettled(true)，重现 batch aggregate 永久 running 问题；文档测试却声称 onSettled exactly once。
4. releasePermit 直接 semaphore.release()（:669-673、:707）；现有 canonical release 是 `this.#releaseSpawnSemaphore()`（task/index.ts:640-642、:1095-1098），绕过会破坏 mid-session task.maxConcurrency 调整语义。
5. post-acquire 只检查 queuedAbortController.signal 而非 combinedSignal.reason；cancel 与 timeout 同 tick 不能证明 first cause。
6. 未说明 acquire 抛出的非-timeout reason 是否保留原始 abort reason；catch 统一改写可能丢失 signal/terminate 语义。
**Required fix**：acquire 独立 try/catch 或 catch 首行 `if (error instanceof TaskJobError) throw error`；acquire 成功后立即 semaphoreHeld=true，所有释放只走 releasePermit→#releaseSpawnSemaphore()；用 combinedSignal.reason 或显式 cause record 判定 first cause，timeout token 只映射 queued-timeout，其他 reason 保留原语义；cancel 路径恢复 progress.status="aborted"、onSettled(true)；所有路径 exactly once；测试观察 batch aggregate 最终 settled 与后续第三个 spawn 可获 permit。

**F6（高，§5.2.3、§5.3.1-§5.3.4、§5.5.4）— Hub/no-manager/type/result/render contracts 仍非 additive**
1. canonical buildJobResult signature 是 (session, manager, op, jobs, CancelOutcome[], agents=[]) 且自动 acknowledge settled rows（jobs.ts:183-200）；修订版改 completedIds + 仅 id/status 的 cancelledResults、移除 agents、要求手工传 completedIds（:804-865），executeWait 示例传空 completedIds（:633-642）→ 显式 ids 含 settled/running 时漏 ack；CancelOutcome.message 与 jobless roster 未保留。
2. 修订 isWaitingPollDetails 用 `(!details.jobs || details.jobs.every(...))`（:879-885），jobs 缺失时为 true → message-only result 也可能被当 useless/displaceable；当前实现要求 jobs 非空数组（jobs.ts:45-49）。
3. no-manager 分支注释保留 message-only wait 却 return buildJobResult(…空 jobs)（:600-606）；正确行为是 executeMessageWait / nothingToWaitForResult（index.ts:371-383）。
4. return 片段未恢复普通 all-running wait 的 useless:true → 普通 poll frames 不再可 displacement。
5. TUI 示例使用仓库不存在的 VStack、theme.error/theme.warning，Component 返回函数中 return null（:971-980）；实际 Theme 用 theme.fg/styledSymbol；示例绕过 jobsRenderResult 的 renderTreeList/truncate/sanitize/cache/shimmer。
6. snapshotJobs 新代码访问 latest.queued/runningStartedAt/lastProgressAt/agentId，但未扩展 TrackedJobLike（jobs.ts:133-141）→ 联合类型访问报错。
**Required fix**：保持 buildJobResult signature/行为，只追加 optional diagnostic（或末尾 options object）；继续自动 ack、保留 CancelOutcome.message、agents roster、普通 useless 判定；isWaiting 要求 jobs 非空数组且无 waited/message/diagnostic，message-only 永不 displacement；no-manager 原样走 executeMessageWait/nothingToWaitForResult；直接在现有 jobsRenderResult/renderTreeList row 按 diagnostic staleIds 改色并禁止 sealed filtering，不新建平行 renderer，用实际 theme/formatStatusIcon/truncate APIs；扩展 TrackedJobLike 可选 liveness/agentId 字段或对 manager.getJob 返回值显式 narrowing；列出 wait/cancel/jobs 所有 buildJobResult callsites 的 additive 迁移。

**F9（高，§7.1、§7.3）— 测试矩阵路径与 Settings 示例不可执行**
1. 工作树真实路径：test/async-job-manager.test.ts、test/tools/hub-wait.test.ts、test/job-poll-displacement.test.ts、test/job-renderer-preview.test.ts、test/task/task-spawn.test.ts、test/task/executor-wall-clock.test.ts；修订文档写成 test/async/…、test/tools/hub/…（:1218、:1359-1363）→ 不存在，建立第二套目录 convention。
2. Settings 默认测试用 new Settings()（:1385-1398），但 constructor private；仓库用 Settings.isolated()/getDefault（settings.ts:377、:448-451）。
3. manager-level staleness-detection test 声称覆盖 message/settled priority，但该 priority 属于 HubTool/AgentSession event integration；只 mock AsyncJobManager callback 无法验证 wait 唤醒、winner arbitration、YieldQueue 重复注入。
4. §7 Test 3 仍假设 manager event callback 足以让 hub wait 在阈值处返回（即 F2 未设计的 seam）。
5. 缺：delivery sink 临时失败/retry、job 在 pending diagnostic 消费前 settled、progress reset episode、job-id reuse/eviction cleanup、active waiter vs proactive follow-up exactly-once。
**Required fix**：路径改真实 owner，新 contract 才建符合 flat layout 的新文件；默认设置测试用 Settings.isolated()/getDefault；timer/episode 单测放 async-job-manager.test.ts，wake-up/priority/exactly-once 放 tools/hub-wait.test.ts，renderer/displacement 放现有 job-renderer-preview/job-poll-displacement.test.ts，queued/runtime 放现有 task owners；补端到端断言：timer 到点 resolve in-flight wait、同 tick winner、wait 与 auto-inject 不重复、settled stale event 丢弃、delivery retry、progress reset、evict/reuse cleanup；每条 bun test 命令指向真实路径，smoke scenario 实际运行改后的 hub wait 路径。

**F11（中，§8 Phase 0-2、§9.3）— rollout/A-B 激活机制、cohort ledger 与 stop metrics 不可执行或方向错误**
1. Phase 0 直接把 schema default 改为 1h/2min 又要求先 shadow、再 10% sessions canary（:1406-1417）；没有 mode setting/feature flag/稳定 cohort 分配，未说明本地 CLI 如何实现 10% sessions；静态 default 一改即 default-on。
2. 5%/80%/20%/10% stop thresholds（:1424-1426、:1454-1456）未标 [拟议验收目标]，无 baseline/denominator/观察窗口/最小样本。
3. runtime timeout 后“LLM 立即 resume/retry”作 false-positive proxy（:1422）混淆不可能的原位 resume 与 retry；salvage_success_rate<80% 衡量 salvage path 健康，不衡量 timeout 是否误杀。
4. “LLM cancel_rate after diagnostic <10%”作诊断无效 stop condition（:1456）会错误激励更多 cancel；正确干预还可能是 inspect/history、raise concurrency、wait、调 threshold 或自然完成。
5. Phase 2 的 non-overlap cohort 仍留在未解决问题（:1471、:1541），无 cohort key、feature/threshold fingerprint、时间区间 ledger、重复 episode 归因。
6. 三项 feature 可各自 0-disable 独立 rollback（已改善），但未说明 A/B 只改一个 lever；同时 rollout 使因果归因失效。
**Required fix**：Phase 工作内容加真实 activation contract（每 feature mode=off|shadow|on 或 release-channel/explicit opt-in；定义稳定 cohort key 与隐私边界；不做远程 cohort 则删“10% sessions/A-B”改可执行 opt-in canary）；所有百分比标 [拟议验收目标]，定义 baseline/分母/窗口/最小样本/观测来源；分开定义 (a) timeout false-positive proxy (b) salvage health (c) diagnostic actionable-response (d) false-cancel，不以 cancel rate 下限作质量目标；建立 non-overlap interval ledger（feature、版本、threshold、cohort、episode generation、start/end，同一 job episode 仅计一次）；A/B 每次只改一个 lever，control/treatment 同 workload/time window/owner eligibility，写 per-feature rollback order 与质量 stop condition。

### 清关条件（第二轮汇总，reviewer 2026-08-04）

- F1/F2/F4/F6/F9 高严重度项全部闭合；F11 rollout/cohort/metric 契约改为可执行。
- 附加：§7 Scenario 1 的 AsyncJob.errorText 裸等值改为「SingleResult.abortReason 等于/包含 runtime-limit reason，AsyncJob.errorText 包含该 reason 且可带 task-result envelope/hint」。
- F3/F7/F8/F12 已闭合；F5 除该字段层级表述外已闭合；F10 gallery/prompt/P4 命名已闭合，剩余 renderer 问题已纳入 F6。

---

## 第三轮复审（2026-08-04，修订版 c8e3fcca…）

- **reviewed_input**: `docs/design/subagent-lifecycle-observability.md`（2217 行）— SHA-256 `c8e3fcca12a3de1a355cc4913af35213c798d0c5604a018cc9127634964aba63`
- **reviewed_revision**: `bced70ba7126648635c11a2146259c5ad50664abf84d010aa735e5349c2d1c38`
- **reviewer**: `LifecycleDesignReview` — gateway/gpt-5.6-sol（xhigh）
- **verdict**: **NEEDS_REVISION**（第三轮）

**正向闭合/改善**：字段互斥与 idle fallback、默认 threshold 标签、候选方案比较、parked-parent 非目标、watchdog owner、现有测试路径清单、runtime errorText contains 表述——均可接受。

**未闭合（7 高 + 2 中）**：

**F1（高）P1 只有 machine-owned detection，没有 machine-owned parent awareness**。§1.2/§4.1 承诺“向 owner sink 主动投递，不依赖 LLM poll”，但 §5.2.1.5 明确“无 subscriber 时事件丢弃”（:629），subscriber 只在 HubTool#executeWait 内创建（:780-783）——父代理没恰好处于 wait 时诊断丢失；timer 触发后无 pending event，也不重排；新 #lifecycleSubscribers 绕过 canonical owner delivery（registerDeliverySink → AgentSession YieldQueue，含 retry/backoff、session epoch/stale 规则）。→ 检测时写入 manager-owned、按 owner+job-incarnation+episode-generation 去重的 pending record，不得因无 active wait 丢弃；复用/显式扩展 canonical owner delivery（typed nonterminal lifecycle sink + 独立 custom message，遵守 epoch/stale/retry）；active waiter 与 proactive follow-up 原子 claim 同一 pending episode（wait 成功则不再 auto-inject，无 waiter 则 sink 注入，message/settled 抢先时 episode 留待后续 claim）；progress/settle/cancel 使 pending event invalid；测试覆盖 no-wait live owner 自动收到、wait/auto-inject exactly-once、抢先后不丢。

**F2（高）lifecycle subscriber、job identity 与 cleanup 契约有确定性错误**：ownerId 为 string 但 executeWait 传 string|undefined（unowned SDK 路径无法订阅）；#emitLifecycleEvent 声称 only-one 却 for-of + splice（可能 resolve 多个 waiter 且跳过相邻元素）；“job-id reuse 靠 generation 失配”论证为假（旧 job 与新 job 都从 generation=0 起，可相等——generation 是 progress episode 不是 incarnation）；settle/cancel/finally 清 timer 的示例调用不存在的 completeJob/evictJob，且 dispose 写成同步 void 而实际是 async Promise<boolean>；dispose 直接 clear subscribers 不 settle 已返回的 promise → timeoutMs=0 的 hub wait 可永久挂起；onSettled 被标为现有 RegisterOptions 字段（实际只有 id/ownerId/agentId/onProgress/queued）。→ 用稳定唯一 job incarnation（单调 token/UUID/对象身份）+ progress episode generation，timer/event/metric key 都带 incarnation；明确 unowned owner key 或在类型上收窄；subscriber 存储用可原子 claim 的记录，一次 event 只选一个 waiter，不得边 for-of 边 splice；在当前 register completion/catch/finally、cancel、cancelAll、#evictJob、async dispose 真实 owner 中清理；dispose 保持 Promise<boolean> 并 settle 所有 pending subscriptions；删不存在的 anchors；补 cancel-ignoring-run、dispose-with-active-wait、ID reuse、两并发 waiter 测试。

**F3（高）staleness race leg 未按现有 Hub wait seam 集成**：调用不存在的 messaging.wait/poll/#buildMessageResult/#resolvePollWindow/#getSmartPollWindow（真实是 drainPendingInbox + IrcBus.global().wait + messageResult + free resolvePollWindow）；message leg 从 bus dequeued 的消息被 arbitration 忽略（只再 poll）→ 消息丢失（现有代码特意 await busLeg 防此 race）；timeoutMs=0 的无限 wait 契约被当成 smart window；runningJobs=0 有 messaging 时应走 pure message wait，文档改造成 Promise.race([]) 改变 peer-liveness 行为；no-manager+no-messaging 应返回 nothingToWaitForResult 而非 errorResult；cleanup 只 unsubscribe staleness，未 clear poll timer/abort bus waiter/移除 signal listener → 晚到的 bus loser 吞下一条消息；abort leg 用 reject 绕过 post-wake arbitration。→ 在当前 #executeWait 原代码上最小 additive patch（保留 pre-drain、visibleJobs/no-running 分支、IrcBus busAbort sentinel、windowMs>0 才建 timer、watchJobs/progress timer、smart ladder reset、全部 loser cleanup）；lifecycle promise 只作新增 race leg；winner 带已 dequeue message 先返回再 drain；timeoutMs=0 不建 poll timer；明确 abort 语义并使 prose/code 一致；测试真实 bus（message 不丢、late loser 不吞下一条、0 跨阈值、manager+zero jobs、same-tick 全组合）。

**F4（高）queued-timeout canonical release 与 same-tick first-cause 仍未闭合**：post-acquire 分支仍直接 semaphore.release()（:1036、:1047）与“所有 release 改 #releaseSpawnSemaphore()”（:1098）自相矛盾；acquire 成功后 semaphoreHeld 仍 false 导致 releasePermit 无法在 race 分支使用；post-acquire 先查 queuedAbortController 再查 runSignal，同 tick 都 aborted 时即使 runSignal 先发生也误报 timeout（未用 combinedSignal.reason）；permit leak 验证只断言第三个 job 仍 queued（泄漏时同样 queued，不能证明可 acquire/complete）。→ await acquire 返回后立即 semaphoreHeld=true；所有退出统一 releasePermit→#releaseSpawnSemaphore()；post-acquire 只检查 combinedSignal.reason 的 unique token 保持 first cause；单一 settle guard 证明 onSettled exactly once；race 测试让 blocker 最终释放并断言第三个 spawn 实际 markRunning/完成，用受控 deferred/fake clock 造四种 interleaving，断言 executor 调用次数/permit 计数/onSettled 次数。

**F5（高）buildJobResult/CoordinationDetails/TUI/TrackedJobLike 仍基于错误 baseline**：canonical signature 是 (session, manager, op, jobs, cancelOutcomes, agents=[]) 且自动 ack settled rows；文档“preserved”却插入 completedIds/cancelledResults 并把第 5 参改义，只在 completedIds 非空时 ack（重开显式 ids 混合场景漏 ack）；构造 details.completed 但 CoordinationDetails 无该字段；把 cancelled 改成可带 message（新增 wire contract 非 unchanged）；renderer 示例签名/theme API（uiTheme.fg(color,text) 参数顺序与 color key 均错）与真实不符；TrackedJobLike 被移到 types.ts export 但实际 owner 是 jobs.ts local interface（不移除 local shadow 则 snapshotJobs 看不到新字段）。→ 以六参 signature 为基线只在 agents 后追加 diagnostic；CoordinationDetails 只加 optional diagnostic（不新增 completed、不改 cancelled）；isWaiting 加 `if (d.diagnostic) return false`；在 actual jobsRenderResult 中把 sealed filtering 条件改为 `... && !details.diagnostic`，renderItem 内用 uiTheme.fg 追加 liveness，保留 cache/shimmer/truncate/preview；直接扩展 jobs.ts local TrackedJobLike（或迁移并删 local 定义）；列出实际 wait/cancel/jobs callsites 参数不错位。

**F6（高）测试大面积不可编译/不可观察**：`new AsyncJobManager({ settings })` 无此选项；register type 只能是 "bash"|"task"（测试用 "test"）；订阅 ownerId 与注册 owner 不匹配（event key 为 "" 永不 resolve）；afterEach 同步 dispose()（实际 async）；hub.execute 首参 toolCallId、二参须含 op；TaskTool constructor private（须 await TaskTool.create(session)，按现有 mock convention）；Settings.getDefault() 不存在（真实 getDefault(path)/Settings.isolated()，defaults 应扩展 settings-manager.test.ts）；imports 路径不符合包内 alias；waitDuration<200ms 依赖真实 100ms timer 易抖，message/stale 只测时间先后不测同时 available 的 priority；queued 测试未证明 permit 释放。→ 复用现有 imports/factories/fixtures；`new AsyncJobManager({onJobComplete...})`、合法 type、ownerId 匹配、`await manager.dispose()`、`tool.execute("call_1",{op:"wait",...})`、`await TaskTool.create(session)`；defaults 扩展 test/settings-manager.test.ts；用 fake clock/受控 deferred，构造“同一 arbitration snapshot 两个结果都 available”测 priority；每个测试断言 observable contract（no-wait owner follow-up、wait 跨阈值、消息不丢、episode 不重复、settle invalidation、第三 spawn 实际完成、executor 调用次数、onSettled 恰一次）。

**F7（高）off|shadow|on activation 未进入 schema/control flow，与“默认启用”矛盾；A/B ledger 不可执行**：§5.1.3/§5.5.2 写非零 schema defaults 自动应用，§8 却新增 timeoutMode default="off"——详细 schema 没有 mode，task spawn 始终按 threshold 启用，代码即 on、prose 即 off；shadow 语义未定义（runtime/queued 是终止型 timer，shadow 须“检测记录但不 abort/fail”，executor/§5.2.4 无 shadow branch）；P0 验收是默认非零 wall-clock，若 mode default=off 则 effective runtime 仍 disabled；ledger 只有 optional cohortKey/featureVersion/recordedOnce，无 assignment/experiment id/interval boundaries；本地无远程 cohort 却仍写“单变量 A/B”；metrics 无 canonical 记录路径，“same agentId retry+success”不能证明 same task（需 task fingerprint），“自然完成”既计 actionable 又计 false-positive。→ 在 §5.1.3 定义 mode schema、final defaults 与 effective policy table（off/shadow/on 对 runtime/queued/staleness 分别做什么），在 executor preflight/queue timer/stalenessPolicy 真实 seam 显示 mode 判断；若 shadow 成本不值就删掉改明确 opt-in threshold canary；写清 canary 阶段与最终 default-on 是两个 release state，P0 最终 effective default 必须非零且 on；A/B 若保留需稳定且隐私合规的 assignment/experiment ledger（job incarnation+episode+experiment 唯一 key），每次只改一个 lever；本地无法可靠分组则改称 sequential opt-in experiment；指定 metrics canonical owner/存储/opt-in，加 task fingerprint，重写互不矛盾的 false-positive/actionable/false-cancel 指标与 stop rule。

**F8（中）AgentProgress.status 与 SingleResult.aborted 仍混写**：AgentProgress 无 aborted boolean（已有 status union 含 "aborted"）；runtime timeout 时 TaskTool 明确设 progress.status="aborted"（不是 failed），AsyncJobManager 因 TaskJobError 把 AsyncJob.status 设 failed 是另一层；§7 Scenario 1 仍写“二选一”。→ 统一：queued-startup timeout → AgentProgress.status="failed"、AsyncJob.status="failed"；runtime timeout → SingleResult.aborted=true、AgentProgress.status="aborted"、外层 AsyncJob.status="failed"；不存在 AgentProgress.aborted 字段；测试分别断言对应层，不用“或”。

**F9（中）`/jobs` surface 未决**：§9.2 仍写“若 /jobs 在 scope…否则在非目标说明”，但 §1.3 未列为非目标、也没有扩展设计——条件本身是未决 handoff；AsyncJobSnapshotItem 只 Pick id/type/status/label/startTime，slash command 只显示 duration/status，人类看不到 queued/idle；末尾“无 TBD”声明与该未决条件矛盾。→ 明确二选一：扩展 AsyncJobSnapshotItem 与 command-controller renderer 并加 fixture/test；或 §1.3 明确 `/jobs` 为非目标并说明其状态仍粗粒度。不得把 scope 决定留给实现者。

### 清关条件（第三轮，reviewer 2026-08-04）

1. staleness episode 无 active wait 时仍可靠到达 live owner；active wait 与 proactive follow-up 原子 claim、exactly-once，不另起 drop-on-no-subscriber 通知引擎。
2. 修正 incarnation/generation、subscriber one-shot、ownerId、cancel/evict/async-dispose cleanup。
3. 在真实 Hub wait 代码上 additive 加入 event leg，保留 message value、timeoutMs=0、message-only/nothing-to-wait、bus/timer/signal cleanup 与明确 priority。
4. queued post-acquire 全部走 canonical releasePermit，用 combinedSignal.reason 保持 first cause；补真实 permit/onSettled 验证。
5. buildJobResult 以当前六参 signature 为 baseline 只追加 diagnostic；修正 CoordinationDetails、ack、renderer、TrackedJobLike owner。
6. 所有 §7 示例改成可编译的真实 API，测试防守 observable races，不以 comment/仍 queued 代替证据。
7. mode schema/control-flow/shadow/default 迁移闭合；A/B 改可执行且隐私合规的 assignment/ledger/metrics，或诚实降级为 sequential opt-in experiment。
8. 统一 AsyncJob/AgentProgress/SingleResult 状态语义；决定并记录 `/jobs` scope。

---

## 第四轮复审（2026-08-04，替换 author 全新重写版 v2）

- **reviewed_input**: `docs/design/subagent-lifecycle-observability-v2.md`（1296 行）— SHA-256 `ec413156b430c955e43e0012b2c269a0f4ab60cfb633ed653ff28c215370d9ea`
- **reviewed_revision**: `5d243294e9d514bfda741a9f9fc7fc8f58c538173260b0ca1c6b0577b969771c`
- **author**: `DesignRewriteV2`（replacement author，gateway/claude-opus-5，全新重写）
- **reviewer**: `LifecycleDesignReview` — gateway/gpt-5.6-sol（xhigh）
- **verdict**: **NEEDS_REVISION**（第四轮）

**已闭合/基本闭合**：queued timeout unique token、post-acquire first-cause、canonical release；runtime 状态三层语义；`/jobs` scope 决定；方案对比；真实 test owner 名称；no-manager 意图。

**未闭合（7 高 + 1 中）**：

**F1（高）canonical lifecycle delivery seam 与 wait/auto-inject exactly-once 状态机未决定（显式 placeholder）**：§5.2.4 明写“扩展现有 registerDeliverySink 或新增 registerLifecycleSink，需选择一个 seam”（:467-469），:486-494 用不存在的 #deliveryQueue/#drainDeliveryQueue 伪代码；#onStalenessThreshold 先写 pending 再立即投递，active waiter 未 claim 前 proactive delivery 已可入队——无原子 transition 保证 episode 只进入 WAIT_CLAIMED 或 OWNER_QUEUED 之一（可双投）；现有 canonical completion engine（#deliveries/#inFlightDeliveries/#enqueueDelivery/#ensureDeliveryLoop/registerDeliverySink，job-manager.ts:130-146、:656-775）suppression 以 jobId 为 key，staleness 需要 episode-key 级 ack/suppression 且不得误抑制 completion；reportProgress 递增 generation 不删旧 pending episode 也不作废已排队 delivery（真正恢复 progress 后仍可能收到过期 stale follow-up）；#cleanupJob 只删 pending map 不删 delivery queue 中的 event；改写 registerDeliverySink 为单参数 union 会破坏现有 AgentSession 三参 callback (jobId,text,job)（agent-session.ts:1208-1217）。→ 选定一个 canonical seam 不得留“或”（推荐：保留 public completion sink 兼容 + 新增 typed lifecycle sink，两种 payload 共享一个私有 generic delivery scheduler；或 union 化并列出全部 callsite 迁移）；定义 episode 状态机与唯一 key：PENDING → WAIT_CLAIMED 或 OWNER_QUEUED → DELIVERED/ACKED，claim/enqueue 在 manager 内原子；progress/markRunning/settle/cancel 作废 pending+queued+in-flight；retry/backoff/dead-letter 与 completion 同一 engine，episode 级 suppression 不复用裸 jobId；写出 AgentSession registration、独立 nonterminal custom message builder、YieldQueue key/isStale；补 no-wait injection、sink 暂时失败重试、wait-vs-auto 原子 claim、progress/settle invalidation 测试。

**F2（高）staleness policy 放错在 process-global manager getter；mode 未接线；incarnation key 不唯一；register 丢现有不变量**：manager 由 SDK 首个 top-level session 创建、subagents 继承 process singleton（sdk.ts:1681-1695），TaskTool 不创建 manager；单 mutable provider 会 last-writer-wins 读错 session settings；#stalenessMode 被调用但无字段声明/configure 方法；threshold 在 timer 启动与事件触发时各读一次，settings 中途改变时等待时长与 event.threshold 不一致；incarnation 用 Symbol 但 pending key 用 incarnation.toString()（两 Symbol("job-x") 可碰撞且不可序列化）；register 重写用 options.id ?? randomUUID 绕过 #resolveJobId/disposed/capacity guard/suppressed-delivery reset（job-manager.ts:188-205），重复 preferred id 可覆盖 live job；markRunning 不递增 progressGeneration（queued→running phase transition 无法失配）；off/shadow 也先创建 pending episode（shadow 触发后 timer 不重排、pending 阻止同 generation 再触发，后续切 on 该 stuck job 不 delivery）。→ 冻结 {thresholdMs, mode} 放入 AsyncJobRegisterOptions/AsyncJob，TaskTool 按 owner session 每次 spawn 传入；global manager 不持 session getter；用 manager 单调 number/UUID string incarnationId（wire/episode key 必须唯一可序列化）；register 上 surgical patch 保留全部现有 guard；markRunning 递增 phase generation 并作废 queued timer/episode；mode 在 timer 启动前决定（off 不建 timer；shadow 记录独立 observation 不占 future delivery pending；on 进 delivery 状态机）；阈值冻结并随 episode 携带；timer unref；补多 owner 不同 settings、ID reuse、shadow→on、新 progress invalidation 测试。

**F3（高）hub wait 伪代码在普通 poll/abort 路径挂死；subscription/claim 是 optional 未定义 API；diagnostic 参数错位**：lifecyclePromise 无条件入 race 但不保存 winner，post-wake 在 message/settled 未命中后无条件 await lifecyclePromise——若 winner 是 poll/abort 则永久不返回；subscribeLifecycleEvents?./claimPendingDiagnostic?. 用 optional chaining 等于允许核心能力缺失；prose 说 subscribe 返回 promise+unsubscribe，代码却自己建 promise 把 resolve 传入、把 method 返回值当 unsubscribe（契约矛盾）；diagnostic 调用 buildJobResult(..., [], {diagnostic}) 把 object 传给第 6 参 AgentActivitySnapshot[]（第 7 参才是 options）；episode 是 StalenessEpisode{jobId,incarnation,generation,ownerId,threshold} 而非 CoordinationDetails.diagnostic{staleIds,thresholdMs,episodes[...]}，payload 不匹配；高优先级 message/settled 获胜后谁重新 enqueue pending episode 未定义。→ 定义非 optional API：subscribeLifecycleEvents(ownerId, watchedIds): {promise: Promise<TaggedEvent>; unsubscribe():void} 与 claimPendingDiagnostic(episodeId, claimant): Diagnostic|undefined（ownerless 用 typed sentinel）；Promise.race 返回 tagged winner，只有 winner.kind==="lifecycle" 才读 event；任何 winner 后做 non-blocking tryClaim，绝不 await 未 settled loser；正确第 7 参调用 buildJobResult(session,manager,"wait",freshSnapshot,[],[],{diagnostic}) 并先把 episode 转完整 diagnostic；高优先级 winner 时 unsubscribe 后 manager 把仍 valid episode 交 owner queue；补 poll/abort winner、method 缺失编译失败、ownerless、参数位置、高优先级 winner 后 event 不丢测试。

**F4（高）静默删除已约定的 JobSnapshot liveness contract；hub jobs 仍无法区分 queued/stuck；diagnostic 数据模型不闭合**：v2:28 明确“不新增 agentIdleForMs/queuedForMs”，也无 startupDelayMs/idleForMs——原 acceptance 要求这些字段跨章节一致，属未获批准的 scope reduction；只有 executeWait 会 claim diagnostic，hub jobs 无读取 pending diagnostic 设计（阈值前/shadow/queued timeout 显式 0 时 jobs 仍只显示 running+duration）；CoordinationDetails 需要 episode phase/idleMs/agentId 但 StalenessEpisode 没有、AsyncJobLifecycleEvent 也没有，无转换函数，renderer 用 ep.idleMs 时数据不存在；phase union 含 queued 但 timer 只由 markRunning/reportProgress 启动——queued phase 不可产生；setting 改名为 task.queuedTimeoutMs 与既定 task.queuedStartupTimeoutMs 不一致。→ 恢复 JobSnapshot additive 字段（queuedForMs/startupDelayMs/idleForMs，agentIdleForMs 去留明确），snapshotJobs 计算、hub jobs/wait 与现有 TUI row 可见（坚持删除需用户明确批准，不得在 replacement 中静默缩减）；定义唯一完整 DiagnosticEpisode 类型（episodeId/jobId/incarnationId/generation/phase/observedMs/thresholdMs/agentId），pending/event/claim/CoordinationDetails 同 shape 或显式 mapper；queued phase 由 queued timer 支撑或从 union/metrics 删除；用既定 task.queuedStartupTimeoutMs 或把 rename 列为显式 contract decision。

**F5（高）buildJobResult 示例回归 wire/useless 行为；TUI 实现 seam 未写**：details 无条件写 cancelled:[]/agents:[]（当前 canonical 仅非空时添加，jobs.ts:248-267，否则 disjoint wire shape 变化）；return 漏 isWaitingPollDetails→useless:true（普通 all-running poll 不再可 displacement）；“No background jobs”fallback/completed/running sections/CancelOutcome.message 被 /*...*/ 略过，additive 却无 surgical diff；jobsRenderResult 无任何修改代码/落点（现有 renderer 会在 sealed poll 过滤所有 running rows，jobs.ts:530-540，有 renderTreeList/shimmer/cache pipeline）；diagnostic options 用 Array<any> 未复用 §5.1.2 类型。→ 给出基于当前 builder 的最小 diff：第 7 参追加 typed options、details 保持 conditional spreads、保留自动 settled ack/CancelOutcome 文本/empty fallback/useless；options 类型直接引用 CoordinationDetails["diagnostic"]；写出 actual jobsRenderResult seam（sealed 过滤加 && !result.details?.diagnostic；renderItem 内用 uiTheme/formatStatusIcon/renderTreeList 追加 queued/idle/stale 信息，保留 shimmer/cache/truncate/preview）；测试验证 sealed renderer 仍显示 diagnostic running row、普通 poll 仍被过滤/标 useless、empty arrays 不新增 wire 字段。

**F6（高）最终 default 与 rollout 未决定；10%/20% canary 与 A/B 无 assignment ledger；P0 shadow 无实现**：stalenessMode default 定 shadow 但 Phase 3 又写“on 或保持 shadow，Phase 4 再 on”而 Phase 4 只是 optional；§4 称 P2 activation default on + A/B，§9.3 仍把 A/B vs sequential opt-in 列为实现前 open question；Phase 1 直接把 schema default 改非零却称 10% sessions canary（无 feature flag/cohort 时 schema default 影响 100% 未配置 session）；Phase 3 写 20% sessions 但无稳定 assignment；风险缓解写“P0 shadow→P1 canary→P2 default-on”但 runtime/queued 无 mode 只有 enforce 或 threshold=0，P0 shadow 不可执行；canary 比例/1周/2周未标 [拟议验收目标] 且无分母/最小样本/工作负载可比性/non-overlap interval；false-cancel=0 实际是 queued timeout permit 未释放（应叫 permit-leak rate）；telemetry/metrics owner/存储/隐私未定义。→ 选择并写死最终 schema default 与 release 序列（本地无可靠 cohort 则删 10%/20%/A/B 改 manual opt-in/sequential canary；保留 A/B 必须给 stable assignment/experiment ledger/privacy boundary）；P0 若需 shadow 必须设计实际 observe-without-abort 分支否则删除“P0 shadow”先 threshold=0 opt-in 再独立 commit 改 default；所有比例/窗口标 [拟议验收目标] 定义分母/最小样本/停止条件；false-cancel 改名 permit-leak/settlement failure；每个 setting 独立 rollback 顺序写清，Phase 3 结束 mode 唯一。

**F7（高）验证矩阵缺 proactive delivery/atomic claim/global-manager 隔离测试**：no-active-wait follow-up 属 AgentSession/YieldQueue owner，应含 agent-session-async-delivery.test.ts 与 async-yield-queue.test.ts；无 delivery sink 失败→retry、wait claim 与 in-flight auto-delivery 竞争、message/settled 抢先后 pending 再投、progress/settle 后 queued lifecycle event 作废测试；无 process-global manager 两 owner 不同 settings 隔离测试；无 poll/abort winner 测试（§5.3.1 无条件 await lifecyclePromise 的 hang 会漏过）；无 shadow→on/off→on/threshold change/incarnation reuse 测试；无 register 重排后 disposed/capacity/#resolveJobId/onProgress-error invariants 回归；Phase 2 shadow 验收要求 pending map 有 entry 会固化错误 mode 状态机。→ 扩充 agent-session-async-delivery/async-yield-queue（no-wait follow-up、epoch stale、retry、exactly-once）；hub-wait（tagged winners、poll/abort 不 hang）；manager（two-owner policy isolation、delivery state transitions）；progress/markRunning/settle/cancel invalidation、shadow/off transitions、ID reuse、register 原 invariants；builder/TUI 同时守旧契约与新 diagnostic；exactly-once 测试观察两侧（wait result 计数 + injected custom message 计数 + pending/queued/in-flight 状态）。

**F8（中）[已核实] anchors 不准确/不可复现**：§1.3 artifact URL 写成 agent://<id>.md（canonical 是 agent://<id>，.md 只是磁盘文件名，agent-protocol.ts:7-13、:53-57）；SOFT_REQUEST_BUDGET 来源标 settings-schema.ts:4756-4781（实际 owner 是 task/executor.ts:93-96）；maxConcurrency anchor 从 4686 起标成 4699-4714；register signature 标 job-manager.ts:219-283（当前 176-266）；queued/markRunning anchors 混用 task/index.ts:1211-1213（实际 queued:true）与 :1117（markRunning）；buildJobResult 标 jobs.ts:170-223（signature 从 :183 起）；故障场景 2 引用不在 Reviewed Inputs 的 session artifact（无法复现）；文档顶部 DRAFT 但结尾称“10 项闭合”且仍含“需选择/伪代码/或/Open Questions”。→ 修正 agent URL 与 soft-budget owner；锚点尽量 file+symbol 而非裸行号；不可复现的 session 事实标 [未验证假设] 或删除；seam/default/open questions 闭合前保持 DRAFT 并删除“10 项已闭合”。

### 清关条件（第四轮，reviewer 2026-08-04）

1. 选择唯一 lifecycle delivery seam，给出 manager/AgentSession/YieldQueue 完整 typed contract；同一 generic retry engine、episode 级原子 claim/ack/invalidation。
2. 改 per-job frozen staleness policy；修 mode 接线、incarnation identity、register 原有 guard/id resolution、shadow 状态机。
3. 定义非 optional subscribe/claim API；修 poll/abort hang、tagged winner、diagnostic 转换与 buildJobResult 第 7 参。
4. 恢复原 acceptance 的 JobSnapshot liveness fields（或取得用户明确 scope 批准），统一 DiagnosticEpisode shape、queued phase 与 setting 命名。
5. buildJobResult/TUI 给出真实 surgical diff，保留 conditional wire、automatic ack、empty fallback、ordinary useless 与现有 renderer pipeline。
6. 最终 mode/default/rollout 唯一；10%/20% A/B 若无 assignment/ledger 则改 sequential opt-in；metrics/隐私闭合。
7. 验证加入 AgentSession/YieldQueue/retry/atomic claim/two-owner policy/poll-abort/register invariants；修正事实 anchors。

---

## 第五轮复审（2026-08-04，F1–F8 修订版 d69a0ea9…）

- **reviewed_input**: `docs/design/subagent-lifecycle-observability-v2.md`（1788 行）— SHA-256 `d69a0ea9713d11183f6712f433f9b2be7ae33d4b054c847593160c7ee18373ff`
- **reviewed_revision**: `4fd365843b012f03d8056a27e085208f1a965cc0897e65c900d1bf977c67be2e`
- **reviewer**: `LifecycleDesignReview` — gateway/gpt-5.6-sol（xhigh）
- **verdict**: **NEEDS_REVISION**（第五轮）

**已改善**：UUID incarnation；per-job policy 方向；tagged winner 消除无条件 await loser；JobSnapshot 字段/setting 名称恢复；off|on 简化；A/B/10%/20% 删除；agent URL 与 soft-budget source 修正。

**未闭合（7 高 + 1 中）**：

**F1（高）核心 P0 queued-startup timeout 详细设计在文件中缺失；§5.2.4 是悬空引用**：v2:328 称由“§5.2.4”实现、§6.3 称竞态已关闭，但 heading 检索只有 §5.2.1/§5.2.3，全文无 QUEUED_TIMEOUT_TOKEN 实现；现有内容只有 settings/风险/测试草图，无 #registerSpawnJob 的 combined signal、unique reason、acquire catch、post-acquire check、semaphoreHeld 时序、canonical releasePermit、timer cleanup、settlement guard。→ 恢复完整 §5.2.4（基于真实 #registerSpawnJob 的 surgical diff：QUEUED_TIMEOUT_TOKEN、AbortSignal.any、acquire 独立 try/catch、combinedSignal.reason first-cause、acquire 后立即 semaphoreHeld=true、post-acquire double-check、全部 release 经 releasePermit→#releaseSpawnSemaphore、timer finally cleanup、progress/onSettled exactly-once）；明确 timeout/cancel 状态与 TaskJobError 文本、queuedTimeoutMs=0 行为、后续 executor 是否进入；连接真实 TaskTool settings 读取与 RegisterOptions.stalenessPolicy 传递；补四种 interleaving 可执行断言。

**F2（高）generic delivery engine 不可实现：定义冲突、现有字段/API 未迁移、retry/in-flight/suppression 不完整**：两个同名 #enqueueLifecycleDelivery（一个无条件 PENDING→OWNER_QUEUED 入队，一个先查 subscriber 再 wait-claimed/owner-queued）行为冲突；新 AsyncJobDelivery 只留 ownerId/event/attempt/nextAttemptAt，但现有 manager 依赖 delivery.jobId/text/lastError/promise（getDeliveryState/acknowledge/resume/filter/drain/suppression/dead-letter/retry 日志），未逐一迁移会全线编译失败；#ensureDeliveryLoop 用未定义 batch 折叠现有 void scheduler/#runDeliveryLoop/#deliverDelivery，未保留 jitter/in-flight promise/filtered drain/next-retry/delivery-state；completion #enqueueDelivery 不再检查 isDeliverySuppressed(jobId)（破坏 watch/ack 防重复 async-result 契约），lifecycle 又需 episode 级 key，未定义两者并存；#invalidateJobEpisodes 对 readonly #deliveries 做 filter 赋值（job-manager.ts:134），且不处理 #inFlightDeliveries 与已入 YieldQueue 的 entry；状态图含 IN_FLIGHT 但 state union 无 in-flight；sink 成功只设 delivered、dead-letter 设 acked 但不删 map；WAIT_CLAIMED→DELIVERED、DELIVERED→ACKED 无方法，状态机会泄漏；AsyncJobDeliverySink 从三参改单 event union 会破坏 AgentSession 及大量 callsites，文档只示意一处无完整 clean cutover 清单。→ 保留单一 #enqueueLifecycleDelivery；设计兼容现有 engine 的 discriminated delivery record（deliveryKey、jobId、ownerId、event、attempt/nextAttemptAt/lastError/promise，completion key 与 episode key 分开）；修改现有 #filterDeliveries/#filterInFlightDeliveries/getDeliveryState/acknowledge/resume/drain/#runDeliveryLoop/#deliverDelivery 而非另写 batch loop，保留 500ms→30s+jitter/in-flight/suppression；invalidation 用原地 splice/tombstone；sink 调用前后及 YieldQueue flush 再校验 episode validity；定义 dead-letter/delivered/acked 后的删除与 wait ack；列出全部 sink/onJobComplete callsites 与 tests 的 typed-union 迁移（或保留 completion public API、新增 lifecycle sink 共享同一私有 scheduler）。

**F3（高）active-wait claim 自相矛盾，diagnostic 永远返回不了；固定 priority 未实现**：active subscriber 匹配时先把 episode 设 wait-claimed 再 resolve，Hub 随后 claimPendingDiagnostic 只接受 state==="pending" → 每个 subscription 唤醒的 episode 都返回 undefined；subscription 路径未写 claimedBy，Hub 用 ownerId 作 claimant，同 owner 两个 wait 无法区分；tagged race 修了 poll-hang，但 message>settled>lifecycle 的 post-wake arbitration 未实现（只 switch temporal winner；lifecycle 先 resolve 后同 tick message/settled 不会被 drain/re-snapshot；message/job winner 时 episode 已被预标 wait-claimed，返回后不重新入 owner queue，通知永久丢失）；wait 返回 diagnostic 后无 WAIT_CLAIMED→DELIVERED/ACKED transition；unsubscribe 无 release reservation→owner queue 逻辑；abort listener cleanup 只 removeBusAbortListener，不移除直接 onAbort listener，signal reason 被改 generic。→ 引入 unique subscriptionId/reservation token：emit 只 reserveForWait(episode,token) 并 resolve；Hub 在 message/settled recheck 后用 consumeReservation(episodeId,token) 取 diagnostic；高优先级结果胜出或 unsubscribe 未 consume 时 manager 原子 release reservation 转 OWNER_QUEUED；任一 leg 唤醒先处理已 dequeue bus message → drain buffered inbox → re-snapshot settled jobs → consume lifecycle reservation → poll/abort；wait result 构建成功后显式 ack/delete episode；清理全部 listener 并保留 signal.reason；测试：lifecycle 与 message/job 同 tick、两个同 owner waits、winner 返回后 auto-inject fallback、state 最终删除。

**F4（高）AgentSession/YieldQueue 示例不符合真实 API**：调用不存在的 this.#yieldQueue.enqueue({...})（真实 this.yieldQueue、enqueue(kind, entry)，yield-queue.ts:45-63；agent-session.ts:429、:1080）；YieldQueue 必须先 register(kind,{isStale,build})，未注册 lifecycle-diagnostic dispatcher/LifecycleDiagnosticEntry/batch builder；completion 分支直接 enqueue raw result 绕过当前 #deliverAsyncJobResult 的 disposed/suppression 检查、epoch snapshot、oversize artifact spill/preview formatting（agent-session.ts:1742-1755）——completion 契约回归；lifecycle stale 只说 epoch，progress/settle invalidation 后已入队 entry 仍会注入；manager 在 sink 返回后标 delivered，但 YieldQueue 可能之后因 epoch/invalid episode 丢弃——未定义何时 ACKED/删除 pending record；新 prompt template 无 buildLifecycleDiagnosticBatchMessage/CustomMessage details type，未说明 nonterminal customType 不会触发现有 async-result yield invalidation。→ completion event 继续走现有 #deliverAsyncJobResult(manager,jobId,text,job)；新建 typed LifecycleDiagnosticEntry + buildLifecycleDiagnosticBatchMessage；AgentSession 注册 yieldQueue.register("lifecycle-diagnostic",{isStale,build})、yieldQueue.enqueue("lifecycle-diagnostic",entry)；isStale 同时查 session epoch 与 manager.isDiagnosticValid(episodeId,incarnationId,generation)；明确 flush 成功/丢弃后的 manager ack/delete；声明独立 customType 不触发 ASYNC_RESULT_MESSAGE_TYPE 的 yield supersession；补真实 AgentSession/YieldQueue tests（format/spill 不回归、lifecycle batching、epoch drop、progress invalidation、ack exactly once）。

**F5（高）buildJobResult/TUI/snapshotJobs 仍含确定的类型/API 错误，且 model-facing hub jobs/wait 无任何 liveness/diagnostic 文本**：useless 写到 details.useless（CoordinationDetails 无该字段，useless 是 AgentToolResult 顶层属性，jobs.ts:271-276）；details.cancelled 放完整 CancelOutcome[]（当前 wire 只投影 {id,status}）；early empty fallback 只查 jobs/agents，cancelOutcomes 非空但 jobs 空时丢取消文本；running model-facing lines 仍只有 id/type/label，无 queuedForMs/idleForMs 也无 diagnostic warning/intervention；TUI 示例用不存在 API（options.sealed/options.shimmer、uiTheme.fg.yellow、uiTheme.text、formatStatusIcon(job.status)、return null、错误 renderTreeList signature；真实 RenderResultOptions 只有 expanded/isPartial/spinnerFrame，当前 jobs renderer 在既有 renderTreeList/shimmer/cache Component 中修改，jobs.ts:513-715）；snapshotJobs 写 `const latest = 'latestDetails' in j ? j : j`（从不调 session.asyncJobManager?.getJob），用 AgentRegistry.global 而非 session.agentRegistry；idleForMs/queuedForMs 未限制 status="running"（settled queued-timeout row 会继续增长）；resolvedModel 只取 progress[0] 回归按 job id 匹配 batch progress 的逻辑。→ 在现有 builder 上追加 diagnostic 文本段与 running-row liveness；顶层返回 `...(isWaitingPollDetails(details)?{useless:true}:{})`；cancelled 继续 map{id,status}；fallback 以 lines.length 判断；以实际 jobsRenderResult 为基线（`!options.isPartial && isPollCall && agents.length===0 && !diagnostic` 才过滤），renderItem 内用 uiTheme.fg("warning",...) 追加字段，保留 formatStatusIcon/statusToIcon/renderTreeList/cache/shimmer；snapshotJobs 保留 current=session.asyncJobManager?.getJob(j.id)/latest=current??j 与现有 resolvedModel 算法；liveness 只对 running 相应 phase 输出；agent cross-check 用 session.agentRegistry 且仅 informational；将 §7 两条 placeholder 改为真实 content/rendered-lines 断言。

**F6（高）per-job policy 只停留在字段，RegisterOptions 与 TaskTool 真实 callsite 未设计；off 激活条件被 threshold 默认值绕过**：AsyncJob 有 stalenessPolicy 但未扩展 AsyncJobRegisterOptions（当前接口无该字段，job-manager.ts:81-106）；Activation contract 称 TaskTool 从 owner settings 读取冻结，但全文无 #registerSpawnJob 传 {thresholdMs,mode} 的代码；stalenessPolicy 类型仍含 shadow（settings schema 已删 shadow 只允许 off|on，内部不一致）；Phase 1 写 mode="on" 或 thresholdMs>0（任一启用）——threshold 默认 600000，mode=off 会被 threshold>0 绕过，与 §5.2.1 mode==='off' 不启动 timer、opt-in contract 冲突；settle/cancel invalidation 只在 run completion 的 #cleanupJob 调用，当前 cancel/cancelAll 立即改 status 并 schedule eviction（job-manager.ts:275-282、:412-417），未同步 invalidate（run 忽略 abort 时 stale delivery 仍可在 cancel 后排队）；Phase 3 声称保留 queued phase timer 引用 §5.2.1，实际 #start 只由 markRunning/reportProgress 调用——queued timer 没有设计。→ 扩展 AsyncJobRegisterOptions.stalenessPolicy；在真实 #registerSpawnJob 读 settings 一次：mode/status…stalenessPolicy = mode==='on' && threshold>0 ? {mode,thresholdMs} : undefined 并传入；类型删 shadow；Phase activation 改 AND；cancel/cancelAll/#evictJob/dispose 同步 stop timer + invalidate lifecycle records/deliveries；queued phase 若 Phase 3 optional 则从 P1 核心 DiagnosticEpisode union/验收标 optional，或补 register queued timer + markRunning generation reset 的设计与测试。

**F7（高）验证计划主要是空测试/无效断言**：13 个 it() 仅一行 // Test: 注释无 setup/assertion（v2:1406-1415、:1424-1437、:1476-1477、:1486-1495、:1504-1513）；第一个 manager test 只断言 progressCalled（timer/episode/delivery 完全不存在也通过），job 有 ownerId 但未注册 owner sink，onJobComplete 收不到 owned event，用真实 2s sleep 且未 dispose manager；queued test 用 queued.details.results[0].jobId 取 async job（真实 async TaskTool 返回时 results 为空，job id 在 details.async.jobId/progress 或 content，task/index.ts:929-980），且第一 blocker 持 permit 10s 第三 spawn 不可能立即 running（timeout-before-acquire 本来就没持 permit）；runtime scenario 用 results[0].jobId/agentId、session.artifactsDir/fs.exists 等非现有 contract（现有 executor-wall-clock owner 直接测 executor handle）；staleness scenario 调用不存在的 HubTool.create(session)（真实 new HubTool(session)），用 500ms/10s real timers，直接 manager.register policy 绕过 TaskTool settings wiring；回归命令未声明 cwd（repo root 跑 bun test test/... 路径不存在，应 cwd=packages/coding-agent 或完整路径）；无可执行 test 证明 generic delivery 现有 API 迁移、wait reservation release、YieldQueue dispatcher/ack、builder top-level useless、model-facing diagnostic text、actual TUI lines。→ 删除所有空 it，换成完整 deterministic tests（可列 Given/When/Then 但不得交付空体）；复用现有 helpers/API（new HubTool、真实 TaskTool async details.async.jobId/progress、现有 executor-wall-clock harness、await manager.dispose、fake timers/deferred）；queued permit 测试控制 blocker 释放断言第三 spawn 最终 markRunning/completes，另造 post-acquire same-tick 场景；delivery test 同时观察 wait result、custom-message count、episode/queue/in-flight 最终状态；builder/TUI 断言实际文本/渲染行；修正 cwd 与真实 owner。

**F8（中）指标 owner/含义与剩余 anchors**：runtime false-positive proxy 定义为 salvage-success（只衡量落盘 path 健康，不能判断 1h 是否误杀）；staleness false-positive proxy 写成 salvage-success>80%（staleness diagnostic 不 abort、通常无 salvage，指标不成立）；Metrics owner 仅 AsyncJobManager+TaskTool，但 Diagnostic-Actionable 含 inspect/history/adjust/wait（manager/task 看不到 internal URL read、Hub wait、settings 修改）——要么加 instrumentation 要么缩到可观察 cancel/complete；"Non-overlap interval=同 episode 仅计一次"只是 dedupe 不是实验 interval，本轮已取消 A/B 可改名 sequential rollout ledger；anchors 仍错：maxConcurrency 称 settings-schema.ts:4730-4800（实际从 :4686）、queued:true 实际 task/index.ts:1212 而非 :1085-1118、markRunning 实际 :1117 而非 :1211-1213、drainPendingInbox 实际 hub/index.ts:348-350 而非 :371-383。→ 把 salvage-success 归类 delivery/salvage health；另定义 runtime 误杀 proxy（如同 task fingerprint 短窗 retry 成功，明确局限）与 staleness 自然完成/干预指标；指定每个 outcome 的真实 instrumentation owner 或删除不可观测项；structured logs 不含 task content；ledger 改称 sequential rollout/dedupe ledger 并定义 interval 边界；更新全部 [已核实] anchors 到当前 symbol/range，优先 file+symbol。

### 清关条件（第五轮，reviewer 2026-08-04）

1. 补回自包含的 §5.2.4 queued-timeout 实现。
2. delivery union 真正迁入现有全部 scheduler/filter/drain/suppression/in-flight APIs，删除冲突定义，完成 episode 状态终结与 typed sink clean cutover。
3. 修复 wait reservation/claim：subscription 预 claim 后 Hub 不能只 claim pending；实现真正 post-wake priority 与未消费 reservation 回 owner queue。
4. 按真实 YieldQueue API 注册/构建/enqueue lifecycle kind，completion 继续走现有 formatter，episode validity+epoch 双 stale 并有 ack。
5. 修正 builder/TUI/snapshot 的实际 API 与 model-facing 文本，保留旧 wire/useless/render pipeline。
6. 落地 AsyncJobRegisterOptions+TaskTool policy wiring，mode 必须 on AND threshold>0，cancel 路径同步 invalidate。
7. §7 所有空测试与无效示例替换为可执行、可失败于真实 bug 的断言；修正 HubTool/TaskTool/result shape/cwd。
8. 修正指标 owner/含义和剩余 facts anchors。

---

## 第六轮记录：Scope 决策（2026-08-04，用户批准拆分交付）

- **全量文档 Gate 状态**：NEEDS_REVISION（未通过）。第五轮 F1–F8 中仅 F1 已应用（§5.2.4 补入，文档 2028→2029 行）；F2–F8 未应用。
- **用户决策**：拆分交付——
  - **P0 转 design-implement**：排队启动超时（§5.2.4）+ 运行墙钟超时 + settings 默认值；实施约束 = 第五轮 F1/F6/F8；测试 owner = `test/task/executor-wall-clock.test.ts`、`test/task/task-spawn.test.ts`（queued timeout，真实 semaphore + await job.promise）、`test/settings-manager.test.ts`（defaults，getDefault(path)/Settings.isolated()）；`bun test` 需 cwd=packages/coding-agent。
  - **P1 另开 epic**：staleness 主动通知（F2/F3/F4/F5/F7）；输入归档于 `docs/design/_p1-epic-inputs/`（F2-F8-corrections.md 规格 + 分节草稿 + pre-r5 备份）。
- **author 状态**：DesignRevisionR5 在第五轮修订中多次 token 截断/产出规范而非正文；本轮仅 F1 落盘。DesignRewriteV2（上一 author）已停手，未触碰 v2.md（仅创建 backup 与 partial draft）。
- **Gate 连续性**：不适用 PASS；P0 进入实现为用户的显式 scope 批准（授权来源：本会话用户选择「拆分交付：P0 转实现，P1 另开 epic」）。
