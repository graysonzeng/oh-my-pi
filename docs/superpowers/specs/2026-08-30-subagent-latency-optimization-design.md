# Design: OMP subagent 活跃墙钟优化（相对 Cursor）

- Date: 2026-08-30
- Status: Draft — implementation-review reentry
- Scope: L
- design_author: grok
- design_author_identity: GrokDesigner
- design_revision_author_identity: `dea73d7c-b393-4b9e-abb1-d80f516595b2`
- design_revision_author_model: cursor-grok-4.6-xhigh-fast / Grok 4.6
- design_second_revision_author_identity: `86139fdc-2f49-4d60-b3ac-f675c51312da`
- design_second_revision_author_model: gpt-5.6-sol-xhigh / GPT-5.6-sol
- design_third_revision_author_identity: `LatencyDesignFallbackRevision`
- design_third_revision_author_model: gpt-5.6-sol-xhigh / GPT-5.6-sol
- design_third_revision_author_fallback_reason: Grok 4.6 author job stalled and was cancelled; replacement author GPT-5.6-sol
- content_author_models: Grok 4.6, GPT-5.6-sol
- planned_reviewer: Claude Opus 5 / claude-opus-5-thinking-high
- implementation_authorization: implementation-authorized; paused for independent design re-Gate
- authorization_source: 用户当前明确要求完成实现；实现代码评审发现合同缺口后回到设计修订。本轮 replacement author 只改设计，独立 Gate PASS/PASS_WITH_NOTES 后恢复同一实现，不改 `~/.omp` 配置或发布。

## 1. 设计目标和范围

### 1.1 要解决的问题

- OMP subagent 用户感知常 30+ min；新鲜语料（2026-08-27–30）里 review/gate 文件首末墙钟 p50=20.0 min、p90=33.1 min、≥30 min 为 9/60，活跃长任务可到 53–70 min。`[历史事实]`
- 同一对照下，Cursor 官方把 Explore 做成快模型 + 隔离中间输出 + 父收 final message；本会话宿主同类委派看起来快且可用。`[历史事实]`
- 问题不是单一「OMP 慢」：产品默认合同、用户级 skill/overrides、社区 hang、以及 jsonl 首末跨度含 park，必须分层处理。`[推导]`
- 相邻设计已覆盖的杠杆不得重做：8/26 skill stub / wait 提示 / 已有 30 min+80 req cap；8/23 thinking-loop / 空停；8/03 长会话模型/TTFT A/B；8/20 grok fast-mode；8/29 live progress（只改善可见性）。`[历史事实]`

### 1.2 成功标准

同时满足，缺一不可。墙钟一律用 **assistant 间隔活跃墙钟**，不用 jsonl 首末跨度。

**活跃墙钟（可复算）** `[历史事实]` 口径来自 brief 对 `GrokDesignAuthor.jsonl` 的抽样定义；JSONL I/O 由 fixture/用户语料脚本负责，二者共用同一个只接收 assistant timestamp 序列的 pure helper（见 §5.3 / §6）：

1. 子 jsonl 中取带 `timestamp` 的 assistant 事件，按时间排序。
2. 相邻间隔 ≤10 min 计入活跃；>10 min 视为 park / keep-alive，不计入。
3. 活跃墙钟 = 计入间隔之和。assistant <2 条的会话不进入分位数样本。
4. 分类与 brief 相同：按子文件名分为 review/gate、scout、design/author、implement、other。
5. 对照基线窗口：2026-08-27–30（review/gate n=60，scout n=8）。实现后窗口：父目录日期 ≥ 实现合并日的新子会话。

**拟议验收目标**（实现后按上式复算）。下表数字是本设计选定的门槛，**不是** brief 已观测值，也**不是** 10 min / 40 req / 75% wrap-up 的因果承诺。`[拟议验收目标]`

| 层 | 样本 | 基线 `[历史事实]` | 拟议验收目标 |
|---|---|---|---|
| 产品默认 fixture | bundled `scout`，隔离 `~/.omp/agent/agents/*` 与 `task.agentModelOverrides` | 文件名类 scout：p50=14.8 / p90=15.8 min | 活跃 p50 ≤ **5.0** min，p90 ≤ **8.0** min |
| 产品默认 fixture | bundled `reviewer`（`thinking-level: medium`），同样隔离用户覆盖 | 语料混有用户 xhigh，无纯净产品基线 | 活跃 p50 ≤ **12.0** min，p90 ≤ **20.0** min；硬超时次数 = 0 |
| 用户可见语料 | 同 brief 文件名类 review/gate | p50=20.0 / p90=33.1 / ≥30 min=9/60 | 活跃 p50 ≤ **16.0** min，p90 ≤ **24.0** min，≥30 min ≤ **3**/同口径 n |
| 用户可见语料 | 文件名类 scout | p50=14.8 / p90=15.8 / ≥20 min=0 | 活跃 p50 ≤ **5.0** min，p90 ≤ **8.0** min |
| 用户可见语料 | `agent=scout`（含文件名 other，如 `CpampFeatures.jsonl`） | 该身份有 32.3 min / 102 轮已确认例 | 活跃 p50 ≤ **5.0** min |

- **treatment 与目标分离**：省略 caller runtime cap 的 task invocation 使用 explore 10 min hard cap；全 structured invocation 使用 explore 40 req / review 80 req与75% advisory wrap-up。它们都是待验证 treatment 参数。`[拟议验收目标]` 未测到上表 p50/p90 即不得宣称成功，也不得把 treatment 本身写成「必然达标」。默认 task explore 75% 检查点 = 7.5 min，距 p90≤8 仅30s；默认 task review 75% = 22.5 min，晚于 p90≤20。因此75% **不能**单独保证分位数目标；分位数依赖 keep-going / scout画像收口，cap只约束长尾。
- 产品 fixture 是**人工触发的 release latency qualification**，不是普通 CI 或 `bun run release` 的自动门。仅当 release mode 有效 PASS 时，才可对外宣称该版本达到本节产品延迟目标；跳过、凭据/额度不足、中断或样本不足均记 `UNVERIFIED`，不阻断普通 release，但禁止 latency success claim。未验证处理见 §6。
- 用户语料对比：新窗口 review/gate n≥20、scout n≥8 时复算上表；n 不足时不宣称用户层数字已达标，但不降低 fixture 门。
- **质量绝对合同**：Design Gate 仍是独立 native spawn；代码双轴仍可存在于用户 skill，不得合并成父进程内审换墙钟。`timeout` / `budget_stop` / 缺口不得计 PASS。最小扩展现有 `evaluateBenchmarkQualityGate`：当 `scorecard.liveQualityUnknown === false` 时，`permission-readonly-review` 与三个真实 `code_review` case（`review-security-paths`、`review-error-handling`、`review-state-transition`）的每一次 run 都必须 `firstPassed===true`，live 的 null/undefined/false 均 fail-close；unknown/fake/history 不施加该检查。known defect 仅经 fixture `successCriteria → passed → minPassRate:100` 间接 fail-close；benchmark 没有独立 `verdict` 字段或 verdict 门。
- **分层**：产品默认（所有用户）与用户级 skill/overrides（本机 grok+sol pair、`reviewer=sol:xhigh`）分开写、分开验。改用户文件不能当产品的唯一修复。
- **社区 hang 边界**：#4957 / #3629 按 §6 映射到真实测试名与 observable；#8462 / #5372 诚实标注现有测试完整性不足。本方案不得改其 owner 行为，不新增弱 smoke 冒充 prevention 回归；若实现 diff 触及其 owner，必须先回订设计并补真实 repro。
- **复用 owner**：禁止第二套 scheduler / 新 review 引擎 / 新 context 平台 / 第二 completion engine / 通用 role framework。

### 1.3 本次范围

- 产品层：把已有 Review/Gate 30 min + 80 req 从「四个 agent 名」收成 **fresh discovery 之后的单一 performance class**；75% 改为纯 advisory steer，不再写入 `budgetStopRequested`。给 explore（`scout`/`sonic`）更紧的已有预算/墙钟解析。
- 产品层：消除 bundled `scout.md`「几秒完成」与 `thinking-level: max` + 「MUST keep going until complete」的合同冲突；子代理系统提示按 explore / review / worker 分支 keep-going，不改 yield 协议。
- 产品层：明确接受两个内部 `sonic` 调用方进入 explore treatment：`cleanse/agent.ts` 的分片 worker，以及 commit-agentic `analyze-file.ts` 经 TaskTool 派发的逐文件分析。二者都是 bounded 分析；默认 setting 下吃10 min ceiling、40 req与 explore prompt/read 行为。cleanse checker discovery仍使用 `agent:"task"`，保持 worker合同。
- 产品层：补齐不经过 `runStructuredSubagent` 的 Vibe direct executor caller。`vibe/runtime.ts` 的 `#buildSpawnOptions` 已拿到 bundled `record.agent`，必须调用同一个中央 `resolveSubagentPerformanceClass({ agentName: record.agent.name, agentShadowReview: record.agent.shadowReview })`，把结果传给 `runSubprocess` 的 `ExecutorOptions`；不重复 discovery，不把 Vibe 迁入 structured runner。
- 产品层：75% runtime steer 的模型可见正文移入静态 `prompts/system/subagent-soft-runtime-notice.md`，`buildSoftRuntimeNotice` 保留为导入、插值与测试 seam。现有 request-count `buildBudgetNotice` 本轮不迁移。
- 用户层：只写推荐画像与编排约束（独立 Gate、双轴可留、spawn 必须带齐已有 `shadowReview: "code"`，并写明该旗标对 **performance class** 的80 req / review prompt后果，以及task+omitted runtime cap的30 min ceiling）。不把改 `~/.omp` 当产品唯一修复。
- 验收：活跃墙钟口径 + 与触及路径匹配的 hang 合同测试 + 8/26 质量绝对门（现有 paired cases + 最小扩展现有判定器）。

### 1.4 非目标

- 不重做 8/26 skill stub / wait 提示 / 已落地 30 min+80 cap **机制本身**（本轮只改分类时序、75% 终态与 explore 天花板数值）。
- 不重做 8/23 Grok thinking-loop / 空停字段。
- 不重做 8/03 ordinary session 模型/TTFT/工具池 A/B。
- 不把 8/20 grok fast-mode 当本轮主缺口。
- 不重做 8/29 live progress preview。
- 不改 yield schema / 畸形 yield 重试环 / post-yield 父 ingest / in-process `pushLoopPhase` / compaction。
- 不取消独立他审，不把 Gate/双轴并进父进程。
- 不新建 scheduler、第二 runtime、第二 completion engine、review 引擎、context 平台、通用 role 框架、feature flag、遥测管道。
- 不把 `shadowReview` 升格为通用 role framework；它仍是现有 `"code" | "off"` 字段，只作为 performance class 的**独立输入之一**。
- 不改 `task.agentIdleTtlMs` 来「藏」park 墙钟。
- 不改 Shadow 90s/120s（上界约 2 min，不是 20–70 min 主因）。`[历史事实]`
- 不改用户 `~/.omp/agent/config.yml` / 用户 agent / 用户 skill 作为产品唯一修复；本轮 design-only，连产品代码也不改。
- 不重跑会话统计、不再搜 Twitter。
- 不为 design/author、implement、worker `task` 设新的「变快」合同；design author 保持 worker，以免 30 min cap 砍掉独立设计起草。
- 不让 executor 在 `performanceClass` 缺失时按 agent name 重新分类，不恢复 legacy `scout`/`sonic` 名字预算；raw executor caller 要么显式传 class，要么按 worker 合同运行。
- 不为 Vibe 新建 structured runner / discovery pass / runtime owner；不在本轮迁移 legacy request-count budget notice。
- `read-summarize: false → true` 是取消 bundled scout 对摘要关闭的强制覆盖，属于真实 explore 工作量杠杆；其延迟与证据完整性影响幅度仍为 `[未知]`（见 §5.3 / §5.5）。

