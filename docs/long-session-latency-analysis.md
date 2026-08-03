# omp 长会话耗时事件点与根因分析

> 生成日期：2026-08-03
> 数据来源：`~/.omp/agent/sessions/` 全量会话记录 + `~/.omp/agent/agent.db`（model_perf）
> 目的：为新会话 agent 制定「长会话性能优化方案」提供证据底座。新会话开工前先读本文，再按文末短 prompt 展开设计。

---

## 1. 背景

原始任务：收集 omp 历史会话记录，分析并总结长会话中主要耗时事件点及根因，附带证据，便于新会话 agent 根据内容制定优化方案。

分析结论一句话：**长会话的耗时集中在三处——① 全程使用高延迟主模型（gpt-5.6-sol）且上下文长期处于 200-300k（TTFT 翻倍）；② 串行等待子代理评审门禁（hub 满时长轮询）；③ 验证循环失败后同命令反复重跑（E2E 重跑 8 次 ≈ 30m）。**

## 2. 结论先行（时间账）

语料：886 个会话 JSONL（1.1GB），解析成功 689 个真实会话（排除 `-tmp-*`、`-.claude*`、`*-fixture`），总墙钟 615h，其中**活跃耗时 306.6h**（模型生成 + TTFT + 工具执行）。

| 根因 | 耗时 | 占比(活跃) | 关键证据 |
|---|---|---|---|
| 模型生成延迟 gen | 174.3h | 57% | 主模型 `gpt-5.6-sol` 17205 轮，avg 29s/轮 |
| 首 token 等待 TTFT | 92.0h | 30% | sol avg 16s/轮；随上下文膨胀至 29-51s |
| hub 同步等子代理/门禁 | 21.3h / 3559 次 | 7% | avg 22s；重点会话 avg 1.4m，intent 全为"等待…" |
| bash 长尾命令+失败重跑 | 6.2h / 5534 次 | 2% | E2E 脚本单次 3-5.5m 重跑 ≥8 次；单条 bash 阻塞 2.12h |
| eval 异模型门禁/测评 | 3.7h / 578 次 | 1.2% | 单次最长 13.9m（在 eval 里跑 LLM 门禁） |
| web_search 外部延迟 | 3.7h / 285 次 | 1.2% | avg 47s/次 |

次要项：`ask` 用户等待 1.04h/9 次（单次最长 52.6m）、`read` 19117 次（同一文件重复读 42 次）、26 个会话发生 compaction（触发点 316-371k tokens，累计压缩 11.5M tokens）。

## 3. 数据来源与方法（可复跑）

- 会话记录：`~/.omp/agent/sessions/<项目>/<时间戳>_<sessionId>.jsonl`。
  - `custom` 事件 `tool_execution_start`：记录 `toolCallId`、`toolName`、`startedAt`、`args`、`intent`
  - `message` 事件 role=`toolResult`：工具结束（含 `isError`）
  - `message` 事件 role=`assistant`：携带 `duration`、`ttft`、`usage`、`contextSnapshot.promptTokens`、`model`、`stopReason`
  - `compaction` 事件：`tokensBefore`、`summary`
- 佐证库：`~/.omp/agent/agent.db` 的 `model_perf` 表（模型级 gen/ttft 聚合样本）。
- 统计口径：
  - 工具耗时 = toolResult.timestamp − tool_execution_start.startedAt
  - 模型等待间隔 = 上一事件时间 → 下一条 assistant message 时间（>5s 计入）
  - 活跃耗时 = gen + ttft + 工具耗时；墙钟含用户空闲/夜间挂机
- 分析脚本与中间结果保留在 `/tmp/omp_analysis/`：`session_analyze.py`（全量解析）、`evidence2.py`（单会话证据）、`sessions_summary.json`（689 会话聚合结果）。

## 4. 长会话排行（按活跃耗时，排除夜间空闲）

