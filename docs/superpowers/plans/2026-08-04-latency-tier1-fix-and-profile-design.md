# Latency Tier-1 Fix & Recommended Implementation Design

- Date: 2026-08-04
- Status: **ready for implementation handoff**
- Repo revision at write time: `c36dd14cbf76482806bb127679d7297e70e6c98a`
- Package scope: `packages/coding-agent/` (default)
- Authority chain:
  - Design A: `docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md`
  - Phase 0: `docs/superpowers/plans/2026-08-04-latency-phase0-baseline-receipt.md`
  - Implementation acceptance: `docs/superpowers/plans/2026-08-04-latency-implementation-acceptance.md`
  - Live pilot receipt: `docs/superpowers/plans/2026-08-04-latency-tier1-live-pilot-receipt.md`

---

## 0. One-line goal

把 live pilot 暴露出的 **3 个阻断点**修到可观测、可单测、可小流量启用：

1. bash 重复失败识别被 wall-time 噪声打穿  
2. read dedupe 在真实 ordinary session 路径未观察到 rewrite  
3. 生产常用模型（尤其 `gpt-5.6-luna` / gateway ids）没有 built-in optimization profile，导致 `modelOptimization.enabled=true` 空转  

**不改默认全局 on**；修完后仍 default-off，但 treatment 路径必须真生效。

---

## 1. Background（完整背景）

### 1.1 最近落地了什么（代码已在 mainline 附近）

最近 8 个 commit 的主线是 coding-agent 的 **latency arms + 超时护栏 + PlanReview V2**：

| 能力 | 开关 / 路径 | 默认 |
|---|---|---|
| 独立 latency arms 框架 | `packages/coding-agent/src/latency/*`，`latency.arms.*` | **全 false** |
| 上下文优化 | `modelOptimization.enabled` → ordinary tool-output optimize | false |
| 读去重 | `latency.arms.readDedupe`（依赖 modelOptimization active + profile） | false |
| bash 失败账本 / advisory | `latency.arms.bashAdvisory` / `bashBoundedInjection` | false |
| 并发声明/执行 | `latency.arms.concurrencyDeclaration` / `Execution` | false |
| 机械 Flash 路由 | `latency.arms.roleStaticSplit` | false |
| eval 迁移门控 | `latency.arms.evalGateMigration` | false |
| 子代理运行超时 | `task.maxRuntimeMs` | **1h** |
| 排队启动超时 | `task.queuedStartupTimeoutMs` | **2m** |
| PlanReview V2 | engine-owned trigger/receipt；模型伪造无效 | 代码路径 |

自动化验证（先前会话）：latency/task/plan-review 相关 **400+ tests pass**，`check:types` clean。  
**实现门禁过了；收益与 live 正确性门禁未过。**

### 1.2 设计约束（不可违反）

来自 Design A：

- arms **独立开关、session 冻结、可单独回滚**
- A/B 必须：同任务配对、clean-context、non-overlap、双账本
- pilot ≥30 对 / arm 才能正式宣称收益；本 handoff **不要求**一次做完 30 对
- fail-open：身份不全 → 不去重；ledger 异常 → 不挡 bash
- **禁止**自动 skip 用户明确要求的 bash rerun
- 不改 control 基线（`task.eager` / `batch` / `async` / compaction）来“制造”优化假象

### 1.3 Live pilot 做了什么

| 项 | 内容 |
|---|---|
| Pilot id | `latency-tier1-pilot-v2-profile-aware` |
| Model | `gateway/gpt-5.6-luna` |
| n | **6** comparable pairs（正式门槛 30，故仅 pilot） |
| Control | 全部 arms false，无 profile |
| Treatment | `modelOptimization.enabled=true` + **显式 luna-pilot profile** + `readDedupe` + `bashAdvisory` |
| 质量 | exact `artifacts/answer.json` |
| 产物 | `/tmp/omp-latency-pilot/pairs_v2/` + pilot receipt 文档 |

### 1.4 Live 结果（v2）

| Metric | Median improve (treatment better) | Wins |
|---|---:|---:|
| Wall clock | **+29.2%** | 6/6 |
| Total tokens | **+50.8%** | 6/6 |
| Input tokens | **+63.6%** | 6/6 |
| Cost | **+55.0%** | 6/6 |
| Tool-result visible chars | **+95.6%** | 6/6 |
| Pass-rate drop | **0.0pp** | quality stop 未触发 |

Arm 归因：

