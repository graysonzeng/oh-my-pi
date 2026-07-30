# Implementation: Quality-Gated Multi-Model Optimization

- Date: 2026-07-30
- Design Doc: `docs/superpowers/specs/2026-07-30-quality-gated-multi-model-optimization-design.md`
- Review Doc: `docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-design-review.md`
- Status: Phase 0-2 Implemented; Short Live Paired A/B Passed (2×2)

## 1. 评审意见处理摘要

- 整体结论为 `PASS_WITH_NOTES`；核心架构与方案 C 保持不变。
- 采纳 MEDIUM-1：评审复核显示 unresolved paths 为 0。设计不再把“17 个 unresolved paths”当作事实，Phase 0 改为执行时探测并分类处理工作树状态。
- 采纳 MEDIUM-2：Phase 3 增加 judge calibration 前置门禁，包括 `Cohen's kappa >= 0.60`、至少 10% 分层随机人工盲审、全部 disagreement 与硬门禁边界样本复核。
- 采纳 MEDIUM-3：增加 `needs_explicit_completion.hbs.md` canonical overlay 示例，明确 shared contract 与 overlay 的边界、组装顺序、failure-feature 映射和 receipt 字段。
- 采纳 MEDIUM-4：增加版本化 token estimate 规则 `estimate:utf8_bytes_div_4_v1`，明确 provider facts、分桶 estimates、cache unknown 和不可恢复内容的边界。
- LOW-1 与 LOW-2 未纳入本次重点修订；它们不阻塞 Phase 0-2，分别保留到 few-shot 与 complexity gate 实施前细化。
- 第二轮建议部分采纳：增加 failure taxonomy 与 5-case overlay 门槛、硬门禁 calibration 100% 一致要求、确定性 hash 去重、Phase 1/2 次序、complexity gate 初始矩阵、fallback chain、成本子项、关键 role、过拟合及 provider/judge 漂移防护。
- 第二轮建议暂不采纳为合同：未经本地证据支持的行业收益百分比、固定 `essential tools <= 15`、未定义校准语义的 `confidence_score`。这些只能作为后续实验候选，不能成为生产默认值或验收事实。

## 2. 根因前提处理结论（按需）

- 适用性：不适用。
- 处理策略：沿用 `NOT_APPLICABLE`，修订事实边界后实施。
- 结论：本方案是架构深化，不依赖单一故障根因；Phase 0-2 已在事实边界和 shadow/gated 门禁下实现。

### 2.1 消费的根因评审结论

- `NOT_APPLICABLE`：评审确认无需故障式根因分析。
- 事实边界修订：2026-07-30 实测 `git diff --name-only --diff-filter=U | wc -l` 为 `0`；大量 staged A/M/D 用户改动不是 unresolved conflict。

### 2.2 本次修订的前提边界

- 已确认事实：当前没有 unresolved paths；仓库已有 policy compiler、prompt assembly、artifact receipts、stage handoff、structured repair 与 benchmark seam。
- 未确认假设：ContextLedger 与去重的净收益、prompt overlay 的真实质量收益、token estimate 与真实 tokenizer 的误差、judge calibration 对 model-card 稳定性的改善。
- 对实现的影响：所有新 lever 默认 shadow/gated；不得因 estimate、judge 分数或历史 model card 单独改变生产默认策略。

## 3. 采纳的设计修订

- §1.4、§2.1、§6.5：工作树状态改为运行时探测输入；unresolved paths 非空时停止并请求冲突处理授权，为空时保留用户改动并建立 baseline。
- §5.2.2：overlay 只追加经 held-out eval 证明的行为差异，不覆盖 shared contract；选择记录 failure feature、case IDs、版本和 policy fingerprint。
- §5.4.1：输入桶按实际 provider payload 的 UTF-8 bytes 估算，`tokens = Math.ceil(bytes / 4)`；provider 未给 cache counters 时保持 `unknown`。
- §6.3：judge calibration 与 acceptance eval 分离；programmatic verifier 始终优先，任何硬门禁分歧不能被总体 agreement 抵消。
- §5.2/§5.3：failure overlay 需同类至少 5 个独立真实可复现 case；确定性去重只接受字节等价 content hash 或相同 immutable artifact hash。
- §5.5/§5.6：补充 complexity gate 初始决策矩阵、实际 fallback chain、成本子项分解和 critical role 最小集合；同模型独立实例仍须击败 `single_session` baseline。
- §5.8/§5.9：provider/model/facts provenance 变化使 model card 回到 shadow；隔离调参/calibration/acceptance 集并监控 judge 长度/风格偏差。

