# 分析：Codex / Grok Build 能否做与 per-model optimization 同类的上下文 token 优化

- 日期：2026-07-25
- **状态（2026-07-25 修订）**：omp **workflow 已移除** `codex_cli` / `claude_cli` 运行时；多模型仅 embedded（provider 模型 + `ModelProfile`）。下文中「omp 内 codex_cli 路径」历史分析保留作对照，**不再是产品路径**。独立原厂 CLI（Codex / Claude Code / Grok Build）仍可自行运行，且常通过 **worker** 执行——omp 不改变其 worker 行为。
- 关联设计：`docs/superpowers/specs/2026-07-25-per-model-optimization-design.md`
- 关联反馈：`docs/research/2026-07-25-per-model-optimization-user-feedback.md`
- 证据基线：`docs/research/2026-07-25-per-model-optimization-evidence.md`
- 方法：设计与代码对照 + 社区/厂商一手来源；社区个案仅作痛点识别，不作普遍 KPI

---

## 0. 结论（先读）

| 判断 | 内容 |
|------|------|
| **能不能做** | **能，但分层。** 设计文档里真正高杠杆、且与质量兼容的优化，大多是 **harness 侧**（喂给模型前的上下文卫生、工具输出卫生、阶段边界策略、可测量路由），不是「改 Codex/Grok 模型权重」。 |
| **omp workflow** | **仅 embedded**：`RuntimeAdapter` → `runStructuredSubagent`；per-model strategy 全覆盖。不再通过 shell 调 `codex`/`claude` 作为 stage backend。 |
| **独立 Codex / Grok Build CLI** | 只能控「你塞进会话的系统/任务上下文」+ 外部 hook；黑盒 tool loop 不在 omp 责任范围。原厂 CLI 仍可用自身 worker 机制。 |
| **质量底线** | 社区反馈一致：静默有损压缩会通过重试/重读把「省下的 token」吐回去。任何落地必须以 **可恢复 + 任务通过率不掉** 为 P0，tool-token −40% 为 P1。 |
| **不建议** | 在未测量前承诺「总会话 −40~70%」；不把外部 CLI 内部 compaction 改造成 omp 责任大修。 |

---

## 1. 设计文档的优化思路（提炼）

设计 v2 的核心不是「再堆 model 特例」，而是 **控制面 + 测量**：

```
噪音源 → 分项治理 → 相对 baseline 测量 → 质量门禁后才改默认
```

### 1.1 五条杠杆（按杠杆/可控性排序）

| 杠杆 | 设计意图 | 目标 token 桶 | 质量风险 |
|------|----------|---------------|----------|
| **Tool-output 卫生** | bash/test/git 等噪音输出 smart 摘要/截断（RTK 思想，内建） | tool-result | 中：丢失败信号会误修 |
| **Stage 上下文策略** | `contextPolicy` / `contextStrategy`：产物 include、byte cap、eviction、repo-map | stage context | 中：丢 plan/finding 会漂 scope |
| **Prompt / schema 适配** | per-model style、schema 增强、可选 retry | system + schema | 低–中：过度 few-shot 反而涨 token |
| **路由** | 质量关键阶段不掉 T3；implement 可换单价模型 | $/任务 | 高：静默降级直接伤质量 |
| **完整 CWL / tree-sitter map** | 方案 B，仅测量证明瓶颈后 | history + map | 高工程量 |

### 1.2 成功标准（设计原文纪律）

- **P0**：任务通过率 ≥ baseline；plan/code_review 不静默掉质量
- **P1**：tool-result tokens −40%+（**不是**总会话承诺）
- **P2**：$ 方向性下降
- 禁止把 RTK 89%、Cursor Router 30–60% 直接抄成 omp KPI

### 1.3 代码中的实际数据流（事实）

```
ModelProfile
  → prepareWorkflowInvocation
      → prompt / schema / context 截断与 eviction
      → processToolResult（embedded 路径经 session 生效）
  → runtime: embedded | codex_cli | claude_cli
```

