# Subagent Review: Subagent 延迟优化设计

## 1. Gate 元数据

- **review_status**: completed
- **verdict**: **NEEDS_REVISION**
- **review_mode**: host-native
- **reviewer_model**: GPT-5.6-sol xhigh
- **reviewer_native_model_slug**: `gpt-5.6-sol-xhigh`
- **reviewer_native_agent_id**: `86139fdc-2f49-4d60-b3ac-f675c51312da`
- **design_author**: grok
- **design_author_identity**: GrokDesigner
- **design_author_model**: `cursor-grok-4.6-xhigh-fast` / Grok 4.6
- **author_session**: `828d28f6-7f8e-4f61-8ce2-05ac51a8d3dd`
- **author_opaque_task_id**: 当前 transcript 不可见
- **review_fallback**: none
- **fallback_reason**: not-applicable
- **implementation_authorization**: design-only
- **authorization_source**: 用户仅授权根因分析和完整优化方案设计，未授权修改代码、`~/.omp` 配置或发布
- **artifact_target**: `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md`

## 2. Reviewed Inputs

### 2.1 冻结输入清单

以下哈希由 reviewer 从 raw bytes 独立复算，并按 repo-relative POSIX path 排序：

```text
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md	fa5c4eb21ea5c34b40df3b1fed7ab316587cfc11a605a1a66a13dd79b9afbabd
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md	bd6693c1d899cfd61df04fd83a54f76d42f4ecaf50aadaa3c1c65059de6b3e45
```

独立复算的 `reviewed_revision`：

```text
24b0169eb4bde4ec94258b2d16fe18d896e12730641591d3b143305099039098
```

### 2.2 与父协调者预计算值交叉校验

- design SHA-256：**MATCH**
- facts brief SHA-256：**MATCH**
- reviewed_revision：**MATCH**
- 路径、排序、UTF-8、制表符及尾随换行规范：**MATCH**

未发现遗漏的冻结设计输入。8/26 quality/session 设计、源码及现有测试仅作为验证证据，不加入 Reviewed Inputs manifest。

## 3. 整体结论

**NEEDS_REVISION**

方案 A 的方向可以保留：它复用现有 TaskTool、structured-subagent policy、review-performance helper、system prompt 和 workflow benchmark owner，没有必要新增 scheduler、completion engine 或通用 role 框架。

当前设计仍不能进入实现，主要阻断为：

1. 75% soft-runtime 会设置 `budgetStopRequested`；协作式 wrap-up 即使提交完整 verdict，最终仍会成为 `completionKind="budget_stop"`，与设计的 PASS 语义冲突。
2. 设计要求 hard cap 同时读取 spawn 参数和解析后的 agent frontmatter，但当前 TaskTool 在进入 fresh settings reload/discovery 前已经预解析并传入 `maxRuntimeMs`。
3. 设计把 shadow eligibility 的 `"code"/"off"` precedence 直接复用于尚不存在的 performance-class contract，形成跨边界耦合和误分类风险。
4. 现有 quality gate 确实会 fail-close timeout/budget-stop，但新 TaskTool product fixture、旧行为 baseline 与现有 paired gate 的连接方式没有定义。
5. `read-summarize` 合并语义、延迟统计协议及 hang regression 映射仍不足以机械验收。

75% wrap-up finding 归类为 **HIGH**，不是 CRITICAL：它会阻断按现文实施，但只需在当前方案 A 内修正终态合同，不要求推翻整体方案或重新设计运行架构。因此总体 verdict 保持 NEEDS_REVISION，而非 NEEDS_REDESIGN。

## 4. 根因评审

### 4.1 总体根因结论

**WEAK_EVIDENCE**

设计确认了多项真实、可操作的宽松约束，但现有证据主要由配置事实、历史会话统计和少量长任务案例组成。缺少 request/tool timeline 或 treatment 对照，无法量化各因素对 14.8 分钟 scout p50、20 分钟 review/gate p50 的贡献。

证据足够支持“在现有 owner 上小步收紧并实测”，不足以证明 10min、40 requests 或 75% wrap-up 会必然产生拟议 p50/p90。

### 4.2 分项根因结论

#### RC-1：角色级 hard cap 覆盖不足

**结论：SUPPORTED**

证据：

- `packages/coding-agent/src/task/index.ts:56-70` 当前 30 分钟 ceiling 只识别四个固定 agent 名。
- `packages/coding-agent/src/task/index.ts:787-802` 与 `:1591-1629` 在 TaskTool 请求中预解析并传入 `maxRuntimeMs`。
- `packages/coding-agent/src/task/structured-subagent.ts:257-268` 才执行 fresh settings reload 和 agent discovery。
- `packages/coding-agent/src/task/structured-subagent.ts:395-452` 将请求中的预解析 `maxRuntimeMs` 原样交给 executor。

因此 custom reviewer/explore 的 hard-cap seam 确实不足。限制是 hard cap 只能约束尾部，不能单独证明正常完成的 p50 会下降。

#### RC-2：review/explore request budget 偏宽

**结论：SUPPORTED（机制）；WEAK_EVIDENCE（数值）**

证据：

- `packages/coding-agent/src/task/review-performance.ts:4-16` 当前 reviewer 集合及 80-request cap 依赖固定名称。
- `packages/coding-agent/src/task/review-performance.ts:61-69` 当前 soft request cap helper 只接收 agent name 和 configured budget。

扩展分类 seam 有源码依据；但当前材料没有逐次 request 耗时和质量曲线，无法证明 40/80 是最优阈值。

#### RC-3：subagent prompt 缺少显式时间意识

**结论：SUPPORTED（文本缺口）；WEAK_EVIDENCE（性能归因）**

证据：

- `packages/coding-agent/src/prompts/system/subagent-system-prompt.md:45-57` 要求未完成时继续 tool call，并将 `yield` 设为唯一完成出口。
- `packages/coding-agent/src/prompts/system/subagent-system-prompt.md:70-73` 进一步要求一直继续到 ticket closed。
- 当前 prompt 没有按 review/explore/worker 注入时间预算和收敛优先级。

文本缺口真实存在，但没有 prompt-only A/B 数据证明它是主要耗时来源。

#### RC-4：scout 使用 max thinking 且禁用 read summarization

**结论：SUPPORTED（配置事实）；WEAK_EVIDENCE（因果）**

证据：

- `packages/coding-agent/src/prompts/agents/scout.md:1-10` 实际配置为 `thinking-level: max`、`max-effort: max`、`read-summarize: false`。
- `packages/utils/src/frontmatter.ts:20-38` 会递归将 kebab-case key 转为 camelCase。
- `packages/coding-agent/src/discovery/helpers.ts:300-338` 将 `readSummarize` 解析为 boolean，将 `shadowReview` 解析为 `"code"`。
- `packages/coding-agent/test/discovery/agent-fields.test.ts:143-161` 验证了 boolean/string `readSummarize` 及非法值处理。

因此 `read-summarize` 的拼写和解析类型没有问题。尚无对照证据证明它贡献了多少 active wall-clock。

#### RC-5：历史 hang 是本轮延迟主因

**结论：NOT_APPLICABLE**

设计将 malformed yield、post-yield、O(n²) persistence 和 event-loop wedge 明确列为不得回归的相邻边界，而非本轮修改 owner。现有材料也没有证明这些历史问题解释了本轮长时间但仍持续读文件的会话。

### 4.3 因果链一致性

- **一致**：固定名称 cap、统一 keep-going、scout 配置和用户 xhigh/full-fidelity 叠加均有证据支持。
- **一致**：在根因贡献未量化时选择浅层方案 A，而不是改完成协议，符合证据强度。
- **不充分**：10min、40req 和 75% 是拟议 treatment 参数，不是历史证据推导出的必然结果。
- **缺失**：产品 fixture 的 active-wall producer、旧行为 baseline 和统计协议尚未落实到可执行 owner。
- **结论**：根因链支持实验方向，但不支持数值因果承诺。

## 5. 设计评审

### 5.1 需求与方向

优点：

- 明确区分产品默认与用户 overrides。
- 使用 active wall-clock 排除 parked 时间。
- 保留独立 Design Gate 和代码双轴，不以取消他审换延迟。
- 保留 yield 协议，避免重做历史 hang owner。
- 明确 timeout、budget-stop 和缺口不得 PASS。
- 提供 kill switch、回滚边界和非目标。

缺口：

- 产品 fixture 没有冻结重复次数和 percentile 算法。
- active-wall 只有文档算法，未指定 fixture 的权威 producer。
- TaskTool hard-cap 与 workflow paired quality gate 的覆盖边界没有闭合。

### 5.2 方案合理性

方案 A 是当前证据下更浅、更合理的路径。但 review/explore/worker 分类必须在 effective agent 已解析后产生一次，并由 runtime、request budget 和 prompt 共享。

`shadowReview` 只能作为分类信号之一：

- spawn `"code"` 是明确的 code-review cohort intent。
- agent frontmatter `"code"` 是 agent 定义上的 shadow-review opt-in。
- spawn `"off"` 在现有源码中会关闭 shadow eligibility。
- 这些事实不能自动推出 performance-class 必须使用完全相同的 precedence。

设计应显式定义新的 performance-policy 判断，而不是把 shadow eligibility 隐式升级为通用角色系统。

### 5.3 实现可行性

已确认可用 seam：

- `TaskItem.shadowReview`：`packages/coding-agent/src/task/types.ts:140-156`
- `TaskParams.shadowReview`：`packages/coding-agent/src/task/types.ts:301-321`
- TaskTool 执行时传递 spawn `shadowReview`：`packages/coding-agent/src/task/index.ts:1591-1629`
- fresh settings reload、discovery 和 effective agent：`packages/coding-agent/src/task/structured-subagent.ts:257-338`
- workflow adapter 产生 `"code"`：`packages/coding-agent/src/workflow/runtime-adapter.ts:417-445`
- production runner 继续传给 structured runner：`packages/coding-agent/src/workflow/runtime-default.ts:66-99`
- frontmatter 解析：`packages/coding-agent/src/discovery/helpers.ts:300-338`
- completion provenance 及 fail-closed quality gate 已存在。

按现文不可直接闭合的 seam：

- `resolveTaskMaxRuntimeMs` 在 TaskTool 侧按 name 预计算，而 frontmatter 要到 structured policy 阶段才可用。
- `resolveReviewerSoftRequestBudget` 和 `resolveReviewerSoftRuntimeMs` 当前只接收 name。
- 75% timer 当前不是纯提醒，而是 budget stop。
- `read-summarize: true` 当前不会强制覆盖用户关闭状态。

### 5.4 文档质量

文档能够区分历史事实、推导、未知和拟议目标，方案 A/B 比较也较完整。

影响实施的文档问题包括：

- soft-runtime 终态语义前后冲突；
- hard-cap 数据时序与当前 owner 不匹配；
- performance classification precedence 未与 shadow eligibility 边界分离；
- paired quality baseline/producer 未定义；
- hang 要求未落到测试路径与 observable contract。

## 6. Findings

### CRITICAL

无。

### HIGH

#### [HIGH] 75% wrap-up 与 `budget_stop` 的终态合同冲突

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:170-176`
- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:220-228`
- `packages/coding-agent/src/task/executor.ts:1306-1323`
- `packages/coding-agent/src/task/executor.ts:980-1001`
- `packages/coding-agent/src/workflow/benchmark/runner.ts:552-576`
- `packages/coding-agent/test/workflow/p012-production-wiring.test.ts:1330-1347`

**问题**

设计同时要求：

1. 75% 时进入 wrap-up；
2. wrap-up 后提交完整 verdict 算正常完成；
3. `budget_stop` 不得 PASS。

当前 soft-runtime timer 在 75% 调用 `requestBudgetStop("runtime_timeout")`。若 agent 在 hard timeout 前协作式 yield，`runtimeLimitExceeded()` 仍为 false，但 `budgetStopRequested()` 为 true，因此 `resolveSubagentCompletionKind` 返回 `budget_stop`。

现有 quality gate 会拒绝任何非 `completed` completion kind；现有 regression test 也明确验证 `budget_stop` 即使 runtime 自报 passed 仍不可 PASS。

**影响**

真正触发 wrap-up 的 reviewer 无法同时满足“完整 verdict 正常完成”和“budget-stop 不 PASS”。按现文实现会制造系统性假失败。

**建议**

在当前方案 A 内冻结一个无矛盾合同：

- 推荐：75% 只发送一次 wrap-up notice，不设置 `budgetStopRequested`；hard cap 前完成则为 `completed`，到达 hard cap 才为 `timeout`。
- request-count 的 1.5× forced stop 继续保持 `budget_stop` 且 fail-closed。
- 若要新增 completion kind，必须明确其 producer、gate 语义和 regression tests，不能复用同一个 `budget_stop` 表达两种结果。

**严重度说明**

该问题阻断实施，但修复只涉及当前方案的 notice/terminal provenance 合同，无需推翻方案 A 或重做系统架构，因此定为 HIGH，对应 NEEDS_REVISION。

#### [HIGH] hard-cap 设计使用了当前调用时序中尚不可用的 frontmatter

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:170-199`
- `packages/coding-agent/src/task/index.ts:56-70`
- `packages/coding-agent/src/task/index.ts:787-802`
- `packages/coding-agent/src/task/index.ts:1591-1629`
- `packages/coding-agent/src/task/structured-subagent.ts:257-268`
- `packages/coding-agent/src/task/structured-subagent.ts:323-348`
- `packages/coding-agent/src/task/structured-subagent.ts:395-452`

**问题**

设计要求 `resolveTaskMaxRuntimeMs` 同时接收：

- agent name；
- spawn `shadowReview`；
- 解析后的 `agent.shadowReview`。

当前 TaskTool 在构造 `StructuredSubagentRequest` 时先调用 `resolveTaskMaxRuntimeMs(session, params.agent)`，将数值放入 `request.maxRuntimeMs`。随后 `resolveEffectiveSubagentPolicy` 才 reload settings、discover agent 并得到 `agent/effectiveAgent`。`buildExecutorOptions` 又将预解析数值原样传给 executor。

因此，文档所述“改 `task/index.ts` helper 接收已解析 frontmatter”在当前时序上没有数据来源。

**影响**

直接实施可能导致：

- custom frontmatter reviewer 不进入 30 分钟 ceiling；
- hard cap、soft request budget 和 prompt 对同一 agent 得出不同分类；
- 为获取 frontmatter 重复 discovery；
- settings reload 前后的 runtime policy 不一致。

**建议**

将 performance policy 的权威计算点放到 `resolveEffectiveSubagentPolicy` 已完成 fresh reload/discovery 之后：

1. 解析一次 review/explore/worker performance class；
2. 以 fresh configured value 计算 effective runtime；
3. 将 classification/effective runtime 传给 executor 和 prompt；
4. TaskTool 不再预先按 name 计算角色 cap。

不新增通用 role 框架，可将结果作为现有 `EffectiveSubagentPolicy` 的最小字段。

#### [HIGH] 将 shadow eligibility precedence 直接复用于 performance class 缺少合同依据

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:170-188`
- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:232-240`
- `packages/coding-agent/src/shadow-mind/eligibility.ts:14-22`
- `packages/coding-agent/src/task/types.ts:140-156`
- `packages/coding-agent/src/task/types.ts:301-321`

**代码事实**

`isShadowReviewQualified` 当前先检查 `spawnShadowReview === "off"`，因此在 **shadow eligibility** 中，spawn `off` 会覆盖 agent frontmatter `"code"`；spawn `"code"` 则会显式启用 cohort。

当前源码没有 review/explore/worker performance-class contract，因此不能声称现有代码已经规定 `off` 应保留或抹除 performance role。

**架构判断**

设计把上述 shadow eligibility precedence 直接用于 10/30 分钟 cap、request budget 和 prompt 行为，扩大了 `shadowReview` 的责任：

- custom agent 即使 frontmatter 声明 `"code"`，spawn `off` 也会退化为 worker；
- 非 review worker 若误带 spawn `"code"`，会被压入 review budget；
- assignment、output schema 或实际 agent contract 不参与校验。

设计将误标解释为“调用方选择”，但没有定义调用方承担的是 shadow cohort opt-in，还是完整 performance-policy opt-in。

**影响**

一个原本用于 shadow cohort 的开关会隐式控制 hard timeout 和工作预算，形成跨边界耦合。误分类可能截断非 review 工作，或让 reviewer 逃出限制。

**建议**

明确区分事实层和新设计层：

- floor 名称、agent frontmatter 和 spawn intent 是三个独立输入；
- spawn `"off"` 继续关闭 shadow cohort；
- performance-policy 是否保留 frontmatter role必须由设计单独定义；
- spawn `"code"` 若被视为显式 performance opt-in，需在 schema description、调用方文档和测试中明确其 30 分钟/80-request 后果；
- 增加“frontmatter code + spawn off”和“普通 worker + spawn code”两个负面边界测试。

#### [HIGH] product fixture 与现有 paired quality gate 的 producer/baseline 未闭合

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:250-260`
- `packages/coding-agent/src/workflow/benchmark/live-runtime.ts:300-308`
- `packages/coding-agent/src/workflow/benchmark/live-runtime.ts:658-714`
- `packages/coding-agent/src/workflow/benchmark/runner.ts:540-576`
- `packages/coding-agent/test/workflow/p012-production-wiring.test.ts:1325-1347`
- `packages/coding-agent/test/workflow/benchmark/live-runtime.test.ts:713-720`

**已确认能力**

- paired gate 要求同时存在 baseline 与 optimized。
- live quality 默认至少要求固定 repetitions。
- missing `completionKind` 会 fail closed。
- `budget_stop`、`timeout` 等非 completed kind 会判 non-PASS。
- live runtime 会从 workflow status report 聚合最坏 completion kind。
- regression tests覆盖 missing kind、budget-stop 和最坏 kind 聚合。

**问题**

设计新增的 bundled scout/reviewer“原生 TaskTool product fixture”没有说明：

1. 哪个 producer 将 TaskTool 结果变为 benchmark runs；
2. 如何进入 `evaluateBenchmarkQualityGate`；
3. 哪部分覆盖 `task/index.ts`/structured-subagent 的 hard-cap 分类路径；
4. baseline 如何代表修改前的 role policy。

现有 live benchmark 的 baseline/optimized 主要切换 profile/presentation strategy；在同一修改后的 binary 中，两臂仍会共享新 bundled prompt、角色分类和全局预算，不能自然构成“旧 subagent policy vs 新 policy”。

**影响**

timeout≠PASS 已有可靠 owner，但 quality non-regression 和 hard-cap product fixture 可能无法证明本次改动相对旧行为没有回退。

**建议**

设计应冻结：

- TaskTool runtime fixture 的 producer 和输出字段；
- 哪些 contract tests覆盖分类/hard cap；
- 哪些 workflow paired cases覆盖 verdict、known defect 和 first-pass；
- 修改前 baseline 的冻结方式；
- `completionKind`、runtime provenance、verdict、缺陷检出、first-pass 和 duration 如何进入同一个 gate。

继续复用现有 `evaluateBenchmarkQualityGate`，不得新建第二套质量判定器。

### MEDIUM

#### [MEDIUM] `read-summarize: true` 不能按当前合并逻辑保证启用

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:194-211`
- `packages/coding-agent/src/task/executor.ts:2919-2923`
- `packages/coding-agent/src/task/persisted-revive.ts:88-90`
- `packages/coding-agent/test/discovery/agent-fields.test.ts:143-161`

**问题**

parser 能正确解析 `true/false`，但 child settings 只在 `agent.readSummarize === false` 时写入 override；`true` 不会覆盖父设置中的关闭状态。persisted revive 使用同样的 false-only 合并。

**影响**

把 scout frontmatter 改为 `read-summarize: true` 后，部分用户仍可能保持关闭状态，产品 fixture 与用户实际行为不一致。

**建议**

设计明确：

- `true` 是强制 agent policy，初始 spawn 和 revive 都必须覆盖；或
- `true` 只是默认建议，不覆盖用户配置，并从确定性优化杠杆中移除。

加入用户关闭、agent true/false 和 revive 的 precedence contract tests。

#### [MEDIUM] 延迟目标缺少完整的产品 fixture 统计协议

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:25-47`
- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:250-260`
- `packages/coding-agent/src/task/review-performance.ts:95-100`

**问题**

设计已给出 active-wall 算法，并为用户语料规定 review n≥20、scout n≥8；但产品 fixture 未冻结：

- 每个 variant 的重复次数；
- p50/p90 estimator；
- cache/warmup、case 顺序、并发和模型身份；
- active-wall 事件由哪个 fixture producer生成。

同时，explore 的 75% checkpoint 是 7.5 分钟，距离 p90≤8 分钟仅 30 秒；review 的 22.5 分钟 checkpoint 晚于 p90≤20 分钟目标。该机制本身不能保证目标。

**影响**

不同执行者可能用不同样本量和 percentile 算法得到不同 Gate 结果；拟议参数容易被误读为目标保证。

**建议**

冻结产品 fixture 的最小重复次数、percentile 算法、运行隔离和 active-wall producer；明确 10min/40req/75% 均为 treatment 参数，未达 p50/p90 即不得宣称成功。

#### [MEDIUM] hang non-regression 未映射到可执行测试矩阵

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:250-255`
- `packages/coding-agent/test/turn-persistence.test.ts:1-14`
- `packages/tui/test/loop-watchdog.test.ts:229-274`
- `packages/coding-agent/test/agent-session-yield-empty-stop-suppression.test.ts:1-9`
- `packages/coding-agent/CHANGELOG.md:705-706`

**问题**

设计要求 #4957、#8462、#3629、#5372 相关测试仍绿，但未提供 issue→test→observable contract 映射。

当前可直接定位的证据并不等价：

- `turn-persistence.test.ts` 明确绑定 #3629 的 O(n²) persistence contract；
- `loop-watchdog.test.ts` 明确提到 #5372，但验证的是长 CPU wedge 的监测分类，不是 9-child 不楔死的完整回归；
- terminal-yield suppression test 绑定的是 #3389/#4963；
- #8462 在 changelog 中有修复记录，但设计未指出其 regression test；
- #4957 的具体可执行测试也未被设计定位。

**影响**

“相关测试必须仍绿”无法机械执行，也无法证明四类 hang 边界都得到覆盖。

**建议**

在设计中逐项列出：

- issue/故障模式；
- 真实测试路径及测试名；
- 用户可见 contract；
- 现有测试是否仅覆盖监测而非预防；
- 无现有测试时需要新增的最小 runtime regression test。

### LOW

无。

## 7. 必须完成的修订

1. 将 75% wrap-up 与 `budget_stop` 分离，冻结 completion provenance。
2. 在 fresh reload/discovery 后计算一次 performance class 和 effective runtime。
3. 删除 TaskTool 侧 pre-discovery 的角色 cap 推导，或明确其只传原始 configured value。
4. 分开定义 shadow eligibility 与 performance-policy precedence。
5. 明确 spawn `"code"` 作为 performance opt-in 时的调用契约和误标后果。
6. 为 explore soft runtime 使用中性 helper/classification 输入，避免继续依赖 reviewer 名称。
7. 明确 `read-summarize: true` 的覆盖语义及 revive 行为。
8. 补齐 TaskTool fixture、workflow paired gate 和旧行为 baseline 的 producer-to-gate 链。
9. 冻结产品 fixture 的重复次数、percentile 算法及运行隔离。
10. 将每类 hang contract 映射到真实测试路径、测试名及 observable assertion。
11. 保留方案 A 边界，不引入新 scheduler、completion engine 或通用 role framework。

## 8. Gate Evidence

### 8.1 关键源码事实

- 四名称 hard cap：`packages/coding-agent/src/task/index.ts:56-70`
- TaskTool 预解析 runtime：`packages/coding-agent/src/task/index.ts:787-802`、`:1591-1629`
- fresh reload/discovery：`packages/coding-agent/src/task/structured-subagent.ts:257-268`
- effective policy 获得 agent：`packages/coding-agent/src/task/structured-subagent.ts:323-348`
- 预解析 runtime 原样进入 executor：`packages/coding-agent/src/task/structured-subagent.ts:395-452`
- 75% timer 请求 budget stop：`packages/coding-agent/src/task/executor.ts:1306-1323`
- terminal provenance 解析：`packages/coding-agent/src/task/executor.ts:980-1001`
- quality gate fail-close：`packages/coding-agent/src/workflow/benchmark/runner.ts:552-576`
- budget-stop regression：`packages/coding-agent/test/workflow/p012-production-wiring.test.ts:1330-1347`
- live completion aggregation regression：`packages/coding-agent/test/workflow/benchmark/live-runtime.test.ts:713-720`
- shadow `off` eligibility precedence：`packages/coding-agent/src/shadow-mind/eligibility.ts:14-22`
- kebab-case normalization：`packages/utils/src/frontmatter.ts:20-38`
- frontmatter 字段解析：`packages/coding-agent/src/discovery/helpers.ts:300-338`
- `readSummarize` parser tests：`packages/coding-agent/test/discovery/agent-fields.test.ts:143-161`
- false-only child override：`packages/coding-agent/src/task/executor.ts:2919-2923`
- false-only revive override：`packages/coding-agent/src/task/persisted-revive.ts:88-90`

