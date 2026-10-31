# Design Review: Goal 主机验收闸门与 Grok 4.6 overlay 减负

- Date: 2026-08-28
- Reviewed Design: `docs/superpowers/specs/2026-08-27-goal-host-completion-and-grok-unload-design.md`
- Review Scope: 只读评审根因证据、Goal 结案状态机、隐藏 evaluator、假完成预检、续跑时序、持久化恢复、Grok prompt 减负、验证计划及替代方向；未修改设计输入、代码或配置。

## 1. 整体结论

- `NEEDS_REVISION`
- 一句话结论：`complete` 的状态转换是正确切入点，但 v1 仍让同一个工作模型决定 `candidate_complete`，没有兑现“主机验收”；D3 的函数合同无法取得自身所需证据，提名单飞、取消、陈旧结果和恢复语义也未定义，不能按现稿直接实现。

## 2. 根因评审结论（按需）

- 适用性：适用。方案明确依赖“完成权所在位置”和“Grok overlay 实际内容”两个根因/前提判断。
- 结论：`WEAK_EVIDENCE`。
- 理由：直接结案路径及 ordinary/interactive continuation 的失效链有充分代码证据；`numbered` 是 Grok 假完成放大器则只有上一轮 RCA 的推断，且该 RCA 明确把 prompt 改动定为“可选减诱因，不是主修复”。主根因成立，复合根因中的 overlay 因果强度未被日志、复现或消融支撑。

### 2.1 证据检查

- `packages/coding-agent/src/goals/tools/goal-tool.ts:71-99` 证明 `op:"complete"` 当前直接调用 `GoalRuntime.completeGoalFromTool()`；`packages/coding-agent/src/goals/runtime.ts:482-503` 随即写入 `enabled=false`、`status="complete"`、`mode="exiting"` 并持久化。设计对“模型调用即产生终态副作用”的定位成立。
- `packages/coding-agent/src/session/agent-session.ts:3361-3397` 证明带任意 tool call 的 `agent_end` 在 todo 与 ordinary-obligation 检查前返回；`packages/coding-agent/src/modes/interactive-mode.ts:1609-1649` 证明 interactive continuation 只在 goal 仍 `active` 时经 800ms 定时器触发。设计 §2.1 的拦截缺口成立。
- `packages/coding-agent/src/model-optimization/default-profiles.ts:84-96` 同时配置 `thinkingPrompt.style="step-by-step"` 与 `instructionFormat="numbered"`；`packages/coding-agent/src/prompts/model-optimization/explicit-grok.md:5-10` 明文要求 numbered steps。overlay 形状事实成立。
- `docs/superpowers/specs/2026-08-20-grok-46-repetition-loop-design.md:109-125` 把 prompt 形状标为 `[推断]`，只说明它会诱发完整计划句，并明确“可选减诱因，不是主修复”；该文档没有证明 numbered 会增加假完成或错误结案。
- 文档没有提供同模型 evaluator 的离线样本、误放行率/误拒率、Grok overlay 消融、假完成启发式命中率或实际 transcript。§2.2 已诚实标为未确认假设，但这些假设直接决定 v1 是否能阻止假完成。

### 2.2 事实 / 假设边界检查

- 成立事实：`complete` 的终态副作用没有证据参数；ordinary gate 不在该副作用前运行；tool-call turn 会跳过 settle 检查；interactive continuation 依赖 `active`；Grok 普通 profile 与 overlay 均含 numbered/step-by-step 信号。
- 未确认假设：同一模型换成“质检角色”就有足够独立性；固定完成动词能以可接受的召回/误报覆盖假完成；同模型看到主机打包摘要后不会再次为自己背书。
- 推断过度：“完成权收回主机”不成立。D2 指定 evaluator 使用“当前会话模型”，D1 又允许它的 `candidate_complete` 直接触发现有终态转换；主机只执行模型决定，没有独立验收。
- 产品假设：“用户要的是 harness 行为”可以指导范围，但不能替代对所有模型默认启用闸门的质量与延迟证据。

### 2.3 对方案的影响检查

