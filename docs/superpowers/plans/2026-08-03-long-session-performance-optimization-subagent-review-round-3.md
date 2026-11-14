# Design Review Gate — omp 长会话性能优化（round 3）

## Gate 元数据

- **review_mode**: `host-native`（shared-worker 路径不适用）
- **评审类型**: `NEEDS_REVISION` 后的完整 Design Review Gate 重审；不是 Gate Continuity Note
- **评审日期**: 2026-08-03
- **Reviewed Inputs**: 单一输入 `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`
- **design_author / design_author_identity**: `deepseek-v4-flash:max` / `LongSessionDesignAuthor`（设计 `:6-7`）
- **planned_reviewer**: `gpt-5.6-sol native reviewer agent`（设计 `:8`）
- **实际 reviewer identity / model**: `LongSessionDesignReviewer-2` / `gateway/gpt-5.6-sol`
- **reviewer host route selector**: `task.agentModelOverrides.reviewer = gateway/gpt-5.6-sol:xhigh`（`/Users/sheng/.omp/agent/config.yml:621-625`）
- **异模型 Gate**: author `deepseek-v4-flash:max` ≠ reviewer `gpt-5.6-sol`；本次由只读 host-native reviewer 执行，未通过 shell 启动模型 CLI，非作者自审
- **implementation_authorization**: `design-only`（设计 `:11`）
- **authorization_source**: 用户明确要求“输出为评审用设计文档……不要直接改代码”；round 2 授权为“修订文档从 gpt-5.6-luna 改为 deepseek-v4-flash:max 来进行，其他不变”（设计 `:12`）

## Reviewed Inputs manifest 与 revision

按 normalized repo-relative path 排序后的 manifest（单行，末尾含 `\n`）：

`docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md\t28293dab442d620800350dd9f82156fa176cf2058b2d6bf20ed90b93094c2504\n`

- **input sha256**: `28293dab442d620800350dd9f82156fa176cf2058b2d6bf20ed90b93094c2504`
- **reviewed_revision**: `3c9a9793df845b7ca4af5c4ad4531f65b5ea6261591f0bd8904b73385f266f8d`
- **独立交叉核对**:
  - `shasum -a 256` 对设计原始 bytes 得到 input sha256 `28293dab442d620800350dd9f82156fa176cf2058b2d6bf20ed90b93094c2504`。
  - `/opt/homebrew/bin/python3` 使用 `Path.read_bytes()` 与 `hashlib.sha256` 得到相同 input sha256。
  - 将上述 manifest UTF-8 bytes 送入 `shasum -a 256` 得到 reviewed revision `3c9a9793df845b7ca4af5c4ad4531f65b5ea6261591f0bd8904b73385f266f8d`；Python 由实际 input hash 构造同一 manifest bytes 后得到相同 revision。
  - 两条独立路径均与协调者预计算值一致，故本 artifact 引用上述值。

## 最终 Verdict

**NEEDS_REVISION**

一句话理由：round 3 已补齐 branch-aware receiver、active-branch 恢复、单一 started-event 计数源及 prompt/config 先前缺口，但 `usedCalls` 合同仍没有可执行的“持久化成功后才调用”门禁，并把内部 bridge invocation 数与外层 `eval` tool-call 数对账，正常的零次/多次 bridge cell 会系统性触发 reconcile mismatch；round 2 的 R2-1 因而尚未真正闭合。

本 verdict 不改变 `implementation_authorization=design-only`，不授权实现、提交、发布或扩大授权。

## Round 2 阻塞项闭环复核

### R2-1：`usedCalls` 单一 durable source 与完整性合同 — **未解决（主体修订正确，仍有两个阻塞缺口）**

已解决部分：

- [事实] §5.3.3 已从 `longSessionFeatureSnapshot` 移除 `usedCalls`；§5.3.4 只把 `phase=started && counted=true` 的 `performanceEvent` 流作为事实来源，不再保留 snapshot fallback 或第二计数通道（设计 `:469-477,502-505`）。
- [事实] `performanceEvent` 已有 `eventId`、`invocationId`、`phase`、`counted`、分相的 `startedAt`/`endedAt` 与 finished outcome（设计 `:479-495`）。
- [事实] started/finished 使用同一 `invocationId` 的 append-only 配对；started 无 finished 仍计入预算，符合“已开始调用不可通过 crash 绕过”的语义（设计 `:505`）。
- [事实] compaction 截断无法证明完整时使用 `used_calls_stream_incomplete` fail closed，且明确禁止第二计数通道；§6.2 要求覆盖配对、crash/abort、写前 fail closed、完整性和 reconcile（设计 `:510,603`）。当前 compaction 实现只追加 compaction entry 并在 context 构建时选择历史，不物理删除 custom journal entries（`session-manager.ts:1996-2024`、`session-maintenance.ts:814-830`）；把保留语义固化为测试仍合理。

