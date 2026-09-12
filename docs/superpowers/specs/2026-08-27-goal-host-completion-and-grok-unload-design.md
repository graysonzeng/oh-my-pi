# Design: Goal 主机验收闸门与 Grok 4.6 overlay 减负

- Date: 2026-08-27
- Status: Revised for implementation (2026-08-28)
- Scope: L
- 关联：`docs/superpowers/specs/2026-08-20-grok-46-repetition-loop-design.md`、`packages/coding-agent/src/goals/`、`packages/coding-agent/src/model-policy/completion.ts`、`packages/coding-agent/src/model-optimization/`
- 非目标：不改 TUI 人设、不抄 grok-build 加密 prompt、不把 hashline / eval DAG / 多模型编排换成 Grok 专用栈、不把普通问答会话做成强制终检、不新增 goal scratch 文件系统、不在本设计落地后台 task 完成 reminder 与 concise tool schema

## 1. 设计目标和范围

### 1.1 要解决的问题

oh-my-pi 跑 grok-4.6 时，长任务质量被两件事拖住：

1. **完成权在干活的那个模型手里。** `goal({op:"complete"})` 在 `GoalTool.execute` 里直接调用 `GoalRuntime.completeGoalFromTool()`，状态立刻变成 `complete`。`evaluateOrdinaryContinuation` 只看「goal 是否仍 open」，并且 `agent_end` 在本轮已有 tool call 时直接 return，拦不住这次结案。
2. **Grok 常驻 overlay 在诱使写完整计划句。** 普通会话把 `explicit-grok.md` 追加进 system prompt；正文仍要求 numbered steps。规划句 mode collapse 的主修复已在 thinking-loop guard；常驻 numbered 仍是诱因。长跑纪律（先 tool 后叙述、禁止假完成、测试必须打 shipped 路径）写在永远在的宪法里，而不是只在 goal 激活时出现。

grok-build 用隐藏 evaluator + 对抗 verifier + laziness 分类器把「别信模型说做完」做成产品。omp 已有 `/goal`、800ms interactive continuation、ordinary-obligation 续跑，缺的是 **结案闸门** 和 **Grok 减负**，不是再写一份人设。

### 1.2 成功标准

1. 活跃 goal 下，`goal({op:"complete"})` 只提名，不结案。确定性 host gate 拒绝时：goal 仍 `active`，tool result 带 `next_step` 与 reasons，TUI 不出现 completed 徽章。
2. host gate 通过后，同模型 evaluator 只写 advisory `next_step` / `blocker`。`candidate_complete` **不得** 调用 `completeGoalFromTool()`。v1 终态只由用户 `/goal complete`（或 `goal.hostGate.enabled=false` 的显式 opt-out）关闭。
3. evaluator 返回 `blocked` 时：goal 暂停，用户看到具体 `blocker_key`，不把预算耗尽当成完成。
4. 终态声称 done（完成动词 + 无成功验证 tool / 无 `complete` 提名）且 goal 仍 active：本轮 settle 用 `GoalCompletionSettleSnapshot` 注入带缺口的 hidden-next-turn，而不是只等泛化的 `goal-continuation.md`。
5. grok 家族普通会话 overlay 不再要求 numbered / step-by-step；goal 激活块才出现 tool-first 纪律。`goal.grokOverlayUnload=false` 独立回滚 overlay，不影响 host gate。
6. 焦点测试覆盖：complete 被 host gate 拒绝、用户确认后才结案、blocked、evaluator 超时 fail-open 为 continue、text-only 假完成续跑、带 tool 的 complete 提名仍走闸门、同 turn 提名共享与陈旧结果丢弃、Grok overlay 不再含 numbered 句、`goal.grokOverlayUnload=false` 可回滚。

### 1.3 本次范围

- 活跃 **goal mode** 的结案协议（所有模型，不只 grok-4.6）。
- 隐藏 evaluator（无工具、JSON、bounded transcript）。
- 假完成预检 + 同一 evaluator 复用。
- Grok 普通会话 overlay 减负。
- Goal 激活时的纪律注射（prompt 文件，不进常驻 `system-prompt.md`）。
- v1.1：只读 verifier + 反 ratchet（同一设计，后一里程碑落地）。

