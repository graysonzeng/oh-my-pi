# Facts Brief: OMP subagent 墙钟过长（相对 Cursor）

- Date: 2026-08-30
- 本 brief 只记录已解析事实。推断标 `[INFERENCE]`。未知标 `[未知]`。
- 协调者不得在本文件写方案、取舍或推荐。

## 0. 用户请求与范围边界

用户原话要求：根据历史会话分析根因，深度优化 omp 中 subagent 耗时；对照「同样执行 subagent，Cursor 很快且效果好」，OMP 常 30 分钟以上；结合社区及推特反馈，总结并设计完整优化方案。

授权：`design-only`。来源：本次请求是「分析根因并设计完整优化方案」，未授权改代码、改本机 `~/.omp` 配置或发布。

已有相邻设计（本轮不得重做其已覆盖杠杆，除非新语料证明它们未闭合）：

| 文档 | 已覆盖 | 与本轮关系 |
|---|---|---|
| `docs/superpowers/specs/2026-08-26-session-quality-context-latency-design.md` + facts brief | skill 重读、`skill://adaptive-delivery` misroute、单元素 `task` + 连续 `hub wait`、review 路径白名单 + executor 预算 | 预算/30min cap 已部分落地；8/27–30 语料显示 review 墙钟仍高 |
| `docs/superpowers/specs/2026-08-23-harness-quality-token-optimization-design.md` | Grok thinking-loop 门、空停字段名、prompt 复述 | 不解释 20–70min 的 read 循环 |
| `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md` | 长会话模型/TTFT/工具池 A/B | 方向是 ordinary session，不是 Cursor 对照的 subagent 产品合同 |
| `docs/superpowers/specs/2026-08-20-grok-fast-mode-design.md` | xAI Priority / Fast-mode | 本轮不把它当主缺口 |
| `docs/superpowers/specs/2026-08-29-subagent-live-progress-preview-design.md` | detached HUD / hub wait 的 live tool 行 | 只改善「看起来在干活」，不缩短墙钟 |

## 1. 新鲜语料（2026-08-27–2026-08-30）

解析范围：`~/.omp/agent/sessions` 下父会话目录日期 ≥ 2026-08-27 的 jsonl。墙钟 = 该文件首条带 `timestamp` 事件到末条带 `timestamp` 事件。子会话 = 嵌套在父会话目录内的 `*.jsonl`。

| 项 | 值 |
|---|---|
| 父会话 | 39 |
| 子会话 | 82 |
| 子墙钟 p50 / p90 / max | 19.3 / 33.7 / 1163.0 min |
| 子墙钟 ≥20 min / ≥30 min | 37 / 13 |
| 父 `tool_execution_start`：`task` / `hub` | 55 / 404 |

按子文件名分类：

| 类 | n | wall p50 | wall p90 | wall max | assistant p50 | ≥20min | ≥30min |
|---|---:|---:|---:|---:|---:|---:|---:|
| review/gate | 60 | 20.0 | 33.1 | 70.0 | 31 | 30 | 9 |
| scout | 8 | 14.8 | 15.8 | 19.7 | 38 | 0 | 0 |
| design/author | 4 | 41.0 | 1163.0 | 1163.0 | 25 | 2 | 2 |
| implement | 1 | 20.3 | 20.3 | 20.3 | 27 | 1 | 0 |
| other | 9 | 19.1 | 32.3 | 37.2 | 49 | 4 | 2 |

oh-my-pi 子集：子 52，wall p50=20.0，p90=37.2，≥30min=10。

活跃工作 vs parked 墙钟（抽样）：`GrokDesignAuthor.jsonl`（`-tencent-oh-my-pi/2026-08-29T17-22-01-892Z_...`）首末 assistant 跨 1155.7 min、58 轮；相邻 assistant 间隔 ≤10 min 的累计仅 42.7 min；>30 min 间隔 3 次，最大 722.3 min；前 30 min 内 30 轮 assistant。`[INFERENCE]` 该 1163 min 文件墙钟含 keep-alive / parked，不能当 19 小时连续推理。

