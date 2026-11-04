# Latency All-Arms Default-On Code Review

- Date: 2026-08-07
- Design input: `docs/superpowers/plans/2026-08-04-latency-tier1-fix-and-profile-design.md`
- Implementation / acceptance input: `docs/superpowers/plans/2026-08-05-latency-tier1-fix-acceptance.md`
- Reviewed commits: `35463a4c31`, `11d9778a45`
- Scope: `modelOptimization.enabled` plus all eight `latency.arms.*` defaults, runtime guards, quality-stop wiring, attribution, and existing live evidence

## Final verdict

**NEEDS_FIX**

It is not currently possible to confirm that enabling every arm by default will avoid materially reducing agent task-completion quality. The code-level guards and 703 passing tests establish implementation correctness and fail-open/fail-closed behavior, but they do not satisfy the design's rollout-quality gate. Production quality stops are not wired, the all-arm combination is neither registered nor persisted for attribution, and the behavior-changing arms lack single-arm paired quality evidence.

## Evidence summary

- The design says the implementation gate passed while benefit and live-correctness gates had not passed; it requires clean-context, non-overlapping, same-task A/B runs and at least 30 comparable pairs per arm.
- The only paired pilot has six Luna pairs. It observed no pass-rate drop, but `readDedupe` and `bashAdvisory` did not activate in those pairs, so it mainly supports the custom Luna context-optimization treatment.
- The later provider-backed optimized workflow is a single-variant path proof. The acceptance document explicitly calls its gate inconclusive; baseline runs remained model-variance-sensitive.
- `modelOptimization.enabled` affects ordinary sessions, while the live workflow proof uses independent workflow profiles and cannot establish ordinary-session quality.
- The current default profiles can materially reduce model-visible evidence: DeepSeek limits bash output to 1,500 bytes / 30 lines and keeps five recent tool calls; Sol limits to 2,000 bytes / 40 lines and keeps eight. Raw artifacts make the transform reversible, but task quality still depends on the model noticing and retrieving recovery references.

## Design consistency

The implementation deviates from the reviewed rollout design in three material ways:

1. The design requires independent arms and pre-registered combinations; current default sessions enable all nine arms without `combinedArmId` or `childArms`.
2. The design requires at least 30 pairs per arm before formal promotion; most arms have contract/integration evidence only.
3. The design's risk register explicitly avoided changing the schema default to on before quality evidence existed; commit `11d9778a45` flips every arm to true.

## Findings

### [HIGH] Rollout safety: production quality stops are not wired

**File**: `packages/coding-agent/src/latency/arms.ts:125-163`; `docs/superpowers/plans/2026-08-05-latency-tier1-fix-acceptance.md:133`

**Problem**: `evaluateLatencyQualityStop` has no production callsite; search finds only unit tests. It evaluates P0/P1, attribution, completion, and rework, but not the declared cost P50/P95, latency, or spawned-agent thresholds. The acceptance document describes monitored rollback, but no runtime owner consumes cohort metrics and disables an arm.

**Impact**: A quality regression can continue under globally default-on settings with no automatic stop or attributable rollback. “Guarded rollout” is currently documentation, not enforced behavior.

**Recommendation**: Feed production cohort metrics into a persisted rollout decision, cover all documented thresholds, and define an actual configuration/feature-flag rollback owner before globally defaulting behavior-changing arms on.

### [HIGH] Attribution: the default all-arm combination is neither registered nor persisted

**File**: `packages/coding-agent/src/session/agent-session.ts:4667-4678`; `packages/coding-agent/src/latency/arms.ts:41-118`

**Problem**: `AgentSession.#ensureLatencyArmSnapshot` supplies only `getSetting`. With all defaults true, the frozen snapshot contains nine active arms but no `combinedArmId` or exhaustive `childArms`; there is no production consumer that persists this combination receipt.

**Impact**: Any completion, cost, or quality regression is unattributed. The stop evaluator itself treats unknown attribution as a stop, so the current all-on state conflicts with its own safety contract.

