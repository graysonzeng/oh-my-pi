# Design: 近期会话质量、无效上下文与并行/长任务耗时

- Date: 2026-08-26
- Status: Accepted; implementation in progress after review Gate NEEDS_REVISION
- Scope: M
- design_author: grok
- design_author_identity: GrokDesigner
- planned_reviewer: GPT-5.6-sol / subagent-sol
- implementation_authorization: P0+P1 after Gate5; user authorized implementation and subsequent review-fix
- authorization_source: 用户要求方案 review 完成后进入实现 P0 + P1。后续评审（方案 Gate NEEDS_REVISION / 实现 Standards+Spec FAIL）已采纳并全量修复。目标提交 a77194b 不是完成态。
- current_handoff: 继续实现/验证本文件推荐方案；旧 design-only「不得实现、不得跑测试」handoff 已 superseded。

## 1. 设计目标和范围

### 1.1 要解决的问题

同一用户近期真实父会话（`~/.omp/agent/sessions`，文件名日期 2026-08-19–2026-08-26；97 个父会话、247 个子 jsonl）同时出现三类可观测瓶颈，且**不是**今早已落地的 P0–P2 代码缺陷：

1. **任务完成质量**：用户侧返工信号集中在评审/Gate（父消息关键词 `review` 49、`评审` 24、`Gate` 17、`NEEDS_REVISION` 7、`重跑` 6），并与超长 review/Gate 子代理、`Unknown skill`、缺失 `SKILL.md` 路径交织。定性上既有「流程过重」也有「设计质量」成分；本设计只处理已证实的编排/上下文杠杆，不把关键词计数当成质量根因。
2. **无效上下文**：主因是 **skill/rule 正文被反复注入** 以及长会话全量历史，不是 optimization receipt。系统提示已写「正文已在 transcript 则不要重读」，但 `skill://` handler 的 `immutable = true` 只禁止 hashline 锚点，**没有**「已读则返回 stub」的运行时短路。本轮只关闭可归因的 skill 全文重注入税；长历史是受控残余（见 §5.7）。
3. **并行 subagent 与长任务耗时**：主因是 **父层单元素 `task` + 连续 `hub wait`**，以及 **review/Gate 子代理 30–60+ min 的全量阅读**；子代理几乎不再扇出（子 `task` 仅 2 次）。

### 1.2 成功标准

用与 facts brief **同一口径** 的会话 jsonl 指标验收（可比窗口：同用户、同解析方法；实现后新会话 vs brief 语料）。方向性达标，不发明 brief 未给出的百分比较值。质量另加一条**离线非回退门**（复用今早 `evaluateBenchmarkQualityGate` 形状，不新建平台、不把 3% 离线门改成 live 熔断器）：

| 目标 | 验收信号（brief 基线） |
|---|---|
| 质量（确定性 misroute） | `Unknown skill: adaptive-delivery` 从 32 次降到 0；`Path '.../code-review/SKILL.md' not found` 不再由 unknown-skill 诱发的文件系统扫读产生；独立他审保留（双轴 / Gate 仍是独立 native spawn） |
| 质量（非回退门，M2） | review/Gate 收窄必须有冻结 replay/paired case + verifier：已知缺陷仍检出、verdict 正确、缺口/timeout/budget-stop **不得计 PASS**。主指标 `first-pass verified success` 相对配对基线不得下降；墙钟下降若伴随该主指标下降，则本杠杆失败。用户关键词 `失败`/`重新`/`NEEDS_REVISION` 只作并排观察，不是门禁 |
| 无效上下文 | 同会话同一 skill 读 ≥2 次的 `(session, skill)` 对从 169 下降；`skill://` 同会话峰值重读（15）下降；**不以**「同一文件不同 selector 78.15%」为 KPI |
| 并行与长任务 | `task` 单元素 batch 占比从 59% 下降（尤其 review/Gate 双轴不得拆成两次 size=1）；连续 ≥3 次 wait 段从 74、最长 12 下降；review/Gate 子代理墙钟从常见 30–60 min / 125–190 轮下降，且必须同时通过上表非回退门 |

### 1.3 本次范围

只动 facts 已证实的四个杠杆，且只复用现有 canonical owner：

1. skill 重读：让 **canonical、完整、模型可见** 的 `skill://` 全文视图通过受限 attested details 进入现有 `#dedupeOrdinaryReadResult` / `#readDedupeArtifacts`。不新建会话 memo。`rule://` 本轮不进 stub（见 §4.2 杠杆 1 / H2 选项 a）。
2. misroute：clean cutover 到 `rule://adaptive-delivery`（修正产生 `skill://adaptive-delivery` 的 prompt/routing owner）；unknown skill **fail-closed**，错误文案加 `Did you mean rule://X?` 且明确不要扫 `SKILL.md`。不做通用 skill→rule alias，不把 alias 扩到 `bash-skill-urls.ts`。
3. 单元素 `task` + 连续 `hub wait`：强化已有 auto-deliver，让父代理在子代理运行时继续工作；对 bare wait 空转给可见提示。
4. review/Gate 子代理过宽：路径白名单仍作**输入宽度**约束；墙钟/轮次预算落到 `task/executor.ts` 现有 request budget + 1.5x forced-yield + grace abort（及已有 `task.maxRuntimeMs` hang abort）。不取消独立他审。brief 不是唯一强制机制。

### 1.4 非目标（摘要）

不重做 2026-08-26 已落地 P0–P2；不上 relevance packing / memory gate / P3 learned router；不自动 skip 失败工具；不建第二套 scheduler、第二套 read memo、或 latency arm taxonomy；不做通用 skill→rule alias。完整清单见 §7。

## 2. 需求与约束

### 2.1 背景

- 语料：父 97 / 子 247；父体积 727.14 MB，子 471.75 MB；父 assistant 13,741 轮，子 12,415 轮。
- 父工具：`read` 16,427，`grep` 4,145，`bash` 4,135 量级，`hub` 1,722，`task` 160（items 257）。近期父 `read` 精算 15,341 次。
- 父 usage：`input` 106,270,919；`cacheRead` 1,783,275,264；`output` 9,775,576。cache 远大于 input，**不能**据此说没有浪费——重读 skill 仍占新 toolResult。
- compaction 很少（44 次事件，分布在 23 / 97 父会话）；长会话主要靠 cache + 全量历史。
- 今早研究/实现 `docs/research/2026-08-26-agent-output-quality-and-latency-optimization.md` 已覆盖 empty-stop fallback、sloppy fail-closed、receipt→outcome join、prompt lint、compaction fidelity、默认关闭的 provider-health / auto-thinking。本设计不得重做那些路径。

### 2.2 必须遵守的约束

- 复用现有 owner，禁止第二引擎：`skill://` → `packages/coding-agent/src/internal-urls/skill-protocol.ts`；`rule://` → `rule-protocol.ts`；read 注入 → `packages/coding-agent/src/tools/read.ts` `#handleInternalUrl`；read-view 去重 → 已有 `latency/read-view-key.ts` + `workflow/context-ledger.ts` + `agent-session.ts` `#dedupeOrdinaryReadResult` / `#readDedupeArtifacts`（**勿新建平行 memo**）；task 运行时预算 → `task/executor.ts` `SOFT_REQUEST_BUDGET` / `resolveSoftRequestBudget` / `BUDGET_STOP_GRACE_REQUESTS` / `driveSessionToYield` + settings `task.softRequestBudget` / `task.softRequestBudgetNotice` / `task.maxRuntimeMs`；task 合同 → `prompts/tools/task.md`；hub wait → `tools/hub/index.ts` / `jobs.ts` / `prompts/tools/hub.md`；双轴 review → `skill://code-review` 与 in-repo `prompts/review-request.md`、`prompts/agents/reviewer.md`；设计 pair → `skill://design-brainstorm`。
- receipt 次数不是 token 浪费：`tool_optimization_receipt` 10,649 次 jsonl 无 `content`；`convertOne` 对 `custom` 在 `!isCustomMessageContent(m.content)` 时返回 `[]`（`session/messages.ts` 约 1256–1257 行）。本设计不改这条路径。
- 文件级 78.15% 再读**不得**当浪费 KPI；硬下界是完全相同 `path` 字符串重复 2,742 次（17.87%）。多数是分段 `read path:start-end`。
- implementation_authorization=design-only：本文只设计，Gate PASS 后停止。

### 2.3 根因分析（影响选型，故需要）

#### 2.3.1 是否需要根因分析

需要。四个杠杆的「改 prompt 还是改运行时 / 改调度还是改 brief」取决于已证实成因；与选型无关的排障细节不写。

#### 2.3.2 已确认事实