### 1.5 实现评审回流（2026-08-31）

Round 5 Gate 已对原方案给出 `PASS_WITH_NOTES`；随后实现代码评审发现两条会改变实施合同的新证据，因此本设计实质 reentry，旧 Gate revision 不再覆盖当前正文：

1. `packages/coding-agent/src/vibe/runtime.ts:#buildSpawnOptions` 直接构造 `ExecutorOptions`，`#registerTurnJob` 首轮直接调用 `runSubprocess`；该路径不经过 `resolveEffectiveSubagentPolicy`。当前实现未传 `performanceClass`，而 `packages/coding-agent/src/task/executor.ts:runSubprocess` 对缺失值按 worker 消费，导致 bundled `sonic` 从 legacy 100 req 实际回退到 configured/default 200 req，并漏掉 explore prompt/runtime-advisory treatment。
2. `packages/coding-agent/src/task/executor.ts:buildSoftRuntimeNotice` 当前内联拼接模型可见 runtime steer 文本；模型提示资产规则要求该正文由静态 prompt asset 持有。本轮指定 `packages/coding-agent/src/prompts/system/subagent-soft-runtime-notice.md` 为 owner，builder 只负责静态导入、渲染参数与保留测试 seam。

这两条只补调用面与提示 owner：不改变 runtime precedence、performance class matrix、12/42 qualification、未知延迟状态、Round 5 LOW resolutions，也不授权第二 engine/settings。

## 2. 背景与约束

- 新鲜语料：父 39 / 子 82；子文件首末墙钟 p50/p90/max = 19.3 / 33.7 / 1163.0 min；≥20 min=37、≥30 min=13。oh-my-pi 子集子 52，p50=20.0，p90=37.2，≥30 min=10。父 `tool_execution_start`：`task` 55 / `hub` 404。`[历史事实]`
- 1163 min 的 `GrokDesignAuthor.jsonl`：首末 assistant 跨 1155.7 min，相邻 ≤10 min 累计仅 42.7 min。文件首末墙钟含 park，不能当连续推理。`[历史事实]`
- 仍属活跃长任务的已确认例：`GrokStandardsAxis` 70.0 min / 63 轮 / `subagent-grok` `grok-4.6:xhigh` / read 167；`GrokSpecAxis` 53.0；`SpecReview` 43.6；`StandardsAxis` 43.3 / `reviewer` `sol:xhigh`；`CleanCodeDesignAuthor` 41.0；`CleanCodeDesignGate` 33.1 / `subagent-sol`；`DesignGate` 28.7 / 107 轮 / read 174；`CpampFeatures` 32.3 / scout / 102 轮；`StandardsFlash` 30.4 / `flash-reviewer` / 169 轮。`[历史事实]`
- `GrokStandardsAxis` `session_init`：`readOnly=false`，`readSummarize=false`，tools=`read,grep,glob,bash,lsp,yield,task,hub`，`spawns=scout`，`systemPrompt` 41186 字符；**不在** 30 min 名单。`[历史事实]`
- 产品合同：`task.maxRuntimeMs` 默认 1h；Review/Gate 额外 30 min 仅当名为 `reviewer` / `subagent-sol` / `sol-xhigh-reviewer` / `security-reviewer`。用户非 0 更严值仍赢，`0` 保持无限。`subagent-grok` / `grok46-reviewer` / `flash-reviewer` **不在名单**。reviewer-class soft budget=80，scout/sonic=100，默认 200。现有 75% timer 调用 `requestBudgetStop("runtime_timeout")`，协作式 yield 仍会得到 `completionKind="budget_stop"`。`[历史事实]`
- TaskTool 在 `#resolveSpawnPreflight` / `#runSpawn` 按 **name** 预计算 `maxRuntimeMs` 写入 `StructuredSubagentRequest`；`resolveEffectiveSubagentPolicy` 才 reload settings + discover agent；`buildExecutorOptions` 把请求里的预解析值原样交给 executor。`[历史事实]`
- bundled `scout.md`：tools 已收窄；model `deepseek-v4-flash:max` → `grok-4.6:xhigh`；`thinking-level: max`，`max-effort: max`，`read-summarize: false`；正文「few seconds」且「MUST keep going until complete」。新鲜 scout 文件名类 p50=14.8 min。`[历史事实]`
- `read-summarize` 经 kebab→camel 解析为 boolean；child settings / revive **只在 `readSummarize === false` 时写入** `read.summarize.enabled=false`；`true` 不覆盖父级关闭。schema 默认 `read.summarize.enabled=true`。`[历史事实]`
- 子代理完成协议是 `yield` + 「While work remains, you MUST continue」+「keep going until this ticket is closed」。Cursor 官方是 final message，无默认 4 维 shadow，无该 keep-going 段。`[历史事实]`
- Shadow 每维 90s、cohort drain 120s，fail-open。`isShadowReviewQualified`：spawn `"off"` 关闭 cohort，即使 frontmatter 为 `"code"`。`[历史事实]`
- 本机 dated receipt（不是仓库默认）：`async.enabled: true`，`task.enableLsp: true`（schema 默认 false），`task.agentModelOverrides.reviewer: gateway/gpt-5.6-sol:xhigh`（覆盖 bundled `thinking-level: medium`）。用户 agent `subagent-grok` / `subagent-sol` 均为 xhigh + `readSummarize: false` + full fidelity。用户 skill：设计 grok→sol；代码 Standards+Spec 双轴，每路 `shadowReview: "code"`。`[历史事实]`
- 公开 Twitter/X 无可持续引用的 omp-specific「subagent 30 分钟」帖；社区证据以 GitHub hang/楔死为主，与本机「xhigh 老实读 80–170 文件」不是同一类。`[历史事实]`
- 约束：复用 brief §9 owner；禁止新引擎；独立他审不可撤；design-only；过载文件先收边界——`REVIEW_GATE_AGENTS`（`task/index.ts`）与 `REVIEWER_AGENT_NAMES`（`review-performance.ts`）已是重复名单，本轮合并到 `review-performance.ts`，不新建 `roles.ts`。

## 3. 根因分析（按需）

### 3.1 是否需要根因分析

- 需要。
- 理由：用户明确要求根因；「产品默认 vs 用户 overrides vs hang vs parked 口径」会改变改哪一层、能不能只加更短 cap、以及能不能动 yield。成因未知会改变选型。

### 3.2 已确认事实

分层给出 **SUPPORTED 机制事实** 与 **WEAK_EVIDENCE 影响幅度**。机制事实支持「在现有 owner 上小步收紧并实测」；现有材料没有 request/tool timeline 或 treatment 对照，**不能**量化各因素对 scout p50=14.8 min、review/gate p50=20.0 min 的贡献，也**不能**证明 10 min / 40 req / 75% 必然打出 §1.2 分位数。`[历史事实]` / `[推导]`

**层 A — 产品默认**

- 内置 scout 自称几秒，配置却是 `thinking-level: max` + `max-effort: max` + keep-going；实测文件名类 scout p50=14.8 min（n=8），不是几秒。配置冲突 **SUPPORTED**；对 p50 的贡献幅度 **WEAK_EVIDENCE**。`[历史事实]`
- 全体子代理吃同一段 `subagent-system-prompt.md`：yield 是唯一完成协议，且「MUST keep going until this ticket is closed」。文本缺口 **SUPPORTED**；是否为主要耗时来源 **WEAK_EVIDENCE**（无 prompt-only A/B）。`[历史事实]`
- 30 min cap / 80 req 按 **四个字符串名** 生效，覆盖不到 `subagent-grok` / `grok46-reviewer` / `flash-reviewer`。hard-cap seam 不足 **SUPPORTED**；hard cap 只能约束尾部，不能单独证明正常完成的 p50 会下降。`[历史事实]`
- 现有 75% timer 调用 `requestBudgetStop`，与「完整 verdict = 正常完成」冲突。这是实施合同事实，不是墙钟主因。`[历史事实]`
- bundled `reviewer.md` 已是 `thinking-level: medium`，且已写「soft budget wrap-up 时 yield」。产品默认评审画像本身不是 xhigh。`[历史事实]`
- Shadow 4 维上界约 2 min，**不能**单独解释 20–70 min。`[历史事实]`
- 子 `task` 再扇出不是主爆炸面（8/26：子 `task` 仅 2；8/27–30 父 `hub` 404 vs `task` 55）。`[历史事实]`

**层 B — 用户 overrides / skills**

- 本机 `reviewer → sol:xhigh` 覆盖 bundled medium。`[历史事实]`
- 用户 agent 强制 full-fidelity read、`readSummarize: false`、xhigh。`[历史事实]`
- 用户 skill 把设计/代码评审派成 grok+sol（代码还是双轴），每路 `shadowReview: "code"`。这不是仓库 `task` 的唯一用法。`[历史事实]`
- 长尾活跃例几乎都是 `*:xhigh` 或 `*:max` + `readSummarize: false` + 几十到一百多次 `read`。叠加存在 **SUPPORTED**；各因子贡献幅度 **WEAK_EVIDENCE**。`[历史事实]`

**层 C — 社区 hang（与「慢但在干活」分开）**

- #4957/#5095：畸形 yield 重试，父死等。
- #8462：terminal yield 后父 TUI 直到 focus 才 ingest。
- #3629/#5372/#2081：in-process 同步处理 + O(n²) / 多子代理楔死。
- #1253：Gemini 429 误用 30 min cooldown（口头「30 分钟」，机制不同）。
- 这些是卡住/楔死，不是 xhigh reviewer 读 80–170 个文件。本轮主因 **NOT_APPLICABLE**。`[历史事实]`
- 修复是否已全部出现在用户当前安装二进制：`[未知]`（brief 未重跑）。

**层 D — parked 墙钟口径**

- `task.agentIdleTtlMs` 默认 7 min 后 park；park 计入文件首末 timestamp。`[历史事实]`
- 1163 min 文件活跃仅 42.7 min。若用首末跨度验收，会把 42 min 活跃报成 19 h。`[历史事实]`

### 3.3 未确认假设