| # | 会话 | 活跃耗时 | 构成 | 特征 |
|---|---|---|---|---|
| 1 | starrocks-diagnostics-skills 07-31「分区一致性告警诊断」 | 7.75h | tools 2.85h + gen 3.14h + ttft 1.75h | 369 轮 sol；hub 2.41h/103 次 avg 1.4m；stopReason error=108 次 |
| 2 | Aegis 08-01「调整 Design Review Gate 变更控制」 | 6.96h | eval 2.51h/22 次(avg 6.8m) + gen 2.84h | eval 异模型门禁型 |
| 3 | oh-my-pi 08-01 11:39「实现质量优先模型路由设计」 | 6.32h | gen 3.77h + ttft 2.36h，**tools 仅 11m** | 纯模型等待型 |
| 4 | oh-my-pi 08-01 06:14（路由调研） | 6.24h | ask 52.6m + hub 42.3m + eval 22.4m | 用户+子代理等待型 |
| 5 | oh-my-pi 08-01 12:07「实现 workflow work-package 自动并行」 | 5.56h | gen 3.37h + ttft 2.18h，tools 43s | 纯模型等待型 |
| 6 | oh-my-pi 08-02 06:31「继续质量路由 Goal 验证」 | 5.42h | bash 53.8m + hub 42.5m + **错误重试 32.6m** | 验证循环型 |
| 7-11 | starrocks-scheduler 07-27 / alter-report 07-28×2 / oh-my-pi 07-28 01:51 / 08-01 05:25 | 4.7-5.4h | 混合模式 | — |

## 5. 分根因证据

### R1 模型生成 + TTFT（占比最大）

- `gpt-5.6-sol`：17,205 轮，gen 136.9h（avg 29s/轮）、TTFT 75.7h（avg 16s/轮）→ **每轮 ≥45s 纯模型等待**。
- **TTFT 随上下文膨胀**（全语料按 promptTokens 分桶，实测）：

  | context 区间 | avg TTFT |
  |---|---|
  | <50k | 8.1s |
  | 50-100k | 16.7s |
  | 100-150k | 19.6s |
  | 150-200k | 27.0s |
  | 200-300k | 28-29s |
  | ≥350k | 51.0s |

- sol 单独看：`ctx<100k avg TTFT 15.6s → ctx≥200k 29.1s`（约 2 倍）。
- 模型间差距：sol/luna TTFT 16-17s vs deepseek-v4-flash / grok-4.5 4s。
- `agent.db model_perf` 佐证：sol 178 样本 TTFT avg 41s、gen 64s/req。
- 纯等待型会话例：08-01 11:39 会话 460 次工具调用但工具耗时仅 11m，265 轮全为 sol（gen 51s + ttft 32s/轮）。

### R2 hub 同步等待（工具耗时第一名）

- 全语料 hub 21.3h / 3559 次，占工具总时间 53%。
- starrocks-skills 会话：103 次 avg 1.4m，intent 均为「等待设计专家异模型复审 / 等待 Spec 代码评审 / 继续等待最终门禁」，且几乎每次都是**满 3.0m 超时轮询**。
- oh-my-pi 08-01 06:14：33 次 avg 1.3m；08-02 06:31：45 次「Waiting for delegated reviews / repair completion」。

### R3 bash 长尾命令 + 失败重跑

- 长尾明细（全语料 top bash）：
  - `bun .agent-artifacts/quality-routing-goal/run-quality-e2e.ts` 单次 2.0-5.5m，**重跑 ≥8 次**（"Running critical E2E"→"Rerunning critical E2E"→"Verifying balanced E2E repair"→"Smoking balanced final source" 同命令反复）
  - `bun test` 单次 5.0m（300s 超时）
  - `omp` 自调用 E2E 2.0-5.0m；ssh 远程命令 2.6m；快照重建 2.4m
- 极端案例：alter-report 07-28 会话单条 bash「Restart BFF on port 8765」前台阻塞 **2.12h**。
- 失败循环证据（oh-my-pi 08-02 06:31）：错误总耗时 32.6m，`fable-final-review` 同脚本重跑 6+ 次（1.4m-3.8m）；starrocks-skills 会话 stopReason `error=108` 次；Aegis 会话 grep 两次 30s 超时（未限定 path 范围）。

