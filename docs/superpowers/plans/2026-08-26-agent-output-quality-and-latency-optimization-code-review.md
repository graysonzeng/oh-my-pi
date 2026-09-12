# Code Review: Agent 输出质量与任务耗时优化

- Date: 2026-08-26
- Design Doc: `docs/research/2026-08-26-agent-output-quality-and-latency-optimization.md`
- Review Doc: `docs/superpowers/plans/2026-08-26-agent-output-quality-and-latency-optimization-design-review.md`
- Implementation Doc: `docs/superpowers/plans/2026-08-26-agent-output-quality-and-latency-optimization-implementation.md`
- Reviewer: 主会话只读审查；5 个 scout 分片（empty-stop、sloppy、outcome-join/health、prompt/error/thinking、ownership/isolation）交叉核对
- 范围: `workflow` @ `1831482bb51d32213d9b69ad2e81d87bb5c518da`，相对 `15b939d940..HEAD`（feat `c7ac8a0f22` + 5 个 follow-up fix）；工作树干净
- 模板源: findings-format.md（code-review 变体）

## 1. 整体结论

- **NEEDS_REVISION**
- 一句话结论：P0 empty-stop fallback、CJK/Grok thinking-loop、prompt lint、compaction fidelity、默认关闭的 provider-health breaker 已落地且有回归锁；但 sloppy 在删掉 closest-block 后仍留下 `neighborsDuplicate` 自动落盘，会删除并非副本的唯一邻行，P0 fail-closed 未完成。

## 2. 设计一致性

设计评审把修订真源写成「设计文档 §13」。**该节不存在**：研究文档止于 §12（496 行）。本轮以设计评审 §4 + 实现文档 §4–§5 为执行合同，对照代码。

| 合同 | 实现 | 结果 |
|---|---|---|
| P0 #9523 capped empty stop 进入既有 model fallback | `turn-recovery.ts:705-767`；测试 `agent-session-retry-fallback.test.ts:5452-5556`（含 billed empty） | 一致。`retry.enabled && retry.modelFallback` 时 `#tryRetryModelFallback`；同模型先 3 次 empty retry 再切链 |
| P0 sloppy closest-block fail-closed | 删除 Levenshtein closest-block（`sloppy.ts` −71 行）；测试 `fails closed on a closest near-match block` | **部分**。closest-block 已删；残留 `neighborsDuplicate`（`sloppy.ts:1207-1220`）仍自动写 |
| P0 最小 receipt→outcome join，不新增 receipt kind | `buildOrdinarySessionObservationJoin` 展开进既有 `latency_rollout_observation` | **部分**。普通会话 dispose 可附 join；verifier 恒 `unknown`；workflow 终态 observation 不带 join；`userCorrectionCount` 无来源 |
| P0 ordinary metrics：wall / tool / 重复 read·grep / fallback / 用户纠正 | join 的 `workMetrics` | **部分**。前四项有；`userCorrectionCount` 调用点不传，恒 `null` |
| P0 #9747 in-flight ownership | `prompts/tools/task.md` overlap 段：子 Agent 目标文件完成/取消前不得覆盖 | 一致于 **P0-policy**。无 runtime 文件锁。`worktree.ts` 本轮未改 |
| P0 #9748 rewind provenance | 既有 `rewind-report` + `#rewoundToolResultIds` | 一致于 verifier/gate：本轮未改 rewind runtime |
| P1 prompt section metadata + 确定性 linter | `prompt-assembly.ts:149-258`；lint 失败 `assemblePrompt` 抛错 | 一致，fail-closed |
| P1 structured ToolError / ValidationError | `agent-loop.ts` 消费 `fieldPath`/`expectedType`/`ToolError.context` | 一致 |
| P1 schema preflight | `wire.ts:646+`；ArkType 路径 `closeDeclaredObjects` | **部分**。raw JSON/TypeBox `toolWireSchema` 不 close；preflight 不强制 `additionalProperties:false` |
| P1 compaction evidence fidelity | `compaction.ts:119-149,1933-1962` | 一致。fail-open，只写 receipt |
| P2 provider-health TTL breaker，默认关 | `arms.ts:113` default false；`availability-preflight.ts:111-118` arm 对象缺省则 fail-open | 一致。2 次 retryable + 60s TTL。介入的非 retryable 错误不重置计数 |
| P2 adaptive-thinking 信号，默认关，不新增 classifier 调用 | `model-controls.ts:625-676` 把 signals 喂进既有 `classifyDifficulty` | 一致 |
| P2 lazy discovery verifier-only | 无重建 | 一致 |
| P3 / relevance / memory | 未实施 | 一致 |
| 不新增 MUST/NEVER 掩盖 runtime bug | `engine.ts:1971` repair 作业多了一句 MUST `noChangesRequired` | 局部偏离；是作业指令不是 runtime 掩盖 |
| Follow-up：billed empty fallback | `turn-recovery.ts:727-738` + 测试 5505 | 一致 |
| Follow-up：CJK 74×4 short-cycle | `thinking-loop.ts:66-69` `EXACT_SHORT_MAX_UNIT=96` | 一致 |
| Follow-up：Grok cumulative reasoning | `openai-completions.ts` snapshot suffix；`gateway-grok-reasoning.test.ts` | 一致 |
| Follow-up：status-line annotated default | `settings-schema.ts:786-789` | 一致 |