1. **无效上下文主因是 skill/rule 正文重读 + 长会话全量历史，不是 receipt。** 父 `skill://` 698 次 / 78 会话，文件系统 `**/SKILL.md` 514 次 / 40 会话；同会话同一 skill ≥2 次 169 对；峰值 `file:design-brainstorm` 16/15、`skill://ponytail` 15、`file:code-review` 15。热词含 `skill://engineering-flow` 110/47、`ponytail` 92/42、`design-brainstorm` 90/28、`code-review` 81/40、`adaptive-delivery` 32/31。
2. **运行时没有 skill 去重；prompt 禁令被系统性违反。** 条文在 `custom-system-prompt.md` 第 33、49 行与 `system-prompt.md` 第 32 行。`SkillProtocolHandler.immutable = true`（`skill-protocol.ts` 第 49 行）只影响 hashline；`#handleInternalUrl` 每次 `internalRouter.resolve` 后把 `resource.content` 全量注入（`read.ts` 约 2465–2493 行），skill 还 `ignoreResultLimits: true`。现有 `#dedupeOrdinaryReadResult` 要求 `readViewKey.eligible`；internal skill/rule 的 details 目前只有 `{ resolvedPath, contentType }`，缺少 `branchOrWorktreeScope` / `providerViewIdentity`，按 `read-view-key.ts` fail-open，**不会**把 skill 正文收成 artifact stub。`#readDedupeArtifacts` 已在 compaction rebase（`agent-session.ts` 1724）与 `auto_compaction_end`（2264）清空。
3. **`rule://` 没有与 skill 对等的完整交付。** `ignoreResultLimits` 仅 `scheme === "skill"`（`read.ts` 2490）。`rule://` 走 `truncateHead`，`resolve()` 的完整 `resource.content` **不等于**模型可见全文。
4. **`skill://adaptive-delivery` 名不副实，稳定失败 32 次。** 本仓库它是 `rule://` 不是 skill；`skill-protocol.ts` 第 62–63 行 `Unknown skill: ${skillName}\nAvailable: ...` 只列 skill。facts 明确：该错误会诱发改读文件系统 `SKILL.md`（另有 8 次 `code-review/SKILL.md` not found）。
5. **并行耗时主因是父层单 spawn + 连续 wait，以及评审子代理全量阅读，不是子代理再扇出。** `task` batch `1`:91、`2`:43、`3`:13、`4`:5、`5`:2 → **59% 单元素**。`hub wait` 形态 bare 371 / `ids` 268 / `from` 235；同一 assistant 轮 `task`+`wait` 共批 **0**；连续 ≥3 次 wait 轮 74 段、最长 12。`task.md` 已写 auto-deliver；`hub.md` 已写「NEVER need to poll」「wait 仅在完全 blocked」；系统提示禁止 spawn-one-then-idle。观测与条文相反。子墙钟合计 7,613 分钟；review/gate 类 137 个，`SpecAxis`/`StandardsAxis`/`SolSpec` 常见 32–63 min、125–192 轮。
6. **reviewer 运行时预算 owner 已存在，但设计若只写 brief 则无法强制。** `SOFT_REQUEST_BUDGET`：`scout`/`sonic` 100，`default` 200（`executor.ts` 112–115）。`resolveSoftRequestBudget` 取 settings `task.softRequestBudget`（默认 200）与 bundled 天花板的更紧者；0 关闭。越预算注入 wrap-up（`task.softRequestBudgetNotice`）；1.5x 调用 `requestBudgetStop` → `driveSessionToYield` 强制 yield；再加 `BUDGET_STOP_GRACE_REQUESTS = 5` 仍不 yield 则 `requestAbort("budget")`（约 129–133、1205–1207、1664–1672 行）。墙钟 `task.maxRuntimeMs` 默认 1h，超时 `requestAbort("timeout")`（1248–1272），`finalizeRunResult` 对 abort/timeout 做 last-assistant salvage（2246–2258）。`ExecutorOptions.maxRuntimeMs` 已是 per-run 覆盖（427–433、2831–2840）。`reviewer` 无 bundled 条目，走 default 200。`task.agentIdleTtlMs`（默认 420_000）是 idle park，不是预算。
7. **今早 P0–P2 没有覆盖本 brief 的行为瓶颈。** 已有离线 quality gate：`evaluateBenchmarkQualityGate`（`workflow/benchmark/runner.ts` 519–521，默认 `maxQualityDropPp: 3`），配对 baseline/optimized，禁止把 3% 改成 live 熔断器。
8. 定性合同：无并行的 oh-my-pi 会话仅因反复读 lifecycle skill 墙钟 157.9 min（`file:design-brainstorm` 15 次）；sr_report 会话 16 次 task / 93 次 wait / 20 child / 1386 min；今日质量优化会话子代理仍各自再读 `skill://code-review` 与 `shadow-informed-review`。

#### 2.3.3 未确认假设（不得当事实、不得当 KPI）

1. `SolDesignReview.jsonl` 墙钟 887.6 min 中有多少是 idle/parked：`[未知]`。
2. `mid-run-todo-nudge` 142 次是否进入 LLM：`[未知]`。
3. 78.15% 不同 selector 再读里多少是合理分段：`[未知]`；硬浪费下界只有 exact path 17.87%。
4. 用户 `NEEDS_REVISION`/`重跑` 里设计质量 vs Gate 过重的比例：`[INFERENCE]` 两者都有，本设计不以此拆分 KPI。
5. `cacheRead` 1.78B 是否含跨会话：本解析只加总父 assistant usage 字段。
6. interrupt skip（read 69 / hub 45 / bash 37）是用户插入或并行冲突：`[INFERENCE]`，本设计不把 skip 当逻辑错误来修。

#### 2.3.4 对设计的影响

| 已确认成因 | 选型含义 |
|---|---|
| prompt 禁令已被系统性违反 | 再堆 MUST/NEVER **不能**达标；今早研究也禁止用更多禁令掩盖确定性 runtime 缺口。必须让完整 skill 全文进入现有 read dedupe，而不是新 memo。 |
| 现有 read-view 去重对 skill/rule fail-open | **不要**重建 ContextLedger，也不要把「给所有文件补 identity」扩成范围；只给不可变、canonical、**已证明完整**的 `skill://` 全文视图补受限 attested details。 |
| `rule://` 可被截断 | 禁止用 `resolve()` 全文 hash 推断 transcript 已含全文。本轮 runtime stub **只**覆盖 canonical `skill://` 全文视图（选项 a）。rule 另做可证明完整交付之前保持 ineligible。 |
| unknown skill 只列 skill、诱发扫盘 | **不要**通用 skill→rule alias。修正产生 `skill://adaptive-delivery` 的 prompt/routing；unknown 保持 fail-closed + `Did you mean rule://X?` + 禁止扫 `SKILL.md`。 |
| auto-deliver 已存在，父代理仍连续 wait | **不要**第二套 scheduler、不要把 wait 改成阻塞到子代理结束；强化提示 + 父代理继续工作。 |
| 双轴并行没有缩短单轴全量读 | **不要**取消独立他审或合并成一个 reviewer；收紧 brief 白名单，预算接 Task executor。 |
| 78% 分段读、receipt 计数都不是浪费 | 禁止做文件级 relevance packing、禁止把 receipt 拉进 LLM。 |
| 长会话全量历史仍在 | 本轮不靠更频繁 compaction 关闭；标为 residual，见 §5.7。 |

## 3. 方案对比

两方案都能覆盖 §1.2 的方向性成功标准。按 conciseness：能达标则选更浅者。

### 方案 A — 现有 owner 上的运行时合同（推荐，更浅）

- **核心思路**：不新建平台。在 read attested details / skill-protocol 错误文案 / hub wait 结果 / review brief **加** Task executor 预算 四条已有链路上，把 facts 已违反的 prompt 合同变成**可观测的短结果**。
- **四个杠杆的落点**（细节只在 §4 展开）：
  1. `read.ts` `#handleInternalUrl`：仅当 canonical `skill://` 全文视图且模型可见结果已证明完整时，写入受限 attested details，让现有 `#dedupeOrdinaryReadResult` 变 eligible；命中返回已有 `[context ref: artifact://… sha256:…]`。不新建 memo。`rule://` 本轮不 attest。
  2. `skill-protocol.ts`：unknown skill 保持 fail-closed；若 `getActiveRules()` 有精确同名则附加 `Did you mean rule://X?`；固定一句不要扫 `SKILL.md`。同时修正 prompt/routing 使 `adaptive-delivery` 走 `rule://`。不 alias。
  3. `hub/index.ts` + `hub.md` / `task.md` / `system-prompt.md`：wait 窗口到期且 job 仍 running 时附加「结果会 auto-deliver，继续自己的工作」；不改调度器、不禁止合法 wait。
  4. `review-request.md` / `reviewer.md` / `task.md` / `system-prompt.md` 负责路径白名单与一次 `tasks[]` 双轴；**预算强制**在 `task/executor.ts` 的全局 `task.softRequestBudget`（默认 200）/ `task.softRequestBudgetNotice` / 1.5x forced-yield / `BUDGET_STOP_GRACE_REQUESTS`。墙钟由 host spawn 传入已有 `ExecutorOptions.maxRuntimeMs`（review/Gate 20 min）；真实 callsite 是 `task/index.ts` `TaskTool.#runSpawn`。不发明不存在的 per-agent request 表键。
- **优点**：owner 都已存在；每杠杆可独立回滚；不碰 compaction 算法 / ledger / receipt；与今早「不要更多 MUST 掩盖 runtime bug」一致；去重复用 compaction 已有 clear。
- **缺点**：不压缩长会话全量历史（compaction 仍少，residual）；不解决 78% 分段读里尚未定性的部分；stub 本轮不覆盖 `rule://` 与「同一 skill 改用文件系统路径」的 mixed 读（mixed 用 prompt + misroute 修复来降，不在 runtime 做路径等价器）。
- **适用前提**：接受「合同级」优化（重读、misroute、wait 空转、review 过宽），而不是新的上下文工程平台。

### 方案 B — 新上下文/调度平台（落败，更深）

