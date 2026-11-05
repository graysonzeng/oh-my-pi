# Per-Model Optimization：用户反馈与下一轮迭代分析

- 日期：2026-07-25
- 关联设计：`docs/superpowers/specs/2026-07-25-per-model-optimization-design.md`
- 方法：优先工程一手来源（GitHub issue/discussion）和官方资料；社区反馈仅用于识别痛点，不作为普遍事实或模型排名。

## 结论

下一轮最值得做的不是继续增加静态 per-model 特例，而是建立一个**可测量、可恢复、可解释的优化闭环**：

1. 先解决有损摘要的质量风险，任何被省略内容都必须可恢复。
2. 把固定任务集 A/B、token 分桶、成本、延迟、用户干预和路由结果连成同一份实验记录。
3. 路由从“模型 ID 排名”转为“阶段合同 + 能力档位 + 明示 fallback”，真实数据稳定后再自适应。

设计 v2 的 `Stabilize & Measure` 方向正确，但当前实现仍更像一组策略开关和单元测试，而不是能回答“哪项优化对哪个模型、哪类任务真实有效”的实验系统。

## 外部反馈

| 反馈主题 | 原始来源 | 证据类型 | 可采信结论 | 限制 |
|---|---|---|---|---|
| 自动压缩丢失关键上下文，用户希望预览、修改和批准保留/摘要/删除项 | [Claude Code #10727](https://github.com/anthropics/claude-code/issues/10727) | engineering / 用户提案 | 压缩的可见性和可控性本身是产品需求；只提高压缩率不够 | 单个 feature request，不代表发生率 |
| 多 agent 结果占上下文 97.5%，到硬上限后 `/compact` 也无法恢复 | [Claude Code #24976](https://github.com/anthropics/claude-code/issues/24976) | engineering / 复现场景 | subagent/tool result 应被独立分桶、提前预警并支持文件化/引用式传递 | 极端长会话个案 |
| 压缩在任务中途突然触发，无预警、进度和恢复路径 | [Claude Code #25388](https://github.com/anthropics/claude-code/issues/25388) | engineering / 用户个案 | 优化时机属于 workflow 质量；应在阶段边界触发并暴露状态 | 单个 Max 用户体验 |
| 通用压缩会丢失角色关键状态；规划、研究、实现需要不同保留策略 | [Claude Code #28559](https://github.com/anthropics/claude-code/issues/28559) | engineering / 设计提案 | context policy 应按 workflow role 定义，而不只按 model 定义 | 尚未证明方案已生产验证 |
| 压缩静默丢掉 subagent 结果，导致重复运行并支付两次 token | [Claude Code #32099](https://github.com/anthropics/claude-code/issues/32099) | engineering / 用户个案 | “节省 token”必须扣除因信息丢失导致的重试、重复搜索和返工成本 | 单个报告，但失败模式清晰 |
| 用户看到单条消息出现异常高 token/成本，即便启用了 repo-map 和 prompt cache | [Aider #2491](https://github.com/Aider-AI/aider/issues/2491) | engineering / 用户个案 | 只展示总 token 不足以诊断；需要 system、schema、history、repo-map、tool result、cache 分桶 | 较旧版本，具体数值可能过时 |
| CLI 输出过滤可显著减少 bash 类 tool payload | [Kilo discussion #5848](https://github.com/Kilo-Org/kilocode/discussions/5848)、[RTK](https://github.com/rtk-ai/rtk) | engineering + 作者自述 | bash/test/git 输出卫生是高杠杆项 | 60–90%/89% 是 tool-output 或作者样本，不是总会话收益 |
| 大 agent profile 的真实上下文压力来自 system、memory、skills、tool schemas、history、tool outputs 的叠加 | [Hermes Agent #33002](https://github.com/NousResearch/hermes-agent/issues/33002) | engineering / 研究需求 | 应提供 request token 分桶、惰性 skill/tool schema 加载和压缩失败诊断 | 需求文档，不是已验证实现 |
| repo-map 用 tree-sitter 符号和图排序在有限预算内提供代码库方向 | [Aider repo-map](https://aider.chat/docs/repomap.html) | primary / 官方文档 | repo-map 的价值在“减少无目标读取”，不是替代精确文件读取 | 不能从机制直接推出 omp 的质量提升 |
| 自动路由可降低成本，并提供 Intelligence / Balance / Cost 档位 | [Cursor Router](https://cursor.com/blog/router) | primary / vendor claim | 用户需要显式目标档位；路由应可解释且可覆盖 | 30–60% 为厂商 A/B/early access 数据，不能当 omp KPI |

访问日期均为 2026-07-25。

## 与当前实现的关键对照

### 1. 最大质量风险：摘要不可恢复

当前 `DEFAULT_SUMMARIZERS.read` 只返回路径、行数和字节数；workflow session 会把 `processResult` 安装到真实工具路径，`read` 工具随后将处理后的文本写入模型可见结果。也就是说，启用该 profile 时，模型可能看不到刚读取的文件正文。

这比“摘要算法还不够聪明”更严重：它破坏了 read 工具的核心合同。外部压缩反馈反复指向同一模式——静默丢失的信息会转化为重复读取、重复 subagent、错误修改和额外成本。

下一轮应先实现：

- `read` 默认只做有界截断，不做正文归零式摘要。
- 所有摘要返回 `original artifact id/hash`、省略范围和可重新展开方式。
- 对失败命令保留 exit code、首个根因块、尾部错误、失败测试名和重现命令，而不是只匹配含 `error|fail` 的行。
- 为 summarizer 增加“信息召回”合同：给定关键行，优化后仍可直接看到或一跳恢复。

### 2. 测量面存在，但尚未形成实验闭环

当前已有 attempt 级 usage artifact、routing audit、budget ledger 和 `quality-gate` 比较函数；缺的是设计 A3 的固定任务 runner，以及把质量、token、cost、latency、retry、user intervention 聚合成可比较报告的执行入口。

建议每次 benchmark 固化：

- repo commit、任务夹具版本、provider/model 实际解析结果、profile/strategy fingerprint。
- input/output/cache/tool-result/schema/repo-map/context-eviction token 分桶。
- 首次通过率、最终通过率、schema retry、provider fallback、工具调用数、重复 read/grep、用户纠正次数。
- wall time、首 token 延迟、模型时间、工具时间、排队/重试时间。
- patch 的测试通过、范围遵循、无关改动、review finding 数量。

必须做 paired A/B 和重复运行。LLM 非确定性下，单次“优化前后各一轮”不足以调默认路由。

### 3. 路由应从模型排行榜转成阶段合同

静态注册顺序和 fallback 能保证可运行，但不能证明“该模型在该阶段最划算”。模型版本、价格和 provider 行为变化很快，按公开模型 ID 长期维护 prompt/profile 会产生配置漂移。

建议分两层：

- 稳定层：`quality_critical`、`balanced`、`cost_sensitive`、`long_context`、`fast_repair` 等能力档位，定义质量下限、最大成本、最大延迟、是否允许降级。
- 易变层：把当前模型映射到能力档位，由 benchmark scorecard 和本地可用性更新。

planning/code review 等关键阶段默认 fail-closed：若只剩低质量档位，明确询问或报错，不静默 fallback。所有 fallback 都应在结果中显示“原计划模型、实际模型、原因和估算影响”。

## 进一步迭代优先级

### P0：先补可信度与质量底座

1. **可恢复的 loss-aware tool optimization**
   - 修复 `read` 正文丢失。
   - 工具结果保留原文 artifact，摘要只是索引层。
   - 增加关键事实召回、失败诊断完整性和重复读取率测试。

2. **固定任务集与阶段级 A/B runner**
   - 任务按单文件修复、多文件实现、调查/规划、review、长会话分类。
   - optimized/off、不同 profile 和 route 使用同一输入，多次重复。
   - 质量回退超过 3pp 自动标红，但不自动改生产配置。

3. **真实可观测性**
   - usage artifact 增加 token bucket、duration、retry/fallback、compression receipt。
   - 输出单任务瀑布图或表：每个阶段花了多少钱、时间和 token，为什么重试。

### P1：优化流程与输出质量

4. **阶段边界压缩与 role-aware retention**
   - planning 完成、implementation 完成等自然边界再压缩。
   - planner 保留决策/约束，implementer 保留文件/patch/test，reviewer 保留 diff/规范/未关闭 finding。
   - 避免任务中途不可见压缩。

5. **结构化输出的分层修复**
   - 先做确定性 JSON 提取/局部修复，再决定是否发起昂贵模型重试。
   - retry prompt 应包含具体 violation 和已生成内容的最小必要片段。
   - 统计“重试后成功率”和“每次成功增加的成本”，按模型调整而非固定拍脑袋次数。

6. **范围遵循与最小改动作为质量指标**
   - 除 pass rate 外，记录无关文件修改、用户回滚/纠正、review 中 scope-creep finding。
   - 这更接近用户对“输出质量”的真实感受，而不只是 schema-valid 或测试绿。

### P2：成本与延迟深化

7. **惰性 tool/schema/skill 加载**
   - 先给短描述，只有阶段需要时加载完整 schema/skill。
   - 记录 schema/system prompt 占比；占比不高时不要为省小量 token 增加复杂度。

8. **缓存友好的稳定前缀**
   - 固定 system、tool schema 顺序和不变策略文本，动态内容放后部。
   - 分开报告 cache read/write/uncached input，成本判断不能只看总 input token。

9. **并发按依赖与预算控制**
   - `maxConcurrentTools` 不应只是 per-model 常数；根据工具依赖图、剩余预算和重复风险调度。
   - 并行探索要计入重复文件读取和被丢弃结果的浪费。

## 不建议现在做

- 不先上完整 CWL 或 tree-sitter/PageRank 重构；先用 benchmark 证明 regex map/当前 eviction 是任务失败主因。
- 不依据社区吐槽继续绝对化模型 T0–T3 排名；用户反馈更能说明 harness 失败模式，不能稳定预测模型能力。
- 不把更激进的截断率当作成功；净成本必须包含重试、返工和重复工具调用。
- 不立即做在线自学习路由；先完成可复现的离线 scorecard、显式档位和 fallback guard。

## 建议的下一步验收顺序

1. 修复并验证 `read`/bash/test 的可恢复摘要合同。
2. 落地 10 个任务夹具，但每类至少重复 3 次，生成 baseline 报告。
3. 根据报告只调一个变量：先 tool optimization，再 context policy，最后 model routing。
4. 当某项在质量不退、净成本/延迟稳定改善后，才改默认 profile。

这个顺序能把“per-model optimization”从静态配置集合变成持续可验证的控制面。