- Cursor Explore / 同等委派的实测 p50/p90。`[未知]`
- 本机 reviewer 从 `sol:xhigh` 改回 bundled `medium` 后，Gate 检出 / first-pass verified success 降多少。`[未知]`
- 8/26 skill stub / wait 提示落地后，8/27–30 skill 重读是否已下降。`[未知]`
- `CpampFeatures.jsonl` 32 min / 102 轮是 brief 过宽还是 scout 画像失败。`[未知]`
- 公开 Twitter 是否存在未索引吐槽。`[未知]`
- 用户「Cursor 效果好」有多少来自父模型而不是子代理。`[未验证假设]`（Cursor 文档把收益写成 context isolation，不是速度。）
- `CleanCodeDesignGate.jsonl` 33.1 min 且 agent=`subagent-sol`（在 30 min 名单内）：是 cap 未进当前二进制、park 尾巴，还是 abort 清理。`[未知]` 因此 **不能** 把「再加更短 hard cap」当唯一杠杆。
- 10 min / 40 req / 75% 对分位数的边际贡献。`[未知]`

### 3.4 对设计的影响

- **主因是叠加，不是已量化的单层。** 产品默认把 explore 配成 max thinking + 全体 keep-going，并把 review cap 绑死在四个名字上；用户再叠加 xhigh + full fidelity + 双轴。只改用户文件 = 违反成功标准分层；只扩名单而不收口工作量 = 把 53–70 min 的 grok 评审砍成 timeout，违反质量门。该叠加是 **SUPPORTED 机制 + WEAK_EVIDENCE 幅度**。`[推导]`
- **只加更短 cap 不够，且 10/40/75% 不是必然达标。** review/gate 基线 p50 已是 20 min，30 min cap 不移动 p50；GrokStandardsAxis 63 轮 < 80 预算，80 也不绑中位数。p50 要动，必须改 explore/review 的 keep-going 与 scout 画像；p90 / ≥30 min 才主要由角色化 hard cap 吃掉 grok/flash 长尾。75% 只是 nudge。`[推导]`
- **75% 必须与 `budget_stop` 分离。** 按现文实施会让真正 wrap-up 的 reviewer 系统性假失败。修复落在现有 steer notice + 现有 `resolveSubagentCompletionKind`，不新造 completion kind。`[历史事实]`
- **hard cap / class 必须在 fresh reload + discovery 之后算一次。** TaskTool 预解析 name-cap 读不到 frontmatter，且会与 policy 后的 agent 不一致。`[历史事实]`
- **Shadow 不是本轮杠杆，也不是 performance class 的 precedence owner。** 不得为墙钟去关四维或把 `isShadowReviewQualified` 直接当 class 函数。`[历史事实]`
- **yield 不是本轮必须改的协议。** Cursor 文档明确子代理收益是隔离不是速度；社区 hang 正好钉在 yield / post-yield / in-process。更浅方案能在保留 yield 的前提下让 scout 进分钟级、让 review 长尾进 30 min 内。没有「A 无法满足的已确认约束」去证明必须分轨完成协议。`[推导]`
- **hub/wait 与 in-process 扇出不是本轮主杠杆。** 父 hub>>task 与 8/26 同型，已有 wait 提示 + 8/29 可见性；in-process 楔死是 hang 类。本轮只保证不回归。`[推导]`
- **验收必须用活跃墙钟，且 fixture 协议必须冻结。** 否则 park 或不同 percentile 算法会污染「优化成功」。`[历史事实]`
- **用户级 xhigh 使「全体 review p50≤12」在不改用户覆盖时没有已确认依据。** 故产品 fixture 用 ≤12；用户可见语料用 ≤16，并单独写可选更快画像。`[推导]`

## 4. 方案对比

### 4.1 方案 A — 角色合同落在现有预算/提示 owner（更浅）

- 核心思路：在 `review-performance.ts` / `structured-subagent.ts` / `executor.ts` 已有 cap、soft budget、steer notice、forced-yield 上，structured invocation 于 **fresh reload + discovery 之后**用已有信号判定 review / explore / worker **一次**。已持有 resolved bundled agent 的 Vibe direct caller 复用同一个纯 class resolver并显式传给 executor；executor 不做 fallback 分类。75% 只走现有 steer notice，不置 `budgetStopRequested`，其模型可见正文来自静态 prompt asset。bundled `scout.md` 与 `subagent-system-prompt.md` 的 keep-going 按 class 收口。**不改 yield 协议，不改 event-loop，不改用户文件作为产品修复，不新造 completion engine / role framework。**
- 优点：改动面限于 brief §9 已列 owner；两份重复名单可合并；社区 hang owner 不动；产品默认与用户层能分开验收；design author 无 `shadowReview` 时保持 worker；wrap-up 后完整 verdict 可与质量门同时成立。
- 缺点：用户仍选 sol:xhigh + full-fidelity 时，review p50 只能降到「十几分钟」而不是 Cursor 体感的很快；10/40/75% 对分位数的贡献未量化，fixture 可能首次未达标。
- 适用前提：成功标准允许 scout「分钟级」而非「几秒」；允许用户层保留 xhigh pair；确认不必为墙钟改完成协议。以上均已被 brief 支持或列为未知（Cursor 几秒无实测）。`[历史事实]` / `[未知]`

### 4.2 方案 B — 完成协议分轨（Cursor 式 final message + 方案 A 的角色合同）

- 核心思路：在 A 的全部杠杆之上，explore-class 改为「最后一条 assistant 文本即结果」（`requireYieldTool: false`），review/worker 仍走 yield。
- 优点：表面更像 Cursor Explore；弱模型少一次 yield schema 重试面。
- 缺点：必须改 `executor.ts` 完成路径与 yield 装配；直接碰到 #4957 / #8462 的协议面；为「分钟级」引入第二套完成语义。Cursor 自己写明收益是隔离不是速度，没有已确认数字证明分轨才能达标。`[历史事实]`
- 适用前提：必须先有「A 达不到 scout 分钟级 / review 质量门」的已确认约束。当前没有。`[推导]`

### 4.3 选型结论

- 选择：方案 A。
- 理由：A 与 B 都能对准 §1.2（B 只是多改协议）。两方案都能达标时必须选更浅落地。选 B 需要写出 A 无法满足的已确认约束——不存在；禁止用「以后更像 Cursor」当理由。
- 「只扩四个名字、不改 scout/keep-going、不修 75% 终态」**不是**合格方案：不移动 review p50，把 grok 长尾变成 timeout≠PASS，scout 仍约 15 min，且 wrap-up 会系统性 `budget_stop`。
- 实现评审后的最小补充仍属于方案 A：Vibe 在自己的 direct-call seam 以已解析 agent 调中央 class resolver；runtime notice 正文归静态 asset。拒绝三种更深/重复做法：executor 对缺失 class 按 name fallback（会恢复第二套 legacy policy）、把 Vibe 迁入新的 structured runner（重复 discovery/lifecycle）、继续在 TypeScript builder 内联模型提示正文。

## 5. 详细方案

### 5.1 核心思路

- **一个抽象**：`SubagentPerformanceClass = "review" | "explore" | "worker"`，纯函数，住在现有 `review-performance.ts`。不是新模块、不是 role framework。
- **一个 structured 权威时点**：`resolveEffectiveSubagentPolicy` 在 `reloadFromDisk` + `discoverAgents` 之后计算 **一次** class 与 `effectiveMaxRuntimeMs`，写入现有 `EffectiveSubagentPolicy` 的最小新字段。performance class、soft request budget 与提示适用于全部 structured subagent invocation；class wall-clock ceiling 只适用于 `invocationKind === "task"` 且 caller **省略** `maxRuntimeMs` 的调用。
- **Vibe direct caller 显式负责 class**：`#buildSpawnOptions` 对已解析的 bundled `record.agent` 调同一个 `resolveSubagentPerformanceClass({ agentName: record.agent.name, agentShadowReview: record.agent.shadowReview })` 并传入 `ExecutorOptions`；不重复 discovery。executor 只消费 class，缺失保持 worker，不按 name 重算。
- **显式 caller runtime authoritative**：`request.maxRuntimeMs !== undefined`（含0与>0）原样成为 effective runtime，不再套 class ceiling。TaskTool 不做角色推导也不传 runtime override；workflow adapter虽使用真实的 `invocationKind:"task"`，但显式传 profile cap，因此 cap原样保留。workflow schema retry 每 attempt 收窄的 `profile.maxRuntimeMs` 仍作为显式 caller cap原样直通。eval `agent-bridge.ts` 使用 `"eval"`并故意省略 cap，继承 fresh setting且不套 class ceiling。`StructuredRepairBudget.remainingTimeMs` 不流向 subagent runtime。删除 `task/index.ts` 的 `REVIEW_GATE_AGENTS` / `resolveTaskMaxRuntimeMs`。
- **75% 是 advisory**：复用现有 `sendUserMessage(..., { deliverAs: "steer" })`。hard cap 前正常 yield = `completed`。仅 request-count 1.5× forced stop = `budget_stop`。hard cap = `timeout`。不新增 completion kind，不改 `resolveSubagentCompletionKind` 优先级。
- **shadow 与 performance 分离**：`isShadowReviewQualified` 保持现有 precedence（spawn `off` 关 cohort）。performance class 用自己的 matrix（§5.2），不调用 eligibility 函数。
- **产品默认**：修 bundled scout 合同，并按 class 分支系统提示 keep-going。yield 对三类都保留。75% runtime notice正文由静态 `subagent-soft-runtime-notice.md` 持有，`buildSoftRuntimeNotice` 只负责渲染与测试；legacy `buildBudgetNotice`不迁移。
- **用户层**：独立文档化推荐画像；产品 class 认 floor 名 ∪ frontmatter `"code"` ∪ spawn `"code"`（explore 名优先）。本机双轴只要继续传该旗标就会自动吃 review-class。
- **质量**：现有 `evaluateBenchmarkQualityGate`；timeout / budget_stop / 缺口不算 PASS。Gate 仍独立 native spawn。

### 5.2 关键数据流 / 控制流

1. 父 `task` spawn（现有 `task/index.ts`）带 `params.agent` 与可选 `params.shadowReview`。
2. `#resolveSpawnPreflight` / `#runSpawn` 构造 `StructuredSubagentRequest` 时：**不传** `maxRuntimeMs`。禁止在 TaskTool 捕获 reload 前 setting，也禁止按 agent 名或 shadow 旗标预计算 class cap。`shadowReview` 原样转发。
3. `resolveEffectiveSubagentPolicy`（现有 owner）：`reloadFromDisk` → spawn/depth 校验 → `discoverAgents` → `getAgent` → 得到 `agent` / `effectiveAgent`。
4. **同一函数内、discovery 之后**调用 `resolveSubagentPerformanceClass({ agentName, agentShadowReview: effectiveAgent.shadowReview, spawnShadowReview: request.shadowReview })`，得到 `performanceClass`。
5. 先读取 `freshConfiguredMaxRuntimeMs = session.settings.get("task.maxRuntimeMs")`，再按真实 request signal 冻结 `effectiveMaxRuntimeMs`：
   - `request.maxRuntimeMs !== undefined`（显式0或>0）→ `effectiveMaxRuntimeMs=request.maxRuntimeMs`；caller override authoritative，**不**套 class ceiling。
   - 否则 `request.invocationKind === "eval"` → `effectiveMaxRuntimeMs=freshConfiguredMaxRuntimeMs`；保持 eval省略并继承 setting 的既有合同，**不**套 class ceiling。
   - 否则只能是 `invocationKind === "task"` 且 request cap omitted：base=`freshConfiguredMaxRuntimeMs`；base=0保持无限，否则 `effectiveMaxRuntimeMs=min(base, class ceiling)`。review ceiling=1,800,000；explore ceiling=600,000；worker ceiling=∞。