仍未解决的阻塞缺口：

1. **现有 append seam 不能兑现“写入失败则调用不启动”。** 设计要求 started 在 bridge invocation 前“同步写入”，写失败返回 `eval_budget_count_write_failed` 且不启动调用（设计 `:394,504,527`）。但指定的 `SessionManager.appendCustomEntry()` 只返回 entry id（`packages/coding-agent/src/session/session-manager.ts:2020-2024`）；热路径对 writer promise 使用 `void ...append(...).catch(...)`，错误异步记入 `#diskFailure`（`:873-881`），调用者不能仅靠 `appendCustomEntry()` 在启动 bridge 前观察该失败。公开 `flush()` 才等待 writer/storage 并抛出 latched failure（`:1514-1523`），且 `ToolSession.sessionManager` 已暴露 `appendCustomEntry`/`flush`（`packages/coding-agent/src/tools/index.ts:249-250`）。设计必须把“append 后 await durable flush（或新增等价 awaitable durable append）成功，才 dispatch bridge”写成明确 seam；否则单次写失败后仍可能执行未计数调用，resume 会低估 `usedCalls` 并绕过 `callsPerSession`。
2. **reconcile 比较的两侧不是同一 invocation 单位。** 配置合同明确 `callsPerSession` 计 **bridge invocation**，wall-clock 也从 bridge invocation 开始（设计 `:460-461`），§5.3.4 的 started 门禁同样写成 eval bridge invocation（`:504`）；但下一行把事件生命周期称为 `eval invocation`，完整性又拿 session message 中的 `eval` tool call/result parts 与 started 数比较（`:505-506,531`）。代码中一条外层 `EvalTool.execute` 执行一个 cell（`packages/coding-agent/src/tools/eval.ts:392-430,563-588`），而该 cell 可调用内部 `completion()`/`agent()` 零次或多次；JS helpers 每次调用 `__omp_call_tool__("__completion__"|"__agent__")`（`packages/coding-agent/src/eval/js/shared/prelude.txt:94-114`），Python helpers也逐次调用同一 bridge（`packages/coding-agent/src/eval/py/prelude.py:466-521`），router 再直接分派到 `runEvalCompletion`/`runEvalAgent`（`packages/coding-agent/src/eval/js/tool-bridge.ts:110-115`）。session message 只有一条外层 `eval` tool call；因此正常的无 bridge cell 是 `outer=1, started=0`，一次 cell 内两个 bridge 是 `outer=1, started=2`。按现合同，两者都会被误判 `ledger_reconcile_mismatch`；若实现者只为外层 eval 写一次 started，又会少算内部 bridge budget。必须统一计数单位：要么预算定义为外层 eval tool invocation 并相应改写 wall-clock/bridge 文本，要么坚持内部 bridge invocation，并选择一对一的 durable bridge witness/reconcile 合同，不能再用外层 message tool-call 数。

补充一致性检查：started 写失败时，外层 assistant `eval` toolCall 已在执行前持久化（`packages/agent/src/agent-loop.ts:1786,2515-2519`），而 started 不存在；当前 reconcile 还会把设计自身的 fail-closed 拒绝误报为 stream corruption。修订后的合同应明确 gate-rejected invocation 如何进入对账，但不能把它变成第二条 counted source。

**判定**: 未解决。单一事实来源的方向正确，但 durability gate 与 reconcile cardinality 仍不能同时实现 `callsPerSession`、resume fail closed 和可归因 ledger。

### R2-2：branch-aware resume dispatcher — **已解决**