### 1.4 非目标

- 不改「You are Grok」人设，不替换 omp 多模型 / `eval` / `hub`。
- 不把 thinking-loop guard 再写一套；规划句复读仍由既有 stream guard 负责。
- 不在 v1 落地独立 strategist 子 agent、goal scratch 目录、MCP/tool schema 缩短、后台 task `<system-reminder>`。
- 不让 `drop` 走验收；用户/模型丢弃 goal 仍立即生效。
- 不在无 goal、无显式 obligation 的普通问答上加第二模型闸。

## 2. 根因分析（按需）

方案选择依赖「完成权在哪」和「Grok overlay 实际喂了什么」，必须先钉死。

### 2.1 已确认事实

- `GoalTool` 的 `op:"complete"` 分支直接 `await runtime.completeGoalFromTool()`（`packages/coding-agent/src/goals/tools/goal-tool.ts`）。`completeGoalFromTool` 无证据参数，把 `status` 写成 `complete`、`enabled=false`（`goals/runtime.ts`）。
- `evaluateOrdinaryContinuation` 在 goal `active` 时推一条 `goal:<id>` open obligation（`model-policy/completion.ts`）。它 **不** 读 transcript，也 **不** 在 `complete` 工具执行前运行。
- `agent_end`：本轮 `content` 含 `toolCall` 则跳过 todo / ordinary-obligation 续跑（`agent-session.ts` `#processAgentEvent`）。因此「调用 complete 工具」这条路径不会被 ordinary gate 拦住。
- Interactive goal 续跑是 `goal` 仍 `active` 时 800ms 后再喂 `goal-continuation.md`（`interactive-mode.ts` `#scheduleGoalContinuation`）。模型若已 complete，续跑不会发生。
- 普通会话 grok overlay：`default-profiles.ts` `systemPromptTemplate: "explicit-grok"`，`sdk.ts` `withModelOpt` 把 `promptBlock` 追加进 system prompt。`explicit-grok.md` 第三条是 “Prefer numbered steps for multi-part work”。`thinkingPrompt.style: "step-by-step"` 只在 **workflow** `buildStablePromptSections` 变成 “Think step-by-step before acting.”；普通会话不走该函数。
- 2026-08-20 RCA：`explicit-grok` numbered 是规划句诱因，不是逐字环的充分条件；主修复是 thinking-loop guard。该设计明确把 overlay 大改列为非 P0。本设计处理的是 **长任务假完成与减负**，不回退 guard。
- grok-build `/goal`：隐藏 evaluator 只许 `continue | candidate_complete | blocked`；`candidate_complete` 才进对抗 verifier；假完成分类器优先于叙述偷懒。

### 2.2 未确认假设

- 同模型无工具 evaluator 对 `next_step` / `blocker` 的质量足够高，误杀可用 `continue` 消化。v1 **不再**假设它能安全授予 complete：超时/解析失败 fail-open 为 continue，`candidate_complete` 也不结案。
- 完成动词启发式会有漏报/误报。漏报由用户仍可手动 `/goal complete` 或模型再提名补；误报只是多一次续跑，不结案。
- 用户要的是 harness 行为，不是「把 omp 变成 grok-build」。闸门对所有 goal 会话生效；overlay 减负只打 grok 家族，且 numbered 作为假完成放大器仍是 WEAK_EVIDENCE。

### 2.3 根因判断

- 主因：goal 结案是模型副作用，不是主机判定。实现把完成权收到确定性 host gate + 用户确认。
- 放大器：Grok overlay 常驻 numbered；长跑纪律不按需注射。overlay 因果强度弱于主因，故独立可回滚。
- 已排除：缺 hashline、缺 thinking-loop、xAI `reasoning_effort` 接线（catalog 已允许 grok-4.6 的 low/medium/high/xhigh）。

## 3. 方案对比

### 方案 A — 只加厚 prompt（拒绝）