- D1 把控制点移到 `completeGoalFromTool()` 之前，直接命中已确认主因；这一总体方向应保留，不需要推翻重设计。
- D2 的同模型 evaluator 只能作为 advisory classifier 或候选生成器，不能作为“主机验收”的最终 authority。要维持当前成功标准，v1 必须先有 deterministic hard gate，并在自动结案前使用独立只读 verifier；否则应下调产品承诺并将失败语义写成“host-mediated self-review”。
- D4 是可独立尝试的减负优化，不应作为结案闸门正确性的证据；需要独立开关、消融或至少独立回滚合同。
- D3 不关闭 goal，安全收益有限：未提名 complete 时 goal 本就保持 `active`，现有 800ms continuation 已会续跑。把 D3 从 v1 移除可同时消除脆弱 NLP、重复 evaluator 和双续跑时序面。

## 3. 设计方案评审

### 3.1 需求与方向

- 正确：在 host 侧截住 `complete` 终态转换，比继续加厚 prompt 更接近根因；`drop` 不验收、普通问答不加闸、overlay 与 gate 可分开讨论，范围边界合理。
- 不足：成功标准把“主机拥有完成权”与“同一工作模型换角色给 JSON”混为一谈。前者需要主机可验证的 hard guards 或独立证据源，后者只是二次采样。
- 更好路径：保留 D1；先复用 `model-policy/completion.ts` 的 typed gate 思路，对 todo、未配对 tool、失败/缺失验证、required artifacts、异步 in-flight 做确定性拒绝；hard guards 通过后才调用独立只读 verifier。当前模型 evaluator 只负责给 `next_step`/`blocker`，不得单独授予 complete。
- v1 应删除 D3。若后续 telemetry 证明“带具体缺口的立即续跑”明显优于现有 800ms continuation，再以统一 scheduler 和结构化 settle snapshot 增量加入。

### 3.2 方案合理性

- 可取：静态 prompt、无工具 oneshot、unknown-field 拒绝、超时/解析失败永不 complete、有限输出 token、可回滚设置，均是保守设计。
- 不合理：D2 同模型 `candidate_complete` 仍是自我验收；角色隔离与无工具不能提供独立 repo 证据，`git --stat` 也只证明改动存在，不证明 objective 满足。
- 不完整：`pendingVerification` 是持久字段，但没有 nomination identity、turn/generation、单飞缓存或 compare-and-set。evaluator 返回时，goal 可能已被 drop、替换、暂停、恢复或由另一提名完成。
- 不完整：D3 同时触碰 `agent_end`、ordinary obligation、interactive timer 和 hidden-next-turn delivery，却没有指定唯一 settle owner。现有 `HiddenNextTurnScheduler` 已维护 generation/delivery ownership，新增路径不能旁路它。
- 不完整：`blocked` 由同模型直接映射 `pauseGoal()`，但没有 host 规则区分稳定外部 blocker、可重试 provider 错误和模型偷懒；`blocker_key` 的格式校验不足以证明应暂停。

### 3.3 实现可行性

- 基础缝可用：`ToolSession.getActiveModel()`、`getTodoPhases()`、`snapshotConsultContext()`、集中 git helper、`instrumentedCompleteSimple()`、GoalRuntime 的 turn snapshot 与静态 prompt 资产都可复用。
- D3 按当前签名不可实现：`looksLikeFalseCompletion(lastAssistantText, turnToolNames)` 只有文本和工具名，却要判断 `goal` 的 op/提名结果、bash/eval 命令文本及成功状态、todo 是否仍 open。
- 取消合同不足：现有 `GoalTool.execute` 已接收 `AbortSignal`（`goal-tool.ts:71-76`），consult 也会用 `AbortSignal.any()` 合并用户取消与 timeout（`tools/consult.ts:109-116`）；设计只写 `AbortSignal.timeout` 和“ESC 时清 pending”，未定义如何中止请求及丢弃晚到结果。
- 恢复合同不足：`interactive-mode.ts:2738-2764` 手工白名单反序列化 Goal，按文件清单实现会丢弃新增 `hostGate`；`goals/hash.ts:32-48` 也不会因 `lastNextStep` 变化重置 goal context hash，和“render 时带 lastNextStep”不一致。
- 输入只有分块字符上限，没有总 token budget；`objective` 还要求全文。现有 consult projection 会基于模型 tokenizer 检查总预算并逐步丢弃可裁剪历史（`tools/consult-transcript.ts:292-303`），evaluator 应复用同类总预算合同。

### 3.4 文档质量