- [事实] §5.3.4 指定只读消费模块 `packages/coding-agent/src/session/long-session-features.ts`，并要求注册 `api.on("session_start" | "session_switch" | "session_branch" | "session_tree")`，在 prompt/feature owner 首次消费前 rehydrate（设计 `:507`）。
- [事实] 四个事件名和 `api.on` overload 均真实存在（`packages/coding-agent/src/extensibility/shared-events.ts:28-30,42-61,133-137`；`extensibility/extensions/types.ts:1083-1102`）；仓库已有完全相同的 registration pattern（`packages/coding-agent/src/autoresearch/index.ts:248-251`）。
- [事实] resume/switch/branch/tree dispatch 均在 SessionManager 已切换文件或 leaf 后发出（`packages/coding-agent/src/session/agent-session.ts:7220-7242,7471-7481,7907-7914`），因此 receiver 可读取新 active branch。
- [事实] 设计明确 snapshot 与 started 事件只从 active branch 推导，禁止从 full journal 取“最新”；代码的 `getBranch()` 返回当前 leaf 的 root-to-leaf 路径，`getEntries()` 返回全 journal 浅拷贝（`session-manager.ts:2135-2137,2167-2170`），与设计引用一致。
- [事实] receiver 未注册或 active branch 无法判定时分别 fail closed 为 `snapshot_consumer_unregistered` / `snapshot_branch_ambiguous`；离线 ledger 每 branch 单独构建，不跨 branch 相加（设计 `:507-509,529`）。§6.2 覆盖 rewind/fork/非活动分支、未注册 receiver、restore 顺序和 branch/session-end 边界（`:603`）。

**判定**: 已解决。消费模块、lifecycle dispatch、active-branch 选择、静默丢弃防护和可观察测试合同均已固定；现有方法名/事件名没有 seam 冲突。

## Round 1 阻塞项闭环复核

### 1. 当前配置事实错误 — 已解决且未回退

- [事实] live config 为 `modelRoles.default = gateway/deepseek-v4-flash:max`、`modelRoles.plan = gateway/gpt-5.6-luna:max`，四个 override、`task.eager/batch`、`async.enabled` 与 compaction 显式值见 `/Users/sheng/.omp/agent/config.yml:609-628,642-644`。
- [事实] 设计 §2.2、§5.3.1、§5.6、§7 均使用 Flash effective control，并明确历史 all-Sol 可路由残余变小、方案 C 前提弱化（设计 `:109-110,405-427,540-544,641-645,652`）。
- [事实] `async.pollWaitDuration` 和 `compaction.thresholdTokens` 不在 config 中显式出现；schema defaults 分别为 `smart` 与 `-1`（`settings-schema.ts:4150-4153,2179-2181`），设计要求 receipt 区分 explicit/default-derived。
- **判定**: 已解决。

### 2. snapshot/event owner 与 resume/consumer 合同 — 未完全解决

- [事实] R2-2 的 persistence customType、消费模块、dispatch 与 active-branch 恢复已闭合；R2-1 的单一 source、schema 和 start/end 配对也已实质补齐（设计 `:479-510`）。
- [事实] 上述 durability gate 与 reconcile-unit 两个缺口仍使计数/完整性合同不可执行。
- **判定**: 未完全解决；阻塞范围已收窄到 R2-1，不再是 receiver/branch owner 缺失。

### 3. tool prompt 与 default-off 合同 — 已解决且未回退

- [事实] §4.1.1、§4.2.1、§4.2.2、§5.2、§5.3.2、§5.6、§6.2 一致规定 `hub.md`、`bash.md`、`web-search.md`、`eval.md` 四个静态资产不改；纪律只经 `promptPolicy.enabled` gated system block 注入（设计 `:173,215-216,232,390,456,561,608-609`）。
- [事实] Hub constructor 无条件 render（`packages/coding-agent/src/tools/hub/index.ts:234-235`）；WebSearch class constructor 与 module-level custom tool 分别无条件 render（`packages/coding-agent/src/web/search/index.ts:314-315,339-340`）。不修改这些资产才能保持 off 字节等价。
- [事实] prompt rebuild 是从头构造并替换 base prompt（`packages/coding-agent/src/session/session-tools.ts:606-619,962-990`）；设计已把 on 语义改准为“每次重建后的最终 prompt 恰有一份 policy、不累积”。
- **判定**: 已解决。

## Round 1 Notes 1–4 复核

