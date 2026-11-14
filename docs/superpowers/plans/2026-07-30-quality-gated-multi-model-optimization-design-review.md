# Design Review: Quality-Gated Multi-Model Execution and Context Optimization

- Date: 2026-07-30
- Reviewed Design: docs/superpowers/specs/2026-07-30-quality-gated-multi-model-optimization-design.md
- Review Scope: 架构深化与产品优化设计，涵盖模型能力编译、上下文优化、多模型执行形态、验证计划与实施路径

## 1. 整体结论

- **PASS_WITH_NOTES**
- 一句话结论：设计方向正确、架构合理、风险识别充分，已具备进入实施阶段的条件；需关注几个中等优先级的补充点以提升实施可信度。

## 2. 根因评审结论（按需）

- 适用性：不适用
- 结论：NOT_APPLICABLE
- 理由：本设计是架构深化与产品优化，不是故障响应或回归修复。设计建立在当前分支实现盘点（§2.1 当前分支事实）、外部证据（§2.3）与目标函数（§1.2）之上，不依赖单一根因判断。

### 2.1 证据检查
不适用

### 2.2 事实 / 假设边界检查
不适用

### 2.3 对方案的影响检查
不适用

## 3. 设计方案评审

### 3.1 需求与方向

#### 正确问题识别
✅ **核心问题清晰**：四类系统性问题（模型漂移、token 成本无闭环、阶段数固定、离线 benchmark 不足）准确识别。

✅ **成功标准严格**：硬门禁（正确率、scope adherence、fail closed、artifact 可恢复性、固定 A/B）与优化指标分离，符合"质量优先"目标函数。

✅ **方向正确**：从静态 per-model profiles 演进为"模型事实 + 阶段合同 + 会话状态"的策略控制面是正确路径，避免了永久排行榜式维护陷阱。

#### 更好路径检查
✅ 方案 A（继续静态 profiles）与方案 B（全量动态路由）的对比充分，选择方案 C（能力编译 + 证据驱动）符合当前成熟度。不建议改变核心方向。

### 3.2 方案合理性

#### 技术可行性
✅ **架构贴合现状**：设计与当前 `workflow` 分支已实现能力（§2.1 表格）高度契合：
- `compiler.ts` 已实现纯函数能力编译
- `stage-handoff.ts` 已实现 role-aware 交接与确定性 fingerprint
- `tool-output-manager.ts` 已实现可恢复截断与 receipt
- `structured-output-repair.ts` 已实现分层修复

✅ **边界覆盖**：失败路径（§5.8 错误处理与回退）、风险缓解（§5.9）、artifact 持久化失败、schema repair 耗尽、reviewer 不可用等边界明确。

✅ **不过度设计**：明确排除 tree-sitter/PageRank repo-map、完整 CWL、在线自学习路由等，留待证据触发（Phase 5）。

#### 架构合理性
✅ **输入三元组清晰**：`ModelFacts + RoleContract + SessionState → CompiledPolicy` 分离关注点，compiler 纯函数可测试。

✅ **执行形态分层**：`single_session` 作为同模型多角色的强 baseline，`independent_review` 风险门控，`parallel_exploration` 独立性约束，避免盲目并行。

✅ **质量门禁**：硬约束（任务成功、scope、验证完整性、权限、可恢复性）与优化目标（单位成本、延迟、token 桶）分离，符合工程原则。

#### 关键设计亮点
1. **Prompt 策略**（§5.2）：共享核心 + 短 overlay，按 failure feature 命名而非型号，few-shot 生命周期管理，cache-friendly assembly。
2. **工具合同**（§5.3.3）：默认最小高信号输出，截断/摘要必须保存原始并返回 recovery URI + hash + transforms，对重复 output 以 artifact hash 引用。
3. **Token ledger**（§5.4.1）：分桶记录 system_static、role_policy、tool_schema、skill_catalog、assignment、repo_map、handoff、history、tool_results、artifacts、output、cache，标记 provider_fact / estimate / unknown。
4. **Artifact-backed working set**（§5.4.2）：原始计划/patch/验证日志/review/subagent output 持久化为不可变 artifact，模型上下文只放 digest + ref + hash + 关键行。

### 3.3 实现可行性

#### 工期与风险
✅ **分阶段清晰**（§6.5）：Phase 0 恢复基线 → Phase 1 可观测性 → Phase 2 单 lever 激活 → Phase 3 held-out 优化 → Phase 4 complexity gate → Phase 5 条件触发深层优化。

⚠️ **Phase 0 前置条件**：文档声称当前工作树有 17 个 unresolved paths，但实测 `git status` 显示 0 个 UU/AA/DD 冲突（只有 A/M/D staged changes）。需澄清"17 个未解决冲突"是指什么；若已解决，Phase 0 可简化为验证 clean build/test baseline。