- 优点：目标/非目标、方案对比、D1-D7、数据流、状态草图、错误表和验证计划齐全；事实与未确认假设分开写，结构清晰。
- 矛盾：D3 的公开函数签名与判定条件不相容；“每 goal 每回合最多 1 次”没有可持久或内存识别的 key；“主机验收”与当前模型授予 `candidate_complete` 不一致。
- 文件清单遗漏：`interactive-mode.ts` 的 Goal 反序列化、`goals/hash.ts` 的 prompt hash 语义、hidden-next-turn scheduler 的唯一所有权、central git helper 的能力确认/扩展。
- 验证计划缺少：双 complete、complete 期间 drop/replace/resume、用户取消与 timeout 竞态、进程在 pending 时崩溃后恢复、陈旧 evaluator 结果、总输入超预算、blocked 的稳定外部依赖语义、interactive/headless/ordinary 三路不双发。

## 4. 主要发现

### CRITICAL

- 无。

### HIGH

#### [HIGH] 架构: 同模型 evaluator 没有把完成权真正收回主机

**位置**: §1.1-1.2、方案 C、D1-D2、D5。

**问题**: v1 使用当前会话模型进行 evaluator，并把其 `candidate_complete` 直接映射为 `completeGoalFromTool()`。主机没有 independently verifiable hard gate，工作模型仍拥有最终完成权，只是多了一次低 effort 自评。

**影响**: 方案可能降低偶发假完成，却不能兑现“别信干活模型说做完”的核心承诺；同一模型系统性遗漏、迎合或被 transcript 注入时仍会误结案。

**建议**: v1 先执行 deterministic host gate；自动结案必须再经过独立只读 verifier，或在 verifier 不可用时保持 active/要求用户确认。当前模型 evaluator 限定为 `next_step`/`blocker` advisory，不得单独产生 complete。若坚持现稿，则必须改名并下调成功标准，不得称“主机验收”。

#### [HIGH] 合同: 假完成预检的输入无法表达自身判定条件

**位置**: D3 第 168-178 行。

**问题**: 声明的输入仅为 `lastAssistantText` 与 `turnToolNames`，但规则需要 goal op、提名是否成功、bash/eval 参数、验证调用是否成功及当前 todo 状态。工具名集合不能提供这些信息。

**影响**: 实现只能猜测或临时读取分散状态；“已提名不二次跑 evaluator”“失败测试不算验证”“todo 未清强制续跑”等合同会互相漂移，焦点测试也无法证明真实 settle 行为。

**建议**: v1 删除 D3，继续使用现有 active-goal continuation。若保留，先定义 `GoalCompletionSettleSnapshot`：turnId、assistant text、tool call id/name/args、result/isError、goal nomination outcome、todo snapshot，并由 agent event 真源一次性构建；纯函数只消费该结构。

#### [HIGH] 时序: 提名缺少单飞、取消、陈旧结果与恢复原子性

**位置**: D1-D2、§5.2、§5.5。

**问题**: `pendingVerification` 没有 nomination id、turn/generation 或 owner；“每 goal 每回合最多一次”没有缓存键；timeout 没有与工具 `AbortSignal` 组合；pending 状态恢复规则未定义。异步 evaluator 期间 goal 可被 drop、替换、暂停、恢复或重复提名。

**影响**: 晚到结果可能完成/暂停错误 goal，重复计费，崩溃恢复后永久显示 Verifying，或在用户取消后仍提交终态。

**建议**: 提名时生成 `{goalId, goalRevision, turnId, nominationId}` 并持久化；以 compare-and-set 应用结果；同 turn 单飞并共享 Promise/result；组合 user abort + timeout；drop/replace/pause/dispose 时取消；陈旧结果只记录并丢弃；恢复遇到 pending 时保守清为 active+continue。同步更新 `#goalFromModeData`、prompt hash 规则和竞态测试。

### MEDIUM

#### [MEDIUM] 调度: D3 没有统一 interactive 与 hidden-next-turn 的续跑所有权

**位置**: D3、D7、§5.1；现状见 `agent-session.ts:7160-7218` 与 `interactive-mode.ts:1609-1649`。

**问题**: 设计要求 agent_end 立即排队 false-completion，又要求取消 interactive 800ms timer，只处理 ordinary-obligation 的双注入；没有定义跨 AgentSession/InteractiveMode 的事件、generation 和唯一 settle owner。

