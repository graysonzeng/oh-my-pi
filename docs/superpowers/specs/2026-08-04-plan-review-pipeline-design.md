# Design: 方案评审管线(单强评审 + 分歧升级)

- Date: 2026-08-04
- Status: Draft
- Scope: M(评审 prompt 与流程设计;落地面为评审 agent prompt 与 workflow plan_review 评审指令,无新引擎)
- 关联文档:
  - `docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md` §8(评审质量背景与反锚定清单需求)
  - `docs/superpowers/specs/2026-08-04-proactive-subagent-delegation-design.md` §10(评审质量背景与反锚定清单需求)
  - `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`(方案 B 与 quality guardrail)
- design_author: 当前会话(用户确认方案 A)
- 用户决策:范围=仅方案评审(plan_review / autoplan 链);优先级=质量优先;结构=方案 A(单强评审 + 分歧升级)

## 1. 背景与动机

### 1.1 评审偏置(§8/§10 已记录,本设计直接引用)

[本仓库观测] deepseek-v4-flash 出稿 + gpt-5.6-sol 评审的 PASS 早于 claude-opus-5 出稿 + gpt-5.6-sol 评审。[推导] 三机制:

1. **攻击面偏置**:评审是「找错」任务,输出量随被评审内容丰富度膨胀;平庸草稿找不到足够的错 → 快速 PASS。
2. **遵从度不对称**:弱模型对 FAIL 意见顺从、收敛快;强模型抵抗、收敛慢。
3. **家族偏置**:judge 对自家家族输出更宽容、对竞争家族更挑剔([文献] Yang et al. 2026)。

**结论:PASS 早 ≠ 方案质量高;评审 PASS 是「内部一致性」信号,不是「最优性」信号。**

### 1.2 配置结论(调研与文献,§8.1 详录)

- 强草稿 + 强评审是开放质量类任务上限最高的配置(Self-Refine +20% absolute;CriticGPT 强评审有真实增量)。
- 弱草稿 + 强评审受草案覆盖度封顶(评审锚定在草案框架内)。
- 多模型并行投票在开放任务上收益有限且放大噪音(评审 precision <17%,SWaB)。
- 评审-refine 循环 1-2 轮封顶,收益递减。

### 1.3 需求来源

用户确认:质量优先;落地反锚定清单(§8.2/§10.2 五项必做);产出可实现的评审管线设计。

## 2. 目标与范围

**目标**:方案评审(plan_review 门禁 + autoplan 评审链)的评审环节防偏置、规格锚定、质量优先。

**范围内**:
- 方案/设计文档评审(plan_review、autoplan 的多评审 skill 链、主动委派链的 plan→review 阶段)
- 评审 prompt 模板与流程(模型选型、分歧升级、PASS 判定)

**范围外**:
- 代码评审(code_review)不在本设计内(用户限定仅方案评审)。
- 不新增评审引擎;复用既有 workflow 门禁、finding dedupe、provider attestation、receipt 途径。

## 3. 架构:三层

```
[生成层]  claude-opus-5:xhigh  →  方案草稿(强草稿)
              ↓
[评审层]  gpt-5.6-sol:xhigh  →  单评审(异家族)
              │  反锚定清单 + 规格锚定 FAIL + PASS 证据密度
              ↓
         PASS ──→ 终稿
         FAIL ──→ 草稿作者 refine(1-2 轮封顶)──→ 同评审复审
              ↓ 分歧触发
[仲裁层]  claude-opus-5:xhigh  →  独立干净上下文仲裁(终判)
```

## 4. 核心组件与规则

### 4.1 评审模型选型(固定)

| 层 | 模型 | 依据 |
|---|---|---|
| 生成 | `claude-opus-5:xhigh` | 强草稿 = 开放任务上限最高;覆盖度高,评审锚定天花板被抬到强模型自身上限 |
| 评审 | `gpt-5.6-sol:xhigh` | 异家族于生成(消自偏好);竞争家族偏置方向 = 偏严,质量优先下可接受且被规格锚定约束;无外部数据裁决 sol vs opus-5 谁评审更好([INFERENCE] 同级,只能 A/B),选 sol 因与生成异家族 |
| 仲裁 | `claude-opus-5:xhigh` | 第二强模型、独立干净上下文;与评审异家族,互为制衡 |

**家族偏置补偿规则**:
- 生成=opus-5 → 评审=sol(异家族 ✓)。
- 生成=flash(成本场景,autoplan 部分路径)→ 评审**仍用 sol**:反锚定清单兜住攻击面偏置,且无 claude 竞争关系,家族偏置最小。
- 生成=sol(未来若出现)→ 评审换 opus-5(异家族规则),仲裁换第三个强模型或人工。

### 4.2 反锚定清单(评审 prompt 必含,统一注入)

适用对象:`packages/coding-agent/src/prompts/workflow/plan-reviewer.md`、`.omp/agents/sol-xhigh-reviewer.md`、autoplan 评审 skill 指令。五项必做:

1. **反锚定清单**:显式列出「草案**未覆盖**的约束、风险、备选方向」,不只对照草案找错。
2. **规格锚定 FAIL**:每个 FAIL/NEEDS_REVISION 意见必须引用被违反的具体规格条目(如「违反 §X 的第 Y 条」);禁止无规格依据的泛泛意见。
3. **PASS 判定标准**:PASS 基于逐条核对规格清单,而非「没找到足够的错」;结论附证据密度(核对条目数、提出问题的具体条目数)。
4. **收敛控制**:评审-refine 循环 1-2 轮封顶;分歧/高风险样本升级仲裁,不在草稿作者处反复打磨。
5. **可验证维度走客观检查**:测试/lint/规格 check 是客观锚点,LLM 评审只负责开放维度。

### 4.3 分歧检测与仲裁

**仲裁触发条件**(任一):
1. 评审输出自相矛盾(同一意见前后冲突);
2. 评审 PASS 但反锚定清单全空(可疑通过);
3. 评审关键意见与草稿作者核心判断冲突且作者明确拒绝,双方各执一词。

**仲裁规则**:
- 独立干净上下文(新 subagent,不含评审对话历史——遵循「独立性 = 干净上下文的新 review」定义,决定 A);
- 输入 = 草稿 + 规格清单 + 评审意见 + 作者反驳;
- 终判 PASS/FAIL,附证据;仲裁结论不可再被评审推翻(终判)。

### 4.4 receipt 与测量

每轮评审记录(进 routing audit / session 现有途径):
- 反锚定清单条目数(评审列出的「未覆盖维度」数);
- FAIL 意见的规格引用数(无引用 = 无效意见,不计数不阻塞);
- PASS 证据密度(核对的规格条目数);
- 仲裁推翻率(仲裁推翻评审结论的比例——管线健康度信号,过高说明评审偏置未消除)。

## 5. 数据流(单次完整流程)

```
草稿(opu-5) + 规格清单
   → sol 评审(反锚定清单 + 规格锚定)
   → PASS(附证据密度) → 终稿
   → FAIL(附规格引用意见) → 作者 refine
       → 复审(同 sol)
       → 仍 FAIL:
           → 分歧触发 → opus-5 仲裁 → 终判
           → 无分歧(意见被合理吸收)→ 继续 refine,至 2 轮封顶后必进仲裁
```

## 6. 错误处理与边界

| 情况 | 处理 |
|---|---|
| 评审 PASS 但反锚定清单全空 | 强制仲裁(不直接放行) |
| FAIL 意见无规格引用 | 视为无效意见,不计入阻塞 |
| 评审意见自相矛盾 | 触发仲裁 |
| 2 轮 refine 后仍 FAIL | 必进仲裁,不无限循环 |
| 评审模型不可用(路由/配额) | 降级:评审层退到 `opus-5:xhigh`(同族自偏好风险被反锚定清单部分对冲),receipt 标记 degraded;不静默放行 |
| 规格清单缺失 | 评审降级为「对照需求文档」,receipt 标记 missing-spec;若连需求文档都无,强制仲裁 |

## 7. 验收指标

- **反锚定清单遵守率**:评审输出含「未覆盖维度」条目的比例(目标 ≥90%)。
- **PASS 证据密度**:PASS 结论附核对规格条目数(目标:平均 ≥ 规格条目数 80%)。
- **与人工裁决一致率**:抽样 A/B,目标 ≥ 单评审现状基线(建立基线后对比)。
- **仲裁推翻率**:仲裁推翻评审的比例(健康区间 5-25%;<5% 说明仲裁冗余,>25% 说明评审偏置未消除)。
- **收敛轮数**:PASS 前平均 refine 轮数 ≤2。

## 8. 落地清单(实现阶段,不在本设计实现)

1. `packages/coding-agent/src/prompts/workflow/plan-reviewer.md` — 注入 §4.2 反锚定清单 + 规格锚定 FAIL 规则;
2. `.omp/agents/sol-xhigh-reviewer.md` — 评审 agent 指令注入 §4.2(含「独立干净上下文」要求);
3. autoplan 评审 skill 指令 — 注入 §4.2,并把评审输出 schema 扩展「未覆盖维度 / 规格引用 / 证据密度」字段;
4. 分歧检测 — 复用现有 finding/verdict 汇合点,实现 §4.3 三触发条件;
5. 仲裁 agent — 新增或复用 opus-5 评审 agent(独立上下文);
6. receipt — 扩展 §4.4 字段到 routing audit 现有途径;
7. 测试 — prompt 渲染断言(清单五项存在)、分歧触发单元测试、receipt 字段完整性。

## 9. 与既有文档的关系

- §8(2026-08-03-latency-defaults-gaps-design.md)与 §10(2026-08-04-proactive-subagent-delegation-design.md)的需求 → 本设计为**落地形态**;
- 本设计在延迟/委派两文档中作为 §8.3/§10.3 的「已定方案」指针;
- 质量守卫沿用 long-session 设计 §6.4(完成率/独立 review/确定性 verifier 不劣化 >2pp、返工不上升 >10%)。
