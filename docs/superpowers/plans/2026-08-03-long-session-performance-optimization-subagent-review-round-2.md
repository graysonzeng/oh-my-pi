# Design Review Gate — omp 长会话性能优化（round 2）

## Gate 元数据

- **review_mode**: `host-native`（shared-worker 路径不适用）
- **评审类型**: `NEEDS_REVISION` 后的完整 Design Review Gate 重审；不是 Gate Continuity Note
- **评审日期**: 2026-08-03
- **design_author / design_author_identity**: `deepseek-v4-flash:max` / `LongSessionDesignAuthor`（设计 `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md:6-7`）
- **planned_reviewer**: `gpt-5.6-sol native reviewer agent`（设计 `:8`）
- **实际 reviewer identity / model**: `LongSessionDesignReviewer` / `gateway/gpt-5.6-sol`
- **reviewer host route selector**: `task.agentModelOverrides.reviewer = gateway/gpt-5.6-sol:xhigh`（`/Users/sheng/.omp/agent/config.yml:621-625`）
- **异模型 Gate**: author `deepseek-v4-flash:max` ≠ reviewer `gpt-5.6-sol`；本次由只读 host-native reviewer 执行，未通过 shell 启动模型 CLI，非作者自审
- **implementation_authorization**: `design-only`（设计 `:11`）
- **authorization_source**: 用户明确要求“输出为评审用设计文档……不要直接改代码”；round 2 授权为“修订文档从 gpt-5.6-luna 改为 deepseek-v4-flash:max 来进行，其他不变”（设计 `:12`）
- **Reviewed Inputs**: 单一输入 `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`

## Reviewed Inputs manifest 与 revision

按 normalized repo-relative path 排序后的 manifest（单行，末尾含 `\n`）：

`docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md\t92f0cf5b7a754d2a60dabe4d9fc0ebf5c03d4cf2561ff2adebacb20342d48f19\n`

- **input sha256**: `92f0cf5b7a754d2a60dabe4d9fc0ebf5c03d4cf2561ff2adebacb20342d48f19`
- **reviewed_revision**: `47370b7ecaafc977d66e0d55634aff0a4b0bbd04237634456cf1763adcaf29ee`
- **独立交叉核对**:
  - `shasum -a 256` 对设计原始 bytes 得到 input sha256 `92f0cf5b...42d48f19`。
  - `/opt/homebrew/bin/python3` 使用 `pathlib.Path.read_bytes()` + `hashlib.sha256` 得到相同 input sha256，并由 manifest UTF-8 bytes 得到 reviewed_revision `47370b7e...caf29ee`。
  - 将由 `shasum` 结果组成的 manifest 行送入 `shasum -a 256`，同样得到 `47370b7e...caf29ee`。
  - 两条独立路径均与协调者预计算值一致，故本 artifact 引用上述值。

## 最终 Verdict

**NEEDS_REVISION**

一句话理由：round 1 的配置事实和 tool-prompt 阻塞项已解决，但新 §5.3.3–§5.3.4 的 `performanceEvent`/`usedCalls` 合同自相矛盾且没有可执行的 start/end、完整性和 resume dispatch 协议，round 1 阻塞项 2 因而仍未闭合。

本 verdict 不改变 `implementation_authorization=design-only`，不授权实现、发布、提交或扩大授权。

## Round 1 阻塞项闭环复核

### 1. 当前配置事实错误 — 已解决

- [事实] live config 的 `modelRoles.default` 为 `gateway/deepseek-v4-flash:max`，`modelRoles.plan` 为 `gateway/gpt-5.6-luna:max`（`/Users/sheng/.omp/agent/config.yml:626-628`）；四个 override、`task.eager/batch`、`async.enabled` 和 compaction 显式值见 `:609-625,642-644`。
- [事实] 设计已在 §2.2、§5.3.1、§5.6 和 §7 使用正确 Flash 默认值（设计 `:109-110,405-427,540,641-642`），并明确：普通主会话已经是低 TTFT 默认模型，历史 all-Sol 可路由残余更小；方案 B 的 guardrail 方向不变，而方案 C 的动态主会话路由前提进一步弱化。
- [事实] `async.pollWaitDuration` 与 `compaction.thresholdTokens` 在 config 中没有显式键；schema 默认分别是 `smart` 与 `-1`（`packages/coding-agent/src/config/settings-schema.ts:4150-4153,2179-2181`）。设计在 `:109,427,540` 一致标为 default-derived，并要求 receipt 区分 explicit/default-derived。
- **判定**: 已解决。Flash effective control、历史 Sol 残余和 B/C 选择影响均已纳入。