| Arm | Live | 说明 |
|---|---|---|
| `context_optimization` | **生效** | 在显式 profile 下，read 从 ~28KB → ~1227B |
| `read_dedupe` | **未观察到** | 二次 full read 无 `[context ref: artifact://…]` |
| `bash_advisory` | **未观察到** | 连续两次 `false` 无 ledger notice |

### 1.5 已证实的根因 / 高置信推断

#### P0 — bash failure fingerprint 被 wall-time 污染（**已 unit 复现**）

路径：`packages/coding-agent/src/tools/bash.ts` → `#recordBashAttempt`  
→ `buildBashFailureExcerpt` / `buildBashFailureFingerprint`（`src/latency/bash-attempt-ledger.ts`）

现状：bash 结果文本常含：

```text
Wall time: 0.03 seconds
Wall time: 0.00 seconds
```

`normalizeBashFailureExcerpt` **不剥离**这些行；指纹把 excerpt 算进去。  
本地复现：`0.03` vs `0.00` → **fingerprint 不同** → `lookupRepeatedBashFailure` 永不 hit → advisory 永不出现。

这是 **确定性逻辑 bug**，不是“样本不够”。

#### P0 — 生产模型缺 built-in optimization profile（**已代码核实**）

`packages/coding-agent/src/model-optimization/default-profiles.ts` 仅：

- `claude`, `gpt-5`, `grok`, `glm`, `deepseek`

主机常用：

- `gateway/gpt-5.6-luna`（smol/task 等）
- `gateway/grok-4.5`（default role；grok pattern 可能部分覆盖，但 gateway 前缀/变体需确认）
- `gateway/gpt-5.6-terra` / `sol` 等

`#optimizeOrdinaryToolResult` 要求：

```text
latencyArms.context_optimization
AND activeModelOptimization.profile !== undefined
```

因此：**只开 `modelOptimization.enabled` 对 luna 经常是 no-op。**  
v1 pilot 因此无效；v2 靠 overlay 注入 `luna-pilot` 才测到截断收益。

#### P1 — read dedupe live 未 rewrite（**观察 + 代码路径风险**）

路径：

1. `tools/read.ts` `attachReadIdentity` 生产  
   `canonicalSource` / `branchOrWorktreeScope` / `providerViewIdentity` / `contentOrRevisionIdentity` / `outputMode`
2. `agent-session.ts` `#dedupeOrdinaryReadResult` 读 `ctx.result.details` 建 `ReadViewKey`
3. 命中且 artifact 校验通过 → 模型可见文本改为  
   `[context ref: artifact://… sha256:…]`

Live 现象：

- session 目录里 **有** `*.read.log` 全量 artifact → save 通路可用  
- 模型可见二次 read **仍是截断正文**，不是 context ref  
- print-mode JSONL 的 tool details 常只剩 `displayContent`/`meta`，**看不到 identity 字段**（可能是序列化裁剪，不必然等于内部 details 丢失）

高置信风险点（实现时按序证伪）：

1. **details 在 after-tool-call 前被剥掉 / 未传入 ctx.result.details**  
2. identity 字段未进入 `ctx.result.details`（TUI/print 包装替换了 details）  
3. `ReadViewKey` ineligible → fail-open（git scope / providerView / content hash 任一空）  
4. **先 truncation 再 dedupe**：第二次用 truncated text 算 hash / 或 artifact verify 用 full vs visible 不一致  
5. `--no-session` 影响 artifact id 稳定或 verify（sessioned probe 仍无 ref，故不是唯一原因）  
6. read 第二次 args/selector 归一化不一致 → key 不同

**实现原则：** 先写 **最小可失败单测** 钉住 “同 view 第二次 → context ref”，再改代码；禁止只改注释/日志宣称修好。

---

## 2. Non-goals（本轮不做）

- 不把任何 latency arm 改成 **schema default true**
- 不做 ≥30 对正式 A/B 全量（可保留/复用 harness，但非必须交付）
- 不实现 concurrency / eval migration / roleStaticSplit 新功能
- 不改 PlanReview V2 行为
- 不改超时默认值语义（1h / 2m）除非发现回归
- 不引入第二套 ledger / 第二套 dedupe 键空间
- 不为了去重改变 read 工具对外 I/O 契约（dedupe 只影响 **模型可见注入**，不改变工具“读到的真实内容”语义；artifact 必须可恢复）

---

## 3. Recommended implementation plan（按步骤）

### Step 0 — 固定基线与验收口径

