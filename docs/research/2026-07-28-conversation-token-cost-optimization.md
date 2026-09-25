# 研究：oh-my-pi 长会话 token / 成本优化（质量优先）

- 日期：2026-07-28
- 范围：oh-my-pi ordinary 主会话的上下文 token、prompt cache 与端到端成本
- 方法：当前会话 usage 实测 + 仓库源码核对 + 厂商官方文档 + 原始 GitHub / Reddit / Hacker News 反馈
- 证据标签：**事实**＝可由 usage、源码或官方文档直接核对；**推断**＝从事实推导、仍需实验；**社区轶事**＝原始用户报告，不作为默认参数依据
- 限制：本文不实现代码、不改配置；未运行测试、lint、构建或产品实验。所有外部页面访问日期均为 2026-07-28。

---

## 0. 结论（先读）

### 0.1 单一最佳路线

**不要先换便宜模型，也不要先引入 LLM 摘要器。** 对 oh-my-pi，质量优先且最可落地的唯一主路线是：

> **可观测性 → 可恢复的工具输出语义裁剪 → 稳定前缀 / cache → cache-aware 批量历史治理 → 结构化 checkpoint / compaction → 按总成本模型路由**

对应实施优先级：

| 优先级 | 动作 | 为什么现在做 | 默认上线条件 |
|---|---|---|---|
| **P0** | 测量、任务质量基线、分桶与回滚门禁 | 当前已有 usage 总桶，但没有 provider-visible 上下文类别、工具 raw/retained、prefix fingerprint、compaction 保真度的端到端闭环 | 只观测，不改变模型输入 |
| **P1** | 工具输出语义裁剪并保留完整 artifact；把 ordinary `ModelOptimizationProfile` 的 tool/context policy 接入主会话 | 当前会话 49 条工具结果约 101k tokens；仓库已有完整 artifact spill 和 profile 声明，真正缺口是主会话执行接线 | 失败信号召回与任务成功率通过门禁 |
| **P2** | prefix 稳定后，做 cache-aware **批量历史治理**；在阶段边界做结构化 checkpoint / compaction | 逐条历史改写会反复破坏热前缀；现有 supersede/useless、shake、compaction 原语足够，不应再造框架 | cache-write 不放大，checkpoint 约束召回通过 |
| **P3** | 仅在离线评估后启用总成本模型路由；LLM tool-result summarizer 也只在 deterministic 裁剪不足时启用 | 跨模型会冷启动前缀；摘要器增加模型调用、延迟、失败与信息损失 | 以 `$ / successful task` 降低且质量不降为准，不以单价为准 |

### 0.2 现状判断

1. **事实：缓存已显著降低本会话输入价格，但没有缩短上下文。** 16 次 provider 调用累计处理输入 1,667,814 tokens，其中 cache read 1,408,512，占 84.45%；这些 cached tokens 仍是模型逻辑输入、仍占上下文容量、仍收费。
2. **事实：工具输出是当前会话最明确的可控新增历史。** 49 条 tool results 合计 404,574 字符，按仓库常用 `bytes/4` 粗估约 101,144 tokens；其中 `read` 占字符量 83.58%。
3. **事实：仓库不是“没有优化能力”。** 已有 50 KiB inline 边界与完整 artifact、supersede/useless prune、age prune、shake、snapcompact/context-full compaction、append-only 稳定前缀、厂商 usage 归一化和模型失败回退。
4. **事实：最大空白是 ordinary profile 未接主会话执行面。** profile 已声明 per-model `outputTruncation`、`resultSummarization`、`targetUtilization`、`keepRecentN`、`maxToolCalls`，但主 Agent 的 `transformContext` 仅做 extension context 与 steering wrap，tool scheduling 也只接 workflow policy；ordinary profile 的 output/context policy 没有进入 provider-bound 主会话路径。
5. **推断：先修执行接线与可观测性，比增加新压缩算法更高杠杆。** 这样复用已有 artifact、prune、compaction 和 cache seam，改动面更小，也更容易做质量回滚。

> **阈值声明：**本文后续所有成功率、比例、token、天数、告警和回滚阈值都是 **工程建议**，不是 OpenAI、Anthropic、Google 或任何社区项目的厂商承诺；上线前必须用 oh-my-pi workload 校准。

---

## 1. 当前会话实测

### 1.1 累计用量与成本桶

采样自当前研究会话的 session JSONL，采样时间 2026-07-28。

| 指标 | 实测值 | 解释 |
|---|---:|---|
| Assistant / provider 调用 | 16 | 每次调用都会携带当时 provider-visible 上下文 |
| Uncached input | 259,302 tokens | provider usage 的未缓存输入桶 |
| Cache read | 1,408,512 tokens | provider usage 的缓存读取桶 |
| Cache write | 0 tokens | 本会话 telemetry 报告值；**不能据此断言从未创建缓存**，不同模型/transport 的写入计量语义不同 |
| Output | 6,578 tokens | assistant 输出 |
| Total processed | 1,674,392 tokens | input + cache read + cache write + output |
| 累计成本 | **$2.198106** | 当前 pricing metadata 计算结果 |
| Uncached input 成本 | $1.296510（58.98%） | 最大成本桶 |
| Cache read 成本 | $0.704256（32.04%） | 命中后仍有显著成本 |
| Output 成本 | $0.197340（8.98%） | 输出 token 少但单价可能高 |
| 最新一次调用 | input 7,955；cache read 164,352；output 713 | total 173,020；成本 $0.143341 |

处理输入定义为：

$$I_{processed}=U+R+W$$

其中 $U$ 为 uncached input，$R$ 为 cache read，$W$ 为 cache write。本会话：

$$I_{processed}=259{,}302+1{,}408{,}512+0=1{,}667{,}814$$

cache-read 处理输入占比：

$$H_{read}=\frac{R}{U+R+W}=84.45\%$$

这是**账单输入桶占比**，不是“84.45% 上下文被删除”，也不是跨厂商可直接比较的 cache hit rate。

### 1.2 工具输出占比估算

当前会话共有 49 条 tool results：

| 工具 | 调用数 | 字符数 | 占工具结果字符量 |
|---|---:|---:|---:|
| `read` | 29 | 338,151 | 83.58% |
| `grep` | 7 | 45,241 | 11.18% |
| `web_search` | 8 | 18,392 | 4.55% |
| `task` | 1 | 1,030 | 0.25% |
| `todo` | 2 | 1,021 | 0.25% |
| `bash` | 2 | 739 | 0.18% |
| **合计** | **49** | **404,574** | **100%** |