### 2. snapshot/event owner 与 resume/consumer 合同 — 未解决（部分补齐）

已补齐部分：

- [事实] §5.3.4 选择 `SessionManager.appendCustomEntry` 作为 canonical persistence，定义 `omp.longSession.featureSnapshot.v1` 和 `omp.longSession.performanceEvent.v1`，列出 feature producer、resume 校验、离线 ledger consumer 以及缺失/损坏 fallback（设计 `:494-503`）。
- [事实] seam 引用成立：`appendCustomEntry` 在 `packages/coding-agent/src/session/session-manager.ts:2020-2024`；`CustomEntry` 明确不进入 LLM context，并要求 reload consumer 按 `customType` 扫描重建状态（`packages/coding-agent/src/session/session-entries.ts:123-136`）。§6.2 也列出 round-trip、resume、完整性与 ledger consumer 的 focused verification（设计 `:592-593`）。

仍未闭合部分：

- [事实] snapshot schema 把 `evalBudget.usedCalls` 列为字段（设计 `:469-476`），但 §5.3.4 又声明 `usedCalls` “不由快照字段携带”、只从 event stream 推导（`:501`）；紧接着 `:503` 又提出 event 被截断时每次 counted invocation 追加 featureSnapshot 来“保证 resume 计数不丢失”。若快照不携带计数，这个 fallback 无法保存计数；若携带，则违反 `:501` 的单一事实来源。
- [事实] `performanceEvent` schema 只有 `startedAt`、`endedAt` 和终态 `outcome`，没有 §5.3.4 依赖的 `counted` 字段、start/end phase、event identity 或 ordinal/completeness anchor（设计 `:478-489`）。但 producer 合同要求“每个 event 在调用起点追加并带 counted 标记”（`:499`）；调用起点尚不知道 `endedAt` 与 `outcome`，而 append-only `CustomEntry` 又没有设计中的 update/pair 规则。
- [事实] §5.4 说 `performanceEvent` 写入失败时 runtime 行为不变、ledger 标记 `event_write_failed`（设计 `:520`），但用于恢复计数的同一 stream 没有 ordinal/hash-chain/持久化 failure sentinel，单个丢失的 counted event 不能被 resume consumer 证明为“缺失”。这会把 `usedCalls` 推导成偏小值并绕过 `callsPerSession`，与 `:501,521` 的 fail-closed 目标冲突。
- [事实] 当前 `SessionManager.setSessionFile` 只加载并 `#applyEntries`（`session-manager.ts:1195-1237`），没有全局 customType router；现有显式消费范式是 lifecycle dispatch 后由 owner 扫描，例如 `autoresearch/index.ts:248-251` 在 `session_start/session_switch/session_branch/session_tree` 调用 rehydrate，再由 `autoresearch/state.ts:224-228` 过滤 customType。设计只写“session 加载路径”且未指定注册模块、生命周期事件、先后顺序或 active-branch 语义。
- [事实] `SessionManager.getBranch()` 返回当前 leaf 的路径，而 `getEntries()` 返回所有 entry（`session-manager.ts:2135-2137,2167-2170`）。设计的“取最新一条”没有说明从 active branch 还是全 journal 选择；session rewind/branch 后，全 journal 的最新 snapshot/event 可能来自非活动分支。
- **判定**: 未解决。round 1 要求的 owner/dispatch、usedCalls 恢复和损坏/缺失 fail-closed 仍不是单一、可实现、可验证的合同。

### 3. tool prompt 与 default-off 合同 — 已解决

- [事实] Hub 静态资产在 constructor 无条件 `prompt.render`（`packages/coding-agent/src/tools/hub/index.ts:234-235`）；WebSearch 分别在 class constructor 和 module-level custom tool 无条件 render（`packages/coding-agent/src/web/search/index.ts:314-315,339-340`）。
- [事实] round 2 在 §4.1.1、§4.2.1、§4.2.2、§5.2、§5.3.2、§5.6、§6.2 一致规定：`hub.md`、`bash.md`、`web-search.md`、`eval.md` 四个静态资产不改；只在 `promptPolicy.enabled` 时通过 `system-prompt.ts` 的 system block 注入；off 字节等价，on 只出现一次且不随轮次增长（设计 `:173,215-216,232,390,456,551,598`）。
- [事实] `buildSystemPrompt` 的 template data/条件 block seam 存在（`packages/coding-agent/src/system-prompt.ts:820-894`），SDK caller 持有 settings 并从头重建 prompt（`packages/coding-agent/src/sdk.ts:2782-2924`）；§6.2 要求覆盖重建后不重复增长。
- **判定**: 已解决。没有发现要求直接编辑四个静态 tool prompt 的残留文字。

