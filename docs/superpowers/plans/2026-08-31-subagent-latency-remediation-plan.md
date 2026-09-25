# 修复方案：subagent 长期无效耗时（评审 + 补齐 + 实施计划）

- Date: 2026-08-31
- Status: Plan（待授权实施）
- Scope: L
- 上游设计：`docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md`（Status: Draft，`implementation_authorization: design-only`）
- 本文档授权状态：仅文档。撰写本文档期间**未修改任何代码、未修改 `~/.omp` 配置、未发布**。
- 证据口径：所有代码结论均为本次直接读取源文件所得，含文件:行锚点；所有语料数字均为本次独立复算所得（脚本 `/tmp/active_wall.py`，一次性）。

---

## 0. 结论摘要

被评审结论的**方向正确、主要事实可复现**，但有 4 处需要修正、1 处根因被完全遗漏、1 条建议如按原文实施会引入新缺陷。

| 判定 | 项 |
| --- | --- |
| 采纳 | 名字白名单覆盖不足；scout 配置与文案自相矛盾；缺统一 performance class；设计仍是 Draft/design-only；"修 hang ≠ 修慢" |
| 修正 | 75% 处**没有任何提醒**，是直接强停；后果比"被质量门拒绝"更严重（结论被丢弃）；"绝不设置 budgetStopRequested" 这条建议会删掉 hang 救援；两个墙钟口径不可混用 |
| 新增（原结论遗漏） | **预算按单次 run 计算，跟进轮/IRC 续跑完全无护栏** —— 与名字白名单并列的第一梯队根因 |
| 新增 | `executor.ts` 注释与 settings 默认值不一致，会误导读者以为护栏默认关闭 |

总判断：**同意"现有修复不够"**，且缺口比原结论列举的多一项。

---

## 1. 复算结果（独立验证）

脚本口径与上游设计 §1.2 一致：取子 jsonl 中带 `timestamp` 的 assistant 事件排序，相邻间隔 ≤10 min 计入活跃。差异说明：我的"墙钟"是 **assistant 首末**跨度，上游是**文件全事件首末**跨度，两者不可混用。

```
children=1731  sampled=1687  parse_errors=0
ALL   active   p50=8.1   p90=28.4   max=185.3
ALL   asst-wall p50=8.5  p90=40.9   max=1155.7
active>=30min: 155        asst-wall>=30min: 248
```

关键值与原结论逐项吻合：

| 指标 | 原结论 | 本次复算 | 判定 |
| --- | --- | --- | --- |
| 活跃 p50 / p90 | 8.3 / 27.0 min | 8.1 / 28.4 min | 一致（口径抖动） |
| 活跃最大值 | 185.3 min | 185.3 min | **完全一致** |
| 活跃 ≥30 min 数量 | 155 | 155 | **完全一致** |
| `Opus5DesignerR2` | 185.3 min，read=207，bash=122 | 同 | **完全一致** |
| `DSHGateReviewer` | 90.3 min，read=514，grep=153，bash=51 | 同 | **完全一致** |
| `GrokStandardsAxis` | 约 70 min，aborted 无 yield | 36.1 min 活跃 / 69.7 min 墙钟，yield=0 | 一致 |
| 新鲜窗口全体活跃 p50/p90 | 11.4 / 22.7 min | 11.4 / 22.4 min | 一致 |
| 墙钟-活跃差 ≥30 min | 136 | 105 | 口径不同，非错误 |

需修正的两处数字：

- **`GrokSpecAxis`**：原结论纠正 brief 的 53 min 是对的，但给出"活跃约 29 min"。我复算 **活跃 = 墙钟 = 32.6 min，无任何 >10 min 间隔**，复现不出 29。建议以 32.6 min 记录。
- **墙钟-活跃差 ≥30 min**：105（assistant 口径）vs 136（全事件口径）。报告中必须标注用的是哪个口径。

复算新发现的证据（第 3 节要用）：活跃 TOP10 中有 4 个是**活跃完全等于墙钟**（零 park）的连续长跑，且都带多次 `yield` 与大量 `hub`：

