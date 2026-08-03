# Review: omp Latency Optimization Plan (claude-opus-5 design)

- Date: 2026-08-03
- Review mode: host-native read-only agent (gpt-5.6-sol xhigh), independent lineage from author
- design_author: claude-opus-5 (xhigh)
- reviewer: gpt-5.6-sol xhigh (sol-xhigh-reviewer agent)
- information_base_author: deepseek-v4-flash:max
- Gate type: full Design Review Gate
- Verdict: **NEEDS_REVISION**

## Verdict summary

核心方向仍可保留，但当前设计不能进入实现。阻塞原因：

1. 当前配置/能力基线已漂移（引用的 `task.agentModelOverrides`、`compaction.thresholdPercent=70`、`idleEnabled=true`、`task.eager=preferred` 在 review-time config 中不存在，多数是 schema 默认值而非显式配置）；
2. 方向 1 重复已有 ordinary-session truncation canonical seam（普通会话已调用共享 `processToolOutputDetailedAsync`，只是 `modelOptimization.enabled` 默认 false）；
3. 方向 4 的主-agent 编排合同与实际 workflow/task/hub 控制流不匹配（`task-batch.ts` 不存在、`await:true` 仅属 hub send、review stage 是直接 `RuntimePort.run`）；
4. §2.1 的小时数（40-60h 等）不是可复现的"算术上限"，是带未测比例的场景估算。

## Evidence

### [fact verified]

- 历史池分解准确复述证据：`docs/long-session-latency-analysis.md:17-28`（689 会话、306.6h、gen 174.3h/TTFT 92.0h/hub 21.3h/bash 6.2h/eval 3.7h/web_search 3.7h）；`:60-75`（Sol 17,205 轮、gen 136.9h、TTFT 75.7h、ctx<100k 15.6s、ctx≥200k 29.1s）。字符/字节单位复核为 6,176 chars / 9,981 UTF-8 bytes。
- 当前 `modelRoles.default = gateway/deepseek-v4-flash:max` 成立（`/Users/sheng/.omp/agent/config.yml:9-19`）；同一文件当前显示 designer/task/advisor=terra、slow=sol，**没有** `task.agentModelOverrides`、compaction 或 async/task override。
- hub 当前确为事件驱动：`packages/coding-agent/src/tools/hub/index.ts:386-456`（job promises/IRC waiter/timeout/abort 的 `Promise.race`）；smart 阶梯在 `src/async/job-manager.ts:10-21`。
- auto-thinking classifier 存在：`src/auto-thinking/classifier.ts:1-18,53-72`；online backend 默认见 `settings-schema.ts:5234-5244`。但 classifier 只在 thinking level=`auto` 时生效；全局 `defaultThinkingLevel` 默认是 `high`（`settings-schema.ts:1064-1069`）。
- ordinary-session read 无"内容已在上下文"的 session dedupe：`src/tools/read.ts:143-147` 的 hash/LRU 只缓存 deterministic summary parse，仍每次 fresh-read bytes；workflow exact-hash dedupe 在 `src/workflow/context-ledger.ts:145-213`。
- 设计保留了 Plan B 的 A/B 基本纪律（单 feature arm、`S_combined`、interval union、2pp/10%/lineage 停止条件，见设计 `:384-425,460-467`）。
- design-only 元数据与目标 artifact path 正确（设计 `:9`、`:553-555`）。

### [claim contradicts source]

- 设计 `:43-45` 称当前有 `task.agentModelOverrides`、`compaction.thresholdPercent=70`、`idleEnabled=true`、`task.eager=preferred`。review-time config 不含这些键；effective schema 默认分别为 `{}`（`settings-schema.ts:4817-4820`）、`-1`（`:2154-2157`）、`false`（`:2248-2251`）、`default`（`:4645-4649`）。只有 `async.enabled=true`（`:4134-4137`）与 `task.batch=true`（`:4662-4665`）成立。
- 设计 `:47,50,132,490` 称 truncation"只存在 workflow、ordinary path 缺失"。实际 ordinary path 已在 `src/session/agent-session.ts:3046-3085` 调用共享 `processToolOutputDetailedAsync`，per-family rules 在 `src/model-optimization/default-profiles.ts:9-27,53-111`；只是 `modelOptimization.enabled` 默认 false（`settings-schema.ts:4506-4509`）。
- 设计 `:192,199,325` 把 `await:true` 写成 hub wait 参数。实际 schema `src/tools/hub/index.ts:75-82` 中 `await` 只属于 `op="send"`；`op="wait"` 自身已执行事件 race。
- 设计 `:191` 指向不存在的 `src/task/task-batch.ts`。实际 batch owner 是 `src/task/index.ts:697-718`，并发原语在 `src/task/parallel.ts:1-126`；workflow work-package owner 是 `src/workflow/work-packages.ts:1-28,65-70`。
- 设计 `:257` 称 slow/designer/reviewer 当前 blanket-use Sol；review-time config 只有 slow=sol，designer=terra，且没有 reviewer override。
- 设计 `:93,257` 假定 luna/terra TTFT≈4s；证据 `docs/long-session-latency-analysis.md:73` 明确 Sol/Luna 为 16-17s，4s 对应 deepseek-v4-flash/grok-4.5，Terra 无实测值。