**验收（本 handoff 完成定义）：**

| ID | 验收项 | 证据 |
|---|---|---|
| A1 | 两次相同失败 bash（仅 wall-time 不同）→ 同一 failureFingerprint → advisory 文本出现 | unit + 可选 live 1-shot |
| A2 | ordinary session：同一文件连续两次 full read，第二次模型可见为 `context ref`（在 arms+profile 开启时） | unit/integration 必过；live 1-shot 推荐 |
| A3 | `gateway/gpt-5.6-luna`（及文档列出的 gateway 常用 id）在 enabled=true 时能 resolve 到 profile，无需用户手写 overlay | unit on profile-resolver |
| A4 | arms 默认仍全 false；关闭开关行为与 baseline 一致 | contracts tests |
| A5 | `bun test` 相关套件 + `bun run check:types` 通过 | CI 本地命令 |

### Step 1 — Fix bash failure fingerprint noise（P0）

**文件：**

- `packages/coding-agent/src/latency/bash-attempt-ledger.ts`
- `packages/coding-agent/test/latency/bash-attempt-ledger.test.ts`
- 如有需要：`packages/coding-agent/src/tools/bash.ts`（仅当 notice 拼接/时序有 bug）

**设计：**

1. 扩展 `normalizeBashFailureExcerpt`（或新增 `stripBashEphemeralNoise`）：
   - 去掉 `Wall time: …` 行（大小写不敏感，允许毫秒/秒）
   - 可选：去掉纯空的 `(no output)` 保留与否需与现网一致；优先 **稳定** 而非更短
   - 已有：ISO 时间戳 / UUID / 长数字 归一
2. **不要** 把成功 exit 0 或 cancelled 算 failure（保持现状）
3. Fingerprint 输入顺序保持：`terminal + normalized excerpt`
4. 对 “exitCode=1 + 空输出 + 不同 wall time” 必须 fingerprint 相等

**测试（必写）：**

```ts
// 伪代码意图
const a = buildBashFailureFingerprint({
  terminal: { kind: "exit", exitCode: 1 },
  stdoutExcerpt: "(no output)\n\nWall time: 0.03 seconds\n\nCommand exited with code 1",
});
const b = buildBashFailureFingerprint({
  terminal: { kind: "exit", exitCode: 1 },
  stdoutExcerpt: "(no output)\n\nWall time: 0.00 seconds\n\nCommand exited with code 1",
});
expect(a).toBe(b);
expect(a).not.toBeNull();
```

再加：`lookupRepeatedBashFailure` 在第二次 append 后 `repeatedFailure===true` 且 `advisoryText` 非空（mode=advisory）。

**回归：** cancel 仍 fingerprint=null；exit 0 仍 null。

### Step 2 — Fix / prove read dedupe ordinary path（P0/P1）

**文件（按排查序）：**

1. `packages/coding-agent/src/tools/read.ts` — identity 是否总是挂在 `details`
2. `packages/coding-agent/src/session/agent-session.ts` — `#optimizeOrdinaryToolResult` / `#dedupeOrdinaryReadResult`
3. tool result 包装/序列化路径（print mode / ExtensionToolWrapper / afterToolCall ctx 构造）
4. `packages/coding-agent/src/latency/read-view-key.ts`
5. tests：
   - `test/latency/read-dedupe.test.ts`
   - `test/latency/read-identity-production.test.ts`
   - **新增** ordinary-session integration：两次 read → 第二次 content 为 context ref

**推荐修复策略（选最小充分集）：**

1. **保证 afterToolCall 的 `ctx.result.details` 含 identity 字段**  
   - 若 print/TUI 层 strip details：内部 dedupe 仍必须读原始 details  
   - 或把 identity 同步进 dedupe 所需的稳定通道（不要只靠 displayContent）
2. **dedupe 的 content hash 以“逻辑全文”为准**  
   - 优先：identity 里的 `contentOrRevisionIdentity`（read 工具已对返回文本 hash）  
   - artifact 保存：应保存 **用于恢复的权威文本**（建议 full original before truncation，或与 immutableSha256 一致的那份）  
   - 第二次命中时：用 key+immutableSha256 校验 artifact，**不要**要求 visible truncated text 相等
3. 第一次 read：eligible → save artifact → map.set(key, ref) → 仍返回（可截断后的）visible  
4. 第二次 read：key hit + verify → **仅改模型可见 content** 为  
   `[context ref: ${artifactRef} sha256:${immutableSha256}]`  
   可附一行短说明，但保持可解析前缀稳定（已有测试/调用方若依赖前缀，勿随意改）
