# Research: omp 侧边建议者（Advisor）该用什么模型，DeepSeek-V4-Flash 是否合适

调研日期：2026-08-30。  
问题：omp 的侧边建议者适合什么模型；`deepseek-v4-flash` 是否合适，有没有更合适的选择。

证据分级：`事实` = 原文/代码可核验；`推断` = 由事实推出；`未知` = 本轮没有跑真实 A/B。

---

## 一句话结论

**侧边建议者不是「快模型旁路」，而是「每轮自动跟读的第二意见」。产品默认走 `slow` 强推理链，不是 `smol`/`flash`。**

对当前这台机器上的 omp 配置（主模型 `gateway/grok-4.6:xhigh`，consult 已是 `gateway/gpt-5.6-sol:xhigh`，scout 才是 `gateway/deepseek-v4-flash:max`）：

- **不要把 Flash 当默认 Advisor。** 弱模型评审强主模型，容易漏真问题，或用错的 `concern`/`blocker` 打断主循环。
- Flash 只适合「便宜、机械的护栏」：`:low`、WATCHDOG 写死检查项、接受它挑战不了 grok。
- 若要真能改 grok 方向：用 **DeepSeek-V4-Pro**（或 Sonnet / 另一家 frontier），不要复用 scout 的 `:max`。
- 已经有 consult=sol 时，Advisor 和 consult 不要再配成同一个模型。

本轮**没有**用 Flash/Pro 各跑一轮真实 advisor transcript。质量对比是官方定位 + 产品契约的推断，不是实测。

---

## 1. 侧边建议者实际是什么

用户说的「侧边建议者」对应 omp 的 **Advisor** 子系统，不是 consult，也不是 scout/reviewer 子代理。

权威说明：[`docs/advisor-watchdog.md`](advisor-watchdog.md)。

`事实`：

- 默认关闭：`advisor.enabled` default `false`（`packages/coding-agent/src/config/settings-schema.ts`）。
- 打开后，第二个模型被动跟读主会话每一轮增量，可自己 `read`/`grep`/`glob`，用 `advise` 往主会话注一条笔记。
- 默认工具面只读；`WATCHDOG.yml` 可以再授权 `edit`/`write`/`bash` 等。Advisor 是完整 agent，不是纯补全。
- 笔记分 `nit` / `concern` / `blocker`。后两者在约束允许时会打断/续跑主循环。
- 默认 `advisor.syncBacklog = off`：Advisor 落后不挡主循环；设成 `1`/`3`/`5` 时最多等 30 秒。
- consult 是主模型主动调用的中途请教，**独立于** Advisor；空 `consult.model` 会落到 `modelRoles.advisor` 再落到 slow 链。

系统提示（`packages/coding-agent/src/prompts/advisor/system.md`）把岗位写成：

- 用户 / 代码质量 / 稳健性的倡导者，peer-shadow 主 agent。
- 优先沉默；每轮最多一条 `advise`；默认 2–3 次工具调用。
- 只对具体技术风险或 transcript 里可见的执行失败发言。
- 不要复述主 agent 已看到的错误，不要质疑用户意图。

`推断`：Advisor 的稀缺能力是**判断什么时候闭嘴、什么时候升级严重度**，不是吞吐或首 token。

---

## 2. 产品默认选的是哪类模型

`事实`（`packages/coding-agent/src/config/model-resolver.ts`）：

```
ROLE_PRIORITY_ALIAS.advisor = "slow"
```

注释原文：Advisor 是 second-opinion reviewer，默认走 `slow` 推理链；**不像 `slow` 角色本身那样继承主模型**，开箱就是另一台强模型。

`slow` 优先链（`packages/coding-agent/src/priority.json`）按顺序是 GPT-5.5/5.4/5.3-codex → 各版 Opus → 最后一项宽模式 `"pro"`。  
`smol` 链才是 flash / haiku / mini。

未写 `modelRoles.advisor`、也没有 `WATCHDOG.yml` 的 `model` 时：`resolveAdvisorRoleSelection()` 走这条 slow 链。

未写 thinking 后缀时，descriptor 默认 `ThinkingLevel.Medium`（`session-advisors.ts`）。DeepSeek 官方把 Chat Completions 的 `medium` 映射成 `high`（[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)）。

`推断`：产品认为 Advisor 是「强、且与主模型不同」的评审者。把 Flash 配成 Advisor 是显式偏离默认，不是对齐默认。

当前用户 `~/.omp/agent/config.yml`（2026-08-30 读取）：