```
94.2m / 94.2m  FinalReviewA             [read=71,  grep=34, hub=28, bash=20]
91.9m / 91.9m  PolicyGateReview         [read=69,  grep=36, bash=11, yield=6]
87.7m / 87.7m  RoutingReliabilityReview [read=83,  grep=49, yield=8, bash=6]
87.5m / 87.5m  ReviewRuntimeInvocation  [read=216, grep=125, yield=24, hub=10]
```

`task.maxRuntimeMs` 默认 1 小时对**所有** agent 生效（`packages/coding-agent/src/config/settings-schema.ts:5577`），所以"名字白名单未命中"**无法解释**这些超过 87 分钟的连续活跃。唯一自洽的解释是多轮驱动 + 跟进轮无护栏（见 §3）。

---

## 2. 逐条评审

### 2.1 采纳（已核实）

**A. 名字白名单覆盖不足 —— 成立。**

```56:71:packages/coding-agent/src/task/index.ts
const REVIEW_GATE_MAX_RUNTIME_MS = 1_800_000;
const REVIEW_GATE_AGENTS: Record<string, true> = {
	reviewer: true,
	"subagent-sol": true,
	"sol-xhigh-reviewer": true,
	"security-reviewer": true,
};

function resolveTaskMaxRuntimeMs(session: ToolSession, agent: string | undefined): number {
	const configured = session.settings.get("task.maxRuntimeMs");
	if (!agent || !REVIEW_GATE_AGENTS[agent]) return configured;
```

同名单在 `packages/coding-agent/src/task/review-performance.ts:5-17` 重复了一遍（`REVIEWER_SOFT_REQUEST_BUDGET` + `REVIEWER_AGENT_NAMES`）。且 `getAgent` 是精确同名匹配（`packages/coding-agent/src/task/discovery.ts:143-145`），没有别名、没有 `shadowReview` 通道、没有 frontmatter 意图通道。`subagent-grok` 不在名单内 —— 用户级默认设计作者/评审者完全不受 30 分钟约束。

**B. 时序错位 —— 成立。** `index.ts:801` 与 `index.ts:1628` 用 `params.agent` 原始字符串预解析 `maxRuntimeMs`，而真正的 settings 重载与 agent discovery 发生在之后（`packages/coding-agent/src/task/structured-subagent.ts:260,267`），`resolveEffectiveSubagentPolicy` 的返回值（`structured-subagent.ts:325-348`）里没有任何 performance class，`structured-subagent.ts:451` 只是把 `request.maxRuntimeMs` 透传。墙钟、请求预算、prompt 三者由三个独立来源决定。

**C. scout 配置与文案矛盾 —— 成立。** `packages/coding-agent/src/prompts/agents/scout.md:4-10` 是 `thinking-level: max` / `max-effort: max` / `read-summarize: false`，模型链末级 `gateway/grok-4.6:xhigh`；正文 `scout.md:40` 说"you are supposed to finish in a few seconds"，`scout.md:60` 又说 "You MUST keep going until complete"；统一系统提示 `packages/coding-agent/src/prompts/system/subagent-system-prompt.md:73` 再加一条 "You MUST keep going until this ticket is closed."；预算 `packages/coding-agent/src/task/executor.ts:122-123` 是 100 请求。四处互相打架。

**D. 设计仍未落地 —— 成立。** `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md:3,14` = `Status: Draft`、`implementation_authorization: design-only`。

**E. "修 hang 不能冒充修慢" —— 成立**，是本轮最重要的判断框架。

### 2.2 修正

**F. 75% 不是"提醒"，是无预警强停。**

原结论写"75% 墙钟'提醒'"。代码里该路径**没有任何 steer 通知**：

```1311:1323:packages/coding-agent/src/task/executor.ts
	const softRuntimeMs = resolveReviewerSoftRuntimeMs(agent.name, maxRuntimeMs);
	if (softRuntimeMs > 0) {
		runtimeSoftTimeoutId = setTimeout(() => {
			if (resolved || abortSent || budgetStopRequested) return;
			logger.warn("Subagent reviewer soft runtime checkpoint; wrapping up", {
				id,
				agent: agent.name,
				softRuntimeMs,
				maxRuntimeMs,
			});
			requestBudgetStop("runtime_timeout");
		}, softRuntimeMs);
	}
```