**事实**：`WorkflowRuntimeKind` 仅 `embedded | codex_cli | claude_cli`（`types.ts`）。  
**事实**：`codex-cli-runtime` 会调用 `prepareWorkflowInvocation`，但最终只把  
`[assignment, context]` 拼成 stdin 交给 `codex exec`；**CLI 内部多轮 tool 调用不经过 omp 的 `processToolResult`**。  
**事实**：Grok 以 `modelPattern` + `explicit-grok` prompt template 出现在 `default-config`，默认走 **embedded**，不是独立 CLI runtime。

---

## 2. 网上用户反馈与意见（主题聚合）

标签：**Fact**（可核工程 issue/官方）/ **Vendor claim** / **Secondary** / **Hypothesis**

### 2.1 跨 harness 共性痛点（与 Codex/Grok 直接相关）

| 主题 | 来源 | 标签 | 含义 |
|------|------|------|------|
| CLI/bash 输出占大量上下文；过滤可砍 **bash 类** 60–90% | [RTK](https://github.com/rtk-ai/rtk)、[Kilo #5848](https://github.com/Kilo-Org/kilocode/discussions/5848) | Fact + 作者自述 | **最高共识杠杆**；作者强调 ≠ 账单 −90% |
| RTK 明确支持 **Codex** hook：`rtk init -g --codex` | RTK README | Fact | Codex 用户侧已有现成 tool-output 路径，不必 fork Codex |
| 自动压缩丢关键上下文；要预览/批准 | [Claude Code #10727](https://github.com/anthropics/claude-code/issues/10727) | Fact（工程诉求） | 质量 > 压缩率 |
| 多 agent 结果淹没上下文（个案 97.5%） | [Claude Code #24976](https://github.com/anthropics/claude-code/issues/24976) | Fact（个案） | subagent/tool 应分桶、文件化、可引用 |
| 中途静默 compact，无预警 | [Claude Code #25388](https://github.com/anthropics/claude-code/issues/25388) | Fact（个案） | 宜在阶段边界压缩 |
| 压缩丢 subagent 结果 → 重跑付双倍 | [Claude Code #32099](https://github.com/anthropics/claude-code/issues/32099) | Fact（个案） | **净成本 = 节省 − 返工** |
| 角色不同保留策略应不同 | [Claude Code #28559](https://github.com/anthropics/claude-code/issues/28559) | Secondary（提案） | role-aware retention |
| 仅总 token 无法诊断 | [Aider #2491](https://github.com/Aider-AI/aider/issues/2491) | Fact（个案） | 需要 system/schema/history/map/tool 分桶 |
| 大 profile = system+skills+schemas+history+tools 叠加 | [Hermes #33002](https://github.com/NousResearch/hermes-agent/issues/33002) | Secondary | 惰性加载 skills/schemas 是方向 |
| 路由可省成本（Intelligence/Balance/Cost） | [Cursor Router](https://cursor.com/blog/router) | Vendor claim | 30–60% 不可直接当 omp 数字 |
| repo-map 默认约 ~1k tokens 给方向 | [Aider repomap](https://aider.chat/docs/repomap.html) | Fact | 减无目标 read，不替代精确读 |

### 2.2 对「Codex 专属」反馈的诚实表述

- **Fact**：RTK 把 Codex 列为官方支持 agent 之一 → 社区承认 **Codex 同样吃 bash 噪音**。
- **Fact / 仓内**：omp 的 Codex 路径是 **一次性 `codex exec` + structured artifact**，不是 omp 接管其内部 conversation compaction。
- **未知（公开一手不足）**：OpenAI Codex 产品内 compaction 的用户投诉面，目前缺少与 Claude Code issue 同密度的可引用清单；不宜用 Claude Code 个案直接断言 Codex 内部行为。
- **推断**：凡「agent + shell + 长会话」架构，工具输出与历史膨胀机制同构，杠杆可迁移，**实现落点不同**。

### 2.3 对「Grok Build / Grok 编码 agent」反馈

- **Fact（仓内）**：omp 已有 `grok_implementer` / `grok_repair` 等 profile，`systemPromptTemplate: explicit-grok`，tool/context strategy 与其它 implementer 同构。
- **公开社区**：相对 Claude Code，**Grok Build 独立 CLI 的 compact/token 投诉一手源更少**；不宜硬造「用户普遍抱怨 Grok 浪费 token」的叙事。
- **推断**：Grok 编码场景同样会调用 bash/test/git；tool-output 卫生与 stage 上下文裁剪 **机制上适用**；是否默认更「啰嗦」需 usage 分桶测量，不能靠印象。

### 2.4 用户意见收敛成 4 条产品原则

1. **省的是无效 token，不是信息** —— 丢关键信号的压缩是负优化。  
2. **可恢复 / 可解释** —— 摘要应带 artifact 指针；压缩时机应可见。  
3. **分桶测量** —— tool / stage-context / history / schema 分开，否则无法调参。  
4. **质量优先门禁** —— 通过率掉 >3pp 则回滚该策略（与设计 §2.1 一致）。

---

## 3. 能力边界：谁控制哪些 token

```
┌─────────────────────────────────────────────────────────────┐
│ omp workflow harness                                        │
│  • stage context 拼装 / eviction / repo-map                 │
│  • prompt style + schema enhance                            │
│  • routing + usage artifact                                 │
│  • embedded: tool loop + processToolResult                  │
└───────────────┬───────────────────────────┬─────────────────┘
                │ stdin prompt + schema     │ 完整 tool loop
                ▼                           ▼
         codex_cli / claude_cli          embedded (含 Grok 模型)
         ┌──────────────────┐            ┌──────────────────┐
         │ 内部 history     │            │ omp tool session │
         │ 内部 tool 输出   │            │ 可摘要/截断      │
         │ 内部 compact     │            │ 可测可回滚       │
         └──────────────────┘            └──────────────────┘
                ▲
                │ 可选：PATH/hook 层 RTK（bash only）
```

| 优化项 | embedded（含 Grok 模型） | `codex_cli` | 独立 Codex 产品 | 独立 Grok Build CLI |
|--------|--------------------------|-------------|-----------------|---------------------|
| 进程前 stage context 裁剪 | ✅ | ✅（已接线 prepare*） | △ 用户/AGENTS.md | △ 用户配置 |
| Prompt style / role 模板 | ✅ | ✅ | △ | △ |
| Structured schema 增强 | ✅ | ✅（`--output-schema`） | △ 视 CLI 旗标 | 未知 |
| 工具结果摘要 | ✅ session | ❌ 黑盒内 | △ RTK hook | △ 若支持 hook |
| 会话中途 eviction | ✅ | ❌ | 产品内建 | 产品内建 |
| 模型路由 | ✅ | ✅ 选不选 codex | ❌ | ❌ |
| usage 分桶 | ✅（可加深） | △ JSONL usage 粗粒度 | 产品侧 | 产品侧 |

---

## 4. 针对 Codex：可做清单（质量不伤前提）

### 4.1 已在 omp 路径上、应保留并测清的

1. **`prepareWorkflowInvocation` 进程前优化**  
   - 只把本阶段必要的 plan/diff/findings/repo-map 注入 stdin。  
   - 严格执行 `artifactInclusion` / byte cap / role include 旗标（避免把全 transcript 塞进 Codex）。  
2. **Schema 合同**  
   - 用 profile `outputStrategy` 减少 schema 来回失败（失败重试成本是隐藏 token 税）。  
3. **角色隔离**  
   - plan / review / implement 分 attempt，避免单次 `codex exec` 背负全流水线历史。

### 4.2 高 ROI、不改 Codex 源码

| 动作 | 机制 | 预期 token 桶 | 质量护栏 |
|------|------|---------------|----------|
| 可选 RTK / 内建 bash 卫生（环境层） | Codex shell 输出变短 | tool-result | 保留 exit code、失败块；A/B 任务通过率 |
| 收紧 stage context 默认 include | 少塞上游产物 | input prompt | review 阶段不得默认丢 finding |
| 禁止 write 角色无 isolation 乱跑 | 已有 policy | 无效返工 | 已实现 |
| usage 从 JSONL 归一化进 artifact | 已有 normalize | 测量 | 分桶仍弱，需加强 |

### 4.3 低 ROI / 高风险（暂不做）

- 尝试 hook 进 Codex 内部 message list 做 CWL 级 eviction（违反设计非目标；兼容面爆炸）。  
- 把 Codex 当「可替换 tool runtime」去转发每一条 tool result 过 omp summarizer（等于再写一个 agent 宿主）。  
- 用更短 prompt「省 token」却导致 schema 失败率上升。

### 4.4 Codex 路径的现实收益区间（**Hypothesis**，须测）

- **进程前 context**：若当前把完整 transcript / 大 artifact 灌入，裁剪后 **prompt 桶** 可观（任务依赖；可能 20–70% of **that bucket**）。  
- **bash tool 桶**：RTK 类 60–90% of **bash output**（官方口径）。  
- **总会话账单**：通常显著小于上述两数的乘积——与 RTK README 稀释说明一致。  
- **质量**：仅当「失败信号 + 决策约束」保留时，通过率才可持平。

---

## 5. 针对 Grok Build / Grok 模型：可做清单

### 5.1 omp 内 Grok profile（主路径，推荐投入）

与设计 Gap Matrix 一致，Grok 已享受：

- `explicit-grok` prompt style  
- toolStrategy summarizers（bash/read/grep/…）  
- contextStrategy eviction + repoMap  
- implement/repair 路由位

**额外建议（Grok 特化，仍服从测量门禁）：**

| 项 | 理由 | 质量注意 |
|----|------|----------|
| implement 默认偏 cost_sensitive 截断阈值 | Grok 常作 implement/repair | 不得用于 code_review 默认 |
| 强化 bash/test summarizer | 实现阶段 tool 占比高 | 失败测试名必须保留 |
| **修正 read 摘要合同** | 用户反馈研究已指出 read 归零式摘要破合同 | **P0**，所有模型共用 |
| 避免给 Grok 堆 inert few-shot | 涨 token 且未接线字段无收益 | 仅 schema 弱时再开 |

### 5.2 独立 Grok Build CLI（若用户本机直接用）

与 Codex 独立产品同构：

1. **会话输入侧**：精简 AGENTS/skills/系统粘贴；分阶段新会话而非无限续聊。  
2. **环境侧**：若 hook 生态可用，上 CLI 输出压缩；否则用 shell wrapper。  
3. **不要指望 omp 改 Grok Build 内部 compact**（设计非目标）。  
4. 若要把 Grok Build 收编为 runtime，需新增 `WorkflowRuntimeKind` + isolation/schema 合同——**另立项**，不在本分析「免费收益」范围。

---

## 6. 「减少无效 token」且「输出质量不受影响」的操作定义

### 6.1 什么叫无效 token（可操作）

| 类型 | 例子 | 处理 |
|------|------|------|
| 噪音 | 测试 progress bar、全量 pass 列表、spinner | 可丢 |
| 冗余 | 重复 git status、重复 cat 同一文件 | 可摘要/引用 |
| 过期 | 已被 supersede 的旧 plan 全文 | 阶段边界驱逐 |
| **有效** | exit code、首个失败断言、用户约束、未关闭 finding、当前 diff 关键 | **必须保留或可一跳恢复** |

### 6.2 质量护栏（落地检查表）

1. **可恢复**：摘要附 `artifact id` / 路径 / 行范围；模型可 `read` 展开。  
2. **失败完整**：错误路径保留 root-cause 块，不只 regex 命中 `error` 的单行。  
3. **阶段边界压缩**：禁止任务中途不可见 compact（对齐社区投诉）。  
4. **配对 A/B**：同任务 × 多 seed；质量跌 >3pp 回滚。  
5. **净成本**：统计重试、重复 read/grep、用户纠正——防止「假省钱」。  
6. **read 工具合同**：默认有界截断，禁止正文归零（既有研究 P0）。

### 6.3 推荐实验顺序（Codex 与 Grok 共用）

```
1. 修 read/bash 可恢复摘要合同（全 runtime 受益面最大的是 embedded；Codex 靠 RTK）
2. 固定 10 任务 × 每类 ≥3 次：baseline vs optimized
3. 只改一个旋钮：先 tool-output，再 stage include，最后路由
4. 分桶报告：prompt / tool / output / retry
5. 通过门禁后再改 default-config
```

---

## 7. 综合可行性评分

| 方向 | 可行性 | 预期净收益 | 质量风险 | 建议 |
|------|--------|------------|----------|------|
| omp embedded 上加强 tool 卫生 + 可恢复摘要 | 高 | 高（tool 桶） | 可控（有护栏） | **立刻做** |
| Codex `prepare*` stage 上下文减负 | 高 | 中–高（视当前是否灌 transcript） | 低–中 | **立刻做 + 测** |
| Codex + RTK/环境 hook | 高 | 中（bash 桶） | 低（保留失败信号时） | **可选集成，默认不强制依赖** |
| Grok profile 调参（截断阈值/路由） | 高 | 中 | 中（须门禁） | Phase C 数据后 |
| 完整 CWL / 劫持 CLI 内部 history | 低–中 | 不确定 | 高 | **不做**（触发条件见设计 §6.7） |
| 新建 grok_cli runtime | 中 | 产品决策 | 工程大 | 另立项 |

---

## 8. 对设计文档的补充建议（不改代码，仅策略）

1. 在设计/实现计划中显式增加 **「按 runtime 的优化覆盖矩阵」**（本文 §3），避免把 embedded 的 toolStrategy 收益误记到 `codex_cli`。  
2. Codex 路径的 P1 指标拆成：`stdin_context_bytes` + `cli_reported_usage` +（可选）`rtk_bash_savings`。  
3. Grok 与 Codex 的「质量不受影响」统一用同一任务集，禁止用不同题集互吹。  
4. 将社区反馈中的 **可恢复压缩** 升为全模型 P0（已有 user-feedback 文）；本分析确认其同样约束 Codex/Grok。

---

## 9. 参考

1. 设计：`docs/superpowers/specs/2026-07-25-per-model-optimization-design.md`  
2. 用户反馈研究：`docs/research/2026-07-25-per-model-optimization-user-feedback.md`  
3. 证据附录：`docs/research/2026-07-25-per-model-optimization-evidence.md`  
4. RTK: https://github.com/rtk-ai/rtk  
5. Kilo discussion: https://github.com/Kilo-Org/kilocode/discussions/5848  
6. Claude Code issues: #10727, #24976, #25388, #28559, #32099  
7. Aider repomap / #2491  
8. Cursor Router: https://cursor.com/blog/router  
9. 仓内：`packages/coding-agent/src/workflow/{runtime-invocation,codex-cli-runtime,default-config,types}.ts`

---

**文档结束**

---

## 附录 A：渐进式默认输出限制（Progressive Output Ladder）

- 日期补充：2026-07-25
- 触发：用户建议参考 RTK，read/bash 默认小输出，不足再 10→40→80… 放大

### A.1 判断

**方向正确，且与仓内现有合同高度同构。** 不应从零发明「压缩层」，而应把「默认小窗 + 触顶明示下一步 + 可恢复全量」做成统一 ladder，替代今天分散的 `limit*2` / 固定 `defaultLimit=300` / bash 50KB 硬截断。

### A.2 现状（事实）

| 能力 | 现状 | 缺口 |
|------|------|------|
| `read.defaultLimit` | 默认 **300** 行（settings；hard cap `DEFAULT_MAX_LINES=3000`） | 偏大；无阶梯语义 |
| 无 selector 代码 read | `read.summarize` 结构摘要 + 恢复 selector | 已是「先小后精」——应保留优先于裸 300 行全文 |
| `applyListLimit` | 触顶后 `suggestion = limit * 2` | 倍增可能跳得猛/不规律；应用固定 ladder |
| `formatOutputNotice` | `Use limit=N for more` / `Use :offset to continue` | 文案未暴露阶梯 |
| bash | ~50KB inline + `artifact://` 全量；prompt 劝勿 head/tail | 无「行数阶梯」参数；模型可见窗仍偏大 |
| workflow summarizer | 结果后处理摘要 | 与工具默认窗是两层，可叠加但勿双砍有效信息 |

### A.3 推荐合同：两层限制

```
Layer 1 — Probe window（默认，模型可见）
  小、可预测、触顶必带 next rung

Layer 2 — Recovery（按需）
  显式 limit/selector / artifact://:range / 下一 rung
  全量永不默认进 context
```

**禁止**：静默把 probe 结果当「文件已完整读完」；notice 必须机器可遵循。

### A.4 阶梯表（默认）

统一 **行数 ladder**（可配置，默认）：

```
10 → 40 → 80 → 160 → 300 → 600 → 1200  (cap = min(settings, DEFAULT_MAX_LINES))
```

辅助函数（概念）：

```ts
function nextOutputLimit(current: number, ladder = DEFAULT_OUTPUT_LADDER): number {
  for (const step of ladder) if (step > current) return step;
  return Math.min(current * 2, HARD_CAP); // 超出 ladder 后倍增封顶
}
```

替换 `list-limit` / `resultLimit` 里的 `suggestion = limit * 2`。

### A.5 分工具策略

#### read

| 调用形态 | 默认行为 | 放大 |
|----------|----------|------|
| 代码文件、无 selector | **保持 summarize**（结构摘要）；不要改成 dump 10 行 | footer 的 range 精确 re-read |
| 显式 range / offset | 尊重用户/模型给的 limit | 触顶 → `nextOffset` + next ladder step |
| 无 limit 的全文/文本 | `defaultLimit` 降到 ladder 低档（建议 **80** 作 default，**10** 仅作 optional aggressive profile） | notice: `Use limit=160` 或 `path:N-M` |
| 目录 listing | 已有 list limit | ladder suggestion |

**反对一律 default=10**：session 统计曾支持 300→更低，但 10 行对源码定位会显著增加 round-trip；净 token = tool_out↓ − 额外 turns↑。  
**折中**：default **40 或 80**；workflow/cost profile 可再降到 10–40。

#### bash / eval 类命令输出

| 输出类型 | 默认 | 放大 |
|----------|------|------|
| 成功 + 冗长（test pass 列表、progress） | RTK 式 **失败优先 / 计数折叠**；可见窗 head+tail 小 | `artifact://` 或 `maxLines` 下一 rung |
| 失败 / 非 0 exit | **smart 保留**错误块，不受 10 行硬切 | 仍可 artifact 全量 |
| 明确探测命令（`wc`/`head` 已写在命令里） | 尊重命令本身 | — |

新增可选工具参数（概念）：`outputLines?: number`（默认 ladder[1] 或 40）。  
触顶 notice：`Showing 40 of 900 lines. Use outputLines=80 for more, or artifact://id:1-200`。

### A.6 Agent 行为（prompt，非靠自觉）

在 `read.md` / `bash.md` 增加短 instruction（Handlebars）：

- 默认接受工具窗；**仅当 notice 报告 truncated 且任务仍缺信息** 再升一档。
- 禁止一上来 `limit=5000` / `outputLines=3000`。
- 代码优先：summary → 精确 selector，而不是 ladder 推到 1200 全文。

### A.7 质量护栏

1. 失败路径不参与「激进 10 行」裁切（smart preserve）。  
2. 每条截断 notice 含：`shown / total / next_limit / recovery URI`。  
3. A/B：任务通过率、重复 read 次数、tool-result tokens、turn 数；**净 token** 为真指标。  
4. 若平均 turns +20% 而 tool tokens −30%、总 input 不降 → 回退 default 到 80/160。

### A.8 实现落点（建议 Phase）

| Phase | 改动 | 风险 |
|-------|------|------|
| P0 | `nextOutputLimit` + 替换 list-limit suggestion；notice 文案 | 低 |
| P1 | `read.defaultLimit` 默认 80（或 40）；UI options 增加 40/80；prompt 一句 | 中（测覆盖率） |
| P2 | bash `outputLines` 默认 40 + smart fail 例外 + artifact 恢复文案 | 中 |
| P3 | workflow profile 绑定更激进 ladder（cost_sensitive=10 起） | 低（已有 strategy 面） |
| 不做 | 把 RTK 作为硬依赖；双层摘要（tool 已小 + workflow 再归零 read） | — |

### A.9 与 Codex / Grok

- **embedded / Grok**：P0–P2 全收益。  
- **codex_cli**：进程前 context 仍按 stage 裁；CLI 内 bash 需 RTK/hook 或 Codex 自身截断；omp 只能在 prompt 里教「先小后大」——**不可强制 CLI 内 ladder**。