1. **字符/字节来源 — 已解决。** 本轮重新执行 `wc -m -c docs/long-session-latency-analysis.md`，输出 `6176 9981`；设计 `:93,598` 与实测一致，并区分字符、字节、token。
2. **explicit/default-derived — 已解决。** config 缺少两个显式键，schema default 与设计 `:109,387,427,540-544,641-645` 一致。
3. **master namespace 原子关闭 — 已解决。** §4.2.5 明确 namespace 缺省/整体清空时所有 leaf 默认 off，不新增 root `enabled`；未来 master switch 必须另列字段、优先级和 rollback tests（设计 `:286`）。
4. **测试入口存在不等于覆盖新合同 — 已解决。** §6.2 明确要求实施时补 observable-contract tests，并举出 `bash-execution-clamp.test.ts` 与受 `PI_PYTHON_INTEGRATION=1` gate 的 integration test 反例（设计 `:611`）。

## Round 2 Notes 复核

1. **WebSearch render 位置 — 已解决。** §4.2.1 准确区分 class constructor `web/search/index.ts:314-315` 与 module-level `webSearchCustomTool` `:339-340`（设计 `:216`），没有继续统称 constructor。
2. **system prompt 重建语义 — 已解决。** §5.3.2 与 §6.2 明确“每次重建后的最终结果恰有一份 policy、不随轮次累积”，并覆盖 tool-set/host 变化触发的重建（设计 `:456,608-609`）。

## 完整评审域 A–N

### A. 目标、范围、约束 — 通过

- [事实] 目标覆盖性能、质量/独立性、canonical owner 与 current-control-first；历史 689 会话不作新增收益分母（设计 `:18-33`）。成功标准全部标为拟议验收目标（`:35-47`），范围与非目标排除动态主会话路由、sidecar compaction、无 freshness 合同的 search cache 和硬抑制验证（`:49-68`）。default-off、session snapshot、identity/lineage、原始失败和 no-second-engine 约束见 `:119-125`。

### B. 三方案比较与单一推荐 — 通过

- [事实] A/B/C 分别覆盖配置纪律、窄 runtime guardrail 和激进编排（设计 `:162-348`）；§4.4 从覆盖面、风险、诊断、回滚与 owner 一致性比较（`:350-361`）；§4.5 只推荐 B，并把 C 推迟到残余与 identity/freshness/isolation 有新证据之后（`:363-371`）。当前 Flash default 进一步削弱 C 的历史模型路由前提，但不改变 B 对 compaction/wait/bash/eval 残余的验证方向。

### C. canonical owner 复用 — 需修订

- [事实] route snapshot、compaction、Hub waiter、Bash result、eval bridge 和 prompt assembly 均复用现有 seam；新 customType persistence 与 branch-aware receiver 也已选定（设计 `:105-117,212-234,502-510`；代码 `quality-route-snapshot.ts:71-159`、`compaction.ts:295-323`、`hub/index.ts:337-467`、`tools/bash.ts:578-705`）。
- [事实] 但 canonical persistence 的写前 gate 只指定 `appendCustomEntry`，没有指定实际可观察 durable failure 的 `flush`/awaitable append；该遗漏直接破坏本 feature 的 source-of-truth owner 合同。

### D. 控制流 — 需修订

- [事实] §5.2 给出 settings → snapshot → route → prompt/compaction/wait/bash/eval → offline ledger 主线（设计 `:384-395`）；Hub 继续使用 job promise/IRC waiter/timeout/abort 的 `Promise.race`（`hub/index.ts:337-467`），没有第二等待引擎。
- [事实] eval 末端控制流在两个位置断裂：started 的 durable success 尚未成为 dispatch 前置条件；内部 bridge start 数又与外部 eval tool message 数对账。正常 cell 因此可能绕过计数或被错误标记不可归因。

### E. 配置接口 — 需修订

- [事实] 五个 leaf 默认 off、独立启用，数值需有限/非负，非法 treatment 配置在 session start 前拒绝（设计 `:429-462`）；snapshot 已不再持久化 `usedCalls`。
- [事实] `evalBudget.callsPerSession` 的 interface 明确以 bridge invocation 为单位（`:461`），而 persistence/reconcile 部分混用 bridge invocation、eval invocation 与外层 tool invocation（`:504-506,531`）。调用者无法据此实现唯一的计数单位。

### F. 失败路径 — 需修订

- [事实] §5.4 覆盖 schema、identity、compaction、wait、bash、eval、prompt、snapshot、receiver、usedCalls、ledger 和质量 gate（设计 `:516-533`）。Bash 原始 `isError`/exitCode/timedOut 行为保持，eval budget 也仍为 typed failure。
- [事实] `eval_budget_count_write_failed` 行要求在调用前观测 append failure，但指定 API 不提供该同步结果；必须补 durable barrier。另见 Note 1：finished 写失败的 `event_write_failed` 离线标签没有 durable witness。