未采纳/正确保持关闭：learned router、跨 turn DAG、relevance packing、memory gate、生产实时 3% 熔断。

## 3. Findings

### [HIGH] sloppy: markerless `neighborsDuplicate` 仍会删除唯一邻行

**文件**: `packages/coding-agent/src/edit/sloppy.ts:1171-1220`；`packages/coding-agent/src/edit/sloppy.ts:3229-3259`；实测 `applySloppy`

**问题**: 本轮已删除「同一行数窗口 + Levenshtein 最近块」自动恢复，注释写明 near-match replacement 不受支持。残留路径仍在：`locate()`（含 normalized/fuzzy）命中后，若归一化匹配块与 `before`/`after` 有 ≥8 字符前缀/后缀重叠，就把 markerless desired 文本当 `desiredState` 落盘。`duplicateCollapseSpan` 随后把重叠邻行吞进同一 span。两条**内容不同**的唯一行只要共享 ≥8 字符前缀，陈述较长那一行会删掉较短那一行。恢复 note 仍写 “closest matching block was replaced”，是已删 closest-block 的遗物。

实测：

```
content = "hello world\nhello world extra\n"
input   = "§\nhello world extra"
output  = "hello world extra\n"   // 删除了唯一的 "hello world"
```

近匹配 / 否定条件 / import 近匹配仍 throw `needs »`。真副本 `run(alpha);\nrun(alpha);` 的 collapse 仍按设计工作。replace/hashline 唯一性合同未改。

**影响**: P0 fail-closed 未闭合。sloppy 模型（#9717 同类）陈述一段已存在的较长文本时，可静默删掉共享前缀的另一行，而不是 `needs »`。现有测试只锁「近匹配 throw」和「真副本 collapse」，锁不住这条前缀邻行删除。

**建议**: `neighborsDuplicate` 只允许**整段归一化相等**的相邻副本（与 `run(alpha)` 测试同形），禁止真前缀/后缀重叠。恢复 note 去掉 “closest matching block”。加回归：上述 `hello world` / `hello world extra` 必须 throw 且 bytes 不变。

### [MEDIUM] observability: outcome join 没有最终 verifier，workflow 终态不带 join

**文件**: `packages/coding-agent/src/session/agent-session.ts:5657-5766`；`packages/coding-agent/src/latency/rollout-cohort.ts:172-205`；`packages/coding-agent/src/workflow/engine.ts:1136-1150`；`packages/coding-agent/test/latency/rollout-cohort.test.ts:38-98`

**问题**: join 复用了既有 `latency_rollout_observation`，这点符合「不新增 receipt kind」。但：

1. `#ordinarySessionObservationJoin` 不传 `verifierSource`/`verifierStatus`，每条记录都是 `{ source: "unknown", status: "unknown" }`。测试把这当成合同，而不是临时缺口。
2. `userCorrectionCount` 字段存在，session 调用点不传，恒 `null`。P0 指标表里的「用户纠正」没有来源。
3. workflow `#evaluateLatencyRolloutAtTerminal` 的 observation 不展开 `ordinaryJoin`，也没有 attempt-evidence 外键。
4. `#evaluateLatencyRolloutAtSessionEnd` 在 `if (!this.#latencyArmSnapshot) return` 后才写；dispose **不** `#ensureLatencyArmSnapshot()`。从未碰 arm API 的短会话零观测。

