# Facts Brief: 近期会话质量 / 无效上下文 / 并行与长任务耗时

- Date: 2026-08-26
- Corpus: `~/.omp/agent/sessions`，父会话文件名日期 `2026-08-19`–`2026-08-26`
- 本 brief 只记录已解析事实。推断标 `[INFERENCE]`。未知标 `[未知]`。

## 0. 与今日已落地设计的边界

`docs/research/2026-08-26-agent-output-quality-and-latency-optimization.md`（及同日 implementation / design-review）已经覆盖：empty-stop fallback、sloppy fail-closed、receipt→outcome join、prompt lint、compaction fidelity、默认关闭的 provider-health / auto-thinking 信号。P3 / relevance packing / memory gate 因本地数据门未满足保持关闭。

本 brief **不重复**那些代码缺陷。本轮问题来自同一用户近期真实会话的行为与编排：任务完成质量、重复读 skill/文件、并行 subagent 与长等待。

## 1. 语料规模

| 项 | 值 |
|---|---|
| 父会话 | 97 |
| 子 jsonl | 247（depth 3: 242，depth 4: 5） |
| 父体积 | 727.14 MB |
| 子体积 | 471.75 MB（近期 child 解析 464.92 MB） |
| 父 assistant 轮 | 13,741 |
| 子 assistant 轮 | 12,415 |
| 父 `task` 调用 | 160（items 257） |
| 父 `hub wait` | 885（近期精确口径 874） |
| 子 `hub wait` | 125 |
| 子 `task` | 2（子代理几乎不再扇出） |
| 有子代理的父会话 | 51 / 97；fanout p90=10，max=20 |
| compaction 事件 | 44，分布在 23 / 97 父会话 |

按项目体积（父+子）：`sr_report` 27 会话 638 MB；`starrocks-oteam-starrocks` 9 / 166 MB；`oh-my-pi` 16 / 104 MB。

模型（父 assistant）：`grok-4.6` 7567，`gpt-5.6-sol` 6174。oh-my-pi 子集：`grok-4.6` 1282，`gpt-5.6-sol` 265。

## 2. 工具与读放大

父会话工具次数：`read` 16427，`grep` 4145，`bash` 4134，`hub` 1722，`edit` 1329，`todo` 1307，`glob` 1119，`eval` 850，`write` 427，`task` 160。

近期父会话 `read` 精算（15,341 次）：

- 完全相同 `path` 字符串重复：2,742（17.87%）
- 同一文件不同 selector 再读：11,989（78.15%）——多数是分段 `read path:start-end`，**不能**直接当浪费
- 带 selector 的 read：10,626
- `skill://` 或 `SKILL.md`：1,211
- `artifact://` 357，`history://` 229

skill 口径拆开后（父会话）：

- `skill://` 合计 698 次 / 78 会话
- 文件系统 `**/SKILL.md` 合计 514 次 / 40 会话
- 同时用 URI 和文件路径读 skill 的会话：存在（mixed）
- 同一会话同一 skill 读 ≥2 次：169 条 (session, skill) 对

`skill://` 热词（次数 / 会话数）：

| 次数 | 会话 | 路径 |
|---:|---:|---|
| 110 | 47 | `skill://engineering-flow` |
| 92 | 42 | `skill://ponytail` |
| 90 | 28 | `skill://design-brainstorm` |
| 81 | 40 | `skill://code-review` |
| 55 | 39 | `skill://shadow-informed-review` |
| 32 | 20 | `skill://subagent-grok` |
| 32 | 31 | `skill://adaptive-delivery` |
| 31 | 26 | `skill://tacit-knowledge` |
| 25 | 21 | `skill://aegis-routing` |
| 25 | 17 | `skill://diagnosing-bugs` |

文件系统 `SKILL.md` 热词：`design-brainstorm` 88/15，`subagent-grok` 67/9，`code-review` 67/14，`ponytail` 53/9，`subagent-sol` 38/5，`using-aegis` 34/17。

同会话重读峰值（≥15）：`file:design-brainstorm` 16 次、15 次；`skill://ponytail` 15；`file:code-review` 15；`skill://engineering-flow` 13×2 会话。

系统提示已经写了「skill/rule 正文已在 transcript 则不要重读」：

- `packages/coding-agent/src/prompts/system/custom-system-prompt.md` 第 33、49 行
- `packages/coding-agent/src/prompts/system/system-prompt.md` 第 32 行

`skill://` handler `immutable = true`（`packages/coding-agent/src/internal-urls/skill-protocol.ts`）只禁止给目录/不可变资源打 hashline 锚点，**没有**「已读则返回 stub」的运行时短路。重读会再次把 SKILL.md 正文作为 `toolResult` 注入。

`skill://adaptive-delivery` 在本仓库 **不是** skill。`rule://adaptive-delivery` 才存在。近期父会话该 URI 报错 32 次：`Unknown skill: adaptive-delivery`（`skill-protocol.ts` 抛错）。

## 3. Token / 上下文税

