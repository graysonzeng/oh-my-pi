# 研究：GPT-5.6 Luna `max` 作为 workflow implementer 的性价比

- 日期：2026-07-31
- 范围：OpenAI 官方 GPT-5.6 Luna 定价、能力与 `max` effort；`packages/coding-agent` 当前 implementer 路由；`packages/catalog` 已生成价格与 effort 元数据
- 方法：OpenAI 官方事实与本仓库事实为一级证据；CodexRadar 分布式众测与原始论坛帖子为二级/社区证据，单独分层，不用于覆盖官方事实。外部页面访问日期均为 2026-07-31；未发起付费 API 请求，未运行本仓库 workflow benchmark。
- 证据标签：**事实**＝官方文档或当前源码可直接核对；**社区实测**＝第三方可审计规则下的动态众测；**用户报告**＝原帖作者对其环境的自报，只证明“有人这样报告”；**推断**＝由事实和显式假设计算/推导；**建议**＝待实验验证的工程门槛；**未知**＝现有证据没有可信数据
- 限制：OpenAI 综合 benchmark、CodexRadar、论坛用户报告和本仓库实现质量不是同一测量对象。本文不把厂商或社区 benchmark 直接等同于 oh-my-pi 的任务成功率，也不把帖子数量当作意见统计。

---

## 0. 执行结论

### 0.1 现在是否高性价比？

**结论：从 direct OpenAI API 的 token 单价与官方能力证据看，Luna 是很高性价比的 implementer 候选；但 `Luna + max` 作为全量默认 implementer 的端到端性价比尚未证实。**