5. fail-open 保持：任何 verify 失败 → 返回可见文本，不抛

**调试探针（实现中允许临时，提交前删或变 test-only）：**

- 记录：eligible? failOpenReasons? key? mapHit? verifyOk?  
- 禁止在用户默认日志刷屏；用 debug logger

**测试矩阵：**

| Case | 期望 |
|---|---|
| arms off | 两次 full text（或仅 truncation off 的 full） |
| opt+profile on, dedupe off | 可截断，无 context ref |
| opt+profile+dedupe on, 同 path 两次 full | 第 2 次 context ref |
| 不同 offset/limit | 不去重 |
| 文件变更（content hash 变） | 不去重旧 ref |
| identity 缺字段 | fail-open 不去重 |

### Step 3 — Built-in profiles for production gateway models（P0 产品化）

**文件：**

- `packages/coding-agent/src/model-optimization/default-profiles.ts`
- `packages/coding-agent/src/model-optimization/profile-resolver.ts`（仅当匹配规则不够）
- tests：profile resolve for `gateway/gpt-5.6-luna`, `gpt-5.6-luna`, 以及 repo 主机 config 中出现的角色模型

**推荐 profile 策略（保守）：**

不要发明未验证的 prompt overlay；**先给 toolStrategy + contextStrategy 基线**（与 deepseek/glm 类似：截断开、summarizer 关）。

建议新增或扩展 pattern（名称可调整，但要稳定 id）：

| id | modelPattern（示例） | 备注 |
|---|---|---|
| `luna` | `*luna*`, `gpt-5.6-luna`, `gateway/gpt-5.6-luna` | 主机 smol/task 高频 |
| `terra` | `*terra*`, `gpt-5.6-terra`, `gateway/gpt-5.6-terra` | plan/designer 等 |
| `sol` | `*sol*`, `gpt-5.6-sol`, `gateway/gpt-5.6-sol` | slow/review 等；**截断可更保守** |
| `grok` | 确认覆盖 `gateway/grok-4.5`, `grok-4.5*` | 已有 grok profile，补 pattern |

优先级：

- built-in priority 保持 0  
- 用户同 id 覆盖仍生效  
- 多 profile 同优先级命中 → 现有 **fail closed（ambiguous → no profile）** 必须避免：pattern 要互斥或提高更具体 id 的 priority

**截断默认值（建议起点，可按模型微调）：**

- read: maxBytes 4–6KB 或沿用 gpt-5/deepseek 档  
- bash/grep: 现有 default-profiles 规则  
- **禁止** 默认打开 resultSummarization LLM

### Step 4 — Settings / overlay ergonomics（P2，可选但便宜）

- 文档化：`modelOptimization.enabled` **不等于** 一定有 profile  
- CHANGELOG 写清：新增 luna/terra/sol patterns；bash fingerprint fix；dedupe live fix  
- 可选：settings UI description 补一句 “requires matching profile”

### Step 5 — Verification commands（实现会话必跑）

在 `packages/coding-agent/`：

```bash
# 1) targeted
bun test test/latency
bun test test/latency/bash-attempt-ledger.test.ts test/latency/read-dedupe.test.ts test/latency/read-identity-production.test.ts

# 2) session/model optimization if touched
bun test test/model-optimization

# 3) types
bun run check:types

# 4) optional live 1-shot smoke (credentialed; do not claim n=30)
# 使用与 pilot 相同 fixture 思路：两次 false、两次 full read，断言 JSONL/可见文本
```

**Live 1-shot 最小断言（推荐）：**

1. treatment config：enabled+profile+dedupe+bashAdvisory  
2. 第二次 `false` 的 tool 可见文本或 notice 含 ledger/advisory 关键词  
3. 第二次 full read 可见文本匹配 `/context ref: artifact:\/\//`  
4. control 同任务无上述信号  

### Step 6 — Docs / receipt 更新

实现完成后更新：

- `packages/coding-agent/CHANGELOG.md`（Added/Fixed，不写未证明的小时级收益）  
- `docs/superpowers/plans/2026-08-04-latency-tier1-live-pilot-receipt.md` 末尾加 “Follow-up implementation status” 或新写  
  `docs/superpowers/plans/2026-08-0x-latency-tier1-fix-acceptance.md`  
- **禁止** 在未跑 ≥30 对前写 “已证明默认开启可省 XX%”

---