仍属活跃长任务的已确认例子（墙钟 ≈ 文件跨度，且工具密度高）：

| 文件 | wall | assistant | agent | model | thinking | 主导工具 |
|---|---:|---:|---|---|---|---|
| `GrokStandardsAxis.jsonl` | 70.0 | 63 | subagent-grok | `gateway/grok-4.6:xhigh` | xhigh | read 167, bash 44, grep 27 |
| `GrokSpecAxis.jsonl` | 53.0 | 70 | subagent-grok | `gateway/grok-4.6:xhigh` | xhigh | read 118, bash 48 |
| `SpecReview.jsonl` | 43.6 | 38 | subagent-grok | `gateway/grok-4.6:xhigh` | xhigh | read 82, grep 35 |
| `StandardsAxis.jsonl` | 43.3 | 100 | reviewer | `gateway/gpt-5.6-sol:xhigh` | xhigh | read 146, grep 44, bash 29 |
| `CleanCodeDesignAuthor.jsonl` | 41.0 | 18 | subagent-grok | `gateway/grok-4.6:xhigh` | xhigh | read 54 |
| `CleanCodeDesignGate.jsonl` | 33.1 | 24 | subagent-sol | `gateway/gpt-5.6-sol:xhigh` | xhigh | read 78 |
| `DesignGate.jsonl` | 28.7 | 107 | subagent-sol | `gateway/gpt-5.6-sol:xhigh` | xhigh | read 174, grep 41 |
| `CpampFeatures.jsonl` | 32.3 | 102 | scout | `gateway/deepseek-v4-flash:max` | max | read 69, grep 69, glob 25 |
| `StandardsFlash.jsonl` | 30.4 | 169 | flash-reviewer | `gateway/deepseek-v4-flash:max` | max | bash 151, read 26 |

`GrokStandardsAxis.jsonl` 的 `session_init`（2026-08-30）：`readOnly=false`，`readSummarize=false`，tools=`read,grep,glob,bash,lsp,yield,task,hub`，`spawns=scout`，`systemPrompt` 41186 字符。该文件不在 30 分钟 reviewer 名单内（见 §3）。

## 2. 历史语料（2026-08-19–2026-08-26，已有 brief）

权威：`docs/superpowers/specs/2026-08-26-session-quality-context-latency-facts-brief.md`。本轮只复述与选型仍相关的数字，不重跑。

- 父 97 / 子 247；子墙钟合计 7613 min。
- review/gate 137 个；`SpecAxis` / `StandardsAxis` / `SolSpec` 常见 32–63 min、125–192 assistant 轮。
- `task` batch 尺寸 `1`:91（59% 单元素）；同一 assistant 轮 `task`+`wait` 共批 0；连续 ≥3 次 `hub wait` 74 段。
- 父 `hub wait` 885 vs `task` 160。
- 子 `task` 仅 2：爆炸在父层，不在子再扇出。
- skill 重读：同会话同一 skill ≥2 次 169 对；prompt「已读不重读」无运行时短路（当时）。
- 2026-08-03 更早底座（`docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md`）：689 会话活跃 306.6h；模型生成 174.3h（57%）；TTFT 92.0h（30%）；Sol avg gen 29s/轮、TTFT 16s/轮；Flash/Grok TTFT 约 4s。Terra 无该证据集实测。

## 3. 产品合同（仓库源码，2026-08-30 工作区）

### 3.1 预算与墙钟