## Round 1 Notes 复核

1. **文档字符/字节来源 — 已解决。** 实际执行 `wc -m docs/long-session-latency-analysis.md` 得 `6176`，`wc -c` 得 `9981`；与设计 `:93,588` 一致。设计同时明确字符、字节、token 不混用。
2. **explicit/default-derived — 已解决。** config 中没有 `pollWaitDuration`/`thresholdTokens` 显式键；schema default 与设计标注一致（设计 `:109,427,540`；schema `:4150-4153,2179-2181`）。
3. **master namespace 原子关闭 — 已解决。** §4.2.5 明确 `performance.longSession` 缺省或整体清空时所有 leaf 按默认 off 回 control，不新增 root `enabled`；未来 master switch 必须另列字段、优先级和 rollback tests（设计 `:286`）。
4. **测试文件存在不等于覆盖新合同 — 已解决。** §6.2 明确说明需补 observable-contract tests（设计 `:601`）。实际文件也支持该说明：`bash-execution-clamp.test.ts:1-105` 主要覆盖 TUI 可见宽度；`core/eval-workflow-helpers.integration.test.ts:12-20` 受 `PI_PYTHON_INTEGRATION=1` gate。设计列出的测试入口均存在；这不被当作新合同已经通过的证据。

## 完整评审域 A–N

### A. 目标、范围、约束 — 通过

- [事实] 目标优先级覆盖性能、质量/独立性、canonical owner 和 current-control-first；历史 689 会话不作为新增收益分母（设计 `:18-33`）。成功门槛均标为拟议验收目标（`:35-47`），范围/非目标明确排除动态主会话路由、sidecar compaction、未经 freshness 合同的 search cache 和硬抑制验证（`:49-68`）。default-off、start snapshot、identity/lineage、原始失败和 no-second-engine 约束见 `:119-125`。

### B. 三方案比较与单一推荐 — 通过

- [事实] A/B/C 分别覆盖现有配置纪律、窄 runtime guardrail、激进编排（设计 `:162-348`）；§4.4 按覆盖面、风险、失败可诊断性、回滚和 canonical-owner 一致性比较（`:350-361`）。§4.5 只推荐 B，并把 C 推迟到静态 route 残余与 identity/freshness/isolation 有新证据后（`:363-371`）。
- [推断] Flash 已是普通会话默认模型，使 C 的主要历史路由前提更弱；B 的 compaction/wait/bash/eval guardrail 不依赖把普通会话从 Sol 换到 Flash，故推荐方向成立。

### C. canonical owner 复用 — 需修订

- [事实] route snapshot owner、compaction pure function/maintenance、Hub waiter、Bash structured result 和 eval timeout owner 均复用现有 seam：设计 `:105-117,212-222`；代码证据包括 `quality-route-snapshot.ts:71-159`、`engine.ts:383-418,638-652,880-908`、`compaction.ts:295-323`、`session-maintenance.ts:923-969,1028-1044,1084-1105,2031-2047`、`hub/index.ts:337-467`。
- [事实] 新 customType 的 persistence seam 选择正确，但其 resume consumer/dispatcher 和 offline ledger module 未固定到文件/生命周期 dispatch；当前加载路径没有 catch-all consumer。见阻塞项 2。

### D. 控制流 — 需修订

- [事实] §5.2 给出 settings → feature snapshot → workflow route → prompt/compaction/wait/bash/eval → offline ledger 的完整主线（设计 `:384-395`）。Hub 仍为 job promise、IRC waiter、timeout、abort 的 `Promise.race`（`hub/index.ts:337-467`），IRC send 直接 resolve waiter（`irc/bus.ts:101-168`），没有第二等待引擎。
- [事实] 末端 event 流没有定义 append-only start/end 配对、终态更新或 crash closure；`endedAt/outcome` 与“调用起点追加”的时序冲突（设计 `:478-484,499`），resume dispatch 也未绑定 lifecycle/active branch。控制流因此不能兑现 non-overlap ledger 与 usedCalls 恢复。

### E. 配置接口 — 需修订

- [事实] 五个 leaf 默认 off、独立启用，数值要求有限/非负，非法 treatment 配置在 session start 前拒绝（设计 `:429-462`）；现有配置与 schema default 区分正确（`:399-427`）。
- [事实] `evalBudget.usedCalls` 同时被定义为 snapshot 字段、event-only 单一事实来源和 snapshot fallback 载体（设计 `:476,501,503`）；配置/receipt schema 不是单一合同，必须修订。