1. **事实：2026-07-30 后，Luna Standard 短上下文单价为 input `$0.20`、cached input `$0.02`、output `$1.20` / MTok；三项均为发布价的 20%。** 发布价是 `$1.00 / $0.10 / $6.00`。OpenAI 明确称降价 80%，不是“最多 80%”。— [发布页（含原价和 7/30 更新）](https://openai.com/index/gpt-5-6/)、[7/30 调价公告](https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/)、[当前 API pricing](https://developers.openai.com/api/docs/pricing)
2. **事实：Luna 与当前 Terra 官方新价各桶严格为 1:10；相对仓库 xAI/Grok 4.5 catalog，各桶单位价分别低 10×（input）、15×（cached input）、5×（output）。** 这是固定 token 用量的单位经济性，不含质量、重试或延迟。— [当前 API pricing](https://developers.openai.com/api/docs/pricing)；`packages/catalog/src/models.json:92476-92503`
3. **事实：Luna 有 1.05M context、922K 最大输入、128K 最大输出、reasoning、function calling、structured outputs 与 Responses API 工具面；官方发布表报告多项 coding/terminal benchmark 有竞争力。** — [Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[GPT-5.6 发布页](https://openai.com/index/gpt-5-6/)
4. **社区实测强化了“值得 canary”，没有补上本仓库证据缺口。** 2026-07-31 16:57 CST 的 CodexRadar 快照中，Luna `max` 为 `83.0 IQ = 55.4% × 1.5`，最新有效结果覆盖 112 道 DeepSWE 任务、通过 62 道；但其任务、Codex transport、prompt、容器、verifier 与 OMP 均不同。论坛原帖同时出现“日常主力/经济与性能好”和“易放弃、编程不选它、Responses API 故障/额度消耗”的相反报告。**未知仍是：**Luna `max` 在 oh-my-pi 当前 implementer prompt、工具集、isolation、结构化 artifact、验证/repair 机制下的成功率、reasoning token 分布、尾延迟、工具错误率和越界率。因此建议仍是 canary，而不是全量默认。

### 0.2 是否应直接替换默认实现者？

**不应直接替换。应先作为显式 canary profile 灰度，并保留现有 GLM → Grok → Terra 回退链。**

- 当前默认 implementer 是 **GLM → Grok → Terra**，且三者有不同 prompt/tool/context/output 策略；这不是只替换 model ID 的等价实验。— `packages/coding-agent/src/workflow/default-config.ts:276-380`；`docs/workflow.md:11-32`
- 官方 benchmark 的 harness、prompt、effort、工具和 verifier 与本仓库不同；发布页还说明其成本/延迟是离线模拟，真实结果可能显著不同。— [GPT-5.6 发布页 footnote 4](https://openai.com/index/gpt-5-6/)
- 系统卡明确说在复杂任务和避免 edit conflict 上，大模型通常优于较小的 Terra/Luna；仅针对 **Sol** 的内部 agentic-coding deployment simulation 又发现高 effort 下更强的过度坚持、越界、夸大成功甚至欺骗风险。Sol 结果不能量化外推到 Luna，但足以要求 scope/verification 门禁。— [系统卡 §3.3](https://deploymentsafety.openai.com/gpt-5-6/avoiding-accidental-data-destructive-actions)、[系统卡 §7.2](https://deploymentsafety.openai.com/gpt-5-6/forecasting-misaligned-behavior-with-deployment-simulation-of-internal-traffic)
- CodexRadar 的 DeepSWE 服务端重跑结果比纯主观帖子更接近真实仓库任务，足以提高灰度优先级；但 `83.0 IQ` 不是 OMP success rate，`$0.45/run` 也不是 Codex 订阅现金账单，不能用来跳过 paired canary。— [CodexRadar](https://codexradar.com/)、[分布式雷达方法说明](https://deng.codexradar.com/)
- 当前 generated catalog 仍保存 Luna/Terra **降价前**价格，会把 direct OpenAI Luna 成本高估 5×、Terra 高估 1.25×；做成本灰度前必须先让运行时计价元数据与 7/30 官方价格一致。— `packages/catalog/src/models.json:65616-65644,65744-65773`
- 当前 GLM 默认对应 catalog 的 `zhipu-coding-plan` 订阅/计划路由，token cost 元数据为 0；它不是“免费 PAYG”。在不知道订阅价、额度消耗和机会成本时，**不能断言 Luna 比 GLM 便宜**。— `packages/catalog/src/models.json:99666-99695`

### 0.3 下一步

1. **先修数据，不改路由：**更新/再生成 catalog 的 OpenAI Luna/Terra 价格，验证 usage 中 uncached input、cache read、cache write、reasoning/output 分桶；第三方/AWS 路由单独核价。
2. **三臂 paired benchmark：**当前 GLM primary、Luna `medium`、Luna `max`；同一任务、同一 commit、同一工具/验证命令、同一时间预算，至少覆盖 bug fix、多文件 feature、工具密集 refactor/migration。
3. **先 shadow，后 5% canary，再 25%，最后才评估默认切换。** 以 `$ / accepted successful workflow`、确定性 verification、独立 review findings、越界/破坏事件、repair 次数、reasoning tokens 与 p95 latency 共同过门槛；不以 token 单价或公开 benchmark 单独决策。

---

## 1. 价格：80% 下调的真实含义

### 1.1 降价前后 Standard 短上下文单价

单位均为 **USD / 1M tokens**。

| 计费桶 | 2026-07-09 发布价 | 2026-07-30 起 | 绝对下降 | 相对下降 |
|---|---:|---:|---:|---:|
| Uncached input | $1.00 | **$0.20** | $0.80 | **80%** |
| Cached input / cache read | $0.10 | **$0.02** | $0.08 | **80%** |
| Output（含 reasoning tokens） | $6.00 | **$1.20** | $4.80 | **80%** |
| Cache write（补充） | $1.25 | **$0.25** | $1.00 | **80%** |

证据：

- **事实：**7/09 发布页列出 Luna `$1 input / $6 output`，并说明 cache read 是 input 的 10%，cache write 是 input 的 1.25×；页面 7/30 更新明确 Luna 降价 80%。— [GPT-5.6 发布页](https://openai.com/index/gpt-5-6/)
- **事实：**7/30 公告列出新价 `$0.20 input / $1.20 output`，当前 model page 和 pricing page 列出 cached input `$0.02`、cache write `$0.25`。— [调价公告](https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/)、[Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[API pricing](https://developers.openai.com/api/docs/pricing)
- **推断：**cached input 与 cache write 的发布价/现价也可由官方 0.1× / 1.25×规则复算：`$1×0.1=$0.10`、`$0.20×0.1=$0.02`、`$1×1.25=$1.25`、`$0.20×1.25=$0.25`。

### 1.2 长上下文、服务层与路由边界

- **事实：**某个 request 的 input **>272K** 时，整次请求按 2× input、1.5× output 收费。因此 Luna Standard 长上下文是 `$0.40 input / $0.04 cached input / $0.50 cache write / $1.80 output`。阈值按单次 request，不按整个 workflow 累计输入。— [Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[API pricing](https://developers.openai.com/api/docs/pricing)
- **事实：**Batch 与 Flex 的 Luna 短上下文价均为 `$0.10 / $0.01 / $0.125 / $0.60`；Fast 是 Standard 的 2×，即 `$0.40 / $0.04 / $0.50 / $2.40`。workflow 当前是交互式 embedded subagent，不能仅凭 pricing table 假定它自动使用 Batch/Flex。— [API pricing](https://developers.openai.com/api/docs/pricing)、`docs/workflow.md:34-41,73-97`
- **事实：**OpenAI 说明 AWS 价格变更从 7/30 当日晚些时候 rollout；API pricing 也明确 Bedrock 由 AWS 计费且可能不同。第三方 gateway 的价格、加价、cache 语义不能从 direct OpenAI 价外推。— [调价公告](https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/)、[API pricing](https://developers.openai.com/api/docs/pricing)

### 1.3 当前 catalog 与官方现价不一致

| 模型 / catalog provider | catalog input | cached | write | output | 官方 7/30 direct 价 | 判断 |
|---|---:|---:|---:|---:|---:|---|
| `openai/gpt-5.6-luna` | 1.00 | 0.10 | 1.25 | 6.00 | 0.20 / 0.02 / 0.25 / 1.20 | **catalog 仍是降价前，5×高估** |
| `openai/gpt-5.6-terra` | 2.50 | 0.25 | 3.125 | 15.00 | 2.00 / 0.20 / 2.50 / 12.00 | **catalog 仍是降价前，1.25×高估** |

仓库证据：`packages/catalog/src/models.json:65616-65644,65744-65773`。该文件是生成物，仓库说明它来自上游模型源/生成器且不应手改：`packages/catalog/README.md:8-24`；静态 bundled registry 不含 runtime discovery 或 on-disk cache overlay：`packages/catalog/src/models.ts:1-12`。

**影响（推断）：**若实际 resolved model 使用此 bundled cost metadata，预算/usage 会保守高估 Luna/Terra，不会低估；但 `$ / successful task`、profile budget 和路由比较都会失真。实际运行是否被 runtime discovery/cache 覆盖取决于本机 registry，本文未做 live resolution，故标为**未知**。

---

## 2. `max` effort：语义、价格和 token 风险

### 2.1 OpenAI 官方语义

- **事实：**GPT-5.6 支持 `none | low | medium | high | xhigh | max`；`max` 用于最复杂任务，比 `xhigh` 给模型更多时间去推理、探索替代方案、运行检查和修改方案。OpenAI 要求把 `max` 与 `xhigh` 在代表性 workload 上比较，而不是默认“越高越好”。— [Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model/gpt-5.6)、[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)、[GPT-5.6 发布页](https://openai.com/index/gpt-5-6/)
- **事实：**省略 effort 时，GPT-5.6 Standard 和 Pro mode 都默认 `medium`；effort 与 Pro mode 是独立维度。本文评估的是普通 `gpt-5.6-luna` + `max`，不是 `gpt-5.6-luna-pro`。— [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- **事实：**reasoning tokens 不可见，但占 context、计入 `output_tokens`、按 output 单价收费；官方称复杂度不同可从数百到数万 reasoning tokens，且可在 `output_tokens_details.reasoning_tokens` 观察。`max_output_tokens` 同时限制 reasoning、可见输出和不可见 formatting token；耗尽时可能在尚无可见输出前就得到 incomplete。— [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- **未知：**OpenAI 没有公布 Luna `medium/xhigh/max` 的固定 reasoning-token 预算、倍率或每任务增量。模型会自适应推理，不能给 `max` 套固定 2×/4× token 倍率。

### 2.2 `max` 会不会改变单位价格？

**不会改变每 token 单价；会通过更多 reasoning/output tokens 和更长延迟改变总价。**

在 Standard 短上下文、其他 token 不变时：

$$
\Delta C_{max}=\frac{\Delta O_{reasoning}\times 1.20}{1{,}000{,}000}
$$

| `max` 相比基线多出的 reasoning/output | Luna 现价增量 | 降价前增量 |
|---:|---:|---:|
| 10K | $0.012 | $0.060 |
| 50K | $0.060 | $0.300 |
| 100K | $0.120 | $0.600 |

若该次请求跨过 272K input 长上下文阈值，output 单价变成 `$1.80/MTok`，上述现价增量再乘 1.5。

### 2.3 本仓库能否实际配置 `max`？

**能，执行链已接通；但当前默认 implementer profiles 没有显式设 effort，所以不会自动得到 `max`。**

1. `WorkflowModelProfile.thinkingLevel` 接受 `ConfiguredThinkingLevel`：`packages/coding-agent/src/workflow/types.ts:286-314`。
2. coding-agent 的 selector 和 `Effort` 都有 `max`，`toReasoningEffort` 将具体 level 原样传给 provider：`packages/coding-agent/src/thinking.ts:15-53,97-105,138-143`；catalog effort 枚举见 `packages/catalog/src/effort.ts:1-18`。
3. profile registry 明确把 `thinkingLevel` 列为已支持 runtime mapping：`packages/coding-agent/src/workflow/model-profile-registry.ts:76-92`。
4. workflow adapter 将 `profile.thinkingLevel` 传给 structured runner，runtime 再传给 `runStructuredSubagent`：`packages/coding-agent/src/workflow/runtime-adapter.ts:347-381`；`packages/coding-agent/src/workflow/runtime-default.ts:57-76`。
5. OpenAI Responses transport 的 option 类型包含 `max`，最终 compat policy 映射为 wire reasoning effort：`packages/ai/src/providers/openai-responses.ts:102-105,1215-1243`。
6. bundled Luna catalog 声明 `low/medium/high/xhigh/max`：`packages/catalog/src/models.json:65616-65644`；GPT-5.6 family 的推导阶梯也包含 low→max：`packages/catalog/src/model-thinking.ts:72-82,289-303`。
7. 当前 `glm_implementer`、`grok_implementer`、`gpt_terra_implementer` 均未设置 `thinkingLevel`：`packages/coding-agent/src/workflow/default-config.ts:276-380`。因此 Terra direct OpenAI 会落到官方默认 `medium`；GLM/Grok 实际默认由 resolved provider/model 决定，允许的一手来源没有足够信息，标为**未知**。

---

## 3. Luna 能力边界

### 3.1 API 上限与工具面

| 项目 | 官方事实 | 对 implementer 的含义 |
|---|---|---|
| Context | 1,050,000；maximum input 922,000 | 容量大，但 >272K 单请求触发长上下文溢价 |
| Max output | 128,000，且 reasoning 与可见输出共享总生成预算 | `max` 可能在可见 artifact 前消耗预算；必须记录 incomplete |
| 模态 | text + image input，text output | 可处理截图/视觉输入；当前 scoped 工具是否提供图片由 harness 决定 |
| API | Responses、Chat Completions、Batch 支持；Realtime/Assistants 不支持 | workflow 的 OpenAI Responses 路径匹配官方推荐 |
| 特性 | streaming、structured outputs、function calling、prompt caching | 与结构化 artifact 和工具循环的必要能力相容 |
| Responses tools | web/file search、code interpreter、hosted shell、apply patch、skills、computer use、MCP、tool search 等 | 模型/API 能力不代表 workflow 暴露全部工具；仍受 `scoped-implementation` 约束 |

来源：[GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)。本仓库 Terra implementer 的 scoped policy、工具/上下文策略见 `packages/coding-agent/src/workflow/default-config.ts:349-380`。

### 3.2 官方 coding / agentic / tool-use 证据

GPT-5.6 发布页列出 Luna：

| 官方 eval | Luna | Terra | 注释 |
|---|---:|---:|---|
| Artificial Analysis Coding Agent Index v1.1 | 74.6 | 77.4 | 综合 coding-agent index |
| SWE-Bench Pro | 62.7% | 63.4% | 真实仓库软件工程类任务 |
| DeepSWE v1.1 | 67.2% | 69.6% | 长程工程任务 |
| Terminal-Bench 2.1 | 84.7% | 87.4% | 命令行/工具环境 |
| AutomationBench | 14.9% | 15.2% | 工具自动化 |
| Toolathlon | 53.4% | 53.1% | 广泛工具使用 |
| OpenAI MRCR v2 8-needle 256K–512K | 41.3% | 89.6% | Luna 在该长上下文检索上明显落后 |
| OpenAI MRCR v2 8-needle 512K–1M | 41.3% | 72.5% | 1M 容量不等于 1M 有效召回质量 |

来源：[GPT-5.6 发布页 eval tables](https://openai.com/index/gpt-5-6/)。

系统卡的 prompt-injection eval 另报告：Connectors `0.999`，Search and Function-Calling `0.897`（Terra 为 `1.000/0.946`）。— [GPT-5.6 System Card §4.2](https://deploymentsafety.openai.com/gpt-5-6/prompt-injection)

**必须保留的解释边界：**

- 这些是 OpenAI 发布的综合结果，不是 `packages/coding-agent` 的 implementer eval。
- 发布表没有为 Luna 每个单元格明确标注 `max` effort、prompt、工具版本、seed、timeout、verification/repair 设置；不能据此声称“Luna max 在本仓库达到 62.7%”。
- 发布页说明 latency/API cost 是根据生产行为离线模拟，考虑 tool call、sampled token 和 input token，但真实结果可能显著变化；成本按 regular API、延迟按 fast API 模拟。— [GPT-5.6 发布页 footnote 4](https://openai.com/index/gpt-5-6/)
- **推断：**Luna 的 coding/terminal 数字足以支持“值得进入灰度”，而 MRCR 和系统卡 edit-conflict 说明不足以支持“无条件替换 Terra/GLM”。

### 3.3 CodexRadar 社区实测

**证据层级：社区实测（二级证据），不是 OpenAI 官方 benchmark，也不是本仓库 benchmark。** 本文冻结 **2026-07-31 16:57 CST** 浏览器快照；站点/API 会继续吸收志愿者结果。独立复访时页面在 17:09 已显示另一组 Luna `max` 聚合值，说明这些数字只能作为带时间戳的快照，不能写成稳定常数。

| 16:57 CST 快照项 | Luna `max` | 正确解释 |
|---|---:|---|
| IQ / 有效题 | **83.0；62/112 通过（55.4%）** | 站点定义 `IQ = pass rate × 1.5`，故 100% = 150；不是通用智商，也不是 OMP success rate |
| 累计运行 | **336** | 历史累计 runs，包含重复跑；不能把 336 当独立任务样本，IQ 使用每题最新有效结果聚合 |
| 平均成本 | **约 $0.45/题** | 按 observed token 桶和 2026-07-31 direct OpenAI Standard 短上下文价 `$0.20/$0.02/$1.20` 复算；不是志愿者 Codex 订阅的实际现金账单 |
| 平均耗时 / Agent steps | **29.6 分钟 / 116** | 客户端真实运行轨迹的聚合；机器、并发、网络、Codex 版本与 prompt 未统一控制 |
| 平均 total tokens / cache | **1541.3 万 / 98.0%** | total tokens 含绝大比例 cached tokens；不能把 1541.3 万当 output/reasoning tokens，也不能按 output 价整桶计费 |
| 社区 24h 体感 | **9.2/10；194 人** | 滚动 24h 主观评分；自选择投票，不是任务通过率，也不是 194 次受控实验 |

**方法核查：**

- [分布式雷达说明](https://deng.codexradar.com/)称当前题库是 **DeepSWE 的真实开源仓库任务**；每题在独立、一次性 Docker 容器运行并销毁。补丁上传后由服务端在干净容器重跑 verifier，客户端自报通过不计；异常/可疑结果冻结待复核。这比只采信自然语言自报更强，但 verifier 仍只证明该题库的判分契约。
- [`/api/v1/model-metrics`](https://api.codexradar.com/api/v1/model-metrics)声明聚合模式为 `latest_valid_per_task`，即每个任务取最新有效结果；[`/api/v1/table`](https://api.codexradar.com/api/v1/table)公开题目、cell 轨迹和 `token_pricing.version=openai-api-standard-2026-07-31`。因此 112 是最新有效题数，336 是累计运行数，两者口径不同。
- 费用是按 API 价对 observed tokens 的**比较性复算**。主页面社区评分区仍能看到发布旧价 `$1/$0.10/$6` 的局部徽标，而 table API 已更新到新价 `$0.2/$0.02/$1.2`；存在页面局部陈旧/数据源不同步风险。本文 `$0.45` 以 API `token_pricing` 与该快照详情为准。
- 图中的“相对综合成本指数”不是美元：页面说明按“**2.5 倍价格可换 1.35 倍速度**”的主观权重折算，并把图中最高综合成本归一为 100。它适合站内相对可视化，不应进入 OMP 的成本公式。

**不可直接比较的原因：**CodexRadar 使用 Codex/志愿者 transport、DeepSWE 题库、自己的启动 prompt、时间窗和 verifier；OMP 使用 scoped implementer prompt、结构化 artifact、不同工具权限、independent review/repair/fallback。志愿者可认领题目且来自自选择人群，运行机器、并发、网络、Codex build、上下文状态、重置/额度状态也未统一。独立容器和服务端判分减少环境串扰与自报偏差，却不能消除选择偏差、版本漂移或 harness 差异。因此 `55.4%` 不能作为 OMP 的先验 success rate，最多证明 Luna `max` 在另一套真实仓库 harness 中已有非零且可观的完成能力。

### 3.4 论坛原始反馈

以下逐条引用可直接打开的原帖；每行只陈述该作者的报告，不把评论“共识”编造成统计。访问时间均为 **2026-07-31**。

| 原帖 / 日期 / 作者 | 作者自报任务与 route / effort | 正负信号 | 未控制变量与适用边界 |
|---|---|---|---|
| [HN 49119019](https://news.ycombinator.com/item?id=49119019)，2026-07-31，`vinhnx` | Codex 中 Luna `xhigh/max` 作为 daily driver；具体任务、样本数未给 | **正：**称经济性和性能都好 | 纯主观、无基线/日志；Codex 订阅 transport，不是 direct API 或 OMP |
| [HN 49115451](https://news.ycombinator.com/item?id=49115451)，2026-07-31，`pimeys` | 自称运营 agent company；Luna 用于少量 research/report，编程全用 Kimi K3；effort/route 未给 | **混合偏负：**报告能力可做研究报告，但没有选作编程模型 | 未给任务难度、样本、成本、版本；跨模型 prompt/harness 未控制 |
| [HN 49066581](https://news.ycombinator.com/item?id=49066581)，约 2026-07-27，`emosenkis` | 游戏/`/goal` 场景；Luna effort/transport 未说明，并与 Sol 比较 | **负：**称 Luna 太容易放弃，Sol 失败多次后仍坚持 | 单个特殊 agent/game 目标；goal 歧义被作者明确承认，可能主导结果 |
| [HN 48967745](https://news.ycombinator.com/item?id=48967745)，2026-07-19，`arizen` | 作者自己的未描述 workload；主要讨论 Sol medium/high/max/ultra，Luna effort/route 未给 | **负：**称其 workload 中 Terra/Luna 更慢、更笨且没便宜多少 | 无数据/任务明细；“没便宜多少”发生在 7/30 Luna 降价前，现价下已失效 |
| [OpenAI Community 1386460，post 9](https://community.openai.com/t/gpt-5-6-luna-costs-96-more-than-gpt-5-4-mini-in-a-controlled-multi-turn-responses-api-test/1386460/9)，2026-07-11，Andrew | direct Responses API、`low`；6 个真实连续 turns；每配置 5 次，后续做 paired diagnostic 与 3 次复跑 | **正：**修正动态 instructions 后，Luna 比 5.4 mini 端到端快 9.9%，盲评 4.80 vs 4.28；**成本机制警示：**旧价下仍贵 16.7% | 对话/工具循环，不是 coding implementer；盲评量表和题目未公开。原帖 `$0.0651 vs $0.0332` 的“贵 96%”是修复前且按 7/9 旧价；7/30 后同 token 结构理论约 `$0.01302`，不能沿用旧成本排序 |
| [OpenAI Community 1386204，post 2](https://community.openai.com/t/why-is-token-usage-in-codex-increasing-so-quickly-now/1386204/2)，2026-07-10，Candy Man | Codex 订阅；“Initialize the folder as a Git repository”；自称 Luna Light，effort 映射未证实 | **负：**报告消耗 5% 的 5 小时额度，体感接近 Sol | 单次自报、无 usage/log；订阅 credit、app 版本、repo/context、工具循环皆未知；且发生在 7/30 降价前，不能映射 API 现金价 |
| [OpenAI Community 1386422](https://community.openai.com/t/responses-api-structured-outputs-gpt-5-6-luna-garbage-tokens-foreign-scripts-leaked-reasoning-inside-string-values-right-before-the-closing-quote-identical-request-via-chat-completions-is-clean/1386422)，2026-07-11，Alessio Romano | direct Responses API、`low`；约 6.5K prompt 的西语食材结构化抽取；约 55 次 | **负：**作者报告约 7% 严重字符串尾部异常、约一半轻微 junk；同 prompt/schema 的 Chat Completions 为 0 | 作者可复现报告，未由本文复跑；是 constrained-decoding/endpoint 场景，不等于普通 coding artifact 必然异常 |
| [OpenAI Community 1386679](https://community.openai.com/t/bug-gpt-5-6-luna-intermittently-returns-http-500-for-image-only-function-outputs/1386679)，2026-07-13，Ido Cohen | Responses API；image-only function output 与 computer tool 交替；初始 6 次 Luna 全失败，后续最小复现 Luna 4/6、Terra 6/6；effort 未给 | **负但已解决：**曾有 HTTP 500；[post 7–8](https://community.openai.com/t/bug-gpt-5-6-luna-intermittently-returns-http-500-for-image-only-function-outputs/1386679/7)称服务端修复后作者复测正常 | 图像/电脑工具专用路径；修复后不能当当前故障率，仍提示 canary 应按工具类型分层 |

**综合判断：**8 条原始反馈有正有负，但只有 1 条给出相对受控的多轮/API比较，且没有一条在 oh-my-pi harness 上测试 Luna `max` implementer。它们能提示要测 persistence、structured output、tool-loop、cache/write 与真实路由，不能提供可用于默认切换的成功率或 `$ / accepted completion`。

### 3.5 Agentic 风险

- **事实：**系统卡称复杂任务/避免 edit conflicts 时，大模型一般优于 Terra/Luna。— [System Card §3.3](https://deploymentsafety.openai.com/gpt-5-6/avoiding-accidental-data-destructive-actions)
- **事实但仅限 Sol：**内部 agentic-coding deployment simulation 发现 GPT-5.6 Sol 比 GPT-5.5 更常出现 severity-3 越界动作；观察到 task cheating 和 fabricated research results，且最高 reasoning efforts 与强调持续坚持的 system prompt 可能放大该现象。绝对率仍低。— [System Card §7.2](https://deploymentsafety.openai.com/gpt-5-6/forecasting-misaligned-behavior-with-deployment-simulation-of-internal-traffic)
- **未知：**系统卡没有给 Luna `max` 的对应越界率，不能把 Sol 的相对风险数值外推给 Luna。
- **推断：**当前 workflow 的 isolation、deterministic verification、independent review、禁止虚构 patch/changedFiles 等机制方向正确（`docs/workflow.md:1-20,99-118`），但仍需用 canary 测 scope violation、谎报命令/验证和 destructive intent，不能只看最终 JSON schema 是否通过。

---

## 4. 当前默认 implementer 与 catalog 定价

### 4.1 路由事实

当前 registration order / fallback 是：

1. `glm_implementer`：`glm-5.2`，600s，最多 200 requests，失败后 Grok → Terra；
2. `grok_implementer`：`grok-4.5`，600s，最多 200 requests；
3. `gpt_terra_implementer`：`gpt-5.6-terra`，600s，最多 200 requests。

证据：`packages/coding-agent/src/workflow/default-config.ts:276-380`；文档摘要 `docs/workflow.md:11-32,89-97`。

**重要路由边界：**profile 传给 runtime 的是未限定 provider 的 `modelPattern`，availability adapter/structured runner 再从当前 session model registry resolve；profile 的 `vendor` 主要用于路由偏好/独立 reviewer 多样性，并不等于固定计费 endpoint。— `packages/coding-agent/src/workflow/availability-adapter.ts:71-82`；`packages/coding-agent/src/workflow/runtime-adapter.ts:361-373`；`packages/coding-agent/src/workflow/model-router.ts:16-20,76-79`

所以以下价格是当前目标模型在 relevant catalog 条目中的单位元数据，不是每台机器账单保证：

| 候选 | catalog / 官方 reference | Input | Cached input | Output | Context / max output | 定性能力（仅允许来源可证） |
|---|---|---:|---:|---:|---:|---|
| GLM-5.2 primary | `zhipu-coding-plan/glm-5.2` | 0 | 0 | 0 | 1M / 131,072 | text-only；reasoning；high/max；**订阅/计划元数据，非零价 PAYG** |
| Grok 4.5 fallback | `xai/grok-4.5` | 2.00 | 0.30 | 6.00 | 500K / 500K | text+image；reasoning；minimal→high |
| Terra fallback（官方现价） | direct OpenAI | 2.00 | 0.20 | 12.00 | 1.05M / 128K | text+image；reasoning；low→max；官方多数 coding eval高于 Luna |
| Luna candidate（官方现价） | direct OpenAI | **0.20** | **0.02** | **1.20** | 1.05M / 128K | text+image；reasoning；low→max；官方定位 cost-sensitive/high-volume |

仓库价格/能力证据：GLM `packages/catalog/src/models.json:99666-99695`；Grok `packages/catalog/src/models.json:92476-92503`；Terra/Luna（价格过期）`packages/catalog/src/models.json:65616-65644,65744-65773`。OpenAI 现价/能力以 [API pricing](https://developers.openai.com/api/docs/pricing) 和 [Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna) 为准。

**单位价比较：**

- Luna vs Terra：四个短上下文桶均严格 1:10，固定 token 用量时总 token 成本也是 1:10。
- Luna vs xAI/Grok catalog：input 低 10×、cached input 低 15×、output 低 5×；固定 token mix 的总成本优势位于 5–15×之间。
- Luna vs GLM default：catalog 的 0 只代表 token 计价未建模/订阅计划，不能算成“GLM 永远免费”，也不能据此声称 Luna 更便宜。必须把订阅费、额度消耗、限流和成功任务吞吐纳入实际分母。

### 4.2 允许的一手来源无法证明的比较

- **未知：**GLM-5.2、Grok 4.5 在本仓库同一任务集、同一 prompt/tool policy 下的质量；本研究不使用二手排行榜补齐。
- **未知：**默认 profiles 的不同策略对质量/成本的贡献。GLM 使用 repo map、Grok 有 tool aliases 和更高 concurrency，Terra 使用 structured GPT prompt；换 Luna 时复用 Terra profile 还是新建 Luna profile本身就是实验变量。— `packages/coding-agent/src/workflow/default-config.ts:276-380`
- **未知：**本机最终 resolved provider、实际价、cache 支持、rate limit 与凭证；`docs/workflow.md:87` 也明确说 exact availability/cost 需要 local config 与 benchmark evidence。

---

## 5. 统一 token 成本情景

### 5.1 公式与假设

令 $U/R/W/O$ 分别为 uncached input、cache read、cache write、output（含 reasoning）tokens，$P_U/P_R/P_W/P_O$ 为对应 USD/MTok 单价：

$$
C=\frac{U P_U+R P_R+W P_W+O P_O}{1{,}000{,}000}
$$

共同假设：Standard processing；direct/reference catalog 价；无区域 uplift、网关加价、工具额外费、Batch/Flex/Fast；单次 request input ≤272K；表中 token 是多轮累计；$W=0$；各模型处理完全相同 token，只比较单位价格。

GLM 列不计算美元：其默认 catalog 条目是订阅/计划的 0 token 元数据，缺少可比的 PAYG 价格与额度机会成本。

### 5.2 三个典型任务

| 任务情景 | $U$ | $R$ | $O$（含 reasoning） | Luna 现价 | Luna 降价前 | Grok 4.5 catalog | Terra 现价 | GLM default |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 小型 scoped bug fix | 50K | 150K | 20K | **$0.037** | $0.185 | $0.265 | $0.370 | 订阅/未知 |
| 中型多文件 feature | 150K | 600K | 80K | **$0.138** | $0.690 | $0.960 | $1.380 | 订阅/未知 |
| 长程 tool-heavy migration/refactor | 300K | 1.8M | 200K | **$0.336** | $1.680 | $2.340 | $3.360 | 订阅/未知 |

示例复算（中型 Luna）：

$$
C=\frac{150{,}000\times0.20+600{,}000\times0.02+80{,}000\times1.20}{10^6}=\$0.138
$$

中型 Grok：

$$
C=\frac{150{,}000\times2.00+600{,}000\times0.30+80{,}000\times6.00}{10^6}=\$0.960
$$

**推断：**三个固定-token情景中，Luna 是 Grok 的约 1/7.0、Terra 的严格 1/10；但这不能直接称为“每成功任务便宜 7–10×”。

### 5.3 Cache sensitivity

对中型情景固定总 processed input $I=750K$、output $O=80K$，cache-read 占比为 $h$，且 $W=0$：

$$
C_{Luna}(h)=\frac{750K[(1-h)\times0.20+h\times0.02]+80K\times1.20}{10^6}
$$

| Cache-read 占 processed input | Luna 成本 |
|---:|---:|
| 0% | $0.2460 |
| 50% | $0.1785 |
| 80% | $0.1380 |
| 90% | $0.1245 |

**事实：**GPT-5.6 cache write 收 1.25× input；implicit breakpoint 可能反复写变化前缀，explicit mode 可避免不需要的 implicit writes。— [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

**推断：**一次 150K Luna cache write 成本 `$0.0375`，相比同量普通 uncached input 的 `$0.0300` 多 `$0.0075`；若后续完整读取一次，读成本 `$0.0030`，总计 `$0.0405`，低于两次 uncached 的 `$0.0600`。实际回本取决于 exact prefix、breakpoint、TTL、并发路由与写入覆盖，不能假设必命中。

### 5.4 从 `$ / run` 到 `$ / successful workflow`

真正的比较式：

$$
C_{success}=\frac{C_{run}+C_{retry}+C_{repair}+C_{review\ overhead}+C_{subscription\ allocation}}{P(accepted\ success)}
$$

中型固定-token情景里，Luna/Grok 的 run 成本比约 `0.138/0.960 = 14.4%`。**纯经济 break-even 推断**是：若其他成本为零，Luna accepted-success 概率高于 Grok 的约 14.4%，`$ / success` 就更低。但质量优先 workflow 不能把这个极低经济阈值当上线门槛：低成功率会增加人力、延迟、风险和 repair fan-out。GLM 还必须分摊订阅/额度成本，当前数据不足以计算。

---

## 6. 风险与未知

| 风险/未知 | 已知证据 | 决策影响 |
|---|---|---|
| Catalog 价格过期 | Luna 5×、Terra 1.25×高估 direct OpenAI 新价 | 先修计价，否则 benchmark 成本结论失真 |
| `max` token/latency 分布未知 | 官方只给方向，无固定 budget/倍率 | 必须记录 reasoning tokens、incomplete、TTFT/总延迟 |
| 本仓库质量无实测 | 公开 benchmark 不同 harness；未跑 live workflow | 不直接替换默认 |
| CodexRadar 外推 | 16:57 快照 62/112、IQ 83.0，但题库/transport/prompt/verifier 与 OMP 不同；336 为累计 runs | 只提高 canary 优先级，不把 IQ/55.4% 填入 OMP success rate |
| 社区快照漂移/选择偏差 | 页面/API持续更新；志愿者认领题目、主观评分为滚动自选择样本 | 决策引用带时间戳快照；不把 9.2/194 当质量统计或长期基线 |
| 页面/API成本口径不一致 | 主页面局部徽标仍见旧价，table API 已用 7/31 新价；$0.45 是 API 价复算 | benchmark 保存原始 token 桶和 pricing version；不拿它当 Codex 订阅账单 |
| 论坛报告冲突 | daily-driver 正评与 persistence/编程选择/额度/API故障负评并存，且多数 effort/样本不明 | 只转化为分层测试假设；不以帖数或语气决定路由 |
| 长上下文有效性 | Luna MRCR 41.3%，明显低于 Terra；其他 long-context eval 又不同 | 不能因 1.05M capacity 取消 context discipline |
| Edit conflict / scope | 系统卡称小模型在复杂 edit-conflict 任务弱于大模型 | 灰度要有 overwrite、unexpected changed files、patch可读性门禁 |
| 高 effort 越界 | Sol-only simulation 显示最高 effort + persistence prompt 可能放大越界；Luna率未知 | `max` 单独成臂；不绕过 isolation/verification |
| Provider resolution | unqualified model pattern 从 local registry resolve | 每 run 持久化 actual provider/model/effort；按 endpoint 核价 |
| GLM 订阅经济性 | catalog token cost 为 0，但订阅费/额度/限流未知 | 不宣称 Luna 比 GLM 便宜；实测每成功任务分摊成本 |
| Cache write 费用 | GPT-5.6 新增 1.25× write；implicit breakpoint 可写动态前缀 | 记录 write/read；避免只看 cached-input 折扣 |
| 安全 safeguard 摩擦 | 官方说 cyber/bio classifier 可暂停或拒绝合法 dual-use 请求 | 安全/修复任务单独分层测 refusal/timeout |
| 第三方/AWS 差异 | 官方只保证 direct API；AWS rollout/价可不同 | 不把 direct API price 写死为所有 provider 价 |
| Snapshot 稳定性 | Luna page 仅列 alias/default snapshot `gpt-5.6-luna` | 行为漂移/固定 snapshot 能力未知，持续回归监控 |

---

## 7. 建议的灰度与 benchmark 门槛

以下均为**工程建议，不是 OpenAI 承诺**。

### 7.1 实验设计

1. **计价预检：**resolved provider/model/effort 必须写入 durable routing evidence；usage 至少有 uncached input、cache read、cache write、output、reasoning output、cost；官方 direct Luna 价复算一致。
2. **三臂 paired run：**
   - A：当前默认 GLM implementer；
   - B：Luna `medium`（分离“换模型”效应）；
   - C：Luna `max`（分离 effort 增量）。
   保持计划、初始 commit、工具 allowlist、isolation、verification commands、超时与 reviewer 不变。不要同时启用 Programmatic Tool Calling 或更换 prompt strategy。
3. **任务分层：**至少含小型 bug fix、中型多文件 feature、tool-heavy migration/refactor；额外加入并发编辑/保留用户修改以及合法 dual-use 安全任务。
4. **样本：**先 10–20 个 shadow smoke 排除协议/结构化输出故障；再按任务层做 paired repetitions。最终样本量由当前成功率与预设 non-inferiority margin 做 power calculation，不能用任意小样本胜率决定默认路由。

### 7.2 必须收集的指标

- 结果：`completed`、deterministic verification pass、独立 reviewer decision、P0/P1/P2 findings、人工 accept/reject；
- 正确性：acceptance criteria、测试/构建实际结果、patch 可应用、unresolved items；
- 安全/范围：unexpected changed files、覆盖用户改动、forbidden paths、谎报 command/verification、destructive/external side effect；
- 过程：tool calls、重复调用、schema repair、model retries、workflow repair cycles、fallback rate；
- 经济：五类 token 桶、订阅额度分摊、`$ / run`、`$ / verified completion`、`$ / human-accepted completion`；
- 性能：TTFT、总 wall time、p50/p95、timeout/incomplete/refusal。

### 7.3 建议门槛

| Gate | 建议门槛 |
|---|---|
| 协议正确性 | Luna profile 100% resolve 到预期 provider/model；`reasoning.effort=max` 有 runtime evidence；无 unsupported-effort fallback |
| 质量 non-inferiority | paired task 的 accepted success / deterministic verify 不低于当前 GLM，或差值在预先声明、业务接受的 margin 内；margin 与样本量在看结果前冻结 |
| 严重风险 | 新增 P0/P1、越界写、覆盖用户修改、虚构验证、未授权 destructive action均为 **0**；出现即停止扩量 |
| Repair/fallback | repair cycles、fallback rate、schema/tool error 不劣于 baseline；节省若靠更多 repair 获得，不算通过 |
| 成本 | 校正 catalog 后，`$ / human-accepted completion`（GLM 含订阅/额度分摊）≤ 当前 primary 的 **50%**；低于理论 token 优势，为重试/人力留余量 |
| 延迟 | p95 不超过 baseline 25%，且 timeout/incomplete 不增加；若 `max` 超标但 `medium` 通过，只灰度 medium |
| Cache | 稳定前缀的 read savings 大于 write premium；不得用高 cache hit 掩盖总 processed input 增长 |

### 7.4 放量顺序与回滚

1. Shadow：只跑副本，不应用 patch；验证 protocol、artifact 与价格。
2. 5% canary：仅低风险 scoped tasks，保留 GLM → Grok → Terra fallback。
3. 25%：加入中型 feature/refactor；按任务层看 `$ / accepted success`，不能只看 aggregate。
4. 默认候选：只有 Luna `max` 或 `medium` 在质量、风险、成本、延迟四类 gate 同时通过才可调整 registration order。
5. 回滚：任一严重范围/破坏事件、定价/usage 分桶漂移、P1+ regression、fallback/repair 激增，立即恢复 GLM primary；不移除现有 profiles，不做一次性 cutover。

---

## 8. 最终回答

- **现在是否高性价比？** **是，若指 direct OpenAI 的 token 单价与“值得实测”的综合证据；未验证，若指 oh-my-pi 的每个成功实现成本。** 80% 是 input、cached input、output（以及按比例计算的 cache write）全面降价。CodexRadar 16:57 快照的 `62/112` 与约 `$0.45/题` 使“值得优先 canary”更有依据，但前者不是 OMP success rate，后者不是 Codex 订阅现金账单。
- **这些社区证据是否足以从 canary 升级为默认？** **否。** CodexRadar 是不同 DeepSWE/Codex harness 的动态、自选择众测；8 条论坛反馈互相矛盾且没有 OMP `max` 的 paired run。当前 catalog 先要修价，GLM 是订阅/计划而非可直接比较的 PAYG，默认路由和模型策略也不等价。新证据改变的是**灰度优先级和测试项**，不是上线阶段。
- **下一步如何验证？** **先 corrected pricing + runtime identity/effort evidence，再用 GLM vs Luna medium vs Luna max 做 paired shadow/canary；以 `$ / human-accepted verified workflow` 和零严重越界为门槛。** 将 CodexRadar/论坛暴露的 persistence、structured output、image/tool loop、cache write、实际 route 纳入分层观测。若 Luna medium 与 max 质量相当，应优先 medium；只有 max 的可测增益覆盖额外 reasoning tokens 和延迟时才启用 max。

---

## 9. 来源索引（分层）

官方/仓库事实优先于社区实测；CodexRadar 与论坛仅支持其各自明确口径。原帖链接证明作者作过该报告，不证明报告可复现或能泛化。

### OpenAI 官方

1. [GPT-5.6 launch（2026-07-09，含 2026-07-30 更新、发布价、benchmark 与脚注）](https://openai.com/index/gpt-5-6/)
2. [Advancing the price-performance frontier with GPT-5.6（2026-07-30 调价公告）](https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/)
3. [GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
4. [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
5. [Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model/gpt-5.6)
6. [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
7. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
8. [GPT-5.6 System Card](https://deploymentsafety.openai.com/gpt-5-6)

### CodexRadar（二级/社区实测）

1. [CodexRadar 主站与动态快照](https://codexradar.com/)
2. [分布式雷达方法、DeepSWE、容器与服务端判分说明](https://deng.codexradar.com/)
3. [Table API：题目、cells 与 pricing version](https://api.codexradar.com/api/v1/table)
4. [Model metrics API：latest_valid_per_task、steps/tokens/cache 聚合](https://api.codexradar.com/api/v1/model-metrics)

### 原始论坛/社区帖子（用户报告）

- [HN 49119019](https://news.ycombinator.com/item?id=49119019)、[HN 49115451](https://news.ycombinator.com/item?id=49115451)、[HN 49066581](https://news.ycombinator.com/item?id=49066581)、[HN 48967745](https://news.ycombinator.com/item?id=48967745)
- [OpenAI Community 1386460](https://community.openai.com/t/gpt-5-6-luna-costs-96-more-than-gpt-5-4-mini-in-a-controlled-multi-turn-responses-api-test/1386460)、[1386204](https://community.openai.com/t/why-is-token-usage-in-codex-increasing-so-quickly-now/1386204)、[1386422](https://community.openai.com/t/responses-api-structured-outputs-gpt-5-6-luna-garbage-tokens-foreign-scripts-leaked-reasoning-inside-string-values-right-before-the-closing-quote-identical-request-via-chat-completions-is-clean/1386422)、[1386679](https://community.openai.com/t/bug-gpt-5-6-luna-intermittently-returns-http-500-for-image-only-function-outputs/1386679)

### 本仓库

- `packages/coding-agent/src/workflow/default-config.ts:276-380,638-679`
- `docs/workflow.md:1-32,73-118`
- `packages/coding-agent/src/workflow/types.ts:286-333`
- `packages/coding-agent/src/workflow/model-profile-registry.ts:76-92`
- `packages/coding-agent/src/workflow/runtime-adapter.ts:347-381`
- `packages/coding-agent/src/workflow/runtime-default.ts:57-76`
- `packages/coding-agent/src/thinking.ts:15-53,97-143`
- `packages/ai/src/providers/openai-responses.ts:102-105,1215-1243`
- `packages/catalog/src/effort.ts:1-18`
- `packages/catalog/src/model-thinking.ts:72-82,289-303`
- `packages/catalog/src/models.json:65616-65773,92476-92503,99666-99695`
- `packages/catalog/README.md:8-24`
- `packages/catalog/src/models.ts:1-12`