父会话 usage 合计：`input` 106,270,919；`cacheRead` 1,783,275,264；`output` 9,775,576；`reasoningTokens` 6,202,104。cache 远大于 input，说明前缀稳定时命中缓存；**不能**据此说「没有浪费」——重读 skill 仍占新 toolResult，并在 miss 时付全量。

`contextSnapshot`：短轮 non-message 占比可以 >80%（system/tool schema 固定税）。长轮 prompt 可到 1e5–4e5。抽样长会话 `-tencent-sr_report/2026-08-24T07-37-55-988Z_...`：AS#1 input 23,702；AS#40 input 119,752（约 21 分钟墙钟）。

compaction 很少（44/97 会话中的 23 个），长会话主要靠 cache + 全量历史，而不是摘要。

自定义事件（父，近期）：

| 类型 | 次数 | 是否进入 LLM |
|---|---:|---|
| `tool_optimization_receipt` | 10,649 | 否。jsonl 为 `{type, customType, data}`，无 `content`。`convertOne` 对 `custom` 在 `!isCustomMessageContent(m.content)` 时返回 `[]`（`session/messages.ts`） |
| `model-policy-opaque-state-receipt-v1` | 6,231 | 否，同上 |
| `mid-run-todo-nudge` | 142 | `[INFERENCE]` 若有 content 则会进模型；未逐条拆 content |
| `skill-prompt` | 50 | 用户触发的 skill 展开，会进模型 |
| `async-result` | 85 | 子代理结果投递 |

因此「receipt 次数巨大」**不是**模型 token 浪费。真正进模型的重复物是：skill/rule 正文、分段文件、tool 输出、system 固定税。

无可见 text 的 toolUse 轮：7,222 / 13,153（约 55%）。这是工具循环形态，不是用户可见答案。

## 4. 并行 subagent 与等待

`task` batch 尺寸：`1`: 91，`2`: 43，`3`: 13，`4`: 5，`5`: 2。**59% 的 spawn 是单元素 batch**。

`hub wait` 形态：bare 371，`ids` 268，`from` 235。同一 assistant 轮里 `task`+`wait` 共批：0。连续 ≥3 次 wait 轮：74 段，最长 12。

`task.md` 写明：结果会 auto-deliver；settled `hub jobs`/`hub wait` 快照即交付，不应再等一份 `async-result`。系统提示另有「Spawn-one-then-wait is a bug」。观测与条文相反：父代理大量单独 spawn，然后用连续 `hub wait` 轮询。

子代理墙钟合计 7,613 分钟。按文件名分类：

| 类 | n | wall p50 | wall p90 | 备注 |
|---|---:|---:|---:|---|
| review/gate | 137 | 高于 scout | 单会话可到数十分钟 | `SpecAxis`/`StandardsAxis`/`SolSpec` 常见 32–63 min、125–192 assistant 轮 |
| scout/audit | 43 | 较短 | | |
| design/author | 27 | | | |
| implement | 9 | | | |
| other | 30 | | | |

极端：`SolDesignReview.jsonl` wall 887.6 min、212 assistant 轮、`gpt-5.6-sol`、input max 174k。`[INFERENCE]` 含 parked/idle 时间，不是纯推理 15 小时。

父会话 fanout 高峰：sr_report 08-24 一会话 20 个 child；另一会话 15；starrocks 审计会话 13。子代理几乎不嵌套 `task`（2 次），爆炸发生在父层。

oh-my-pi 子集：16 父会话，task 10，wait 46，children 17。工具仍以 `read` 2615 / `grep` 833 为主。

## 5. 质量与返工信号

用户消息关键词（父，近期，可重叠）：`review` 49，`继续` 41，`失败` 27，`重新` 25，`评审` 24，`Gate` 17，`还是` 14，`NEEDS_REVISION` 7，`重跑` 6，`未完成` 3。

stopReason：`toolUse` 12,663，`stop` 350，`aborted` 82，`error` 58。

`isError` toolResult 前缀（父）：

| n | 前缀 |
|---:|---|
| 69 | `read` skipped pending peer interrupt |
| 45 | `hub` skipped pending peer interrupt |
| 37 | `bash` skipped pending peer interrupt |
| 32 | `Unknown skill: adaptive-delivery` |
| 23 | tool call not executed because provider stream ended |
| 20 | bash Traceback |
| 8 | `Path '.../code-review/SKILL.md' not found` |
| 7 | grep timed out after 30s |
| 5 | `bun check: failed` |
| 4 | `xd://browser` invalid args |
| 4+4 | curl timeout 15s/20s |

`[INFERENCE]` interrupt skip 是用户插入或并行冲突，造成空转 tool 税，不一定是逻辑错误。`Unknown skill: adaptive-delivery` 与缺失的 claude skill 路径是确定性错误，且会诱发改读文件系统 SKILL.md。

## 6. 定性抽样（合同级）

### 6.1 简单问题被 skill 流程拖成超长会话

`-tencent-oh-my-pi/2026-08-23T12-03-46-720Z_...`

- 用户：全局规则默认实现是否使用 ponytail
- 墙钟 157.9 min，children 0，task 0
- 同会话 `file:design-brainstorm` 15 次、`file:subagent-grok` 11、`file:ponytail` 11、`file:design-implement` 9