**Recommendation**: Either restore independent defaults and promote arms one at a time, or register and durably persist an explicit all-arm combination with complete child-arm, code-revision, config-hash, and cohort metadata.

### [HIGH] Evidence mismatch: workflow proof does not validate ordinary-session optimization

**File**: `packages/coding-agent/src/config/settings-schema.ts:4510-4520`; `packages/coding-agent/src/model-optimization/default-profiles.ts:14-148`; `docs/superpowers/plans/2026-08-05-latency-tier1-fix-acceptance.md:109`

**Problem**: The acceptance table cites the live optimized workflow for `modelOptimization.enabled`, but workflow profiles are explicitly independent. The six-pair pilot used a Luna-only custom profile and had no context-only ablation. No paired task-quality evidence covers the shipped Claude, GPT-5, Grok, GLM, DeepSeek, Luna, Terra, or Sol ordinary-session profiles.

**Impact**: Global ordinary sessions can receive aggressive evidence truncation and history reduction without proof that completion or rework stays within the stop thresholds for each model family.

**Recommendation**: Restrict default-on to a proven Luna cohort or restore the global default to false until each enabled family passes paired ordinary-session quality runs.

### [HIGH] Quality-changing arms lack paired task outcomes

**File**: `packages/coding-agent/src/model-optimization/runtime-policy.ts:93-120`; `packages/coding-agent/src/workflow/engine.ts:1129-1130,2121-2218`

**Problem**: `contextBudgetTuning` reduces Luna target utilization from 0.75 to 0.70 and tool history from 10 calls to 8; `roleStaticSplit` can route repair to Flash; concurrency declarations can alter write execution or fail closed on invalid supplied declarations. Their evidence is contract/integration coverage, not paired task outcomes.

**Impact**: These arms can omit model-visible evidence, change model quality, change execution ordering, or block workflows. Unit correctness does not establish task completion quality.

**Recommendation**: Keep `contextBudgetTuning`, `roleStaticSplit`, `concurrencyDeclaration`, and `concurrencyExecution` default-off until their dedicated paired matrices pass.

### [MEDIUM] Eval migration is default-on but does not deliver migration benefit

**File**: `packages/coding-agent/src/tools/eval.ts:409-446`

**Problem**: Without a proven parity receipt, bridge control remains. Even with a proven receipt, the notice states that the bridge is retained until native-owner cutover.

**Impact**: Default-on currently adds a notice but does not realize the claimed native migration/overlap benefit. Quality risk is low; benefit is also effectively zero.

**Recommendation**: Keep it on only as an inert guarded flag, or leave it off until a real native cutover and parity/cancel-resume live proof exist.

## Arm-level interim decision

| Arm | Current evidence | Interim recommendation |
|---|---|---|
| `modelOptimization.enabled` | Six Luna pairs; ordinary multi-family matrix missing | Restrict to Luna cohort or default-off globally |
| `readDedupe` | SHA/artifact verification, fail-open paths, provider-backed rewrite smoke | May remain on in a monitored cohort; still needs paired task quality |
| `bashAdvisory` | Real BashTool/git integration; never blocks execution | Low-risk candidate to remain on |
| `bashBoundedInjection` | Bounded repeat-failure injection integration | Low-risk candidate to remain on with context-size monitoring |
| `contextBudgetTuning` | Policy application tests only | Default-off pending long-session pairs |
| `roleStaticSplit` | One routing contract; no repair-quality comparison | Default-off pending false-positive and repair-quality pairs |
| `concurrencyDeclaration` | Strict validation tests | Default-off until compatibility/live DAG coverage |
| `concurrencyExecution` | Engine wave and merge tests | Default-off until independent/dependent/cancel-resume quality pairs |
| `evalGateMigration` | Fails closed to bridge; no real cutover | Safe but inert; no optimization claim yet |

## Remaining verification matrix