- `task.maxRuntimeMs` 默认 `3_600_000`（1h），`0` 关闭。`packages/coding-agent/src/config/settings-schema.ts`。
- Review/Gate 额外天花板 30 min，仅当 agent 名为 `reviewer` / `subagent-sol` / `sol-xhigh-reviewer` / `security-reviewer`。更严的非零用户值仍赢；`0` 保持无限。`packages/coding-agent/src/task/index.ts` `REVIEW_GATE_MAX_RUNTIME_MS` + `resolveTaskMaxRuntimeMs`。测试：`test/task/task-spawn.test.ts`。
- `subagent-grok`、`grok46-reviewer`、`flash-reviewer` **不在**该名单。这与 §1 中 70 / 53 / 43.6 / 35.4 / 30.5 min 的 grok 评审文件一致。
- Reviewer-class soft request budget cap=80；scout/sonic bundled cap=100；默认 `task.softRequestBudget`=200。reviewer 另在墙钟 75% 处 wrap-up。`review-performance.ts`、`settings-schema.ts`。
- CHANGELOG Unreleased 已写：Review/Gate `task` spawn cap 30 min / 80 requests，75% 墙钟 wrap-up。

### 3.2 内置 agent 画像（与「几秒完成」条文冲突）

`packages/coding-agent/src/prompts/agents/scout.md`：

- tools: `read, grep, glob, web_search`
- model: `gateway/deepseek-v4-flash:max` 然后 `gateway/grok-4.6:xhigh`
- `thinking-level: max`，`max-effort: max`，`read-summarize: false`
- 正文写「supposed to finish in a few seconds」，同时又写「MUST keep going until complete」
- 新鲜语料 scout p50=14.8 min（8 个），不是几秒

`packages/coding-agent/src/prompts/agents/reviewer.md`：

- tools 含 `bash, lsp, web_search, ast_grep`
- `spawns: scout`
- `shadow-review: code`（frontmatter 默认开四维）
- model: `gateway/gpt-5.6-sol` → `gateway/claude-opus-5` → `@task`
- `thinking-level: medium`，`max-effort: xhigh`

`packages/coding-agent/src/prompts/agents/task.md`：FULL tools；「MUST keep going until this ticket is closed」写在 `subagent-system-prompt.md`。

`packages/coding-agent/src/prompts/system/subagent-system-prompt.md`：

- 完成协议是 `yield`，不是「最后一条 assistant 文本即结果」
- 「While work remains, you MUST continue with another tool call」
- 「You MUST keep going until this ticket is closed. This matters.」
- 无 worktree 时禁止跑项目级 format/lint/build/test，除非 assignment 明确要求

### 3.3 Shadow review

- `task.shadowReview.enabled` 默认 `true`。
- 合格 spawn（`shadowReview: "code"` 或 agent frontmatter `shadow-review: code`）并行 4 维：`architecture-review` / `grounded-review` / `correctness-review` / `completion-review`。`shadow-mind/types.ts`、`cohort.ts`。
- 每维超时 90s，cohort drain 120s。因此 shadow **上界约 2 min**，不能单独解释 20–70 min 墙钟。
- fail-open：超时/跳过不阻塞主核。

### 3.4 调度 / 隔离 / 进程模型

- `task.batch` 默认 true；`async.enabled` 为 true 时 spawn 为独立后台 agent（idle/park 生命周期），否则调用方阻塞等合并结果。
- `task.maxConcurrency` 默认 32；`task.queuedStartupTimeoutMs` 默认 2 min。
- `task.agentIdleTtlMs` 默认 420_000（7 min）后 park；被消息/resume 复活。park 期间计入文件首末 timestamp 墙钟。
- `task.enableLsp` **schema 默认 false**。
- 子代理默认 in-process 自有 `Agent` 实例（issue #8829 维护者说明）。父处理子 `AgentEvent` 同步走 `pushLoopPhase(subagent:)`（issue #5372 / #3629）。
- `task.maxRecursionDepth` 默认 2。

### 3.5 已落地、与本问题正交或只部分闭合的修复

GitHub / CHANGELOG 已修（社区当「卡住」报，不是「慢但在干活」的主因）：