按仓库默认 UTF-8 byte estimator 的 `(bytes + 3) / 4` 近似，约 **101,144 tokens**。这是估算，不是目标模型 tokenizer 实测；中文、多字节文本、代码、JSON、URL 的 token/byte 比不同，101k 可能低估真实 token，不能当精确账单值。

两个分母必须同时报告：

- 相对本会话累计 processed input：$101{,}144 / 1{,}667{,}814 \approx 6.06\%$；
- 相对累计 uncached input：$101{,}144 / 259{,}302 \approx 39.01\%$。

两者都**不是工具输出的精确账单贡献**：同一工具结果可能在后续多轮被 cache read 重放，新增工具结果也会与 system、tool schema、用户消息、assistant 历史一起计费。要得到精确贡献，P0 必须在每次 provider 调用前按类别记录可见 token，而不是把 session 静态字符数直接乘调用次数。

本会话最大单条工具结果为 38,117 字符，另有 22,628、21,614、20,303、19,415 字符的大结果。说明主要问题不是 49 条都略长，而是少数全文 read/web 输出形成长尾。

### 1.3 为什么 cache 不缩上下文

**事实：prompt cache 是前缀计算 / 计费优化，不是上下文删除。** 模型仍需在逻辑上看到完整 system、tools、messages 与 tool results；provider 只是复用已处理的稳定前缀。结果是：

1. cached tokens 仍进入模型的有效上下文长度计算；
2. cached tokens 仍在 usage 中报告，并按厂商 cached-input 规则收费；
3. 会话继续增长时，新增尾部仍会增加 context occupancy；
4. 前缀较早位置变化会缩短可复用前缀，触发 cache write / uncached input 放大；
5. 达到上下文窗口或 compaction 阈值时，cache 命中不能替代历史治理。

因此需要同时优化两个目标：

- **计算 / 账单复用：**稳定 prefix，提高正确的 cache read；
- **上下文容量 / 信息密度：**减少 provider-visible 的无效内容，并保留可恢复指针。

二者相关但不等价。只追 cache hit 会留下越来越大的逻辑上下文；频繁逐条 prune 又可能破坏热 cache。最佳策略是先稳定前缀，再在明确阶段边界批量治理。

---

## 2. 三家官方机制：共同方向与不可泛化差异

### 2.1 共同方向

三家官方机制共同支持的只有高层原则：

- 将大且稳定的共同内容置前，将动态内容置后；
- 命中必须用 provider 原生 usage 字段观测，不能仅凭文本 hash 推定；
- cache 影响输入计算、价格和延迟，不等于删除上下文；
- Batch / Flex / Priority 属于服务层选择，与 cache 是正交维度；
- 工具 schema、system 指令、图片 / thinking 配置等变化都可能影响前缀复用，但具体失效规则按厂商和 API 而异。

### 2.2 OpenAI

| 机制 | 官方事实 | 对 oh-my-pi 的含义 |
|---|---|---|
| 前缀匹配 | Prompt Caching 要求 exact prefix match；静态内容应在前，动态内容在后；图片与 tools 也需一致 | 对 system/tools 做 canonical serialization；不要在稳定前缀中插时间戳、随机 ID |
| 门槛与路由 | 官方文档说明自动缓存从 1,024 tokens 起；GPT-5.6+ 可用 `prompt_cache_key` 提高匹配可靠性 | 门槛与 cache key 是 OpenAI 语义，不能硬编码成全厂商规则 |
| GPT-5.6+ | 支持 implicit / explicit breakpoint；最多每请求 4 个新写入、读取考虑最近 50 个断点；当前 TTL `30m` 是至少可用时间，可能更久 | 与旧 OpenAI 模型的 retention 字段不同，也不是 Anthropic 的刷新 TTL |
| 旧模型 | 文档列出通常 5–10 分钟 idle、最长约 1 小时，部分模型支持 24h extended retention | 必须按 exact model / API 分支，不可说“OpenAI cache 都 30 分钟” |
| 价格 | GPT-5.6 当前短上下文示例为写 1.25×、读 0.1×；旧模型的 cache write / read 比例并不统一 | pricing table 必须版本化；不能假设所有 OpenAI cached input 都是 0.1× |
| 服务层 | Batch 为异步、约 50% 折扣、24h 窗口；Flex 同步慢速、可能资源不可用；Priority 低延迟溢价并可能降 Standard | 三种 route 的延迟、失败与降级语义不同，不能只比较单价 |

官方来源：