把 `goal-continuation.md` / `explicit-grok.md` 再写严。

- 优点：改动面小。
- 缺点：`completeGoalFromTool` 仍无条件结案；4.6 会把收工话说圆。与已验证缺口矛盾。

### 方案 B — 每轮独立 verifier 子 agent（拒绝作为 v1）

goal 每轮 settle 都 spawn 只读 `task` 做对抗审查。

- 优点：证据最强，接近 grok-build 全量。
- 缺点：延迟/费用高；和现有 800ms continuation 叠床架屋；无反 ratchet 时会抬杠到永远做不完。作为 v1 过重。

### 方案 C — 确定性 host gate + advisory evaluator + Grok 减负（采用，已按评审修订）

`complete` 改为提名。v1 **先**跑确定性 host gate（未配对 tool、open todo、失败/缺失验证命令）。gate 拒绝则 `continue`，永不 complete。gate 通过后，同模型无工具 JSON evaluator 只写 `next_step` / `blocker`；`candidate_complete` **不得**结案。v1 终态只由用户 `/goal complete` 关闭。假完成预检消费 `GoalCompletionSettleSnapshot`，经 hidden-next-turn 注入。Grok overlay 去掉 numbered/step-by-step，可独立回滚。v1.1 再加只读 verifier + 反 ratchet。

- 优点：完成权离开工作模型；费用可控；复用 goal runtime / consult 调用缝；对非 Grok 的 goal 同样有效。
- 缺点：v1 终检没有独立读仓库；host gate 是硬拒绝，不是证明 objective 满足。用户确认是 v1 的独立完成权。

### 方案选择

采用修订后的 **C**。评审 HIGH-1/2/3 已并入 D1–D3；B 的 verifier 仍是 v1.1。

## 4. 关键设计决策

### D1 — `complete` 只提名，确定性 host gate 拒绝，用户确认才结案

`GoalTool` `op:"complete"` 不再直接 `completeGoalFromTool`。

顺序：

1. 校验 goal 存在且非 `dropped`。
2. `GoalRuntime.nominateComplete({ nominationId, turnId, generation })`：写入 `pendingVerification` + identity，**不**把 `status` 写成 `complete`。同 turn/generation 二次提名共享既有 nominationId。
3. 从 agent event 真源构建 `GoalCompletionSettleSnapshot`，跑 `evaluateGoalHostGate`。
4. host `continue`：compare-and-set 清 pending，tool result 带 reasons + `next_step`，`gate: "continue"`。goal 仍 active。
5. host `pass` 后才跑 advisory evaluator。evaluator `blocked` → `pauseGoal()`，`gate: "blocked"`。其它 evaluator 结果（含 `candidate_complete`、超时 fail-open）只写 advisory，`gate: "candidate_complete"`，**不**调用 `completeGoalFromTool()`。
6. 用户 `/goal complete` 取消 in-flight 提名后调用 `completeGoalFromTool()`。`goal.hostGate.enabled=false` 才恢复旧的工具直接结案。

`drop` / `create` / `get` / `resume` 不变；drop/replace/pause/abort 取消 in-flight 提名。陈旧 `{goalId, goalRevision, nominationId, turnId, generation}` 结果丢弃。恢复遇到 pending 时清为 active+continue。

TUI：continue/blocked 用 warning 色。`/goal complete` 是用户确认，不是第三种模型可点的结案工具。

### D2 — 隐藏 evaluator：无工具、JSON、bounded transcript

新模块 `packages/coding-agent/src/goals/evaluator.ts`（纯函数 + 一次 completeSimple）。Prompt 静态文件：

- `prompts/goals/evaluator-system.md`
- `prompts/goals/evaluator-user.md`

合同（与 grok-build 对齐，字段名稳定）：

```json
{
  "decision": "continue" | "candidate_complete" | "blocked",
  "evidence": "string, min 1",
  "next_step": "string, min 1",
  "blocker_key": "string"
}
```

规则：