- **核心思路**：会话级 skill packer（按相关性只留摘要）、wait 合并器/父进程挂起直到子代理结束、把双轴/Gate 收成单 reviewer 或父进程内审、必要时上 learned skill router。
- **优点**：理论上能同时打长历史税和 wait 墙钟，单一子系统叙事完整。
- **缺点**：第二套引擎，与 ContextLedger / auto-deliver / 独立他审 / 今早非目标直接冲突；relevance packing、memory gate、learned router 本地数据门未满足；取消独立他审会伤害质量目标；实现面远大于四个已证实杠杆。
- **适用前提**：已证明 stub+brief+executor budget 无法降低 169 对重读或 review 30–60 min。**当前没有这条已确认约束。**

### 对比

| 维 | 方案 A（浅） | 方案 B（深） |
|---|---|---|
| 质量 | 保留独立他审；消掉 32 次确定性 misroute；冻结 paired verifier 防止漏报换墙钟 | 合并评审有回归独立他审的风险；packer 误摘要会伤 Gate 证据 |
| token / 无效上下文 | 切断 **完整 skill:// 全文**二次注入（698 次中的重读、169 对）；receipt 仍不进 LLM | 可能再打长历史，但无本地 precision 证据；易把 78% 分段读误当成优化对象 |
| 耗时 | 降 wait 连续段；review 用现有 request budget/forced-yield 收敛轮次 | 或能把父 wait 变成一次阻塞，但父空转改成挂起，且需新调度器 |
| 实现面 | 现有 `read.ts` details / `skill-protocol.ts` 文案 / `hub/*` / `executor.ts` 预算表 / 若干 prompt；可单测 | 新 packer、新 scheduler、新 review 拓扑、新 memo；必碰非目标 |
| 风险 | skill 内容变更用 hash fail-open 缓解；compaction 后 map 已 clear 再注入全文 | 第二引擎、质量门、与今早 P0–P2/ledger 边界冲突 |

### 推荐

**推荐方案 A。** 两方案都能朝 §1.2 达标；A 是更浅落地，且四条杠杆都能映射到仓库里已存在的文件。选 B 所需要的「更浅方案无法满足的已确认约束」不存在。

## 4. 推荐方案详细设计

只展开方案 A。落败方案 B 不写文件级细节。

### 4.1 核心思路

把四条已经写在 prompt 里、但被语料系统性违反的合同，改成 **toolResult 短、可见、可回放**，并且强制机制落在已有 runtime owner：

- 重读已证明完整的 canonical `skill://` 全文 → 现有 `#dedupeOrdinaryReadResult` 的 context-ref stub，不是再注入 SKILL.md 全文，也不是新 memo。
- 把 rule 名错当成 skill → fail-closed + `Did you mean rule://X?`，并修正 prompt 使 `adaptive-delivery` 走 `rule://`；不是跨协议 alias，不是去扫盘。
- 子代理运行中 → 父代理继续工作；wait 空转 → 结果文本提示 auto-deliver，不是新 scheduler。
- 他审 → 更窄 brief 白名单 + 一次 batch；轮次/墙钟由 Task executor 强制；到点 forced-yield / timeout 只能交缺口，不是取消他审。

### 4.2 控制流（四杠杆）

#### 杠杆 1 — 完整 skill 全文进入现有 read dedupe（关闭 H1/H2）

**禁止**在 `AgentSession` 新增与 `#readDedupeArtifacts` 并列的 memo。