## 4. 实现摘要

Phase 0-2 已按依赖顺序实现：

1. Phase 0 baseline：最终 HEAD 为 `e13a01e6d43e2a2c766ae254f4672c5bf690ceac`；unresolved paths 为 0；保留全部用户 unstaged/untracked 改动，未清理或回退无关文件。
2. Phase 1 typed context optimization：`WorkflowAgentRequest.contextEntries` 提供显式 typed 边界；只对 byte-identical attachment/reminder/skill/tool delta 去重；replaceable old tool result 仅在 session artifact 持久化及 SHA-256 读回验证成功后替换为 numeric `artifact://` ref。无 artifact store 或完整性失败时保留 inline 原文。
3. Phase 1 ContextLedger：记录 11 个版本化 bucket、`estimate:utf8_bytes_div_4_v1`、provider facts/unknown cache counters、artifact/handoff refs 与 context optimization receipts；production RuntimeAdapter 在 provider response 后合并 observed usage，engine 持久化 ledger artifact。
4. Phase 1 benchmark：默认 suite 固定为 30 cases × 每 variant 至少 5 repetitions；所有 30 个 descriptor 均能 materialize 独立 repo、执行配置 verifier 并进行 git scope 检查。Fake runtime 继续只验证管线并明确 `liveQualityUnknown=true`。
5. Phase 2 single-lever shadow：compiler active 必须同时有显式 supported `activeLever`；只允许 `tool_concurrency_ceiling` 或 `descriptor_placement` 映射到 ordinary runtime。没有 lever 时保持 shadow。
6. Phase 2 evidence gates：cache assembly 需要 observable provider facts；prompt overlay 需要至少 5 个独立 failure cases 与 held-out eval；tool catalog 需要 held-out tool-selection eval。即使 receipt eligible，缺 explicit rollout approval 也不应用。
7. Benchmark provenance：live CLI 必须显式 provider/model，并把二者写入每个 run fingerprint；fake fingerprint 保持 unknown/null。

实际涉及模块：

- `packages/coding-agent/src/model-policy/`
- `packages/coding-agent/src/model-optimization/`
- `packages/coding-agent/src/workflow/context-ledger.ts`
- `packages/coding-agent/src/workflow/policy-experiment.ts`
- `packages/coding-agent/src/workflow/runtime-invocation.ts`
- `packages/coding-agent/src/workflow/runtime-adapter.ts`
- `packages/coding-agent/src/workflow/benchmark/`
- 对应 `packages/coding-agent/test/model-policy/`、`test/model-optimization/` 与 `test/workflow/` 合同测试

## 5. 验证结果