✅ **依赖可控**：不引入外部 CWL、tree-sitter 等新依赖；优化基于已有 compiler、receipts、workflow、benchmark 和 artifact 基础。

#### 可测试性
✅ **数据集覆盖**（§6.1）：首批 30 个任务覆盖 bug fix、feature、refactor、research、review、tool-heavy、schema-heavy、long-session、permission/safety 九类场景。

✅ **指标分层**（§6.2）：硬门禁（verified success rate、scope violation、verifier integrity、permission violations、critical-context recall、artifact recovery）与诊断指标（tool accuracy、duplicate calls、schema repair rate、token buckets、latency、cost per success）分离。

✅ **实验方法**（§6.3）：paired baseline/candidate、固定环境、≥5 次重复、置信区间、programmatic verifier + rubric judge + 人工盲审。

⚠️ **Judge 偏差风险**：§5.9 提到 LLM judge 可能偏好更长输出，缓解措施是程序 verifier 优先 + 双 judge agreement + 人工盲审，但未明确 judge agreement 的阈值与人工抽样比例。建议补充 judge calibration 具体流程。

#### 上线门禁
✅ **渐进策略**（§6.4）：shadow → offline A/B → opt-in 5% → canary 25% → default，每阶段有明确退出条件（硬指标低于 baseline、artifact 不可恢复、权限扩大、verifier integrity 失败立即回滚）。

### 3.4 文档质量

#### 完整性
✅ **结构完整**：目标范围、背景约束、根因判断（明确不适用）、方案对比、详细设计、验证计划、决策摘要、handoff 全覆盖。

✅ **证据溯源**：当前分支能力表（§2.1）逐项列出代码证据，外部证据表（§2.3）列出来源、日期、可采信结论与边界，访问日期 2026-07-30。

✅ **数据结构演进**（§5.7）：新增 `RoleContractV1`、`ExecutionShape`、`PolicyExperimentV1`、`ModelPerformanceCardV1`、`ContextLedgerV1`，迁移路径明确（读取现有 profile → 标准化为 override → compiler shadow → 单 lever 激活 → 移除 deprecated）。

#### 一致性
✅ **目标-方案-验证闭环**：成功标准（§1.2）→ 核心架构（§5.1）→ 硬约束（§5.6）→ 硬门禁（§6.2）→ 上线门禁（§6.4）逻辑自洽。

✅ **假设显式化**（§3.3）：未确认假设（compiler 替代 profile 降维护成本、complexity gate 降单位成本、catalog 节省净 token、regex repo-map 是否瓶颈）明确标记，并要求 shadow receipts + paired A/B 验证。

#### 待改进点
⚠️ **模板示例缺失**：§5.2.2 描述了 Claude-like / GPT / Grok / GLM 等不同 overlay 策略，但未给出一个完整 overlay 示例（哪些是 shared-contract、哪些是 overlay、overlay 如何选择）。建议补充一个 canonical overlay 示例。

⚠️ **Token ledger 实现细节**：§5.4.1 定义了 9 个 token 桶，但未说明如何在 provider 不返回 cache counters 时 estimate 各桶分配。建议补充 UTF-8 bytes 推算规则或指向已有 `utf8ByteLength` 实现。

## 4. 主要发现

### CRITICAL
无

### HIGH
无

### MEDIUM

#### MEDIUM-1: Phase 0 前置条件澄清
**位置**: §2.1 当前分支事实、§6.5 实施阶段 Phase 0

**问题**: 文档声称"工作树同时有大量用户合并改动，`git status` 显示 17 个 unresolved paths"，但实测 `git status --short | grep -E '^(UU|AA|DD|AU|UA|DU|UD)' | wc -l` 返回 0，只有 staged A/M/D changes。

**影响**: 若冲突已解决，Phase 0 可简化；若理解有误，可能低估恢复基线工作量。

**建议**: 明确"17 个未解决冲突"指什么（是 staged changes 还是其他 git 状态），并更新 Phase 0 范围。如果是 staged changes 且已可构建，直接验证 clean build/test baseline 即可。

#### MEDIUM-2: Judge agreement 阈值与人工抽样比例缺失
**位置**: §5.9 风险与缓解、§6.3 实验方法

**问题**: 提到 LLM judge 偏差风险，缓解措施包括"双 judge agreement + 人工盲审抽样"，但未定义 agreement 阈值（如 Cohen's kappa > 0.6）与人工抽样比例（如 10% 随机 + 所有 disagreement cases）。

**影响**: Judge calibration 不足可能让 judge 偏差污染 model card 结论。