```text
read(path=skill://name | rule://name | 其它)
  → #handleInternalUrl
  → protocol.resolve()                     // 仍解析 resource；不得用 resource.content hash 当「transcript 已有全文」
  → renderer（buildInMemoryTextResult）
       skill → ignoreResultLimits: true     // 已有；模型可见 = 选中全文
       rule → ignoreResultLimits: false     // 已有；可能 truncateHead
  → 是否「canonical skill 全文 + 模型可见已证明完整」？
       否 → 不写 attested identity（缺 branch/provider → 现有 fail-open）
       是 → 在 ReadToolDetails 写入受限 attested fields
  → 现有 #optimizeOrdinaryToolResult → #dedupeOrdinaryReadResult
       ineligible / 无 retained / hash 变 / artifact verify 失败 → 返回 visibleText（全文）
       eligible 且 retained.sha256 相同且 artifact 仍在 → 返回已有
         `[context ref: artifact://N sha256:…]`
```

**H2 选项 a（本设计采用，更浅）：** runtime stub **只**覆盖 canonical `skill://` 全文视图。`rule://` 在可证明完整交付（给 rule 开 `ignoreResultLimits`，或截断即 ineligible）之前保持 fail-open，不登记。选项 b（先为 rule 定义完整交付合同再 eligible）列入非目标，避免本轮扩大 renderer 行为。

**「模型可见已证明完整」**（登记前提，缺一不可）：

1. `scheme === "skill"`。
2. canonical 全文视图：无 path/selector，或 `normalizeReadSelector(...) === "full"`（现有 key 已区分 selector；ranged / `raw` 分段 / query 不 attest）。
3. renderer 实际走了 `ignoreResultLimits: true`（skill 已有），因此 `truncation.truncated` 不为 true。
4. 用于 identity 的 digest 是 **模型可见完整结果**（`#dedupeOrdinaryReadResult` 已有的 `originalText` / 可见全文），**不是** `resolve()` 的 `resource.content` 在截断前的 hash。

**受限 attested details**（只在上述前提成立时由 `read.ts` 写入；不给普通文件补 identity，不改 `#dedupeOrdinaryReadResult` 的 fail-open 算法）：

| 字段 | 值 |
|---|---|
| `canonicalSource` | canonical `skill://<name>`（不是文件系统路径，避免与 mixed `**/SKILL.md` 撞 key） |
| `normalizedSelector` | 现有 `normalizeReadSelector`（全文为 `full`） |
| `branchOrWorktreeScope` | 复用已有 `readBranchOrWorktreeScope(session.cwd)`（git commit 或 `worktree:<abs>`） |
| `providerViewIdentity` | `skill-immutable:<name>`（协议 `immutable = true` 的稳定 provider 视图；不把未证明完整的 resolve hash 填这里） |
| `contentOrRevisionIdentity` | 模型可见完整正文的 sha256（与现有 fallback `sha256Hex(originalText)` 一致） |
| `outputMode` | markdown → `converted`，否则 `raw`（已有 details 启发式；禁止 `unknown`） |

key 因此已经区分 selector 与 outputMode（`ReadViewKeyV1` / `read-view-key.ts` 46–73 行）。不同 selector 不会命中全文 stub。

**Compaction / history-rewrite 生命周期（H1 必写不变量）：**

现有 `#readDedupeArtifacts` 会在这些点 `clear()`：

- compaction rebase：`agent-session.ts` 1724（`rebaseAfterCompaction`）
- `auto_compaction_end`：2264
- 额外已有：模型切换 5045（本杠杆不新造 reset，只承认它）

因此：compaction 后原 toolResult **不保证仍模型可见** → map **已经 clear** → 下次读没有 retained → `#dedupeOrdinaryReadResult` fail-open → **再注入全文**。不会出现「memo 仍命中、正文已被 compact 掉」的抑制重载。hash 变化或 `#verifyReadArtifact` 失败同样 fail-open 再注入。不需要第二套 reset 合同。

普通文件 `#dedupeOrdinaryReadResult` 资格算法不变；78% 分段读仍 fail-open。

#### 杠杆 2 — misroute clean cutover（关闭 M1）

**不做**通用 `skill://X` → `rule://X` alias，**不**把 alias 扩到 `bash-skill-urls.ts`（该 helper 只把 `skill://` 解析为 skill 绝对路径，不能返回 rule content）。

```text
产生 skill://adaptive-delivery 的 prompt/routing
  → 改为 rule://adaptive-delivery（canonical RuleProtocolHandler）

skill://X 且 skills 无 X
  → throw（fail-closed）：Unknown skill: X\nAvailable: ...
     若 getActiveRules() 有 name===X → 附加 Did you mean rule://X?
     固定一句：Do not glob or read **/SKILL.md to recover unknown skills.
     不要扫 SKILL.md 做恢复。

bash resolveSkillUrlToPath(skill://X)
  → 仍只解析 skill 路径；unknown 同样 fail-closed + 同上文案；不 alias。
```

- `adaptive-delivery` 是本语料的合同级反例：32 次 / 31 会话。canonical owner 是 `rule-protocol.ts`。
- prompt/routing owner（将改）：`packages/coding-agent/src/prompts/system/system-prompt.md`（约 30–36 行：「Matching skill → MUST read `skill://<name>`」不得覆盖 always-apply **rule**）；`custom-system-prompt.md` 第 33、49 行旁写明 routing/lifecycle 的 `adaptive-delivery` 是 `rule://adaptive-delivery`，不是 skill。always-apply generic-rules 已内联 rule 正文时，禁止再引导 `skill://adaptive-delivery`。
- **不**做模糊技能搜索、**不**在失败后自动改读 `SKILL.md`、**不**静默把调用者的路由错误改成另一协议成功。

#### 杠杆 3 — auto-deliver 与 wait 空转提示

```text
父 task() 立即返回 ids（已有，不改调度）
父若未 blocked → 继续自己的工作（prompt 强化；不强制）
父 hub wait：
  job 已 settled → 现有 snapshot 即交付（已有）
  无 running job 且无 running peer → 现有 nothingToWaitForResult（已有）
  仍有 running job 但本次 wait 窗口到期 → 在现有 snapshot 上追加可见提示：
    results auto-deliver; do not poll; continue other work;
    re-issue wait only if you have zero remaining work
```

- 连续 wait-only streak（≥3 点名加严）**删除**：无 owner、无计数状态、无验收。只保留静态 auto-deliver / idle 提示。若静态提示经验证无效，再单独设计会话状态生命周期。
- 不把 wait 改成「阻塞直到全部 job 结束」（会让父代理更空转）。
- 不拒绝合法 wait（父确实 blocked 时仍可 wait）。
- 不引入跨 turn DAG / 第二套 poll 合并器。

#### 杠杆 4 — 收紧 review/Gate：白名单 + executor 预算（关闭 H3/M2）

父层一次 `tasks[]` 同时拉起双轴（`review-request.md` 已有 Distribution Guidelines，语料仍出现 size=1 与串行 wait，故必须在 **task.md + system-prompt 委派门** 再写死：review/Gate 双轴禁止两次单元素 spawn）。

每个 review/Gate 子任务 brief **仍必含输入宽度约束**（这不是预算强制）：

1. **路径白名单**：assigned files + 共享 packet（`local://code-review-packet.md` / Reviewed Inputs manifest）。
2. **禁止全库扫**：不得无范围 `glob` / `grep` / `git diff`；producer/consumer 只在要证明一条 finding 时读。
3. **独立他审保留**：Standards / Spec 仍是两个只读 native spawn；Design Review Gate 仍是 sol 审 grok 稿。

**预算强制机制（唯一执行路径）**落在 `packages/coding-agent/src/task/executor.ts`，不是 brief 自报：

| 阶段 | 现有 owner | review/Gate 如何用 |
|---|---|---|
| 软轮次 cap | `resolveSoftRequestBudget(agent.name, settings["task.softRequestBudget"])`（`executor.ts:124-127`）；settings 默认 **200**；bundled 表只有 `scout`/`sonic` 100 与 `default` 200 | `reviewer` / `subagent-sol` / `sol-xhigh-reviewer` 均无 bundled 条目，全部走全局 200。**禁止**给 `SOFT_REQUEST_BUDGET` 加 reviewer 键。语料 125–192 轮已贴近该 cap |
| wrap-up 提示 | 达到 cap 且 `task.softRequestBudgetNotice`（默认 true）→ `buildBudgetNotice` steer | 要求 wrap-up 并 yield；brief 可重复这句话，但不能替代 steer |
| 1.5x forced-yield | `progress.requests >= cap * 1.5` → `requestBudgetStop()` → `driveSessionToYield` 强制一次 final yield | **这是缺口 verdict 的主投递路径**：部分 findings 作为真实 report 回来 |
| grace abort | 1.5x 后再跑 `BUDGET_STOP_GRACE_REQUESTS`（5）仍不 yield → `requestAbort("budget")` | 父层当失败/缺口，不得 PASS |
| 墙钟 hang 防御 | 已有 `ExecutorOptions.maxRuntimeMs`（`executor.ts:427-433`）；未传入时继承 `task.maxRuntimeMs` 默认 3_600_000（1h）；`requestAbort("timeout")`；`finalizeRunResult` salvage | 全局 1h **高于** 30–60 min。review/Gate 主收敛是 host spawn **传入 20 min**，不是新 setting、也不是把 1h 默认改掉 |
| idle park | `task.agentIdleTtlMs` 默认 420_000 | **不是** review 预算；本杠杆不改 |

**如何选 cap（不发明不存在的 setting / 表键）：**

1. **request cap 复用全局 `task.softRequestBudget=200`。** `SOFT_REQUEST_BUDGET` 今日只有 `scout`/`sonic`/`default`（`executor.ts:112-116`）。`resolveSoftRequestBudget` 按精确 `agentName` 查找，未知名回退 configured budget（`:124-127`）。bundled agents（`task/agents.ts`）与项目 `.omp/agents/*.md` 都没有 per-agent request 字段。因此 `reviewer`、Design Gate 的 `subagent-sol`、本仓项目 agent `sol-xhigh-reviewer` **一律 200**。**禁止**给 `SOFT_REQUEST_BUDGET` 增加 reviewer 键或任何未存在的 setting。不降低全局 200（以免误伤普通 `task`/`designer`/`scout`）。
2. 轮次收敛 = 全局 200 + 已有 1.5× forced-yield + 5-request grace abort。facts 的 125–192 轮已贴近该 cap；本轮不另造 per-agent request 表。标定若要更紧，只能动已有 `task.softRequestBudget`（会波及全部子代理）——本轮不做。
3. **墙钟：真实、单一 host seam 传入已有 `ExecutorOptions.maxRuntimeMs`。** 这是 spawn 参数，覆盖 settings；**不是**新 setting，也 **不**暴露给模型 task schema。
   - **Callsite（必须改传入值）：** `packages/coding-agent/src/task/index.ts` `TaskTool.#runSpawn`（约 1580–1602）今日对所有 agent 写死 `maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs")`（默认 1h）。同文件 `#resolveSpawnPreflight`（约 743–755）同样。模型 `task()` 的 `agent: "reviewer"`（code-review 双轴，`review-request.md`）与 `agent: "subagent-sol"`（Design Gate；本仓 discovered 名是 `.omp/agents/sol-xhigh-reviewer.md` 的 `sol-xhigh-reviewer`，同一 `task()` → `#runSpawn` 入口）都走这里。coding-agent 源码里 **没有** 名为 `subagent-sol` 的第二 execute；Gate 不是 `workflow/runtime-adapter.ts`。
   - **应传的值：** 当 `params.agent` ∈ {`reviewer`, `subagent-sol`, `sol-xhigh-reviewer`, `security-reviewer`} 时传入 **`1_200_000`（20 min）**。1h 高于 32–63 min 问题区间，20 min 卡在失控扩张之前，且宽于 workflow profile 的 300_000（changelog 已证明 3 min 会误杀 live gateway review）。其它 agent 仍继承 settings 1h。
   - **转发（不改合同）：** `packages/coding-agent/src/task/structured-subagent.ts` `buildExecutorOptions`（约 451）已有 `maxRuntimeMs: request.maxRuntimeMs` → `ExecutorOptions.maxRuntimeMs`（约 427–433）；`runSubprocess`（约 2833–2836）`options.maxRuntimeMs ?? settings`。
   - **非本杠杆：** `packages/coding-agent/src/workflow/runtime-adapter.ts`（约 406）已把 `request.profile.maxRuntimeMs` 传给 runner；那是 workflow plan/code-review profile（300s），不是 omp Design Gate / `task()` reviewer。
4. brief 里的墙钟/轮次数字最多是解释性输入，**缺 brief 上限不再视为不合格的唯一理由**；缺上述 spawn 传入的 `maxRuntimeMs` 才是不合格。验收失败：review/Gate spawn 仍传入 1h 或未传（落到 settings 默认）。

**timeout / budget 后如何投递缺口 verdict（稳定 provenance，关闭 N1）：**

`budgetStopRequested()` 只是 `SubagentRunMonitor` 私有状态（`executor.ts:1003-1014,1200-1216`），用于驱动一次 forced yield。`finalizeRunResult`（`:2290-2316`）只把 **wall-clock timeout** 升成 `status=aborted`；成功 budget forced-yield 仍可 `status=completed` / `aborted=false`。今日 `SingleResult`（`:2335-2366`，类型 `task/types.ts:490-560`）没有 budget-stop 字段；reminder 文案（`subagent-yield-reminder.md`）不是父层可验证的 provenance。

新增稳定字段 **`completionKind: "budget_stop" | "timeout" | "hard_abort" | "completed"`**（写在 `SingleResult`；terminal lifecycle payload 原样带出。**父模型消费端不是** `task/render.ts`，见下表后的消费链）：

| 结局 | `status`（现有） | `completionKind`（新增） | 父层 / `evaluateBenchmarkQualityGate` |
|---|---|---|---|
| 成功 1.5× forced-yield | 仍可为 `completed` | **必须** `budget_stop` | **一律非 PASS**，不论子代理文本 verdict |
| grace 耗尽 / `requestAbort("budget")` | `aborted` | `hard_abort` | 非 PASS；salvage 若有则附上 |
| `requestAbort("timeout")` | `aborted`（timeout 已强制） | `timeout` | 非 PASS；不走 `driveSessionToYield` |
| 正常 yield，monitor 未 stop | `completed` | `completed` | 才可进入 PASS 判定 |
| 其它 caller abort / terminate | `aborted` | `hard_abort` | 非 PASS |

- **budget 1.5x**：forced yield 仍走已有 yield 通道产出带缺口的 report。**不得**再让父层去读私有 `budgetStopRequested` 或匹配 `Soft request budget exceeded` 文案。
- **timeout**：文案仍是 `Subagent runtime limit exceeded (task.maxRuntimeMs=…)`；salvage 规则不变。本轮不把 timeout 改成第二次 forced-yield。
- M2 verifier：`completionKind !== "completed"`（含成功 forced-yield 的 `budget_stop`）、缺口、缺 finding recall **一律不得计 PASS**。该规则只在 scorecard run 真正带有 `completionKind` 时可执行，见下方消费链。

**消费链（Gate4 关闭 N1 残留；父 summary 已关闭。不重开 H1/H2/H3/M1）：**

父模型看见的 task 文本 **不是** `task/render.ts`（那是 TUI）。`TaskTool.#runSpawn`（`packages/coding-agent/src/task/index.ts` 约 1565–1625）成功路径调用 `#buildResultPayload`（约 1649–1706；Gate3 引用的 1655–1704 即此函数的 status / `prompt.render` 段）。该函数今日按 `aborted` / `exitCode` / `error` 计算 `status`，渲染 `packages/coding-agent/src/prompts/tools/task-summary.md` 作为 `content`；完整 `SingleResult` 只进 `details.results`，父模型默认不读 details。模板今日只有 `status`、`abortReason`、preview 等，**没有** `completionKind`。因此仅改 TUI / 仅改 `SingleResult` 都会让成功 forced-yield 仍显示为普通 `completed`。

1. **父模型 summary（canonical owner：`task-summary.md`）**  
   根元素 `<task-result>` 增加可见属性 `completionKind="{{completionKind}}"`（与现有 `status` / `abortReason` 并列）。`#buildResultPayload` **必须**把 `SingleResult.completionKind` 传入该模板。当 `completionKind !== "completed"` 时，`status` **不得**再写成无修饰的 `"completed"`（成功 1.5× forced-yield：属性必为 `completionKind="budget_stop"`，`status` 用 `budget_stop` 或其它非普通 completed 值）。`task/render.ts` 最多同步给人类 HUD 看，**不能**替代这条路径。

2. **benchmark scorecard（canonical owner：`BenchmarkRunResult`）**  
   `evaluateBenchmarkQualityGate(scorecard: BenchmarkScorecard, …)`（`packages/coding-agent/src/workflow/benchmark/runner.ts:519-610`）只读 `scorecard.summaries[].runs[]`。run 的真实类型是 **`BenchmarkRunResult`**（`packages/coding-agent/src/workflow/benchmark/types.ts:204-227`），今日字段为 `fingerprint` / `passed` / `firstPassed` / `qualityScore` / `tokens` / `stage` / `scopeStatus` / `runtimeProvenance` / `error` / `durationMs`，**没有** `completionKind`。`BenchmarkScorecard`（同文件约 259）本身不新造字段。必须：
   - 在 **`BenchmarkRunResult`** 增加 `completionKind?: "budget_stop" | "timeout" | "hard_abort" | "completed"`（与 `SingleResult` 同一四值）。**live / review/Gate paired**（`liveQualityUnknown===false`）必须显式写出，缺省 **不得**视为 `"completed"`。仅 fake / 历史 fixture（`liveQualityUnknown===true`）可缺省。
   - 在 **`BenchmarkRuntimeResponse`**（`runner.ts:35-47`，scorecard 的 runtime 输入，**不在** types.ts）增加同名字段。
   - `runBenchmarkSuite` 构造 run 时（`runner.ts:353-365`）把 `response.completionKind` 拷进 `BenchmarkRunResult`；`kind !== "completed"` 时 **硬映射** `passed=false`（与现有 `identityErrors` 合取）。catch 路径保持 `passed=false`；live 路径 kind 仍缺则 evaluator fail-closed，不得事后补 `"completed"`。
   - `evaluateBenchmarkQualityGate`：**禁止**无条件 `run.completionKind ?? "completed"`。用现有 `scorecard.liveQualityUnknown` 做 presence 边界（`runner.ts:65-68,462`；live 验收 `false`，fake 默认 `true`）：
     - **live / review/Gate paired**（`liveQualityUnknown === false`，含 `createLiveWorkflowBenchmarkRuntime`）：缺 `completionKind` **fail-closed / 非 PASS**（与 missing `runtimeProvenance` 同类 hard fail）。不得把丢字段规范化成 `completed`。
     - **历史 / 非 live fixture**（`liveQualityUnknown === true`，含 `createFakeBenchmarkRuntime`）：缺 kind 才允许视为 `"completed"`。
     - 有值且 `!== "completed"`（含成功 `budget_stop`）→ 该 case **非 PASS**（与 `scopeStatus=violation` 同类 hard fail），即使 runtime 误报 `passed=true`。
   - live producer 真实符号（**没有** `StructuredRunnerResult → LiveBenchmarkAgentResult` 的独立 mapper；不要发明）：
     1. `StructuredRunnerResult.result`（`packages/coding-agent/src/workflow/runtime-adapter.ts:87-111`）今日只有 `exitCode` / `error` / `aborted` / `abortReason`，**必须**增加 `completionKind`（与 `SingleResult` 同一四值）。
     2. `productionRunner`（`packages/coding-agent/src/workflow/runtime-default.ts:67-123`，投影 `:104-119`）今日只复制 `id` / structured+raw output / patch / branch / usage / `exitCode` / `error` / `aborted` / `abortReason` / model / toolCalls。**必须**转发 `SingleResult.completionKind`，禁止丢字段。这是 live 子代理 outcome 进入 workflow 的唯一投影。
     3. `RuntimeAdapter.#runOnce`（同文件 `:422-438`）今日只在 `body.aborted` 时按 abort 文案分 soft budget / timeout / cancel。成功 1.5× forced-yield **不 aborted**、`exitCode` 仍可为 0，必须读 `body.completionKind`；`budget_stop` / `timeout` / `hard_abort` 不得当普通 structured success。**成功路径返回的 `WorkflowAgentResult`（`types.ts:719-748`）必须携带同一 `completionKind`。** `BudgetExhaustedError` / `WorkflowTimeoutError` 的 `details` 必须带该 kind（`budget_stop` / `timeout`），不得只靠文案正则。
     4. **权威 persist（Gate5 HIGH）：** `WorkflowEngine.#recordUsageAndProfile` 写入的 `runtime-evidence` artifact（`engine.ts:4057-4086`）必须带 `completionKind`。`modelExecutionEvidence`（`:283-296`）解析该字段到 `WorkflowModelExecutionEvidenceV1`。`getStatusReport` 的 `WorkflowStatusReportV1.modelAttempts[].executions[]` 因此可见 kind。这是 `RuntimeAdapter` 到 live producer 的唯一 persist 桥，不新造 status report 顶栏字段、不新建 store 列。
     5. **多 stage / retry 聚合：** live 一对 case 的 `completionKind` = 该 workflow `modelAttempts` 全部 execution 的 **最坏** kind。优先级 `hard_abort > timeout > budget_stop > completed`。缺任一 execution kind 的 live paired case **fail-closed**（与 missing provenance 同类）。成功 forced-yield 即使 workflow `terminalStatus=completed` 也是 `budget_stop`。
     6. `runProductionWorkflow`（`live-runtime.ts:629-687`）从 `workflow.statusReport` 聚合 kind 写入 `LiveBenchmarkAgentResult.completionKind`（`:62-77`），**不得**只抄 `terminalStatus`，也不得从 `terminalStatus` 猜 kind。
     7. `runLiveCase`（`:703-775`）把 `agentResult.completionKind` 拷进 `BenchmarkRuntimeResponse`；`createLiveWorkflowBenchmarkRuntime`（`:778-804`）只包 `runLiveCase`。`kind !== "completed"` 或 live 路径缺 kind 时，不得因 `terminalStatus==="completed"` 而 `passed=true`。
     `createFakeBenchmarkRuntime`（`fixtures.ts:717`）可不填 kind（仅 `liveQualityUnknown=true` 缺省）。Paired live / review/Gate case 必须显式带 kind；缺 kind 不得 PASS。
     验收必须覆盖 `productionRunner → RuntimeAdapter → runtime-evidence → getStatusReport → runProductionWorkflow → runLiveCase → runBenchmarkSuite`：成功 forced-yield 最终 `BenchmarkRunResult.completionKind="budget_stop"` 且非 PASS；live missing-kind 仍 fail-closed。

3. **lifecycle：** `SubagentLifecyclePayload`（`task/types.ts:88-106`）的 `status` 仍是 `started | completed | failed | aborted`。`completionKind` **只在 terminal**（completed/failed/aborted）必填；`started` 不填。结局优先级不变：timeout / grace `hard_abort` 不得被仍为 true 的 `budgetStopRequested` 标成成功 `budget_stop`。

### 4.3 将改路径

| 路径 | 改动 |
|---|---|
| `packages/coding-agent/src/tools/read.ts`（`#handleInternalUrl`，约 2395–2493 行） | 仅 canonical 完整 `skill://` 全文视图写入受限 attested details（`canonicalSource` / `branchOrWorktreeScope` / `providerViewIdentity` / `contentOrRevisionIdentity` / `outputMode`）。`ignoreResultLimits` 保持仅 skill。不 attest `rule://`。ranged 行为不变。 |
| `packages/coding-agent/src/session/agent-session.ts` | **不**新增 memo，**不**改 `#dedupeOrdinaryReadResult` fail-open 算法。复用 `#readDedupeArtifacts`（声明约 723）与 1724 / 2264 clear。 |
| `packages/coding-agent/src/latency/read-view-key.ts` | 不改合同；skill 全文靠 attested details 变 eligible。 |
| `packages/coding-agent/src/internal-urls/skill-protocol.ts`（约 49–63 行） | unknown skill **fail-closed**；精确同名 rule 时附加 `Did you mean rule://X?`；禁止引导扫 `SKILL.md`。不 alias。 |
| `packages/coding-agent/src/tools/bash-skill-urls.ts`（约 75–76 行） | unknown-skill 文案与上条对齐（Did you mean + 禁扫盘）。**不** alias，不返回 rule 路径。 |
| `packages/coding-agent/src/task/executor.ts` | 预算强制 owner（不改算法）。`finalizeRunResult`（约 2290–2366）从 monitor 私有 `budgetStopRequested` / `runtimeLimitExceeded` / `abortReason` 写出 `SingleResult.completionKind`。成功 forced-yield：`status` 可仍为 `completed`，`completionKind` **必须** `budget_stop`。lifecycle emit（约 2319–2334）带上同一字段。**不**给 `SOFT_REQUEST_BUDGET` 加 reviewer 键。 |
| `packages/coding-agent/src/config/settings-schema.ts` | 相关键保持为执行面：`task.softRequestBudget`（默认 200）、`task.softRequestBudgetNotice`、`task.maxRuntimeMs`（全局 hang 默认 1h，review/Gate 不靠改这个默认）、`task.agentIdleTtlMs`（idle park，不改语义）。**不**新造 setting。 |
| `packages/coding-agent/src/task/types.ts` | `SingleResult`（约 490）增加 `completionKind`。`SubagentLifecyclePayload`（约 88）只在 terminal status（completed/failed/aborted）必填该字段；`started` 不加。 |
| `packages/coding-agent/src/task/index.ts` | **H3 唯一 host callsite：** `TaskTool.#runSpawn`（约 1580–1602）与 `#resolveSpawnPreflight`（约 743–755）。今日一律 `settings.get("task.maxRuntimeMs")`（1h）。对 `reviewer` / `subagent-sol` / `sol-xhigh-reviewer` / `security-reviewer` 改为传入 `maxRuntimeMs: 1_200_000`（20 min spawn 参数）。其它 agent 不改。不把 cap 写入模型 task schema。 |
| `packages/coding-agent/src/task/structured-subagent.ts` | **不改转发。** `buildExecutorOptions`（约 451）已把 `request.maxRuntimeMs` 写入 `ExecutorOptions`。 |
| `packages/coding-agent/src/task/render.ts` | **TUI only。** 可展示 `completionKind` 以免人类 HUD 把 `budget_stop` 画成无条件 success；**不是**父模型消费端，不能替代 `task-summary.md`。 |
| `packages/coding-agent/src/prompts/tools/task-summary.md` | 根元素 `<task-result>` 增加可见属性 `completionKind`。成功 forced-yield 的父模型摘要不得显示为普通 `status="completed"`（无 kind 或 kind 被省略）。 |
| `packages/coding-agent/src/task/index.ts` `#buildResultPayload`（约 1649–1706，由 `#runSpawn` 约 1617 调用；Gate3 1655–1704） | 把 `SingleResult.completionKind` 传入 `task-summary.md`。`completionKind !== "completed"` 时 `status` 不得为无修饰 `"completed"`。**不改** `#runSpawn` 的 review/Gate `maxRuntimeMs=1_200_000` 合同（H3）。 |
| `packages/coding-agent/src/workflow/benchmark/types.ts` | **`BenchmarkRunResult`**（约 204–227）增加 `completionKind`。这是 `BenchmarkScorecard.summaries[].runs[]` 的元素，也是 `evaluateBenchmarkQualityGate` 的输入记录。不新造 scorecard / gate struct。 |
| `packages/coding-agent/src/workflow/runtime-adapter.ts` | **`StructuredRunnerResult.result`**（约 87–111）增加 `completionKind`。`#runOnce` 成功返回的 `WorkflowAgentResult` 必须带该字段。`BudgetExhaustedError` / `WorkflowTimeoutError` 的 details 带 kind。不新造第二套 runner 合同。 |
| `packages/coding-agent/src/workflow/runtime-default.ts` | **`productionRunner`**（约 67–123，投影 104–119）**必须**转发 `SingleResult.completionKind`。禁止继续丢字段。 |
| `packages/coding-agent/src/workflow/types.ts` | `WorkflowAgentResult`、`WorkflowRuntimeEvidence`、`WorkflowModelExecutionEvidenceV1` 增加 `completionKind`。不给 `WorkflowStatusReportV1` 顶栏加字段。 |
| `packages/coding-agent/src/workflow/engine.ts` | `#recordUsageAndProfile` 把 kind 写入 `runtime-evidence`；`modelExecutionEvidence` 解析它。各 stage `#recordUsageAndProfile` 调用转发 `result.completionKind`。`getStatusReport` 因此在 `modelAttempts[].executions[]` 可见 kind。 |
| `packages/coding-agent/src/workflow/benchmark/runner.ts` | **`BenchmarkRuntimeResponse`**（约 35–47）增加同名字段。`runBenchmarkSuite`（约 353–365）拷贝到 `BenchmarkRunResult`；`kind !== "completed"` 时 `passed` 硬映射 false。`evaluateBenchmarkQualityGate`（约 519–610）：`liveQualityUnknown===false` 时缺 kind **fail-closed / 非 PASS**；仅 `liveQualityUnknown===true`（fake / 历史 fixture）允许缺省 `"completed"`。有值且 `!== "completed"`（含成功 `budget_stop`）一律非 PASS。**删除**无条件 `run.completionKind ?? "completed"`。 |
| `packages/coding-agent/src/workflow/benchmark/live-runtime.ts` | **`LiveBenchmarkAgentResult`** 增加 `completionKind`。`runProductionWorkflow` 从 `statusReport.modelAttempts[].executions[]` **最坏 kind** 聚合（`hard_abort > timeout > budget_stop > completed`）；不得只抄 `terminalStatus`、不得从终态猜 kind。`runLiveCase` 转发到 response；缺 kind 或 `kind !== "completed"` 时 `passed` 不得为 true。 |
| `packages/coding-agent/src/tools/hub/index.ts`（`#executeWait`） | wait 窗口到期且仍有 running jobs 时追加 auto-deliver / 继续工作提示。 |
| `packages/coding-agent/src/tools/hub/jobs.ts`（`nothingToWaitForResult` 一带） | 空转结果补一句「若无 running jobs，不要反复 bare wait」。 |
| `packages/coding-agent/src/prompts/tools/hub.md` | 与运行时提示对齐：poll 不是交付路径。 |
| `packages/coding-agent/src/prompts/tools/task.md` | 强化 auto-deliver；禁止 spawn 后立刻进入连续 wait；review/Gate 双轴必须同一 `tasks[]`。写明预算由 executor 强制，brief 白名单只约束输入宽度。 |
| `packages/coding-agent/src/prompts/system/system-prompt.md`（约 30–36、32、164–201 行） | 重读完整 skill 将得到 context-ref stub；`adaptive-delivery` 走 `rule://`；unknown skill 不要 glob `SKILL.md`；spawn-one-then-wait 与双轴一次 batch。 |
| `packages/coding-agent/src/prompts/system/custom-system-prompt.md`（第 33、49 行） | 与上条同义；routing/lifecycle 的 `adaptive-delivery` 写 `rule://adaptive-delivery`。 |
| `packages/coding-agent/src/prompts/review-request.md` | 白名单 / 禁全库扫 / 一次 task；brief 可解释预算但不是执行机制。 |
| `packages/coding-agent/src/prompts/agents/reviewer.md` | 与 brief 一致：超出白名单的探索视为 brief 违例，报告缺口；命中 runtime cap 必须 yield 缺口而不是扩范围或假 PASS。 |
| `packages/coding-agent/test/tools/hub-wait.test.ts` | wait 窗口到期提示。 |
| `packages/coding-agent/test/skill-protocol-customdirs.test.ts`（及既有 skill-protocol 测试） | unknown skill fail-closed + `Did you mean` + 禁扫盘；**无** alias 成功路径。 |
| `packages/coding-agent/test/task/executor-soft-budget.test.ts`（及 timeout 同类测试） | **producer 两条契约，不只测 reminder 文案：**（1）成功 1.5× forced-yield → executor `status` 可为 `completed` 且 `completionKind==="budget_stop"`；（2）grace 耗尽 hard-abort → `completionKind==="hard_abort"` 且 aborted。另覆盖 review/Gate spawn 传入 20 min 而非常规 agent 的 1h（H3，不重开）。 |
| `packages/coding-agent/test/task/` 下与 `task-spawn` 并列的 model-facing 测试（不要用 `job-renderer-preview.test.ts`：那是 TUI 剥 envelope） | 渲染 `task-summary.md` 后的**父模型文本**含 `completionKind="budget_stop"`（或等价可见属性），且不得与普通 `status="completed"` 摘要相同。 |
| `packages/coding-agent/test/workflow/p012-production-wiring.test.ts`（与现有 scope-violation 用例同形） | 构造 `BenchmarkRunResult.completionKind="budget_stop"` 且 `passed=true` 的 scorecard → `evaluateBenchmarkQualityGate` **非 PASS**。`timeout` / `hard_abort` 同样拒绝。另：`liveQualityUnknown=false` 且缺 `completionKind` 的 live scorecard **不得 PASS**（覆盖 `?? "completed"` 漏洞）。 |
| 新建只读单测（与现有 read/skill 测试并列，不新建框架） | 完整 `skill://` 第二次全文 read → context-ref stub；compaction clear 后下一次再注入全文；截断/非 full selector/`rule://` 不登记；hash 变化 fail-open。 |
| 离线 quality gate（复用，不新建平台） | `evaluateBenchmarkQualityGate` 继续以 `BenchmarkScorecard` 为输入；冻结 paired review/Gate case；known-defect recall、正确 verdict；**输入记录 `BenchmarkRunResult.completionKind` 为 `budget_stop` / `timeout` / `hard_abort` 一律非 PASS**（含成功 forced-yield）；`first-pass verified success` 非回退。不新建评测平台。 |

**明确不改：** `workflow/context-ledger.ts` 算法、`session/messages.ts` `convertOne` custom 分支、`rule-protocol.ts` 的解析成功路径、`#dedupeOrdinaryReadResult` 资格算法、今早 P0–P2 文件、latency arm 表、`task.agentIdleTtlMs` 语义、通用文件 identity 补全。**不重开 H1/H2/H3/M1。** 不把 `task/render.ts` 当父模型消费端；不新造第二套 scorecard / gate 类型。不发明 `StructuredRunnerResult → LiveBenchmarkAgentResult` 的新 mapper；只改现有 `productionRunner` / `#runOnce` / `runProductionWorkflow` / `runLiveCase`。

外部 skill 正文（`skill://code-review`、`skill://design-brainstorm`、`skill://subagent-sol`）若从用户 skill 目录加载：只在**实际被加载的那一份**上收紧「子代理 brief 必须含白名单」，**禁止**在仓库再复制一份平行 skill。in-repo 的 `review-request.md` / `reviewer.md` / `task.md` 已覆盖宿主原生 `/review` 与 task spawn。

### 4.4 不变量

1. 第一次 **完整** canonical `skill://` 全文 read 仍注入完整正文（模型必须能首次执行 skill）。
2. stub/context-ref 只在 **canonical skill 全文 + 模型可见已证明完整** 时生效；带 line selector 的读、`rule://`、截断结果保持现有 fail-open。
3. skill 内容变更（模型可见 hash 不同）必须再注入，不得用旧 context-ref 冒充新正文。
4. compaction / `auto_compaction_end` 后 `#readDedupeArtifacts` 已 clear：原 toolResult 不可见 → 下次读 fail-open 再注入全文。
5. unknown skill 保持 fail-closed；不把 `skill://` 静默改写成 `rule://` 成功。
6. receipt / custom 无 content 仍不进 LLM。
7. 独立他审拓扑不变：code-review 双轴、设计 grok author → sol Gate。
8. wait 仍可在「完全 blocked」时使用；auto-deliver 仍是交付路径。
9. `#dedupeOrdinaryReadResult` 对普通文件的 fail-open 资格不变。
10. `completionKind` 为 `budget_stop` / `timeout` / `hard_abort` 或缺口 yield **不得**被父层或 verifier 计为 PASS。成功 forced-yield 即使 executor `exitCode===0` / 旧 `status=completed`，父模型 `task-summary.md` 与 `BenchmarkRunResult.completionKind` 也必须是 `budget_stop`，且 `evaluateBenchmarkQualityGate` 非 PASS。**`productionRunner` 投影必须带 kind。** live / review/Gate paired scorecard（`liveQualityUnknown===false`）**缺 kind 不得 PASS**；成功 `budget_stop` 不得 PASS。仅 fake / 历史 fixture 允许缺省 `completed`。
11. 禁止用 `protocol.resolve()` 的完整 `resource.content` hash 推断 transcript 已含全文。

### 4.5 失败路径与回滚

| 失败 | 行为 | 回滚 |
|---|---|---|
| attested details / key 构建 / artifact verify 异常 | fail-open：注入全文（现有 `#dedupeOrdinaryReadResult` catch） | 不需要 |
| compaction 后重读 | map 已 clear → 再注入全文 | 不需要 |
| `rule://` 或截断结果 | 不 attest → ineligible → 全文或现有截断行为 | — |
| 用户读 `skill://name/foo.md` 或 ranged | 非 canonical 全文，不 stub | — |
| unknown skill 无同名 rule | 现有 Available 列表 + 禁扫盘 | — |
| unknown skill 有同名 rule | fail-closed + `Did you mean rule://X?` | — |
| wait 提示导致模型该等却不等 | 仍可下次 wait；job 仍 auto-deliver | 去掉提示文案即可 |
| review 命中 1.5x / timeout | `completionKind=budget_stop` 或 `timeout` / `hard_abort`；不得 PASS | 只调 `#runSpawn` 传入的 `maxRuntimeMs`（20 min）或全局 `task.softRequestBudget`，不改拓扑、不发明表键 |
| context-ref 被误认为「skill 不存在」 | prompt 写明 context-ref = 正文已在 transcript + hash；unknown 文案禁扫盘 | 回退 read.ts attested details |

回滚单位是上表各文件的 git revert；**不**新增第二套 latency arm / feature-flag taxonomy（非目标）。四杠杆无交叉写，可单独 revert。

### 4.6 本方案验收（实现阶段，非本设计授权范围）

- 单测：见 §4.3 测试路径。
- 语料级 + 离线 paired gate：见 §6。
- 本设计 authorization=design-only，**现在不实现、不跑测试套件**。

## 5. 风险与缓解

1. **context-ref 让模型以为 skill 未加载，转去扫 `SKILL.md`。** 缓解：stub 为已有 `artifact://` + sha256；prompt 写明已在 transcript；杠杆 2 的 unknown 文案明确禁止 glob `SKILL.md`。验收看文件系统 `SKILL.md` 热读与 `not found` 是否下降，而不是只看 stub 命中率。
2. **compaction 后误 stub。** 缓解：不平行 memo；复用 1724/2264 clear。不变量：原 toolResult 不可见 → map 已空 → 再注入全文。
3. **用 resolve() hash 把截断 rule 当成全文。** 缓解：选项 a 不登记 `rule://`；登记只认模型可见完整结果。
4. **wait 提示过强，父代理在必须同步时提前 yield。** 缓解：只提示、不拒绝 wait；连续 ≥3 才加严。交付仍靠 auto-deliver。
5. **review 预算把真问题漏掉。** 缓解：M2 冻结 paired case；known defect 必须仍检出；缺口/timeout/budget-stop 不得 PASS；墙钟下降伴随 `first-pass verified success` 下降则本杠杆失败。独立双轴保留。
6. **把 78.15% 分段读或 10,649 次 receipt 当优化对象（范围漂移）。** 缓解：§1.4 / §7 写死；实现评审若出现 ledger/packer/receipt-to-LLM/新 memo 视为超范围。
7. **长会话全量历史本轮不关闭。** facts 把全量历史与 skill 重注入并列为主因，compaction 仅 44 次 / 23 会话。方案 A 明确不靠更频繁 compaction。本轮指标改善 **不得**表述成消除全部上下文税。重新进入独立设计/实验的触发：同口径新窗口里，skill 重读对已下降，但父 input tokens 或墙钟仍不降，且 compaction 次数仍低——那时才单独立项 compaction/history，不在本杠杆加 packer。
8. **外部 skill 与 in-repo prompt 双份 brief。** 缓解：宿主 `/review` 以 in-repo `review-request.md` 为准；omp `skill://code-review` 只改加载源那一份，禁止复制。

## 6. 验证计划

设计阶段不跑项目测试。实现授权之后，用 **与 facts brief 相同的 jsonl 解析** 做前后对比（新窗口会话，字段定义不得改），并另跑冻结 paired quality gate。

| 指标 | brief 基线 | 期望方向 | 禁止误用 |
|---|---|---|---|
| `skill://` 次数 / 会话 | 698 / 78 | 下降（尤其同会话 ≥2） | 不要用「第一次合法加载」或 compaction 后再注入当回归 |
| `(session, skill)` ≥2 | 169 对 | 下降 | compaction 后的合法再注入可排除 |
| 同会话 skill 重读峰值 | 15–16 | 下降 | — |
| 文件系统 `**/SKILL.md` | 514 / 40 | 下降（misroute 修复后） | mixed 会话允许残留一次对照 |
| `Unknown skill: adaptive-delivery` | 32 | **0** | 不得靠 alias 把错误变成成功来「归零」 |
| `code-review/SKILL.md` not found | 8 | 下降到不被 unknown-skill 诱发 | 用户真缺文件仍可失败 |
| exact path dup | 2,742 / 15,341 = 17.87% | 非本方案主 KPI | **禁止**把 78.15% selector 再读当浪费 |
| `tool_optimization_receipt` 次数 | 10,649 | 允许不变 | **禁止**当 token 浪费 |
| `task` batch size=1 | 91（59%） | 下降；review/Gate 双轴不得为两次 size=1 | 真·单切片 size=1 仍合法 |
| 同一轮 `task`+`wait` | 0 | 保持 0（spawn 后应继续工作） | — |
| 连续 ≥3 wait 段 / 最长 | 74 段 / 12 | 下降 | 单次合法 wait 仍允许 |
| review/gate 子墙钟与轮次 | 常见 30–60 min、125–190 轮；类 137 个 | 同名类（SpecAxis/SolSpec/StandardsReview）下降 **且** 通过非回退门 | 不得用 887.6 min 极端值当均值；其中 idle 比例未知 |
| 子 `task` | 2 | 不要求再降 | 爆炸在父层 |
| runtime cap 单测 | 无语料基线 | 成功 forced-yield → `completionKind=budget_stop`；hard-abort → `hard_abort`；timeout salvage；review/Gate 20 min spawn；**父 summary 文本可见 `budget_stop`**；**`productionRunner` 投影带 kind**；**live scorecard 缺 kind 不得 PASS**；**`evaluateBenchmarkQualityGate` 拒绝把 `budget_stop` 当 PASS** | 禁止只测 reminder 文案或只测 TUI `render.ts`；禁止 `?? "completed"` 把 live 丢字段藏成 PASS |

**质量非回退门（M2，实现授权后，离线）：**

- 形状：复用 `evaluateBenchmarkQualityGate`（配对 baseline vs treatment，`maxQualityDropPp: 3` 只用于该离线比较器）。**不**把 3% 改成 live 熔断器，**不**新建评测平台，**不**发明 facts brief 没有的生产百分比承诺。
- 冻结 replay/paired case：至少覆盖一类 code-review 双轴与一类 Design Gate；每案含已知缺陷（必须检出）、正确 verdict、以及「证据不足应报缺口」的负例。
- Verifier 失败条件（任一即 fail）：known defect 漏报；verdict 从错误改为 PASS；`completionKind` 为 `budget_stop` / `timeout` / `hard_abort` 被标 PASS（含成功 forced-yield）；**live / review/Gate paired 缺 kind 被标 PASS**；缺口被标 PASS；`first-pass verified success` 相对配对基线下降。
- **墙钟/轮次下降若伴随 first-pass verified success 下降 → 本杠杆失败**，即使 jsonl 的 wait 段和 unknown-skill 看起来「改善」。
- 用户关键词仅并排报告，不能单独判成败。

实现阶段单测（已授权）：fail-closed `Did you mean`、skill 二次全文 → context-ref、compaction/map-clear 后再注入、hash 变化 fail-open、`rule://`/query/fragment/raw 不登记、wait 静态提示（无 streak）、**成功 forced-yield 的 `completionKind=budget_stop`（executor status 可 completed）**、**hard-abort 的 `completionKind=hard_abort`**、review/Gate spawn 20 min 且不得放宽更严/0 配置、**父模型 `task-summary.md` 可见 `budget_stop` 且不是普通 completed**、**`productionRunner` 投影带 `completionKind`**、**live scorecard 缺 kind 不得 PASS**、**`evaluateBenchmarkQualityGate` 拒绝把 `budget_stop` 当 PASS**、**timeout→fallback completed 双 execution 最坏 kind=timeout**。禁止只断言 reminder 文案或只断言 TUI。禁止 live 路径用 `?? "completed"` 把丢字段藏成 PASS。跳过与本杠杆无关的全仓套件。
- **superseded：** 旧句「本设计 authorization=design-only，现在不跑这些测试 / Gate PASS 后停止」已作废。当前授权是继续修复并跑本杠杆验证。

## 7. 非目标

- 今早已落地 P0–P2：empty-stop fallback、sloppy fail-closed、receipt→outcome join、prompt lint、compaction fidelity、默认关闭的 provider-health / auto-thinking。见 `docs/research/2026-08-26-agent-output-quality-and-latency-optimization.md`。
- relevance packing、memory gate（本地 precision/freshness 门未满足）。
- P3 learned router。
- 因重复失败自动 skip 合法工具（保持 advisory/fail-open）。
- 第二套 latency arm taxonomy / 第二套 Control Plane / 第二套 scheduler / 跨 turn DAG。
- 重建 ContextLedger、平行 skill/rule memo、或把 skill stub 做成通用文件 packer。
- 通用 skill→rule alias，或把 alias 扩到 `bash-skill-urls.ts`。
- 本轮为 `rule://` 开启 `ignoreResultLimits` / 完整交付合同（H2 选项 b；rule 保持 ineligible）。
- 把 78.15% 不同 selector 再读当成浪费来「修复」。
- 把 receipt 次数当 token 浪费，或把 receipt 拉进 LLM（`convertOne` 丢弃无 content 的 custom 必须保持）。
- 取消独立他审、合并双轴、grok 自审、父代理代写 Gate verdict。
- 用更频繁 compaction 处理长历史（本语料 compaction 已很少；见 §5.7 residual）。
- 把 `task.agentIdleTtlMs` 改成 review 预算。
- 实现代码、全仓测试、formatter/linter（本授权 design-only）。

## 8. Handoff

### 8.1 同会话继续

本请求 **implementation_authorization=design-only**。设计正文落盘后，同会话主 agent **只**进入 Design Review Gate，**不得** `$design-implement` 或 `/design-implement`。

宿主原生路径：`按 subagent-delegation 触发只读 GPT-5.6-sol / subagent-sol（默认 GPT-5.6-sol / subagent-sol；优先与 grok 异模型；author 为 grok 时不可回退到 grok；reviewer 不可用则 claude-opus-5-thinking-high，再主 agent 同模型）。`

- `$design-review` 与 `/design-review` 等价，二选一即可，不要开第二套 Gate。
- reviewer spawn 传 `shadowReview: "code"`。禁止 grok 审 grok 稿。禁止作者自审。
- review artifact 持久化到 `docs/superpowers/plans/2026-08-26-session-quality-context-latency-subagent-review.md`。
- 结论必须为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一。
- `NEEDS_REVISION`：回到本文档由 **Grok 4.6 author** 修订后重跑 Gate。
- `NEEDS_REDESIGN`：回到 `design-brainstorm` 重比较方案并重跑 Gate。
- **PASS / PASS_WITH_NOTES 后必须停止。** design-only 不得进入实现。

### 8.2 新会话恢复 prompt

```text
请读取完整设计输入集合（docs/superpowers/specs/2026-08-26-session-quality-context-latency-design.md；docs/superpowers/specs/2026-08-26-session-quality-context-latency-facts-brief.md；docs/research/2026-08-26-agent-output-quality-and-latency-optimization.md），生成按 normalized path 排序的 path + SHA-256 `Reviewed Inputs` manifest，并计算 `reviewed_revision`；pre-review handoff 不伪造 digest。设计元数据：design_author=grok；implementation_authorization=design-only；authorization_source=用户要求基于近期历史会话分析瓶颈并落地完整解决方案文档；未授权实现代码。
使用起草前选定的只读 GPT-5.6-sol / subagent-sol 执行独立 Design Review（默认 GPT-5.6-sol / subagent-sol；优先与全部内容作者异模型；author 为 grok 时不可回退到 grok；reviewer 不可用则 claude-opus-5-thinking-high，再主 agent 同模型，并记录 review_fallback）；将完整 review artifact 持久化到 docs/superpowers/plans/2026-08-26-session-quality-context-latency-subagent-review.md。按宿主记录 review_mode=host-native、author/reviewer native agent_id、model、verdict、授权来源与证据。
若文档包含根因分析，请一并核对根因判断、证据与设计方案是否一致。
评审结论必须为 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一，并附可复查证据；禁止作者自审。
NEEDS_REVISION 时回到当前设计文档修订；NEEDS_REDESIGN 时回到 design-brainstorm 重做方案；正文变更后均须重新执行 Gate，且在通过前不得实现。
PASS/PASS_WITH_NOTES 后，current Inputs manifest 等于 reviewed manifest 或存在覆盖全部输入的有效 Gate Continuity Note，且 implementation_authorization=authorized，才继续 design-implement；design-only 必须停止。
Review 后输入变化由未参与 author/reviewer/正文修改/implementation 的主协调者按 handoff 规则分类；非实质变化持久化覆盖完整 manifest 的 Gate Continuity Note，实质、不确定、遗漏输入或角色未分离时重跑 Gate。
```

## 9. Gate 修订

关闭 `docs/superpowers/plans/2026-08-26-session-quality-context-latency-subagent-review.md` 中必须采纳的 findings（LOW 无）。本轮仍是方案 A 内合同收敛，不是 redesign。

| id | 关闭方式 |
|---|---|
| **H1** | 删除平行 skill/rule memo。canonical 完整 `skill://` 全文经受限 attested details 进入现有 `#dedupeOrdinaryReadResult` / `#readDedupeArtifacts`。复用 artifact、hash、eligibility、1724/2264 clear、fail-open。写明：compaction 后原 toolResult 不可见 → map 已 clear → 下次读 fail-open 再注入全文。 |
| **H2** | 采用选项 a：只登记模型可见已证明完整的 canonical `skill://` 全文；`ignoreResultLimits` 仅 skill，故 `rule://` 本轮 ineligible。key 区分 selector/outputMode。禁止用 `resolve()` 的 `resource.content` hash 推断 transcript 已含全文。 |
| **H3** | request cap **只**复用全局 `task.softRequestBudget=200`（`SOFT_REQUEST_BUDGET` 无 reviewer 键，不发明）。墙钟：`TaskTool.#runSpawn` / `#resolveSpawnPreflight`（`task/index.ts` 约 743–755、1580–1602）对 `reviewer` / `subagent-sol` / `sol-xhigh-reviewer` / `security-reviewer` **必须**传入已有 `ExecutorOptions.maxRuntimeMs=1_200_000`（20 min spawn 参数，不是新 setting）。`structured-subagent.ts:451` 只转发。coding-agent 没有独立的 `subagent-sol` execute；Gate 与 reviewer 同一 `task()` 入口。brief 白名单只约束输入宽度。 |
| **M1** | 不做通用 skill→rule alias，不扩 `bash-skill-urls`。clean cutover：修正 prompt/routing 产生 `rule://adaptive-delivery`；unknown skill fail-closed + `Did you mean rule://X?` + 禁止扫 `SKILL.md`。 |
| **N1** | **本轮关闭 Gate5 HIGH。** 权威桥接：`productionRunner` 转发 → `RuntimeAdapter.#runOnce` 写入 `WorkflowAgentResult.completionKind` → `#recordUsageAndProfile` persist 到 `runtime-evidence` → `modelExecutionEvidence` 解析到 `WorkflowModelExecutionEvidenceV1` → `getStatusReport.modelAttempts[].executions[]` → `runProductionWorkflow` 最坏-kind 聚合 → `LiveBenchmarkAgentResult` → `runLiveCase` → `BenchmarkRunResult`。live 缺 kind fail-closed。成功 forced-yield 即使 `terminalStatus=completed` 也是 `budget_stop` 且非 PASS。不新造 status report 顶栏 / store 列 / 第二 mapper。 |
| **M2** | §1.2 / §6 增加冻结 paired replay + `evaluateBenchmarkQualityGate` 形状 verifier：known defect 仍检出、正确 verdict、`completionKind !== completed` 与缺口不得 PASS；墙钟下降伴随 `first-pass verified success` 下降则失败。不新建平台。 |

未扩范围的 Gate 旁注：长会话全量历史标为 §5.7 residual，不在本轮当已关闭。