- #9191 / #9192：墙钟 timer 改写已提交 outcome
- #4957 / #4961：畸形 `yield` 死循环
- #8462 / #8464：terminal yield 后父 TUI 直到 focus 才 ingest
- #3629 / #3631：mid-run compaction O(n²) 导致 TUI 卡
- #5372：9 子代理时 event-loop 楔死（100% CPU）
- #1253 / #1254：Gemini 429 误用 30 min cooldown
- #2081：卡死 subagent + 巨大 bash 输出导致按键滞后
- skill-protocol 已有 `Did you mean rule://X?`（`skill-protocol.ts`）

未在本 brief 重跑：这些修复是否已全部出现在用户当前安装二进制里。`[未知]`

## 4. 本机 effective 配置（dated receipt，不是仓库默认）

Source：`/Users/sheng/.omp/agent/config.yml`，读取于 2026-08-30。只描述当时本机值。

```yaml
async.enabled: true
task.eager: preferred
task.batch: true
task.enableEffort: true
task.enableLsp: true          # schema 默认 false
task.isolation.mode: auto
task.isolation.apply: true
task.agentModelOverrides:
  scout: gateway/deepseek-v4-flash:max
  designer: gateway/grok-4.6:xhigh
  task: gateway/grok-4.6:xhigh
  reviewer: gateway/gpt-5.6-sol:xhigh   # 覆盖 bundled reviewer thinking-level: medium
consult.model: gateway/gpt-5.6-sol:xhigh
modelRoles.default: gateway/grok-4.6:xhigh
```

用户级 agent：

- `~/.omp/agent/agents/subagent-grok.md`：`model: gateway/grok-4.6`，`thinking-level: xhigh`，`max-effort: xhigh`，`readSummarize: false`，tools=`read,grep,glob,bash,lsp`，`spawns: scout`。作者/评审都写「Read every assigned input at full fidelity」。
- `~/.omp/agent/agents/subagent-sol.md`：`model: gateway/gpt-5.6-sol`，`thinking-level: xhigh`，`max-effort: xhigh`，`readSummarize: false`，同样 full fidelity。description 要求 caller 对评审 spawn 传 `shadowReview: "code"`。

用户级 skill 强制的编排（不是仓库默认产品路径）：

- `skill://design-brainstorm`：默认 Grok 4.6 author → GPT-5.6-sol reviewer；禁止 grok 审 grok；评审 spawn 传 `shadowReview: "code"`。
- `skill://code-review` / `skill://subagent-grok` / `skill://subagent-sol`：代码路径一次 batch 派 Standards + Spec 两轴，每轴 `shadowReview: "code"`。

`[INFERENCE]` 用户看到的「OMP subagent 30+ min」大量来自这条 pair + 双轴 + xhigh + full-fidelity read，而不是内置 `scout` 的默认路径。内置 scout 在新鲜语料里也要 15 min 量级，仍远慢于 Cursor Explore 的公开定位。

## 5. Cursor 对照（一级来源）

官方文档 `https://cursor.com/docs/subagents`（2026-08-30 抓取）：

- 子代理自有 context；父只收 **final message**。
- Explore / Bash / Browser 三个内置子代理的设计动机是：中间输出吵、会撑爆主会话；Explore **默认更快模型**，以便「10 路并行搜索的时间约等于主代理做一次搜索」。
- Foreground 阻塞等结果；Background 立刻返回，子代理独立跑。
- 文档明确写：子代理的收益是 **context isolation**，不是速度；简单任务用主代理往往更快。
- 自定义子代理可用 `readonly: true`、`model: inherit`、收窄工具。

本会话宿主（Cursor Task）可观察合同，不是 OMP 源码：

- 专用 `subagent_type`（explore / researcher / implementer / scout_subagent 等）带工具白名单。
- `run_in_background` 时父继续。
- 返回是最终文本，没有 `yield` schema 重试环。
- 无默认 4 维 shadow cohort，无「keep going until this ticket is closed」等价系统段。
- 可选更快模型（文档与宿主均提供 fast / composer 类）。