6. 只把 `performanceClass` / `effectiveMaxRuntimeMs` 写入 `EffectiveSubagentPolicy`。TaskTool 的 preflight 与 run 都重新执行该函数并从 fresh setting 解析；cleanse direct同样按每次调用 fresh解析。workflow虽为 `"task"`，但每次 attempt 的显式 profile cap原样直通；eval省略 cap并继承 fresh setting。**不在 TaskTool 或 executor 再 discover / 再分类**，不新增第三趟 discovery。
7. 下表是现有 **`runStructuredSubagent` 的完整调用 universe**，不是所有 raw executor caller；五个 structured 调用面按下表冻结：

| 调用面 | 真实入口 | `invocationKind` | request cap | wall-clock 结果 |
|---|---|---|---|---|
| TaskTool（含 commit-agentic `AnalyzeFile*` → `sonic`） | `task/index.ts` | `"task"` | omitted | fresh setting；非0再套 class ceiling |
| workflow adapter | `workflow/runtime-adapter.ts` → `runtime-default.ts` | `"task"` | explicit profile cap | caller cap原样；0或>0均不套 class ceiling |
| eval bridge | `eval/agent-bridge.ts` | `"eval"` | omitted | fresh setting原样；不套 class ceiling |
| cleanse checker discovery | `cleanse/agent.ts` direct，agent=`task` | `"task"` | omitted | worker：fresh setting（worker ceiling=∞） |
| cleanse `dispatchWorker` | `cleanse/agent.ts` direct，agent=`sonic` | `"task"` | omitted | explore：默认 setting下10 min ceiling |

`cleanse dispatchWorker` 与 commit-agentic逐文件 `sonic` 都有意进入 explore class：前者按 assignment 分片，后者按 file 分片，均是 bounded 分析。两者同时使用40 req、explore prompt与默认摘要行为；这不是遗漏或临时兼容例外。

Vibe 是非 structured direct executor caller，不加入上表计数：

| direct 调用面 | 真实入口 | 已解析 agent | class / runtime 合同 |
|---|---|---|---|
| Vibe 首轮 spawn | `vibe/runtime.ts:#buildSpawnOptions` → `#registerTurnJob` → `runSubprocess` | `#resolveWorker` 已返回 bundled `record.agent` | 调同一 central resolver并传 `ExecutorOptions.performanceClass`；不经过 structured policy、不新增 class ceiling，wall-clock 仍用 executor现有 setting/caller合同 |

8. structured 路径的 `buildExecutorOptions`：`maxRuntimeMs = policy.effectiveMaxRuntimeMs`；新增 `performanceClass = policy.performanceClass`。**不再**直接复制 `request.maxRuntimeMs`。Vibe 在自己的 `#buildSpawnOptions` 直接填该字段。
9. executor 消费：
   - hard cap timer：`options.maxRuntimeMs`（已是 effective）。到点 `requestAbort("timeout")` → `runtimeLimitExceeded` → `timeout`。
   - soft request budget：唯一 helper `resolveSoftRequestBudget(performanceClass, configuredBudget)`。越过预算仍走现有 notice → 1.5× `requestBudgetStop("soft_budget")` → `BUDGET_STOP_GRACE_REQUESTS`。`SOFT_REQUEST_BUDGET` 只保留 configured default；explore 名与40 req数值分别由 `EXPLORE_AGENT_NAMES` / `EXPLORE_SOFT_REQUEST_BUDGET` 持有，不保留 legacy `scout`/`sonic=100`。
   - 75% advisory：`resolveClassSoftRuntimeMs(performanceClass, maxRuntimeMs)`；到点只发 **一条** steer notice，**不**调用 `requestBudgetStop`。
   - 系统提示：`exploreClass = performanceClass === "explore"`，`reviewClass = performanceClass === "review"`。不从 agent 名重算；class缺失保持worker。
10. 子代理仍必须 `yield`。`requireYieldTool: true` 保持。Shadow cohort 仍由 `isShadowReviewQualified` 决定，90s/120s 不变。
11. 父合并结果、hang 路径、post-yield ingest、yield schema：**不改**。

**75% 与 completion 合同（冻结）**

现有 owner：`executor.ts` 的 `runtimeSoftTimeoutId`、`sendUserMessage(..., { deliverAs: "steer" })`、`requestBudgetStop`、`requestAbort("timeout")`、`resolveSubagentCompletionKind`。不新写 completion engine。

| 事件 | 置位 | `resolveSubagentCompletionKind` |
|---|---|---|
| 75% advisory + hard cap 前协作式 terminal yield | 仅发 steer；`budgetStopRequested=false`；`runtimeLimitExceeded=false` | `completed` |
| request-count 达 soft budget | 现有 `buildBudgetNotice` + steer（受 `task.softRequestBudgetNotice` 控制） | 仍 `completed`（尚未 forced stop） |
| request-count 达 1.5×，forced yield 成功 | `requestBudgetStop("soft_budget")` | `budget_stop` |
| 1.5× + grace 耗尽 | `requestAbort("budget")` → `budgetLimitExceeded` | `hard_abort` |
| wall-clock hard cap | `requestAbort("timeout")` → `runtimeLimitExceeded` | `timeout`（优先于仍为 true 的 `budgetStopRequested`） |
| caller signal / shutdown / terminate | 现有 abortKind | `hard_abort` |

- 75% notice **不**复用 `task.softRequestBudgetNotice`（该 key 只描述 request-count crossing）。不新增 settings key；review/explore 且 `effectiveMaxRuntimeMs > 0` 时才可能发送。
- runtime advisory 与 request-count notice 共用拟新增的 `wrapUpNoticeSent` latch；它由现有 `budgetSteerSent` 扩职并改名。任一路决定发送时先置 latch；真正调用 `sendUserMessage` 前再次检查 `resolved`、terminal yield、`abortSent`、`budgetStopRequested`。任一状态已成立则丢弃，且不补发。两事件同时触发只允许一条 notice。
- `sendUserMessage` rejection 只记现有 logger warning，不清 latch、不重试；force-stop、grace 与 hard-cap 语义不变。
- 不新增 `"soft_runtime"` checkpoint。75% 时点原本经 `requestBudgetStop("runtime_timeout")` 产生的 checkpoint 随 advisory 化一并移除，当前未发现消费者；hard timeout 与 request-count 触发的 checkpoint 保持不变。75% advisory 通过 steer spy/runtime contract test 观察。
- notice 函数：`buildSoftRuntimeNotice(softRuntimeMs, maxRuntimeMs)` 保留在 `executor.ts` 作为渲染/test seam；模型可见正文静态导入自 `prompts/system/subagent-soft-runtime-notice.md` 并由现有 `prompt.render` 注入两个数值。legacy `buildBudgetNotice`保持内联。

**performance class 与 shadow eligibility（分离）**

Floor 名（现有一份名单，迁到 `review-performance.ts`，删除 `task/index.ts` 副本）：`reviewer` / `subagent-sol` / `sol-xhigh-reviewer` / `security-reviewer`。

Explore 名（中央 `EXPLORE_AGENT_NAMES` 名单，不与预算数值混合）：`scout` / `sonic`。

`resolveSubagentPerformanceClass`（**不**调用 `isShadowReviewQualified`）：

1. agentName ∈ explore 名 → **explore**（explore 优先：不被 spawn/frontmatter `"code"` 升格为 review，以免 10 min 被放宽成 30 min）。
2. 否则 agentName ∈ floor 名 → **review**（spawn `"off"` **不**降级）。
3. 否则 `agentShadowReview === "code"` → **review**（spawn `"off"` **不**降级：agent 定义声明 review 意图；caller 只关 shadow cohort）。
4. 否则 `spawnShadowReview === "code"` → **review**（显式 performance opt-in）。
5. 否则 **worker**。

`spawnShadowReview === "off"` **只**关闭 shadow cohort（现有 eligibility）。它**不是** performance class 输入的否决项。

| # | floor 名 | frontmatter `code` | spawn | explore 名 | performance class | shadow eligible（enabled 且无其它否决时） |
|---|---|---|---|---|---|---|
| 1 | 是 | 任意 | 任意含 `off` | 否 | review | `off` → 否；`code`/缺省+fm code → 是 |
| 2 | 否 | 是 | `off` | 否 | review | 否 |
| 3 | 否 | 是 | 缺省 | 否 | review | 是 |
| 4 | 否 | 否 | `code` | 否 | review | 是 |
| 5 | 否 | 否 | `off` 或缺省 | 否 | worker | 否 |
| 6 | 否 | 任意 | `code` | 是 | explore | 是 |
| 7 | 否 | 是 | `off` | 是 | explore | 否 |
| 8 | 否 | 否 | 缺省 | 是 | explore | 否（无 fm code） |
| 9 | 否 | 否 | `code` | 否（普通 worker 名，含无旗标 `subagent-grok` 的反例） | review | 是 |

spawn `"code"` 作为 performance opt-in 的调用契约：该次 run 吃 review 的80 req、review prompt与75% advisory；若 `invocationKind === "task"` 且 request cap omitted，还吃30 min ceiling。误标在长时 TaskTool worker 上视为调用方选择，会被30 min/80收口；显式 caller cap或 eval invocation不套 class ceiling。design author 现有 skill **省略**该旗标，保持 worker。`shadowReview` 不升格为通用 role；assignment / output schema **不**参与 class（避免第二套校验引擎）。

### 5.3 接口 / 配置 / 数据结构变更

只列将改路径。现有符号按当前名字列出；拟新增或改名符号显式标注。

