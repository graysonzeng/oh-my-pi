# GPT-5.6 Sol xhigh/max 体感速度慢：网上论坛用户反馈收集

- 日期：2026-08-04
- 背景：omp 评审角色 `sol-xhigh-reviewer`（`gateway/gpt-5.6-sol` @ xhigh）与 `opus5-designer`（`gateway/claude-opus-5` @ xhigh）等模型对比，用户体感 gpt-5.6-sol xhigh 明显更慢。
- 方法：优先论坛原帖直引（Reddit / Hacker News / OpenAI Community / GitHub discussion / LinkedIn）；第三方受控测量用 Artificial Analysis；本机一手数据用 `~/.omp/agent/agent.db` 的 `model_perf`。所有外部页面访问日期均为 **2026-08-04**。
- 证据标签：**用户报告**＝原帖作者对其环境的自报，只证明"有人这样报告"，不构成统计；**第三方测量**＝Artificial Analysis 受控/聚合测量；**厂商声明**＝OpenAI 官方发布；**本机一手**＝本仓库/本机可复核数据；**推断**＝由证据推导。
- 限制：AI 产品 subreddit/HN 有自选择偏差（抱怨者更活跃）；单帖数量不是发生率；论坛报告的 effort/transport/harness 未统一控制。

## 结论先行

1. **"gpt-5.6-sol 高 effort 慢"是跨平台、跨时间的一致用户报告主题**（r/codex、HN、OpenAI Community、openai/codex discussion、LinkedIn），从 07-09 发布当周延续到 08-02 仍在出现，不是孤例。
2. **存在与 claude-opus-5 的直接对比报告**："I just re-subscribed to Anthropic to test Opus 5, and it is 10x faster when asking the same questions or small fixes"（r/codex，07-26）；"Anthropic's models are comparatively faster on similar intelligence scale"（LinkedIn）。方向与用户体感一致：同档 effort 下 Claude 系交互更跟手。
3. **"慢"由三个可分离成分叠加，论坛报告全部指向这三者**：
   - **高 effort 推理等待**：Artificial Analysis 测 Sol (max) TTFT **133s**（OpenAI API，同类 reasoning 模型中位 2.8s）；Sol (high) TTFT 12.49s vs Claude Opus 4.8 (max) 9.84s。xhigh/max 的首 token 等待是极端值。
   - **服务端容量/排队**：OpenAI status 7/17 记录 "Codex 5.6-sol Experiencing Increased Server-Overload Errors" 事故；7/28 用户复现 "Selected model is at capacity" + `server_overloaded`，多名 Pro 20X 用户报 2 次/小时频率；xhigh 用户明确报 "I can't use sol 5.6 xhigh - it gives the same errors"。
   - **harness 子代理开销**：Codex 在 high/xhigh 自动 spawn 子代理（HN 用户观察到 "spawning subagents in 'high' thinking mode"；GitHub discussion 用户报 "attempts to create multiple subagents… frequently fail to connect"）。
4. **与官方宣传存在张力，但两者可以同时成立**：OpenAI 声称 Sol max 完成 agentic 任务时间比 Fable 5 少 61%、AA Coding Agent Index 用时不到 Opus 4.8 一半——但官方自己标注 latency 是**离线模拟**（footnote 4），且口径是**任务总完成时间**（含并行子代理分摊墙钟），不是交互式单轮的 TTFT/reasoning 等待。用户体感"每轮等待久"与官方"任务更快完成"不矛盾。
5. **对本仓库的含义（推断）**：本机 `model_perf` 中 sol 平均 TTFT **25.1s**，是 deepseek-v4-flash（7.5s）的 3.3 倍、fable-5（6.1s）的 4.1 倍；08-03 全量会话分析（17205 轮 sol）每轮纯模型等待 ≥45s（gen 29s + TTFT 16s，200k+ 上下文时 TTFT 29-51s）。两个高 effort 评审角色同为 xhigh，体感差距主要落在 **TTFT 与推理时长**，不是 effort 档位差异。低价值轮次换低 TTFT 模型、xhigh 只留给必要高难轮次的方向（`docs/long-session-latency-analysis.md` §6）由此得到论坛证据支持。

## 1. 论坛用户反馈明细