### [claim unverifiable]

- §2.1 的 40-60h / 10-18h / 7-10h / 3-6h / 2-3h（设计 `:93-97`）是带未测比例的场景估算。按文档自己的 16s→4s 假设，35% Sol TTFT 迁移节省应为 `75.7×0.35×(1-4/16)=19.87h` 而非 `75.7×0.35≈26h`；而 Luna 又不是 4s。方向 1 的 `92×0.3×13.5/29.1=12.80h` 把"30% turns"当作"30% TTFT hours"并把 Sol 桶差比例套到全部 92h。prior Plan B 明确要求受影响轮次数未知时"不外推总小时"（`:83,239`）。
- 方向 4 的 30-50% 可消比例无 corpus 分类支撑；方向 3 的 3-6h 等于整个 bash 池 48.4%-96.8%；方向 5 的 2-3h 等于 eval 池 54.1%-81.1%，且后台化只有存在可重叠独立工作时才缩短 critical path。
- "并行 N reviewers 与当前串行语义等价"未成立：当前每个 review stage 是一次直接 `RuntimePort.run`（`src/workflow/engine.ts:1092-1131,1253-1331`），artifact 是单 reviewer header/decision（`workflow/types.ts:154-160`、`workflow/schemas.ts:96-115`）；设计未定义多 reviewer artifact、identity receipts、冲突/置信度/失败聚合、持久化恢复或取消语义。

## Findings

### [BLOCKING][current baseline]
- **Exact claim**: §1.2（设计 `:43-50`）把 task overrides、compaction 70%+idle、task.eager=preferred、auto-thinking-active、workflow-only truncation 呈现为当前事实。
- **Why wrong/risky**: review-time config.yml 与 schema 默认值与之矛盾；实验会用错误 control。
- **Fix**: 用带日期的 effective-settings receipt 替换静态清单，区分 explicit vs default-derived；旧配置值标为 historical；明确 auto-thinking/truncation 的激活条件。

### [BLOCKING][no second engine / direction 1]
- **Exact claim**: §4.a 提议新建 `session/tool-output-processor.ts`、`performance.contextVolume.truncation.*` 并抽取 `processToolOutputDetailed`（`:138-146,172-174`）。
- **Why wrong/risky**: 普通会话已调用共享 canonical manager（`agent-session.ts:3046-3085`），由 `modelOptimization.enabled` 门控；新 namespace/processor 造成竞争 ownership 与回滚行为。
- **Fix**: 方向 1.c 设计为现有 `modelOptimization` profile + `workflow/tool-output-manager.ts` seam 的激活/扩展，保留现有 per-tool 规则、fail-closed recovery 与 receipts；不新建 truncator 或重复 config owner。

### [BLOCKING][read dedupe correctness]
- **Exact claim**: §4.a 从 session-scoped `sha256(path + content)` LRU 返回"已在上下文中"，文件变化或 `fresh` 请求时失效（`:138,145-147`）。
- **Why wrong/risky**: session presence ≠ provider-context presence（compaction、eviction、branch/rewind、model switch、不同 read selector/display mode 后）；`fresh` 不是现有 read contract。可能抑制模型已不再持有的内容。
- **Fix**: 指定 branch/provider-view-aware 状态；含 normalized selector/range/display mode 与不可变内容哈希；compaction/rewind/model-context 重建时 reset/reconcile；提供兼容的 force/full-read override；presence 不确定时 fail open 到全文。

### [BLOCKING][main-agent concurrency contract]
- **Exact claim**: §4.b 说主 agent 声明 group/max/dependency/isolation/rendezvous 后由 `task-batch`/hub 执行并行 reviewer（`:184-201`）。
- **Why wrong/risky**: `task-batch.ts` 不存在；workflow review stage 直接调 `RuntimePort.run` 而非 hub/task；`await:true` 是 send-only；无 typed declaration 载体（WorkflowRequest/PlanArtifact/stage policy），无 durable state、cancellation、resume、backpressure、dependency validation、rendezvous 失败语义。
- **Fix**: 增加 versioned declaration schema + owner（request/plan/stage policy），映射到实际 `task/index.ts`/`task/parallel.ts` 或 workflow `RuntimePort`；定义状态迁移与 receipt。

### [BLOCKING][parallel review semantics]
- **Exact claim**: §4.b 用 all-pass/any-block 聚合 N reviewers 并称串行等价（`:190-201,225`）。
- **Why wrong/risky**: 当前 control 是单 reviewer，ReviewArtifactV1 只有单个 model identity 与 decision；加 reviewer 改变 workload、block 概率、质量与 artifact schema；advisor exact-text note dedupe 不是 finding merger。
- **Fix**: 定义 multi-review envelope（每个不可变 review + identity receipt、确定性 finding fingerprint/provenance、decision/confidence 冲突策略、失败 quorum、聚合 artifact）；A/B 用相同 N reviewers/assignments/models/gate policy 的并行调度对照串行 control，而非对照当前单 reviewer。