未验证：Cursor Explore 的实测 p50 墙钟、Cursor 评审类子代理是否存在、Cursor 是否对 reviewer 做 30 min hard cap。`[未知]`

## 6. 社区反馈（GitHub 为主；公开 Twitter 未找到可复核帖）

检索：`oh-my-pi` / `omp` + subagent slow/hang/timeout/30 min；Twitter/X 与 Discord 公开检索 **没有** 可引用的 omp-specific「subagent 30 分钟」帖。社区证据以 GitHub issues 为准。

用户可观察主题（按机制归类，不是按 star 数）：

| 主题 | 代表 | 用户看到的 | 机制（issue 内已写明的） |
|---|---|---|---|
| 子代理已 yield，父还转几分钟 | #8462 | 「子代理做完了还在等」 | post-yield keepalive / idle-flush |
| 畸形 yield 一直重试，父死等 | #4957, #5095 | 「弱模型卡在提交」 | yield schema 与监控未计数错误 |
| 多子代理时 TUI/会话冻结 | #3629, #5372, #2081 | 「一开一堆 subagent 就卡」 | in-process 同步处理 + O(n²) 维护 |
| 流空转 / bash 后楔死 | #8829, #3301 | 「子代理没输出但一直占着」 | waitForIdle 不解、idle timeout 配不好 |
| 429 误等 30 分钟 | #1253 | 字面 30 min cooldown | 与「评审跑满 30 min」不是同一机制，但用户口头都叫 30 分钟 |
| 审批策略卡住 detached 子代理 | #3091 | AFK 后空耗 budget | 无交互 UI 时 prompt 工具不能前进 |
| 父等 detached 看不到在干什么 | #3821 及相关、2026-08-29 live progress 设计 | 「不知道是慢还是死」 | HUD/hub 丢 live tool 字段 |

社区主诉里「卡住 / 楔死 / 提交环」和本机历史里「xhigh reviewer 老实读 80–170 个文件」是两类。完整方案必须分开，不能用修 hang 冒充修慢。

## 7. 对选型有影响的已确认事实（不是方案）

1. 新鲜语料里 review/gate 子代理中位仍约 20 min，p90 约 33 min；用户「30 分钟以上」不是过时印象。
2. 长尾几乎都是 `*:xhigh` 或 `*:max` + `readSummarize: false` + 几十到一百多次 `read`。
3. 30 min 产品天花板按 **agent 名** 生效，覆盖不到本机最常见的 grok 评审身份；这些身份可以跑到 53–70 min。
4. Shadow 4 维有 90s/120s 上界，不是 30 min 主因。
5. 父层仍是 `hub` 远多于 `task`（404 vs 55）；与 8/26 brief 的 wait 形态同型。
6. 内置 scout 条文自称几秒，配置却是 `thinking-level: max` + `MUST keep going until complete`；实测 p50≈15 min。
7. 完成协议是 `yield` + 「必须继续 tool call」；Cursor 官方是 final message。社区 #4957/#5095 证明 yield 形状会把弱模型打进死环。
8. 本机 `task.agentModelOverrides.reviewer=gpt-5.6-sol:xhigh` 覆盖 bundled `thinking-level: medium`。
9. 用户 skill 默认把设计/代码评审派成 grok+sol（或双轴）且每路 shadow；这是用户级编排，不是仓库 `task` 工具的唯一用法。
10. Cursor 官方把 Explore 做成「快模型 + 隔离中间输出 + 父收摘要」；OMP 默认 `task` worker 是全工具 + 关不掉的 keep-going，reviewer 还可再开 shadow 与 scout。
11. 子代理 in-process 共享父 event loop：社区在高扇出时看到的是卡顿/楔死，不是「每个子代理自己慢 30 min」，但会放大用户对「subagent 很慢」的感知。
12. 文件首末墙钟包含 park/keep-alive；验收若用 jsonl 首末跨度，必须同时报 assistant 活跃间隔，否则会把 42 min 活跃报成 19 h。