### F. 失败路径 — 需修订

- [事实] schema、identity、compaction、wait、bash、eval、prompt、snapshot、event、quality gate 均有对应失败行（设计 `:505-523`）；Bash 保留 `isError`/exitCode/timedOut 的既有结果边界（`packages/coding-agent/src/tools/bash.ts:578-705`），eval bridge timeout-pause 语义也有 owner（`src/eval/bridge-timeout.ts:18-64`）。
- [事实] `event_write_failed` 无法由缺少 completeness anchor 的同一丢失 stream 在 resume 时证明，因而与 `used_calls_unknown` fail closed 之间有空洞（设计 `:499-503,520-521`）。其余失败行成立。

### G. 量化口径 — 通过

- [事实] `docs/long-session-latency-analysis.md:17-28,60-72,79-118` 支持 689/306.6h、gen/TTFT、Hub/Bash/eval/search、context bucket、compaction/read/cacheRead 等历史量；设计均按历史事实/算术上限/未验证假设/拟议验收目标分层（设计 `:20-27,73-93`）。
- [事实] 独立算术复核：`212.6×60%=127.56≈127.6`，`266.3×60%=159.78≈159.8`，`(29.1−15.6)×1000/3600=3.75h`。`wc -m=6176`、`wc -c=9981` 也已实测。

### H. 不双算 — 通过

- [事实] 区间并集、组合 arm 只用 `S_combined`、单 feature delta 不相加、factorial interaction、Hub parent wait/child runtime 分离、eval bridge/internal LLM 包含关系见设计 `:95-103,613,629-636`。

### I. A/B baseline — 通过

- [事实] current effective config 先做 control，历史 689 会话仅作背景；同任务分层、同 deterministic verification contract、pilot 每 arm ≥30、promotion 每 arm ≥100 或预注册置信区间见设计 `:33,39-43,583-613`。模型 configured/local/attested 分层和缺 attestation 不冒充样本见 `:606-612`。

### J. 质量停止条件 — 通过

- [事实] 完成率/verifier 2pp、lineage/identity/scope/isolation fail closed、compaction 10%、wait regression、bash hard-block、eval gate、search freshness 和 off→control 均有明确停止条件，并标为拟议门槛而非实测结果（设计 `:615-627`）。

### K. 独立回滚 — 通过

- [事实] §4.2.5 为 prompt、compaction、wait、bash、eval 分别定义独立默认-off leaf 和 control 恢复路径（设计 `:254-287`）；master namespace 缺省/清空的原子关闭语义已明确（`:286`）。四个 tool prompt 资产不改，使 `promptPolicy` off 的回滚可做字节级验证（`:216,456,598`）。

### L. 根因分析章节 — 通过

- [事实] §3 明确不重新发明根因，只把既有证据转成候选，并要求用当前 Flash effective control 验证残余（设计 `:128-157`）。证据文档说明历史 Sol/context、Hub 满时长 wait、Bash 重跑、eval 长尾、search timeout 和晚 compaction（`docs/long-session-latency-analysis.md:17-118`）；当前 Hub smart ladder `[5s,10s,30s,60s,300s]` 由 `packages/coding-agent/src/async/job-manager.ts:10-20` 复核。

### M. 当前配置事实 — 通过

- [事实] `async.enabled=true`、`task.eager=preferred`、`task.batch=true`、四个 agent override、`modelRoles.plan/default`、`compaction.thresholdPercent=70`、`idleEnabled=true` 与 live config 一致（`/Users/sheng/.omp/agent/config.yml:609-628,642-644`）。default-derived `smart/-1` 与 schema 一致；设计 §2.2、§5.3.1、§5.6、§7 无 stale Sol-default 残留（设计 `:109-110,405-427,540,641-642`）。

### N. Handoff — 通过

- [事实] metadata 的 `design_author=deepseek-v4-flash:max`、`revision_round=2`、`planned_reviewer=gpt-5.6-sol`、`implementation_authorization=design-only` 和 round 2 authorization source 均正确（设计 `:6-12`）。§8 指定 host-native 异模型只读 reviewer、单一输入、round 2 完整 Gate、artifact 路径 `...-subagent-review-round-2.md`，并要求任何 PASS/PASS_WITH_NOTES 后仍停在 design-only（`:651-672`）。

## 阻塞项