- `continue` / `candidate_complete` → `blocker_key` 必须为空。
- `blocked` → `blocker_key` 为稳定 snake_case；同一外部依赖保持同一 key。
- 自信的 final response **不是**证据。pending todo、缺验证、placeholder、只描述没执行 → `continue`。
- 预算将尽 **不是** `candidate_complete`。

输入由主机打包，模型无工具：

| 块 | 上限 | 来源 |
|---|---|---|
| objective | 全文，XML escape | `Goal.objective`（沿用 `renderTrustedObjective`） |
| todo | 4KB | 现有 goal todo context 同源 |
| git | 8KB | 中央 `utils/git`：`status -sb` + `diff --stat`；失败则写 `git_unavailable` |
| transcript | 32KB，单条 4KB | 最近对话项，strip thinking；格式与 consult 投影同类：只保留 user/assistant text + tool 名/短结果 |
| prior_gaps | 2KB | 上一轮 evaluator/verifier 缺口，v1 可空 |

调用约束：

- 模型：当前会话模型。不继承「更强顾问链」，避免 goal 结案依赖第二套路由。
- effort：`clampThinkingLevelForModel(sessionModel, "low")`；不支持 effort 则省略。
- `maxTokens`：512。超时：15s（`AbortSignal.timeout`）。
- `instrumentedCompleteSimple`，`oneshotKind: "goal_evaluator"`。
- 解析：去 fence → JSON → deny unknown fields。失败 / 超时 / 空响应 → **decision=continue**，`next_step` 用固定文案「verification unavailable; keep working from current repo evidence」，并 `logger.warn`。**禁止**在失败时 complete。
- 每 goal 每回合最多 1 次 evaluator（complete 提名与假完成预检共享这次调用）。

不把 evaluator 做成 `AgentTool`。用户看不见 tool 行；失败只进日志 + 模型侧 tool result / 续跑块。

### D3 — 假完成：结构化 settle snapshot + hidden-next-turn

不在每轮 idle 再开一次分类器。D3 纯函数只消费 `GoalCompletionSettleSnapshot`（turnId、generation、assistant text、tool id/name/args/result/isError/unpaired、nomination outcome、todo snapshot）。禁止只看 tool 名。

命中条件（同时）：

1. nomination outcome 不是 `nominated` / `accepted`（本轮已提名走 D1，不再 D3）。
2. `stopReason` 不是 `error` / `aborted`。
3. 终态文本匹配完成动词。
4. 没有成功的 bash/eval 验证命令，**或者** todo 仍有 `pending` / `in_progress`。失败测试不算验证。

命中后：`recordHostAdvice` 写入 `lastNextStep`，经现有 `#queueHiddenNextTurnMessage` 注入 `goal-false-completion`。不平行启动 InteractiveMode 800ms timer。不在 D3 路径调用 evaluator，也不自动结案。

`agent_end` 已有 toolCall 时，今天会跳过 ordinary-obligation。假完成预检必须在 **goal active** 且 `stopReason !== error` 时于 `#processAgentEvent` 增加一条，**即使 hasToolCalls**。这是与当前 early-return 的唯一有意差异。

### D4 — 纪律按需注射，Grok overlay 减负

**普通 grok overlay**（`prompts/model-optimization/explicit-grok.md`）改为四条，去掉 numbered：

1. Use tools for repository evidence — do not invent file contents.
2. Prefer small, verified edits over large speculative rewrites.
3. If uncertain, read files before editing.
4. Stay within the user request; do not add unrequested features.

`default-profiles.ts` grok profile：

- `thinkingPrompt`: `{ enabled: false, style: "none" }`（避免将来 ordinary 路径接上 workflow 的 step-by-step 句）。
- `instructionFormat`: `"natural"`。
- `systemPromptTemplate` 仍为 `explicit-grok`。
- tool/context 策略不变（3KB / 并发 6 / utilization 0.7）。

**Goal 激活块**（`goal-mode-active.md` 与 `goal-continuation.md` 增加一节，不进 `system-prompt.md`）：