`requestBudgetStop` 会立即 `session.abort()`（`executor.ts:1248-1264`）。对照请求预算路径，那里是规范的三段式 —— 1.0x 发 steer 通知、1.5x 强停、+5 请求硬中止（`executor.ts:1756-1783`）。**墙钟路径缺的正是第一段。** 这不是"提醒的语义错了"，是"提醒根本不存在"。

**G. 后果比"被质量门拒绝"严重一个量级：完整评审结论被直接丢弃。**

原结论只指出 benchmark 质量门拒绝 `budget_stop`（`packages/coding-agent/src/workflow/benchmark/runner.ts:572-578`，已核实）。真正的破坏在 workflow 适配层 —— 对**未中止、已成功 terminal yield** 的 run，只要终态是 `budget_stop` 就直接抛异常：

```472:475:packages/coding-agent/src/workflow/runtime-adapter.ts
			const kind = body.completionKind;
			if (kind === "budget_stop") {
				throw new BudgetExhaustedError(1, "unknown", 0, { completionKind: "budget_stop" });
			}
```

即：评审者在 22.5 分钟被强停、随后交出了 schema 合法的完整 verdict，这份 verdict 不是"被标记为可疑"，而是**连同 payload 一起变成一个错误被丢掉**。这是数据丢失，不是 fail-close。对 devflow 是活跃路径，不只 benchmark。

**H. "75% 只发送一次 steer，绝不设置 budgetStopRequested" 这条建议按原文实施会引入新缺陷。**

该定时器的存在理由写在代码注释里：

```1304:1308:packages/coding-agent/src/task/executor.ts
	// Wall-clock hard limit. Defense-in-depth for the case where a provider stream
	// hang escapes the inference-layer watchdog (see openai-completions
	// `isOpenAICompletionsProgressChunk`). Disabled by default; set
	// `task.maxRuntimeMs > 0` to cap each subagent's lifetime.
```

如果 75% 永不强停，一个真卡住的评审者就只剩 100% 处的硬中止，而硬中止**不会**驱动强制 yield —— 部分结论直接丢失。正确做法不是删掉强停，而是**补上缺失的第一段**并把强停后移（见 §4.1）。

**I. 注释与默认值不一致（原结论未提）。** 上引 `executor.ts:1306-1307` 说 "Disabled by default"，但 `settings-schema.ts:5577` 的默认值是 `3_600_000`。任何按注释推理的人都会误判护栏默认关闭。

### 2.3 原结论遗漏的根因

见 §3，单列一节。

---

## 3. 遗漏的第一梯队根因：预算按单次 run 计，跟进轮无护栏

所有护栏（墙钟定时器、请求计数 `progress.requests`、`completionKind`）都创建在**单次 run** 的作用域内。跨轮继续工作有两条路径，两条都绕过护栏。

### 3.1 跟进轮把预算硬编码为 0

```2779:2795:packages/coding-agent/src/task/executor.ts
	const monitor = createSubagentRunMonitor({
		index,
		id,
		agent,
		task: message,
		description: options.description,
		modelRole: options.modelRole,
		signal,
		onProgress: options.onProgress,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		sessionFile,
		softRequestBudget: 0,
		softRequestBudgetNotice: false,
		maxRuntimeMs: options.maxRuntimeMs ?? 0,
	});
```

`softRequestBudget: 0` = 请求预算**完全禁用**（`executor.ts:135-136`：0 直接 return 0）。`maxRuntimeMs: options.maxRuntimeMs ?? 0` = 除非调用方显式传值否则**无墙钟**。唯一调用方不传：

```1531:1540:packages/coding-agent/src/vibe/runtime.ts
						: await runSubagentFollowUpTurn({
								id: record.id,
								agent: record.agent,
								message,
								description: `vibe ${record.cli} session`,
								signal,
								onProgress,
								eventBus: session.eventBus,
								artifactsDir: session.getSessionFile()?.slice(0, -6),
							});
```

结论：vibe worker 的每一个跟进轮都是**无请求预算、无墙钟上限**运行。

### 3.2 IRC/hub 送信路径完全不经过 run monitor