## 4. Concrete code anchors（实现时从这里读）

| 主题 | Path |
|---|---|
| Arms freeze | `src/latency/arms.ts` |
| Bash ledger + fingerprint | `src/latency/bash-attempt-ledger.ts` |
| Bash record/advisory | `src/tools/bash.ts` `#recordBashAttempt` |
| Read identity | `src/tools/read.ts` `attachReadIdentity` |
| Read view key | `src/latency/read-view-key.ts` |
| Ordinary optimize + dedupe | `src/session/agent-session.ts` `#optimizeOrdinaryToolResult` `#dedupeOrdinaryReadResult` |
| Default profiles | `src/model-optimization/default-profiles.ts` |
| Profile resolve | `src/model-optimization/profile-resolver.ts` |
| Settings schema | `src/config/settings-schema.ts` `latency.arms.*` / `modelOptimization.*` |
| Pilot receipt | `docs/superpowers/plans/2026-08-04-latency-tier1-live-pilot-receipt.md` |

---

## 5. Implementation order（强制）

```text
1. bash fingerprint normalize + tests          # 最快、根因已钉死
2. profile patterns for luna/terra/sol/grok    # 解锁 enabled=true 真生效
3. read dedupe path proof test (fail first)    # 红灯
4. fix details/identity/hash/artifact wiring   # 绿灯
5. changelog + short acceptance note
6. optional live 1-shot smoke
```

不要先做大而全重构；不要合并进 concurrency/eval 工作。

---

## 6. Risk register

| Risk | Mitigation |
|---|---|
| 去重误伤：文件已变仍 ref | content/revision identity + artifact sha 校验；fail-open |
| 截断过猛导致任务质量下降 | profile 默认保守；不改 schema default on |
| pattern 过宽导致 ambiguous no profile | 单测覆盖主机模型；冲突时提高具体 pattern priority |
| fingerprint 归一过猛导致不同错误被当成重复 | 只剥 ephemeral wall-time/ISO/UUID；保留 exit 与错误正文 |
| print-mode 观测不到 details | 测试走 session 内部断言 content，不只依赖 JSONL details |

---

## 7. Rollback

```yaml
modelOptimization.enabled: false
latency.arms.readDedupe: false
latency.arms.bashAdvisory: false
latency.arms.bashBoundedInjection: false
```

代码回滚：revert 本 handoff 相关 commit；arms 框架与超时护栏可保留。

---

## 8. Out-of-scope follow-ups（记下来别做进本 PR）

- ≥30 对 / ≥100 对正式 A/B  
- contextBudgetTuning 实验  
- concurrency declaration 默认启用  
- eval native migration cutover  
- Plan arbitrator 生产 profile 注册  
- 把 pilot harness 产品化进 repo（若要做，另开任务）

---

## 9. Short prompt for a new session（复制即用）

```text
按文档实现 latency tier-1 修复，不要扩大范围。

必读：
- docs/superpowers/plans/2026-08-04-latency-tier1-fix-and-profile-design.md
- docs/superpowers/plans/2026-08-04-latency-tier1-live-pilot-receipt.md
- docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md（约束）

范围：仅 packages/coding-agent/

按顺序做：
1) 修 bash failure fingerprint：剥离 Wall time 等 ephemeral 噪声，使两次 `false`（仅 wall-time 不同）指纹相同并触发 bashAdvisory；补单测。
2) 为 gateway/gpt-5.6-luna、terra、sol 及 grok gateway id 增加/补齐 built-in modelOptimization profiles（保守 tool 截断，不默认 LLM summarize）；保证 enabled=true 时能 resolve 到 profile；补 resolver 单测。
3) 先写失败单测证明 ordinary session 在 opt+profile+readDedupe 下“同一文件两次 full read → 第二次模型可见 context ref”；再修 read identity / afterToolCall details / artifact verify 路径直到绿灯。fail-open 保持。
4) 跑 bun test test/latency（及相关 model-optimization 测试）+ bun run check:types。
5) 更新 packages/coding-agent/CHANGELOG.md；可补短 acceptance 笔记。禁止把任何 latency arm 默认改为 true；禁止宣称未跑满 30 对的收益。

验收：A1 bash 重复失败 advisory；A2 read 第二次 context ref；A3 luna 等模型有 profile；A4 默认仍全 off；A5 测试与 types 通过。
```

---

## 10. Document history

| Date | Note |
|---|---|
| 2026-08-04 | Initial handoff from live pilot v2 + code path review |