### G. 量化口径 — 通过

- [事实] `docs/long-session-latency-analysis.md:17-28,60-72,79-118` 支持 689/306.6h、gen/TTFT、Hub/Bash/eval/search、context bucket、compaction/read/cacheRead 等历史量；设计按历史事实、算术上限、推导、未验证假设和拟议验收目标分层（设计 `:20-27,73-93`）。
- [事实] 算术成立：`212.6×60%=127.56≈127.6`、`266.3×60%=159.78≈159.8`、`(29.1−15.6)×1000/3600=3.75h`；`wc -m=6176`、`wc -c=9981` 已在本轮重新实测。

### H. 不双算 — 通过

- [事实] 区间并集、组合 arm 只用 `S_combined`、单 feature delta 不相加、factorial interaction、Hub parent wait/child runtime 分离、eval bridge/internal LLM 包含关系见设计 `:95-103,623-626,639-646`。本次 blocker 是事件 cardinality，不是收益重复计算规则本身。

### I. A/B baseline — 通过

- [事实] current effective config 先做 control，历史 689 只作背景；同任务分层、同 deterministic verification contract、pilot 每 arm ≥30、promotion 每 arm ≥100 或预注册置信区间见设计 `:33,39-43,593-623`。configured/local/attested identity 分层和缺 attestation 不冒充目标模型样本见 `:616-622`。

### J. 质量停止条件 — 通过

- [事实] 完成率/verifier 2pp、lineage/identity/scope/isolation fail closed、compaction 10%、wait regression、bash hard-block、eval gate、search freshness 和 off→control 均有停止条件，并明确不得用历史算术上限掩盖回归（设计 `:625-637`）。

### K. 独立回滚 — 通过

- [事实] §4.2.5 为 prompt、compaction、wait、bash、eval 分别定义独立默认-off leaf 与 control 恢复路径（设计 `:254-287`）；namespace 缺省/清空的原子关闭语义明确。四个 tool prompt 资产不改，使 prompt leaf off 的字节级回滚可验证（`:216,286,456,608-609`）。

### L. 根因分析章节 — 通过

- [事实] §3 明确不重新发明根因，只把既有证据转为候选，并要求用 Flash effective control 验证残余（设计 `:128-157`）。证据文档支持历史 Sol/context、Hub 满时长等待、Bash 重跑、eval 长尾、search timeout 和晚 compaction；当前 Hub smart ladder `[5s,10s,30s,60s,300s]` 由 `packages/coding-agent/src/async/job-manager.ts:10-20` 复核。

### M. 当前配置事实 — 通过

- [事实] `async.enabled=true`、`task.eager=preferred`、`task.batch=true`、四个 agent override、`modelRoles.plan/default`、`compaction.thresholdPercent=70`、`idleEnabled=true` 与 live config 一致（`/Users/sheng/.omp/agent/config.yml:609-628,642-644`）。default-derived `smart/-1` 与 schema 一致；设计 §2.2、§5.3.1、§5.6、§7 无 stale Sol-default 残留。

### N. Handoff — 通过

- [事实] metadata 的 `design_author=deepseek-v4-flash:max`、`revision_round=3`、同时引用 round 1/2 verdict 的 `revision_basis`、`planned_reviewer=gpt-5.6-sol`、`implementation_authorization=design-only` 与 authorization source 均完整（设计 `:6-12`）。§8 指向 host-native 异模型只读 reviewer、单一输入、round 3 完整 Gate 与 artifact `...-subagent-review-round-3.md`，并规定 PASS/PASS_WITH_NOTES 后仍停在 design-only（`:661-682`）。

## 阻塞项

### 1. 为 counted-start 增加可观察的 durable write barrier

- **优先级**: P1
- **影响**: `appendCustomEntry()` 的异步错误在当前调用返回后才 latch；若 bridge 立即启动，可能出现真实调用但没有 durable started 记录，resume 低估 `usedCalls` 并绕过 `callsPerSession`。
- **证据**: 设计 `:394,504,527`；`session-manager.ts:873-881,1514-1523,2020-2024`；`tools/index.ts:249-250`。
- **必须修订**: 把 append 与 durability barrier 定义为同一 pre-dispatch transaction：明确调用现有 `flush()` 并 await/catch，或指定新的 awaitable durable append seam；只有 durable success 后才能进入 `runEvalAgent`/`runEvalCompletion`，失败必须返回 `eval_budget_count_write_failed`。