`packages/coding-agent/src/irc/bus.ts:148` 先 `ensureLive` 复活 parked agent，再 `session.deliverIrcMessage(...)`（同文件 `:178`）把消息注入活跃 session，直接恢复其 agent 循环。这条路径上没有 monitor、没有计数、没有定时器、也不产生 `completionKind`。父层 `hub send` 与 peer 之间的协调消息都走这里。

### 3.3 与复算证据吻合

§1 里 4 个零 park、87–94 分钟连续活跃的子会话，全部带多次 `yield`（6/8/24 次）与大量 `hub`（10/28 次）。1 小时默认墙钟对所有 agent 生效，单次 run 不可能跑到 94 分钟还不被中止 —— 只有"每轮重置 + 部分轮无上限"能解释。

**这条根因的严重性不低于名字白名单**：即使把 performance class 做对了，只要跟进轮仍传 0，多轮代理照样可以无限跑。原结论的"最小充分后续动作"6 条里没有任何一条覆盖它。

---

## 4. 修复方案

优先级按"正在造成损害"排序，不按设计文档章节顺序。P0 两项与 8-30 设计的 A 方案不冲突，但**必须先做** —— 它们在修正现存的错误行为，而不是新增优化。

### 4.1 P0-A：修复墙钟收尾语义，停止丢弃已完成的评审结论

**现状缺陷**：75% 无预警强停（`executor.ts:1311-1323`）；非中止且已 yield 的 `budget_stop` 被抛异常丢弃（`runtime-adapter.ts:472-475`）；benchmark 质量门连带把正常收尾记为非 PASS（`benchmark/runner.ts:572-578`）。

**改动**：

1. `packages/coding-agent/src/task/review-performance.ts`
   - 保留 `REVIEWER_SOFT_RUNTIME_RATIO = 0.75` 语义，改为**建议线**；新增 `REVIEWER_FORCED_STOP_RUNTIME_RATIO = 0.9`。
   - 新增 `resolveReviewerAdvisoryRuntimeMs()` 与 `resolveReviewerForcedStopRuntimeMs()`，替换单一的 `resolveReviewerSoftRuntimeMs`（`review-performance.ts:97-101`）。
2. `packages/coding-agent/src/task/executor.ts:1309-1323`
   - 75% 定时器改为**只发一次 steer**，复用请求预算路径已有的机制（`executor.ts:1769-1782` 的 `sendUserMessage(notice, { deliverAs: "steer" })`），并用一个 `runtimeSteerSent` 一次性标志守护；**不** `requestBudgetStop`、**不** abort session。
   - 新增 90% 定时器，行为等于今天的 75%（`requestBudgetStop("runtime_timeout")`），保住 provider hang 的强制 yield 救援（回应 §2.2 H）。
   - 通知文案放入静态 `.md`（仓库规则禁止代码内拼 prompt），建议 `packages/coding-agent/src/prompts/tools/subagent-runtime-wrapup.md`，由 Handlebars 注入已用分钟/总上限。
   - 同步修掉 `executor.ts:1306-1307` 的过时注释（回应 §2.2 I）。
3. `packages/coding-agent/src/workflow/runtime-adapter.ts:472-475`
   - 改为：仅当**没有可用产物**时才抛 `BudgetExhaustedError`；若 run 未中止且 structured output 为 valid，正常返回产物并原样带上 `completionKind: "budget_stop"`，交由 stage 门决定。
   - 已中止分支（`runtime-adapter.ts:452-471`）行为不变。
4. `packages/coding-agent/src/workflow/benchmark/runner.ts`
   - 保持"非 `completed` 即非 PASS"的绝对门不变（这是正确的），但新增 `wrapUpRate` 报表字段，让"被强停但交了完整结论"和"硬中止"在 scorecard 里可区分。

**为什么这样切**：正常的 20–28 分钟评审在新逻辑下 22.5 分钟收到一条 steer、按提示收尾、终态 `completed`，假失败消失；真卡住的在 27 分钟被强停走强制 yield，终态 `budget_stop`，诚实且结论不丢。

**验收**：
- 新增 `packages/coding-agent/test/task/executor-wall-clock.test.ts` 用例：75% 触发后 run 仍在跑且 `budgetStopRequested()===false`、恰好注入一条 steer；90% 触发后终态为 `budget_stop`。
- 新增 `packages/coding-agent/test/workflow/runtime-adapter.test.ts` 用例：非中止 + valid structured output + `budget_stop` → 返回产物且不抛；无产物 + `budget_stop` → 抛 `BudgetExhaustedError`。