### [BLOCKING][benefit labels and ordering]
- **Exact claim**: §2.1 把 40-60h > 10-18h > 7-10h > 3-6h > 2-3h 标为算术上限（`:91-101`）。
- **Why wrong/risky**: 公式用未测转换比例、把 Sol 比例套到全模型池、一项把快模型延迟当零、假设未测重叠机会；evidence #2 明确禁止无受影响轮次数的总小时外推。
- **Fix**: 只保留真实算术恒等式（如每 1,000 受影响 Sol 轮 3.75h；21.3h×实测可消比例），范围改标 `[未验证假设]/scenario estimate`；Phase-0 residual-pool 数据前移除排序断言；报告置信区间。

### [HIGH][direction 2 routing evidence/owner]
- **Exact claim**: §4.d 把机械工作路由到 Luna/Terra（~4s）并扩展 `session/role-models.ts`/`config/model-resolver.ts`（`:257-292`）。
- **Why wrong/risky**: 证据说 Luna 是 16-17s、Terra 未测；当前角色并非 blanket Sol；workflow 路由 canonical owner 是 `workflow/model-router.ts`、`session-config.ts`、`quality-route-snapshot.ts`，有固定 WorkflowRole union。
- **Fix**: 等 live configured/local/attested latency receipts；只经 workflow role/tier owner 路由；定义显式 task-class taxonomy source/schema；class/lineage 不确定时 fail closed。静态 stage 路由不必违反"无动态单轮路由"约束。

### [HIGH][feature isolation/order]
- **Exact claim**: §5.2 说必做优先，但 Phase 2a 把酌情项 3、5 放在必做编排 4.a/4.b 之前（`:357-379`）；§5.3 给 4.b 的 arm 无真实独立开关；Plan B bash advisory 与方向 3 failure injection 都依赖重叠 fingerprint 状态。
- **Why wrong/risky**: 核心范围可被拖延；marginal attribution 与回滚不独立；重复 bash tracker 有第二引擎风险。
- **Fix**: Phase 0 后先落地全部核心合同 1.c/1.a/4.a/4.b 再做酌情行为；4.a/4.b 给显式独立开关/快照；advisory 与 cause-injection 实现为单一 canonical bash failure ledger 上的两种模式。

### [HIGH][A/B and ledger discipline]
- **Exact claim**: §5.4/§6 用 interval union 复算 306.6h baseline（`:404-417,473-492`），但 evidence #1 的历史活跃时间定义是 gen+TTFT+tool durations；计划遗漏 prior Plan B 的 30/100 会话或置信区间纪律。
- **Why wrong/risky**: legacy 总量在新 union ledger 下可能不可复现；并行 reviewer arm 可能不可比；2pp/10% 触发可能打在噪声上。
- **Fix**: 维护 legacy-reproduction ledger 与独立 canonical non-overlap ledger，量化两者 delta；预登记同期随机化/配对分配、样本量或 CI 规则、相同 model availability；gate 并行用相同 reviewer roster/workload；用 attested modelFamily/checkpoint 分层。

### [MEDIUM][handoff/evidence hygiene]
- **Exact claim**: §7.1 的 Review Inputs manifest（`:530-534,595-612`）遗漏被评审设计本身，反而包含 `.omp/agents/opus5-designer.md`；§4.a 嵌入一次性绝对路径（`:129`）。
- **Why wrong/risky**: review hash 无法标识被评审 revision；设计不可移植。
- **Fix**: manifest 含本设计 + 三个证据文档；重算 reviewed_revision；结论传输用 canonical `artifact://`/`local://` contract 而非用户/会话特定绝对路径。

### [NOTE][supported omissions]
Repeat-read discipline 未被遗漏（方向 1 覆盖，但 runtime contract 需上述修复）。Compaction-threshold verification 在 Phase 0/Plan B arms 中，但必须用刷新后的 effective config。web_search cache/merge 可接受省略（池仅 3.7h/1.2%）；保留 query-merging 纪律与观测，本修订不加缓存。

## Reviewed Inputs

```
docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md	f04123c429f338da8f969accb6635b47d9b3209b3416f1ffc74f315ca759c71b
docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md	cc8fbc97e9423224ced820b2b8fb9397f39ec890587dffda2ac70990c2242bb0
docs/long-session-latency-analysis.md	0fd71c4dc5ad665b65118f0d80381ee5800360c31b72ca0800715218e3048089
docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md	42f8e15a22ae2c22f62be233200b2b2dcafd373b67f348303c60e56f39c269b9
```

## Next step

NEEDS_REVISION → 回到设计文档修订：由 claude-opus-5 按上述 BLOCKING/HIGH findings 修订（正确基线 receipt、方向 1 改为激活现有 modelOptimization seam、方向 4 映射到真实 task/parallel.ts 与 RuntimePort、收益改标 scenario estimate、阶段顺序核心优先、manifest 修复），修订后重新执行完整 Design Review Gate；通过前不得实现。