- Tool-call first, narration second。过去式/进行式描述动作必须同回合有对应 tool。
- 不要问「要我继续吗」；下一步由 todo/objective 决定就执行。
- 有未阻塞的活不许停。
- 测试必须打 shipped 真路径：禁止硬编码期望、从被测对象下游起步、在测试里重写被测函数。

这些句子只在 `GoalRuntime.renderGoalPrompt` 的 active/continuation 模板出现。

### D5 — v1.1 只读 verifier + 反 ratchet（同设计后一里程碑）

不改变 D1–D4 的提名协议。`candidate_complete` 之后：

- 主机 spawn 只读子 agent（工具：`read`/`grep`/`glob`/`bash`；禁止 `edit`/`write`/`goal`）。
- Prompt：`prompts/goals/verifier-system.md` + kind lens（v1.1 只做 `code-change` 一种；research/analysis 仍走 evaluator）。
- 输出：`refuted: boolean` + `gaps[]`（每条 `path:line` 或命令摘录）+ `blocking`。
- `refuted=false` → `completeGoalFromTool`。
- `refuted=true` → goal 保持 active，continuation 带 gaps。
- **反 ratchet：** `prior_gaps` 非空时，新异议只有「可演示的 shipped 缺陷或计划内 gating 未满足」才能 refute；风格/夹具偏好不算。实现为 verifier prompt 硬规则 + 主机把上一轮 gaps 注入，不另做 NLP。
- 连续 3 轮 refute → 不自动改 objective；continuation 增加一节「换 HOW，不换 WHAT」。v1.1 **不** spawn grok-build 式 strategist 子 agent（避免再开编排面）。

v1 未落地 verifier 时，changelog 必须写明：v1 结案 = evaluator 提名通过，不是对抗终检。

### D6 — 设置与默认

| key | default | 作用 |
|---|---|---|
| `goal.hostGate.enabled` | `true` | 总开关。false 时 `complete` 恢复今日直接结案（回滚） |
| `goal.hostGate.timeoutMs` | `15000` | evaluator 超时 |
| `goal.hostGate.maxOutputTokens` | `512` | evaluator 输出上限 |
| `goal.hostGate.falseCompletion` | `true` | D3 预检 |

沿用 `goal.enabled`、`goal.continuationModes`。不新增用户可见 slash command。`goal.hostGate.enabled=false` 时 overlay 减负 **仍然生效**（减负与闸门可独立回滚）。

### D7 — 与 ordinary-obligation / todo reminder 的关系

- Goal 仍是 ordinary obligation 源。闸门拒绝 complete 后 goal 保持 open，后续 text-only settle 仍可走 `#enforceOrdinaryTaskObligations`。
- 同一 `agent_end`：D3 假完成续跑若已 `queueHiddenNextTurnMessage`，则 **不再** 跑 ordinary-obligation 续跑，避免双注入。
- Todo reminder（`todo-tracker`）不变。evaluator 把未关闭 todo 视为 continue 证据，不替代 todo 工具。

## 5. 详细设计

### 5.1 数据流

```text
模型调用 goal({op:"complete"})
        │
        ▼
GoalTool.execute ── nominateComplete({nominationId,turnId,generation})
        │
        ▼
evaluateGoalHostGate(GoalCompletionSettleSnapshot)
        │
        ├─ continue ── applyNominationResult(CAS) ── tool result(next_step) ── goal stays active
        └─ pass
                │
                ▼
        runGoalEvaluator (advisory only)
                │
                ├─ blocked ── pauseGoal() ── user-visible blocker_key
                └─ continue | candidate_complete | fail-open
                        │
                        └─ write lastNextStep; goal stays active
                                │
                                └─ user /goal complete ── completeGoalFromTool()
```

假完成：

```text
agent_end (goal active, not error)
        │
        ├─ 本轮已 nominate complete → 只走 D1，不再 D3
        ├─ looksLikeFalseCompletion(snapshot) → recordHostAdvice + hidden-next-turn
        └─ 未命中 → 现有 ordinary-obligation / continuation
```

### 5.2 状态扩展