实现文档写「完成 receipt/outcome join」。设计 P0 要求关联到最终 outcome。当前是 attribution + work metrics 片段，outcome 仍显式 unknown。P3 数据门因此仍为 0，与实现文档自述一致，但不能再把 join 标成完成。

**影响**: 普通/workflow 观测无法支撑 P3，也无法按 verifier pass/fail 做质量门。用户纠正永远缺测。短会话可能完全没有 ordinary 观测。

**建议**: 有明确 session_stop/extension 结果时写入 `passed`/`failed`，否则保持 `unknown`（不要把 dispose 伪造成 pass）。接上已有 workflow `userCorrections` 或显式文档化「本轮不采集」。workflow 终态 observation 展开同一 join。dispose 路径先 `#ensureLatencyArmSnapshot()` 再写，或在 session 启动 freeze。

### [MEDIUM] provider-health: 非 retryable 错误不打断 consecutive retryable 计数

**文件**: `packages/coding-agent/src/latency/provider-health-breaker.ts:91-120`；`packages/coding-agent/test/workflow/provider-health-breaker.test.ts:127-159`

**问题**: `recordFailure` 只对 `rate_limit|timeout|provider_transient` 加计数；`available` 才清零。介入的 `authentication` 等 hard error 既不加也不清。序列 `timeout → authentication → timeout` 会把 `consecutiveFailures` 打到 2 并 open 60s。测试只断言连续两次 auth 不 open，没有覆盖夹心 hard error。Arm 默认关闭。

**影响**: arm 打开后，一次 timeout + 一次无关 auth + 再一次 timeout 就会跳过该 profile 的物理 probe 60s。与「两次**连续** retryable failure」字面不符。

**建议**: 非 retryable 的 `unavailable` 清零 consecutive 计数（仍不 trip）。补夹心 hard-error 测试。

### [MEDIUM] schema: raw JSON/TypeBox 工具路径不 close declared objects

**文件**: `packages/ai/src/utils/schema/wire.ts:586-610,480-496,646-668`

**问题**: `arkToWireSchema` 调用 `closeDeclaredObjects`（声明了 `properties` 且未设 `additionalProperties`/`patternProperties` 的 object 设为 `false`）。`toolWireSchema` 的 raw/TypeBox 分支只 `upgradeJsonSchemaTo202012` + `postProcessJsonSchema`。`preflightToolWireSchema` 检查可序列化、根类型、`properties`/`required` 形状，不强制闭包。omptype 新工具（如 workflow `"+": "reject"`）是闭的；遗留 raw schema 仍接受未声明键。

**影响**: 「omptype cutover 后拒绝多余 key」只覆盖 ArkType 作者。raw schema 工具仍可能把额外参数当成功。

**建议**: raw 路径同样 `closeDeclaredObjects`，或在 preflight 对声明了 `properties` 的 object 要求显式 `additionalProperties`。加一条 Ark vs raw 对照测试。

### [MEDIUM] 重复实现: coding-agent 又写了一套 ZIP/tar

**文件**: `packages/coding-agent/src/utils/zip.ts`（本轮 +1106）；对照 `packages/utils/src/ar/zip.ts`；`packages/coding-agent/src/tools/read.ts:63`；`packages/coding-agent/src/tools/grep.ts` 改为 `@oh-my-pi/pi-utils/ar`

**问题**: 仓库已有 `@oh-my-pi/pi-utils/ar`（markit、fetch、debug bundle、grep 都走它）。本轮 `read.ts` 改从本地 `utils/zip.ts` 读档。该文件自称「唯一 ZIP/`Bun.Archive` 边界」，与事实相反。`..` 路径会 drop、成员 64MB、tar 256MB，未见 zip-slip；本轮没有针对该模块的测试（`tools.test.ts` 打的是 `pi-utils/ar`）。违反 AGENTS.md「同一能力两套实现是 bug」。

**影响**: 路径规范化、symlink、ZIP64、压缩算法两套分叉。read 与 grep 对同一 archive 成员可能一个能打开一个不能。

**建议**: `read.ts` 切到 `@oh-my-pi/pi-utils/ar`；删除或把 `coding-agent/src/utils/zip.ts` 收成薄封装。不要保留第二套 framing。