这是「完成质量尚可、上下文与时延不可接受」的最小反例：无并行，纯主会话把 lifecycle skill 正文反复读完。

### 6.2 设计/评审编排把父会话打成 wait 循环

`-tencent-sr_report/2026-08-24T07-37-55-988Z_...`

- 12 个 user 轮，542 assistant 轮，16 次 task，93 次 wait，墙钟 1386 min，20 个 child
- 开场并行读 `rule://adaptive-delivery`（对）和 `skill://diagnosing-bugs` / `skill://aegis-routing`，随后文件系统 Aegis SKILL.md
- skill 54 次 / unique 9；`skill://` 计数器里该会话还有 35 次未展开短名
- AS#360 起多轮只有 `hub:wait`（「等 Grok 写完设计」）
- 同一 `routine_load_errmsg_history.py` 在后期仍被反复分段 read

### 6.3 今日 oh-my-pi 质量优化会话仍重复读 skill

`-tencent-oh-my-pi/2026-08-26T01-57-52-858Z_...` 与 `02-59-40-...`：实现/双轴 review 仍先 `read skill://code-review` + `skill://shadow-informed-review`，即使 system 已有 progressive-loading 条文。子会话 `SpecReviewer` / `StandardsReviewer` / `IndependentQualityVerify` 各自再读一遍。

### 6.4 评审子代理本身是长任务

多个 `SpecAxis`/`SolSpec`/`StandardsReview`：30–60 min、130–190 轮、input 75–130k。双轴并行没有缩短单轴内部的全量读代码。父层 `hub wait` 被最慢轴卡住。

## 7. 现有 owner（禁止重建）

| 能力 | Owner | 本轮事实 |
|---|---|---|
| skill/rule 渐进加载条文 | `prompts/system/*.md` | 仅 prompt；无运行时 |
| `skill://` 解析 | `internal-urls/skill-protocol.ts` | unknown → throw；immutable 不解重读 |
| `rule://` | 对应 protocol | `adaptive-delivery` 是 rule 不是 skill |
| task 并行合同 | `prompts/tools/task.md` | auto-deliver；禁止 spawn-one-then-wait（system prompt） |
| hub wait | `tools/hub/index.ts` | bare wait 看所有 running jobs；可 `from`/`ids`/`timeoutMs`；idle peer 不满足 bare wait（`jobs.ts`） |
| 普通会话 read dedupe / artifact | `workflow/context-ledger.ts`、`agent-session.ts` `#dedupeOrdinaryReadResult` | 已存在；不阻止模型再发 ranged read |
| tool 输出截断 receipt | `workflow/optimization-receipt.ts` | 落盘 custom data，不进 LLM |
| 今早质量/耗时 P0–P2 | `docs/research/2026-08-26-agent-output-quality-and-latency-optimization.md` §13 | 已实现；本设计不得重做 |
| 双轴 code-review | `skill://code-review` | 两个只读 subagent + shadow fragment |
| 设计 pair | `skill://design-brainstorm` | grok author → sol reviewer |

## 8. 已确认 vs 未确认

已确认：

1. 无效上下文的主因是 **skill/rule 正文重读** 和 **长会话全量历史**，不是 optimization receipt。
2. 运行时没有 skill 去重；prompt 禁令被系统性地违反。
3. `skill://adaptive-delivery` 名不副实，稳定失败。
4. 并行耗时的主因是 **父层单 spawn + 连续 wait**，以及 **评审/Gate 子代理 30–60+ min 的全量阅读**，不是子代理再扇出。
5. 59% task batch 大小为 1，与「真独立才并行、一次 batch」条文冲突。
6. 今早设计已覆盖失败路径/观测，**没有**覆盖本 brief 的行为瓶颈。

未确认 / 不要当事实：

1. 887 min 的 SolDesignReview 有多少是 idle parked。`[未知]` 需对照 session_exit / 最后一条 assistant 时间。
2. `mid-run-todo-nudge` 是否进入 LLM。`[未知]`
3. 文件级 78% 再读里，多少是合理分段、多少是忘了已读。`[未知]`；精确重复 17.9% 才是硬浪费下界。
4. 用户 `NEEDS_REVISION`/`重跑` 有多少是设计质量问题、多少是 Gate 流程过重。`[INFERENCE]` 两者都有。
5. cacheRead 1.78B 是否含跨会话；本解析只加总父 assistant usage 字段。

## 9. 本设计必须回答的问题

1. 如何让「skill/rule 已在 transcript 则不重读」从 prompt 变成可观测合同（失败时短结果，而不是再注入全文）？
2. 如何消掉 `skill://adaptive-delivery` 这类稳定 misroute，而不鼓励模型改扫文件系统 SKILL.md？
3. 如何减少单元素 `task` + 连续 `hub wait`，让父代理在子代理运行时继续自己的工作？
4. 如何限制 review/Gate 子代理的输入宽度和墙钟，而不削弱独立他审？
5. 哪些能力复用今早 P0–P2 / ContextLedger，哪些明确非目标（relevance packing、第二套 scheduler、自动跳过失败工具）？