`Goal` 增加可选字段（缺省 = v1 未跑过闸门）：

```ts
hostGate?: {
  goalRevision: number;
  pendingVerification: boolean;
  nominationId?: string;
  turnId?: string;
  generation?: number;
  lastDecision?: "continue" | "candidate_complete" | "blocked" | "user_confirmed";
  lastEvidence?: string;
  lastNextStep?: string;
  lastBlockerKey?: string;
  lastReasons?: string[];
  consecutiveContinueCount: number;
  lastGaps?: string[];
};
```

persist 走现有 `persist("goal")`。旧 session 无该字段视为 `pendingVerification=false`。`#goalFromModeData` 必须还原 `hostGate`。`lastNextStep` 变化会重置 goal prompt hash。

`GoalToolDetails.gate`：`continue` | `candidate_complete` | `blocked` | `user_confirmed`。Renderer：continue/blocked 用 warning 色；candidate_complete 仍是 active，不是 completed。

### 5.3 模块与文件

| 文件 | 变更 |
|---|---|
| `src/goals/host-gate.ts` | settle snapshot + 确定性 gate + false-completion 纯函数 |
| `src/goals/complete.ts` | 提名、host gate、advisory evaluator、用户确认路径 |
| `src/goals/evaluator.ts` | 打包、tokenizer 预算、解析、fail-open continue |
| `src/goals/runtime.ts` | nominate/CAS/cancel/recover/recordHostAdvice |
| `src/goals/state.ts` | `hostGate` 字段 |
| `src/goals/hash.ts` | `next_step` 重置 |
| `src/goals/tools/goal-tool.ts` | complete 走闸门；warning 色 |
| `src/session/agent-session.ts` | D3 hidden-next-turn；generation host |
| `src/modes/interactive-mode.ts` | hostGate 反序列化、pending 恢复、`/goal complete` |
| `src/config/settings-schema.ts` | hostGate + grokOverlayUnload |
| `src/model-optimization/prompts.ts` | numbered overlay 独立回滚 |
| `prompts/model-optimization/explicit-grok.md` | 去掉 numbered |
| `prompts/model-optimization/explicit-grok-numbered.md` | 回滚模板 |
| `prompts/goals/evaluator-system.md` | 新 |
| `prompts/goals/evaluator-user.md` | 新 |
| `prompts/goals/goal-false-completion.md` | 新 |
| `prompts/goals/goal-mode-active.md` | 纪律节 + lastNextStep |
| `prompts/goals/goal-continuation.md` | 纪律节 + lastNextStep |
| `prompts/tools/goal.md` | complete = 提名 |
| `test/goals/host-gate.test.ts` | 验证/todo/unpaired/假完成 |
| `test/goals/goal-evaluator.test.ts` | 解析/unknown field/blocker |
| `test/goals/goal-nomination.test.ts` | 单飞、CAS、取消、恢复 |
| `test/goals/goal-tool.test.ts` | complete 不再无条件结案 |
| `packages/coding-agent/CHANGELOG.md` | Unreleased Changed |

v1.1 另加 `src/goals/verifier.ts` 与 verifier prompts；本里程碑不建这些文件。

### 5.4 Prompt 约束

- 全部静态 `.md` + Handlebars。禁止在 `evaluator.ts` 里拼接角色说明。
- evaluator system 必须声明 transcript 为 untrusted data。
- `blocker_key` 与 `next_step` 的语言跟用户 objective 走（不强制中英）。
- false-completion 续跑禁止再要求模型「先列出 1.2.3 计划」；只给 **一个** next_step。

### 5.5 错误与费用

| 失败 | 行为 |
|---|---|
| 超时 / abort | continue + warn 日志；永不 complete |
| 非 JSON / 缺字段 / unknown field | continue + warn |
| 会话无模型 | continue |
| 用户 ESC / drop / replace / pause | 取消 in-flight AbortController；pending 清为 continue |
| 陈旧 nomination 结果 | `applyNominationResult` 返回 `stale`，不改 status |
| 崩溃恢复时 pending=true | `recoverPendingVerification` 清 pending，goal 保持原 status |
| git 命令失败 | bundle 标记 `git_unavailable`；evaluator 仍跑 |
| objective 超 tokenizer 预算 | `blocked` + `blocker_key=objective_over_budget`，不无限 continue |