- 工作树事实：HEAD `e13a01e6d43e2a2c766ae254f4672c5bf690ceac`（后续 feature commit `c3e5f0958` + 未提交 Phase 0-2 收尾）；`git diff --name-only --diff-filter=U` 无输出；保留用户改动，未清理/回退无关文件。
- 相关合同：聚焦 Phase 0-2 相关套件 `141 pass / 0 fail`（含 benchmark/live-runtime/context-ledger/policy-experiment/compiler/runtime-adapter）；live-runtime 另含早失败仍报告 scope 的合同。
- 静态检查：`packages/coding-agent` 的 `bun check` 通过（仅 fixtures 中故意保留的 template-curly 字符串警告）。
- 构建/安装：`bun run build` 通过；installed `~/.local/bin/omp` SHA-256 = `60e09dc2a3a598380e7e998460dabe11c38d23c7b2ca132110da22ea19237737`（与 dist 一致）。
- Native：`~/.omp/natives/17.1.8/pi_natives.darwin-arm64.node` SHA-256 = `6c79bfbd95a3626a038c5f21b4d00636a23e32c8480f2b3ff114821e16474c27`；含 `__piNativesV17_1_8` sentinel。
- Installed CLI：`omp/17.1.8`；`omp --smoke-test` → `smoke-test: ok`。
- Fake CLI：`bugfix-null-deref` baseline/optimized×5，gate passed，`liveQualityUnknown=true`（管线烟测，非真实质量验收）。
- 30-case executable contract：全部 descriptor 可 materialize + hidden verifier（`bun test ./.benchmark/verify.test.ts`）+ scope 检查。
- `gateway/gpt-5.6-sol` 全量 5×5 尝试失败：全部 `required_role_unavailable: planner`（availability fail-closed）；不计为通过。
- 用户要求缩短后：杀掉长跑，改 short acceptance。`--repetitions` 现为精确覆盖；live gate 的采样下限跟随 `acceptanceMinRepetitions`。
- **短真实 paired A/B（通过）**：`/tmp/omp-short-live-ab`，`gateway/claude-sonnet-4-6`，`bugfix-null-deref`，baseline/optimized 各 2 次共 4 runs；双方 passRate=1.0、scope=adhered、runtimeProvenance 齐全、fingerprint=`gateway/claude-sonnet-4-6`、outer usage 保持 unknown、`gate.passed=true`、exit=0；报告明确标注 short acceptance（低于完整 5-rep held-out 卡）。耗时约 9 分钟（07:38–07:47Z）。
- 生产默认路由未因 estimate/judge/fake 改变；日志持续可见 `compilerActive:false`。

## 6. 已知限制与后续建议

- Context optimization 只处理调用方提供的 typed `contextEntries`；现有 untyped stage markdown 不做猜测分类。无 typed entries 时 production path no-op。
- `bytes / 4` 是跨 provider 可复现估算，不是 tokenizer 真值或上界；provider/cache 缺失值保持 `unknown`。
- 30-case materializer 证明 suite 可执行，不等于 30-case 全量真实 provider 质量结论。
- 本次真实质量验收为 **short 2×2**，不是完整 5×5 held-out acceptance card；完整卡需另跑 `--repetitions=5`。
- `gateway/gpt-5.6-sol` 在固定模型 live override 下 planner availability 探测失败；需单独排查 provider probe，不阻塞 Phase 0-2 shadow/gated 交付。
- Judge calibration 属于 Phase 3；judge 分数未参与 Phase 0-2 生产 gate，也未改变默认路由。
- 新策略保持 shadow/gated；未凭 estimate、fake benchmark 或 judge 分数改变生产默认 routing/profile。
- 工作树包含大量用户改动；本次未清理、回退或提交无关文件。

## 7. Code Review 与 Handoff

- Code review 文档：`docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-code-review.md`。
- 前期 5 个 HIGH 均已修复；本轮追加：hidden verifier 路径需 `./` 前缀、fake gate 不得因 `liveQualityUnknown` 单独失败、agent 早失败仍须报告 scope、CLI `--repetitions` 精确覆盖。
- 最终 review 结论：**PASS_WITH_NOTES**（short live A/B 通过；完整 5×5 held-out 与 gpt-5.6-sol availability 为已知后续项）。

同会话继续：

```text
继续读取 docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-implementation.md
和 docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-code-review.md，
检查 /tmp/omp-final-hard-gate-live 的最终真实 paired A/B 报告，
确认 10 个 run、双方 100% pass、完整 scope、provider/model fingerprint、unknown outer usage 与 gate，
然后完成最终 code review 结论和全套验证记录。
```

新会话恢复 prompt：

```text
请阅读设计输入 docs/superpowers/specs/2026-07-30-quality-gated-multi-model-optimization-design.md、
实现文档 docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-implementation.md、
代码审查文档 docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-code-review.md，
以及本次 Phase 0-2 代码变更。
检查 /tmp/omp-final-hard-gate-live 的最终真实 paired A/B 报告，
重点核对五个已修复 HIGH、10 个 run、双方 100% pass、完整 scope、provider/model fingerprint、
unknown outer usage、shadow/gated 默认行为与最终验证证据是否一致；发现问题时修复并重新完成全套验证。
```