- 接口：
  - `packages/coding-agent/src/task/review-performance.ts`：
    - 保留 `REVIEWER_SOFT_REQUEST_BUDGET` / `REVIEWER_SOFT_RUNTIME_RATIO` / floor 名表。
    - 新增 `EXPLORE_SOFT_REQUEST_BUDGET = 40`、`REVIEW_GATE_MAX_RUNTIME_MS = 1_800_000`、`EXPLORE_MAX_RUNTIME_MS = 600_000`（从 `task/index.ts` 迁入 ceiling 常数）。
    - 新增 `SubagentPerformanceClass`、`resolveSubagentPerformanceClass`、`resolveClassMaxRuntimeMs`、`resolveClassSoftRuntimeMs`。不新增第二个 soft-request-budget helper。
    - 删除`resolveReviewerSoftRuntimeMs(agentName, …)`与`resolveReviewerSoftRequestBudget(agentName, …)`；runtime测试改走class helper，soft-request-budget测试改走唯一的`resolveSoftRequestBudget(performanceClass, configuredBudget)`。`isReviewerAgentName`仅供class函数识别floor名。
  - `packages/coding-agent/src/latency/active-wall.ts`（拟新增）：新增 pure `computeActiveWallMs(assistantTimestamps: readonly number[])`；只做 timestamp 排序、相邻差与 10 min gap 过滤，不读文件、不解析 JSONL。按仓库约定在 `packages/coding-agent/src/latency/index.ts` 增加 `export * from "./active-wall"`。fixture 与用户语料脚本负责 I/O 和 timestamp 提取；fixture 在调用现有 `percentile(sorted, p)` 前负责升序排序，分位数复用 `rollout-cohort.ts` 经 latency barrel 导出的 nearest-rank helper，不复制算法。
  - `packages/coding-agent/src/task/index.ts`：删除 `REVIEW_GATE_AGENTS` 与 `resolveTaskMaxRuntimeMs`。`#resolveSpawnPreflight` / `#runSpawn` 均省略 `maxRuntimeMs`。
  - `packages/coding-agent/src/task/structured-subagent.ts`：`EffectiveSubagentPolicy` 只增加 `performanceClass`、`effectiveMaxRuntimeMs`。fresh configured、request override与`invocationKind`仅参与 resolver局部计算；显式 request cap（含0）权威直通，eval omitted继承fresh setting，只有task+omitted对非0 setting应用class ceiling。`buildExecutorOptions` 使用两个 policy 字段，不再把 `request.maxRuntimeMs` 当作已套 class 的值。
  - `packages/coding-agent/src/vibe/runtime.ts`：`#buildSpawnOptions` 对已解析 bundled `record.agent` 调中央 `resolveSubagentPerformanceClass` 并写入 `ExecutorOptions.performanceClass`；不调用 structured policy、不重复 discovery、不新增 Vibe runtime ceiling。
  - `packages/coding-agent/src/task/executor.ts`：
    - `resolveSoftRequestBudget` 是唯一soft-request-budget seam，签名冻结为`(performanceClass, configuredBudget)`：explore cap=40、review cap=80、worker使用configured；0仍关闭。删除按agent name签名，不新增第二个class-named budget helper；name/frontmatter/spawn仅在`resolveSubagentPerformanceClass`出现。
    - `ExecutorOptions` 增加 `performanceClass`；缺失只按worker处理，不看agent name。`SOFT_REQUEST_BUDGET`删除legacy `scout`/`sonic=100`。
    - 75% timer 改为拟新增 `buildSoftRuntimeNotice` + steer；不 `requestBudgetStop`。builder静态导入并渲染 `subagent-soft-runtime-notice.md`；现有 `budgetSteerSent` 扩职/改名为拟新增 `wrapUpNoticeSent`，由 runtime 与 request notice 共用；enqueue 前执行终态复查，rejection 只日志。
    - 系统提示 render（约 L3340）增加 `exploreClass` / `reviewClass`，值来自 `options.performanceClass`。
    - `requireYieldTool: true` 保持。`resolveSubagentCompletionKind` 不改。
  - `packages/coding-agent/src/workflow/benchmark/runner.ts`：最小扩展现有 `evaluateBenchmarkQualityGate`。固定 required live case IDs 为 `permission-readonly-review`、`review-security-paths`、`review-error-handling`、`review-state-transition`。仅当 `scorecard.liveQualityUnknown === false` 时，对 baseline/optimized 每个 run 要求 `firstPassed===true`；live 的 null/undefined/false 均 fail-close，unknown/fake/history 不施加。现有 pass-rate、scope、completion kind、runtime provenance 与 quality-score 检查保持；known defect 仅由各 fixture 的 `successCriteria` 经 `passed` 和 `minPassRate:100` 间接约束，benchmark 无独立 verdict 字段或门。
  - `packages/coding-agent/src/shadow-mind/eligibility.ts`：**不改**。
  - 不改 yield assembly、worktree/isolation-runner、scheduler。
- 配置：
  - 不新增 settings key / feature flag。
  - `packages/coding-agent/src/config/settings-schema.ts`：只改 `task.maxRuntimeMs` / `task.softRequestBudget` 的 **description**：review-class = floor 名 ∪ frontmatter `"code"` ∪ spawn `"code"`（explore 名除外）；explore-class = `scout`/`sonic`；10/30 min class ceiling仅用于task invocation且caller省略runtime cap时，显式request cap权威直通，eval omitted继承fresh setting；40/80 req与class prompt用于全部structured invocation；75%是advisory steer，不是`budget_stop`。`task.softRequestBudgetNotice`描述保持「仅request-count crossing」。
  - 用户 `~/.omp/**`：产品方案不改。
- 数据结构：
  - 不新增 `AgentDefinition` 字段。继续用已有 `shadowReview?: "code"`（`task/types.ts` / `discovery/helpers.ts` `parseAgentFields`）。
  - 不新增 role enum、不新增 frontmatter `class`。
  - 不扩展 `SubagentCheckpointMetrics.kind`；advisory 没有持久化消费者。
  - `TaskItem` / `TaskParams` 的 `shadowReview?: "code" | "off"` 注释补一句：非 explore 上的 `"code"` 同时是 review performance opt-in（80 req；task+omitted runtime cap另有30 min ceiling）。
- 提示：
  - `packages/coding-agent/src/prompts/agents/scout.md`：`thinking-level: max` → `medium`；`max-effort: max` → `medium`；`read-summarize: false` → `true`（取消默认强制 false，见下方行为合同）；删除「You MUST keep going until complete」；保留 parallel tools；「few seconds」仅作目标句，不是 §1.2 门槛。model 链不动。
  - `packages/coding-agent/src/prompts/system/subagent-system-prompt.md`：用已有 Handlebars 分支改 § Completion 的 keep-going 句；yield 协议原文保留。
    - explore：回答完 assignment 立刻 terminal-yield 压缩发现；禁止「ticket 不关就不停」。
    - review：保留 incremental yield；verdict 就绪或收到 wrap-up steer 立即 yield，禁止为 completeness 继续搜（与 `reviewer.md` 已有条文对齐）。
    - worker：保持现有 keep-going + yield。
  - `packages/coding-agent/src/prompts/system/subagent-soft-runtime-notice.md`（拟新增）：只持有75% advisory模型可见正文及 `softRuntimeMs` / `maxRuntimeMs` 占位符，由 `executor.ts:buildSoftRuntimeNotice` 静态导入渲染；legacy request-count notice不迁入。
  - `packages/coding-agent/src/prompts/agents/reviewer.md`：wrap-up 条文已存在，不扩责；`spawns: scout` 保留。
- **`read-summarize: false → true` 行为合同（最小充分）**：
  - 现有 spawn（`executor.ts` createSubagentSettings）与 revive（`persisted-revive.ts`）都是 **false-only**：仅 `agent.readSummarize === false` / `init.readSummarize === false` 写入 `read.summarize.enabled=false`。`true` **不**覆盖父级关闭。
  - bundled scout 从 `false` 改为 `true` 的实质，是取消 spawn 与 revive 对 `read.summarize.enabled=false` 的现有强制写入，使未显式配置的用户回落到 schema 默认 true；它不是强制 true，用户显式关闭摘要时仍保持 false。
  - 该变化会让默认 scout 的 read 路径实际启用摘要，是与 thinking-level/medium、去 keep-going、explore 10 min/40 req及 class prompt并列的真实工作量杠杆；其对活跃墙钟与证据完整性的影响幅度仍为 `[未知]`，不得单独承诺达标。
  - 产品 fixture 的独立子进程使用空临时配置根，故采用 schema 默认 true。
  - 测试 owner：spawn precedence 加入既有 `packages/coding-agent/test/task/create-subagent-settings.test.ts`；revive precedence 加入既有 `packages/coding-agent/test/task/persisted-revive.test.ts`。不新建第三个合并测试文件。
  - `persisted-revive.ts` **不改**。
- 用户层（非产品唯一修复）：
  - `skill://design-brainstorm`：继续 Grok author → sol reviewer，禁止 grok 审 grok；Gate 必须独立 native spawn。
  - `skill://code-review` / `skill://subagent-grok` / `skill://subagent-sol`：双轴可留；**每路评审 spawn 必须继续传 `shadowReview: "code"`**，否则 grok 轴会再次落入 worker（1h/200）。这些 TaskTool spawn省略runtime cap，传该旗标即接受30 min/80 review performance。
  - 可选更快用户画像（用户自己改才生效）：`task.agentModelOverrides.reviewer` 回到 bundled medium；用户 agent 去掉「Read every assigned input at full fidelity」或打开 `readSummarize`。这是用户层加速，**不是**产品 PASS 条件。
- 实现落地时的用户可见说明：`packages/coding-agent/CHANGELOG.md` `[Unreleased]`；本次 re-Gate 通过后随实现一并核对。

### 5.4 错误处理与回退策略

- 先读取 fresh `task.maxRuntimeMs`。显式 request `maxRuntimeMs`（0或>0）为内部 caller authoritative cap并原样使用，不套class ceiling；request omitted + eval继承fresh setting且不套ceiling；request omitted + task时，fresh=0保持无限，否则与class ceiling取min。TaskTool、commit-agentic TaskTool与cleanse direct均省略；workflow虽为`"task"`但显式传profile cap；eval省略且kind=`"eval"`。schema repair的`remainingTimeMs`不参与subagent runtime。
- task+omitted的review-class碰到30 min hard abort：现有`requestAbort("timeout")`+salvage；`completionKind=timeout`；**Gate/双轴不得记 PASS**。workflow显式profile cap与eval omitted均不因class新增该ceiling。
- 1.5× soft budget forced-yield 成功：`budget_stop`；**不得记 PASS**。
- 1.5× 后 grace 仍不 yield：现有 budget abort → `hard_abort`；**不得记 PASS**。
- 75% advisory 之后 agent 给出完整 verdict + findings（或显式无 finding）并 terminal-yield：`completed`，可以过质量门。
- wrap-up / salvage 只有空正文或「没看完」：记缺口，不得记 PASS。
- task+omitted的explore-class 10 min abort：走现有 salvage；`completionKind=timeout`。若`summary`/`files`等scout schema已有内容，视为压缩handoff完成物，但kind仍是`timeout`，fixture计硬超时。explore不是Gate，不适用Gate PASS规则；fixture仍要求硬超时次数为0且活跃≤5/8 min。cleanse/commit内部调用方也不得把该timeout当成功。
- spawn 漏传 `shadowReview` 且非 floor、非 frontmatter `code`、非 explore 名：worker（1h/200）。不靠猜名字后缀补洞。
- Shadow 超时/跳过：fail-open，不阻塞主核（现有行为）。spawn `"off"` 只关 cohort，不改变 class。
- 畸形 yield / post-yield 父转 / in-process 楔死：走现有修复路径，本方案零改动。
- 人工 release latency qualification 未有效 PASS（含跳过、凭据/额度不足、中断、partial、有效样本不足、identity失败或 p50/p90 未达）：状态为 `UNVERIFIED`，不阻断普通 release，但禁止该版本作 latency success claim。不得改口径或放宽 treatment 冒充达标。质量门仍独立用 `evaluateBenchmarkQualityGate` 判定。
- 产品 kill switch 保持：`task.softRequestBudget===0`关闭request守卫（含1.5×）；task+omitted与eval omitted继承的`task.maxRuntimeMs===0`关闭hard cap与75% timer；任何显式request 0权威关闭该次wall-clock，workflow显式profile cap（0或>0）原样优先。qualification的skip是测试命令合同，不是产品feature flag；不新增settings key。