1. [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)
2. [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)
3. [OpenAI Batch API](https://developers.openai.com/api/docs/guides/batch)
4. [OpenAI Flex processing](https://developers.openai.com/api/docs/guides/flex-processing)
5. [OpenAI Priority processing](https://developers.openai.com/api/docs/guides/priority-processing)

### 2.3 Anthropic

| 机制 | 官方事实 | 对 oh-my-pi 的含义 |
|---|---|---|
| 启用方式 | 通过 `cache_control`；可用顶层自动断点或块级显式断点；完整前缀层级为 tools → system → messages | 不能把 OpenAI `prompt_cache_key` 搬成 Anthropic 设计 |
| 断点查找 | 每断点最多向后查 20 blocks，最多 4 个 breakpoints；变化发生在断点前会影响后续 cache | 历史治理要批量、阶段化，避免不断改热前缀 |
| TTL | 默认 5m，可选 1h；命中会免费刷新 TTL；当前类型为 ephemeral | 不是 OpenAI 的 minimum eligibility，也不是 Gemini cache resource 的 expire time |
| 价格 | 5m 写 1.25×、1h 写 2×、读取 0.1×；Batch 折扣可按官方规则叠加 | 1h cache 是否回本取决于复用次数与 idle 分布 |
| 最低长度 | 不同 active model 的最低可缓存长度从 512 到 4096 tokens 不等；不足时静默不缓存 | 必须用 vendor + exact model 阈值表 |
| 失效 | tools、system、messages、thinking、images、tool choice 等有分层失效矩阵 | “对话文本没变”不足以证明 cache 稳定 |
| Batch / tier | Message Batches 约 50% 折扣、24h 过期；批内执行顺序使 cache hit 仅 best effort；Priority 新承诺已停售，仅适用既有客户 | 不能假设 batch 第一条一定先预热，也不能把 OpenAI/Gemini Priority 产品语义套来 |

官方来源：

6. [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
7. [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
8. [Anthropic Message Batches](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
9. [Anthropic Service Tiers](https://platform.claude.com/docs/en/api/service-tiers)

### 2.4 Gemini

| 机制 | 官方事实 | 对 oh-my-pi 的含义 |
|---|---|---|
| Interactions API | 仅隐式缓存；Gemini 2.5+ 默认开启；建议大且共同内容前置、短时间发相似前缀；命中不保证 | “相似前缀”是 Google 文档表述，不能改写成 OpenAI / Anthropic 的 exact-breakpoint 算法 |
| `generateContent` | 同时支持隐式和显式 CachedContent；显式对象默认 TTL 1h，可改 `ttl` / `expire_time`，内容不可读回，仅元数据可读 | Interactions 与 generateContent 能力不能混用 |
| 价格 | 显式缓存除读取价外还有 token × hour 存储费；不同模型、模态、上下文长度费率不同 | 必须把 storage 单列，不能套 Anthropic 的“复用 1/2 次回本” |
| 使用量 | Interactions 暴露 `usage.total_cached_tokens`；generateContent 使用 `usage_metadata` | 保留原始字段，再归一化，不能丢失 API 语义 |
| Batch / Flex / Priority | Batch 只支持 generateContent、目标 24h；Flex 为 Preview、同步慢速且不会自动升级；Priority 为 Preview、超限会降 Standard | Flex 与 Priority 的 fallback 方向相反；Batch 与 Interactions 不互通 |

官方来源：

10. [Gemini Interactions context caching](https://ai.google.dev/gemini-api/docs/caching)
11. [Gemini generateContent context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)
12. [Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing)
13. [Gemini Batch API](https://ai.google.dev/gemini-api/docs/batch-api)
14. [Gemini Flex inference](https://ai.google.dev/gemini-api/docs/flex-inference)
15. [Gemini Priority inference](https://ai.google.dev/gemini-api/docs/priority-inference)

### 2.5 明确禁止的跨厂商泛化

| 错误泛化 | 正确表述 |
|---|---|
| “cached input 都是原价 10%” | Anthropic 当前命中为 0.1×；OpenAI 旧模型可能是 0.25× / 0.5×；Gemini 按模型、模态、长度定价 |
| “写缓存免费” | OpenAI GPT-5.6+ 与 Anthropic 有写入乘数；Gemini explicit 另有存储费；部分旧 OpenAI 行为不同 |
| “cache 都是 5 分钟” | Anthropic 默认 5m；OpenAI GPT-5.6+ 当前至少 30m，旧模型另有规则；Gemini explicit 默认 1h |
| “显式缓存是同一个 API” | OpenAI 是 prefix breakpoint；Anthropic 是 `cache_control`；Gemini generateContent 是独立 CachedContent resource；Interactions 不支持 explicit |
| “Batch 一定在 cache 价上再打五折” | OpenAI、Anthropic、Gemini 的价格表和叠加规则不同，必须逐模型逐字段读取 |
| “Priority / Flex 都会自动回退” | OpenAI、Gemini、Anthropic 的 tier 可用性与 fallback 语义不同；Gemini Flex 明确不自动升级 |
| “cache hit 会释放 context window” | 三家 cache 都不等同历史删除；cached tokens 仍属于模型逻辑输入 |

---

## 3. 社区原始反馈：聚类、支持与反例

> 下列数字全部是原始 issue / 帖子 / HN 评论里的版本化个案。除第一方工程负责人明确说明外，均按**社区轶事**处理；不能直接成为 oh-my-pi 默认 KPI。

### 3.1 原始样本表（15 条）

| # | 原始链接 | 信号 | 证据层级 / 限制 |
|---:|---|---|---|
| 1 | [Claude Code #9579](https://github.com/anthropics/claude-code/issues/9579) | 报告 autocompact 重复处理；四日 token 与约 $235 额外成本明细 | 社区轶事；数字详尽，但根因未获厂商确认 |
| 2 | [Claude Code #23751](https://github.com/anthropics/claude-code/issues/23751) | v2.1.34 在 `/context` 97k/200k 时判满；tools 16.5k、messages 77.7k、buffer 33k | 强复现个案；仅适用当时版本 |
| 3 | [Claude Code #42542](https://github.com/anthropics/claude-code/issues/42542) | 50+ file/grep/bash 后，约 80k 时旧 tool results 静默被清除，用户报告早期信息不可用 | 版本化个案；“模型变笨”仍是单用户判断 |
| 4 | [Claude Code #40524](https://github.com/anthropics/claude-code/issues/40524) | 逐调用 cache_read / cache_create 从稳定读退化到约 224k–230k 全量写 | 强测量个案；history invalidation 是报告者归因 |
| 5 | [Claude Code #49048](https://github.com/anthropics/claude-code/issues/49048) | hook 将约 200 行测试输出缩到约 8 行，日志 tail 100，重复读改 unchanged/diff | 有实现、无独立质量 A/B；不能把局部节省当总成本 |
| 6 | [OpenAI Codex #6426](https://github.com/openai/codex/issues/6426) | 256 行 / 10 KiB、head 128 + tail 128 会丢中段错误 | 强机制反例：粗暴 head/tail 可能导致额外往返 |
| 7 | [OpenAI Codex #19001](https://github.com/openai/codex/issues/19001) | 报告 git/test/docker 输出 60–90% 为噪声，请求内置 RTK | 社区轶事；60–90% 是局部宣传口径，未给完整基线 |
| 8 | [OpenAI Codex #14425](https://github.com/openai/codex/issues/14425) | v0.114.0 在约 15% 剩余上下文时 auto-compaction 可卡 30 分钟 | 版本化可用性个案；不证明普遍质量下降 |
| 9 | [Reddit：两次 prompt / 5 小时](https://www.reddit.com/r/ClaudeCode/comments/1mc7z4c/only_two_prompts_per_5_hour_period_with_about_10/) | 帖内仪表两轮合计约 3.07M input/cache tokens | 社区轶事；无 transcript，订阅 quota 不等于 API 美元成本 |
| 10 | [Reddit：GitHub MCP 开关 A/B](https://www.reddit.com/r/ClaudeCode/comments/1ngag9h/initial_context_comparison_with_and_without_the/) | 初始 `/context` 从启用时 32% 降到禁用时 8% | 社区轶事；无绝对 token、版本与完整控制变量 |
| 11 | [Reddit：MCP tool masking](https://www.reddit.com/r/ClaudeCode/comments/1nwwpdi/tool_for_managing_excess_context_usage_by_mcp/) | 报告约 500 tokens/tool、单 MCP 50–100 tools，用 masking 惰性加载 | 作者自报且推广自建工具；需本地测 schema |
| 12 | [Reddit：MCP vs CLI](https://www.reddit.com/r/ClaudeCode/comments/1n55yli/mcp_vs_cli_tool_usage_on_local_development_which/) | 多用户感觉 CLI 更快、更省，建议按 `/context` 自测 | 弱轶事；无 token A/B，不可推出“所有 MCP 都应禁用” |
| 13 | [HN 47740541](https://news.ycombinator.com/item?id=47740541) | Claude Code 团队负责人说明主 agent 通常 1h cache、subagent 通常 5m；idle >1h 的 1M miss 昂贵 | 第一方工程说明；仅适用当时 Claude Code / Anthropic 路径 |
| 14 | [HN 47880089](https://news.ycombinator.com/item?id=47880089) | 同一负责人说明 N 条消息通常 N−1 命中；>1h 可全 miss，900k 一次写回；删除 thinking 曾引入质量 bug | 第一方工程说明；明确支持“cache 不缩上下文”和有损删除风险 |
| 15 | [HN 47526276](https://news.ycombinator.com/item?id=47526276) | 作者称 git porcelain 重写省 71%；评论者按 3,156 sessions 反算约 60 tokens/session、总体很小 | 关键反例：局部压缩率不能替代端到端分母 |

补充质量反例：

- [HN 47368651](https://news.ycombinator.com/item?id=47368651)：有用户称 1M 在同质逆向任务中到约 700k 仍有价值；也有人在较低占用主动换会话，认为 compaction 会丢刚发现的细节。说明“越早 compact 越好”不成立。
- [HN 45387374](https://news.ycombinator.com/item?id=45387374)：有人报告错误探索会压过后续纠偏，也有人强调大原始上下文使复杂任务可完成。说明“更大窗口”和“更高有效信息密度”不是同一指标。

### 3.2 聚类一：工具负载要分 schema 与 result

**支持信号：**Reddit #10–#12 指向常驻 MCP tool schema；GitHub #5、#7 指向运行期 file/test/git/stdout。两者的生命周期与治理 seam 不同：

- schema：按任务惰性暴露、canonical serialize、记录 `tool_schema_tokens`；
- result：语义裁剪、完整 artifact、分页 / selector 恢复、记录 raw → retained。

**反例：**Codex #6426 显示固定行数或 head/tail 可把根因所在的中段切掉。结论不是“输出越短越好”，而是“保留 exit code、失败用例、首个根因块、异常附近上下文和恢复指针”。

### 3.3 聚类二：长会话成本是每轮输入的面积

累计输入近似：

$$I_{cumulative}=\sum_{t=1}^{T}(U_t+R_t+W_t)$$

不是最后一轮 context 长度。Reddit #9 的两轮仪表与 Claude Code #40524 的 cache-write 放大都支持这一点；HN #13/#14 给出了 Anthropic 路径的第一方解释。

**反例 / 限制：**cache miss 的 TTL、写价与断点规则不可从 Anthropic 外推到 OpenAI 或 Gemini。oh-my-pi 必须保留 vendor/model/api 维度。

### 3.4 聚类三：compaction 可能省 token，也可能成为成本与质量故障

反馈显示三类风险：

1. 摘要调用、重试或循环造成成本放大（#1）；
2. compaction 本身卡住或在过早阈值失败（#2、#8）；
3. 静默删除 tool result / thinking 破坏后续任务（#3、#14）。

**反例：**HN 补充线程中也有人认为长上下文或现有 compaction 在其任务上有效。因此不能把某个固定 40% / 50% 占用阈值当普遍最佳值。必须按任务类型比较 raw、checkpoint+fresh、compact 三臂。

### 3.5 聚类四：局部压缩率常夸大总体收益

GitHub #19001 的 60–90% 和 HN #47526276 的 71% 都是局部工具输出口径；后者有社区反算指出到 session 级可能很小。任何 oh-my-pi 优化必须同时报告：

- `local_reduction = 1 - retained_tool_tokens/raw_tool_tokens`；
- `end_to_end_input_reduction`；
- `$ / successful task`；
- 任务成功率、重读 / 重试、checkpoint 保真度。

### 3.6 聚类五：模型路由可能破坏 cache locality

较便宜模型可降低单 token 价，但新 provider/model/agent 通常需要新的 system/tools/history 前缀；HN #13 还说明 Claude Code main/subagent 的 cache 策略不同。路由收益必须减去 cold prefix write、重复工具上下文、失败回退和摘要调用，不能只比较价目表。

---

## 4. 仓库现状：已有能力与真正缺口

### 4.1 端到端消息与 provider 路径

主路径为：

```text
User / tool result
  → Agent live messages
  → SessionManager append-only JSONL persistence
  → transformContext
  → convertToLlm / provider normalize
  → optional AppendOnlyContextManager
  → transformProviderContext
  → provider encoder + cache semantics
  → usage / cost 回流
  → prune / shake / compaction maintenance
```

事实锚点：

- tool result 规范化后写回 live context：`packages/agent/src/agent-loop.ts:1909-1996`；
- provider 前转换顺序：`packages/agent/src/agent-loop.ts:1230-1278`；
- Session JSONL append：`packages/coding-agent/src/session/session-manager.ts:685-733,1493-1510`；
- compaction 后按 summary + retained tail 重建上下文：`packages/coding-agent/src/session/session-context.ts:154-186,301-436`；
- transport 按 `model.api` 路由：`packages/ai/src/stream.ts:1419-1623`。

### 4.2 已有：artifact spill 与可恢复输出边界

- 通用 inline 默认边界为 3,000 行、50 KiB，grep 单行 512 字符：`packages/coding-agent/src/session/streaming-output.ts:10-12`；
- artifact 默认磁盘总量不截断，完整 raw stream 可由 `artifact://` 恢复；head budget 3 MiB：`packages/coding-agent/src/session/streaming-output.ts:14-22`；
- bash 在最终 tool-result boundary 再执行 inline byte cap，防止中间层漏网：`packages/coding-agent/src/tools/bash.ts:540-574`；
- URL read 使用 50 KiB + 300 行并在截断时落 artifact：`packages/coding-agent/src/tools/fetch.ts:41,1691-1718`；
- truncation metadata 包括总 / 输出 bytes、lines、artifact id 与分页 offset：`packages/coding-agent/src/tools/output-meta.ts:18-39,104-178`。

**结论：**P1 不应重造 storage；应把 semantic selection 与 ordinary profile cap 接到现有最终边界，并保留已有 artifact / pagination 合同。

### 4.3 已有：supersede / useless / age prune

- age prune 默认保护最近 40,000 tokens，只有预计至少节省 20,000 tokens 才执行，并保护 `skill`：`packages/agent/src/compaction/pruning.ts:54-59`；
- superseded 与 useless 使用显式占位符：`packages/agent/src/compaction/pruning.ts:66-70`；
- supersede key 支持同文件 selector 分组，bare read 可覆盖 selector read：`packages/agent/src/compaction/pruning.ts:72-79,403-428`；
- supersede 默认只改 suffix 不超过 8,000 tokens 的候选：`packages/agent/src/compaction/pruning.ts:81-109`；
- 小于 50 tokens 的普通结果不做 age prune，避免占位符反而更长：`packages/agent/src/compaction/pruning.ts:115-123`；
- coding-agent 主 session 将 idle flush 设为 90 分钟，刻意越过 Anthropic long cache：`packages/coding-agent/src/session/agent-session.ts:783-803,10787-10811`。这是面向 Anthropic 1h retention 的当前产品取值，不是跨 provider 最优值；P2 必须按 vendor/model/API 的已观测冷却状态决定 flush，不能全局复用 90 分钟。

**结论：**仓库已认识“改写热前缀有 cache 成本”。P2 应将候选先标记，按阶段 / cache 冷却 / 节省阈值批量提交，而不是每发现一条就重写。

### 4.4 已有：shake 与 compaction

- shake 自动模式保护最近 16,000 tokens、至少节省 4,000 tokens，fenced/XML block 至少 400 tokens；手动 aggressive 为 0/0：`packages/agent/src/compaction/shake.ts:45-61`；
- agent-core compaction 默认支持 context-full、mid-turn、keepRecent 20,000、remote 与 streaming V2：`packages/agent/src/compaction/compaction.ts:163-205`；
- coding-agent 产品默认策略为 `snapcompact`，keepRecent 20,000、V2 retained budget 64,000，idle compaction 默认关闭：`packages/coding-agent/src/config/settings-schema.ts:1973-2064,2110-2140`；
- pre-turn、mid-tool-loop、post-turn 都取 provider billed 与本地 stored estimate 的较大值，避免 provider-bound compression 后永不触发：`packages/coding-agent/src/session/agent-session.ts:11647-11700,11734-11785,11960-12031`；
- compaction summary 输入中的单个 tool result 最多 2,000 字符，`useless` 结果与配对 call 会从摘要输入移除：`packages/agent/src/compaction/utils.ts:199-260`；
- 普通 context-full compaction 本身可能产生额外模型调用；测试代码记录普通 2 spans、split-turn 3 spans：`packages/agent/test/compaction-telemetry.test.ts:106-165`。

**结论：**真正缺的是结构化 checkpoint 合同与保真评估，不是“再加一个摘要按钮”。

### 4.5 已有：append-only 与厂商 cache 接线

- `AppendOnlyContextManager` 冻结 system + tools snapshot，按 message digest 找最长稳定前缀；历史缩短时清空，局部改写时 truncate 到 divergence：`packages/agent/src/append-only-context.ts:156-260`；
- fingerprint / digest 对确定字段 `JSON.stringify` 后 hash：`packages/agent/src/append-only-context.ts:284-349`；
- append-only `auto` 只对特定 provider / local endpoints / supportsStore 开启，不是全 provider 默认：`packages/coding-agent/src/config/append-only-context-mode.ts:10-81`；
- OpenAI Responses 优先用 `promptCacheKey`，否则 `sessionId`，并归一到 64 chars：`packages/ai/src/providers/openai-shared.ts:403-429`；
- OpenAI Responses body 发送 `prompt_cache_key`，兼容时发送 retention：`packages/ai/src/providers/openai-responses.ts:889-950`；
- Anthropic OAuth 与支持 long 的 API-key endpoint 默认 long，映射为 `cache_control: {type:"ephemeral", ttl:"1h"}`：`packages/ai/src/providers/anthropic.ts:440-461`；
- Anthropic 最多应用 4 个 breakpoints，并归一 cache read / creation usage：`packages/ai/src/providers/anthropic.ts:2962-3061,1688-1705,2158-2163`；
- Google 只将 `usageMetadata.cachedContentTokenCount` 归一为 cacheRead，并从 promptTokenCount 扣除，避免双计：`packages/ai/src/providers/google-shared.ts:727-751`。

**结论：**厂商 cache 语义已经正确留在 `packages/ai` provider 层。新的 history policy 不应把三家抽象成同一 TTL / breakpoint；只应提供稳定 provider-visible message 序列和统一观测字段。

**补充事实：当前 checkout 已对常驻 tool schema 做惰性暴露。** `sdk.ts` 会把 ambient discoverable tools 挂载到 `xd://`，只保留 `read` / `write` 传输工具：`packages/coding-agent/src/sdk.ts:2797-2823`。系统 prompt 仅列设备名与单行摘要，完整 docs + JSON schema 首次使用前通过 `read xd://<tool>` 加载：`packages/coding-agent/src/tools/xdev.ts:1-20,228-261`。因此 schema 方向的下一步应是 P0 测量该机制的实际命中、误路由与 token 收益，不是再造第二套 tool masking；P1 主攻仍是运行期 tool results。

### 4.6 已有：usage 与 cost 桶

- finalized assistant usage 会持久化 context snapshot：`packages/coding-agent/src/session/agent-session.ts:4450-4478`；
- session stats 汇总 input / output / reasoning / cacheRead / cacheWrite / total / cost：`packages/coding-agent/src/session/agent-session.ts:17350-17422`；
- run collector 明确把 cost-bearing input 定义为 input + cacheRead + cacheWrite，并保留各桶：`packages/agent/src/run-collector.ts:206-235`；
- telemetry 会发 usage、cost estimator、`onChatUsage` 与 collector：`packages/agent/src/telemetry.ts:1112-1160`。

**缺口：**这些桶回答“花了多少”，还不能回答“为什么花”：缺 provider-visible system/schema/user/assistant/tool-result/checkpoint 分类，缺 raw→retained tool 指标，缺 prefix fingerprint、idle duration、rewrite reason、compaction side-call 与恢复率。

### 4.7 关键事实空白：ordinary model profile 未接主会话

profile 已经声明：

- `bash/read/grep/*` 的 1.5–6 KB / 行数 / preservePatterns 规则；
- `resultSummarization`；
- `targetUtilization`；
- `preserveUserTurns`、`evictPersisted:false`、`keepRecentN`；
- `toolHistory.maxToolCalls` 与 `summarizeOld`。

证据：`packages/coding-agent/src/model-optimization/default-profiles.ts:9-44,51-110`。

但 resolved policy 只产出 `promptBlock`、`toolScheduling` 与 `contextStrategy`，没有 output manager / summary adapter：`packages/coding-agent/src/model-optimization/runtime-policy.ts:52-64`。

主会话实际接线：

- `transformContext` 只执行 `extensionRunner.emitContext` 与 `wrapSteeringForModel`：`packages/coding-agent/src/sdk.ts:2867-2870`；
- `transformProviderContext` 只做 secret obfuscation、snapcompact inline 与 image clamp：`packages/coding-agent/src/sdk.ts:2888-2892`；
- Agent 的 `toolScheduling` 只来自 `workflowToolOptimization`：`packages/coding-agent/src/sdk.ts:2944-2993`；
- `modelOptimizationContextStrategy` 只有 getter：`packages/coding-agent/src/session/agent-session.ts:7261-7269`。

**事实结论：**ordinary profile 的 output truncation / summarization / context strategy 被定义、解析、暴露，但没有接入 ordinary 主会话的 provider-bound transform / tool-result final boundary。profile 中的数值不是当前主会话真实执行上限。

**推断：**这是当前最高优先级实现缺口。先接 deterministic output truncation 和 provider-only context policy；LLM summarizer 后置，避免把一个未观测问题变成额外隐藏调用。

---

## 5. 目标指标与成本模型

### 5.1 原始字段必须保留

每次 provider 调用建议记录：

```text
vendor, model, api, service_tier, agent_role
input_tokens, cache_read_tokens, cache_write_tokens, output_tokens
provider_raw_usage
system_tokens, tool_schema_tokens, user_tokens, assistant_tokens
retained_tool_result_tokens, checkpoint_tokens
prefix_fingerprint, tool_schema_fingerprint, stable_prefix_tokens
idle_duration_ms, history_rewrite_reason
latency_ms, ttft_ms, retry_count, fallback, stop_reason
compaction_input/output_tokens, compaction_latency, compaction_retry
```

`provider_raw_usage` 必须保留；统一字段用于看板，不能反向抹平厂商语义。

### 5.2 核心公式

1. **累计处理输入**

$$I_{processed}=\sum_t(U_t+R_t+W_t)$$

2. **cache read 输入占比**

$$H_{read}=\frac{\sum R_t}{\sum(U_t+R_t+W_t)}$$

仅在同 vendor/model/api 内比较；跨厂商只作描述，不作统一 SLO。

3. **cache 写放大**

$$A_{write}=\frac{W_t}{\operatorname{median}(W_{t-5:t-1})+\epsilon}$$

另报绝对写 token，避免低基数误报。

4. **工具输出局部裁剪率**

$$S_{tool}=1-\frac{retained\_tool\_tokens}{raw\_tool\_tokens}$$

5. **provider-visible 工具占比**

$$Q_{tool}=\frac{retained\_tool\_result\_tokens}{provider\_visible\_input\_tokens}$$

6. **重试 / 重放放大**

$$A_{retry}=\frac{\sum(U_t+R_t+W_t)}{unique\_admitted\_context\_tokens}$$

7. **端到端成本**

$$C_{task}=\sum_t(U_tP^U_t+R_tP^R_t+W_tP^W_t+O_tP^O_t)+C_{storage}+C_{summary}+C_{retry}+C_{fallback}$$

Gemini explicit 的 token-hour storage 必须进入 $C_{storage}$；其他厂商不存在相同语义时为 0。

8. **每个成功任务成本**

$$C_{success}=\frac{\sum C_{task}}{N_{successful}}$$

这是模型路由的主目标；不得用“平均 token 单价”替代。

9. **checkpoint 保真度**

$$R_{checkpoint}=\frac{正确恢复的任务不变量}{应保留的任务不变量}$$

任务不变量至少包括：用户目标、明确否决项、安全约束、已改文件 / 符号、关键证据、未解错误、已运行验证及结果、下一步。

### 5.3 建议门禁（非厂商承诺）

| 门禁 | 建议阈值 | 失败动作 |
|---|---:|---|
| 任务成功率 | 相对 baseline 不下降超过 **1 个百分点** | 回滚对应策略 |
| 用户明确约束 / 安全约束 checkpoint 召回 | **100%** | 禁止上线 compaction |
| 其他 checkpoint 不变量召回 | **≥95%** | 保留 raw / 降低压缩强度 |
| 裁剪后错误关键信号召回 | **≥99%**；含 exit code、失败用例、错误类型、首个根因位置 | 回滚该 tool 策略 |
| artifact 可恢复性 | 裁剪样本 **100%** 有效指针，抽样可重开 | 停用裁剪 |
| P1 局部 tool-result reduction | 建议 **≥50%** | 不代表失败，但不改默认 |
| P1 端到端 processed input reduction | 建议 **≥15%** 且质量过门 | 否则仅保留 opt-in |
| cache 稳定性 | 同一稳定前缀 fingerprint 不变；cache-read 不低于同模型 baseline | 检查序列化 / rewrite |
| cache write spike | provider 确实报告非零 write 时，建议单轮 >50k 或高于近 5 轮中位数 **10×** 告警；不报告 write 的 transport 改用 uncached-input spike + prefix divergence | 冻结 history rewrite；先校准可观测字段 |
| compaction thrash | 建议 3 个 provider turns 内再次 compact 视为 thrash | 停止自动重试，恢复 checkpoint/raw |
| 自动 compaction 重试 | 建议最多 **1 次** | 转显式失败，不循环 |
| 模型路由 | `$ / successful task` 建议下降 **≥10%**，成功率门禁同时通过 | 回滚路由 |

---

## 6. 实施方案

### 6.1 P0：测量与质量门禁

**目标：**先让每一美元、每一次 history rewrite 和每一个被裁剪字节可解释。

动作：

1. 在 provider-bound context 形成后、provider encoder 前统计类别 token；本地估算与 provider usage 分开命名。
2. 对每个 tool result 记录 raw bytes/tokens、retained bytes/tokens、策略、artifact、是否后续 re-read。
3. 记录 system/tools canonical fingerprint、provider-visible stable prefix fingerprint、idle duration、history rewrite reason。
4. 将 compaction / summarizer side call 单独记账，不并入“主回答调用”后消失。
5. 建立固定 workload：长活跃会话、跨 TTL idle 恢复、10/50/100 tools、200+ 行测试输出、错误位于中段的大日志、重复 read、两次 compaction、模型切换、并行 subagents。
6. 对每个任务记录成功、用户纠正、重试、重复 tool read、checkpoint 召回。

验收：

- 同一调用的分桶估算可以解释 provider-visible context；分桶之和与本地总估算差异有明示误差；
- provider 原生 usage 未丢字段；
- P0 shadow mode 不改变发给模型的 bytes / message sequence；
- 能复现当前会话级报表：累计 usage、成本桶、工具输出占比与 cache read 占比。

回滚：P0 本身只观测；若 telemetry 增加明显延迟或内存，关闭细粒度 payload 分类，但保留原始 usage 和 tool raw/retained 计数。

### 6.2 P1：可恢复工具输出语义裁剪 + ordinary profile 接线

**目标：**删除噪音，不删除信息；先 deterministic，后 LLM。

建议执行 seam：

1. 在 tool result 形成最终 `ToolResultMessage` 前应用 active ordinary profile 的 `outputTruncation.rules`；
2. 复用现有 `OutputMeta` 与 `artifact://`，完整原文先落 artifact；
3. `read` 保留结构摘要、匹配行、selector / offset；`grep` 保留命中计数、文件分布、代表性行和继续分页方式；
4. `bash/test` 保留 exit code、失败用例、首个错误块、异常前后窗口、最终摘要；成功噪音可计数折叠；
5. `preservePatterns` 只能作为辅助，不可只保留命中单行；需保留语义块；
6. 将 `modelOptimizationContextStrategy` 接入 provider-only 发送副本，绝不修改 SessionManager JSONL；保留 user turns，按 `maxToolCalls/keepRecentN` 只治理 tool history；
7. 在没有 P0 质量证据前，暂不执行 profile 的 LLM `resultSummarization`。

为什么 provider-only：

- 原始 transcript / artifact 可恢复；
- 模型切换后可以按新 profile 重建；
- 回滚只关闭 transform，不需要修复持久化历史；
- 与现有 `evictPersisted:false` 设计一致。

验收与回滚使用 §5.3 门禁。特别要求：错误在中段的日志必须进入回归集，防止重现 Codex #6426 的 head/tail 失真。

### 6.3 P2：cache-aware 批量历史治理 + checkpoint compaction

这里的“批量”指**在一个 history maintenance transaction 中合并多个 prune / supersede / useless / shake 候选**，不是厂商异步 Batch API。

#### A. cache-aware 批量治理

1. 候选产生时先标记，不立刻逐条 rewrite；
2. 满足任一条件再提交：阶段边界、cache 已冷、逼近 context budget、预计净节省超过建议阈值；
3. 在一次 rewrite 中同时处理 superseded read、useless result、过期大 tool result；
4. 计算净收益：被省 provider-visible tokens 减去 cache write 增量、占位符、恢复重读与维护成本；
5. 若 prefix fingerprint 变化但节省不足，推迟治理；
6. 厂商 adapter 只提供 observed cache state / usage；flush 时机按 vendor/model/API 与实测冷却状态配置，不把 TTL 或 90 分钟统一成全局常量。

验收：稳定前缀在非治理 turn 不变化；一次 batch rewrite 后的 cache write 不超过所省 token 的可接受范围；后续 re-read / retry 未显著上升。

#### B. 结构化 checkpoint / compaction

compaction 前生成机器可检查的 checkpoint：

```text
goal
user_constraints_and_rejections
security_and_scope_boundaries
decisions_with_evidence
changed_files_and_symbols
open_errors_and_hypotheses
verification_run_and_results
artifact_and_source_pointers
next_actions
```

规则：

- checkpoint 是控制面，摘要是叙述面；先验证控制面，再让模型生成短叙述；
- 用户明确否决项、安全 / 范围约束必须逐项保留；
- 大原始证据不重复塞入 checkpoint，只保留可重开 artifact / file:line / URL；
- compaction 发生在阶段边界，任务中途只在硬 context 压力下触发；
- 记录 compaction side-call、重试、前后 tokens、3 turns 内是否再次 compact；
- 对长调查 / 逆向类任务允许较高 raw retention，不强求统一占用阈值。

### 6.4 P3：评估后才启用路由与 LLM summarizer

#### 总成本模型路由

路由候选评分至少包括：

```text
expected cold-prefix write
+ expected cached reads
+ expected output/reasoning
+ expected retries/fallback
+ tool schema/history duplication
+ compaction/summarizer calls
+ latency/failure penalty
```

限制：

- 同一长会话的模型切换默认视为 cache cold-start，除非 provider 原生证据证明复用；
- review / safety /高风险变更不因单价自动降模型；
- 路由必须按任务类型评估，不允许用不同题集比较模型；
- 失败 fallback 要计入原候选策略成本；
- 只有 `$ / successful task` 与质量门禁同时通过才启用。

#### LLM tool-result summarizer

仅在 deterministic 裁剪出现以下证据时评估：

- 某类输出无法可靠用 parser / block selection 保留根因；
- artifact re-read 明显增加；
- 任务成功率因 deterministic 裁剪下降。

摘要器自身必须记录输入、输出、模型、成本、延迟、失败与原文 artifact；摘要失败不得替换原文为 no-op / 空内容。

---

## 7. 30 / 60 / 90 天 rollout

### Day 0–30：P0 基线 + P1 shadow

交付：

- provider usage 原始字段与统一桶；
- context category、tool raw/retained、prefix fingerprint、rewrite reason；
- 任务级 `$ / successful task` 与成功率；
- P1 只计算“本可裁剪成什么”，不改变 provider payload；
- 固定回归 workload 与 checkpoint 不变量标注。

建议退出条件：

- 至少覆盖主要 vendor/model/api 路径；
- 连续两周能解释 p50/p95 token 与成本变化；
- shadow selector 在错误信号召回上达到建议门禁；
- 不再用 session 最终长度替代累计 processed input。

回滚条件：telemetry 造成建议 **>3%** p95 latency 或明显内存回归时，降低采样率；此数值是工程建议。

### Day 31–60：P1 小流量 → 默认；P2 shadow

交付：

- ordinary profile deterministic output truncation 接入主会话；
- provider-only context strategy 接线；
- 5% → 25% → 50% 建议阶梯放量；
- batch history governance 只记录候选与预计净收益；
- checkpoint 在 shadow 中生成并评估，不替换历史。

每阶梯建议至少观察一周，并满足：任务成功率、错误召回、artifact 恢复、端到端 processed input、重试 / re-read 都通过 §5.3。任何阶梯失败，回到上一档；不得通过放宽质量评分来保留节省。

### Day 61–90：P2 有限启用；P3 离线评估

交付：

- cache-aware batch pruning 先在 cache-cold / 明确阶段边界启用；
- checkpoint compaction 先覆盖结构清晰的编码任务，再覆盖长调查；
- 显示删了什么类别、节省多少、如何恢复；
- 路由和 LLM summarizer 做离线 / shadow 三臂评估；只有通过总成本与质量门禁时，建议最多 5% cohort 启用。

90 天结束时的决策：

- P0/P1 通过则成为 ordinary 主会话默认能力；
- P2 按任务类型与 provider 维持不同策略，不追求一个全局 threshold；
- P3 若只降低单价、却增加 cold write / retry 或降低成功率，则保持关闭；
- 没有实测优势的 profile 字段应标记为未执行或删除，不能继续给用户“已优化”的错觉。

---

## 8. 验收与回滚矩阵

| 变更 | 验收证据 | 建议回滚条件 | 回滚方式 |
|---|---|---|---|
| P0 observability | 原始 usage 可追溯；类别之和有误差说明；不改 payload | 延迟 / 内存超过建议预算 | 降采样或关细分桶，保留 provider raw usage |
| P1 tool semantic trim | 中段错误、失败用例、exit code、artifact 恢复通过；任务成功率不降 | 成功率下降 >1pp、错误召回 <99%、artifact 失效 | 关闭 per-tool / per-model rule，发送原文 |
| P1 provider-only context | JSONL 不变；user turns 保留；provider payload 按 profile 有界 | 用户约束丢失、模型切换恢复错误 | 关闭 transform，重建原始 session context |
| P2 batch pruning | rewrite 次数下降、净 token / 成本下降、cache write 无异常放大 | write spike、re-read / retry 上升、净成本不降 | 冻结候选，不提交 rewrite |
| P2 checkpoint compact | 约束 100%、其他不变量 ≥95%、无 3-turn thrash | 约束遗漏、自动重试 >1、任务失败 | 恢复 raw tail / checkpoint 前分支 |
| P3 routing | 同题集 `$ / successful task` 下降且质量门禁通过 | 质量下降、cold-prefix 成本吞掉单价收益、fallback 上升 | 固定回原模型/profile |
| P3 LLM summarizer | 比 deterministic 更高保真且净成本下降 | 隐藏调用成本、延迟或失败超过收益 | 回到 deterministic + artifact |

---

## 9. 不建议做的事

1. **不把 cache 当 context compression。** 这会推迟必要的历史治理，直到窗口压力才被动 compact。
2. **不按单条 tool result 立即改写历史。** 热 cache 上的频繁 rewrite 可能比保留几千 tokens 更贵。
3. **不以固定 head/tail 代替语义裁剪。** 中段错误是已知反例。
4. **不静默删除 thinking、用户否决项、未解错误或验证结果。** 社区与第一方反馈都显示质量风险。
5. **不先启用 LLM summarizer。** 它增加调用、路由、成本、延迟和失败面。
6. **不先按标价路由模型。** 跨模型 cold prefix 与 fallback 可能抵消单价收益。
7. **不承诺“总 token 降 60–90%”。** 论坛数字多为工具局部口径；本会话估算也显示分母选择会把占比从 6.06% 变成 39.01%。
8. **不把厂商 TTL、breakpoint、cached pricing、Batch / Flex / Priority 统一成一个枚举后假定同义。** 可以统一观测字段，不能统一语义。

---

## 10. 最终建议

oh-my-pi 已有深度足够的底层能力：完整 artifact、结构化输出 metadata、supersede/useless、cache-tail 保护、shake、compaction、append-only prefix、厂商 cache adapter 与 usage buckets。当前最值得做的不是增加另一套压缩框架，而是：

1. **让 ordinary 主会话真正执行已经声明的 profile；**
2. **在 provider-bound、非持久化副本上做可恢复的 deterministic 信息密度优化；**
3. **用 prefix fingerprint 与 provider 原始 usage 约束历史 rewrite；**
4. **把 prune 从零散事件改成阶段化 batch transaction；**
5. **把 compaction 从自由文本摘要升级为可检查 checkpoint；**
6. **最后才用总成本而非单价决定模型路由和 LLM summarizer。**

当前会话已提供一个明确基线：缓存读取占 processed input 84.45%，但累计成本仍为 $2.198106，工具原始结果约 101k tokens，且 `read` 占工具字符量 83.58%。这正说明优化目标不是“再提高一个 cache 百分比”，而是降低进入长会话的无效增量，同时不破坏可复用前缀与任务记忆。

---

## 11. 来源索引

### 11.1 官方（15）

1. https://developers.openai.com/api/docs/guides/prompt-caching
2. https://developers.openai.com/api/docs/pricing
3. https://developers.openai.com/api/docs/guides/batch
4. https://developers.openai.com/api/docs/guides/flex-processing
5. https://developers.openai.com/api/docs/guides/priority-processing
6. https://platform.claude.com/docs/en/build-with-claude/prompt-caching
7. https://platform.claude.com/docs/en/about-claude/pricing
8. https://platform.claude.com/docs/en/build-with-claude/batch-processing
9. https://platform.claude.com/docs/en/api/service-tiers
10. https://ai.google.dev/gemini-api/docs/caching
11. https://ai.google.dev/gemini-api/docs/generate-content/caching
12. https://ai.google.dev/gemini-api/docs/pricing
13. https://ai.google.dev/gemini-api/docs/batch-api
14. https://ai.google.dev/gemini-api/docs/flex-inference
15. https://ai.google.dev/gemini-api/docs/priority-inference

### 11.2 社区原始链接（17）

1. https://github.com/anthropics/claude-code/issues/9579
2. https://github.com/anthropics/claude-code/issues/23751
3. https://github.com/anthropics/claude-code/issues/42542
4. https://github.com/anthropics/claude-code/issues/40524
5. https://github.com/anthropics/claude-code/issues/49048
6. https://github.com/openai/codex/issues/6426
7. https://github.com/openai/codex/issues/19001
8. https://github.com/openai/codex/issues/14425
9. https://www.reddit.com/r/ClaudeCode/comments/1mc7z4c/only_two_prompts_per_5_hour_period_with_about_10/
10. https://www.reddit.com/r/ClaudeCode/comments/1ngag9h/initial_context_comparison_with_and_without_the/
11. https://www.reddit.com/r/ClaudeCode/comments/1nwwpdi/tool_for_managing_excess_context_usage_by_mcp/
12. https://www.reddit.com/r/ClaudeCode/comments/1n55yli/mcp_vs_cli_tool_usage_on_local_development_which/
13. https://news.ycombinator.com/item?id=47740541
14. https://news.ycombinator.com/item?id=47880089
15. https://news.ycombinator.com/item?id=47526276
16. https://news.ycombinator.com/item?id=47368651
17. https://news.ycombinator.com/item?id=45387374