1. **Wire rollout enforcement first**
   - Persist cohort, arm combination, code revision, config hash, and attribution.
   - Evaluate P0/P1 escapes, completion drop, rework rise, cost P50/P95, latency improvement, and spawned-agent P95.
   - Exercise and record an actual rollback drill.

2. **Single-arm clean-context pairs: at least 30 per arm**
   - Same task, model, fixture, and availability; counterbalanced control/treatment order; non-overlapping runs.
   - Require a treatment receipt proving the arm actually fired. “Enabled but inactive” does not count.
   - Stratify hidden tasks across bug fix, feature, multi-file refactor, research plan, review, long session, tool-heavy, schema-heavy, and permission-safety categories.

3. **Ordinary-session model matrix**
   - Luna, Terra, Sol, Grok, DeepSeek, Claude, GLM, and GPT-5.
   - Assert completion/first-pass/rework plus recovery-artifact use after truncation.
   - Add long-context runs at 100k, 200k, and near compaction thresholds.

4. **Arm-specific quality cases**
   - `readDedupe`: same selector, changed selector, edit between reads, branch/model/session switch, and explicit artifact recovery.
   - Bash arms: identical failure, changed worktree/env/timeout/PTY, user-requested rerun, cancellation, async completion, and no false advisory.
   - `contextBudgetTuning`: required evidence older than 8 tool calls, recovery after eviction, and compaction interaction.
   - `roleStaticSplit`: mechanical and deliberately non-mechanical repairs; measure false-positive routing and compare Flash with the strong route.
   - Concurrency: independent writes, overlapping paths, dependencies, merge conflicts, cancellation/resume, crash recovery, and final-diff equality against serial control.
   - Eval: real proven parity receipt, native/bridge output equality, cancellation/resume, and overlap ownership.

5. **Combination and canary validation**
   - Pairwise tests for context optimization + read dedupe + budget tuning, and role split + concurrency.
   - At least 30 paired all-on combinations after single-arm gates pass; use 100+ tasks for a formal promotion claim.
   - Run a 5-10% cohort for 7-14 days with immediate stop-rule rollback.

## Handoff

**Same-session continuation**:

直接执行 $fix-implement 或 /fix-implement

**New-session recovery prompt**:

```
请阅读实现文档 docs/superpowers/plans/2026-08-05-latency-tier1-fix-acceptance.md、
审查文档 docs/superpowers/plans/2026-08-07-latency-all-arms-default-on-code-review.md，
以及本次代码变更，
使用 $fix-implement（或 /fix-implement）进行方案修复及代码实现。
重点修复 HIGH-1：在未达到逐 arm ≥30 对与组合质量门、且质量 stop 未接入生产执行前，全部 latency arms 默认开启无法证明不会降低 agent 任务完成质量。
```

---

## 修复记录（2026-08-07 HIGH-1 修复）

### 修复摘要

HIGH-1 已按审查文档的 arm 级 interim 建议修复，方向为「恢复基于证据的独立默认值 + 把质量 stop 接入生产执行」：

1. **恢复默认值（决定性修复）**：`11d9778a45` 的全开默认被回退为仅低风险 fail-open 的 bash 对默认开启，其余行为改变型 arm 默认关闭：

   | Arm | 默认值 | 依据 |
   |---|---|---|
   | `modelOptimization.enabled` | `false` | 无配对 ordinary-session 质量矩阵（审查 HIGH-3）；恢复全局默认 off |
   | `latency.arms.readDedupe` | `false` | 仍缺 paired task quality；仅在受监控 cohort 中允许开启 |
   | `latency.arms.contextBudgetTuning` | `false` | 待 long-session pairs |
   | `latency.arms.roleStaticSplit` | `false` | 待 false-positive 与 repair-quality pairs |
   | `latency.arms.bashAdvisory` | `true` | 低风险、永不阻断执行（A7/A8 真实 CLI 证据） |
   | `latency.arms.bashBoundedInjection` | `true` | 有界 payload、低风险 |
   | `latency.arms.concurrencyDeclaration` | `false` | 待兼容性/活 DAG 覆盖 |
   | `latency.arms.concurrencyExecution` | `false` | 待独立/依赖/取消-恢复质量对 |
   | `latency.arms.evalGateMigration` | `false` | 惰性守卫，真实 native cutover 前关闭 |