### 5.5 风险与缓解

- 风险：review wrap-up 让 findings 变少，质量回退。
  - 缓解：四个 required live review cases每次必须 first-pass 通过；known defect经 successCriteria/pass rate间接约束；timeout/budget_stop/缺口≠PASS；不把task+omitted review ceiling再压到15 min；75% 不再把完整 review outcome标成 `budget_stop`。
- 风险：scout `thinking-level: medium` 与取消 `read.summarize.enabled=false` 强制覆盖后，摘要可能漏掉全保真证据。
  - 缓解：scout 合同本就是压缩 handoff，不是 Gate；thoroughness 仍要求空搜至少换一策；三个真实 `code_review` required cases持续约束缺陷检出；对用户显式关闭摘要保持 false。该杠杆效果幅度标 `[未知]`，不单独归因。
- 风险：用户 xhigh 语料 p50 仍≈20，看起来「没优化」。
  - 缓解：分层验收；用户层 p90 / ≥30 min 必须先降（grok/flash 长尾进 cap）；p50≤16 依赖 keep-going 收口；可选更快画像单独写。不把改 `~/.omp` 当产品唯一 PASS。
- 风险：10/40/75% 首次打不出 §1.2 分位数。
  - 缓解：事先写明其为 treatment；未达标不得宣称成功；不在本轮为「凑数」改 yield 或加第二引擎。
- 风险：`shadowReview:"code"`误标在task+omitted worker上，被30 min砍断；显式caller cap或eval仍会应用80 req与review prompt但不套class ceiling。
  - 缓解：文档与schema description写明这是performance opt-in及caller-cap precedence；误标视为调用方选择。design author省略该旗标。负面测试覆盖worker+spawn code与frontmatter code+spawn off。
- 风险：cleanse较大assignment分片或commit-agentic较大单文件分析在10 min/40 req/explore摘要与收口提示下timeout或压缩掉证据；影响幅度`[未知]`。
  - 缓解：保留cleanse按assignment分片、commit按file分片的bounded边界；`timeout`/`budget_stop`不得冒充成功。cleanse现有`CleanseAgentOutcome.success=false`/error必须向loop与调用方显式暴露，commit TaskTool失败必须保留在tool result中。cleanse direct若未来确需更长，只能经设计明确传显式caller cap；commit TaskTool不新增per-call override。以qualification与真实功能验证确认效果。
- 风险：Vibe 绕过 structured policy；direct caller 漏传 class 会让 bundled `sonic` 再次按worker configured/default预算运行。
  - 缓解：分类仍只有中央 `resolveSubagentPerformanceClass` 一个owner；`#buildSpawnOptions`显式传class，executor不加name fallback掩盖遗漏；行为测试捕获真实交给`runSubprocess`的options并覆盖`fast`/sonic=explore、`good`/task=worker。
- 风险：runtime notice移入静态asset后模板变量错误会让75% steer缺数字或为空。
  - 缓解：保留`buildSoftRuntimeNotice`渲染/test seam，断言两个数值与收尾语义；legacy budget notice不迁移，避免扩大prompt diff。
- 风险：改系统提示时碰坏 yield 协议，回归 #4957。
  - 缓解：只改 keep-going 句子；yield 形状/重试/forced-yield 函数不改；§6 hang 测试必须保持绿。
- 风险：`CleanCodeDesignGate` 已在名单内仍见 33.1 min，说明只靠 cap 不可靠。
  - 缓解：主杠杆是工作量收口 + advisory wrap-up；cap 是长尾安全网；二进制是否含 8/26 cap 标 `[未知]`，实现后以 fixture 为准。
- 风险：同一 binary 的 live baseline/optimized 两臂共享新 bundled prompt 与新 class，无法构成旧 policy 对照。
  - 缓解：删除相对旧 subagent policy 的 first-pass 非回退声明和旧值字面表负面测试；live paired 只执行 absolute quality contract（live required cases 每 run first-pass；known defect经 successCriteria/pass rate间接约束；scope、kind与 provenance fail-closed）。不宣称不存在的 verdict 门。
- 风险：人工 release qualification 需要最多42次外部模型调用，可能因凭据、额度、provider 可用性或人工中断未完成。
  - 缓解：由获授权且具凭据的 release maintainer显式运行；固定调用上限与并发1；任何 partial 均不 PASS；未运行或失败记 `UNVERIFIED`，不阻断普通 release但禁止 latency success claim。凭据只走既有 provider认证，不记录 secret。

## 6. 验证计划

本轮是实现评审触发的实质设计修订；下列门、owner 与 producer-to-gate 链在独立 re-Gate 通过后继续用于已授权实现，只报告新鲜运行结果。

### 6.1 谁覆盖什么

| 合同 | 覆盖层 | Owner / 路径 | 进入 `evaluateBenchmarkQualityGate`？ |
|---|---|---|---|
| performance class matrix、`off` 不降级、explore 不被 `"code"` 升格 | contract runtime | `packages/coding-agent/test/task/review-performance.test.ts` | 否 |
| runtime precedence：TaskTool request恒省略；task+omitted对fresh非0 setting套class ceiling，0保持无限 | contract runtime | `packages/coding-agent/test/task/task-spawn.test.ts` + `packages/coding-agent/test/task/structured-subagent.test.ts` | 否 |
| runtime precedence：workflow adapter真实传`invocationKind:"task"`与显式profile cap；显式0/>0（含>ceiling）均原样权威直通 | contract runtime | `packages/coding-agent/test/workflow/runtime-adapter.test.ts` + structured resolver contract | 否 |
| runtime precedence：eval bridge传`"eval"`且恒省略request cap；继承fresh setting并不套class ceiling | contract runtime | 既有或扩展 `packages/coding-agent/test/eval/agent-bridge.test.ts` / `agent-bridge-policy.test.ts` | 否 |
| internal sonic policy：cleanse direct与commit TaskTool的`sonic+task+omitted`=explore 10 min/40 req；direct explicit caller cap不套ceiling | contract runtime | 中央行为放入既有 `packages/coding-agent/test/task/structured-subagent.test.ts`；soft budget放入既有`executor-soft-budget.test.ts` | 否 |
| internal sonic调用方邻接与失败暴露 | functional adjacency | 运行既有`packages/coding-agent/test/cleanse.test.ts`与`packages/coding-agent/test/commit-agentic-attribution.test.ts`；见下方覆盖边界 | 否 |
| Vibe direct executor caller：`fast`/bundled `sonic`传`explore`，`good`/bundled `task`传`worker` | direct caller contract | 扩展既有`packages/coding-agent/test/vibe/spawn-model-role.test.ts`，捕获真实传给`runSubprocess`的`ExecutorOptions.performanceClass` | 否 |
| 75% steer 且 yield → `completed`；与 request notice 同时触发只发一次；terminal race/rejection 不续跑；静态asset正确渲染两个runtime数值 | contract runtime / prompt | `packages/coding-agent/test/task/executor-wall-clock.test.ts` + `executor-async-quiescence.test.ts`，复用`buildSoftRuntimeNotice` seam | 否 |
| 1.5× → `budget_stop`；hard cap → `timeout` | contract runtime | 现有 `executor-soft-budget.test.ts` / `executor-wall-clock.test.ts` / `resolveSubagentCompletionKind` 行为 | 否（单测）；质量门侧已有 kind 拒绝 |
| `readSummarize` false-only precedence（spawn + revive） | contract runtime | 既有 `create-subagent-settings.test.ts` + `persisted-revive.test.ts`；parser 仍由 `agent-fields.test.ts` 覆盖 | 否 |
| live required cases 每 run first-pass；successCriteria/pass rate、kind、scope、provenance fail-closed | live paired absolute contract | 真实 suite IDs + 最小扩展现有判定器 | **是** |
| smoke p50/max、release p50/p90、硬超时=0、bundled identity | 人工 release latency qualification | §6.3；不进入普通 CI/release | **否** |
| hang 边界 | 与触及路径相关的现有真实 regression | §6.4 | 否 |

不再测试“新 helper 与旧值字面表不同”，也不构造旧 subagent policy runtime。分类/预算单测只断言新公开合同；质量由 §6.2 的 absolute cases 负责。

runtime precedence测试矩阵必须逐来源独立覆盖，不可用同一条helper单测代替：

- TaskTool：setting使用默认非零、0、比class ceiling更严的非零；均断言request field为`undefined`，effective分别按fresh setting执行min/0合同。`sonic`覆盖默认1h→10 min；review覆盖默认1h→30 min；preflight与run两次fresh读取行为保持。
- workflow：真实runtime adapter断言`invocationKind:"task"`且profile cap被显式传入。resolver contract覆盖显式request `0`、低于ceiling的非0、**高于ceiling的非0**均`effectiveMaxRuntimeMs===request.maxRuntimeMs`，证明caller authoritative且不套class ceiling。
- eval：`agent-bridge`断言`invocationKind:"eval"`且请求恒省略`maxRuntimeMs`；setting为默认非零、0、以及高于review/explore ceiling的非零时均继承fresh值，证明不套class ceiling。
- cleanse direct：中央policy用真实形状`agent:"sonic"`+`invocationKind:"task"`+omitted request cap覆盖默认10 min/40 req；另覆盖显式caller `maxRuntimeMs`大于10 min仍原样，证明只有直接`runStructuredSubagent`内部调用方可明确override。cleanse checker discovery的`agent:"task"`保持worker合同。
- commit-agentic：经TaskTool的`AnalyzeFile*`不新增per-call runtime override，复用TaskTool `sonic+task+omitted`中央合同。
- Vibe：复用现有spawn capture seam，断言`fast`/bundled `sonic`的class为explore、`good`/bundled `task`为worker；不得改走structured runner或只扫源码字面。
- workflow schema retry：每个attempt按已耗时收窄`profile.maxRuntimeMs`，该次实际值作为显式caller cap原样直通；测试按每次真实传入值断言，不假定attempt间恒定。
- schema repair：`StructuredRepairBudget.remainingTimeMs`不流向`StructuredSubagentRequest.maxRuntimeMs`；不得与上一条混成新runtime seam。

既有`cleanse.test.ts`与`commit-agentic-attribution.test.ts`当前只列为调用方邻接运行范围，**不虚构其已证明timeout/error传播**。若实现后现有断言不能观察失败向上层暴露，新增或扩展测试必须触发真实`timeout`/`budget_stop`结果并断言cleanse outcome/loop状态或commit tool result的错误映射；不得读取源码检查`sonic`、`invocationKind`或参数字面，也不得用“调用过”式 tautology代替行为合同。

### 6.2 质量绝对门（复用，不新建判定器）

- 判定器：`evaluateBenchmarkQualityGate`（`packages/coding-agent/src/workflow/benchmark/runner.ts`）。默认 `minPassRate: 100`、`maxPassRateDropPp: 3`、`maxQualityDropPp: 3`。不把 3% 改成 live 熔断器。
- **required live review cases**（固定 ID，不由配置放宽）：
  - `permission-readonly-review`：known ambient-secret risk 必须经 success criteria检出；readonly scope；结构化 review artifact。
  - `review-security-paths`：known traversal finding 必须被证据化。
  - `review-error-handling`：known swallowed error 与状态不一致必须被发现。
  - `review-state-transition`：两个 known state risks 均须评估且 findings 引证据。