费用：goal 每次 **提名 complete 且 host gate pass** 才多 1 次短 JSON 调用。D3 假完成不调 evaluator。不在每轮 tool 循环付费。

### 5.6 风险与缓解

- 风险：evaluator 与干活模型同权重，互相吹捧。
  - 缓解：v1 evaluator 不得 complete；host gate 硬拒绝；用户 `/goal complete` 才结案。evaluator 只 advisory。
- 风险：假完成启发式误报，打断正常短答。
  - 缓解：仅 goal active；完成动词 **且**（无验证命令或 todo 未清）；误报只是续跑。
- 风险：complete 变慢 15s。
  - 缓解：low effort、512 tokens、15s cap；TUI 在 pending_verification 显示 Verifying。
- 风险：Grok overlay 变短导致非 goal 会话指令遵循下降。
  - 缓解：`goal.grokOverlayUnload=false` 独立回滚 numbered overlay，不必关 host gate。
- 风险：与 2026-08-20「overlay 大改非 P0」表面冲突。
  - 缓解：该文档 P0 是 stream guard（已落地）。本设计动 overlay 是为假完成/规划诱因减负，且改动是删句不是加戏。

## 6. 验证计划

单测（必须，合同级）：

1. `complete` + host gate 拒绝（缺验证 / open todo / unpaired tool）→ status 仍 `active`，tool text 含 next_step，无 `Goal achieved`。
2. `complete` + host gate pass + evaluator `candidate_complete` → goal 仍 `active`，`gate: "candidate_complete"`，**不**调用 `completeGoalFromTool`。
3. `complete` + evaluator `blocked` → paused，`blocker_key` 出现在 result。
4. evaluator 超时 / 坏 JSON → continue，永不 complete。
5. `looksLikeFalseCompletion(snapshot)`：`all green` 且无成功验证 → true；有 `bun test` 成功 → false；nomination=`nominated` → false。失败测试不算验证。
6. 同 turn 二次 `nominateComplete` 共享 nominationId；陈旧 revision 的 `applyNominationResult` 返回 `stale` 且不改 status。
7. drop 取消 in-flight AbortController；`recoverPendingVerification` 清 pending 且不结案。
8. grok 默认 overlay **不含** `Prefer numbered steps`；`goal.grokOverlayUnload=false` 恢复该句。
9. `goal.hostGate.enabled=false` → `complete` 直接结案（回滚合同）。

集成：`goal-mode-integration.test.ts` 证明工具 `complete` 只提名；用户 `/goal complete` 才退出 goal mode。

`bun check` + 上述 focused tests。不跑全量 `cargo` / 全仓 test。

## 7. 关键决策摘要

- 完成权收回主机：确定性 host gate 拒绝，用户 `/goal complete` 才结案。
- 同模型 evaluator 只 advisory；`candidate_complete` 永不映射为 complete。
- 假完成消费结构化 settle snapshot，经 hidden-next-turn 注入，不平行 timer。
- 提名带 `{goalId, goalRevision, nominationId, turnId, generation}` compare-and-set；取消与恢复语义明确。
- 闸门对所有 goal 会话生效；numbered 减负只打 grok overlay，可独立回滚。
- 长跑纪律只进 goal 激活/续跑模板。
- 只读 verifier + 反 ratchet 是同一设计的 v1.1，不作为 v1 完成定义。

## 8. Handoff

### 8.1 同会话继续

直接执行 $design-review 或 /design-review

### 8.2 新会话恢复 prompt

```text
请阅读设计文档 docs/superpowers/specs/2026-08-27-goal-host-completion-and-grok-unload-design.md，
使用 $design-review（或 /design-review）对该方案进行评审；若文档包含根因分析，
请一并分析根因判断、证据与设计方案是否正确、合理，以及两者是否一致。
```