**风险**：把 `budget_stop` 产物放行给 stage 后，若某 stage 之前隐式依赖"budget_stop 一定抛异常"来短路，行为会变。实施时必须逐个检查 `workflow/stages/*.ts` 里消费 `completionKind` 的分支（`plan.ts:91`、`plan-review.ts:115,170`、`implement.ts:122`、`repair.ts:161`）。

### 4.2 P0-B：把预算从"单次 run"提升到"agent 生命周期"

**现状缺陷**：§3。

**改动**：

1. 在 `AgentRegistry` 的 ref 上（`packages/coding-agent/src/registry/agent-registry.ts`）增加累计计数：`cumulativeRequests`、`cumulativeActiveMs`，由 run monitor 在 `finish()` 时累加。
2. `runSubagentFollowUpTurn`（`executor.ts:2779-2795`）停止硬编码：`softRequestBudget` 走与首轮相同的解析（`resolveSoftRequestBudget`），并以累计值作为起点；`maxRuntimeMs` 由调用方按 class 传入（见 4.3），不再默认 0。
3. `packages/coding-agent/src/vibe/runtime.ts:1531-1540` 显式传 `maxRuntimeMs`。vibe worker 是设计上长寿的，应给一个**显式且有限**的上限（新增 vibe 专属 setting），不能继续沿用"无限"。
4. IRC 续跑（`irc/bus.ts:148,178`）**需要一个设计决策**，本文档不单方面拍定：
   - 方案 1（较小改动）：在 `AgentSession` 层面加一个与 run 无关的生命周期护栏，累计活跃墙钟/请求超限后对注入消息回一条硬 steer 并拒绝继续自由推理。
   - 方案 2（较干净）：让 IRC 注入也走一个轻量 run monitor，使这条路径产生 `completionKind` 与计数。
   - 我倾向方案 2 —— 方案 1 会造出第二套预算引擎，违反仓库"中心化工具"规则；但方案 2 触及 IRC 投递的时序，需要单独评审。

**验收**：新增用例断言"第二个跟进轮的请求预算不是 0，且累计跨轮生效"；断言 vibe 轮次有非 0 墙钟。

**风险**：给 vibe worker 加上限会改变现有长会话行为，需要用户确认可接受的上限值。

### 4.3 P1-A：统一 performance class（对应设计 A 的核心闭环）

**改动**：

1. 新建 `packages/coding-agent/src/task/performance-class.ts`：
   - `export type SubagentPerformanceClass = "review" | "explore" | "worker"`
   - `resolveSubagentPerformanceClass({ agent, shadowReview, invocationKind })`，判定顺序：explore 名单（`scout`、`sonic`）优先 → frontmatter 声明的 review 意图 → `shadowReview === "code"` → bundled reviewer 名单 → `worker`。explore 优先是必要的，否则带 `shadowReview` 的 scout 会被误升为 review。
2. `packages/coding-agent/src/task/types.ts`（`AgentDefinition`，`readSummarize` 在 `:390` 附近）增加可选 frontmatter 字段 `performance-class`，让用户级 agent（如 `~/.omp/agent/agents/subagent-grok.md`）能自我声明，不必再靠仓库改名单。
3. `packages/coding-agent/src/task/structured-subagent.ts`
   - 在 `resolveEffectiveSubagentPolicy` 里 `discoverAgents`（`:267`）之后计算 class，加进 `EffectiveSubagentPolicy` 返回值（`:325-348`）。
   - `runStructuredSubagent` 用 `policy` 派生的墙钟覆盖透传值（`:451`），使其成为**唯一**解析点。
4. **删除**：`index.ts:56-71` 的 `REVIEW_GATE_AGENTS` / `resolveTaskMaxRuntimeMs` 与两处调用（`:801`、`:1628`）；`review-performance.ts:5-17` 的 `REVIEWER_SOFT_REQUEST_BUDGET` / `REVIEWER_AGENT_NAMES` 双名单。三者收敛到 class 表。
5. prompt 也由 class 驱动：`packages/coding-agent/src/prompts/system/subagent-system-prompt.md:73` 的无条件 "keep going until this ticket is closed" 改为按 class 分级的 Handlebars 分支（explore 收窄为"完成本次窄调查即 yield"）。