2. **质量 stop 接入生产执行**：`evaluateLatencyQualityStop` 不再只有单元测试调用点。
   - 评估器补全全部文档化阈值：新增 `cost_breach`（P50/P95 倍数）、`latency_miss`（提速不足）、`spawned_agents_breach`（P95 倍数）三个 stop reason，覆盖 `LATENCY_QUALITY_STOP` 全部阈值。
   - 新增 `deriveLatencyCombination`：≥2 arm 开启时确定性注册组合（`combined:<sorted ids>` + 完整 childArms），未注册的多 arm 状态由 stop 评估器 fail-closed（`missing_attribution`）。
   - 新增 `LatencyRolloutDecisionV1` + `buildLatencyRolloutDecision`：从 session-frozen 快照 + 运行证据生成可持久化的 rollout decision。
   - Session 快照冻结时携带 `codeRevision`（cwd 的 git HEAD）+ `configHash`（arm settings 哈希）+ 自动组合注册（`agent-session.ts #ensureLatencyArmSnapshot`）。
   - Workflow engine 在 terminal 完成时持久化 `latency-rollout-decision` artifact；stop 触发时通过 `session.settings.override` 关闭因果 arm（配置/feature-flag 回滚 owner 落地为真实执行，`engine.ts #evaluateLatencyRolloutAtTerminal`）。
   - `ToolSession` 新增 `getLatencyArmSnapshot?`（sdk.ts 接 session 冻结快照）。

### 保留项（有理有据未在本轮修复）

- **≥30 对逐 arm 配对矩阵**：这是验证工作，不是代码缺陷；本轮把未达标 arm 恢复默认 off，使「未验证 arm 不再全局开启」成为事实。配对矩阵（审查矩阵第 2/3/4 项）仍待后续 A/B 运行。
- **cohort 聚合消费**：`buildLatencyRolloutDecision` 的 cohort 输入（completionDropPp/reworkRisePct/cost/latency/spawned 倍数）已由评估器覆盖，但生产 callsite 按单次运行能观测到的证据求值（attribution + P0/P1 + completion/rework/cost/latency 观测值）；P50/P95 聚合仍需 cohort 聚合器（审查矩阵第 1 项）。
- **MEDIUM（eval 迁移无收益）**：默认关闭即采纳「leave it off until a real native cutover」建议，无需其他代码改动。

### 验证结果

- 定向测试 29/29（contracts/read-dedupe/profile-resolver/engine-latency-rollout）。
- 全量回归：`test/latency` + `test/model-optimization` + `test/session` + `test/workflow` = **849 pass / 0 fail**（含新增 engine rollout 集成测试 2 条）。
- `bun check`（biome + tsgo）通过；`bun run build` 通过。

### 剩余风险 / 下一轮重点检查范围

1. 生产 callsite 目前只对单次运行可求值的 stop 生效（attribution + P0/P1 zero-tolerance + 观测值记录）；cost/latency/spawned 的 P50/P95 阈值需要 cohort 聚合器喂入 `cohort` 输入后才真正触发。
2. 逐 arm ≥30 对矩阵与 ordinary-session 多 family 矩阵仍未跑；通过前相关 arm 保持默认 off。
3. 建议下一轮检查：
   - 审查 `engine.ts #evaluateLatencyRolloutAtTerminal` 的失败路径（bookkeeping 永不阻断 workflow 完成）。
   - 确认 `settings.override` 回滚在真实 CLI 会话中的行为（当前仅集成测试覆盖）。
   - 跑一次真实 rollback drill（审查矩阵第 1 项）。