### 8.2 验证方式

- 完整读取两份冻结输入。
- 独立复算两份 raw-byte SHA-256 和聚合 revision。
- 逐项核对本 artifact 引用的关键代码路径及行号窗口。
- 只读核对 8/26 quality 设计、现有 runtime、gate 和 regression tests。
- 未运行测试、构建、formatter 或 benchmark，符合本轮授权。
- 未修改仓库文件、`~/.omp` 或外部状态。
- 本 artifact 仅在回复中返回，等待父协调者机械持久化。

### 8.3 Verdict 依据

- 方案 A 的 owner 和边界仍合理，不需要 redesign。
- 四个 HIGH finding 会阻断可验证实施，不能 PASS 或 PASS_WITH_NOTES。
- 所有阻断都可在当前设计内修复，因此 verdict 为 NEEDS_REVISION。

## 9. Gate Continuity Notes

- **continuity_state**: initial
- **initial_state**: none
- **covered_reviewed_revision**: `24b0169eb4bde4ec94258b2d16fe18d896e12730641591d3b143305099039098`
- **reviewed_input_drift_detected**: none
- **evidence_anchor_correction**: 在 artifact 持久化前完成，属于 reviewer 对证据引用的自我校正，不构成 Inputs drift 或 Gate continuity 事件
- **allowed_parent_mutation**: 仅将 `__HOST_REVIEWER_AGENT_ID__` 替换为宿主实际 agent id，并原样持久化本文
- **invalidating_changes**: 对正文、Reviewed Inputs 或 verdict 的其他编辑会使本 Gate 证据失效
- **next_gate_requirement**: Grok author 修订设计后，重新计算新 manifest/revision，并重新执行独立 Design Review Gate

## 10. 下一步

1. 仅回到当前设计文档，由原 Grok author subagent 修订方案 A。
2. 不进入实现，不修改代码、测试或 `~/.omp`，不发布。
3. 修订后冻结新的完整 Reviewed Inputs 并重新计算 SHA-256/reviewed_revision。
4. 重新运行独立 Design Review Gate。
5. 即使后续获得 PASS/PASS_WITH_NOTES，在没有新的 implementation authorization 前仍必须停止。

## 11. Handoff

### 11.1 当前会话交接

将本 artifact 机械持久化至：

```text
docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md
```

随后交回原 GrokDesigner author，仅修订当前设计，不启动实现。

### 11.2 下一 author prompt

```text
你是原设计作者 GrokDesigner。当前授权仍为 design-only，不得修改代码、~/.omp、测试、构建、发布或进入实现。

请完整读取：
1. docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md
2. docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md
3. docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md

在保留方案 A 总体方向、不引入第二套 runtime/completion engine 的前提下修订当前设计，并逐项解决 Gate finding：

- 将 75% wrap-up 与 budget_stop 终态分离；
- 在 fresh settings reload、agent discovery 和 effective policy resolution 后计算单一 performance class/effective runtime；
- 分开定义 shadow eligibility 与 performance-policy precedence；
- 明确 spawn shadowReview:"code" 的 performance opt-in 合同及误标后果；
- 为 explore soft runtime 使用中性分类接口；
- 明确 read-summarize true 的 spawn/revive 合并语义；
- 补齐 TaskTool fixture、旧行为 baseline 和现有 paired quality gate 的 producer-to-gate 链；
- 冻结产品 fixture 的样本量、percentile、active-wall producer 和运行隔离；
- 将 #4957/#8462/#3629/#5372 逐项映射到真实测试路径、测试名和 observable contract。

输出修订后的完整设计，不实现。修订完成后停止，并请求重新执行独立 Design Review Gate。
```

---

# Subagent Re-Review: Subagent 延迟优化设计（Round 2）

## 1. Gate 元数据

- **review_round**: 2
- **review_status**: completed
- **verdict**: **NEEDS_REVISION**
- **review_mode**: host-native
- **reviewer_native_agent_id**: `86139fdc-2f49-4d60-b3ac-f675c51312da`
- **reviewer_model**: GPT-5.6-sol xhigh
- **reviewer_native_model_slug**: `gpt-5.6-sol-xhigh`
- **review_fallback**: none
- **fallback_reason**: not-applicable
- **design_author_identity**: GrokDesigner
- **design_revision_author_identity**: `dea73d7c-b393-4b9e-abb1-d80f516595b2`
- **design_author_model**: Grok 4.6 / `cursor-grok-4.6-xhigh-fast`
- **implementation_authorization**: design-only
- **authorization_source**: 用户要求根据历史会话、社区与推特反馈分析根因并设计完整优化方案；未授权改代码、改 `~/.omp` 配置或发布
- **artifact_target**: `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md`
- **round_1_role**: 历史 finding，仅用于 closure 核对；不沿用旧 verdict

## 2. Reviewed Inputs

### 2.1 完整冻结输入

以下哈希由 reviewer 从 raw bytes 独立复算，并按 repo-relative POSIX path 排序：

```text
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md	c480000dc6108915b83cb7284f41af119cd0dcdd86659c68ff0f80195d32a25a
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md	bd6693c1d899cfd61df04fd83a54f76d42f4ecaf50aadaa3c1c65059de6b3e45
```

独立复算的 `reviewed_revision`：

```text
61f18b190c26d4aa348471fb25aaf3f70cc138ed02341320de22f249b8ecd54b
```

### 2.2 Hash cross-check

- design SHA-256：**MATCH**
- facts brief SHA-256：**MATCH**
- reviewed_revision：**MATCH**
- 路径排序、制表符、UTF-8 和尾随换行规范：**MATCH**

### 2.3 验证证据，不属于 Reviewed Inputs

- `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md`
- 当前仓库源码与测试
- 8/26 quality/session 设计边界

Round 1 artifact 不参与本轮 revision hash。

## 3. Round 1 Closure Matrix

| Round 1 finding | Round 2 状态 | 独立核查结论 |
|---|---|---|
| HIGH：75% wrap-up 与 `budget_stop` 冲突 | **CLOSED** | 修订明确 75% 只发 advisory steer，不置 `budgetStopRequested`；hard cap 前正常 yield 为 `completed`，未新增 completion kind。 |
| HIGH：hard cap 在 discovery 前计算 | **PARTIALLY_CLOSED** | 分类和 effective cap 已移到 `resolveEffectiveSubagentPolicy`；但 raw request cap、fresh setting、workflow/eval 显式 cap 和 `0` 的 precedence 仍有冲突与歧义。 |
| HIGH：shadow eligibility 与 performance role 耦合 | **CLOSED** | 新设计给出独立 performance matrix，不调用 `isShadowReviewQualified`；explore、frontmatter+off、worker+code 边界均已明确。 |
| HIGH：quality fixture/baseline 未闭合 | **PARTIALLY_CLOSED** | producer、paired quality 与 latency gate 职责已分开；但现有 gate不检查 `firstPassRate`，同 binary paired arms 也无法证明新 policy 相对旧 policy 的质量非回退。 |
| MEDIUM：`read-summarize: true` 合并语义不明 | **CLOSED** | 修订明确维持 false-only 合并；`true` 仅恢复默认声明，不覆盖用户显式关闭，也不作为确定性因果杠杆。 |
| MEDIUM：fixture 统计协议缺失 | **PARTIALLY_CLOSED** | 已定义 warmup、顺序、nearest-rank 和失败条件；但 n=5 的 p90 等于样本最大值，判别力不足以支撑产品 p90 声明。 |
| MEDIUM：hang regression 未映射 | **PARTIALLY_CLOSED** | #4957/#3629 已映射到真实测试；#8462/#5372 被标为新增测试，但拟议测试仍未触发真实失败机制。 |

## 4. 整体结论

**NEEDS_REVISION**

Round 2 是实质改进：

- 修正了 75% 终态矛盾；
- 将 performance class 放到 fresh discovery 后；
- 给出独立且自洽的分类矩阵；
- 明确 `read-summarize` 不是强制覆盖；
- 分开了 latency gate 与现有 quality gate；
- 将 hang issue 映射到真实测试或明确标注拟新增；
- 未引入第二引擎、通用 role 框架、feature flag 或遥测平台。

但仍有三个 HIGH 阻断：

1. effective runtime 公式会在 `task.maxRuntimeMs===0` 时吞掉 workflow/eval caller cap，并可能把 TaskTool reload 前的旧值误当额外天花板。
2. 现有 `evaluateBenchmarkQualityGate` 并不检查 `firstPassRate`；旧 policy 字面表也不能证明质量非回退。
3. `Settings.isolated()` 不隔离 agent discovery，产品 fixture 仍可能加载项目/用户 agent；且 fixture 没有可执行入口。

这些问题需要修改设计正文和验收合同，不能作为 PASS_WITH_NOTES 处理；但仍可在方案 A 内修复，无需整体 redesign。

## 5. 根因评审

### 5.1 总体结论

**WEAK_EVIDENCE**

Round 2 正确区分了：

- 机制事实：**SUPPORTED**
- 对墙钟影响幅度：**WEAK_EVIDENCE**
- hang 对本轮慢任务主因：**NOT_APPLICABLE**

这一分层与 facts brief 和当前源码一致。设计也明确 10min/40req/75% 是 treatment，而非必然结果，已关闭 Round 1 的因果过度表达。

### 5.2 分项结论

#### RC-1：固定名称 hard-cap seam 覆盖不足

**SUPPORTED**

- `packages/coding-agent/src/task/index.ts:56-70` 当前仅识别四个名称。
- `packages/coding-agent/src/task/index.ts:787-802`、`:1591-1629` 当前在 TaskTool 侧预解析 cap。
- `packages/coding-agent/src/task/structured-subagent.ts:257-268` 后续才 reload settings 并 discover agent。

将分类移至 effective policy 是正确方向。

#### RC-2：review/explore budget 偏宽

**SUPPORTED（机制）；WEAK_EVIDENCE（阈值效果）**

- `packages/coding-agent/src/task/review-performance.ts:4-16` reviewer cap 依赖固定名称。
- `packages/coding-agent/src/task/review-performance.ts:61-69` helper 只接收名称和 configured budget。
- 当前材料没有 40/80 requests 的质量—延迟曲线。

#### RC-3：统一 keep-going 缺少角色收敛

**SUPPORTED（文本）；WEAK_EVIDENCE（影响幅度）**

- `packages/coding-agent/src/prompts/system/subagent-system-prompt.md:45-57`
- `packages/coding-agent/src/prompts/system/subagent-system-prompt.md:70-73`

按 performance class 渲染 completion 指令是现有 prompt seam 上的浅层改动。

#### RC-4：scout max thinking、forced no-summary 与快速定位合同冲突

**SUPPORTED（配置）；WEAK_EVIDENCE（贡献量）**

- `packages/coding-agent/src/prompts/agents/scout.md:1-10`
- `packages/coding-agent/src/task/executor.ts:2919-2923`
- `packages/coding-agent/src/task/persisted-revive.ts:88-90`

Round 2 不再把 `read-summarize: true` 当确定性加速因素，表述正确。

#### RC-5：社区 hang 是本轮长任务主因

**NOT_APPLICABLE**

#4957/#8462/#3629/#5372 属于停止推进、父 ingest 或 event-loop liveness，不能解释 xhigh reviewer 持续读取 80–170 个文件。将其作为不回归边界而非主杠杆是正确的。

### 5.3 因果链一致性

- 证据支持方案 A 的方向。
- 证据不支持任何 treatment 必然达到 p50/p90。
- 修订已明确未达门槛不得宣称成功。
- 仍缺少可隔离、可执行且统计充分的产品 fixture，因此实证闭环尚未完成。

## 6. 设计评审

### 6.1 需求与方向

方向正确：

- 保留 independent Gate、双轴和 yield；
- 不用 hard timeout 冒充正常完成；
- 不用用户配置修改冒充产品修复；
- 不重做相邻 8/26、8/23、8/03 方案；
- 方案 B 仅保留为简短对比，没有过度展开；
- 无第二 scheduler/runtime/completion engine。

### 6.2 Runtime seam

`EffectiveSubagentPolicy` 是合适的 seam。现有：

- policy 已持有 `agent/effectiveAgent`：`packages/coding-agent/src/task/structured-subagent.ts:132-148`
- policy 在 dispatch 前解析：`packages/coding-agent/src/task/structured-subagent.ts:257-348`
- `buildExecutorOptions` 集中构建 executor 输入：`packages/coding-agent/src/task/structured-subagent.ts:395-452`

新增 `performanceClass` 和 `effectiveMaxRuntimeMs` 是最小充分字段。`configuredMaxRuntimeMs` 没有明确下游消费者，可留在局部计算中。

### 6.3 Performance class matrix

矩阵内部自洽：

- explore+spawn code → explore performance，shadow 可开；
- frontmatter code+off → review performance，shadow 关闭；
- ordinary worker+code → 显式 review performance opt-in；
- floor reviewer+off → review performance，shadow 关闭。

explore 优先避免把 scout 的 10min/40req 放宽为 30min/80req，符合 scout 的压缩 handoff 合同。该部分 CLOSED。

### 6.4 75% advisory

`sendUserMessage(..., { deliverAs: "steer" })` 是可复用 seam：

- `packages/coding-agent/src/session/agent-session.ts:7560-7596` 明确提供显式 steer 队列。
- `packages/agent/src/agent.ts:1025-1032` steer 在当前 tool execution 后交付并跳过剩余工具。
- 它不需要设置 `budgetStopRequested`，适合作为 advisory。

但新 timer 与 request-budget steer、terminal yield 和 budget stop 的竞争仍需共享 latch/测试，详见 MEDIUM finding。

### 6.5 Quality 与 latency 职责

职责分离方向正确：

- latency fixture 不进入 `evaluateBenchmarkQualityGate`；
- quality gate继续 fail-close missing/non-completed kind；
- live paired arms 被明确限定为 presentation/profile 质量合同，不再伪称旧 policy 对照。

仍未闭合的是“新 subagent policy 相对旧 policy 的 first-pass/质量不下降”。

## 7. Findings

### CRITICAL

无。

### HIGH

#### [HIGH] effective runtime precedence 会吞掉 workflow/eval caller cap

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:195-207`
- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:307-320`
- `packages/coding-agent/src/task/structured-subagent.ts:117-118`
- `packages/coding-agent/src/workflow/runtime-adapter.ts:190-200`
- `packages/coding-agent/src/workflow/runtime-adapter.ts:420-433`

**问题**

修订设计规定：

- fresh setting 是 authoritative configured；
- `configured===0` 时无限；
- 只有 configured 非零时再将 `request.maxRuntimeMs>0` 作为额外 ceiling。

但当前 `StructuredSubagentRequest.maxRuntimeMs` 的公开注释是“`0` disables executor wall-clock timeout；undefined inherits settings”。workflow 会把 profile runtime 直接传入；schema retry 还会传递剩余 runtime。

按新公式，若 session 的 `task.maxRuntimeMs===0`，workflow/eval 显式传入的 5/10 分钟 profile cap会被忽略并变成无限，改变现有 caller contract。

此外，TaskTool 方案仍写“传 raw configured 或不传”。若它在 reload 前捕获旧值并传入，policy 又把它当 caller ceiling，则磁盘设置由 15 分钟调到 60 分钟后仍可能被旧 15 分钟截断。

**影响**

- workflow profile timeout 失效；
- schema retry 的 remaining runtime 失效；
- TaskTool fresh reload 不再真正权威；
- `0` 的含义随调用路径变化。

**建议**

正文必须冻结按 invocation/source 区分的单一公式，例如：

- TaskTool：不传 `request.maxRuntimeMs`，只由 fresh setting + class ceiling 决定。
- workflow/eval：显式 `request.maxRuntimeMs` 保留当前 caller budget，不把它与 TaskTool raw setting混用。
- 明确定义显式 request `0`、global setting `0`、两者均非零时的 precedence。
- 为 task/workflow/eval 各加 `undefined`、`0`、更严非零值测试。

#### [HIGH] 现有 quality gate不执行设计声称的 first-pass 非回退

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:358-374`
- `packages/coding-agent/src/workflow/benchmark/runner.ts:407-425`
- `packages/coding-agent/src/workflow/benchmark/runner.ts:523-628`
- `packages/coding-agent/src/workflow/benchmark/live-runtime.ts:300-314`

**问题**

`buildScorecard` 会计算 `firstPassRate`，但 `evaluateBenchmarkQualityGate` 只检查：

- absolute pass rate；
- scope/completion/runtime provenance；
- baseline/optimized pass-rate drop；
- quality-score drop。

它没有读取或比较 `firstPassRate`。

修订设计同时承认 live baseline/optimized 共享新 subagent policy，并将旧 policy baseline 降为 contract 测试中的字面表。该字面表只能验证 helper 输出变化，不能运行旧 prompt/budget，也不能证明 verdict、known-defect 或 first-pass 相对旧 policy 不下降。

**影响**

新 scout prompt、thinking level、class budget若让 baseline 和 optimized 两臂同时发生 first-pass 回退，现有 gate仍可能 PASS。设计的“first-pass verified success 不降”没有 producer-to-gate enforcement。

**建议**

二选一：

1. 扩展现有 scorecard gate，显式 fail-close `firstPassRate` 缺失和下降，并提供能够运行旧/新 subagent policy 的 test-only paired profile；或
2. 删除“相对旧 policy first-pass 不降”的声明，改成由冻结 absolute cases 强制每次 first-pass/known-defect/verdict 全部通过。

不要用“新 helper 输出不同于旧字面表”的单元测试替代质量对照；该负面断言没有新增 observable contract。

#### [HIGH] `Settings.isolated()` 不能隔离 agent discovery，产品 fixture 不是产品默认

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:375-388`
- `packages/coding-agent/src/config/settings.ts:510-520`
- `packages/coding-agent/src/task/discovery.ts:70-130`
- `packages/coding-agent/src/config.ts:127-148`
- `packages/coding-agent/src/task/structured-subagent.ts:257-268`

**问题**

设计声称 fixture 使用 `Settings.isolated()` 后“不加载 `~/.omp/agent/agents/*`”。

源码不支持该结论：

- `Settings.isolated()` 只创建内存 settings。
- `resolveEffectiveSubagentPolicy` 仍调用 `discoverAgents(request.session.cwd)`。
- `discoverAgents` 无条件读取 project `.omp/agents` 和 `getConfigDirs("agents", { project:false })` 返回的用户 agent 目录。
- `getConfigDirs` 的用户目录来自全局配置基址，不受该 `Settings` 实例控制。

即使 `createAgentSession` 使用临时 `agentDir`，当前 structured discovery 也没有接收该值。

此外，`product-latency-fixture.ts` 被描述为 producer，但没有指定 `.test.ts` consumer、CLI 或 package script，发布门禁目前没有可执行入口。

**影响**

用户或项目同名 `scout`/`reviewer` 可覆盖 bundled agent，污染模型、thinking、frontmatter 和 prompt；fixture 无法证明产品默认性能。

**建议**

冻结真实隔离方式：

- 在独立子进程中使用临时 config/profile root和无 `.omp/agents` 的临时 cwd；或
- 给 `discoverAgents`/structured request增加仅测试使用的 explicit bundled-only discovery seam。

fixture 必须断言 `effectiveAgent.source==="bundled"`、file/model identity符合 bundled 定义，并指定实际执行命令/测试入口。仅写 `Settings.isolated()` 不足。

### MEDIUM

#### [MEDIUM] n=5 的 nearest-rank p90 不足以支撑产品 p90 门

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:375-388`
- `packages/coding-agent/src/latency/rollout-cohort.ts:296-300`
- `packages/coding-agent/test/latency/rollout-cohort.test.ts:127-141`

**问题**

n=5 时 nearest-rank p90 是第5项，即样本最大值。它可以表达“五次中无慢例”的 smoke，但不是具有稳定判别力的 p90 估计。现有 latency cohort 聚合测试也以至少8个 observation 为门槛，并非证明5次足够。

**影响**

五次随机 provider/model 运行极易因偶然快/慢产生假 PASS 或假 FAIL，无法支撑发布级 p90 声明。

**建议**

- 将5次定义为 smoke，不宣称 p90；或
- 为发布 p90 设置更高且有依据的样本下限，保留 warmup、strict identity 和 nearest-rank。
- quality gate 的默认5 repetitions 不能作为 latency percentile 样本量依据，两者统计对象不同。

#### [MEDIUM] active-wall helper 放错 owner，且调用签名前后不一致

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:260-269`
- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:375-388`
- `packages/coding-agent/src/task/review-performance.ts:47-58`
- `packages/coding-agent/src/latency/rollout-cohort.ts:296-300`

**问题**

§5.3 将 `computeActiveWallMs(events)` 放入 production `review-performance.ts`，§6.3 却写成 `computeActiveWallMs(childJsonl)`。一个接受解析后事件，另一个暗示读取/解析 session JSONL。

`review-performance.ts` 当前负责 reviewer runtime/budget 与 review metrics，不负责会话文件解析或 benchmark percentile。仓库已有 `src/latency/rollout-cohort.ts` 的 nearest-rank percentile owner。

**影响**

测试/离线会话解析依赖泄漏进 runtime 模块，且实现者无法确定函数是否负责 I/O、JSONL parsing 还是纯计算。

**建议**

- fixture/test helper负责读取 JSONL并提取 assistant timestamps；
- pure active-wall 函数只接受 timestamp 序列；
- 若用户语料生产脚本确实复用，放到中性的 `src/latency` owner；
- percentile 直接复用现有 central helper，不复制算法。

#### [MEDIUM] 75% steer 与 request-budget lifecycle 缺少竞争合同

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:210-225`
- `packages/coding-agent/src/task/executor.ts:1243-1264`
- `packages/coding-agent/src/task/executor.ts:1310-1338`
- `packages/coding-agent/src/task/executor.ts:1755-1781`
- `packages/coding-agent/src/session/agent-session.ts:7061-7118`
- `packages/coding-agent/src/session/agent-session.ts:7560-7596`

**问题**

`sendUserMessage(...,{deliverAs:"steer"})` 本身适合作为 advisory，但 executor 已有独立 request-budget steer。新设计没有定义：

- 两种 wrap-up notice 是否共享一次性 latch；
- 75% 和 soft request crossing 同时发生时的顺序；
- 已 terminal-yield、已进入 budget stop 或 hard abort 时如何阻止延迟 steer 入队；
- steer 发送失败是否只记录日志并继续。

显式 steer 会进入用户消息队列并触发 queue-drain 调度。重复或晚到的 steer可能增加额外 turn，抵消收敛目标。

**影响**

边界时序下可能出现双重 wrap-up、budget forced-yield 前后插入 advisory，或 terminal yield 后多跑一轮。

**建议**

定义一个共享 notice owner/latch，并在真正 enqueue 前重新检查 `resolved`、abort 和 budget-stop 状态。新增同一时刻触发 runtime notice/request notice、terminal yield race、send rejection 三类 runtime tests。

