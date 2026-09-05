# Research: Reasonix 高缓存命中率机制，以及 omp 可复用点

Date: 2026-08-13  
Scope: DeepSeek-Reasonix 如何把 prefix cache 做成产品行为；哪些是 DeepSeek 专属，哪些可复用到 oh-my-pi。  
Primary sources:

- `/Users/sheng/tencent/DeepSeek-Reasonix/REASONIX.md`
- `/Users/sheng/tencent/DeepSeek-Reasonix/CONTRIBUTING.md`
- `/Users/sheng/tencent/DeepSeek-Reasonix/internal/control/input.go`（`Compose`）
- `/Users/sheng/tencent/DeepSeek-Reasonix/internal/boot/boot.go`
- `/Users/sheng/tencent/DeepSeek-Reasonix/internal/agent/cache_shape.go`
- `/Users/sheng/tencent/DeepSeek-Reasonix/internal/environment/probe.go`
- `/Users/sheng/tencent/DeepSeek-Reasonix/internal/config/cache_policy.go`
- `/Users/sheng/tencent/DeepSeek-Reasonix/docs/SPEC.md` §3.2 / §3.5 / compaction
- `/Users/sheng/tencent/DeepSeek-Reasonix/docs/research/cache-aware-compaction-design.md`
- `/Users/sheng/tencent/DeepSeek-Reasonix/scripts/{cache-guard,check-cache-impact}.sh`
- omp: `packages/agent/src/append-only-context.ts`、`packages/coding-agent/src/system-prompt.ts`、`docs/compaction.md`
- DeepSeek 官方: [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)、[Reasonix 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/reasonix/)、[定价](https://api-docs.deepseek.com/quick_start/pricing)
- 社区: [HN #48256953](https://news.ycombinator.com/item?id=48256953)、[dev.to](https://dev.to/arshtechpro/reasonix-deepseek-a-terminal-coding-agent-built-around-the-thing-everyone-else-ignores-3l21)、[Developers Digest](https://www.developersdigest.tech/blog/deepseek-reasonix-cache-first-coding-agents)、[GitHub #530](https://github.com/esengine/DeepSeek-Reasonix/issues/530)

Twitter/X 被自动化抓取拦截；X 上的数字口径来自二次转述，单独标注。

## 一句话结论

Reasonix 的「极高命中率」不是 DeepSeek 私有算法，而是一套**应用层纪律**：把发给模型的前缀（系统提示 + 工具定义 + 早期历史）做成跨轮次字节级稳定，让厂商的自动前缀缓存一直热着。

便宜来自 DeepSeek 的计价差：缓存命中大约是未命中价的 2%。手法本身对 Anthropic / OpenAI / 本地 llama.cpp 都成立，只是折扣和 TTL 不同。

omp 已经有半套（`appendOnlyContext`、cache-aware prune、status-line 命中率）。缺的是「把前缀当产品契约」：日期、召回、心智模型、MCP schema 仍会在会话中改系统提示。

## 1. 宣传数字怎么读

| 说法 | 性质 | 出处 |
| --- | --- | --- |
| 长会话 90–99%+ 命中 | 产品目标 + 发布门禁默认阈值 90% | `TestReleaseCacheHitGuard`，`REASONIX_CACHE_GUARD_THRESHOLD` 默认 90 |
| 单日 4.35 亿 input、99.82% 命中、~$12 vs ~$61 | 社区反复引用的一次真实会话，**本仓库未复现** | [ByteIota](https://byteiota.com/deepseek-reasonix-cuts-ai-coding-costs-80-heres-the-catch/)、HN 二次转述 |
| V4-Flash hit $0.0028 / miss $0.14 / 1M tokens | 官方定价（2026-08 文档口径；8/16 将改峰谷价） | [DeepSeek Pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| DeepSeek 官方推荐 Reasonix | 事实 | [Integrate with Reasonix](https://api-docs.deepseek.com/quick_start/agent_integrations/reasonix/) |

README 本体反而克制：只写 “cache-aware context maintenance”，不把 99.82% 写进仓库首页。数字主要在社区稿和发布叙事里。

算术：命中价 / 未命中价 ≈ 0.0028 / 0.14 = 2%。长会话里系统提示 + 工具 + 旧历史占绝大多数 input，命中率到 99% 时，input 账单可以掉一个数量级。输出 token 不享受这个折扣。

## 2. 厂商层：DeepSeek 给了什么

DeepSeek「硬盘上下文缓存」对所有用户默认开启，客户端不用打 `cache_control`。规则是：

1. 从 token 0 起，和最近一次请求的前缀做**字节级**匹配。
2. 匹配上的那段按 cache-hit 计价，其余按 cache-miss。
3. 前缀任意一处变化（时间戳、工具顺序、空白、JSON key 顺序）都会让其后全部失效。
4. TTL 按官方说法是「数小时到数天」。Reasonix 因此把 DeepSeek 默认 TTL 设成 **24h**；Anthropic / 阿里云 DashScope 是 **5min**（`internal/config/cache_policy.go`）。

这是供应商能力，不是 Reasonix 发明的。Reasonix 做的是：**别把前缀弄脏**。

对照：

| | DeepSeek | Anthropic | 本地 llama.cpp / Ollama |
| --- | --- | --- | --- |
| 开启方式 | 自动，无 markup | 要 `cache_control` 断点 | 自动 KV prefix |
| 匹配 | 从位置 0 的公共前缀 | 显式缓存块 | 公共前缀 |
| 命中折扣 | ~98% | 大约读缓存 = 输入的 10% | 省的是预填充时间，不是账单 |
| TTL | 小时–天 | 默认 5 分钟 | 进程/显存寿命 |
| 应用层纪律是否通用 | 是 | 是 | 是 |

所以：「高命中」对 DeepSeek 最赚钱；对本地模型最省等待；对 Anthropic 也省，但窗口短、折扣小。

## 3. Reasonix 怎么做到的

核心约束写在 `REASONIX.md`：

> Cache-first: the system-prompt prefix (base prompt + tools + memory) must stay byte-stable across turns so DeepSeek's automatic prefix cache stays warm. Never mutate it mid-session — ride the turn tail instead (`control.Compose`).

### 3.1 前缀冻结，变化坐尾巴

会话启动时一次性装进系统提示：

- 基座 prompt + output style
- 工具 schema（注册时规范化）
- 环境摘要（见 3.2）
- 工作区路径（固定字符串，无目录树）
- 项目记忆 / `REASONIX.md` / skill **索引**

会话中途变化一律进**当前用户轮**，不改系统提示（`internal/control/input.go` `composeWithGoal`）：

| 变化 | 挂载位置 |
| --- | --- |
| 中途写入的 memory | `<memory-update>`，下个会话才折进前缀 |
| 自动召回 | 用户句尾巴，且只在真实用户轮 |
| 后台任务完成 | `<background-jobs>` |
| hook / SessionStart | `<hook-context>` |
| 目标、Plan Mode、语言 | 用户句前缀标记 |
| 规划/审查强度 | `<execution-policy>` 用户块，不改系统提示（`boot.go`） |
| planner 深度 | `<planner-turn>`，系统提示共用一份 |

前端仍显示用户原文；模型看到的是 Compose 后的尾巴。

### 3.2 环境摘要只探一次，而且排序

`internal/environment/probe.go`：

- 启动探测 OS / Shell / 一组固定工具版本
- 结果按名字排序，最多渲染 24 个
- 进程内 5 分钟缓存 + 磁盘 snapshot；刷新时用旧 snapshot 填瞬时失败，避免「某次 `go version` 失败」改掉前缀
- **没有当前时间，没有按 mtime 排序的目录树**

测试钉死稳定字段：`- OS:`、`Detected tools:`。

### 3.3 工具 schema 当合约

`docs/SPEC.md` §3.2：registry 插入时规范化 schema；`TOOL_CONTRACT.md` + golden `provider_request.json` 回归。  
`cache_shape.go` 比较前还会再按 name/description/parameters 排序后哈希。

已知缺口：MCP `tools/list` 顺序和 JSON key 顺序仍可能抖。[#530](https://github.com/esengine/DeepSeek-Reasonix/issues/530) 提议：按注册名排序、递归排 object key、只对 `required` 这种集合排序、保留 `enum`/`oneOf` 语义顺序。V1 关闭，迁到 V2。

### 3.4 Compaction 不改写正本，也不因 cache 变冷而改写

`docs/research/cache-aware-compaction-design.md`：

```
canonical transcript（永不因普通维护改写）
    └── 模型可见投影：stable prefix + 一条 summary + recent tail
cache 状态（warm/cold/unknown）只影响成本和观测，不触发历史改写
```

- 唯一自动触发：`compact_ratio`（默认 0.85）
- 首次跨阈值：预期一次 miss；装上后前缀再稳住
- resume 只记 TTL，不 compact、不 prune
- 工具结果在**写入时**截到约 32KB 可见内容；完整原文进 `RawContent`，不进 provider 序列化
- 旧的多阈值 snip/prune/cold-resume-prune 已退役，因为会在 resume 时打穿前缀

### 3.5 两个模型两套 session

`SPEC.md` §3.5：planner 和 executor 分 session，各保各的前缀。深度合同写在稳定系统提示里，每轮只换一小块 `<planner-turn>`。

### 3.6 把命中率做成工程门禁

这是和「写了 append-only」最大的差别。

1. **运行时诊断**（`PrefixShape` / `CompareShape`）  
   对 system / tools / 内容改写原因分别哈希。miss 时能说是 `system`、`tools` 还是 `compact_auto`。本地-only 元数据改动不报 cache change。
2. **状态栏**展示命中率。
3. **PR 模板 + CI**（`scripts/check-cache-impact.sh`）  
   改 `internal/boot/`、`internal/tool/`、`internal/provider/`、`internal/memory/` 等路径必须填：
   - `Cache-impact: none|low|medium|high`
   - `Cache-guard:`
   - 动系统提示还要 `System-prompt-review:`
4. **发布门禁** `scripts/cache-guard.sh`  
   mock DeepSeek：用「与上一请求公共前缀字节」模拟命中。场景含对话 / 长对话 / 工具循环 / 有无 reasoning。尾部 3 次平均 < 90% 记 warning；`REASONIX_CACHE_GUARD_STRICT` 才 fail。

没有这套，前缀稳定是愿望；有这套，才是产品行为。

## 4. 社区反馈（分层）

**事实**

- 2026-05 左右 HN 登顶（[#48256953](https://news.ycombinator.com/item?id=48256953)）。DeepSeek 官方文档收录集成步骤。
- 社区共识：普通 agent 每轮改时间戳、重扫目录树、重排工具、改 mode 就重写系统提示，账单 silently 涨几倍。dev.to 原文把这称作 “the thing everyone else ignores”。
- MCP schema 非确定性是明确技术债（#530）。

**推断（社区口径，未在本仓库复现）**

- 长会话 90%+ 常见；99.82% 是「前缀几乎不动 + DeepSeek 长 TTL + 当天不 compact」的上限样本。
- 推理链很长的任务命中率会低一些（输出不进缓存折扣；reasoning 回灌会拉长未命中尾巴）。[INFERENCE]

**反对意见 / 代价**

- [Developers Digest](https://www.developersdigest.tech/blog/deepseek-reasonix-cache-first-coding-agents)：不要只追命中率。便宜复用也可能把失败推理冻在前缀里。建议同时看 cache-bust 原因、重试、测试、返工、单次合入成本。
- HN 上有人对比 DS 与 GPT：省钱 ≠ 不抄近路。缓存优化解决的是账单，不是模型质量。
- Twitter 原文未能直接读取。中文圈「命中率 90%+、输入大约 1/5 价」与官方折扣数量级一致，但是转述。

## 5. omp 现在有什么

已经对准同一物理机制：

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| 冻结 system + tools | `AppendOnlyContextManager` / `StablePrefix` | 有。fingerprint 变才重建 |
| DeepSeek / 本地 / 小米自动开 | `shouldEnableAppendOnlyContext` | `auto` 默认对这些开 |
| 消息层最长稳定前缀 | `syncMessages` | 修过「改一条就整段重发」 |
| 侧路请求共用缓存 | `buildSideRequestContext`、handoff | 有 |
| 显式 cache key | `promptCacheKey` | 给需要 markup 的厂商 |
| 冷缓存才改写旧 tool 结果 | `pruneSupersededToolResults` idle gap | 有，和 Reasonix TTL 政策同构 |
| 命中率 UI | `cache_hit` status segment | 有；DeepSeek 的 miss 记在 `input` |
| `/fresh` | session ops | 有，清 stale cache |
| xd:// 非 MCP 目录不进 prompt 签名 | `session-tools.ts` | 有意识保前缀 |

## 6. omp 仍在打穿前缀的点

按「会不会改系统提示 / 工具字节」排序。

### P0 — 值得直接搬

1. **日期写在系统提示里**  
   `project-prompt.md`：`Today is {{date}}`。`formatLocalCalendarDate()` 是本地日历日。  
   `session-tools.ts` 把日期编进 tool signature，跨午夜会 `rebuildSystemPrompt`。  
   注释写明这是有意的（否则跨夜会停在昨天）。代价是：跨夜长会话必 miss 一次整段前缀。  
   Reasonix 前缀里没有日期。

2. **召回 / 心智模型改 base prompt**  
   Hindsight `refreshBaseSystemPromptAfter("recall" | "MM load")` 直接重绘系统提示。  
   Reasonix 对等物是 `<memory-update>` / 召回块挂在用户轮。  
   这是 omp 和 Reasonix 差距最大的产品选择，不是漏实现。

3. **缺 miss 归因**  
   omp 能显示 80.00%，不能说是日期、MCP、skill 还是 compact。  
   Reasonix 的 `PrefixChangeReasons` 把「为什么贵」变成可修的 bug。

4. **缺 cache-impact 门禁**  
   改 `system-prompt.md`、工具 schema、memory 前缀没有 PR 必填项，也没有「发给 provider 的字节」黄金测试。  
   `append-only-context-mode.test.ts` 只测开关，不测前缀稳定性。

### P1 — 可分阶段做

5. **MCP / 工具 schema 规范化**  
   omp 对 MCP instructions 做了排序，但 schema object key / `required` 顺序、`tools/list` 顺序未看到与 #530 同级的规范化。热插拔 MCP 仍是经典 miss 源。

6. **模式/人设进系统提示**  
   Reasonix 把 role 从系统提示挪到每轮 `<execution-policy>`。omp 的 personality、部分 mode 文本仍在 `buildSystemPrompt`。切换 mode = 换前缀。

7. **环境块比 Reasonix 更抖**  
   omp `<workstation>` 含 `os.release()`、kernel、Terminal 名。一般稳定，但比 Reasonix 的 `GOOS/GOARCH` 面宽。  
   `includeWorkspaceTree` 默认 false（好）；若打开且按 mtime 排，等于每轮都能打穿前缀。

8. **双模型共前缀**  
   Reasonix 强制 planner/executor 分 session。omp vibe 已有独立 worker session；主会话里切模型会 `invalidateForModelChange()`，这是对的，不要为了「省一次冷启动」把两个模型焊在同一前缀上。

### 不要照搬

- 不要把 99.82% 当 KPI。那是 DeepSeek + 整天不改前缀的上限样本。
- 不要为了命中率去掉日期而不给模型任何日期。放到用户轮尾巴即可。
- 不要把 cache TTL 绑回「自动改写历史」。omp 的 idle-gap prune 方向已经对。
- 不要用命中率代替正确性。社区已经在说这件事。

## 7. 建议落地顺序（只分析，不实施）

若要把 Reasonix 的成本优势迁到 omp，按杠杆排序：

1. **诊断先于优化**  
   给每次 provider 请求记 `systemHash` / `toolsHash` / `prefixChanged` / reasons。没有这个，后面都是猜。

2. **动态内容改走 turn tail**  
   日期、hindsight recall、memory 更新、后台任务完成、execution policy。系统提示只在**新会话**折叠。

3. **MCP/工具 schema 规范化**  
   按 #530 的保守规则做，加一条「打乱 tools/list 后 fingerprint 不变」的测试。

4. **Cache-impact 当成改 prompt/tool 的 CI**  
   最小集：`packages/coding-agent/src/prompts/**`、`system-prompt.ts`、`packages/agent/src/append-only-context.ts`、工具 schema。发布级 mock 命中曲线可后做。

5. **Compact 继续「正本不动、投影更新、首次 miss 可接受」**  
   omp 已有多种 compact 策略；对齐的是「不要在 cache 变冷时主动改前缀」，以及「工具结果写入时截断，而不是回头改旧消息」。

预期效果（[INFERENCE]，取决于 DeepSeek 用量占比）：P0 做完后，DeepSeek 长会话的命中率应从「看人品」变成「跨夜/召回各付一次 miss，其余接近 Reasonix」。Anthropic 会好一些，但 5 分钟 TTL 决定了上限。本地模型主要降 TTFT，不是降账单。

## 8. 证据缺口

- 99.82% / $12 会话：未在 Reasonix 仓库或 DeepSeek 官方文档找到原始账单截图。当社区传闻，不当承诺。
- Twitter 原文未能直接读取。
- DeepSeek KV 文档是客户端渲染，本次只能用 meta / 二次来源确认「默认开启、按前缀匹配」。匹配粒度（token 还是字节）以官方为准；Reasonix 代码按**请求字节前缀**工程化。
- 未跑 Reasonix `cache-guard.sh`，未对比同一仓库上 omp vs Reasonix 的实测命中率。
- omp 生产会话的实际命中率分布：未查。