| 槽位 | 值 |
| --- | --- |
| `modelRoles.default` | `gateway/grok-4.6:xhigh` |
| `modelRoles.plan` | `gateway/gpt-5.6-luna:max` |
| `modelRoles.advisor` | **未设** |
| `advisor.enabled` | **未设（默认 false）** |
| `consult.model` | `gateway/gpt-5.6-sol:xhigh`（已开） |
| `agentModelOverrides.scout` | `gateway/deepseek-v4-flash:max` |
| `agentModelOverrides.reviewer` | `gateway/gpt-5.6-sol:xhigh` |

没有项目/用户级 `WATCHDOG.yml`。

---

## 3. Advisor 对模型的硬约束

这些是代码合同，不是口味：

1. **必须会稳的 tool use。** 至少 `advise`；默认还要 `read`/`grep`/`glob`。Native DeepSeek catalog 给 Flash/Pro 标了 `supportsToolChoice: false`，但仍标 tool calls 可用（`packages/catalog/src/models.json` `provider: deepseek`）。官方定价页也对两档都勾了 Tool Calls（[Pricing](https://api-docs.deepseek.com/quick_start/pricing)）。
2. **思考轨迹要回传。** DeepSeek thinking + tools 时，后续请求必须带回全部 `reasoning_content`，否则 400（[Thinking Mode / Tool Calls](https://api-docs.deepseek.com/guides/thinking_mode)）。catalog 已标 `requiresReasoningContentForToolCalls: true`。omp 这条路径是按官方要求接的，不是 Flash 独有坑。
3. **弱模型会刷屏。** `AdvisorEmissionGuard` 的注释写明真实会话里出现过 309 次 `advise`、114 次 `Stop.`（issue #3520）。代码已经静默丢掉空话和重复，但**挡不住错误的 concern/blocker**。
4. **Gemini 空回复曾被当成失败。** CHANGELOG / issue #8223：合法沉默被重试到丢掉 backlog。Advisor 的正确输出经常是「什么都不说」。
5. **上下文是 append-only 增量。** 最近改成按源消息拆 user delta，让 provider prefix cache 能随会话增长（CHANGELOG）。DeepSeek 缓存命中价远低于未命中，长开 Advisor 时 cache 比模型档位更影响账单（[Pricing](https://api-docs.deepseek.com/quick_start/pricing)；另见 `docs/research-reasonix-cache-hit.md`）。
6. **和 consult 共用角色。** 不设 `consult.model` 时 consult 跟 Advisor。用户已经把 consult 钉死 sol，所以改 Advisor **不会**自动改 consult。

---

## 4. DeepSeek 官方怎么划分 Flash / Pro

### 4.1 预览版定位（2026-04-24）

中文公告（`事实`，[news260424](https://api-docs.deepseek.com/zh-cn/news/news260424/)）：

- **V4-Pro**：内部 Agentic Coding 模型；体验优于 Sonnet 4.5；交付接近 Opus 4.6 **非思考**；仍落后 Opus 4.6 **思考**。
- **V4-Flash**：知识弱一档，推理接近 Pro；参数/激活更小，更快更便宜。
- **关键句**：Flash 在 Agent 测评上「简单任务与 Pro 旗鼓相当，**高难度任务仍有差距**」。
- 复杂 Agent 场景官方建议思考模式，强度 **max**。

英文对应（[v4-preview](https://www.deepseek.com/en/news/v4-preview/)）：Flash = fast / efficient / economical；simple Agent tasks on par with Pro。

规模：Pro 1.6T / 49B active；Flash 284B / 13B active。两档都是 1M 上下文，都支持 thinking / non-thinking。

### 4.2 正式版（2026-08-13）

[news260813](https://api-docs.deepseek.com/zh-cn/news/news260813/)（`事实`）：

- 正式版强调的是 **V4-Pro** 生产环境 Agent 提升。
- Flash 和 Pro 思考档都是 `low` / `high` / `max`：简单任务 low，日常 Agent high，高度复杂 max。
- Code Agent 榜用的是 **Harness 极简模式 + max**，不是 omp Advisor 这种完整工具面。

### 4.3 HF 模型卡：Flash-Max 能追推理，追不上复杂 Agent

[DeepSeek-V4-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)（`事实`）：

> DeepSeek-V4-Flash-Max achieves comparable reasoning performance to the Pro version when given a larger thinking budget, though its smaller parameter scale naturally places it slightly behind on pure knowledge tasks and the most complex agentic workflows.

Instruct 分档节选（同一页 Comparison across Modes）：

| 任务 | Flash Non-Think | Flash High | Flash Max | Pro High | Pro Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| LiveCodeBench | 55.2 | 88.4 | 91.6 | 89.8 | 93.5 |
| HLE | 8.1 | 29.4 | 34.8 | 34.5 | 37.7 |
| Terminal Bench 2.0 | 49.1 | 56.6 | 56.9 | 63.3 | 67.9 |
| SWE Verified | 73.7 | 78.6 | 79.0 | 79.4 | 80.6 |
| HLE w/ tools | — | 40.3 | 45.1 | 44.7 | 48.2 |

`推断`：关掉 thinking 换延迟，硬推理会塌（LiveCodeBench 88→55，HLE 29→8）。SWE Verified 这种「改完仓库」差距小。Advisor 要的是判断，更接近 HLE / Terminal Bench，不是 SWE Resolve。

HF 把 Non-think 写成「Routine daily tasks, low-risk decisions」；Think High 才是「Complex problem-solving, planning」。

### 4.4 官方「在 Oh My Pi 中使用 DeepSeek」页说的是主模型，不是 Advisor

[oh_my_pi 集成页](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/oh_my_pi)（`事实`）：

- 默认示例是 `omp --model deepseek/deepseek-v4-pro`。
- 「需要更快响应时」才写 `omp --model deepseek/deepseek-v4-flash`。这是**主会话** `--model`，没有提到 Advisor / `modelRoles.advisor`。
- thinking + tools 必配：`supportsToolChoice: false`、`requiresReasoningContentForToolCalls`、`requiresAssistantContentForToolCalls`；缺了长对话 400。
- 非官方网关（DeepInfra、Kilo、NIM、Zenmux）上 `reasoning_content` 回传规则可能不同，建议优先 `api.deepseek.com`。
- 该页示例 `thinking.minLevel: high`，只映射 `high`/`xhigh→max`，**没写 `low`**。现行 API 已有 low（[updates 2026-08-13](https://api-docs.deepseek.com/updates/)）。跟这份示例走、又不写 `:low`，Advisor 会落在 high。

当前仓库 catalog 的 `provider: deepseek` 条目已经带了这三项 compat。该页「内置条目会 400」针对的是旧 bundled 缺字段，不是今天这份 catalog。

### 4.5 官方定价与并发（2026-08-30 读取）

[Pricing](https://api-docs.deepseek.com/quick_start/pricing)（`事实`，每 1M tokens，美元）：

| | Flash 闲时 / 高峰 | Pro 闲时 / 高峰 |
| --- | --- | --- |
| 输入 cache hit | $0.007 / $0.014 | $0.022 / $0.044 |
| 输入 cache miss | $0.22 / $0.44 | $0.66 / $1.32 |
| 输出 | $0.66 / $1.32 | $1.98 / $3.96 |
| 并发上限 | 2500 | 500 |

高峰：UTC 周一到周五 01:00–04:00、06:00–10:00。

catalog 原生 `deepseek` 条目仍写 Flash `$0.14 / $0.28`、Pro `$0.435 / $0.87`，和当前官方峰谷价不一致。**以官网为准**；catalog 数字不要当现价。

Thinking **默认开，默认 high**（[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)）。  
`deepseek-chat` / `deepseek-reasoner` 已指向 Flash 的非思考/思考，2026-07-24 后退役。

`推断`：Flash 官方自己承认难 Agent 任务不如 Pro。Advisor 的「沉默纪律 + 升级 blocker + 2–3 次核实」更接近难任务，不是简单 Agent。

---

## 5. Flash 适不适合当 Advisor

### 5.1 能力面：能跑，但岗位不对

`事实`：Flash 有 tool calls、thinking、1M 窗口、高并发、低价。omp catalog 各网关都收了 `deepseek-v4-flash`。功能上**可以**当 Advisor。

`推断`：不合适作为**默认**侧边建议者，原因叠在一起：

1. 产品默认是 slow/强模型，Flash 落在 smol/`flash` 语义。
2. 官方写明难 Agent 任务有差距；Advisor 难在判断，不难在打字。
3. 主模型已是 grok-4.6:xhigh。用更弱的模型自动打断它，假阳性比漏报更贵——`concern`/`blocker` 会steer 主循环。
4. Emission guard 只能滤空话，不能滤「看起来像那么回事的错建议」。
5. 用户已经把 Flash:max 给了 scout。Scout 是一次性勘探；Advisor 是**每一轮增量**。把 scout 的 `:max` 抄过来，等于每轮主更新都付思考 max，官方把 max 留给「高度复杂」，不是旁路跟读。
6. 「关 thinking 换延迟」是假省：HF 上 Flash Non-Think 的硬推理比 High 塌一截。Advisor 若关 thinking 求快，判断力先没了；开 high/max 求准，又不再是快旁路。官方 OMP 页的「更快响应用 flash」不能挪到 Advisor 槽。

### 5.2 什么时候 Flash 可以用

同时满足这些，Flash 才值得开：

- 目标是便宜的机械护栏（漏测、跑偏、重复规划），不是挑战 grok 的设计。
- 显式 `:low`（最多 `:high`），**不要** `:max`。
- `WATCHDOG.md` 把检查项写死，缩小自由发挥。
- `advisor.syncBacklog` 保持 `off`，除非量过延迟。
- consult 继续留给 sol（用户已经这样配了）。

### 5.3 不要用 Flash 的情况

- 指望它抓住 grok 的推理错误、错误完成、薄验证。
- 打开 `syncBacklog=1` 又开 thinking high/max：主循环会被等。
- 不设 `consult.model` 就把 Advisor 改成 Flash：consult 会一起变弱。当前配置没有这个坑。

---

## 6. 更合适的模型（按这台机器的真实槽位）

主模型已经是 grok-4.6:xhigh，consult/reviewer 已经是 sol。Advisor 必须是**第三种声音**，否则和 consult 重叠（`builtin-consult.ts` 会提示 same model is also the shadow advisor）。

| 选择 | 适合当 Advisor？ | 理由 |
| --- | --- | --- |
| `deepseek-v4-flash` / `:max` | 不作为默认 | 快、便宜、难任务弱；`:max` 是 scout 档，不适合每轮旁路 |
| `deepseek-v4-flash:low` | 仅机械护栏 | 官方：简单任务用 low |
| **`deepseek-v4-pro:high`** | **DeepSeek 里最对齐岗位** | 官方内部 coding 模型；日常 Agent 用 high；slow 链最后一项就是 `pro` |
| `deepseek-v4-pro:max` | 偶发/硬任务，不要常开 | 官方复杂 Agent 才 max；每轮跟读太贵太慢 |
| `gateway/gpt-5.6-sol:xhigh` | 能打，但浪费 | 已是 consult + reviewer；再当 Advisor 重叠 |
| `gateway/grok-4.6:xhigh` | 不要 | 产品明确不让 Advisor 继承主模型；同模型第二意见增益小 |
| Sonnet 4.5 `:medium` | 很对齐文档示例 | `docs/advisor-watchdog.md` 示例就是它 |
| Opus / luna:max | 过重 | 每轮自动跟读不该上 plan/Gate 档 |

`推断`（本机建议）：

1. **要真侧边建议者**：`modelRoles.advisor: gateway/deepseek-v4-pro:high`（或你已有的 Sonnet）。consult 保持 sol。
2. **只要便宜护栏**：`gateway/deepseek-v4-flash:low` + 短 `WATCHDOG.md`。
3. **已经够用**：继续关 Advisor，只靠 consult=sol。Advisor 默认就是关的。

未在本机核验 gateway 上 `deepseek-v4-pro` / `deepseek-v4-flash` 是否都能解析。配之前用 `/advisor status` 看是 `running` 还是 `no_model`。

---

## 7. 若要试，最小配置

```yaml
advisor:
  enabled: true
  syncBacklog: off
modelRoles:
  advisor: gateway/deepseek-v4-pro:high   # 或 gateway/deepseek-v4-flash:low
```

或 `WATCHDOG.yml` 按人拆模型：

```yaml
advisors:
  - name: Review
    model: gateway/deepseek-v4-pro:high
    tools: [read, grep, glob]
  - name: Rails
    model: gateway/deepseek-v4-flash:low
    tools: [read, grep, glob]
    instructions: |
      Only flag skipped verification, unused files, or explicit instruction breaches.
      Stay silent on design taste.
```

验证：`/advisor status` 看模型、上下文、费用；看 `__advisor.jsonl` 是沉默还是刷 `advise`。没有实测前不要宣称「Flash 够用」或「Pro 明显更好」。

---

## 来源

- omp Advisor：`docs/advisor-watchdog.md`，`packages/coding-agent/src/{advisor,prompts/advisor,config/model-resolver.ts,config/settings-schema.ts,priority.json,session/session-advisors.ts}`
- 用户配置：`~/.omp/agent/config.yml`（2026-08-30）
- DeepSeek：[V4 Preview 中文](https://api-docs.deepseek.com/zh-cn/news/news260424/)、[英文](https://www.deepseek.com/en/news/v4-preview/)、[V4-Pro 正式版](https://api-docs.deepseek.com/zh-cn/news/news260813/)、[Pricing](https://api-docs.deepseek.com/quick_start/pricing)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)、[Oh My Pi 集成](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/oh_my_pi)、[HF V4-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)
- 既有笔记：`docs/research-deepseek-harness-v4-pro-vs-opus5.md`，`docs/research-reasonix-cache-hit.md`