**建议**: 补充 judge agreement 具体阈值与人工盲审抽样规则，或明确在 Phase 3 held-out 优化时建立 judge calibration 流程。

#### MEDIUM-3: Overlay 示例缺失
**位置**: §5.2.2 默认提示策略

**问题**: 描述了不同模型的 overlay 策略（Claude-like、GPT、Grok、GLM 等），但未给出一个完整 overlay 文件示例，不清楚 overlay 包含哪些字段、如何与 shared-contract.hbs.md 组装、failure feature 如何映射。

**影响**: 实施时需要重新解释 overlay 设计，可能偏离设计意图。

**建议**: 补充一个 canonical overlay 示例（如 `overlays/needs_explicit_completion.hbs.md`），展示完整结构与 shared-contract 组装方式。

#### MEDIUM-4: Token ledger estimate 规则缺失
**位置**: §5.4.1 Token ledger

**问题**: 定义了 9 个 token 桶与 `provider_fact` / `estimate` / `unknown` 标记，但未说明 estimate 如何计算（是否复用已有 `utf8ByteLength`、是否考虑 tokenizer 差异、cache 未命中时如何分配）。

**影响**: 实施时可能出现不同 estimate 实现，影响跨模型成本对比可信度。

**建议**: 明确 estimate 规则（如"UTF-8 bytes / 4 作为 token 上界，标记为 estimate"），或指向已有 `packages/coding-agent/src/workflow/tool-output-manager.ts:utf8ByteLength` 作为统一实现。

### LOW

#### LOW-1: Few-shot expiry_condition 未定义
**位置**: §5.2.3 Few-shot 生命周期

**问题**: Few-shot 样例记录包含 `expiry_condition` 字段，但未定义可能的值（如"held-out eval 无提升"、"token 净负收益"、"上游 prompt 版本变更"、"模型版本更新"）。

**影响**: 实施时需要重新定义 expiry 语义，可能不一致。

**建议**: 补充 `expiry_condition` 枚举值或示例，或明确由实施时根据 held-out eval 结果动态决策。

#### LOW-2: Complexity gate 信号权重未明确
**位置**: §5.5.2 Complexity gate

**问题**: Triage 根据 7 个信号（写入风险、affected files、接口/状态/权限、认知去相关、verifier 覆盖、搜索空间、context pressure）选择执行形态，但未给出信号权重或决策树示例。

**影响**: 实施时可能出现不同 triage 逻辑，影响阶段裁剪一致性。

**建议**: 补充一个 decision matrix 或规则示例（如"写入 ≥3 files + 涉及 DB schema → independent_review"），或明确由 Phase 4 实施时基于历史任务分布建立 heuristic。

## 5. 修订建议

1. **澄清 Phase 0 前置条件**（MEDIUM-1）：更新 §2.1 与 §6.5，明确当前 git 状态与 Phase 0 实际范围。
2. **补充 judge calibration 流程**（MEDIUM-2）：在 §5.9 或 §6.3 补充 judge agreement 阈值与人工抽样比例，或标记为 Phase 3 待定义。
3. **补充 overlay 示例**（MEDIUM-3）：在 §5.2 或附录补充一个完整 overlay 文件示例。
4. **明确 token estimate 规则**（MEDIUM-4）：在 §5.4.1 补充 estimate 计算方式或指向已有实现。
5. **补充 few-shot expiry 语义**（LOW-1）：在 §5.2.3 补充 `expiry_condition` 可能值或示例。
6. **补充 complexity gate 决策示例**（LOW-2）：在 §5.5.2 补充 decision matrix 或标记为 Phase 4 实施时建立。

## 6. 下一步建议

- **进入 design-implement**
- 理由：设计方向正确、架构合理、风险识别充分，MEDIUM 级发现不阻塞进入实施阶段，可在实施过程中逐项补充。设计已具备足够细节支持 Phase 0-2 实施。

## 7. Handoff

### 7.1 进入修订及实现

**同会话继续**:
直接执行 $design-implement 或 /design-implement

**新会话恢复 prompt**:
```
请阅读设计文档 docs/superpowers/specs/2026-07-30-quality-gated-multi-model-optimization-design.md
和评审文档 docs/superpowers/plans/2026-07-30-quality-gated-multi-model-optimization-design-review.md，
重点核对根因分析（如有）、事实/假设边界、以及方案修订点，
使用 $design-implement（或 /design-implement）进行方案修订及实现。
重点关注：
- MEDIUM-1: 澄清 Phase 0 前置条件（§2.1 与 §6.5）
- MEDIUM-2: 补充 judge calibration 流程（§5.9 或 §6.3）
- MEDIUM-3: 补充 overlay 示例（§5.2）
- MEDIUM-4: 明确 token estimate 规则（§5.4.1）
```