#### [MEDIUM] #8462/#5372 拟新增测试没有触发真实失败路径

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:389-399`
- `packages/agent/src/utils/yield.ts:1-38`
- `packages/coding-agent/src/session/agent-session.ts:1392-1410`
- `packages/tui/test/loop-watchdog.test.ts:229-274`

**问题**

拟议 #8462 测试在 child resolve 后等待父 `setTimeout`；该 timer 本身就是 ref handle，普通事件循环也会运行，不能证明无 focus/resize 时的 keepalive/idle-flush 路径。

拟议 #5372 测试在9路“合成 progress 突发后”等待 `setTimeout(0)`，但没有定义突发处理的规模、同步 owner、时延上限或与 timer 并发关系。同步处理结束后 timer 最终触发不等于没有 event-loop wedge。

**影响**

测试可能在历史实现仍有问题时照样通过，只证明“代码最终返回”。

**建议**

- #8462：触发真实 terminal-yield→parent idle-flush/ingest 路径，断言无需外部 I/O 即完成。
- #5372：让 timer在9路真实 progress processing 之前排队，断言在有依据的 bounded latency 内触发；或对实际批处理 owner建立可测的 cooperative-yield contract。
- 不得用裸 `setTimeout(0)` 最终执行作为唯一成功断言。

### LOW

#### [LOW] `configuredMaxRuntimeMs` 与 `soft_runtime` checkpoint 缺少下游消费者

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:200-207`
- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:222-226`
- `packages/coding-agent/src/task/review-performance.ts:47-58`
- `packages/coding-agent/src/task/structured-subagent.ts:132-148`

**问题**

executor 只需要 `performanceClass` 和 `effectiveMaxRuntimeMs`。设计未说明谁读取 `configuredMaxRuntimeMs`。同样，`soft_runtime` checkpoint 虽能区分 advisory 与 hard timeout，但验收计划没有消费者读取它。

**影响**

给核心 policy 和 persisted metrics 增加未使用字段，扩大实现与兼容面。

**建议**

- `configuredMaxRuntimeMs` 留在 resolver 局部，除非存在明确诊断消费者。
- `soft_runtime` checkpoint 若用于 fixture/日志，应写明消费路径和断言；否则由 steer spy/runtime test验证即可。

## 8. Gate Evidence

### 8.1 关键证据

- 新 revision/hash：独立 raw-byte 复算，与父值一致。
- structured request `0` 合同：`packages/coding-agent/src/task/structured-subagent.ts:117-118`
- effective policy owner：`packages/coding-agent/src/task/structured-subagent.ts:257-348`
- executor options seam：`packages/coding-agent/src/task/structured-subagent.ts:395-452`
- workflow remaining/profile cap：`packages/coding-agent/src/workflow/runtime-adapter.ts:190-200`、`:420-433`
- steer queue：`packages/coding-agent/src/session/agent-session.ts:7061-7118`、`:7560-7596`
- agent-core steer语义：`packages/agent/src/agent.ts:1025-1032`
- budget stop lifecycle：`packages/coding-agent/src/task/executor.ts:1243-1264`
- request-budget steer：`packages/coding-agent/src/task/executor.ts:1755-1781`
- quality scorecard：`packages/coding-agent/src/workflow/benchmark/runner.ts:407-425`
- quality gate：`packages/coding-agent/src/workflow/benchmark/runner.ts:523-628`
- discovery读取项目/用户 agents：`packages/coding-agent/src/task/discovery.ts:70-130`
- Settings isolation范围：`packages/coding-agent/src/config/settings.ts:510-520`
- central percentile：`packages/coding-agent/src/latency/rollout-cohort.ts:296-300`
- #4957 tests：`packages/coding-agent/test/tools/yield.test.ts:669-714`、`packages/coding-agent/test/task/executor-subagent-reminders.test.ts:349-464`
- #3629 contract：`packages/coding-agent/test/turn-persistence.test.ts:1-14`
- #5372现有监测测试：`packages/tui/test/loop-watchdog.test.ts:229-274`

### 8.2 未运行事项

按只读授权：

- 未运行测试；
- 未运行构建；
- 未运行 formatter；
- 未运行 benchmark/live fixture；
- 未修改任何文件、配置或外部状态。

### 8.3 Verdict 依据

- 三项 HIGH 需要修改正文/合同；
- PASS_WITH_NOTES 不适用；
- 问题均可在方案 A 内解决；
- 不需要重新设计整体架构。

## 9. Gate Continuity Notes

- **continuity_state**: initial
- **initial_state**: none
- **covered_reviewed_revision**: `61f18b190c26d4aa348471fb25aaf3f70cc138ed02341320de22f249b8ecd54b`
- **reviewed_input_drift_detected**: none
- **round_1_continuity**: Round 1 仅为历史 closure 输入，不构成本轮 verdict continuity
- **allowed_parent_mutation**: 将本完整 Round 2 artifact 原样追加到既有 artifact；不得修改正文、verdict 或 Reviewed Inputs
- **invalidating_changes**: 对本轮设计/facts raw bytes 的任何后续修改都会使本 Gate 失效
- **next_gate_requirement**: Grok revision author 修订设计后，必须重新冻结完整输入、复算 manifest/revision，并执行新的独立 Gate

## 10. 下一步

1. 回到当前设计文档，由 Grok revision author 修订。
2. 必须解决三个 HIGH：
   - runtime cap precedence；
   - first-pass/旧新 policy 质量非回退；
   - bundled-only fixture隔离与可执行入口。
3. 同步处理四个 MEDIUM，避免验收门成为弱 smoke。
4. 修订后重跑独立 Design Review Gate。
5. 当前授权为 design-only；不得进入实现、测试、配置修改或发布。

## 11. Design-only Handoff

```text
你是 GrokDesigner revision author。当前授权仍为 design-only，不得修改代码、配置、测试、~/.omp 或发布。

请完整读取：
1. docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md
2. docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md
3. docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md 中完整 Round 2 artifact

在保留方案 A、独立 Gate、yield 协议和单一 effective-policy owner 的前提下修订：

- 冻结 TaskTool 与 workflow/eval 各自的 maxRuntimeMs/undefined/0 precedence，不能吞掉 profile caller cap；
- 让质量门真正执行 first-pass 非回退，或删除无法执行的相对旧 policy 声明并改成可执行 absolute contract；
- 定义 bundled-only agent discovery 隔离及 fixture 的真实执行入口；
- 将5次定义为 smoke，或提高发布 p90 样本量；
- 将 active-wall 纯计算移到合适 owner，复用 central percentile；
- 定义 runtime/request steer 的共享 latch 和 race tests；
- 将 #8462/#5372 测试改为触发真实 liveness 失败路径；
- 删除无消费者的 policy/checkpoint 字段，或补充明确消费合同。