**影响**: 同一 agent_end 可能提交两次隐藏 turn、丢失具体 next_step，或在 busy/用户输入窗口触发 `AgentBusyError`。

**建议**: 所有自动 goal continuation 统一进入现有 hidden-next-turn scheduler，以 delivery/generation 去重；InteractiveMode 只消费调度结果，不再拥有平行 timer。若不做统一，删除 D3。

#### [MEDIUM] 预算: evaluator 没有完整请求 token budget

**位置**: D2 输入表与调用约束。

**问题**: 4KB/8KB/32KB 是字符/字节分块上限，`objective` 仍无上限；没有基于当前模型 contextWindow、maxOutputTokens 和 reserve 的总 token 检查。

**影响**: 大 objective 或高密度 transcript 可被 provider 拒绝，fail-open=continue 会让本来完成的 goal 永远无法结案并反复付费。

**建议**: 复用 consult projection 的 tokenizer 总预算与 pinned/droppable 裁剪顺序；objective 单独超预算时返回稳定 blocker 或明确用户操作，不进入无限 continue。

#### [MEDIUM] 变更管理: Grok overlay 减负的因果与独立回滚不足

**位置**: §2.1 第 56-57 行、D4、D6、§5.6。

**问题**: 上一轮 RCA 只把 numbered 定为规划句诱因，未证明它导致假完成；本设计却和所有模型的 goal gate 同期落地。`goal.hostGate.enabled=false` 不恢复 overlay，也没有 overlay 专用开关或消融指标。

**影响**: 普通 Grok 会话指令遵循若下降，无法与 gate 效果分离归因或单独运行时回滚。

**建议**: 把 D4 作为独立 patch/feature flag，记录普通 Grok 与 goal 会话的成功率、tool-first 遵循和完成延迟；至少保证不改 gate 即可单独回滚 profile/template。

### LOW

- 无。

## 5. 修订建议

1. 保留 D1 的结案切入点，但把 v1 改为“deterministic host gate → 独立 verifier → 原子 complete”；当前模型 evaluator 仅输出 advisory `next_step`/`blocker`。
2. 从 v1 删除 D3；现有 goal active continuation 已保证不会因 text-only 假完成而结案。后续只有在 telemetry 证明收益后再增加结构化 settle classifier。
3. 为 nomination 定义 revision/turn/id、单飞、组合取消、compare-and-set、陈旧结果丢弃、崩溃恢复和所有状态转换表。
4. 统一 interactive、headless、ordinary/false-completion 的隐藏续跑 owner；不得从两个组件各自提交下一 turn。
5. 给 evaluator 增加模型 tokenizer 驱动的总输入预算、明确裁剪顺序和 objective 超预算终态。
6. 更新完整实现面：Goal 反序列化、hash reset、ToolSession/GoalRuntime host seam、central git helper、settings/details/renderer、持久化兼容与 changelog。
7. 补齐并发、取消、恢复、blocked、输入超限、三路续跑去重和 overlay 独立回滚测试；保留现有合同级 happy/error 路径。

## 6. 下一步建议

- 进入 `design-implement`，先按三个 HIGH 项修订设计，再实施修订后的 v1。
- 理由：`complete` 前置 host gate 的总体方向正确，无需推翻；但 authority、可实现输入合同和异步状态机都是编码前必须钉死的 load-bearing 契约。

## 7. Handoff

### 7.1 同会话继续

`直接执行 $design-implement 或 /design-implement`

### 7.2 新会话恢复 prompt

```text
请阅读设计输入 docs/superpowers/specs/2026-08-27-goal-host-completion-and-grok-unload-design.md
以及评审文档 docs/superpowers/plans/2026-08-28-goal-host-completion-and-grok-unload-design-review.md，
重点核对根因分析（如有）、事实/假设边界、以及方案修订点，
使用 $design-implement（或 /design-implement）进行方案修订及实现。
重点关注：HIGH-1 在 deterministic host gate 或独立 verifier 前不得让同一工作模型拥有最终 complete 权；HIGH-2 删除 v1 的假完成预检或改为可表达 tool args/results/todo 的结构化 settle snapshot；HIGH-3 为提名与 evaluator 定义 turn/generation 单飞、组合取消、陈旧结果丢弃与恢复语义。
```