| 来源 | 日期 | 原话（摘录） | 上下文 | 证据类型 | 可采信结论 | 限制 |
|---|---|---|---|---|---|---|
| Reddit r/codex [1urw0c3 megathread](https://www.reddit.com/r/codex/comments/1urw0c3/gpt56_sol_codex_release_discussion_megathread)，`Emergency_Motor_5105` | ~07-26 | "I just re-subscribed to Anthropic to test Opus 5, and it is **10x faster** when asking the same questions or small fixes." | Codex 订阅；Sol vs Opus 5 | 用户报告 | 直接、同任务的 Opus 5 更快体感 | 单一用户自报倍数，无受控测量；"小修复"场景 |
| 同上，`IndividualEngine8579` | ~07-26 | "Sol 5.6 is soooo slow recently, **30 minutes just to fix some preview text in an input box** and redeploy on iOS simulator." | Codex；Sol 默认档 | 用户报告 | 简单任务也要半小时级等待 | 含 iOS 重部署等非模型时间；effort 未注明 |
| 同上，`Big-Anxiety6037` | ~07-31 | "I get the impression that the 5.6 model is extremely slow, **even the smaller versions like Luna**… I'm leaning towards switching back to 5.4 because of the speed." | 5.6 全系 vs 5.4 | 用户报告 | 5.6 家族整体体感慢于 5.4 | 单一用户；非 Sol 专属 |
| Reddit r/codex [1uvigpf](https://www.reddit.com/r/codex/comments/1uvigpf/is_anyone_elses_codex_gpt56_sol_suddenly) "Is anyone else's Codex GPT-5.6 SOL suddenly extremely slow? (3 hours…)" | ~07-27 | 标题帖："I started having the super slowness basically at the same time as I started using 5.6" | Codex；Sol | 用户报告 | 多人同主题帖，慢非个例 | 帖子正文未完整核对（Reddit 反爬） |
| Reddit r/codex [1uybaz9](https://www.reddit.com/r/codex/comments/1uybaz9/why_are_gpt_56_sol_and_terra_taking_forever_to_do) "Why are gpt 5.6 sol and Terra taking forever…" | ~08-01 | "switched to 5.6 sol. Now my MacBook is working all day bc it's taking like 2-3h do…" | Codex；Sol/Terra | 用户报告 | 长任务动辄 2-3h | 未区分模型时间/重试/tool 循环 |
| HN [48849066](https://news.ycombinator.com/item?id=48849066)（GPT-5.6 发布帖），`shabgzer` | ~07-21 | "tried out Sol today with Pi, 'medium' mode… it's really **sssslllloooowww**… just noticed it's **spawning subagents in 'high' thinking mode**." | Pi harness；medium 但子代理 high | 用户报告 | 高 thinking 子代理放大等待 | 单个用户；Pi harness |
| 同上，`zarzavat` | ~07-21 | "This is also what I noticed, it's **hella slow and the quality doesn't match the thinking time**." | Codex 生态 | 用户报告 | 慢且性价比体感差 | 无数据 |
| 同上，`paxys` | ~07-21 | "I've been getting **'this model is at capacity'** a bunch with Sol, so definitely launch related." | 发布期容量 | 用户报告 | 容量排队是慢的一部分 | 发布初期，随时间衰减 |
| HN [48827402](https://news.ycombinator.com/item?id=48827402)（发布预告帖），`returnInfinity` | ~07-10 | "I think GPT 5.6 sol is pretty slow. I went back to 5.5." | ChatGPT；默认档 | 用户报告 | 发布 3 天即有慢反馈 | 无 effort/任务细节 |
| GitHub openai/codex [discussion 32065](https://github.com/openai/codex/discussions/32065) "Why does Codex become noticeably slower…"，`Heyu2002` | 07-10 | "GPT-5.6 Sol Ultra… response speed significantly slower than with GPT-5.5… attempts to create **multiple subagents**… frequently fail to connect and require reconnection." | Codex；Sol Ultra | 用户报告 | 慢+子代理失败叠加 | 单一用户；Ultra 非 xhigh |
| 同上，`ethan-2937` | 07-14 | "I tried sol. For me, it seems better than 5.5, but **it's too slow** ):"; 同帖 `Mahkhmood9`："Terra is blazing fast… honestly just ignore SOL." | Codex 订阅 | 用户报告 | 部分用户弃 Sol 转 Terra | 主观偏好 |
| OpenAI Community [1387571](https://community.openai.com/t/significant-slowdown-and-frequent-timeouts-interruptions-since-switching-to-5-6-sol/1387571) "Significant slowdown and frequent timeouts/interruptions since switching to 5.6 Sol" | ~07 下旬 | OP："Compared to my previous setup using 5.5 Medium + Superpowers skills, the processing speed **feels drastically slower**… sessions often run for a very long time only to end up getting interrupted or timing out mid-task." 回复："its unusable as per today, i pay 220€ per month for that crap. **they are overbooking their servers x10**." | Codex/API 混合 | 用户报告 | 慢+超时+中断组合 | 无受控数据；"overbooking"是推测 |
| OpenAI Community [1388332](https://community.openai.com/t/gpt-5-6-sol-repeatedly-hits-selected-model-is-at-capacity-in-codex-desktop/1388332) "GPT-5.6 Sol repeatedly hits 'Selected model is at capacity'"，`WillRen`（Pro 20X） | 07-28~31 | 引用 status 页 7/17 事故 "Codex 5.6-sol Experiencing Increased Server-Overload Errors"，7/28 复现；"For over **48 hours**, GPT-5.6 Sol has been almost continuously unavailable"；两个会话共 **70 次手动 continue** 自救。回复：**"I use opencode with my 20x sub, I can't use sol 5.6 xhigh - it gives the same errors."**；"I started to understand why people would choose **Claude Max 20x**."；"It happens about twice per hour on average." | Codex Desktop/opencode；Pro 20X | 用户报告 + OpenAI 员工确认容量机制 | 容量排队是 xhigh 用户慢的实锤成分；OpenAI 员工 Avinash 确认 capacity 错误 = 需求临时超容量 | 服务端事故，随时间变化；非模型本身延迟 |
| LinkedIn [Akshay Rawat](https://www.linkedin.com/posts/akshayraw_after-working-on-20x-max-subscription-for-activity-7485877665330016256-oe8Y) | 未注明（20x max 订阅，推测 07 下旬） | "Sol 5.6 is a very capable model, yet **very slow for coding**. Anthropic's models are comparatively faster on similar intelligence scale. Codex runs for hours… Claude would've blasted through the task." | 20x Max 订阅对比 | 用户报告 | Claude 系同档更快 | 自述 personal observation，非严格评测 |
| Towards Data Science [How to Work Effectively with GPT-5.6](https://towardsdatascience.com/how-to-work-effectively-with-gpt-5-6) | 未注明 | "if you go with the **extra high or ultra-reasoning levels, I believe the model is both too slow** and spends usage limits way too fast… I've actually ended up using **extra high thinking for planning and medium reasoning for actual implementations**." | 订阅用户实操 | 用户报告（教程作者） | xhigh/ultra 体感慢是实操共识，作者主动降档 | 单一作者经验 |
| aiidelist [Codex GPT-5.6 Sol reasoning guide](https://aiidelist.com/blog/codex-gpt-5-6-sol-reasoning-levels) | 未注明 | 档位表：Extra High = "Slow"、Max = "Very slow"、Ultra = "Variable"；"during interactive debugging, Medium… may produce a better workflow than repeatedly waiting for Max-level analysis." | 第三方整理 | 二手整理 | 高 effort 慢是产品预期设定，不是缺陷 | 非官方；档位表为整理者归纳 |

## 2. 受控测量对照（Artificial Analysis / 官方）

| 测量 | Sol | Claude 对照 | 结论 |
|---|---|---|---|
| TTFT @max（[AA Sol 模型页](https://artificialanalysis.ai/models/gpt-5-6-sol)，OpenAI API） | **133.04s** | 同类 reasoning 模型中位 2.80s | xhigh/max 首 token 等待是极端值，是体感慢主因 |
| TTFT @high vs Opus 4.8 @max（[AA 对比页](https://artificialanalysis.ai/models/comparisons/gpt-5-6-sol-high-vs-claude-opus-4-8)） | 12.49s | 9.84s | 同档对比 Sol TTFT 更高 |
| Output speed @max（AA） | 63.5 tok/s | — | 生成吞吐不慢，慢在等待不在出字 |
| Output speed @high（AA） | 56.8 tok/s | Opus 4.8 (max) 53.5 tok/s | 出字速度略快于 opus |
| 官方：agentic 任务完成时间（[GPT-5.6 发布页](https://openai.com/index/gpt-5-6/)） | Sol max 比 Fable 5 少 **61%** 时间；AA Coding Agent Index 用时 < Opus 4.8 一半 | — | 官方口径=任务总时间（离线模拟、fast API），与单轮 TTFT 体感不同度量 |

注意：buda.im 转述 AA 为 "Sol High 12.8s / Opus 4.8 max 28.9s"，与 AA 原对比页（9.84s）冲突——AA 快照时间不同，本文以 AA 原页为准。Opus 5 于 07-24 发布（[AA](https://x.com/ArtificialAnlys/status/2080734447717298483)：Opus 5 max = AA Intelligence Index 61，领先 Sol max 59），论坛里"Opus 5 更快"的报告大多在 07-24 之后，与其发布时间吻合。

## 3. 本机一手数据（omp）

`~/.omp/agent/agent.db` `model_perf`（快照更新至 ~07-31，146 样本）：

| model_key | 样本 | avg gen | avg TTFT | avg 输出 token |
|---|---:|---:|---:|---:|
| gateway/gpt-5.6-sol | 146 | 39.5s | **25.1s** | 451 |
| gateway/claude-fable-5 | 28 | 41.4s | 6.1s | 1097 |
| gateway/deepseek-v4-flash | 80 | 16.4s | 7.5s | 981 |

- sol TTFT 是 flash 的 3.3×、fable-5 的 4.1×；`docs/long-session-latency-analysis.md`（08-03，全量 689 会话）进一步给出 sol 17205 轮 gen avg 29s + TTFT avg 16s（200k+ 上下文 29-51s），模型等待占活跃耗时 87%。
- 本仓库 `sol-xhigh-reviewer` 与 `opus5-designer` 同为 xhigh effort（`.omp/agents/*.md`），本地对比中慢的差距落在 TTFT/推理时长而非 effort 档位。

## 4. 反方证据（诚实分层）

- **厂商声明**：OpenAI 宣称 Sol max 比 Fable 5 快 61%、token 效率更高（发布页）；AA Coding Agent Index Sol (max) in Codex = 80 分领先。口径为任务总时间 + 离线模拟。
- **部分用户认为 Codex 整体更快**：HN [48849126](https://news.ycombinator.com/item?id=48849126) `nvarsj` "Gpt is also way faster than Claude"；YouTube [7 Rules](https://www.youtube.com/watch?v=STczJBYJf7w) "Fable, Opus, and Sonnet all take longer… Codex models are way faster"。但此类报告多指 **Codex harness + Terra/Luna/5.5/fast mode 的吞吐**，不针对 sol xhigh 的单轮交互等待；亦有用户报 Opus 4.8 出字速度更快（buda.im 转述）。
- **综合**："sol xhigh 慢"报告集中在 **TTFT / 推理等待 / 容量排队**；"codex 快"报告集中在**任务完成吞吐与 token 效率**。两者不矛盾，测量口径必须分开。

## 5. 结论与对本仓库的建议

1. 用户体感慢**成立且可解释**：133s @max / 12.5s @high 的 TTFT（AA）+ 25.1s 本机 TTFT + 7/17、7/28 容量排队事故 + high/xhigh 子代理开销。
2. 不改变"sol 用于高难轮次"的定位（`default-config.ts` 角色矩阵），但 xhigh 只留给必要评审/规划轮次；低价值轮次走低 TTFT 模型——与 `docs/long-session-latency-analysis.md` §6 优化方向一致，本次论坛证据支持该方向。
3. 如需量化：固定任务集 A/B `sol-xhigh-reviewer` vs `opus5-designer`，记录 wall time / TTFT / 成功率，补上 07-25 per-model-optimization 反馈文要求的测量闭环。
4. attempt 级 usage artifact 应记录 **TTFT 与每轮等待**，不能只看任务总时间——"任务更快完成"与"每轮等待更久"可同时为真，缺前者会掩盖 sol 在交互评审场景的真实体感成本。