### 2. 统一 `usedCalls`、budget 与 reconcile 的 invocation 单位

- **优先级**: P1
- **影响**: 一条外层 `eval` tool call 可产生零到多个内部 bridge calls。当前合同要么少算实际 bridge calls，要么把每个正常的零次/多次 bridge cell 标为 `ledger_reconcile_mismatch`，从而无法证明 resume budget 或生成可归因 ledger。
- **证据**: 设计 `:460-461,504-506,531`；`tools/eval.ts:392-430,563-588`；`eval/js/shared/prelude.txt:94-114`；`eval/py/prelude.py:466-521`；`eval/js/tool-bridge.ts:110-115`。
- **必须修订**: 只选择一个可测试单位，并让 started producer、callsPerSession、wall-clock、message/audit witness、resume 推导和 reconcile 全部使用它；若坚持内部 bridge invocation，就不能以外层 eval message toolCall 数作为 1:1 witness。还需定义 pre-start gate 拒绝记录如何参与 reconcile，而不能形成第二 counted source。

## 非阻塞 Notes

1. **finished 写失败标签不可离线区分。** 设计 `:505,528` 要求 ledger 标记 `event_write_failed`，但 finished 本身未持久化时，durable stream 只表现为 started-without-finished，与 crash/abort/in-flight 不可区分；schema 也没有独立 failure marker。计数仍由 started 保证，故不扩大为 budget blocker；实现前应把离线分类收敛为“terminal event missing / interval unattributable”，或定义不参与计数的 durable failure receipt。
2. **receiver 必须实际装配为 extension factory。** `api.on` 只能在 `ExtensionFactory` 中注册；现有先例为 `createAutoresearchExtension`（`autoresearch/index.ts:33,248-251`），并由 `sdk.ts:2049-2051` 装配。仅创建 `session/long-session-features.ts` 文件不会自动注册。§6.2 的 receiver-unregistered/restore-order 测试应覆盖 factory wiring。
3. **fresh-session 与 prompt 顺序要固定。** `session_start` receiver 同时覆盖新会话和 resume；实现需确保新会话 snapshot producer 先于 rehydrate，或明确区分 fresh/resume，且 restored `promptPolicy` 在第一次 provider request 前生效。当前设计已经要求“首次消费前完成”和 restore-order test（`:507,603`），故作为实现精度 Note，不另设阻塞项。
4. **finished 的 `counted` 表示应唯一化。** schema `:483` 写成“无此字段（或 false）”；两者对 `phase=started && counted=true` 结果等价，但实现 schema/test 应固定一种 wire representation，避免两个合法编码。
5. 本次为 design-only Gate；按用户要求未运行 formatter、linter、build 或测试套件。实际执行的验证仅为全文/源码读取、双路 SHA-256、manifest revision、`wc -m -c` 与算术复核；没有把测试文件存在当作行为已经通过。

## 实现前必须满足

1. 修订并闭合上述两个阻塞项；R2-1 只有在 durable write barrier 与 like-for-like invocation reconcile 同时单一、可执行、可验证时才算解决。
2. §6.2 增加能证伪本轮缺口的 observable tests：started append/flush 失败时 bridge 绝不 dispatch；零 bridge、单 bridge、多 bridge/parallel bridge cell 的 usedCalls 与 reconcile；gate-rejected invocation；resume 后同一 active branch 的 callsPerSession。
3. 保持已闭合的 R2-2、round 1 阻塞项 1/3、round 1 Notes 1–4 与 round 2 Notes：active-branch receiver、Flash effective control、explicit/default-derived receipt、四个 tool prompt 资产不变、off 字节等价、master namespace 原子关闭和 prompt 重建不累积均不得回退。
4. 因阻塞项涉及 source of truth、跨模块 invocation interface、错误行为与验收义务，修订后必须重新计算 input manifest/reviewed_revision 并再次执行完整 Design Review Gate；不能用 Continuity Note 延续本 verdict。
5. `implementation_authorization` 继续为 `design-only`；在新的通过 verdict 与另行实现授权出现前，不得进入实现、提交或发布。