### R4 eval 里跑异模型门禁/测评

- Aegis 08-01：eval 22 次 avg **6.8m**（总 2.51h），intent「异模型设计门禁」。
- starrocks-skills：11 次 avg 2.2m（单次 13.9m「异模型最终设计门禁」）。
- oh-my-pi 08-01 06:14：36 次 avg 37s（5m 上限的测评类）。

### R5 外部服务延迟

- web_search 285 次 avg 47s；xd://browser 两次超时（60s/30s，目标 artificialanalysis.ai）；ssh 跨机命令 2.6m。

### R6 上下文压力（compaction + 重复 read）

- 26 个会话发生 compaction，触发上下文 **316-371k tokens**，累计压缩 11.5M tokens；长会话长期运行在 200-300k → 直接推高 TTFT（见 R1）。
- read 19,117 次：同一 design spec 文件被读 42 次、同一源文件 29 次、classify.py 25 次（top-5 采样，实际更高）→ 上下文刷新后反复重读。
- cacheRead 750M tokens、命中率 95.7% → 缓存虽生效，TTFT 仍随上下文增长，**省的是钱，不是时间**。

### R7 用户交互等待

- ask 9 次 avg 7m，最长 52.6m（oh-my-pi 08-01 06:14「确认 Memory Bank 替代路径」）。

## 6. 优化方向（证据推导）

1. **模型路由**：低价值轮次/子代理改用低 TTFT 模型（flash/grok TTFT 4s vs sol 16s）；sol 仅用于必要的高难轮次。按 17205 轮规模，可省约 60% 模型等待。
2. **上下文管理**：主动在 ~200k 前压缩/归档（compaction 触发点 316k+ 已太晚）；重复 read 前先确认内容是否已在上下文（42 次重读同一 spec 是明确浪费）；结论走 memory-bank/local:// 传递，避免重读。
3. **并行策略**：hub 等待期间推进其他独立切片，不要空等；用事件驱动 / `await:true` 替代 2-3m 满时长轮询（证据：等待时长几乎恒等于超时上限）；压缩「等评审门禁」的串行链。
4. **验证闭环**：E2E 先跑定向/小范围（run-quality-e2e.ts 单次 3-5.5m）；失败先看输出再决定重跑（同命令重跑 8 次 ≈ 30m 纯浪费）；为 bash 设合理超时并区分服务型命令（2.12h 前台阻塞案例 → 应走 hub start 后台）。
5. **外部调用**：web_search 合并查询、限制次数；grep 先 glob 缩小范围防 30s 超时；不在 eval 里跑异模型门禁（14m 单次）。
6. **工具纪律**：长服务进程用 `hub op:start`；`eval` 是 CPU 执行环境，不是 LLM 推理通道，不应承载模型调用。

## 7. 新会话设计方案的短 prompt

以下 prompt 可直接作为新会话的开场指令（将其粘贴到新会话首条消息即可）：

```text
读 docs/long-session-latency-analysis.md（omp 长会话耗时根因分析，含完整证据链）。

背景：omp 长会话主要耗时点为①主模型 gpt-5.6-sol 高 TTFT（avg 16s/轮，200k+ 上下文时 29s+）；②hub 串行等待子代理/评审门禁（全语料 21.3h，多为 2-3m 满时长轮询）；③bash 验证命令失败后同命令反复重跑（E2E 重跑 8 次）；④eval 内跑异模型门禁（单次最长 13.9m）；⑤外部调用 web_search avg 47s/次；⑥compaction 触发点 316k+ 过晚导致 TTFT 翻倍。

任务：基于该文档设计「长会话性能优化方案」。要求：
1. 至少两个可选方案（如模型路由优化 / 并行与等待策略优化 / 验证闭环优化），输出取舍对比；
2. 每个方案给出：改动点（文件/模块级）、预期收益（按文档数据量化，如可省 X 小时）、风险与回滚方式、验收证据；
3. 方案必须可落地到本仓库，优先最小侵入；
4. 输出为评审用设计文档（目标、约束、成功标准、风险、实施步骤），不要直接改代码。
```