- producer：现有 `packages/coding-agent/src/workflow/runtime-default.ts` → structured runner → `BenchmarkRunResult`（`completionKind`、`firstPassed`、`passed`、`qualityScore`、`scopeStatus`、`runtimeProvenance`、`durationMs`）。命令入口`packages/coding-agent/src/cli/workflow-bench-cli.ts`以`mode === "live"`设置`liveQualityUnknown=false`；`buildScorecard`未显式传值时默认`true`，因此不施加required firstPassed检查。
- 仅当 `scorecard.liveQualityUnknown === false` 时，`evaluateBenchmarkQualityGate` 直接检查 required IDs 的 `summary.runs`：每个 baseline/optimized run 都须 `firstPassed===true`；live 的 `null`（未观测）、`undefined` 与 `false` 均 fail-close，且一个成功 run不能抵消另一个失败/未观测 run。`liveQualityUnknown === true` 的 unknown/fake/history scorecard不施加该检查，保留 `firstPassed` 的既有“未观测可为空”合同。
- known defect **没有独立 gate 字段**：由上述四个 fixture 的 `successCriteria` 决定 `passed`，再经 `minPassRate:100` 间接 fail-close。benchmark 目录没有 `verdict` 字段，本方案不新增 verdict 门。
- `packages/coding-agent/test/workflow/p012-production-wiring.test.ts` 在现有 budget-stop/missing-kind 合同上，使用全部四个真实 required IDs 测试：显式live（`liveQualityUnknown=false`）任一run的`firstPassed=false/null/undefined`均失败；全部为true且`passed`、scope、completion kind、runtime provenance满足既有门才通过。另显式覆盖`buildScorecard`省略该参数的默认unknown分支，以及`liveQualityUnknown===true`的fake/history分支，二者均不受新增firstPassed检查。
- live baseline/optimized 是现有 presentation/profile experiment，二者共享新 subagent policy。它们只证明 absolute contract，不证明新 policy 相对旧 policy 的质量变化。正文不再作后者声明。
- treatment 导致 `timeout`/`budget_stop`、fixture success criteria未满足、scope 非预期或 provenance 缺失时，现有 gate继续 fail-close，不得为过门放宽。

### 6.3 人工 release latency qualification（冻结）

- **拟新增唯一支持入口**：在 root `package.json` 增加明确 scripts：
  - `"test:latency:smoke": "bun packages/coding-agent/test/task/product-latency-fixture.ts --mode smoke"`
  - `"test:latency:release": "bun packages/coding-agent/test/task/product-latency-fixture.ts --mode release"`
  - `packages/coding-agent/test/task/product-latency-fixture.ts` 为拟新增父/子双模式脚本；不接入 `ci:test:ts`、普通 `bun test` 或 `scripts/release.ts`，避免隐性外部调用和费用。
- **owner / 阻断范围**：仅由获明确授权、具备现有 provider凭据的 release maintainer人工触发。普通 release不因未运行或未完成而阻断；但只有 `test:latency:release` 有效 PASS 后，才可对外宣称该版本达到 §1.2 产品延迟目标。未运行、skip或失败统一为 `UNVERIFIED`，禁止 latency success claim。
- **调用硬上限**：smoke 最多12次（2 variants × (1 warmup + 5)）；release 最多42次（2 variants × (1 warmup + 20)）；fixture不得因 retry、identity失败或局部错误超过上限。全局并发=1。任一 child abort/timeout、父进程中断或 partial result均不 PASS。
- **凭据与报告**：认证只经既有 provider认证链获取；fixture 不新增 credential key、不直接读取或记录 secret。报告仅含实际调用次数、模型身份、elapsed，以及现有 runtime已经提供时的 token usage；不估算费用。
- **skip contract**：凭据缺失、额度不足、provider不可用或 maintainer主动中断时，命令以非 PASS 状态结束并输出 `UNVERIFIED` 原因；这是 qualification 命令的跳过合同，不是产品 feature flag，不新增 settings key。
- **隔离方式**：父模式为每个 repetition 创建独立 `tempHome`，并固定 `tempCwd=tempHome/workspace`；该目录及其到 `tempHome` 的祖先不含 project agent配置，使 `discoverAgents` 的向上遍历在 homedir边界停止。再用 `Bun.spawn([process.execPath, fixturePath, "--child", ...])` 启动新进程。child env 从当前 env 复制后显式设置 `HOME=tempHome`、`USERPROFILE=tempHome`、`PI_CONFIG_DIR=.omp-latency-fixture`、`OMP_PROFILE=""`、`PI_PROFILE=""`；将 `XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME` 指向 `tempHome` 下独立目录，并删除继承的 `PI_CODING_AGENT_DIR`、`COPILOT_HOME`、`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`。`XDG_CONFIG_HOME` 也指向临时目录，但它不是 `pi-utils/dirs.ts` 的输入，只用于一并隔离 lspmux、github-cache 等其它消费者。所有 env 必须在 child import产品模块前生效。
- child 内可用 `Settings.isolated()` 防止内存配置串扰，但它**不承担 discovery 隔离**；真正隔离来自新进程 + 临时 HOME/config root + 干净 cwd。比同一 test process 修改全局 env/目录 resolver 安全，因为 module-load cache 不跨 repetition，且不会污染全套测试。
- **bundled-only 断言**：每次 dispatch 前记录并断言 `effectiveAgent.source==="bundled"`。scout identity 必须匹配修订后的 bundled model chain、`thinkingLevel=medium`、`maxEffort=medium`、`readSummarize=true`；reviewer 必须匹配 bundled model chain、`thinkingLevel=medium`、`maxEffort=xhigh`、frontmatter `shadowReview="code"`。任一来源或 identity 不符，整次 fixture fail，不允许回退为无效样本后继续过门。
- **Producer**：child 调用现有 `TaskTool` / `runStructuredSubagent`，不新建 runner；输出 JSONL 字段为 `variant`、`repetition`、`completionKind`、`durationMs`、`activeWallMs`、`runtimeProvenance`、`hardTimeout`、`effectiveAgentSource`、`effectiveModel`、`effectiveEffort`、`effectiveFrontmatterIdentity`，以及现有 runtime可提供时的可选 `tokenUsage`。
- **Active-wall owner**：fixture读取 child JSONL并提取带 timestamp 的 assistant 序列，再调用 `src/latency/active-wall.ts` 的 `computeActiveWallMs(timestamps)`。pure helper不做 I/O。fixture 对样本升序排序后，调用 latency barrel 导出的现有 `percentile(sorted, p)`。
- **样本量**：每 variant 先 1 次 warmup并丢弃。smoke 计 5 次，只报告/门禁 p50、max、hard timeout与 identity，**不计算或报告 p90**。release 每 variant计 20 次，以 nearest-rank 报告 p50/p90；两 variant共 42 次模型执行（含 warmup），接受该成本作为发布级 p90 的最低样本成本。
- **Percentile**：nearest-rank、1-indexed；p50/p90 由现有 central helper计算，禁止插值和本地副本。用户语料门保持原规则：review/gate n≥20、scout n≥8；不足时不宣称用户层达标。
- **顺序 / 并发**：先 scout 后 reviewer；variant 内串行；全局并发=1；任何 retry也不得突破该 mode调用硬上限。
- **Cache**：warmup 后才计入；两 variant 使用独立 session/artifacts，不共享 provider prompt-cache 作为达标手段。
- **模型身份**：bundled frontmatter model 链；fixture 跑 `strictModelIdentity: true`；必须有 `runtimeProvenance`；身份混合/缺失 → 该次无效，不进分位数，且 latency 门失败。
- **资格结果**：smoke 的 p50/max、release 的 p50/p90、任一 hard timeout、有效样本不足、identity失败或 partial均使对应命令不 PASS。release mode有效 PASS是 latency success claim 的必要条件；其他结果统一 `UNVERIFIED`。允许报告已得数字，但禁止据此宣称达标。禁止改10 min gap、改 percentile或把 treatment当成已达标。
- scout assignment：bounded（定位 `resolveTaskMaxRuntimeMs` 的后继 `resolveClassMaxRuntimeMs` 定义与调用方）。reviewer assignment：小 diff + 证据包，必须产出 verdict。人为拖到 timeout 的 replay **不得**记质量 PASS。

### 6.4 hang 映射与实现边界

不得用 issue 编号代替绿测，也不得用 `setTimeout(0)` 最终触发冒充 liveness prevention。本方案不触及 post-yield ingest、`pushLoopPhase`、`EventLoopKeepalive` 或 TUI loop watchdog owner。

| Issue / 故障 | 现有测试路径与测试名 | Observable contract | 完整性 | 本方案动作 |
|---|---|---|---|---|
| #4957 畸形 yield 重试、父死等 | `packages/coding-agent/test/tools/yield.test.ts` — `aborts instead of throwing forever after repeated untyped empty results`；`resets the untyped empty-result retry budget after a valid yield`。`packages/coding-agent/test/task/executor-subagent-reminders.test.ts` — `fails instead of waiting forever when yield submit errors repeat`；`fails when malformed yields repeat after an incremental yield section` | yield 工具在空 result 重试耗尽后 `status=aborted` 且文案含 `retrying forever`；executor 在 6 次 invalid yield 后退出，`stderr` 含 `invalid yield results 6 times` / `infinite submit loop`，父不等待无限重试 | 现有测试覆盖该合同，源码未标注 #4957；验收以测试名为准 | 保持绿；不改 yield schema / `MAX_YIELD_TOOL_ERRORS` |
| #8462 terminal yield 后父 TUI 直到 focus/resize 才 ingest | CHANGELOG 有修复记录；`executor-async-quiescence.test.ts` 的 `does not wait on a second idle barrier after a terminal yield` 仅是 child quiescence | 用户可见：terminal yield 后父 ingest/render 不依赖 focus/resize | **仓库内未定位到完整 prevention regression** | 本轮不新增测试、不声称覆盖；实现 diff 若触及 post-yield ingest / keepalive / parent idle-flush，先回订设计并加入能在旧失败路径复现的真实 integration test |
| #3629 mid-run compaction O(n²) 楔死 TUI | `packages/coding-agent/test/turn-persistence.test.ts` 全文件；文件头写明替代旧 O(n²) branch rebuild + `JSON.stringify` compare（issue #3629）。含 `assistant identity covers timestamp/provider/model/responseId/stopReason — different content keeps the same key` 及 `planTurnPersistence` 单次扫描合同 | persistence key 是逻辑身份；planner 一次扫描，不重走 branch；同 key 不同 content 不双写 | 现有完整 helper 回归 | 保持绿；不改 `turn-persistence.ts` |
| #5372 多子代理 event-loop 楔死（9 child / 100% CPU） | `packages/tui/test/loop-watchdog.test.ts` — `LoopWatchdog long-block classification` / `reports a CPU-bound wedge longer than sleepMs instead of discarding it` | 只验证长 CPU wedge 的监测分类，**不**证明9-child prevention | 仅监测，非 prevention | 本轮不新增测试、不声称完整覆盖；实现 diff 若触及 in-process progress、`pushLoopPhase` 或 loop watchdog，先回订设计并补有 bounded latency 与真实并发处理 owner 的 repro |