### [MEDIUM] 文档: 修订真源 §13 未写回设计文档

**文件**: `docs/research/2026-08-26-agent-output-quality-and-latency-optimization.md`（止于 §12）；`docs/superpowers/plans/2026-08-26-agent-output-quality-and-latency-optimization-design-review.md:6`；implementation.md:4

**问题**: 设计评审与实现文档都把 §13 当作 P0-runtime/policy/RCA、owner/扩展点/verifier 表的真源。文件里没有 §13。执行合同只散落在评审/实现 markdown。

**影响**: 后续修复/复审会对着一个不存在的章节。P0 拆分边界无法从设计文档单独复核。

**建议**: 把评审 §4 的执行合同写进设计文档 §13，或改两处引用，指向实际承载合同的实现文档章节。

### [LOW] prompt: repair 作业新增 MUST noChangesRequired

**文件**: `packages/coding-agent/src/workflow/engine.ts:1967-1972`

**问题**: 设计写「不通过增加 MUST/NEVER 掩盖确定性 runtime bug」。这里是 completion gate `unresolved_items_open` 时给 repair 的作业指令，不是用 prompt 盖 runtime bug。

**影响**: 低。可能把模型逼进 `noChangesRequired=true`，若 gate 误判会跳过该做的 patch。

**建议**: 保持作业级约束，但不要扩成全局 MUST。确认 `#requiresRepairNoOpDeclaration` 的谓词足够窄。

### [LOW] percentile 公共 helper 不校验 NaN/未排序

**文件**: `packages/coding-agent/src/latency/rollout-cohort.ts:296-301`

**问题**: 约定输入已排序有限数。NaN 的 rank 为 NaN，`sorted[NaN]` 为 `undefined`。breaker snapshot 已 filter finite；公开 helper 与部分聚合路径没有。

**影响**: 默认关闭的 observational p95；污染输入会得到 `undefined` 而不是 throw。

**建议**: helper 内丢掉非有限值，或在 JSDoc/类型上标明前置条件并保持调用点 filter。

## 4. 明确非本轮问题（scout 已排除）

- `ensureIsolation` 先 `fs.rm(baseDir)` 再写 owner marker（`task/worktree.ts:464-471`）是既有沙箱生命周期，本轮 diff 未改该文件。#9747 本轮按设计落在 prompt ownership，不是 runtime lock。不要当作本轮回归修。
- Empty-stop fallback 集成测试**存在**：`agent-session-retry-fallback.test.ts:5452`（#9523）与 `:5505`（billed dropped-content）。
- CJK 74 字 ×4 与 Grok cumulative snapshot 有测试锁。
- session_stop 隐藏 continuation 与 DSH headless gate 分离（`agent-session.ts:7090-7121`），符合「continuation 不走 DSH headless」。

## 5. 验证证据

本轮只读，未跑全量测试。下列为对照源码与针对性探测：

- `bun --eval` 调用 `applySloppy`：closest/import 近匹配 throw `needs »`；`hello world` / `hello world extra` **写入并删除邻行**；`run(alpha)` 真副本 collapse 成功。
- `#9523` / billed empty 测试文本与断言已读（4 次 primary + 1 次 fallback，交付 fallback 文本）。
- `lintPromptSections` → `assemblePrompt` throw 已读。
- compaction fidelity fail-open 已读。
- provider-health default false、preflight skip open profile 已读。

实现文档声称 focused 470/470、三包 typecheck、smoke 通过；本次未复跑，不作为本审查的通过证据。

## 6. 评审结论

**NEEDS_REVISION**

无 CRITICAL。HIGH-1 必须在宣称 P0 sloppy fail-closed 完成前修复。MEDIUM 项（join 完整性、breaker 连续计数、raw schema 闭包、重复 ZIP、§13 缺失）应在复审前处理或显式降级为已知限制。

## 7. Handoff

**同会话继续**:

直接执行 $fix-implement 或 /fix-implement

**新会话恢复 prompt**:

