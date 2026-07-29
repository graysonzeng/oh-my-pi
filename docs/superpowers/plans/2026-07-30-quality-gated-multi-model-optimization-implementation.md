# Implementation: Quality-Gated Multi-Model Optimization

- Date: 2026-07-30
- Design Doc: `docs/superpowers/specs/2026-07-30-quality-gated-multi-model-optimization-design.md`
- Review Doc: `docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-design-review.md`
- Status: Awaiting User Confirmation Before Code Implementation

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
- 结论：本方案是架构深化，不依赖单一故障根因；代码实现可以建立在当前实现盘点和质量门禁上。实现前仍需用户确认范围。

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

当前只完成设计修订与实施准备，尚未修改生产代码。用户确认后按依赖顺序实施：

1. Phase 0 baseline：重新探测 unresolved paths；记录 HEAD、工作树分类及 package-local test/check/build/smoke 结果；建立 current implementation gap matrix。
2. Phase 1 去重：按 content/artifact hash 检测重复 attachment/reminder/skill-tool delta，记录 dedupe receipt 与估算节省桶；不合并仅语义相似的内容。
3. Phase 1 可恢复引用：将旧 tool result 正文替换为一跳 artifact ref；持久化或完整性失败时保留 inline 原文。
4. Phase 1 ContextLedger 与评测：增加版本化 request bucket ledger、measurement/cache provenance、artifact/handoff refs；将 live suite 扩充到至少 30 个固定 case。
5. Phase 2 单 lever：依次 shadow 评估 tool concurrency ceiling、descriptor placement；cache assembly、prompt overlay、tool catalog 分别等待 provider facts、5-case failure cluster、tool-selection held-out eval。
6. Calibration 支撑：只实现版本化 calibration receipt 与离线评测合同；judge 不控制生产 gate，Phase 3 数据集与阈值验收留在对应阶段执行。

拟涉及模块以代码定位结果为准，优先复用：

- `packages/coding-agent/src/workflow/model-policy/`
- `packages/coding-agent/src/workflow/prompt-assembly.ts`
- `packages/coding-agent/src/workflow/optimization-receipt.ts`
- `packages/coding-agent/src/workflow/stage-handoff.ts`
- `packages/coding-agent/src/workflow/benchmark/`
- 对应 `packages/coding-agent/test/workflow/` 合同测试

## 5. 验证结果

- 文档事实探测：`git diff --name-only --diff-filter=U | wc -l` 返回 `0`。
- 当前工作树分类：`git status --short` 报告 staged 1415、unstaged 0、untracked 4；这些是用户改动，不等于 unresolved conflict。
- 设计文档修订：MEDIUM-1 至 MEDIUM-4 均已落盘。
- 测试：未跑；尚未修改生产代码。
- lint/typecheck：未跑；尚未修改生产代码。
- 构建：未跑；尚未修改生产代码。
- 功能验证：未跑；等待用户确认后进入实现。

用户确认后的最低验证闭环：

- 受影响 workflow 合同测试；新测试只覆盖 externally observable ledger、dedupe、overlay selection 与 calibration receipt 合同。
- `packages/coding-agent` 执行 `bun check`。
- `packages/coding-agent` 执行项目现有 build 命令。
- 执行 workflow fake benchmark 验证管线；真实质量结论只接受 live paired A/B。
- 若触及 worker/runtime 路径，追加 `omp --smoke-test`；否则运行受影响 CLI/workflow 的直接 smoke scenario。

## 6. 已知限制与后续建议

- 当前不是已实现状态；任何代码行为、测试通过或性能收益均未宣称。
- `bytes / 4` 是跨 provider 可复现的估算，不是 tokenizer 真值或上界；model card 必须区分 `provider_fact`、`estimate`、`unknown`。
- Judge calibration 阈值是最低准入线，不表示 judge 可替代 programmatic verifier 或人工判断。
- 工作树包含大量用户 staged 改动。实现必须小范围编辑，不得清理、重排或回退这些改动。
- 用户确认范围后才进入生产代码修改。

## 7. Handoff

代码实现尚未开始，因此本阶段不移交 `code-review`。用户确认后继续执行本实现文档 §4，并在完成验证后补充最终 code-review handoff。