**验收**：`subagent-grok`（用户级、名字不在任何名单里）在 `shadowReview: "code"` 下拿到 review class → 30 分钟上限与 80 请求预算生效。这是原结论 §2 的直接回归用例。

### 4.4 P1-B：scout 真正变快

**改动**：
- `packages/coding-agent/src/prompts/agents/scout.md:4-10`：`thinking-level`/`max-effort` 从 `max` 降档；`read-summarize` 改回默认开启；重新评估模型链末级是否该保留 `gateway/grok-4.6:xhigh`。
- `scout.md:60` 的 "keep going until complete" 与 `subagent-system-prompt.md:73` 统一为 explore 分级合同（见 4.3.5），消除四处互相打架的指令。
- `packages/coding-agent/src/task/executor.ts:121-126`：`scout`/`sonic` 由 100 请求降到 explore class 预算（设计建议 40），墙钟由 class 给 10 分钟。

**风险**：降 effort 会影响 scout 产出质量。必须与 §5 的质量门一起上，不能只测速度。

### 4.5 P2：可证明性（否则无法宣称达标）

- 把 §1 的活跃墙钟算法固化成仓库内的 pure helper + CLI（设计 §5.3 已规划），只接收 assistant timestamp 序列，fixture 与用户语料共用。
- release qualification 增加活跃墙钟 p50/p90 门槛；benchmark 质量门增加"required review case 每次 `firstPassed===true`"绝对门（当前 `benchmark/live-runtime.ts:767-782` 只算单次 `passed`）。

### 4.6 P3：父层空等（收益最低，最后做）

单元素 batch 从约 59% 降到约 46%，但仍约 4.3 次 hub wait / task。现有 `prompts/tools/task.md`、`prompts/tools/hub.md`、`tools/hub/jobs.ts` 的改动是**可见提示**，不是行为闭环。此项只影响端到端体感，不是子代理活跃耗时主因，排在最后。

---

## 5. 实施与验证顺序

1. P0-A（墙钟语义 + 不丢产物）—— 独立可上线，先止损。
2. P0-B（跨轮预算）—— 独立可上线。
3. P1-A（performance class）—— 依赖 P0-B 提供的跟进轮墙钟入口。
4. P1-B（scout 降档）—— 依赖 P1-A 的 class 与分级 prompt。
5. P2（可证明性）—— 必须在宣称任何改善**之前**就位。
6. P3（父层）。

每批的最小验证：`bun check` + 该批改动涉及的 package-local 测试 + §4 各项列出的新增用例。

**报告纪律**：P1-B 合并后必须重新采集至少一个完整新窗口（父目录日期 ≥ 合并日）并用 §4.5 的固化 helper 复算。在拿到新窗口 p50/p90 与质量门结果之前，只能写"已部署 treatment"，**不得**写"延迟已解决"。

---

## 6. 明确未验证 / 需确认

- **未验证**：本文档未运行任何测试；上游结论声称的"77 pass / 0 fail / 5.62s"我未复跑。
- **未验证**：`~/.omp/agent/agents/subagent-sol.md` 我只读了 `subagent-grok.md`（`:4-9,30` 已核实为 xhigh/xhigh/`readSummarize: false`/"full fidelity"）；sol 的同构性沿用上游结论，未亲自核对。
- **未验证**：新鲜窗口的 review/gate 与 scout/audit 分位数，我的分类正则与上游不同（我 n=54/10，上游 n=60/8），这两组分位数不可直接对比。
- **推断**（非实测）：§3.3 把 4 个 87–94 分钟连续活跃归因于多轮驱动 + 无护栏跟进轮。机制已在代码中核实，但我未把这些具体 jsonl 的每一轮与 run 边界对齐验证。
- **需确认**：4.2.4 的 IRC 续跑走方案 1 还是方案 2。
- **需确认**：vibe worker 可接受的显式墙钟上限值。
- **需确认**：P1-B 的 scout 目标 effort 档位（降到 `medium` 还是 `high`）。