```
请阅读设计文档 docs/research/2026-08-26-agent-output-quality-and-latency-optimization.md、
评审文档 docs/superpowers/plans/2026-08-26-agent-output-quality-and-latency-optimization-design-review.md、
实现文档 docs/superpowers/plans/2026-08-26-agent-output-quality-and-latency-optimization-implementation.md、
审查文档 docs/superpowers/plans/2026-08-26-agent-output-quality-and-latency-optimization-code-review.md，
以及本次代码变更（workflow @ 1831482bb51d32213d9b69ad2e81d87bb5c518da，相对 15b939d940..HEAD），
使用 $fix-implement（或 /fix-implement）进行方案修复及代码实现。
重点修复 HIGH-1：sloppy markerless `neighborsDuplicate` 仍会按 ≥8 字符相邻前缀/后缀重叠自动落盘，删除并非重复副本的唯一邻行（例如 `hello world` / `hello world extra`）。
```

## 8. 修复记录（2026-08-26）

### 8.1 HIGH-1：已关闭

- 根因确认：markerless desired-state 路径在唯一匹配后仍用 `neighborsDuplicate` 的 ≥8 字符归一化前缀/后缀重叠作为落盘证明；`duplicateCollapseSpan` 再把重叠邻行扩入替换 span，导致内容不同的唯一邻行被删除。
- 修复策略：删除字符级 `neighborsDuplicate` 推断及遗留的 “closest matching block” note；markerless 自动去重只接受行边界完整、归一化相等的相邻前缀/后缀块。两处完整相邻副本的既有 collapse 分支保持不变。
- 回归合同：`hello world\nhello world extra` 与 `hello world extra\nworld extra` 两个方向均必须返回 `needs »`，且 `executeSloppy` 不得改写文件；`run(alpha)` 真副本仍 collapse。
- 变更文件：`packages/coding-agent/src/edit/sloppy.ts`、`packages/coding-agent/src/edit/sloppy.test.ts`。

### 8.2 全量回归中同步修复

- coding-agent 全量测试暴露：自动压缩已安排 agent-level queued continuation、但没有 hidden delivery id 时，公开 `agent_end` 被错误标成 terminal。
- 根因是 `emitAgentEndNotification` 把 `willContinue` 与 `Boolean(deliveryId)` 绑定；delivery id 只服务 hidden scheduler 记账，不是 compaction continuation 是否存在的判据。
- 修复为直接保留调用方的 `willContinue`，仅在 delivery id 存在时执行 hidden scheduler 的 `markNonterminal`/`finalSettle`。对应队列压缩测试恢复为 12/12 通过。
- 变更文件：`packages/coding-agent/src/session/agent-session.ts`。

### 8.3 验证证据

- RED：新增落盘回归后，`bun test packages/coding-agent/src/edit/sloppy.test.ts` 为 172 pass / 1 fail，失败原因为 markerless 重叠操作仍 resolved 而非 reject。
- GREEN：同一文件 173/173 通过；`agent-session-auto-compaction-queue.test.ts` 12/12 通过。
- 行为烟测：前缀、后缀唯一邻行均返回 `Operation 1 needs ».`；`run(alpha)` 真副本输出单份。
- `bunx biome check`（三个修复文件）通过；三个文件 LSP diagnostics 为 `OK`；`bun run check:types` 通过。
- `bun run build` 通过；源码 CLI 与编译后二进制 `--smoke-test` 均为 `smoke-test: ok`。
- coding-agent 全量：943 pass / 1 fail。剩余失败为既有 `codex-mcp-cwd.test.ts` 跨文件全局状态隔离问题；目标文件单独运行 2/2 通过，且实现/测试文件均不在 `15b939d940..HEAD` 变更范围。本轮不扩张到该基线测试隔离问题。
- `bun run check` 仍被包内既有 Biome 诊断阻断；本轮三个修复文件的 targeted Biome check 通过。

### 8.4 剩余风险与结论

- 原审查中的 MEDIUM/LOW 项显式保留为已知限制：outcome join 的 verifier 仍为 unknown、默认关闭的 provider-health breaker 连续计数语义、legacy raw schema 闭包、重复 ZIP/tar 实现、缺失设计 §13、repair prompt 低风险约束与 percentile 输入前置条件。本轮未把这些非 HIGH 项伪装为已修复；P3 与相关行为门仍保持关闭。
- 修复后无未关闭的 CRITICAL/HIGH；P0 sloppy fail-closed 合同已闭合。本轮代码按高优先级修复范围已达到可合并状态，无需额外 handoff。