## 8. 未确认假设

1. Cursor Explore / 同等委派的实测 p50/p90。`[未知]`
2. 若把本机 reviewer 从 `sol:xhigh` 改回 bundled `medium`，质量（Gate 检出、first-pass verified success）会降多少。`[未知]`
3. 8/26 skill stub / wait 提示落地后，8/27–30 的 skill 重读次数是否已下降。本轮未重跑 skill 计数。`[未知]`
4. `CpampFeatures.jsonl` 以 `scout` 身份跑 32 min / 102 轮，是 brief 过宽还是 scout 画像失败。`[未知]` 需读该 assignment。
5. 公开 Twitter 是否存在未索引的 omp subagent 吐槽。本轮检索未命中。`[未知]`
6. 用户「效果很好」的 Cursor 对照，有多少来自父模型（本会话宿主）而不是子代理本身。`[INFERENCE]` Cursor 文档把质量放在父收摘要、子做隔离搜索。

## 9. Canonical owners（禁止新引擎）

| 能力 | Owner |
|---|---|
| task spawn / batch / runtime cap | `packages/coding-agent/src/task/index.ts` |
| 子代理驱动、budget、wall-clock | `packages/coding-agent/src/task/executor.ts` |
| reviewer 名单与 soft budget | `packages/coding-agent/src/task/review-performance.ts` |
| 内置 agent 定义 | `packages/coding-agent/src/prompts/agents/*.md` |
| 子代理系统提示 / yield 协议 | `packages/coding-agent/src/prompts/system/subagent-system-prompt.md` |
| task 工具合同 | `packages/coding-agent/src/prompts/tools/task.md` |
| shadow cohort | `packages/coding-agent/src/shadow-mind/*` |
| settings | `packages/coding-agent/src/config/settings-schema.ts` |
| 隔离 / worktree | `packages/coding-agent/src/task/worktree.ts`, `isolation-runner.ts` |
| 用户级 agent / 模型覆盖 | `~/.omp/agent/agents/*`, `~/.omp/agent/config.yml`（产品方案不得把改用户文件当唯一修复） |
| 用户级设计/评审编排 | `skill://design-brainstorm`, `skill://code-review`, `skill://subagent-grok`, `skill://subagent-sol` |

## 10. 本设计必须回答的问题

1. 30 min 现象的主因是「产品默认把每个 spawn 做成全量 xhigh agent」，还是「用户 skill/overrides 把评审做成双轴 + full-fidelity」，还是两者叠加？方案必须按层拆开，不能只改一层却验收另一层。
2. 怎样在不取消独立他审的前提下，让 **scout/explore 类** 接近 Cursor Explore（快模型、短循环、父收摘要），而不是把 scout 配成 max thinking + keep-going？
3. 怎样让 **review/Gate 类** 的墙钟从常见 20–40 min 降下来，同时保留可复核证据？只加更短 cap 会不会把正在读的 reviewer 砍成超时失败（8/26 已要求 timeout/budget-stop 不得计 PASS）？
4. 30 min cap 的 agent 名单是否应改为能力/角色合同，而不是四个字符串？
5. `yield` + keep-going 是否仍是所有子代理的正确完成协议，还是只留给 worker，scout/review 改为 Cursor 式 final message？
6. 父层 `hub`/`wait` 与 in-process 扇出卡顿，哪些必须进本轮才能让用户感觉「和 Cursor 一样快」，哪些属于已有 8/26 / live-progress / hang 修复的残余？
7. 验收口径如何同时约束：活跃墙钟（不是 parked 首末跨度）、质量非回退（独立他审仍在、timeout 不得假 PASS）、以及社区 hang 类问题不回归。