实现验证只运行与实际diff触及路径相关的现有测试：performance/class、structured runtime、workflow runtime adapter、eval agent bridge、Vibe `spawn-model-role.test.ts`、executor wall-clock/soft-budget、`cleanse.test.ts`、`commit-agentic-attribution.test.ts`、`executor-async-quiescence.test.ts`、prompt/frontmatter、`create-subagent-settings.test.ts`、`persisted-revive.test.ts`、required quality gate，以及因executor/yield边界相关而保留的#4957 regression。静态runtime notice通过`buildSoftRuntimeNotice` seam与75%行为验证；legacy budget notice不迁移。cleanse/commit既有测试仅作邻接回归，除非新增上节所述可观察失败映射断言，否则不宣称其已证明timeout传播。#3629可作为邻接完整性检查但不宣称本轮修复；#8462/#5372不列为本轮passing证据。

### 6.5 根因前提复核与明确不做

- 实现后抽样确认：TaskTool的`subagent-grok`+`shadowReview:"code"`省略request cap时，`policy.performanceClass==="review"`且`effectiveMaxRuntimeMs≤1_800_000`；无旗标的design author仍为worker，可超过30 min而不被误杀；frontmatter `"code"`+spawn `"off"` class仍为review且shadow关闭。另确认workflow显式profile cap原样、eval omitted继承fresh setting、cleanse/commit `sonic+task+omitted`落explore。
- 不做：Twitter 再检索；会话全量重统计（除非实现后验收窗口）；改 `~/.omp` 再宣称产品层 PASS；用 issue 编号代替 §6.4 测试名；为 #8462/#5372 新增弱 timer smoke。

## 7. 关键决策摘要

- 规模 L；根因分析需要。机制层 SUPPORTED（名单漏覆盖、统一 keep-going、scout max、用户 xhigh 叠加、75% 现为 budget stop、hard cap 预解析过早）；影响幅度与 10/40/75% 效果 WEAK_EVIDENCE。Shadow≠主因；hang≠慢；parked≠活跃。
- 推荐方案 A。方案 B 更深且无已确认必要约束。
- 单一class owner=fresh discovery后的`resolveEffectiveSubagentPolicy`。先读fresh setting；显式request cap（0或>0）为caller authoritative并原样使用；request omitted+eval继承fresh setting且不套ceiling；request omitted+task对fresh非0值套class ceiling，0保持无限。TaskTool、cleanse direct与eval均省略request runtime，但eval以`invocationKind:"eval"`分流；workflow真实使用`"task"`并显式传每attempt profile cap，因此原样直通。schema repair remaining time不流入subagent runtime。
- 上一条只覆盖structured universe。Vibe是非structured direct executor caller：`#buildSpawnOptions`用已解析bundled agent调同一central resolver并传`ExecutorOptions.performanceClass`；不重复discovery、不新增class ceiling。executor对缺失class保持worker，不按name reclassify。
- review-class = floor 四名 ∪ frontmatter `"code"` ∪ spawn `"code"`，但 explore 名优先为 explore。spawn `"off"` 只关 shadow cohort，不降 performance class。不新增 `class` 字段，不按名字后缀猜测，不把 `shadowReview` 升格为 role framework。
- explore-class=`scout`|`sonic`。task+omitted treatment：10 min ceiling；全部structured invocation：40 req+explore prompt+75% **advisory**。cleanse分片worker与commit逐文件分析明确接受该treatment；timeout/budget_stop必须暴露，不能冒充成功。scout提示改为medium thinking，去掉keep-going-until-complete；`read-summarize: false→true`取消默认child强制关闭摘要，是真实但效果幅度未知的工作量杠杆，显式关闭仍保持false。
- soft request budget只有`resolveSoftRequestBudget(performanceClass, configuredBudget)`一个seam；name/frontmatter/spawn仅参与`resolveSubagentPerformanceClass`。`SOFT_REQUEST_BUDGET`只保留configured default；explore名单与40 req值各有唯一owner，不保留legacy 100。
- 75% ≠ `budget_stop`。现有 `budgetSteerSent` 扩职/改名为拟新增 `wrapUpNoticeSent`，runtime/request notice共用并在终态前复查；75% 原 checkpoint随 `requestBudgetStop` 移除且无已知消费者，hard timeout/request-count checkpoint保持。模型可见runtime正文归静态`prompts/system/subagent-soft-runtime-notice.md`；`buildSoftRuntimeNotice`保留渲染/test seam，legacy budget notice不迁移。
- worker（含无旗标的 `subagent-grok` design author、通用 `task`）保持 yield + keep-going + 1h。
- 全体子代理继续 yield；不把 explore 改成 final message。
- 独立他审保留；双轴是用户 skill 选择，不是产品必删项。
- 用户 `sol:xhigh` / full fidelity 不是产品默认，也不能当产品唯一修复；用户语料门槛与产品 fixture 分开。
- 验收：由 release maintainer人工运行 `test:latency:smoke` / `test:latency:release`；不接入普通 CI/release。smoke最多12次，release最多42次；n=5不报p90，release p90每 variant n=20。非有效 release PASS均为 `UNVERIFIED`，不阻断普通 release但禁止 latency success claim。
- 质量：`workflow-bench-cli.ts`以`mode==="live"`设置`liveQualityUnknown=false`；现有`evaluateBenchmarkQualityGate`仅在该值为false时，对`permission-readonly-review`加三个真实`code_review` IDs执行每-run `firstPassed===true`；live null/undefined/false fail-close。`buildScorecard`默认true时不施加该检查；p012覆盖显式live与默认unknown。known defect仅经successCriteria/pass rate间接约束；无verdict门。
- active-wall pure helper位于拟新增 `src/latency/active-wall.ts`，接入 `src/latency/index.ts` 星号 barrel；fixture排序后复用现有 `percentile(sorted,p)`。
- hang：#4957/#3629 有真实映射；#8462/#5372 现有完整性不足，本轮不新增弱测试或宣称覆盖。实现若触及其 owner，先回订设计并补真实 repro。
- `EffectiveSubagentPolicy` 只新增 `performanceClass`、`effectiveMaxRuntimeMs`；不新增 `configuredMaxRuntimeMs` 或 `"soft_runtime"` checkpoint。
- implementation_authorization=implementation-authorized、当前因实质design reentry暂停；replacement author为GPT-5.6-sol，原因是Grok author job stalled/cancelled。下一reviewer固定Claude Opus 5，Grok与GPT-5.6-sol均不得自审。本修订必须重跑独立Gate；PASS/PASS_WITH_NOTES后恢复用户已授权的实现。

## 8. Handoff

### 8.1 同会话继续

宿主原生路径：触发只读 `Claude Opus 5 / claude-opus-5-thinking-high` 独立 Design Review Gate。Grok 4.6 与 GPT-5.6-sol 均参与正文；本轮 replacement author 是 GPT-5.6-sol（Grok author job stalled/cancelled），二者及其同模型实例不得担任 reviewer。

Reviewer 必须完整读取 design + facts brief，从 raw bytes 生成按 normalized path 排序的 path + SHA-256 `Reviewed Inputs` manifest 与新 `reviewed_revision`。以下实现评审证据是 Gate evidence、不是 Reviewed Inputs：

- `packages/coding-agent/src/vibe/runtime.ts:#resolveWorker`、`#buildSpawnOptions`、`#registerTurnJob` → `runSubprocess`
- `packages/coding-agent/src/task/executor.ts:runSubprocess`、`resolveSoftRequestBudget`、`buildSoftRuntimeNotice`
- `packages/coding-agent/src/task/review-performance.ts:resolveSubagentPerformanceClass`
- `packages/coding-agent/test/vibe/spawn-model-role.test.ts:spawnAndCaptureOptions`

Gate 必须核对：五行表仅是完整 `runStructuredSubagent` universe；Vibe direct caller在resolved-agent owner显式分类；executor不fallback reclassify、不恢复legacy name budget；runtime steer正文使用静态asset且legacy budget notice不迁移。runtime precedence、class matrix、12/42 qualification、unknown latency状态、无第二engine/settings与Round 5 LOW resolutions均不得回退。

若 Claude Opus 5 unavailable，只能选择未参与正文的native fallback并记录原因；不得回退Grok或GPT-5.6-sol。完整review写入既有review artifact路径并带新revision。`NEEDS_REVISION`回本文修订，`NEEDS_REDESIGN`回设计阶段；`PASS/PASS_WITH_NOTES`后恢复用户已授权的实现，而不是按旧design-only合同停止。

### 8.2 精确 review handoff

```text
请执行只读独立 Design Review Gate。

Reviewed Inputs（必须完整读取 raw bytes）：
1. docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md
2. docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md

从两文件 raw bytes 生成按 normalized POSIX path 排序的 path + SHA-256 manifest及新 reviewed_revision；不要沿用Round 5 digest。

作者元数据：原author=Grok 4.6；正文revision author含GPT-5.6-sol；本次implementation-review reentry replacement author=GPT-5.6-sol，原因=Grok author job stalled/cancelled。Reviewer必须是Claude Opus 5 / claude-opus-5-thinking-high；Grok 4.6与GPT-5.6-sol及其同模型实例不得自审。

必须核对两条新事实与最小设计：
- packages/coding-agent/src/vibe/runtime.ts 的 #buildSpawnOptions/#registerTurnJob 直接调用runSubprocess且不经过runStructuredSubagent。Vibe已持有#resolveWorker解析出的bundled record.agent；它必须调用中央resolveSubagentPerformanceClass({agentName: record.agent.name, agentShadowReview: record.agent.shadowReview})并传ExecutorOptions.performanceClass。executor不得在class缺失时按name重分类或恢复legacy scout/sonic预算；不得为Vibe新建structured runner/discovery/runtime ceiling。
- packages/coding-agent/src/task/executor.ts:buildSoftRuntimeNotice 的模型可见正文必须来自静态 packages/coding-agent/src/prompts/system/subagent-soft-runtime-notice.md，并用现有prompt.render渲染softRuntimeMs/maxRuntimeMs；builder保留test seam。legacy buildBudgetNotice本轮不迁移。

同时确认：原五行调用表被准确限定为完整runStructuredSubagent universe；Vibe direct-caller row、packages/coding-agent/test/vibe/spawn-model-role.test.ts行为回归、executor-wall-clock静态asset渲染覆盖均进入manifest/验证计划；runtime precedence、9行class matrix、smoke/release 12/42上限、UNVERIFIED语义、未知延迟状态、无第二engine/settings，以及Round 5两条LOW resolution均未回退。

Verdict只能是PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN，并附path:line证据。完整review持久化到docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md，带新manifest/reviewed_revision与reviewer native identity。

当前implementation_authorization=implementation-authorized; paused for independent design re-Gate。PASS/PASS_WITH_NOTES后恢复现有实现与针对性验证；不得误按旧design-only合同停止。NEEDS_REVISION回本文修订；NEEDS_REDESIGN回设计阶段。
```