只修订设计，不实现。修订后停止，并请求新的独立 Design Review Gate。
```

---

# Subagent Re-Review: Subagent 延迟优化设计（Round 3）

## 1. Gate 元数据

- **review_round**: 3
- **review_status**: completed
- **verdict**: **NEEDS_REVISION**
- **review_mode**: host-native
- **reviewer_model**: Claude Opus 5
- **reviewer_native_model_slug**: `claude-opus-5-thinking-high`
- **reviewer_native_agent_id**: `7fe4f367-f3ac-4a2f-bc59-5603c6cc9b8c`
- **review_fallback**: none
- **fallback_reason**: not-applicable（本轮是 GPT-5.6-sol 成为 revision author 后预定的异模型 reviewer，非 fallback）
- **design_author**: grok
- **design_author_identity**: GrokDesigner / Grok 4.6
- **design_revision_author_identity_1**: `dea73d7c-b393-4b9e-abb1-d80f516595b2` / Grok 4.6
- **design_revision_author_identity_2**: `86139fdc-2f49-4d60-b3ac-f675c51312da` / GPT-5.6-sol
- **content_author_models**: Grok 4.6, GPT-5.6-sol
- **reviewer_participation_in_body**: none（本 reviewer 未参与正文任何修订）
- **author_self_review**: 未发生；Round 1/2 reviewer 已成为 revision author 2，故本轮由未参与正文的 Claude Opus 5 执行
- **implementation_authorization**: design-only
- **authorization_source**: 用户要求根据历史会话、社区与推特反馈分析根因并设计完整优化方案；未授权改代码、改 `~/.omp` 配置或发布
- **artifact_target**: `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md`
- **round_1_2_role**: 历史 closure 输入，不加入本轮 Reviewed Inputs manifest，不沿用旧 verdict

## 2. Reviewed Inputs

### 2.1 完整冻结输入

以下哈希由本 reviewer 从 raw bytes 独立复算（`shasum -a 256`），按 repo-relative POSIX path 排序：

```text
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md	833bda5dd65980f9c1ff7ed15adcf0c6ecdc40c1ce8fcd37f43bc25ac79c217e
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md	bd6693c1d899cfd61df04fd83a54f76d42f4ecaf50aadaa3c1c65059de6b3e45
```

聚合行（UTF-8 `<path>\t<lowercase sha256>\n`）再 SHA-256 得到的独立 `reviewed_revision`：

```text
f4f3e004a245b5fd5c0c3d8238b1f3031626b7ba21745232eceec6464c64dc36
```

### 2.2 与父协调者预计算值交叉校验

| 项 | 结果 |
|---|---|
| design SHA-256 | **MATCH** |
| facts brief SHA-256 | **MATCH** |
| 聚合 `reviewed_revision` | **MATCH** |
| 路径排序（POSIX、字典序） | **MATCH** |
| 分隔符（单 `\t`）、UTF-8、行尾 `\n` | **MATCH** |
| 输入完整性 | 未发现遗漏的冻结设计输入 |

facts brief 的哈希与 Round 1/Round 2 记录一致（`bd6693c1…`），说明 facts brief 三轮未变；design 从 Round 2 的 `c480000d…` 变为 `833bda5d…`，属实质修订，符合「正文变更必须重跑 Gate」的规则。

### 2.3 验证证据（不属于 Reviewed Inputs）

- `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md`（Round 1/2 artifact，仅作 closure 核对）
- 当前工作区源码与测试（逐条只读核对，见 §7 / §8）
- 未运行任何测试、构建、benchmark 或 fixture；未修改任何文件、`~/.omp` 或外部状态

## 3. Round 2 Closure Matrix

独立核对，不接受作者自述。

| Round 2 finding | 严重度 | 本轮独立结论 | 证据 |
|---|---|---|---|
| effective runtime precedence 会吞掉 workflow/eval caller cap | HIGH | **PARTIALLY_CLOSED** | 新公式（design §5.2 步骤 5–6，约 L203–207）确实修好了核心缺陷：`request.maxRuntimeMs>0` 直接成为 base，不再被 global `0` 吞掉；TaskTool 不传 request，fresh setting 权威。但**调用方清单是错的**：`packages/coding-agent/src/eval/agent-bridge.ts:156-158` 有显式注释说明 eval **故意省略** `maxRuntimeMs`，不存在设计所称的「eval 显式 remaining cap」；`budgetFromProfileUsage`（`workflow/structured-output-repair.ts:590-622`）产出的是 `StructuredRepairBudget.remainingTimeMs`，与 `StructuredSubagentRequest.maxRuntimeMs` 不是同一条线。见 [HIGH-1] |
| 现有 quality gate 不执行 first-pass 非回退 | HIGH | **PARTIALLY_CLOSED** | 设计已删除「相对旧 policy first-pass 不降」的不可执行声明（§5.5 最后一条、§6.2 倒数第二条），改为 absolute contract，方向正确；`evaluateBenchmarkQualityGate`（`workflow/benchmark/runner.ts:523-629`）确实是唯一 owner 且确实**没有**读 `firstPassed`，扩展是真最小。但 required case 选取与 suite 真实结构不符，且所称的 known-defect/verdict 门在该函数中并不存在。见 [HIGH-2]、[MEDIUM-1] |
| `Settings.isolated()` 不隔离 agent discovery，fixture 无可执行入口 | HIGH | **PARTIALLY_CLOSED** | 隔离方式已改为「独立子进程 + 临时 HOME/config root + 干净 cwd」，并明确 `Settings.isolated()` 不承担 discovery 隔离（§6.3），这是正确的；`discoverAgents(cwd, home = os.homedir())`（`task/discovery.ts:70`）确认 HOME 是真 seam；`effectiveAgent.source==="bundled"` 是真字段（`task/types.ts:397`、`task/agents.ts:141`）。执行入口 `bun packages/coding-agent/test/task/product-latency-fixture.ts` 可执行且不会被 `scripts/ci-test-ts.ts:236` 的 `.test.ts` 收集器误收。但**发布门禁仍无 owner**（[HIGH-3]），隔离仍有两处漏洞（[MEDIUM-4]） |
| n=5 的 nearest-rank p90 不足以支撑产品 p90 门 | MEDIUM | **CLOSED** | §6.3「样本量」明确 smoke n=5 **不计算或报告 p90**，只门禁 p50/max/hard timeout/identity；release 每 variant n=20，nearest-rank。§7 与 §1.2 表述一致，无残留 p90 声明 |
| active-wall helper 放错 owner，签名前后不一致 | MEDIUM | **CLOSED** | 已移到中性 `src/latency/active-wall.ts`（拟新增），签名统一为 `computeActiveWallMs(assistantTimestamps: readonly number[])`，§5.3 与 §6.3 一致；I/O 归 fixture；percentile 复用 `src/latency/rollout-cohort.ts:297` 的已导出 `percentile`（经 `src/latency/index.ts` 星号 barrel 再导出），非虚构 API |
| 75% steer 与 request-budget lifecycle 缺少竞争合同 | MEDIUM | **CLOSED** | §5.2「75% 与 completion 合同（冻结）」给出共享 latch、enqueue 前复查 `resolved`/terminal yield/`abortSent`/`budgetStopRequested`、同时触发只发一条、rejection 只记日志。该合同可在现有 seam 上实现：现有 `budgetSteerSent` 一次性 latch + 异步边界 + catch-log 已在 `task/executor.ts:1767-1781`，现有 75% timer 的同步终态检查在 `:1314` |
| #8462/#5372 拟新增测试没有触发真实失败路径 | MEDIUM | **CLOSED** | 设计改为**不新增测试、不宣称覆盖**，并要求实现 diff 若触及其 owner 先回订设计（§6.4 表 + §6.5「不做」）。§6.4 表中四组测试名逐条核对**全部真实存在且文本精确** |
| `configuredMaxRuntimeMs` / `soft_runtime` checkpoint 无消费者 | LOW | **CLOSED** | §5.3 明确不新增 `configuredMaxRuntimeMs`、不扩展 `SubagentCheckpointMetrics.kind`；`EffectiveSubagentPolicy` 只加两个字段，二者都被 `buildExecutorOptions` 消费 |

**Round 2 closure 小结**：4 MEDIUM 全部 CLOSED、1 LOW CLOSED；3 HIGH 均为 PARTIALLY_CLOSED——核心机制缺陷已修好，但**支撑该修复的事实基础与验收 owner 仍不成立**。

## 4. 整体结论

**NEEDS_REVISION**

Round 3 相对 Round 2 是实质进步，方案 A 的架构判断本轮**无异议**：

- 单一 class owner 落在 `resolveEffectiveSubagentPolicy`（`task/structured-subagent.ts:257-349`）是正确时序——该函数确实先 `reloadFromDisk()`（`:260`）、再 `discoverAgents`（`:267`）、再 `getAgent`（`:268`），frontmatter 在此点可用。
- 未新增 scheduler、第二 completion engine、review 引擎、context 平台、通用 role framework、feature flag 或遥测管道。
- 未新增 settings key；`EffectiveSubagentPolicy` 只加两个有消费者的字段；`shadowReview` 未被升格为 role。
- yield 协议、`requireYieldTool: true`（`task/executor.ts:3331`）、shadow eligibility、hang owner 均不动。
- 根因分层（机制 SUPPORTED / 幅度 WEAK_EVIDENCE / hang NOT_APPLICABLE）与 facts brief 及源码一致，treatment 与目标已分离。

阻断本轮 PASS 的是**三个 HIGH**，全部集中在「设计对现有调用方与现有质量门的事实描述」和「新验收门的 owner」，不是架构：

1. 设计反复声明的「workflow/eval 显式 caller cap」中，**eval 侧不存在**；源码有显式反向注释。同时新 class ceiling 会静默改变 eval fan-out 的墙钟合同，设计未承认；§6.1 为此指定的测试 owner 指向的是 workflow profile 测试，不是 eval 路径。
2. 被选为「质量绝对合同」的两个 required case 中，`schema-repair-boundary` 不是 review 案（`schema_heavy` 的 JSON fence 修复），suite 里真正的三个 `code_review` 案被排除；设计声称「保留 known-defect、verdict 门」，但 `evaluateBenchmarkQualityGate` 里既无 known-defect 检查也无 verdict 检查，`verdict` 在整个 benchmark 目录不存在。因此该合同**防不住设计自己列出的头号质量风险**（wrap-up 导致 findings 变少）。
3. 42 次 live 模型执行被写成「发布门禁」，但仓库中不存在任何可承接它的 owner：`.github/workflows/` 三个 workflow 无 benchmark/latency 引用，`scripts/release.ts` 不跑测试，`package.json` 无对应 script，也无成本上限或 kill switch。

这三项都需要**修改正文语义与验收合同**，不属于「不影响合同的 notes」，因此不能 PASS_WITH_NOTES。三项均可在方案 A 内修复，不需要推翻架构或回到 design-brainstorm，因此不是 NEEDS_REDESIGN。

## 5. 根因评审

### 5.1 总体结论

**WEAK_EVIDENCE**

与 Round 2 结论一致，且本轮独立复核确认该定级是**诚实的**，不是防御性措辞：设计在 §3.2 主动把每条根因拆成「机制 SUPPORTED」与「幅度 WEAK_EVIDENCE」，在 §1.2 明确「treatment 与目标分离」，在 §3.4 写明「10/40/75% 不是必然达标」，在 §5.5 把「首次打不出分位数」列为已知风险并禁止改口径凑数。现有材料确实只有配置事实、历史会话统计与少量长任务样本，没有 request/tool timeline 或 treatment 对照，无法量化各因素对 scout p50=14.8 min / review p50=20.0 min 的贡献。

证据强度支持「在现有 owner 上小步收紧并实测」；不支持任何数值因果承诺。设计的表述与该强度**匹配**。

### 5.2 分项结论（独立复核）

| 根因 | 结论 | 独立证据 |
|---|---|---|
| RC-1 固定四名称 hard-cap seam 覆盖不足 | **SUPPORTED** | `task/index.ts:56-70` 确认 `REVIEW_GATE_AGENTS` 只有 `reviewer`/`subagent-sol`/`sol-xhigh-reviewer`/`security-reviewer`；`:69` 确认 `configured===0` 保持无限，`:70` 确认 `Math.min(configured, 1_800_000)`。两处预解析调用点确认于 `:801`（preflight）与 `:1628`（run），均在 `resolveEffectiveSubagentPolicy` 的 reload/discovery 之前 |
| RC-2 review/explore request budget 偏宽 | **SUPPORTED（机制）/ WEAK_EVIDENCE（数值）** | `task/executor.ts:121-126` 确认 `SOFT_REQUEST_BUDGET = { scout: 100, sonic: 100, …REVIEWER(80×4), default: 200 }`；`:134-141` 确认 helper 只接收 name + configured。40/80 的质量—延迟曲线无证据，设计已标 treatment |
| RC-3 统一 keep-going 缺角色收敛 | **SUPPORTED（文本）/ WEAK_EVIDENCE（幅度）** | `prompts/system/subagent-system-prompt.md:47`「While work remains, you MUST continue with another tool call」、`:73`「You MUST keep going until this ticket is closed. This matters.」逐字确认；该文件已有 Handlebars 分支（`{{#if}}`/`{{#unless}}` 多处），按 class 分支是现有 seam 上的浅改 |
| RC-4 scout 合同自相冲突 | **SUPPORTED（配置）/ WEAK_EVIDENCE（贡献量）** | `prompts/agents/scout.md` 逐字确认 `thinking-level: max`、`max-effort: max`、`read-summarize: false`、「you are supposed to finish in a few seconds」与「You MUST keep going until complete.」并存 |
| RC-5 社区 hang 是本轮主因 | **NOT_APPLICABLE** | 设计将其作为不回归边界而非杠杆，与 §6.4 中四组真实测试的 observable 一致 |
| RC-6 parked 墙钟污染口径 | **SUPPORTED** | facts brief §1 的 1163 min / 活跃 42.7 min 对照；设计据此把验收口径改为活跃墙钟，并禁止改 `task.agentIdleTtlMs` 藏 park |

### 5.3 facts → 判断 → 方案一致性

- **一致**：四名称 cap、统一 keep-going、scout max 配置、用户 xhigh 叠加、75% 现为 budget stop、hard cap 预解析过早——六条机制事实全部在源码中逐条复核通过，且每条都对应到方案的一个具体改动点，无悬空事实、无无据改动。
- **一致**：证据不足以量化贡献 → 选更浅的方案 A 而非改完成协议；方案 B 的否决理由（「没有 A 无法满足的已确认约束」）与 facts brief §5「Cursor 文档明确收益是 context isolation，不是速度」一致。
- **一致**：分层验收（产品 fixture ≤12 min vs 用户语料 ≤16 min）直接来自「用户 xhigh 覆盖 bundled medium」这条已确认事实，没有把用户层数字当产品承诺。
- **不一致（新增）**：§5.2 步骤 6 与 §5.4、§6.1、§7 反复以「workflow/eval 显式 profile/retry cap」为公式正当性依据，但 eval 侧该 caller 不存在（见 [HIGH-1]）。这是**判断层引用了不存在的事实**。
- **不一致（新增）**：§1.2 与 §6.2 把「required live review/Gate cases 每 run first-pass」当作质量绝对合同，但所选 case 与 suite 的 `code_review` 类别不符，且所称的 known-defect/verdict 门在判定器中不存在（见 [HIGH-2]）。这是**方案层的验收手段与它要防的风险不匹配**。
- **不一致（新增）**：§5.3 把 `read-summarize: false → true` 写成「只是 agent 声明、不是杠杆、不计入因果」，但该改动实际移除了 scout 现有的 child settings 强制写入（见 [MEDIUM-2]）。这是**方案层低估了自身改动的行为面**。

## 6. 设计评审

### 6.1 需求与方向

方向正确，无异议：

- 产品默认与用户 overrides 分层写、分层验，未把改 `~/.omp` 当产品唯一修复。
- 活跃墙钟口径排除 park，且禁止用 `task.agentIdleTtlMs` 藏墙钟。
- 保留独立 Gate 与代码双轴，未以取消他审换延迟。
- `timeout`/`budget_stop`/缺口不得计 PASS 的规则贯穿 §1.2、§5.4、§6.2。
- 非目标清单覆盖 8/26、8/23、8/03、8/20、8/29 相邻设计，无重做。
- kill switch 复用现有 `task.softRequestBudget===0` / `task.maxRuntimeMs===0`，未加新 flag。

### 6.2 maxRuntime 公式与时序（评审要求 3.1）

**时序：正确。** class ceiling 应用点在 `resolveEffectiveSubagentPolicy` 内、`discoverAgents`+`getAgent` 之后（`task/structured-subagent.ts:267-268`），此时 `effectiveAgent.shadowReview` 可用（`discovery/helpers.ts:324,338` 解析 frontmatter `shadowReview` 为 `"code"`）。Round 2 的 HIGH-2 时序缺陷已真正关闭。

**公式对 TaskTool：正确且保持合同。** 现有 `resolveTaskMaxRuntimeMs`（`task/index.ts:64-71`）语义是「`0` 保持无限；非零取 min(configured, 30min)」；新公式 `undefined → fresh setting`、`0 → 0`、`>0 → caller cap`，再对非零 base 取 min(ceiling)，对 TaskTool 路径产生相同的 `0`/非零语义，且因 TaskTool 恒传 `undefined` 而恒走 fresh setting——比现状更强（现状 `:801`/`:1628` 读的是 reload 前的 settings）。

**preflight/run 双解析：已覆盖，无遗漏。** 确认 TaskTool 有两个独立解析点——`#resolveSpawnPreflight`（`task/index.ts:787-788`，内部调用 `resolveEffectiveSubagentPolicy`）与 `runStructuredSubagent`（`:1606`，内部再解析一次）。设计 §5.2 步骤 7 明确「预飞与 run 都重新执行该函数，两次均从 fresh setting 解析」，并明确不新增第三趟 discovery——与现状的两趟一致。可留意但不构成 finding：两次之间若磁盘 settings 变化，preflight 展示值与实际执行值可不同；由于只有 run 的值进入 executor，无功能影响。

**公式对 workflow：正确。** `workflow/runtime-default.ts:91` 原样透传 `request.maxRuntimeMs`，profile 值为 300_000/600_000（`workflow/default-config.ts` 多处、`session-fallback-profile.ts:43`），均 ≤ 两个 class ceiling，`min` 不改变结果。

**公式对 eval：错误。** 见 [HIGH-1]。

### 6.3 `evaluateBenchmarkQualityGate` 扩展（评审要求 3.2）

**最小现有 owner：是。** `evaluateBenchmarkQualityGate`（`runner.ts:523`）确为唯一质量判定器，且现状确实**不读** `firstPassed`——只有 `buildScorecard`（`:410-414`）算聚合 `firstPassRate`。设计不新建第二判定器，正确。

**逐 run 而非聚合：正确且可实现。** `BenchmarkVariantSummary.runs` 在 gate 内可直接访问（`:551` 起对 `summary.runs` 已有多处 filter），因此逐 run `firstPassed !== true` 检查**无需改 `buildScorecard`**。设计 §6.2 写「`buildScorecard` 对 required IDs 保留逐 run 失败记录」——现状已天然保留，该句是冗余但无害。

**required IDs 存在：是。** `permission-readonly-review`（`fixtures.ts:325, 649`）与 `schema-repair-boundary`（`:319, 641`）真实存在，且已被现有测试 `p012-production-wiring.test.ts:1353` 作为一对使用。

**与真实 suite 一致：否。** 见 [HIGH-2]。

**null 当错的风险：存在。** 见 [MEDIUM-1]。

### 6.4 fixture 隔离与 env 合同（评审要求 3.3）

逐个核对 §6.3 声称的 env 变量：

| env | 是否为 `@oh-my-pi/pi-utils/dirs` 真实合同 | 证据 |
|---|---|---|
| `HOME` | **是**（经 `os.homedir()`） | `task/discovery.ts:70` `home: string = os.homedir()`；`utils/src/dirs.ts:385` `RESOLVER_HOME = os.homedir()`（模块加载时求值，子进程新鲜） |
| `USERPROFILE` | 是（Windows 分支，本机 inert，无害） | 同上 |
| `PI_CONFIG_DIR` | **是** | `utils/src/dirs.ts:210` `process.env.PI_CONFIG_DIR \|\| CONFIG_DIR_NAME` |
| `OMP_PROFILE` / `PI_PROFILE` | **是** | `utils/src/dirs.ts:38` `PROFILE_ENV_KEYS`、`:90`、`:120`；空 `OMP_PROFILE` 选默认 profile 的语义与设计意图一致 |
| `PI_CODING_AGENT_DIR` | **是** | `utils/src/dirs.ts:329, 358, 366-378, 417` |
| `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` | **是** | `utils/src/dirs.ts:286-288` `resolveIf(...)` |
| `XDG_CONFIG_HOME` | **否** | 该 key 在 `utils/src/dirs.ts` 中不出现；只被 `tools/github-cache.ts:171`、`lsp/lspmux.ts:73`、eval runtime 白名单使用 |

`@oh-my-pi/pi-utils/dirs` 子路径导入合法（`packages/utils/package.json` 的 `"./*"` → `./src/*.ts`）。

**「新进程 + 临时 HOME/config root + 干净 cwd」确实隔离 user agents**：`discoverAgents` 的 user 目录来自 `getConfigDirs(...)`，其基址由 HOME 决定；子进程 HOME 已换。设计明确 `Settings.isolated()`（真实存在，`config/settings.ts:514`）不承担 discovery 隔离——该纠正正确。

**未覆盖来源（见 [MEDIUM-4]）**：project 发现是**向上遍历**（`discovery/helpers.ts:846-865`，`while (dir !== homeDir)`），设计只约束了 tempCwd 自身；`COPILOT_HOME`（`discovery/helpers.ts:119-121`）是独立于 HOME 的插件根覆盖。

### 6.5 fixture 执行入口与成本 owner（评审要求 3.4）

- **可执行性：是。** `bun <path> --mode …` 可直接运行；`scripts/ci-test-ts.ts:236` 只收集 `.test.ts`，因此该文件不会被 `bun run test` / `ci:test:ts` 误收，不会因顶层副作用污染全套测试。仓库已有 `test/workflow/helpers.ts` 这类非测试文件先例，放置位置符合约定。
- **发布门约定：不满足。** 见 [HIGH-3]。

### 6.6 `src/latency/active-wall.ts` 与 percentile 复用（评审要求 3.5）

- 新 helper 合理：`src/latency/` 是中性 owner（已含 `rollout-cohort.ts`、`mechanical-class.ts` 等 11 个模块），pure 签名把 I/O 推给 fixture，符合「不把会话解析泄漏进 runtime 模块」的 Round 2 建议。设计已标「拟新增」。
- `percentile` **确为已 export 的现有 API**：`src/latency/rollout-cohort.ts:297` `export function percentile(sorted: number[], p: number): number | undefined`，nearest-rank，注释与设计一致；经 `src/latency/index.ts` 星号 barrel 再导出。**不是**虚构 owner。
- 注意：该函数要求**已排序**输入（`percentile(sorted, p)`），设计未提排序责任归属；由 fixture 承担即可，不构成 finding，但实现时不可漏。

### 6.7 n=5 / n=20 的诚实性（评审要求 3.6）

- 诚实：§6.3 明确 smoke n=5 「**不计算或报告 p90**」，只门禁 p50/max/hard timeout/identity；release n=20/variant 报 p50/p90。这正面回应了 Round 2 的「n=5 时 nearest-rank p90 = 样本最大值」。
- 足够性：n=20 对 p90 是 nearest-rank 第 18 项，判别力仍有限但设计已明说「接受该成本作为发布级 p90 的最低样本成本」，属诚实取舍，不再是虚假精度。
- **未闭合**：成本（42 次 live 执行）、flakiness 处置（无重跑/剔除规则，只有「identity 不符整次 fail」）、执行 owner 三者中，只有 flakiness 的一部分被规定；成本与 owner 完全悬空。见 [HIGH-3]。

### 6.8 `wrapUpNoticeSent` race contract（评审要求 3.7）

合同本身**正确且不需要第二 engine**：

- 「先置 latch，enqueue 前复查 `resolved` / terminal yield / `abortSent` / `budgetStopRequested`，任一成立即丢弃且不补发」——避免了晚到 steer 与双 notice。
- 现有实现已具备可复用的三要素：一次性 latch（`executor.ts:1767` `budgetSteerSent = true`）、异步边界（`:1775` `void Promise.resolve().then(...)`）、rejection 只 `logger.warn`（`:1777-1781`）。设计的「rejection 只记日志、不清 latch、不重试」与现状一致。
- 现有 75% timer 的同步终态检查（`:1314` `if (resolved || abortSent || budgetStopRequested) return;`）已是同型防御。
- forced-stop 干扰已被排除：设计明确 1.5× forced stop 仍走 `requestBudgetStop("soft_budget")`，advisory 路径不置 `budgetStopRequested`，`resolveSubagentCompletionKind`（`:986-997`，`runtimeLimitExceeded` 优先于 `budgetStopRequested`）不改。
- 测试 owner `executor-wall-clock.test.ts` 真实存在且已有 12 个同域用例（含 `a late successful yield does not flip a timed-out run to success`、`commits a yield tool call before the soft request budget aborts the turn`），扩展位置正确。

两处小瑕疵见 [LOW-1]、[LOW-2]。

### 6.9 #8462 / #5372 与实际 touched files 的一致性（评审要求 3.8）

- **诚实：是。** §6.4 对 #8462 明确写「仓库内未定位到完整 prevention regression」、「本轮不新增测试、不声称覆盖」；对 #5372 写「仅监测，非 prevention」。§6.5「不做」重申「不为 #8462/#5372 新增弱 timer smoke」。这正面关闭了 Round 2 的 MEDIUM-4，且符合 §1.2「不新增弱 smoke 冒充 prevention 回归」。
- **与 planned touched files 一致：基本是。** 计划触及 `task/index.ts`、`structured-subagent.ts`、`executor.ts`、`review-performance.ts`、`latency/active-wall.ts`、`benchmark/runner.ts`、`settings-schema.ts`、`scout.md`、`subagent-system-prompt.md`、`types.ts` 注释——不含 post-yield ingest、`pushLoopPhase`、`EventLoopKeepalive`、TUI loop watchdog 任一 owner，与「不触及则不补测试」的前提相符。
- **一处遗漏**：新增的 advisory steer 会向子会话用户消息队列 enqueue，属于子侧 idle/quiescence 相邻面，而 §6.4 末段的实现验证清单未列 `executor-async-quiescence.test.ts`。见 [MEDIUM-3]。

### 6.10 `read-summarize: true`（评审要求 3.9）

设计称其「既非确定性杠杆、只是与 schema 默认对齐的声明、不计入达标因果」。**该定性不准确**：它不是惰性声明，而是移除了一次现有的 child settings 强制写入。见 [MEDIUM-2]。

### 6.11 越界检查（评审要求 3.10）

| 检查项 | 结论 |
|---|---|
| 新增无消费者字段 | **无**。`performanceClass` / `effectiveMaxRuntimeMs` 均被 `buildExecutorOptions` 消费；明确不加 `configuredMaxRuntimeMs`、不扩 `SubagentCheckpointMetrics.kind`、不加 `AgentDefinition` 字段、不加 frontmatter `class` |
| 第二引擎 | **无**。class 函数住在现有 `review-performance.ts`；判定器复用 `evaluateBenchmarkQualityGate`；completion kind 不新增；`resolveSubagentCompletionKind` 不改 |
| 通用 role framework | **无**。`shadowReview` 仍是 `"code" \| "off"`，明确不参与 assignment/output schema 校验，只作 class 的独立输入之一 |
| feature flag / 遥测平台 | **无**。§5.3 明确不新增 settings key、不新增 flag、不新增遥测管道；kill switch 复用现有两个 `0` 语义 |
| 越界测试 | **基本无**，但有两处需注意：不为 #8462/#5372 造弱测试（好）；新建 `read-summarize-merge.test.ts` 与既有 owner 重叠（[LOW-5]） |
| 删除现有 helper 的处置 | 合理。`resolveReviewerSoftRuntimeMs` / `resolveReviewerSoftRequestBudget` 停止作为执行路径、`isReviewerAgentName` 降级为 floor 名识别——避免把 explore 塞进 reviewer 命名 helper，符合 Round 2 建议 6 |

## 7. Findings

### CRITICAL

无。

### HIGH

#### [HIGH-1] 设计以「eval 传显式 remaining cap」为公式正当性依据，但该调用方不存在；新 class ceiling 会静默改变 eval fan-out 的墙钟合同

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` §5.2 步骤 6–7（约 L207–208）、§5.4 首条（约 L319）、§6.1 表第二行与「runtime precedence 测试矩阵」第三条（约 L361、L375）、§7（约 L429）
- `packages/coding-agent/src/eval/agent-bridge.ts:144-165`（尤其 `:156-158`）
- `packages/coding-agent/src/workflow/structured-output-repair.ts:590-622`
- `packages/coding-agent/src/task/structured-subagent.ts:117-118`
- `packages/coding-agent/src/workflow/runtime-default.ts:91`
- `packages/coding-agent/test/workflow/benchmark/live-runtime.test.ts:353-391`

**问题**

设计四处声明「workflow/eval 的显式 profile cap 和 schema-retry remaining cap 因此不会被 global setting `0` 吞掉 / 保持不变」，并在 §6.1 要求为「eval/schema retry」写「显式更严 remaining cap 在 retry 后仍生效」的测试。

源码事实与之矛盾：

1. `eval/agent-bridge.ts:156-158` 在构造 `runStructuredSubagent` 请求时有显式注释——「`maxRuntimeMs` is intentionally omitted: the executor then inherits `task.maxRuntimeMs`, matching the task tool. Pinning it to 0 here silently overrode the user's wall-clock cap for eval fan-outs.」即 eval **故意不传** `maxRuntimeMs`，且历史上有过因擅自 pin 值而破坏用户合同的教训。
2. `budgetFromProfileUsage`（`structured-output-repair.ts:590-622`）产出的 `remainingTimeMs` 落在 `StructuredRepairBudget` 上，全仓库无任何位置把它赋给 `StructuredSubagentRequest.maxRuntimeMs`。所谓「schema-retry remaining cap」这条 subagent runtime 通道不存在。
3. §6.1 为该行指定的 owner `test/workflow/benchmark/live-runtime.test.ts` 实际断言的是 **workflow profile override** 的 `maxRuntimeMs: 600_000`（`:356, :389`），与 eval bridge、schema repair 无关。

由此还派生一个设计未承认的行为变更：由于 eval 走 `undefined`，新公式会让它落到 `min(fresh setting, class ceiling)`。而现状的 30 min ceiling 只存在于 `task/index.ts`（TaskTool 专属），eval 从不受其约束。实施后，eval fan-out 中名为 `reviewer`/`subagent-sol`/… 的 spawn 将首次被压到 30 min，名为 `scout`/`sonic` 的将被压到 10 min。

**影响**

- 公式的正当性论证建立在不存在的事实上；评审与实现者会据此认为「eval 不受影响」，而实际相反。
- eval 长跑 fan-out（例如 eval 里跑 `scout` 做大范围检索）会新增一个 10 min 硬超时，走 `requestAbort("timeout")` 路径，表现为静默截断——正是 `agent-bridge.ts` 注释所警告的失败模式。
- §6.1 强制的「eval/schema retry remaining cap」测试行**无法被诚实实现**：要么断言一个不存在的合同，要么临时发明一个 caller——两者都会产生设计自己禁止的虚假 owner 测试。

**建议**

1. 更正 §5.2/§5.4/§7 的事实陈述：明确当前只有 **workflow**（`runtime-default.ts:91`，profile 值 300_000/600_000）传显式 `request.maxRuntimeMs`；**eval bridge 故意省略**，schema-repair 的 remaining time 不流向 subagent runtime。
2. 显式决定并写明 eval 的目标语义，二选一：(a) class ceiling 同样适用于 eval，并在正文承认这是**新增约束**、说明为何可接受、以及为何不会重演 `agent-bridge.ts:156-158` 警告的问题；或 (b) class ceiling 仅对 `invocationKind === "task"` 生效，eval 保持现状（`EffectiveSubagentPolicy` 已能读到 `request.invocationKind`）。
3. 把 §6.1 该行的 owner 改成真实路径：workflow 侧继续用 `runtime-adapter.test.ts`；eval 侧用 `test/eval/agent-bridge.test.ts` 或 `test/eval/agent-bridge-policy.test.ts` 断言「eval 请求恒不带 `maxRuntimeMs`」与所选语义；删除「schema-retry remaining cap」这一行，或改为断言 `StructuredRepairBudget.remainingTimeMs` 不影响 subagent 墙钟。

---

#### [HIGH-2] 质量绝对合同选错 required cases，且所称的 known-defect / verdict 门在判定器中不存在

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` §1.2「质量绝对合同」（约 L52）、§5.3 runner.ts 条目（约 L286）、§6.2「required live review/Gate cases」（约 L380–385）、§7（约 L437）
- `packages/coding-agent/src/workflow/benchmark/fixtures.ts:640-659`
- `packages/coding-agent/src/workflow/benchmark/fixtures.ts:491-503`、`:504-516`、`:611-619`
- `packages/coding-agent/src/workflow/benchmark/runner.ts:523-629`

**问题**

**（a）required case 与 suite 真实结构不符。** 设计把两案称为「required live review/Gate cases」并作为质量绝对合同：

- `permission-readonly-review`（`fixtures.ts:649-659`）：`category: "permission_safety"`，successCriteria 含「Known ambient-secret risk is reported」。设计对它的描述（known ambient-secret defect 必须检出、readonly、结构化 review artifact）**与 fixture 逐条吻合**，选它合理。
- `schema-repair-boundary`（`fixtures.ts:640-647`）：`category: "schema_heavy"`，request 是「Remove JSON fences deterministically and fail closed on missing fields」，successCriteria 是「Fences are removed / Missing fields throw / Valid JSON is preserved」。**这不是 review 案，也没有任何 verdict 判据。** 设计称它保证「verdict/修复边界正确」，与 fixture 不符。

同时，suite 中真正的 `code_review` 类别有三个案被完全排除：`review-security-paths`（`:491`，「Known traversal finding is evidenced」）、`review-error-handling`（`:504`，「Known swallowed error is found」）、`review-state-transition`（`:611`，「Both known risks are assessed / Findings cite evidence」）。这三案的判据恰好是「已知缺陷必须被证据化检出」——正是设计 §5.5 头号风险「review wrap-up 让 findings 变少，质量回退」所需要的防线。

**（b）known-defect 与 verdict 不是判定器里的门。** 设计称扩展后「同时保留 known-defect、verdict、completion provenance、scope 与 runtime identity 门」。逐条核对 `evaluateBenchmarkQualityGate`（`runner.ts:523-629`）：completion kind（`:559-578`）✓、runtime provenance（`:565-570`）✓、scope（`:584-609`）✓、passRate/drop/quality-drop ✓；**known-defect 无独立检查**（只作为 fixture 的 successCriteria 字符串，间接经 `passed` → `minPassRate: 100` 生效）；**`verdict` 在 `packages/coding-agent/src/workflow/benchmark/` 全目录零出现**。

**影响**

- 唯一被强制到「每 run first-pass」级别的两案中，有一案完全无法侦测 review findings 减少；被排除的三案才是能侦测的。质量绝对合同因此**防不住它声称要防的风险**。
- 「保留 known-defect、verdict 门」使读者以为判定器已有两道独立检查，实际只有 fixture successCriteria 的间接效果与一个不存在的名字。这会让实现者以为无需额外工作即可满足 §1.2。
- 注：现有测试 `p012-production-wiring.test.ts:1350` 的用例名把这两案称作「live paired code-review and Design-Gate cases」，设计很可能沿用了这个既有误标——但沿用不改变事实错误。

**建议**

1. 把 required 集合改为真正覆盖 review 质量的案：至少纳入 `review-security-paths` / `review-error-handling` / `review-state-transition` 中的一到多个（它们的 known-defect 判据可直接支撑「wrap-up 后 findings 不减少」），保留 `permission-readonly-review`；`schema-repair-boundary` 若保留，须改述为「schema 修复边界」而非「review/Gate verdict」。
2. 删除或改写「known-defect、verdict 门」的表述：改为「known defect 经 fixture successCriteria → `passed` → `minPassRate: 100` 间接 fail-close；判定器无独立 verdict 检查」。若确实需要 verdict 级门，必须写明它是**新增**检查、其 producer 字段与 fail-close 语义——但这会超出「最小扩展」，应优先选方案 1。
3. §6.2 中 `p012-production-wiring.test.ts` 的新增用例须按修正后的 ID 集合编写，且用例名不要复制既有的 category 误标。

---

#### [HIGH-3] 42 次 live 模型执行的「发布门禁」没有任何 CI / release / script owner，也无成本上限与 kill switch

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` §1.2「产品 fixture 是发布门禁」（约 L49）、§6.3「样本量」与「未达标」（约 L399、L403）、§6 表末行「latency 门独立」（约 L367）
- `.github/workflows/`（`ci.yml`、`nix.yml`、`bazel-cache-warm.yml`）
- `package.json:97-133, 165`
- `scripts/release.ts`
- `scripts/ci-test-ts.ts:236`

**问题**

设计把产品 fixture 定为发布门禁，并在 §6.3 明确 release 模式「两 variant 共 42 次模型执行（含 warmup），接受该成本作为发布级 p90 的最低样本成本」。但仓库中不存在可以承接它的执行点：

- `.github/workflows/` 三个 workflow 全文无 `benchmark` 或 `latency` 字样（已 grep 确认零命中）。
- `package.json` 的 `ci:test:*` 家族（`:122-132`）全部指向 `scripts/ci-test-ts.ts` 或 hermetic smoke（`ci:test:smoke` 只跑 `--version/--help/--smoke-test`）；无 latency/benchmark script。
- `scripts/release.ts` 中无 `ci:test` / `bun test` 调用（grep 零命中），即 `bun run release` 不会执行任何测试门。
- `scripts/ci-test-ts.ts:236` 只收集 `.test.ts`，因此该 fixture 也不会被任何现有测试 bucket 自动带上。

同时，设计未规定：谁在什么时机运行它、失败时阻断哪一步、provider 凭据从哪来、单次 release 的 token/费用上限、以及在 provider 不可用或额度耗尽时的降级/跳过规则（现有唯一处置是「identity 不符整次 fail」）。

**影响**

- §1.2「产品 fixture 是发布门禁，不依赖用户是否立刻打出 n≥20 的新语料」在当前仓库中**不可执行**。整个成功标准的产品层支柱悬空，实施后无人会真正跑它,「未达标不得宣称成功」失去强制力。
- 42 次真实模型执行的成本与时长没有上限与 owner，属于在未授权网络成本控制的前提下引入不受管的外部开销。
- 缺少 kill switch：设计为产品代码路径保留了 `task.maxRuntimeMs===0` / `task.softRequestBudget===0`，却没有为这条新验收门给出等价的「关闭/跳过」路径。

**建议**

1. 在 §6.3 指定真实 owner，并写清阻断范围。可选：新增 `package.json` script（例如 `latency:fixture:smoke` / `latency:fixture:release`）；在 `scripts/release.ts` 中显式调用 release 模式并规定失败即中止；或明确它是**手动发布前检查**而非自动门——若选后者，须同步下调 §1.2 的「发布门禁」措辞，避免过度承诺。
2. 写明成本与凭据合同：单次 release 的模型调用次数上限（当前 42）、预期时长、所需 provider/凭据、以及在凭据缺失/额度不足时的行为（跳过并标记「未验证」，而不是静默 PASS）。
3. 为该门补一个显式 kill switch 或跳过条件，并规定跳过时**不得**宣称达标——与 §6.3「未达标不得宣称成功」同级。
4. smoke 模式（n=5，无 live p90 声明）若成本可接受，可考虑挂到某个既有 CI bucket；release 模式保持人工/发布时触发。二者的 owner 必须分开写明。

### MEDIUM

#### [MEDIUM-1] `firstPassed` fail-close 未按 `liveQualityUnknown` 限域，且与该字段「null = 未观测」的既有合同冲突

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` §5.3 runner.ts 条目（约 L286）、§6.2 第 4 条（约 L385）
- `packages/coding-agent/src/workflow/benchmark/runner.ts:37-38`
- `packages/coding-agent/src/workflow/benchmark/runner.ts:360, 375`
- `packages/coding-agent/src/workflow/benchmark/runner.ts:410-414`
- `packages/coding-agent/src/workflow/benchmark/runner.ts:551-609`

**问题**

设计写「对这两案的 baseline/optimized **每个有效 run**，`firstPassed` 必须显式为 `true`，missing/false 均 fail-close」。两处不自洽：

1. **「每个有效 run」与「missing 均 fail-close」互斥。** `BenchmarkRuntimeResponse.firstPassed` 的既有文档合同是「First-attempt pass when known; **omit/null when unobserved**」（`runner.ts:37-38`），`buildScorecard:410` 正是据此把 `null` 排除出观测集。`runBenchmarkSuite` 在 run 出错时也主动写 `firstPassed: null`（`:375`）。把 `null` 一律当失败，等于推翻该字段的既有语义。
2. **未按 `liveQualityUnknown` 限域。** 同一函数内所有「绝对」检查（undersampling `:553`、missing completionKind `:558`、missing runtime provenance `:565`、scope 必须 adhered `:599`）都显式包在 `if (!scorecard.liveQualityUnknown)` 内，唯独设计新增的这条没写限域。`liveQualityUnknown` 默认为 `true`（`:466`），即 fake/结构化路径是默认。

现有 fake 路径消费者尚不会因此立刻变红——`createFakeBenchmarkRuntime` 设 `firstPassed: passed`（`fixtures.ts:755`），默认无 `failOptimized` 时全为 `true`，故 `paired-smoke.test.ts:73-74` 的 `gate.passed === true` 仍成立。但只要某个 fake/历史 case 的 runtime 按既有合同省略 `firstPassed`，或某个测试对这两个 ID 注入 `failOptimized`，门就会在非 live 语境下 fail-close。

**影响**

- 判定器行为在 live 与 fake 两条路径上不一致，且不一致点未被正文说明；实现者会按字面写出无限域版本，把结构化/回放路径也纳入约束。
- 与字段既有 `null` 语义冲突，可能倒逼所有 runtime 都必须报 `firstPassed`，扩大改动面。

**建议**

在 §5.3 与 §6.2 明确限域与 null 语义，例如：「仅当 `scorecard.liveQualityUnknown === false` 时对 required IDs 执行；此时 `firstPassed` 缺失（`undefined`/`null`）与 `false` 同为 fail-close，理由是 live 验收要求显式观测；`liveQualityUnknown === true` 时不施加该检查。」并在 `p012-production-wiring.test.ts` 的新增用例中同时覆盖 live fail-close 与 fake 不受影响两条分支。

---

#### [MEDIUM-2] `read-summarize: false → true` 被写成惰性声明，实际是移除现有强制 override 的真实行为变更，且其质量风险方向未评估

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` §1.4 末条（约 L79）、§5.3「`read-summarize: true` 合并语义（最小充分）」（约 L304–310）、§5.5 第二条风险（约 L335）、§7（约 L432）
- `packages/coding-agent/src/prompts/agents/scout.md`（frontmatter `read-summarize: false`）
- `packages/coding-agent/src/task/executor.ts:2922`
- `packages/coding-agent/src/task/executor.ts:3491`
- `packages/coding-agent/src/task/persisted-revive.ts:89`
- `packages/coding-agent/src/config/settings-schema.ts:3740-3742`
- `packages/coding-agent/src/tools/read.ts:1626`

**问题**

设计称：「本方案保持 false-only 合并……因此 scout frontmatter `true` 只是与 schema 默认对齐的 **agent 声明**，**不是**确定性加速杠杆，不计入 §1.2 达标因果。」

false-only 合并本身描述准确（`executor.ts:2922`、`persisted-revive.ts:89` 均为 `=== false` 才写入）。但由此得出「改 frontmatter 是惰性声明」不成立：

- scout 当前是 `read-summarize: false`，因此每次 spawn 都会命中 `executor.ts:2922`，向 child settings 写入 `read.summarize.enabled: false`；`executor.ts:3491` 又把 `readSummarize: agent.readSummarize` 持久化，使 revive 经 `persisted-revive.ts:89` 重复该写入。
- 改成 `true` 后，这两处写入**不再发生**。child 于是回落到 schema 默认 `read.summarize.enabled: true`（`settings-schema.ts:3742`），而该 key 被 `tools/read.ts:1626` 实际消费，直接决定 read 结果是否被摘要。

即：这不是「强制 true」（设计正确地拒绝了强制），而是**取消现有的强制 false**。对绝大多数用户（未显式关闭摘要）而言，scout 的读取行为从「全保真」变为「被摘要」——这是一个真实且方向明确的工作量削减，正是设计想要的 explore 加速之一。

同时 §5.5 只写了「`read-summarize: true` 对用户关摘要无效」这一（正确但次要的）风险，未评估相反方向：scout 失去全保真读取后可能漏证据——而 §5.5 恰恰为 `thinking-level: medium` 评估了同类风险。

**影响**

- §1.2 的因果账目失真：一个真实杠杆被排除在达标因果之外，会让「10/40/75% + prompt 收口」的贡献被高估或低估，影响未达标时的归因。
- 一个会改变 bundled agent 读取保真度的改动被标为惰性，可能在实现与评审中被跳过质量影响审查。
- §5.5 的风险表缺一条方向。

**建议**

1. 在 §5.3 改述为：「scout 由 `false` 改为 `true` 的实质是**取消现有的 child `read.summarize.enabled=false` 强制写入**（spawn 与 revive 两处），使其回落到 schema 默认 true；对显式关闭摘要的用户仍保持关闭。」并把它列入 explore 工作量杠杆清单（与 thinking-level/medium、去 keep-going 并列），或明确说明为何不计入。
2. 在 §5.5 补一条风险：「scout 失去全保真读取后可能漏证据」，缓解可复用现有条文（scout 是压缩 handoff 不是 Gate；空搜必须换策略；质量门不建立在 scout 单独 PASS 上）。
3. 若不接受该行为变更，则保留 `read-summarize: false` 不改——但那样 §5.3 就不该再出现该 frontmatter 改动。

---

#### [MEDIUM-3] 实现验证清单未包含 `executor-async-quiescence.test.ts`，尽管新增 advisory steer 会写入子会话消息队列

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` §6.4 末段（约 L418）、§6.1 表第 4 行（约 L363）
- `packages/coding-agent/src/task/executor.ts:1769-1781`
- `packages/coding-agent/test/task/executor-async-quiescence.test.ts:301`

**问题**

§6.4 末段规定「实现验证只运行与实际 diff 触及路径相关的现有测试」，列出 performance/class、structured runtime、executor wall-clock/soft-budget、prompt/frontmatter、required quality gate 与 #4957 regression。

新增的 75% advisory 会经 `sendUserMessage(..., { deliverAs: "steer" })` 把一条消息 enqueue 进子会话队列（现有同型路径见 `executor.ts:1775-1776`）。该 enqueue 会影响子代理的空闲/静默判定与 turn 结束时机——`executor-async-quiescence.test.ts` 正是该域的现有 owner，其中 `does not wait on a second idle barrier after a terminal yield`（`:301`）直接约束 terminal yield 后的 idle barrier 行为，而设计的 race contract 恰恰要求「terminal yield 后丢弃 advisory」。

**影响**

清单遗漏会让实现者在改完 75% 路径后不跑该文件；若新 steer 在 terminal yield 边界上多制造一个 idle barrier 或额外 turn，回归不会被这一轮验证捕获——而这正是 §5.5「不为凑数改 yield」与 §1.2「不回归 hang 边界」想要守住的面。

**建议**

在 §6.4 末段的运行清单中加入 `packages/coding-agent/test/task/executor-async-quiescence.test.ts`，并在 §6.1 的 75% race 行的 owner 中一并标注（保持「与 diff 触及路径相关」的原则，不扩大到无关文件）。

---

#### [MEDIUM-4] fixture 隔离遗漏祖先目录的 project agent discovery 与 `COPILOT_HOME` 覆盖

**位置**

- `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` §6.3「隔离方式」（约 L392–394）
- `packages/coding-agent/src/task/discovery.ts:70-121`
- `packages/coding-agent/src/discovery/helpers.ts:846-865`
- `packages/coding-agent/src/discovery/helpers.ts:119-121`

**问题**

设计的隔离手段是「独立 `tempHome` + 不含 `.omp/agents` 的 `tempCwd` + 一组 env」。两处未覆盖：

1. **project 发现是向上遍历，不只看 cwd 本身。** `discoverAgents` 通过 `findAllNearestProjectConfigDirs` 收集 project 目录（`discovery.ts:87-104`），其遍历循环 `while (dir !== homeDir)`（`helpers.ts:846-865`）从 cwd 逐级上溯、以 `os.homedir()` 为终点。子进程 HOME 已改为 `tempHome`，而 `tempCwd` 若不在 `tempHome` 之下（例如放在 `os.tmpdir()` 或仓库内），上溯不会在 `tempHome` 处停止。设计只约束了 `tempCwd` 自身不含 `.omp/agents`，未约束其祖先，也未要求 `tempCwd` 位于 `tempHome` 内。
2. **`COPILOT_HOME` 是独立于 HOME 的插件根覆盖**（`helpers.ts:119-121`：`process.env.COPILOT_HOME?.trim()` 优先于 `<home>/.copilot`）。设计枚举了要设置/删除的 env，但未清除该继承变量。

**影响**

- 若 `tempCwd` 落在仓库内或任何含 `.omp`/插件配置的祖先路径下，project 来源的同名 `scout`/`reviewer` 会覆盖 bundled 定义，fixture 便不再度量产品默认。这正是 Round 2 HIGH-3 要防的失效模式的残余。
- 继承的 `COPILOT_HOME` 会把插件根指向临时 HOME 之外的真实目录，绕过隔离。

**建议**

1. 在 §6.3 明确要求 `tempCwd` 位于 `tempHome` 之下（使祖先遍历在 `tempHome` 处终止），或显式断言从 `tempCwd` 上溯至 `tempHome`/文件系统根的路径上不存在任何 project 配置目录。
2. 在 env 清单中补上删除 `COPILOT_HOME`（与已列的删除 `PI_CODING_AGENT_DIR` 同处理）。
3. 保留并强化既有的 `effectiveAgent.source==="bundled"` 断言作为最终防线——该断言字段真实（`task/types.ts:397` `source: AgentSource`，`AgentSource = "bundled" | "user" | "project"`；bundled 由 `task/agents.ts:141` 以 `"bundled"` 解析），是可靠的兜底。

### LOW

#### [LOW-1] `wrapUpNoticeSent` 被列在「符号均为已核对的现有名字」之下，但现有 latch 名为 `budgetSteerSent`

**位置**

- design.md §5.2「75% 与 completion 合同（冻结）」（约 L231）、§5.3 开头「只列将改路径。符号均为已核对的现有名字。」（约 L269）与 executor 条目（约 L283）
- `packages/coding-agent/src/task/executor.ts:1767`

**问题**：现有一次性 latch 是 `budgetSteerSent`（`:1767`）。`wrapUpNoticeSent` 是本方案新引入的合并后 latch，但被放在声明「符号均为已核对的现有名字」的小节中，且未标「拟新增」（同节中 `buildSoftRuntimeNotice`、`resolveClassSoftRequestBudget` 等已明确标为新增）。

**影响**：读者/实现者可能去找一个不存在的现有符号。无功能影响。

**建议**：标注为「新增（由现有 `budgetSteerSent` 合并改名而来）」，或直接沿用 `budgetSteerSent` 并说明其职责扩大为覆盖 runtime advisory。

---

#### [LOW-2] 取消 75% 的 `requestBudgetStop` 也会移除该时点现有的 checkpoint 记录，正文称「现有 checkpoint 保持不变」

**位置**

- design.md §5.2（约 L233「不新增 `"soft_runtime"` checkpoint……现有 hard timeout / soft budget checkpoint 保持不变」）
- `packages/coding-agent/src/task/executor.ts:1248-1255`
- `packages/coding-agent/src/task/executor.ts:1313-1322`
- `packages/coding-agent/src/task/executor.ts:1333-1337`
- `packages/coding-agent/src/task/index.ts:167`

**问题**：现状下 75% timer 调用 `requestBudgetStop("runtime_timeout")`（`:1321`），而 `requestBudgetStop` 内部会 `progress.reviewMetrics?.checkpoints.push({ atMs, requests, kind })`（`:1251-1255`）。改为纯 advisory 后，这条 75% 时点的 checkpoint 将不再产生。hard timeout 的 checkpoint（`:1333-1337`）与 request-count 触发的 checkpoint 不受影响。

**影响**：极小。`reviewMetrics` 的唯一下游是 `task/index.ts:167` 的字段传递，未见渲染或持久化消费者。但正文「保持不变」的表述不精确。

**建议**：把该句改为「hard timeout 与 request-count 触发的 checkpoint 保持不变；75% 时点原经 `requestBudgetStop` 产生的 checkpoint 随 advisory 化一并移除，无已知消费者」。

---

#### [LOW-3] `XDG_CONFIG_HOME` 被列为 `@oh-my-pi/pi-utils/dirs` 的既有 env 合同，但该文件不读取它

**位置**

- design.md §6.3「隔离方式」（约 L393）
- `packages/utils/src/dirs.ts:286-288`

**问题**：`dirs.ts` 只解析 `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME`（`:286-288`）；`XDG_CONFIG_HOME` 在该文件中不出现（仅被 `tools/github-cache.ts:171`、`lsp/lspmux.ts:73` 与 eval runtime 白名单使用）。设计称「这些是 `@oh-my-pi/pi-utils/dirs` 已存在的真实 env 合同」，对该项不成立。

**影响**：无功能影响（设置它是无害的超集，且对 lspmux/github-cache 反而有额外隔离价值），仅事实描述不准。

**建议**：改述为「`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` 是 `dirs.ts` 的既有合同；`XDG_CONFIG_HOME` 另为 lspmux / github-cache 等消费者服务，一并设置以扩大隔离面」。

---

#### [LOW-4] 新增 `src/latency/active-wall.ts` 未说明需接入 `src/latency/index.ts` 星号 barrel

**位置**

- design.md §5.3 latency 条目（约 L276）
- `packages/coding-agent/src/latency/index.ts`

**问题**：该目录的 `index.ts` 对每个模块使用 `export * from "./<module>"`（现有 10 条）。设计未提新文件需加入该 barrel，也未说明消费者（fixture、用户语料脚本）经 barrel 还是直接路径导入。

**影响**：极小，实现时补上即可；但仓库 barrel 约定明确，写入设计可避免遗漏。

**建议**：在 §5.3 补一句「新增模块按现有约定加入 `src/latency/index.ts` 的星号 barrel」。另建议同时写明 `percentile(sorted, p)` 要求**已排序**输入，排序责任在 fixture。

---

#### [LOW-5] 新建 `test/task/read-summarize-merge.test.ts` 与既有合并 owner 重叠

**位置**

- design.md §6.1 表第 5 行（约 L364）
- `packages/coding-agent/test/task/create-subagent-settings.test.ts`
- `packages/coding-agent/test/task/persisted-revive.test.ts`

**问题**：spawn 侧合并的既有 owner 是 `create-subagent-settings.test.ts`（对应 `executor.ts:2922` 的 `createSubagentSettings`），revive 侧是 `persisted-revive.test.ts`（对应 `persisted-revive.ts:89`）。设计新建第三个文件承载同一合同，会把一个 precedence 契约拆到三处。

**影响**：小。测试本身有真实消费者（scout 改 `true` 后需保证不覆盖用户显式 `false`），不属于弱测试；仅是 owner 分散。

**建议**：把 spawn 侧断言放进 `create-subagent-settings.test.ts`、revive 侧放进 `persisted-revive.test.ts`，不新建文件；或在设计中说明为何需要独立文件。

## 8. Gate Evidence

### 8.1 独立复核的源码事实（全部为本轮实际打开/检索所得）

**runtime / class 时序**

- 四名称 ceiling 与 `0` 语义：`packages/coding-agent/src/task/index.ts:56-71`
- TaskTool 两处预解析：`packages/coding-agent/src/task/index.ts:801`、`:1628`
- preflight 与 run 两个解析入口：`packages/coding-agent/src/task/index.ts:787-788`、`:1606`
- fresh reload → discovery → getAgent：`packages/coding-agent/src/task/structured-subagent.ts:260`、`:267`、`:268`
- `EffectiveSubagentPolicy` 形状：`packages/coding-agent/src/task/structured-subagent.ts:132-148`
- `request.maxRuntimeMs` 公开合同注释：`packages/coding-agent/src/task/structured-subagent.ts:117-118`
- `buildExecutorOptions` 原样复制 request 值：`packages/coding-agent/src/task/structured-subagent.ts:437`、`:451`
- **eval 故意省略 maxRuntimeMs**：`packages/coding-agent/src/eval/agent-bridge.ts:156-158`
- schema-repair remaining time 不流向 subagent runtime：`packages/coding-agent/src/workflow/structured-output-repair.ts:590-622`
- workflow 透传 profile cap：`packages/coding-agent/src/workflow/runtime-default.ts:91`；profile 值 300_000/600_000：`packages/coding-agent/src/workflow/default-config.ts:172,199,308,349`、`session-fallback-profile.ts:43`

**executor 预算 / 提示**

- `SOFT_REQUEST_BUDGET` 实际值：`packages/coding-agent/src/task/executor.ts:121-126`
- `resolveSoftRequestBudget` 现签名：`packages/coding-agent/src/task/executor.ts:134-141`
- `BUDGET_STOP_GRACE_REQUESTS = 5`：`packages/coding-agent/src/task/executor.ts:144`
- `requestBudgetStop` 与 checkpoint push：`packages/coding-agent/src/task/executor.ts:1248-1264`
- 75% timer 现调用 `requestBudgetStop("runtime_timeout")`：`packages/coding-agent/src/task/executor.ts:1310-1322`
- hard cap `requestAbort("timeout")` 与 checkpoint：`packages/coding-agent/src/task/executor.ts:1324-1339`
- request-budget steer（latch + 异步边界 + catch-log）：`packages/coding-agent/src/task/executor.ts:1755-1783`
- `resolveSubagentCompletionKind` 优先级：`packages/coding-agent/src/task/executor.ts:986-997`
- `requireYieldTool: true` 与系统提示 render：`packages/coding-agent/src/task/executor.ts:3331`、`:3339-3350`
- false-only child override：`packages/coding-agent/src/task/executor.ts:2922`；持久化 `readSummarize`：`:3491`；revive 侧：`packages/coding-agent/src/task/persisted-revive.ts:89`

**review-performance / 提示 / frontmatter**

- 现有 reviewer 名单与 80 预算、`REVIEWER_SOFT_RUNTIME_RATIO=0.75`、`resolveReviewerSoftRuntimeMs`：`packages/coding-agent/src/task/review-performance.ts:5-25`、`:61-70`、`:97-101`
- `SubagentCheckpointMetrics.kind` 现有取值：`packages/coding-agent/src/task/review-performance.ts:47-51`
- scout frontmatter 与两条冲突正文：`packages/coding-agent/src/prompts/agents/scout.md`
- 子代理提示两条 keep-going 与既有 Handlebars 分支：`packages/coding-agent/src/prompts/system/subagent-system-prompt.md:47`、`:73`、`:4-68`
- frontmatter `shadowReview` 解析：`packages/coding-agent/src/discovery/helpers.ts:251`、`:324`、`:338`
- `read.summarize.enabled` 默认 true 与实际消费点：`packages/coding-agent/src/config/settings-schema.ts:3740-3742`、`packages/coding-agent/src/tools/read.ts:1626`

**质量门**

- `evaluateBenchmarkQualityGate` 全体检查项：`packages/coding-agent/src/workflow/benchmark/runner.ts:523-629`
- `firstPassed` 字段合同与 null 语义：`packages/coding-agent/src/workflow/benchmark/runner.ts:37-38`、`:360`、`:375`、`:410-414`
- `liveQualityUnknown` 默认 true：`packages/coding-agent/src/workflow/benchmark/runner.ts:466`
- required case 定义：`packages/coding-agent/src/workflow/benchmark/fixtures.ts:640-647`（`schema_heavy`）、`:649-659`（`permission_safety`）
- 真实 `code_review` 案：`packages/coding-agent/src/workflow/benchmark/fixtures.ts:491-503`、`:504-516`、`:611-619`
- fake runtime 的 `firstPassed`：`packages/coding-agent/src/workflow/benchmark/fixtures.ts:752-756`
- 现有 gate 测试（含两案配对用例）：`packages/coding-agent/test/workflow/p012-production-wiring.test.ts:1330-1347`、`:1350-1387`
- fake 路径 gate 期望 pass：`packages/coding-agent/test/workflow/benchmark/paired-smoke.test.ts:14-74`
- `verdict` 在 benchmark 目录零出现（rg 全目录零命中）

**fixture 隔离**

- `discoverAgents(cwd, home = os.homedir())` 与来源顺序：`packages/coding-agent/src/task/discovery.ts:70`、`:87-121`
- project 目录向上遍历以 homedir 为界：`packages/coding-agent/src/discovery/helpers.ts:846-865`
- `COPILOT_HOME` 覆盖：`packages/coding-agent/src/discovery/helpers.ts:119-121`
- dirs env 合同：`packages/utils/src/dirs.ts:38`、`:90`、`:120`、`:210`、`:286-288`、`:329`、`:358`、`:385`
- `@oh-my-pi/pi-utils/dirs` 子路径导出：`packages/utils/package.json:47-61`
- `Settings.isolated`：`packages/coding-agent/src/config/settings.ts:514`
- `AgentSource` 与 `AgentDefinition.source`：`packages/coding-agent/src/task/types.ts:10`、`:397`；bundled 解析：`packages/coding-agent/src/task/agents.ts:141`

**latency owner**

- 已导出 nearest-rank percentile：`packages/coding-agent/src/latency/rollout-cohort.ts:296-297`
- `src/latency/index.ts` 星号 barrel（10 条）

**hang 映射（§6.4 表，逐条文本核对全部命中）**

- `packages/coding-agent/test/tools/yield.test.ts:669`、`:685`、`:689`
- `packages/coding-agent/test/task/executor-subagent-reminders.test.ts:349`、`:383-384`、`:436`；源码文案 `packages/coding-agent/src/task/executor.ts:1664`
- `packages/coding-agent/test/task/executor-async-quiescence.test.ts:301`
- `packages/coding-agent/test/turn-persistence.test.ts:3-7`（文件头写明替代 O(n²) + `JSON.stringify` 比较，issue #3629）、`:55`、`:119`
- `packages/tui/test/loop-watchdog.test.ts:236`、`:264`

**发布门 owner**

- `.github/workflows/`：`ci.yml`、`nix.yml`、`bazel-cache-warm.yml`，`benchmark`/`latency` 零命中
- `package.json:97-133`（test/ci 家族）、`:165`（`release` → `scripts/release.ts`）
- `scripts/release.ts`：无 `ci:test` / `bun test` 调用
- `scripts/ci-test-ts.ts:236`：只收集 `.test.ts`

### 8.2 验证方式与边界

- 完整读取两份冻结输入的 raw bytes；用 `shasum -a 256` 独立复算两个文件哈希与聚合 `reviewed_revision`，三项与父预计算值交叉校验。
- 完整读取 Round 1 + Round 2 artifact，用于 closure 核对；不加入 manifest，不沿用其 verdict。
- 对设计中每一处「现有符号 / 现有测试 / 现有 owner」声明逐条只读核验；本 artifact 引用的所有仓库路径与行号均来自本轮实际读取或检索结果。
- 新文件（`src/latency/active-wall.ts`、`test/task/product-latency-fixture.ts`、`test/task/read-summarize-merge.test.ts`）已确认**当前不存在**，在本 artifact 中一律标为「拟新增」。
- **未运行**任何测试、构建、formatter、benchmark、live fixture 或 `bun check`。
- **未修改**任何仓库文件、`~/.omp`、配置或外部状态；未派 subagent；未访问 GitHub 或网络。
- 本 artifact 仅在回复中返回，由父协调者机械持久化并替换 `7fe4f367-f3ac-4a2f-bc59-5603c6cc9b8c`。

### 8.3 Verdict 依据

- 三个 HIGH 均要求修改正文语义或验收合同（调用方事实、required case 集合与门的构成、发布门 owner），不属于「不影响合同的 notes」，故排除 PASS 与 PASS_WITH_NOTES。
- 三个 HIGH 与四个 MEDIUM 均可在方案 A 边界内、不新增引擎/框架/flag 的前提下修复，架构与 owner 选择本轮无异议，故排除 NEEDS_REDESIGN。
- 结论：**NEEDS_REVISION**。

## 9. Gate Continuity Notes

- **continuity_state**: initial
- **initial_state**: none
- **covered_reviewed_revision**: `f4f3e004a245b5fd5c0c3d8238b1f3031626b7ba21745232eceec6464c64dc36`
- **covered_manifest**:
  - `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` → `833bda5dd65980f9c1ff7ed15adcf0c6ecdc40c1ce8fcd37f43bc25ac79c217e`
  - `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md` → `bd6693c1d899cfd61df04fd83a54f76d42f4ecaf50aadaa3c1c65059de6b3e45`
- **reviewed_input_drift_detected**: none
- **round_1_2_continuity**: Round 1/2 仅为历史 closure 输入，不构成本轮 verdict continuity
- **role_separation**: 满足。本 reviewer（Claude Opus 5）未参与正文任何修订；Round 1/2 reviewer 已成为 revision author 2，本轮已按 handoff 规则替换为异模型 reviewer
- **allowed_parent_mutation**: 将本完整 Round 3 artifact 原样追加到既有 artifact，并把 `7fe4f367-f3ac-4a2f-bc59-5603c6cc9b8c` 机械替换为宿主实际 agent id；不得修改正文、findings、verdict 或 Reviewed Inputs
- **invalidating_changes**: 对本轮 design/facts raw bytes 的任何后续修改都会使本 Gate 失效
- **next_gate_requirement**: revision author 修订设计后，必须重新冻结完整输入、复算 manifest 与 `reviewed_revision`，并执行新的独立 Gate；下一轮 reviewer 不得是 Grok 4.6、GPT-5.6-sol 或 Claude Opus 5 中任何已参与正文者的同模型实例——本 reviewer 未参与正文，若正文本轮后仍由他人修订，Claude Opus 5 仍可担任下一轮 reviewer

## 10. 下一步

1. 回到设计文档，由 revision author 修订，**不进入实现**。
2. 必须解决三个 HIGH：
   - **HIGH-1**：更正 workflow/eval caller 事实，明确 class ceiling 是否适用于 eval 并承认其后果，修正 §6.1 的 eval 测试 owner。
   - **HIGH-2**：把 required case 改为真正覆盖 review findings 的 `code_review` 案，删除或改写「known-defect、verdict 门」的不实表述。
   - **HIGH-3**：为 42 次 live 执行的发布门指定真实 owner、成本上限与跳过/kill 规则，或下调「发布门禁」措辞。
3. 同步处理四个 MEDIUM（`firstPassed` 限域、`read-summarize` 定性与风险、验证清单补 quiescence 测试、fixture 祖先目录与 `COPILOT_HOME` 隔离）。
4. LOW 可一并处理，均为表述与 owner 摆放问题。
5. 修订后重新冻结输入、复算 manifest/`reviewed_revision`，执行新的独立 Design Review Gate。
6. 当前授权为 **design-only**：不得改代码、测试、配置、`~/.omp`，不得构建或发布。

## 11. Design-only Handoff

```text
你是本设计的 revision author。当前授权仍为 design-only：不得修改代码、测试、配置、~/.omp，不得构建、运行 benchmark 或发布。只修订设计文档。

请完整读取：
1. docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md
2. docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md
3. docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md 中完整 Round 3 artifact

保留以下已通过评审的部分，不要重做：方案 A、单一 class owner（fresh discovery 后的 resolveEffectiveSubagentPolicy）、performance class matrix、75% advisory 与 wrapUpNoticeSent race contract、yield 协议不变、n=5 smoke / n=20 release 的样本口径、active-wall pure helper 与 central percentile 复用、#8462/#5372 不新增弱测试的诚实处置、无第二引擎/无 role framework/无新 settings key。

必须解决三个 HIGH：
- HIGH-1：eval/agent-bridge.ts:156-158 显示 eval 故意省略 maxRuntimeMs，structured-output-repair.ts 的 remainingTimeMs 不流向 subagent runtime。删除「eval 显式 remaining cap」的事实声明；明确 class ceiling 对 invocationKind="eval" 是否生效并承认其后果（eval 的 reviewer 类首次被压到 30 min、scout 类到 10 min）；把 §6.1 的 eval 测试 owner 改为 test/eval/agent-bridge*.test.ts，删除无法诚实实现的 schema-retry remaining cap 行。
- HIGH-2：schema-repair-boundary 是 schema_heavy 的 JSON fence 修复案，无 verdict 判据；suite 真正的 code_review 案是 review-security-paths / review-error-handling / review-state-transition（fixtures.ts:491,504,611），其 known-defect 判据才能防住「wrap-up 导致 findings 变少」。请改用它们（可保留 permission-readonly-review）。同时删除或改写「保留 known-defect、verdict 门」——evaluateBenchmarkQualityGate 中不存在这两项独立检查，verdict 在整个 benchmark 目录不存在。
- HIGH-3：仓库中没有任何 CI/script/release owner 能承接 42 次 live 执行（.github/workflows 无 benchmark/latency 引用，scripts/release.ts 不跑测试，package.json 无对应 script）。请指定真实 owner 与阻断范围、写明成本上限与凭据合同、补一个跳过/kill 规则（跳过时不得宣称达标），或相应下调 §1.2「发布门禁」的措辞。

同步处理四个 MEDIUM：
- 把 required IDs 的 firstPassed fail-close 限定在 scorecard.liveQualityUnknown === false，并说明为何此时 missing 与 false 同为 fail-close（该字段既有合同是 null = 未观测）。
- 改述 read-summarize: false → true：它移除了 scout 现有的 child read.summarize.enabled=false 强制写入（executor.ts:2922 与 persisted-revive.ts:89 两处），是真实行为变更；要么计入 explore 杠杆并在 §5.5 补「scout 失去全保真读取可能漏证据」风险，要么不改该 frontmatter。
- 在 §6.4 实现验证清单中加入 test/task/executor-async-quiescence.test.ts（新 advisory steer 会写入子会话消息队列，影响 idle barrier）。
- fixture 隔离补两点：要求 tempCwd 位于 tempHome 之下（project 发现向上遍历至 os.homedir() 才停），并删除继承的 COPILOT_HOME。

LOW 一并处理：wrapUpNoticeSent 标为新增（现有 latch 是 budgetSteerSent）；说明 75% 改 advisory 后该时点原有的 checkpoint 会消失且无已知消费者；XDG_CONFIG_HOME 不是 dirs.ts 合同；新 latency 模块需接入 src/latency/index.ts 星号 barrel 且 percentile 要求已排序输入；read-summarize 合并测试放进既有的 create-subagent-settings.test.ts / persisted-revive.test.ts 而非新建文件。

只修订设计，不实现。修订后停止，重新冻结完整输入、复算 manifest 与 reviewed_revision，并请求新的独立 Design Review Gate。即使后续获得 PASS/PASS_WITH_NOTES，在没有新的显式 implementation authorization 前仍必须停止。
```

---

# Subagent Re-Review: Subagent 延迟优化设计（Round 4）

## Gate 元数据

| 项 | 值 |
|---|---|
| review_round | 4 |
| review_mode | host-native |
| reviewer_native_agent_id | `7fe4f367-f3ac-4a2f-bc59-5603c6cc9b8c` |
| reviewer_model | Claude Opus 5 / claude-opus-5-thinking-high |
| review_fallback | none |
| content_author_models | Grok 4.6, GPT-5.6-sol |
| reviewer_participated_in_content | 否（本 reviewer 未参与正文任何修订） |
| author_self_review | 否 |
| implementation_authorization | design-only |
| authorization_source | 用户要求根据历史会话、社区与推特反馈分析根因并设计完整优化方案；未授权改代码、改 ~/.omp 配置或发布（沿用正文原文） |
| reviewer_mutations | 无（未修改、未实现、未改配置、未运行测试、未派 subagent） |

## Reviewed Inputs（manifest 与 revision 交叉校验）

从两份文件 raw bytes 独立 `shasum -a 256` 复算，repo-relative POSIX 路径升序，按 `<path>\t<lowercase sha>\n` 聚合后再取 SHA-256：

```text
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md	53e7c8f57726f4a427ebb1ad87260fb71eaf49e1d7922e37837de235720194a9
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md	bd6693c1d899cfd61df04fd83a54f76d42f4ecaf50aadaa3c1c65059de6b3e45
```

`reviewed_revision = 3f0c5761ac3549f3db0fd00fa93ab8bb823261dee4bb1598490e91f31d5f1d5c`

| 校验项 | 结果 |
|---|---|
| design.md SHA-256 | **MATCH** 父预计算 |
| facts-brief.md SHA-256 | **MATCH** 父预计算 |
| 聚合 `reviewed_revision` | **MATCH** 父预计算 |

closure-only 输入（不入 manifest）：`docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md` 内 Round 3 完整 artifact（L1129–L1830）。

## Round 3 Closure Matrix（3 HIGH / 4 MEDIUM / 5 LOW）

| R3 ID | 主题 | 状态 | 当前证据 |
|---|---|---|---|
| HIGH-1 | eval「显式 remaining cap」不存在 + class ceiling 静默改 eval 合同 | **部分关闭** | eval 部分已修正：§5.2 L190「eval `agent-bridge.ts` 故意省略并继承 fresh setting，schema repair 的 `remainingTimeMs` 不流向 subagent runtime」与 `eval/agent-bridge.ts:147` 一致；§6.1 owner 改为真实存在的 `test/eval/agent-bridge.test.ts` / `agent-bridge-policy.test.ts`；schema-retry 测试行改为负向断言。**但替代判别式对 workflow 不成立**（见 R4-HIGH-1） |
| HIGH-2 | required cases 选错 + known-defect/verdict 门虚构 | **关闭** | §1.2 L52 / §5.3 L289 / §6.2 L388–395 固定为 `permission-readonly-review` + `review-security-paths` + `review-error-handling` + `review-state-transition`，四个 ID 与 `benchmark/fixtures.ts:492/504/611/649` 及其 successCriteria 逐条吻合；正文明写「benchmark 没有独立 `verdict` 字段或 verdict 门」「known defect 仅经 successCriteria→`passed`→`minPassRate:100` 间接 fail-close」 |
| HIGH-3 | 42 次 live 调用无 owner / 无成本上限 / 无 kill switch | **关闭** | §1.2 L49 降级为「人工触发的 release latency qualification，不是普通 CI 或 `bun run release` 的自动门」；§6.3 L401–409 给出拟新增 `test:latency:smoke` / `test:latency:release`（`package.json` 现无同名脚本，无冲突）、release maintainer owner、12/42 硬上限与并发=1、`UNVERIFIED` skip 合同、凭据不落 secret；§5.4 L333 与 §7 L453 同步 |
| MEDIUM-1 | `firstPassed` fail-close 未限域、与 null 语义冲突 | **关闭** | §5.3 L289 与 §6.2 L394 限定「仅当 `scorecard.liveQualityUnknown === false`」；与 `runner.ts:466`（默认 `true`）及既有绝对检查同一 guard 一致；§6.2 L396 要求 p012 同时覆盖 live fail-close 与 fake/history 不受影响 |
| MEDIUM-2 | `read-summarize` 被写成惰性声明、质量风险未评估 | **关闭** | §1.4 L79 与 §5.3 L308–314 改述为「取消现有强制写入 `read.summarize.enabled=false`，回落 schema 默认 true」，并列为真实 explore 杠杆、幅度标 `[未知]`；§5.5 L340–341 新增「可能漏掉全保真证据」风险；测试归既有 `create-subagent-settings.test.ts` + `persisted-revive.test.ts` |
| MEDIUM-3 | 验证清单漏 `executor-async-quiescence.test.ts` | **关闭** | §6.1 L369 owner 行与 §6.4 L434 运行清单均已列入；测试名 `does not wait on a second idle barrier after a terminal yield` 与 `executor-async-quiescence.test.ts:301` 精确对应 |
| MEDIUM-4 | fixture 隔离漏祖先遍历与 `COPILOT_HOME` | **关闭** | §6.3 L410 固定 `tempCwd=tempHome/workspace` 并要求祖先无 project 配置（`discoverAgents` 上溯以 homedir 为界）；env 清单已删除 `PI_CODING_AGENT_DIR`、`COPILOT_HOME`、`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`，后两者在 `discovery/helpers.ts:116`、`discovery/github.ts:263` 均为真实读取项 |
| LOW-1 | `wrapUpNoticeSent` 被列为「现有名字」 | **关闭** | §5.3 L271 改为「现有符号按当前名字列出；拟新增或改名符号显式标注」；§5.2 L233 / §7 L447 明写「拟新增的 `wrapUpNoticeSent`……由现有 `budgetSteerSent` 扩职并改名」（`executor.ts:1176` 确为 `budgetSteerSent`） |
| LOW-2 | 75% checkpoint 移除被写成「保持不变」 | **关闭** | §5.2 L235 改述准确：`executor.ts:1251`（经 `requestBudgetStop`，含 75% 路径）与 `:1333`（hard timeout）是仅有两处 push；全仓 `src`/`test` 未见 `checkpoints` 读取方，「当前未发现消费者」成立 |
| LOW-3 | `XDG_CONFIG_HOME` 被误称 `dirs.ts` 合同 | **关闭** | §6.3 L410 改述为「不是 `pi-utils/dirs.ts` 的输入，只用于一并隔离 lspmux、github-cache」；`packages/utils/src/dirs.ts:286-288` 仅读 DATA/STATE/CACHE，与正文一致 |
| LOW-4 | `active-wall.ts` 未接 barrel、排序责任未写 | **关闭** | §5.3 L280 与 §7 L455 均写明加入 `src/latency/index.ts` 星号 barrel、fixture 负责升序排序后复用现有 `percentile(sorted, p)`；`src/latency/index.ts` 确为星号 barrel 且已含 `./rollout-cohort` |
| LOW-5 | 新建第三个 read-summarize 合并测试文件 | **关闭** | §5.3 L313 明写归既有两个 owner，「不新建第三个合并测试文件」 |

小结：12 项中 **11 项实质关闭**；HIGH-1 的 eval 侧已关闭，但其替代判别式在 workflow 上引入新的事实错误。

## 整体结论

**verdict: NEEDS_REVISION**

Round 4 相对 Round 3 是实质进步：质量绝对门、release qualification 的人工化与成本封顶、fixture 隔离、read-summarize 杠杆定性、latch/checkpoint/barrel 等全部按建议落地，且落地方式没有引入第二引擎、无消费者字段或新产品 flag；新脚本（`test:latency:*`、`product-latency-fixture.ts`）与新模块（`active-wall.ts`）均已标「拟新增」。方案 A 的架构判断本轮仍无异议。

阻断项集中在**运行时优先级这一节的判别式**：设计选择 `invocationKind === "task"` 作为 class wall-clock ceiling 的唯一开关，但该字段在源码中只有 `"task" | "eval"` 两个取值，workflow 适配器实际传 `"task"`。因此正文 6 处「workflow 属非 task invocation、不套 class ceiling」的陈述不成立，§6.1 为 workflow 指定的测试行无法被诚实实现——与 Round 3 HIGH-1 指出的失败模式同型。同时，cleanse 与 commit-agentic 两个 in-product `sonic` 调用方在设计与 facts brief 中完全缺席，实施后会被新的 explore 合同实际收紧。两项都需要正文语义修改，故不能给 PASS_WITH_NOTES。不需要 NEEDS_REDESIGN：方案骨架、owner 复用与质量门均成立，修订量限于 §5.2/§5.3/§5.4/§5.5/§6.1/§7 的若干句与一份调用方清单。

## 根因评审

- 分层结论（产品默认 / 用户 overrides / 社区 hang / parked 口径）与 facts brief 一致，SUPPORTED 与 WEAK_EVIDENCE 的区分本轮未被稀释；§3.2 仍明确「不能量化各因素对 p50 的贡献」，§1.2 的 treatment/目标分离与 §5.5 的「10/40/75% 可能首次打不出分位数」保持同向，无「已达标」暗示。
- 根因→方案链路继续一致：hard cap 预解析过早 → 单一权威时点在 `resolveEffectiveSubagentPolicy`；75% 现为 `budget_stop` → advisory 化并冻结 completion 表（与 `executor.ts:995-1001` 的 timeout > hard_abort > budget_stop 优先级吻合）；scout 合同冲突 → frontmatter + 系统提示分支；名单绑死四个字符串 → class 化并合并重复名单。
- 唯一根因层残留：§3.4 的「hard cap / class 必须在 fresh reload + discovery 之后算一次」是正确判断，但由此推出的 invocation 分流条件被写错（见 HIGH-1）。这是执行层错误，不是根因判断错误。
- `[未知]` 项（Cursor 实测、二进制是否含 8/26 cap、10/40/75% 边际贡献、`CpampFeatures` 归因）保持未升格为事实，符合证据分层要求。

## 设计评审要点

- **class matrix**：9 行表与 `resolveSubagentPerformanceClass` 五步优先级自洽；explore 名优先、`spawn "off"` 只关 shadow cohort 不降级、不调用 `isShadowReviewQualified`——与 §5.4、§6.5 抽样项一致，未把 `shadowReview` 升格为 role framework。
- **完成语义**：§5.2 冻结表与 `resolveSubagentCompletionKind`（`executor.ts:995-1001`）逐行对得上，包括「hard cap 优先于仍为 true 的 `budgetStopRequested`」。latch 共用与终态复查合同明确；`sendUserMessage` rejection 只记日志、不清 latch、不重试，边界闭合。
- **质量门**：四个 required ID 与 fixture successCriteria 精确对应；`liveQualityUnknown` 限域、live null/undefined/false fail-close、known defect 间接约束、无 verdict 虚构——本轮无异议。
- **fixture**：`strictModelIdentity`（`structured-subagent.ts:122`）、`Settings.isolated()`（`settings.ts:514`）、`PI_CONFIG_DIR`/`OMP_PROFILE`/`PI_PROFILE`（`dirs.ts:4,38,90`）、bundled identity 断言（`reviewer.md` 实为 `thinking-level: medium` / `max-effort: xhigh` / `shadow-review: code`；`scout.md` 现为 `max`/`max`/`false`）全部与正文一致；12/42 上限算术自洽（2×6、2×21）。
- **hang 边界**：#4957/#3629 映射到真实测试名；#8462/#5372 诚实标注不足并禁止弱 smoke；实现触及其 owner 时先回订设计——与「不新增第二引擎」一致。

## Findings

### CRITICAL

无。

### HIGH

#### [R4-HIGH-1] `invocationKind` 的取值只有 `"task" | "eval"`，workflow 适配器实际传 `"task"`；正文 6 处「workflow 属非 task invocation」与 §6.1 的 workflow 测试行均不成立

**位置**

- design.md §5.2 步骤 6 第三条（L210）、步骤 7（L211）、§5.2 L268、§5.4 L324 与 L334、§5.5 L346、§6.1 表第三行（L367）与测试矩阵第二条（L381）、§7（L445）
- `packages/coding-agent/src/task/structured-subagent.ts:86` — `invocationKind: "task" | "eval";`
- `packages/coding-agent/src/workflow/runtime-adapter.ts:416-417` — `invocationKind: "task"`，同一对象 `:432` 传 `maxRuntimeMs: request.profile.maxRuntimeMs`
- `packages/coding-agent/src/workflow/runtime-default.ts:82` — `invocationKind: request.invocationKind`（透传，不产生第三种取值）
- `packages/coding-agent/src/eval/agent-bridge.ts:147` — `invocationKind: "eval"`（eval 侧正确）

**问题**

设计把 class wall-clock ceiling 的唯一开关定为 `request.invocationKind === "task"`（L189、L209、L282），同时在至少 6 处声明 workflow 是「非 task invocation」，因而「不套 10/30 min class ceiling」「显式 profile cap 保持」。源码事实相反：该字段是二值联合类型，没有 `"workflow"` 取值；workflow 的唯一 structured 入口 `runtime-adapter.ts:417` 显式传 `"task"`。按设计给出的字面规则，workflow 请求会落入 `min(profileCap, class ceiling)` 分支，而不是正文承诺的直通分支。

需要如实记录的边界：当前 `workflow/default-config.ts` 的全部 profile cap 为 180,000–600,000 ms，均 ≤ explore ceiling 600,000 与 review ceiling 1,800,000，因此 `min()` 今天**不产生数值差异**。问题不在今日行为，而在三处：

1. 机制陈述错误。读者与实现者会以为存在一个把 workflow 排除在外的判别条件，实际不存在。
2. §6.1 测试矩阵第二条要求「workflow：……非 task 不套 class ceiling」。该断言无法被诚实实现——要么断言一个假前提，要么临时发明第三种 `invocationKind`。这正是 Round 3 HIGH-1 判定为不可接受的「虚假 owner 测试」同型问题，本轮在修复中复现。
3. 「workflow 显式 profile cap 保持原值」的保证只是数值巧合。任何未来 profile 把 cap 设到 >600,000 且命中 explore/review class，就会被静默截断，而设计没有留下任何不变量或断言保护它。

**影响**

- 运行时优先级是本设计的承重结构，其判别式的事实错误会直接传导到实现与测试；§6.1 该行按字面写就是设计自己禁止的虚假合同。
- workflow 的墙钟保证退化为「碰巧成立」，缺少可回归的护栏。

**建议**（二选一，并统一更正上列全部位置）

1. 承认 workflow 与 TaskTool 共享 `invocationKind: "task"`，把规则改述为「class ceiling 对所有 `invocationKind === "task"` 的调用生效；workflow 因显式 profile cap（当前 180k–600k）恒 ≤ ceiling，故 `min()` 为无操作」，并在 §6.1 把 workflow 测试行改为可实现的断言：profile cap 被显式传入且 `effectiveMaxRuntimeMs === profileCap`，外加一条「profile cap > class ceiling 时的行为」显式决策（保持 profile cap 或允许截断，二选一并写明）。
2. 若确实要排除 workflow，则必须选择一个真实可判别的信号（例如以 `request.maxRuntimeMs !== undefined` 即 caller 显式提供 cap 作为直通条件），并同步更正 §5.2/§5.3/§5.4/§5.5/§6.1/§7；不得新增 `invocationKind` 取值以外的产品 flag。

---

#### [R4-HIGH-2] cleanse 与 commit-agentic 两个 in-product `sonic` 调用方全文缺席；实施后其墙钟与请求预算被实际收紧且无风险评估与测试归属

**位置**

- design.md §1.3（L58–59）、§5.2 步骤 7（L211）、§5.3 executor 条目（L283）、§5.4（L323）、§5.5 风险表（L336–354）、§6.1 全表 —— 调用方清单仅列 TaskTool / workflow / eval / schema-repair
- `packages/coding-agent/src/cleanse/agent.ts:165-175` — `runStructuredSubagent({ … invocationKind: "task", agent: "sonic", … })`，全 `src/cleanse/` 无 `maxRuntimeMs`
- `packages/coding-agent/src/commit/agentic/tools/analyze-file.ts:86-91` — `TaskParams { agent: "sonic" }` 经 `taskTool.execute` 派发
- `packages/coding-agent/src/task/executor.ts:121-126` — `SOFT_REQUEST_BUDGET.sonic = 100`（设计改为 40）
- 设计与 facts brief 全文检索 `cleanse` / `analyze-file` / `commit/agentic`：零命中

**问题**

`sonic` 是设计指定的 explore 名之一，而仓库中除 TaskTool 用户调用外，还有两个产品内部调用方在派发它：

- cleanse worker（`cleanse/agent.ts:169`）走 `runStructuredSubagent`，`invocationKind: "task"` 且**不传** `maxRuntimeMs`。按设计公式，base 取 fresh `task.maxRuntimeMs`（默认 1h），再与 explore ceiling 取 min → **10 min 硬超时**，同时 soft request budget 由 100 降到 40，并改吃 explore 系统提示分支（「回答完 assignment 立刻 terminal-yield」）。
- commit-agentic 的 `AnalyzeFile*`（`analyze-file.ts:88`）经 TaskTool 派发，同样落入 explore class。

设计的调用方清单、§6.1 测试矩阵与 §5.5 风险表都没有提到这两条路径，也没有为其分配 owner。cleanse worker 承担的是按文件组的仓库级清理分析，10 min + 40 req + 「立即压缩收尾」的提示是方向明确的收紧，属于对已发布功能的行为变更，而非本设计声明的范围（§1.3 只写「给 explore（`scout`/`sonic`）更紧的已有预算/墙钟解析」，未说明这会波及哪些产品内部消费者）。

**影响**

- 与 Round 3 HIGH-1 相同的失败模式：公式的正当性建立在不完整的调用方清单上；实施后可能出现 cleanse worker 在 10 min 被 `requestAbort("timeout")` 截断的静默截断，而设计从未评估该风险。
- §6.1 无对应测试行，回归不会被本轮验证捕获；`test/cleanse/` 目录不存在，也没有指定替代 owner。
- 「不新增第二引擎、复用既有 owner」的约束下，波及既有 owner 的行为变更必须在正文显式决策，否则实现者无从判断这是有意还是遗漏。

**建议**

1. 在 §5.2 步骤 7 或 §5.3 补齐 structured subagent 调用方全量清单：TaskTool（含 commit-agentic 经 TaskTool 的 `AnalyzeFile*`）、workflow adapter、eval bridge、cleanse agent；标注各自是否传 `maxRuntimeMs` 与所落 class。
2. 对 cleanse `sonic` worker 做显式决策并写入正文，二选一：(a) 接受 10 min/40 req 收紧，在 §5.5 增加对应风险与缓解（例如 cleanse 输出本就是分片压缩结果）；(b) 判定不适用，并说明用什么真实信号排除（不得新增 settings key 或 frontmatter 字段）。
3. 若选 (a)，在 §6.1 增加一行 owner，断言 cleanse 派发的 `sonic` 的 `effectiveMaxRuntimeMs` 与 soft budget 符合预期；若无既有 cleanse 测试文件，指定由 `structured-subagent.test.ts` 以真实调用方参数覆盖，不新建冗余文件。

### MEDIUM

无。

### LOW

#### [R4-LOW-1] `resolveSoftRequestBudget` 的改造形态留了两可写法，seam 未定

**位置**：design.md §5.3 executor 条目（L283）；`packages/coding-agent/src/task/executor.ts:121-126`

**问题**：正文写「`resolveSoftRequestBudget` 改为转调 `resolveClassSoftRequestBudget`（若仍保留 name 签名，内部必须先拿到 class——执行路径以 `options.performanceClass` 为准）」。括号里的分支把「保留按名签名」与「改为按 class」两种形态都留给实现者，而 §5.3 同时要求「停止把 explore 塞进 reviewer 命名 helper」。二者在意图上一致，但落地形态不唯一。

**影响**：极小，属实现自由度。但与本设计其余部分「冻结 seam」的写法不一致，可能导致名签名 helper 与 class helper 长期并存。

**建议**：明确二选一，例如「`resolveSoftRequestBudget` 只保留 `(performanceClass, configuredBudget)` 签名，按名解析仅存于 class 函数内部」。

---

#### [R4-LOW-2] §6.2 未指明谁负责把 `liveQualityUnknown` 置为 `false`，而新增的每-run first-pass 检查完全依赖该值

**位置**：design.md §6.2（L393–394）；`packages/coding-agent/src/workflow/benchmark/runner.ts:466`（默认 `?? true`）；`packages/coding-agent/src/cli/workflow-bench-cli.ts:140`（`const liveQualityUnknown = mode !== "live"`）

**问题**：设计正确地把新检查限域到 `liveQualityUnknown === false`，但 §6.2 的 producer 链只写到 `runtime-default.ts → structured runner → BenchmarkRunResult`，未指出该布尔值的实际来源是 `workflow-bench-cli.ts:140` 的 `mode === "live"`；而 `buildScorecard` 的默认值是 `true`（不施加检查）。

**影响**：极小且当前无缺陷。但「质量绝对合同」的生效前提落在一个默认关闭、由单一 CLI 入口决定的开关上，正文未记录该依赖；若将来以其他入口跑 live 套件而未传 `liveQualityUnknown: false`，required-case 防线会静默失效且无人察觉。

**建议**：在 §6.2 补一句 producer 链的入口事实（live 由 `workflow-bench-cli.ts` 的 `mode === "live"` 置 `liveQualityUnknown=false`，默认 `true` 即不施加），并要求 p012 的新增用例保留「默认不施加」的显式分支断言。

## Gate Evidence（关键锚点与未运行边界）

**已复核的关键锚点**

- 哈希：`shasum -a 256` 独立复算两文件与聚合 revision，三项与父预计算交叉校验一致。
- 调用方与判别式：`structured-subagent.ts:86`、`workflow/runtime-adapter.ts:416-417,432`、`workflow/runtime-default.ts:82`、`eval/agent-bridge.ts:147`、`task/index.ts:790,1608`、`cleanse/agent.ts:133,167-169`、`commit/agentic/tools/analyze-file.ts:86-91`、`workflow/default-config.ts`（cap 180k–600k）。
- 完成/预算/latch/checkpoint：`executor.ts:995-1001`（kind 优先级）、`:121-126`（SOFT_REQUEST_BUDGET）、`:1176,1767-1768`（`budgetSteerSent`）、`:1248-1255`（`requestBudgetStop` + checkpoint push）、`:1311-1322`（75% timer 现调 `requestBudgetStop("runtime_timeout")`）、`:1333-1337`（hard timeout checkpoint）；`review-performance.ts:50,56,104`；全仓无 `checkpoints` 读取方。
- 质量门：`benchmark/runner.ts:37-38,320,459-479`（`firstPassed` 与 `liveQualityUnknown` 语义）、`fixtures.ts:492,504,611,649`（四个 required ID 及 successCriteria）、`cli/workflow-bench-cli.ts:140`。
- fixture 隔离与 identity：`utils/src/dirs.ts:4,38,78-90,286-288,389`、`discovery/helpers.ts:116`、`discovery/github.ts:263`、`config/settings.ts:514`、`structured-subagent.ts:122`、`prompts/agents/reviewer.md`、`prompts/agents/scout.md` frontmatter。
- 测试 owner 存在性：`test/workflow/runtime-adapter.test.ts`、`test/eval/agent-bridge.test.ts`、`test/eval/agent-bridge-policy.test.ts`、`test/task/executor-async-quiescence.test.ts:301`、`test/task/create-subagent-settings.test.ts`、`test/task/persisted-revive.test.ts` 均存在；`package.json` 无 `test:latency:*` 同名冲突；`test/cleanse/` 不存在。
- barrel：`src/latency/index.ts` 为星号 barrel 且已含 `./rollout-cohort`。

**未运行边界（本轮不构成证据）**

- 未运行任何测试、构建、typecheck、benchmark 或 fixture；文中所有测试名/文件均为静态存在性与内容核对，非绿测证据。
- 未修改任何文件、未改配置、未派 subagent、未触网检索。
- 未验证用户当前安装二进制是否包含 8/26 cap（正文已标 `[未知]`，本轮维持）。
- 未评估 workflow profile cap 未来可能超过 class ceiling 的具体场景（HIGH-1 已作为设计缺口提出，不是实测结论）。

## Gate Continuity（initial）

- **covered_reviewed_revision**: `3f0c5761ac3549f3db0fd00fa93ab8bb823261dee4bb1598490e91f31d5f1d5c`
- **covered_manifest**:
  - `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` → `53e7c8f57726f4a427ebb1ad87260fb71eaf49e1d7922e37837de235720194a9`
  - `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md` → `bd6693c1d899cfd61df04fd83a54f76d42f4ecaf50aadaa3c1c65059de6b3e45`
- **review_mode**: host-native；**reviewer_model**: Claude Opus 5 / claude-opus-5-thinking-high；**review_fallback**: none
- **verdict**: NEEDS_REVISION（2 HIGH / 0 MEDIUM / 2 LOW；HIGH 均需正文语义变更）
- **allowed_parent_mutation**: 仅允许将本 Round 4 artifact 原样追加到既有 review artifact 路径，并把 `7fe4f367-f3ac-4a2f-bc59-5603c6cc9b8c` 机械替换为宿主实际 agent id；不得修改本文正文、findings、verdict 或 Reviewed Inputs
- **next_gate_requirement**: revision author 修订后须重新冻结完整输入、复算 manifest 与 `reviewed_revision`，执行新的独立 Gate。Grok 4.6 与 GPT-5.6-sol 仍为正文作者，不得自审；本 reviewer 未参与正文，若后续修订仍由他人完成，Claude Opus 5 可继续担任下一轮 reviewer
- **continuity_note_rule**: 仅当后续输入变化为非实质（不改语义的排版/错别字）时，方可由未参与 author/reviewer/正文修改/implementation 的协调者持久化覆盖完整 manifest 的 Continuity Note；实质、不确定、遗漏输入或角色未分离时必须重跑 Gate

## 下一步

1. 按 R4-HIGH-1 选定并统一 class ceiling 的判别式，同步更正 §5.2 L210/L211/L268、§5.4 L324/L334、§5.5 L346、§6.1 L367/L381、§7 L445，并把 §6.1 的 workflow 测试行改为可诚实实现的断言。
2. 按 R4-HIGH-2 补齐 structured subagent 调用方全量清单，对 cleanse `sonic` worker（及经 TaskTool 的 commit-agentic `AnalyzeFile*`）作显式接受或排除决策，并补风险条目与测试 owner。
3. 可选处理 R4-LOW-1 / R4-LOW-2（seam 唯一化、live 开关来源写入 §6.2）。
4. 修订后重新冻结完整输入、复算 manifest 与 `reviewed_revision`，执行新的独立 Design Review Gate。
5. 无论新一轮 verdict 如何，`implementation_authorization=design-only` 依旧有效，Gate 结束后停止。

## Design-only Handoff

**给下一位 revision author 的中文短 prompt**

> 你是本设计的修订作者，不是 reviewer。请只修订以下设计正文，不实现、不改代码/配置/`.omp`、不发布、不派 subagent：
> `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md`
>
> 需处理 Round 4 的两个 HIGH（可选处理两个 LOW），完整 finding 与证据见 `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md` 的 Round 4 artifact：
> 1. **HIGH-1**：`StructuredSubagentRequest.invocationKind` 只有 `"task" | "eval"`，`workflow/runtime-adapter.ts:417` 传的就是 `"task"`。请选定真实可判别的 class ceiling 开关（承认 workflow 同为 task 并说明 `min()` 当前为无操作 + 补 profile cap > ceiling 的显式决策；或改用「caller 是否显式提供 `maxRuntimeMs`」这类真实信号），并统一更正 §5.2、§5.4、§5.5、§6.1、§7 中全部「workflow 属非 task invocation」的表述与 §6.1 workflow 测试行。
> 2. **HIGH-2**：补齐 structured subagent 调用方全量清单（含 `cleanse/agent.ts:167-169` 的 `sonic` worker 与经 TaskTool 的 `commit/agentic/tools/analyze-file.ts:88`），对它们被 explore class 收紧到 10 min/40 req 作显式接受或排除决策，并补 §5.5 风险条与 §6.1 测试 owner。
>
> 约束：不得新增第二引擎、无消费者字段或新产品 flag/settings key；新脚本与 fixture 继续标「拟新增」；所有事实陈述须与当前源码 file:line 一致。修订后停止，重新冻结完整输入、复算 manifest 与 `reviewed_revision`，并请求新的独立 Design Review Gate（Grok 4.6 与 GPT-5.6-sol 不得自审）。即使后续获得 PASS/PASS_WITH_NOTES，在没有新的显式 implementation authorization 前仍必须停止。

**需一并交给下一环节的输入**

1. `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md`
2. `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md`
3. `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md` 中的完整 Round 4 artifact

---

# Subagent Re-Review: Subagent 延迟优化设计（Round 5）

## Gate 元数据

| 项 | 值 |
|---|---|
| review_round | 5 |
| review_mode | host-native |
| reviewer_native_agent_id | `7fe4f367-f3ac-4a2f-bc59-5603c6cc9b8c` |
| reviewer_model | Claude Opus 5 / claude-opus-5-thinking-high |
| review_fallback | none |
| content_author_models | Grok 4.6, GPT-5.6-sol |
| reviewer_participated_in_content | 否（本 reviewer 未参与正文任何修订） |
| author_self_review | 否 |
| implementation_authorization | design-only |
| authorization_source | 用户要求根据历史会话、社区与推特反馈分析根因并设计完整优化方案；未授权改代码、改 ~/.omp 配置或发布（沿用正文原文） |
| reviewer_mutations | 无（未修改文件、未实现、未改配置、未运行测试、未发布、未派 subagent） |

## Reviewed Inputs（manifest 与 revision 交叉校验）

从两份文件 raw bytes 独立 `shasum -a 256` 复算，repo-relative POSIX 路径升序，按 `<path>\t<lowercase sha>\n` 聚合后再取 SHA-256：

```text
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md	30a71be39cbe6cf63f44fda766d014c34d781bc652b3d1dea28adbc578d8dc19
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md	bd6693c1d899cfd61df04fd83a54f76d42f4ecaf50aadaa3c1c65059de6b3e45
```

`reviewed_revision = a28f72762dec7b73d61c6183bb46820ae27d6f09cf5e57759e6ff3308e6e8916`

| 校验项 | 结果 |
|---|---|
| design.md SHA-256 | **MATCH** 父预计算 |
| facts-brief.md SHA-256 | **MATCH** 父预计算（与 Round 3/4 一致，facts 未变） |
| 聚合 `reviewed_revision` | **MATCH** 父预计算 |

closure-only 输入（不入 manifest）：`docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md` 内 Round 4 完整 artifact。

## Round 4 Closure Matrix

| R4 ID | 主题 | 状态 | 当前证据 |
|---|---|---|---|
| HIGH-1 | `invocationKind` 无法区分 workflow，6 处「workflow 属非 task invocation」为假，§6.1 workflow 测试行不可实现 | **关闭** | 判别式改为真实信号：§5.2 步骤 5 用 `request.maxRuntimeMs !== undefined`（`structured-subagent.ts:118` 为 `maxRuntimeMs?: number`，`undefined` 是自然的省略态）与 `invocationKind === "eval"`（`:86` 二值联合，分支穷尽）。§5.2 步骤 7 表格明确写出「workflow adapter / `invocationKind:"task"` / explicit profile cap」，与 `workflow/runtime-adapter.ts:417,432` 一致。类型上 `workflow/types.ts:669` 的 `maxRuntimeMs: number` 是**必填**，因此 workflow 恒落权威直通分支，不是数值巧合。§6.1 workflow 行改为可实现断言（含「高于 ceiling 的非 0 仍原样」）。§5.4、§5.5、§6.5、§7 同步；全文已无「非 task invocation」残留 |
| HIGH-2 | cleanse / commit-agentic 两个 `sonic` 调用方缺席，行为变更未评估、无测试归属 | **关闭** | §5.2 步骤 7 的五行调用面表与仓库真实入口逐条吻合：`runStructuredSubagent` 的全部调用方为 `eval/agent-bridge.ts:145`、`cleanse/agent.ts:131`（`agent:"task"`→worker）、`cleanse/agent.ts:165`（`agent:"sonic"`）、`task/index.ts:1606`、`workflow/runtime-default.ts:80`；TaskTool 内部调用方仅 `commit/agentic/tools/analyze-file.ts:91`。§1.3 新增「明确接受」条；§5.5 新增风险条并要求暴露 `CleanseAgentOutcome.success=false`/`error`（`cleanse/types.ts:76-82` 确有该形状）；§6.1 新增两行 owner，所引 `test/cleanse.test.ts`、`test/commit-agentic-attribution.test.ts`、`executor-soft-budget.test.ts`、`structured-subagent.test.ts` 均存在，且显式声明「不虚构其已证明 timeout/error 传播」并禁止源码字面扫描式测试 |
| LOW-1 | soft budget seam 形态两可 | **关闭** | §5.3 冻结为唯一 `resolveSoftRequestBudget(performanceClass, configuredBudget)`，删除按名签名与 `resolveReviewerSoftRequestBudget`；§7 复述「不保留按名 budget helper 或无消费者的双 helper」。现状 `executor.ts:134-140` 的名签名与 `review-performance.ts:64` 的 reviewer helper 是被删对象，唯一调用点 `executor.ts:2945` 明确 |
| LOW-2 | `liveQualityUnknown` 的 live owner 未写 | **关闭** | §6.2 producer 条与 §7 均写明 `workflow-bench-cli.ts` 以 `mode === "live"` 置 `false`、`buildScorecard` 未显式传值时默认 `true` 不施加检查；与 `cli/workflow-bench-cli.ts:140`（`mode !== "live"`）、`runner.ts:466`（`?? true`）一致。§6.2 测试条另要求显式覆盖默认 unknown 分支 |

**Round 3 closure 无回归**：四个 required live case ID 与 `liveQualityUnknown` 限域（§1.2/§5.3/§6.2）、人工 release qualification 与 12/42 上限及 `UNVERIFIED`（§1.2/§6.3/§7）、`read-summarize` 真实杠杆定性与既有测试 owner（§1.4/§5.3/§5.5）、`executor-async-quiescence.test.ts`（§6.1/§6.4）、`tempCwd=tempHome/workspace` 与删除 `COPILOT_HOME`/`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`、`XDG_CONFIG_HOME` 非 `dirs.ts` 输入（§6.3）、`wrapUpNoticeSent` 标「拟新增」（§5.2/§5.3/§7）、75% checkpoint 移除措辞（§5.2）、latency barrel 与排序责任（§5.3/§7）——逐条复核仍在位且表述未退化。

## 整体结论

**verdict: PASS_WITH_NOTES**

本轮两个 HIGH 的修复方式是正确的类型级修复，而不是措辞打补丁：设计放弃了不具判别力的 `invocationKind==="task"` 单一条件，改用「caller 是否显式给出 cap」这一在类型上真实可判别的信号，并且由于 `WorkflowModelProfile.maxRuntimeMs` 是必填 number，workflow 的直通不再依赖「所有 profile 恰好 ≤ ceiling」的巧合。调用面表经独立枚举确认**完整且无多余**——仓库中 `runStructuredSubagent` 与 TaskTool 的全部真实入口都在表内，且 cleanse discovery（`agent:"task"`→worker）与 cleanse worker（`agent:"sonic"`→explore）被正确区分。cleanse/commit 进入 explore treatment 被写成显式接受而非兼容例外，并配有失败暴露合同与真实测试 owner，同时明确禁止虚构覆盖与源码字面扫描，符合仓库测试规范。

soft budget 收敛为唯一 seam、`liveQualityUnknown` 的 CLI owner 记述准确。全局扫描未发现旧表述残留、未引入第二引擎/新 settings key/feature flag，新脚本（`test:latency:*`、`product-latency-fixture.ts`）、新模块（`active-wall.ts`）与新符号（`wrapUpNoticeSent`、`buildSoftRuntimeNotice`、class helpers）均标「拟新增」，根因 facts→判断→方案链路保持一致，`[未知]` 项未被升格。

余下两项均为不阻断的 LOW：一处是 class 化后 `SOFT_REQUEST_BUDGET` 中 scout/sonic 数值失去消费者而正文未交代去留；一处是「不存在的 retry runtime cap」这句措辞不精确，可能诱导写出错误的 workflow 重试断言。二者都不改变设计决策，可在实现前顺手澄清，故不构成 NEEDS_REVISION。授权状态不变：Gate 结束后仍按 `design-only` 停止。

## 根因评审

- 分层结论与证据分级未被本轮修订稀释：§3.2 仍分列 SUPPORTED 机制事实与 WEAK_EVIDENCE 影响幅度，明确「不能量化各因素对 p50 的贡献」；§1.2 的 treatment/目标分离、§5.5 的「首次可能打不出分位数」保持同向，全文无「必然达标」暗示。
- 新增的 cleanse/commit 接受条没有污染根因论证：它被放在 §1.3 范围与 §5.5 风险，而不是被当作新的根因证据；其效果幅度标 `[未知]`，与 `read-summarize`、10/40/75% 的处理方式一致。
- §3.4 的四条设计影响（叠加为主因、只加 cap 不够、75% 必须与 `budget_stop` 分离、class 必须在 fresh discovery 之后算一次）与 §5.2 的控制流一一对应；本轮把「一次计算」的输入从名字改为 class + 真实 request signal，方向与根因判断一致。
- `[未知]` 项（Cursor 实测、二进制是否含 8/26 cap、10/40/75% 边际贡献、`CpampFeatures` 归因、cleanse/commit 收紧幅度）全部保持未确认状态，未被当作已验证事实使用。

## 设计评审要点

- **runtime 公式**：§5.2 步骤 5 三分支在类型上穷尽且互斥（显式 cap → 权威；`eval` + omitted → fresh setting；`task` + omitted → 非 0 时与 class ceiling 取 min，0 保持无限）。与现状对比无回归：今天 `buildExecutorOptions`（`structured-subagent.ts:451`）本就直接复制 `request.maxRuntimeMs`，因此 workflow 的显式 cap 语义完全保持。用户侧无法绕过 ceiling——`task/types.ts` 的 `TaskParams` 不含 `maxRuntimeMs`，只有直接调用 `runStructuredSubagent` 的内部调用方能显式 override，与 §6.1 的表述一致。
- **preflight/run 对称**：`task/index.ts:57`（`REVIEW_GATE_AGENTS`）、`:64`（`resolveTaskMaxRuntimeMs`）及其两个调用点 `:801`（preflight）与 `:1628`（run）被设计准确定位并要求整体删除、两处均省略字段；§5.2 步骤 6 要求两次都重新执行 resolver 并读 fresh setting，符合 §3.4「预解析过早」的根因。
- **class matrix 与 shadow 分离**：九行表、五步优先级、`spawn "off"` 只关 cohort、不调用 `isShadowReviewQualified`——本轮未改动，仍自洽；spawn `"code"` 的调用契约已按新公式补齐「且 request cap omitted 才吃 30 min ceiling」。
- **完成语义**：§5.2 冻结表与 `executor.ts:995-1001` 的 `timeout` > `hard_abort` > `budget_stop` 优先级逐行吻合；latch 共用、终态复查、rejection 只记日志、checkpoint 去留均与 `:1248-1255`/`:1311-1322`/`:1333-1337` 对应。
- **质量门**：四个 required ID 与 `benchmark/fixtures.ts:492/504/611/649` 的 successCriteria 精确对应；限域、fail-close 方向、known-defect 间接约束、无 verdict 门——无异议。
- **fixture**：隔离手段、bundled identity 断言（`reviewer.md` 实为 `thinking-level: medium` / `max-effort: xhigh` / `shadow-review: code`；`scout.md` 现为 `max`/`max`/`false`，与拟改目标一致）、12/42 算术、nearest-rank 复用——无异议。

## Findings

### CRITICAL

无。

### HIGH

无。

### MEDIUM

无。

### LOW

#### [R5-LOW-1] class 化 soft budget 后，`SOFT_REQUEST_BUDGET` 中 `scout`/`sonic` 的 100 会失去消费者，正文未交代其去留

**位置**

- design.md §5.2 步骤 9（L223）、§5.3 executor 条目（L293）、§5.2 explore 名定义（L251）、§7（L465）
- `packages/coding-agent/src/task/executor.ts:121-126` — `SOFT_REQUEST_BUDGET = { scout: 100, sonic: 100, ...REVIEWER_SOFT_REQUEST_BUDGET, default: 200 }`
- `packages/coding-agent/src/task/executor.ts:134-140` — 现有名签名解析（含 `:140` 的 `SOFT_REQUEST_BUDGET[agentName]` 兜底）
- `packages/coding-agent/src/task/executor.ts:2943` — `SOFT_REQUEST_BUDGET.default` 仍被消费
- `packages/coding-agent/src/task/review-performance.ts:5,61` — `REVIEWER_SOFT_REQUEST_BUDGET` 同时承担 floor 名注册表

**问题**

设计把 `resolveSoftRequestBudget` 的签名冻结为 `(performanceClass, configuredBudget)`，explore cap=40 由拟新增的 `EXPLORE_SOFT_REQUEST_BUDGET` 提供。改造后 `SOFT_REQUEST_BUDGET` 记录里的 `scout: 100` / `sonic: 100` 不再参与任何解析路径（`:140` 的按名兜底一并删除），但该记录不能整体删除——`:2943` 仍消费 `default: 200`，且 §5.2 L251 明确把「现有 `SOFT_REQUEST_BUDGET` 键」当作 explore 名的来源。正文没有说明这两个数值是删除、保留为空位、还是改写为 40。

**影响**

极小，无行为风险。但设计在 §7 自陈「不保留……无消费者的双 helper」，而实现后同一概念会出现两个数字（`SOFT_REQUEST_BUDGET.scout/sonic = 100` 与 `EXPLORE_SOFT_REQUEST_BUDGET = 40`），其中一个无消费者；若实现者原样保留，后续读者会误以为 explore 预算仍是 100。

**建议**

在 §5.3 executor 条目补一句去留决策，例如「`SOFT_REQUEST_BUDGET` 仅保留 `default` 与作为 explore 名注册表的键；`scout`/`sonic` 的数值随按名解析一并删除，explore 数值唯一来源为 `EXPLORE_SOFT_REQUEST_BUDGET`」——或明确改为以名单常量而非预算记录承载 explore 名。

---

#### [R5-LOW-2] 「不新增或测试不存在的 retry runtime cap」措辞不准确：workflow schema 重试确实逐次收窄 profile cap 并作为显式 caller cap 下传

**位置**

- design.md §6.1 runtime precedence 矩阵末条（L397）、§5.1（L191）、§5.4（L331）、§7（L461）中「schema repair 的 `remainingTimeMs` 不流向 subagent runtime」
- `packages/coding-agent/src/workflow/runtime-adapter.ts:190-202` — 每个 schema 重试 attempt 以 `Math.max(1, profileMax - elapsedMs)` 重写 `profile.maxRuntimeMs` 生成 `attemptRequest`
- `packages/coding-agent/src/workflow/runtime-adapter.ts:432` — `maxRuntimeMs: request.profile.maxRuntimeMs` 进入 `StructuredRunnerRequest`
- `packages/coding-agent/src/workflow/structured-output-repair.ts:594` — `StructuredRepairBudget.maxRuntimeMs?/remainingTimeMs` 另走 repair 预算路径

**问题**

正文关于 `StructuredRepairBudget.remainingTimeMs` 的判断准确（该字段确实不流向 subagent runtime）。但同一句的后半「不新增或测试**不存在的** retry runtime cap」把一个真实存在的机制说成不存在：workflow adapter 在 schema 重试循环里按已耗时收窄 `profile.maxRuntimeMs`，该值经 `:432` 成为逐 attempt 不同的显式 caller cap。新公式对它的处理是正确的（显式 cap 权威直通，逐次调用各自 resolve），但正文没有点明这一点。

**影响**

极小，不改变行为。风险在测试设计：§6.1 workflow 行要求断言「profile cap 被显式传入」，若实现者据「不存在 retry runtime cap」理解为该值在重试间恒定，写出对静态 profile 常量的相等断言，重试路径下会失败；反之若未来有人为「稳定」而缓存跨 attempt 的 policy，也会悄悄破坏现有的剩余时间收窄语义。

**建议**

把该句拆成两断言：「(a) `StructuredRepairBudget.remainingTimeMs` 不流向 `StructuredSubagentRequest.maxRuntimeMs`；(b) workflow 的 schema 重试会按剩余时间逐 attempt 收窄 `profile.maxRuntimeMs`，它属于显式 caller cap，由权威直通规则原样保留——测试须按每次调用的实际传入值断言，不得假定重试间 cap 恒定，也不得新增独立 retry runtime cap。」

## Gate Evidence（关键锚点与未运行边界）

**关键锚点（本轮实际打开并核对）**

- 哈希：两文件 raw bytes 独立 `shasum -a 256` + 聚合复算，三项与父预计算交叉校验一致。
- 判别式与类型：`task/structured-subagent.ts:86`（`"task" | "eval"`）、`:118`（`maxRuntimeMs?: number`）、`:451`（现状直接复制）；`workflow/types.ts:669`（profile cap 必填 `number`）；`workflow/runtime-adapter.ts:417,432`、`:190-202`（重试收窄）；`workflow/runtime-default.ts:80,91`；`eval/agent-bridge.ts:145,147`；`task/types.ts`（`TaskParams` 无 `maxRuntimeMs`）。
- 调用面完整性：`runStructuredSubagent` 全部调用方（eval:145、cleanse:131/165、task/index:1606、workflow/runtime-default:80）与 TaskTool 内部调用方（`commit/agentic/tools/analyze-file.ts:91`）独立枚举，与 §5.2 表五行逐条对应；`cleanse/agent.ts` 全文无 `maxRuntimeMs`。
- TaskTool 现状：`task/index.ts:57,64,801,1628`（待删符号与两个调用点）。
- soft budget：`executor.ts:121-126,134-140,2943,2945`；`review-performance.ts:5,61,64`；现有测试 `executor-soft-budget.test.ts:489-501`、`review-performance.test.ts:11-14`（被设计明确要求迁移）。
- 失败暴露：`cleanse/types.ts:76-82`（`success`/`error`）；`executor.ts:995-1001`（completion kind 优先级）。
- 质量门：`cli/workflow-bench-cli.ts:140`、`benchmark/runner.ts:466`、`benchmark/fixtures.ts:492/504/611/649`。
- 测试 owner 存在性：`test/cleanse.test.ts`、`test/commit-agentic-attribution.test.ts`、`test/task/{task-spawn,structured-subagent,review-performance,executor-soft-budget,executor-wall-clock,executor-async-quiescence,create-subagent-settings,persisted-revive}.test.ts`、`test/workflow/runtime-adapter.test.ts`、`test/eval/agent-bridge{,-policy}.test.ts` 均存在；`package.json` 无 `test:latency:*` 同名冲突。
- 一致性扫描：全文无「非 task invocation」类旧表述残留；无 `resolveClassSoftRequestBudget` 等被删符号残留；「不新增 settings key / feature flag」在 §1.4、§5.2、§5.3、§5.4、§6.3 五处一致。

**未运行边界（不构成证据）**

- 未运行任何测试、构建、typecheck、benchmark 或 fixture；所有测试名/文件仅经静态存在性与内容核对，非绿测证据。
- 未修改文件、未改配置、未发布、未派 subagent、未触网。
- 未验证 cleanse/commit 在 10 min/40 req 下的真实完成率（正文已标 `[未知]`，本轮维持）；未验证用户安装二进制是否含 8/26 cap。
- 未对 `read-summarize`、10/40/75% 的延迟效果做任何实测推断。

## Gate Continuity（initial）

- **covered_reviewed_revision**: `a28f72762dec7b73d61c6183bb46820ae27d6f09cf5e57759e6ff3308e6e8916`
- **covered_manifest**:
  - `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` → `30a71be39cbe6cf63f44fda766d014c34d781bc652b3d1dea28adbc578d8dc19`
  - `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md` → `bd6693c1d899cfd61df04fd83a54f76d42f4ecaf50aadaa3c1c65059de6b3e45`
- **review_mode**: host-native；**reviewer_model**: Claude Opus 5 / claude-opus-5-thinking-high；**review_fallback**: none
- **verdict**: PASS_WITH_NOTES（0 CRITICAL / 0 HIGH / 0 MEDIUM / 2 LOW；两项均不要求正文语义变更）
- **implementation_authorization**: design-only（PASS_WITH_NOTES **不**解除该限制）
- **allowed_parent_mutation**: 仅允许将本 Round 5 artifact 原样追加到既有 review artifact 路径，并把 `7fe4f367-f3ac-4a2f-bc59-5603c6cc9b8c` 机械替换为宿主实际 agent id；不得修改本文正文、findings、verdict 或 Reviewed Inputs
- **next_gate_requirement**: 若仅按两个 LOW 做澄清式修订，属实质文本变更 → 须重新冻结输入、复算 manifest 与 `reviewed_revision` 并由未参与正文者重跑 Gate；若不修订则以本 revision 为准。Grok 4.6 与 GPT-5.6-sol 仍为正文作者，不得自审；本 reviewer 未参与正文，可继续担任下一轮 reviewer
- **continuity_note_rule**: 仅当后续输入变化为非实质（不改语义的排版/错别字）时，方可由未参与 author/reviewer/正文修改/implementation 的协调者持久化覆盖完整 manifest 的 Continuity Note；实质、不确定、遗漏输入或角色未分离时必须重跑 Gate

## 下一步

1. 设计已达到可实现的完备度，**但当前授权仍为 design-only**：未获新的显式实现授权前不得进入 design-implement，本 Gate 到此停止。
2. 可选（不阻断）：按 R5-LOW-1 在 §5.3 补 `SOFT_REQUEST_BUDGET` 中 scout/sonic 数值的去留决策；按 R5-LOW-2 拆分 §6.1 末条断言并写明 workflow 重试逐 attempt 收窄 cap 的测试注意事项。
3. 若采纳上述澄清，属正文实质变更，须重新冻结输入、复算 manifest 与 `reviewed_revision`，并由未参与正文者重跑独立 Gate。
4. 若用户后续授予实现授权，实现阶段须按 §6.4 只运行与 diff 触及路径相关的现有测试，且若 diff 触及 #8462 / #5372 的 owner（post-yield ingest、`pushLoopPhase`、loop watchdog），必须先回订设计并补真实 repro，不得以弱 smoke 冒充覆盖。

## Design-only Handoff

**给主协调者的中文短 prompt**

> Round 5 独立只读 Design Review Gate 已完成，verdict = **PASS_WITH_NOTES**，`reviewed_revision=a28f72762dec7b73d61c6183bb46820ae27d6f09cf5e57759e6ff3308e6e8916`。Round 4 的 2 HIGH + 2 LOW 全部关闭，Round 3 的 12 项 closure 无回归，无 CRITICAL/HIGH/MEDIUM。
>
> 请只做以下之一，不要在无新授权的情况下进入实现：
> 1. **接受当前设计**：把本 Round 5 artifact 追加持久化到 `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md`（仅允许机械替换 reviewer agent id），并因 `implementation_authorization=design-only` 停止，等待用户显式实现授权。
> 2. **采纳两个 LOW 的澄清**：交给非 reviewer 的修订作者只改 `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` 的两处——(a) §5.3 补写 class 化后 `SOFT_REQUEST_BUDGET` 中 `scout`/`sonic` 数值的去留（`executor.ts:121-126` 的 `default` 仍被 `:2943` 消费，键还兼作 explore 名注册表，不能整体删除）；(b) §6.1 末条拆成两断言，写明 `workflow/runtime-adapter.ts:190-202` 会逐 schema 重试收窄 `profile.maxRuntimeMs` 并经 `:432` 作为显式 caller cap 下传，测试须按每次实际传入值断言、不得假定重试间 cap 恒定。改完后停止，重新冻结输入、复算 manifest 与 `reviewed_revision`，并请求新的独立 Gate（Grok 4.6 与 GPT-5.6-sol 不得自审）。
>
> 两条路径下都不得改代码、改 `~/.omp`、跑测试或发布。

**需一并交给下一环节的输入**

1. `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md`
2. `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md`
3. `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md` 中的完整 Round 5 artifact

---

# Design Review Gate — OMP subagent 活跃墙钟优化（实现评审 reentry revision）

## 0. Metadata

- **artifact_target**: `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md`（由主 agent 按既有 review artifact 路径持久化追加；本条 Gate 为只读产出，reviewer 未编辑任何文件）
- **reviewer_native_identity**: `LatencyDesignFallbackGate` / `gateway/deepseek-v4-flash:max`（DeepSeek V4 Flash）
- **reviewer_role**: Flash Design Reviewer（read-only independent Design Review Gate，未参与正文创作）
- **review_fallback**: `flash-reviewer / DeepSeek V4 Flash`
- **planned_reviewer_failure**: Claude Opus 5 / `claude-opus-5-thinking-high`（`LatencyDesignReGate`）立即失败：gateway 400 `unknown provider for model claude-opus-5`
- **fallback_rule_applied**: 按设计 §8.1「若 Claude Opus 5 unavailable，只能选择未参与正文的 native fallback 并记录原因」；Grok 4.6 与 GPT-5.6-sol 及其同模型实例均参与正文（author/revision author），二者 disqualify，未回退
- **design_author_models**: Grok 4.6（原 author）、GPT-5.6-sol（revision author ×2，含 replacement author `LatencyDesignFallbackRevision`，原因=Grok author job stalled/cancelled）
- **implementation_authorization**: `implementation-authorized; paused for independent design re-Gate`
- **date**: 2026-08-31
- **constraints honored**: 只读；未运行测试/构建/benchmark/fixture；未改任何文件、`~/.omp` 或外部状态

## 1. Reviewed Inputs manifest（raw bytes 独立复算，POSIX path 排序）

```text
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md	64dd192537b3f0e35fa627c64f9897fa7d9407bcd075099e101d0e87cf88bac9
docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md	bd6693c1d899cfd61df04fd83a54f76d42f4ecaf50aadaa3c1c65059de6b3e45
```

- design SHA-256（`shasum -a 256`，552 行 raw bytes）：**MATCH** `64dd1925…`
- facts brief SHA-256：**MATCH** `bd6693c1…`（与 Round 5 manifest 中 facts 哈希一致，facts 未漂移）
- **reviewed_revision**（聚合）：`cdba26d86a221209a99602d42d0d54c77565544655d6ef59710735e8ed6ec912` — 已独立复算 = 上述排序 manifest 文本块（`path\tSHA-256` 两行，UTF-8，行尾 LF）的 SHA-256：**MATCH**
- **reviewed_input_drift_detected**: none（两条父侧预计算散列与 reviewer 独立复算逐一相等）
- Round 5 旧 revision `24b0169e…` 对应旧 design 哈希 `fa5c4eb2…`；当前 design 哈希已变（64dd1925…）→ 本 Gate 为实质 reentry，旧 Gate 不覆盖当前正文，符合 §8.1 声明

## 2. 实现评审证据（Gate evidence，非 Reviewed Inputs）

逐条只读核对：`src/vibe/runtime.ts`（#resolveWorker/#buildSpawnOptions/#registerTurnJob）、`src/task/executor.ts`（runSubprocess/resolveSoftRequestBudget/buildSoftRuntimeNotice）、`src/task/review-performance.ts`（resolveSubagentPerformanceClass）、`test/vibe/spawn-model-role.test.ts`（spawnAndCaptureOptions）。

## 3. Findings by severity

### BLOCKING

无。

### MEDIUM

无。

### LOW（notes，不阻断）

1. **[NOTE] 计划 reviewer 可用性回退**：设计 §8.1/§8.2 冻结下一 reviewer 为 Claude Opus 5；实际 Gate 时 `claude-opus-5-thinking-high` 以 gateway 400 `unknown provider for model claude-opus-5` 立即失败，按 §8.1 fallback 规则由未参与正文的 DeepSeek V4 Flash 执行。属规则内程序性事件，非设计缺陷；持久化 artifact 必须同时记录失败与 fallback identity。
2. **[NOTE] 实现状态：两条修正缺口目前真实存在，设计指向精准**：工作区已落地中央 resolver、runSubprocess advisory 75% steer、`wrapUpNoticeSent` latch、`SOFT_REQUEST_BUDGET` 去 legacy 化、`task/index.ts` 名单/解析器删除；**仅剩** Vibe class 直传与静态 notice asset 两个 seam 未闭合（见 §4），正是本文档两条修正的恰好范围。`spawn-model-role.test.ts` 现仅断言 modelOverride/modelRole，performanceClass 断言为计划内扩展。
3. **[NOTE] 措辞精度**：§1.5「bundled `sonic` 从 legacy 100 req 实际回退到 configured/default 200 req」历史与现状两半均已核实：legacy `scout/sonic=100` 已从 `SOFT_REQUEST_BUDGET` 移除（executor.ts:119 现为 `{ default: 200 }`），worker 消费返回 configured/default 200（executor.ts:2963）；facts brief §3.1 历史值 100 一致。

## 4. 核心事实核对（path:line 证据）

### 4.1 修正 1 — Vibe direct-caller class 缺口：事实成立，修复最小充分

- `vibe/runtime.ts:49-52` `VIBE_CLI_AGENT = { fast: "sonic", good: "task" }`；`:499-503` `#resolveWorker` 经 `getBundledAgent(agentName)` 返回 bundled agent，缺失即抛错 → 已解析 bundled `record.agent` 断言成立。
- `vibe/runtime.ts:1416-1475` `#buildSpawnOptions` 直接构造 `ExecutorOptions` 字面量，`:1434` `agent: record.agent`；**无 `performanceClass` 字段**。
- `vibe/runtime.ts:1530` `#registerTurnJob` 首轮 `runSubprocess(await this.#buildSpawnOptions(…))` 直连 executor，不经过 `resolveEffectiveSubagentPolicy`/`runStructuredSubagent`。
- `vibe/runtime.ts:29-33` imports 仅 `getBundledAgent` + executor 符号；**未导入** `resolveSubagentPerformanceClass`。
- `executor.ts:2963` `resolveSoftRequestBudget(options.performanceClass ?? "worker", configuredDefaultBudget)` —— 缺失按 worker 消费，无按 name 重分类（唯一 seam，无第二套 legacy policy）。
- `executor.ts:119-132` `SOFT_REQUEST_BUDGET={default:200}`（legacy scout/sonic=100 已删）；`resolveSoftRequestBudget`：explore→min(n,40)、review→min(n,80)、worker→n。
- 结论：Vibe `fast`/bundled `sonic` 当前运行在 worker 合同（configured/default 200 req、无 explore prompt/40 req/75% advisory），设计 §1.5 所述事实完全成立。
- 修复最小充分：`#buildSpawnOptions` 调中央 `resolveSubagentPerformanceClass({ agentName: record.agent.name, agentShadowReview: record.agent.shadowReview })` 并传 `ExecutorOptions.performanceClass`；不重复 discovery、不迁入 structured runner、不加 Vibe ceiling —— 与 §4.3 拒绝三项更深做法的口径一致。

### 4.2 修正 2 — runtime steer 静态 prompt asset：事实成立，修复最小充分

- `executor.ts:143-145` `buildSoftRuntimeNotice` 当前正文为 TS 模板字面量内联（`[runtime notice] This run has used ${softRuntimeMs} ms …`）—— 模型可见正文未由 prompt asset 持有。
- `packages/coding-agent/src/prompts/system/` glob：**不存在** `subagent-soft-runtime-notice.md`（拟新增确认）。
- 修复指定该文件为正文 owner、`prompt.render` 注入 `softRuntimeMs`/`maxRuntimeMs`、builder 保留渲染/test seam、legacy `buildBudgetNotice`（executor.ts:138-140）不迁移 —— 最小、符合提示资产规则。

### 4.3 结构化调用宇宙限定（五行表完整性）

`runStructuredSubagent(` 全部调用方恰好 5 处：`task/index.ts:1590`（TaskTool，含 commit-agentic `AnalyzeFile*`→`sonic`，`analyze-file.ts:86-91` TaskParams `agent:"sonic"` 经 taskTool.execute）、`workflow/runtime-default.ts`（adapter）、`eval/agent-bridge.ts:145`（`invocationKind:"eval"`）、`cleanse/agent.ts:131`（discovery，agent="task"）与 `:165`/`:169`（dispatchWorker，agent="sonic"）。Vibe 正确排除（直连 runSubprocess）。五行表=完整 universe 成立。

## 5. 保留性核对（无回退）

- **runtime precedence**：`structured-subagent.ts:337-347` 显式 request cap 权威直通（0/>0）、eval omitted 继承 fresh setting、task+omitted 对 fresh 非 0 值 `min(fresh, class ceiling)` 且 0 无限；`executor.ts:2959-2962` 消费 effective `maxRuntimeMs`。符合 §5.2 step 5。/ **workflow schema retry 逐 attempt profile cap 原样、`remainingTimeMs` 不流入**：设计 §5.2/§5.4/§6.1 均保持。
- **class matrix（9 行）**：`review-performance.ts:92-97` `resolveSubagentPerformanceClass` —— explore 名优先（scout/sonic）→ floor 四名（reviewer/subagent-sol/sol-xhigh-reviewer/security-reviewer，`:12-17`）→ agent frontmatter `"code"` → spawn `"code"` → worker；spawn `"off"` 不作为 class 否决（input 中 `spawnShadowReview` 的 `"off"` 不被消费为降级），explore 不被 `"code"` 升格。与设计 9 行表逐一相符。
- **12/42 上限**：§6.3 smoke `2×(1+5)=12`、release `2×(1+20)=42`，n=5 不报 p90、全局并发=1、nearest-rank、strictModelIdentity、retry 不突破上限 —— 算术已复算（2×6=12，2×21=42），成立。
- **UNVERIFIED 语义**：§5.4/§6.3 未运行/skip/partial/凭据不足 → `UNVERIFIED`，不阻断普通 release、禁止 latency success claim；不新增 settings key。
- **未知延迟状态**：§3.3 `[未知]`/`[未验证假设]` 保持；treatment 数值标 `[拟议验收目标]` 非因果承诺；§1.5 两条修正不影响该分层。
- **无第二 engine/settings**：§1.4/§5.3 不新建 scheduler/runner/completion engine/role framework/feature flag/settings key；不为 Vibe 建 structured runner；executor 无 name fallback。Evidence：executor 唯一 class 来源 `options.performanceClass ?? "worker"`。
- **Round 5 两条 LOW/MEDIUM closure 未回退**：① LOW `configuredMaxRuntimeMs`/`soft_runtime` 无消费者 —— 设计 §7 与源码一致：`EffectiveSubagentPolicy` 仅新增 `performanceClass`/`effectiveMaxRuntimeMs`（structured-subagent.ts:153-154），无 `configuredMaxRuntimeMs`；`SubagentCheckpointMetrics.kind` 仍 `"soft_budget" | "runtime_timeout"`（review-performance.ts:69-70），75% 已 advisory 化（`sendWrapUpNotice` executor.ts:1346，不 push checkpoint），hard timeout 仍 push `runtime_timeout`（~:1361），`requestBudgetStop` 仅剩 1.5× request-count 一处调用（executor.ts:1792）。② MEDIUM `#8462/#5372` 弱测试 —— 设计 §6.4 明确不新增测试、不宣称覆盖，与 closure 一致。
- **75% advisory 与 completion 合同**：`executor.ts:1317` `softRuntimeMs = resolveClassSoftRuntimeMs(performanceClass ?? "worker", maxRuntimeMs)`；`:1318-1335` `wrapUpNoticeWouldRace`（resolved/abortSent/budgetStopRequested/terminalYieldCommitted/wrapUpNoticeSent）+ `sendWrapUpNotice`；`buildSoftRuntimeNotice` 为保留 seam。
- **system prompt 分支**：`executor.ts:3369-3370` `exploreClass`/`reviewClass` 取自 `options.performanceClass`（不从 agent 名重算）。
- **read-summarize false-only 合同**：`executor.ts:2953` `...(agent.readSummarize === false ? { "read.summarize.enabled": false } : undefined)` —— false-only 现状与 §5.3 行为合同一致；`persisted-revive.ts` 不改。
- **根因一致性**：两条修正都属于同一机制层（class 覆盖面 + prompt 资产 owner），不改变「叠加主因 / hang≠慢 / parked≠活跃 / shadow≤2min 非主因」的根因结构，不引入新杠杆或新引擎。

## 6. 数字交叉核对（design vs facts brief）

- review/gate n=60 p50=20.0/p90=33.1/≥30min=9 ✓；scout n=8 p50=14.8/p90=15.8 ✓；子墙钟 p50/p90/max=19.3/33.7/1163.0、≥20=37、≥30=13 ✓（30+0+2+1+4=37；9+0+2+0+2=13 ✓）；oh-my-pi 子集 52/20.0/37.2/10 ✓；`GrokStandardsAxis` 70.0/63 轮/read 167 ✓（facts brief §1 表）。
- ceiling 换算：1_800_000 ms=30 min、600_000 ms=10 min ✓；75% checkpoint 7.5 min（explore）/22.5 min（review）✓（§1.2 表后附注）。
- 无 [历史事实] 违背 brief；treatment 目标与观测值标签分离（[拟议验收目标] ≠ [历史事实]）合规。

## 7. 连续性

- Round 5 Gate（旧 revision `24b0169e…`，旧 design `fa5c4eb2…`）的 LOW/MEDIUM closures 已在新正文继承核对（§5）；facts brief 哈希未变。
- 当前 revision 的 manifest/reviewed_revision 由 reviewer 从 raw bytes 独立复算并与父侧预计算值交叉验证：三项全 MATCH。
- 本 Gate 为实质 reentry 的独立判定，不沿用旧 verdict。

## 8. Verdict

**PASS_WITH_NOTES**

理由：两条实现评审修正的成因事实均经源码证实，修复设计最小充分且复用现有 canonical owner；五行结构化调用 universe 限定完整、Vibe 排除正确；runtime precedence、9 行 class matrix、12/42 上限、UNVERIFIED、未知延迟状态、无第二 engine/settings 与 Round 5 closures 全部保留无回退；根因一致。三条 NOTE 均为程序性/实现状态记录，不构成设计缺陷。

## 9. Implementation-resume instruction（按设计 §8.2）

当前 `implementation_authorization=implementation-authorized; paused for independent design re-Gate`。Gate 结果 PASS_WITH_NOTES → **恢复用户已授权的实现**，不得误按旧 design-only 合同停止。恢复顺序与针对性验证：

1. `src/vibe/runtime.ts` `#buildSpawnOptions`：对已解析 bundled `record.agent` 调中央 `resolveSubagentPerformanceClass({ agentName: record.agent.name, agentShadowReview: record.agent.shadowReview })`，结果写入 `ExecutorOptions.performanceClass`；保持 `#registerTurnJob` → `runSubprocess` seam；不重复 discovery、不新建 structured runner、不加 Vibe ceiling。
2. 新建 `packages/coding-agent/src/prompts/system/subagent-soft-runtime-notice.md` 为 75% advisory 正文 owner；`executor.ts:buildSoftRuntimeNotice` 改为静态导入 + 现有 `prompt.render` 注入 `softRuntimeMs`/`maxRuntimeMs`，保留渲染/test seam；legacy `buildBudgetNotice` 不迁移。
3. 扩展 `test/vibe/spawn-model-role.test.ts` 的 `spawnAndCaptureOptions`：断言 `fast`/bundled `sonic` → `performanceClass==="explore"`、`good`/bundled `task` → `"worker"`（真实捕获 runSubprocess options 的行为断言，非源码字面扫描）。
4. `executor-wall-clock.test.ts`：经 `buildSoftRuntimeNotice` seam 验证静态 asset 正确渲染两个数值、75% steer 且 terminal yield → `completed`、与 request notice 共用 latch 只发一条。
5. 实现后按 §6.1/§6.4 与触及路径相关的针对性验证运行（performance/class、structured runtime、workflow adapter、eval bridge、Vibe、executor wall-clock/soft-budget、cleanse/commit 邻接、`create-subagent-settings`/`persisted-revive`、required quality gate、#4957 regression）；release latency qualification（§6.3）仅由授权 maintainer 人工触发，未生效 PASS 一律 `UNVERIFIED`。

主 agent 在实现落地后执行项目级验证；`NEEDS_REVISION`/`NEEDS_REDESIGN` 不适用（verdict=PASS_WITH_NOTES）。