### 1. 统一 `performanceEvent` 生命周期与 `usedCalls` 单一事实来源

- **影响**: 当前合同不能构造 schema-valid 的 invocation-start event，也不能证明 event stream 无缺口；resume 可能少算 `usedCalls` 并绕过 `callsPerSession`，或无法生成可复查的 non-overlap ledger。
- **证据**: snapshot 含 `usedCalls`（设计 `:476`），event schema 无 `counted`/phase/ordinal（`:478-489`），正文要求 invocation start 写 counted event（`:499`），又声明 event-only source 并提供 snapshot fallback（`:501-503`），失败表允许 event write failure 后 runtime 继续（`:520-521`）。
- **必须修订**:
  1. 只选一个 durable source of truth：event stream，或具备明确 checkpoint/sequence 语义的 snapshot；删除相反合同。
  2. 定义 append-only event lifecycle：例如有共同 `eventId` 的 `started`/`finished` 两条记录，或单独 durable counted-start + terminal record；明确 `counted`、sequence/ordinal、缺口检测、crash/abort closure 和 end outcome。
  3. invocation-start record 无法持久化时，eval budget 当场 fail closed；不能依赖把 `event_write_failed` 再写回同一失败通道。
  4. 修正 `:503` 的 compaction fallback，使其与选定 source of truth 一致；若 CustomEntry retention 是必要前提，应以 focused test 固化而不是留下互相冲突的双源方案。

### 2. 固定 customType 的 resume/ledger dispatch owner 与 active-branch 语义

- **影响**: `appendCustomEntry` 只保存值，不自动路由。若没有显式 lifecycle receiver，两个新 customType 会被静默忽略；若从全 journal 取“最新”而非当前 branch，rewind/branch 后可恢复错误 snapshot 或错误 eval 计数。
- **证据**: 当前 `setSessionFile` 只 load/apply entries（`session-manager.ts:1195-1237`）；CustomEntry 合同要求 consumer 自行扫描（`session-entries.ts:123-136`）；已有 consuming dispatch 是 `autoresearch/index.ts:248-251` → `state.ts:224-228`；`getBranch` 与 `getEntries` 的范围不同（`session-manager.ts:2135-2137,2167-2170`）。设计只写“session 加载路径按 customType 扫描，取最新一条”（设计 `:500`），没有绑定模块、事件和 branch。
- **必须修订**:
  1. 指定 snapshot/event reader 的 canonical 文件/模块和它注册的 `session_start/session_switch/session_branch/session_tree`（或等价核心 lifecycle）dispatch。
  2. 明确在 prompt/feature owner 首次消费前完成 rehydrate，并定义 active branch、fork、rewind 和 resume 的选择规则。
  3. 指定离线 ledger consumer 模块/入口及其 branch/session-end 边界；§6.2 增加非活动分支、缺 listener 和 restore 顺序的 observable tests。

## 非阻塞 Notes

1. `web/search/index.ts:339-340` 是 module-level `webSearchCustomTool` render，不是 constructor；设计 `:216` 把两个位置统称为 constructor 是证据措辞误差，不改变“不改静态资产”的结论。
2. `buildSystemPrompt` 会在 tool-set/host prompt 变化时从头重建（`session-tools.ts:606-612,962-969`）。实现 `on 仅一次` 应表示“每次重建后的最终 system prompt 恰有一份 policy、不会累积”，而不是一次置位后让后续重建丢失 policy；§6.2 的字节/重复增长测试应覆盖重建路径。
3. 本次是设计 Gate，只执行了读取、SHA-256/wc/算术复核；按用户要求未运行 formatter、linter、build 或全量测试套件。未把测试文件存在当作行为已通过。

## 实现前必须满足

1. 修订并闭合上述两个阻塞项；round 1 阻塞项 2 只有在 event schema、durability、resume dispatch 和 active-branch 测试合同同时单一且可执行时才算解决。
2. 保持已验证闭合的 round 1 阻塞项 1/3 和 Notes 1–4：Flash effective control、explicit/default-derived receipt、四个 tool prompt 资产不变、off 字节等价、master namespace 原子关闭和“文件存在≠覆盖合同”不得回退。
3. 因阻塞项涉及跨模块数据结构、持久化/恢复、错误行为和验收义务，修订后必须重新计算输入 manifest/reviewed_revision，并再次执行完整 Design Review Gate；不能用 Continuity Note 延续本 verdict。
4. `implementation_authorization` 继续为 `design-only`；在新的通过 verdict 与另行实现授权出现前，不得进入实现、提交或发布。
