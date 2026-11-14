# 质量控制与多模型优化最佳实践建议

Date: 2026-07-30
Based on: 2026-07-30-quality-gated-multi-model-optimization-design.md

## 执行摘要

基于设计文档的深度分析和行业最佳实践对比，核心结论：

1. **设计方向正确**：文档的"质量优先 + 能力编译 + 证据驱动"方案与 2025-2026 行业前沿高度一致
2. **实施路径合理**：Phase 0-5 的顺序符合"确定性→可恢复→模型依赖"的优化原则
3. **关键强化点**：需在 single-agent baseline、judge calibration 和复杂度门禁量化上补充细节
4. **立即可行**：Phase 1（去重+可观测性）可立即实施，零质量风险且有净收益

## 1. 质量保障体系（最高优先级）

### 1.1 分层验证金字塔

**设计文档状态**：§5.3.4、§6.2 已设计三层验证

**行业共识验证**：
- Anthropic 工程文（2025-09）："真实 eval 驱动，programmatic verifier 优先"
- OpenAI 指南："先建 baseline，再在 eval 门禁下优化"
- 多篇论文显示 LLM-as-judge 存在长度偏差和风格偏好

**建议金字塔**：
```
┌─────────────────────────────────────┐
│ Layer 3: 人工盲审抽样               │ ≥10% 分层抽样
│ - 校准 judge                        │ 校准 κ、验证边界
│ - 所有 disagreement                 │
│ - 硬门禁边界 cases                  │
├─────────────────────────────────────┤
│ Layer 2: LLM-as-judge               │ 设计/可维护性
│ - 双 judge agreement                │ 辅助性评估
│ - 仅用于程序无法覆盖的维度          │
├─────────────────────────────────────┤
│ Layer 1: Programmatic verifier      │ 功能正确性
│ - 测试通过、构建成功                │ 决定性判定
│ - 确定性验证命令                    │
│ - Schema validation                 │
└─────────────────────────────────────┘
```

**关键原则**：
- Layer 1 决定 functional success，Layer 2/3 不得覆盖确定性失败
- Judge 只评估无法可靠程序化的维度（设计、可维护性、评审质量）
- 所有 judge disagreement 必须人工复核（文档 §6.3 已要求）

### 1.2 Judge Calibration 门禁

**设计文档状态**：§6.3 已要求 κ ≥ 0.60 + 人工盲审

**建议强化**：

```typescript
interface JudgeCalibrationGate {
  // 基础门禁（文档已有）
  cohens_kappa: number;              // ≥ 0.60 (substantial agreement)
  critical_agreement_rate: number;   // ≥ 90% 关键结论一致
  
  // 建议补充：硬门禁维度更严格
  hard_gate_dimensions: {
    permission_violation: { kappa: number };  // 要求 ≥ 0.75 或 100% 一致
    scope_drift: { kappa: number };           // 要求 ≥ 0.75 或 100% 一致
    verifier_integrity: { kappa: number };    // 要求 ≥ 0.75 或 100% 一致
  };
  
  // 偏差检测
  length_bias_check: {
    correlation: number;  // output_length vs judge_score
    threshold: 0.3;       // |r| > 0.3 触发警告
  };
  
  // 人工抽样
  human_audit: {
    stratified_sample_rate: number;   // ≥ 0.10
    strata: ['task_class', 'risk_tier', 'output_length_quartile'];
    all_disagreements: boolean;       // true（全部复核）
    all_boundary_cases: boolean;      // true（硬门禁边界）
  };
}
```

**校准流程**（文档 §6.3 已完整，建议细化）：

1. **准备阶段**
   - 使用与调参集分离的 calibration set
   - 样本匿名化（移除 model/provider 标签）
   - 随机化顺序（避免位置偏差）

2. **双 judge 评分**
   - 两名独立 judge 按版本化 rubric 评分
   - Judge 不得看到 baseline/candidate 标签或 token 统计

3. **计算 κ 与一致率**
   - Ordinal rubric → weighted κ
   - Nominal rubric → unweighted κ
   - 关键结论一致率单独计算

4. **人工盲审**
   - 所有 disagreement
   - 所有硬门禁边界 cases
   - 分层随机抽样 ≥10%（按 task class / risk tier / output length quartile）

5. **偏差检测**
   ```python
   # 检测长度偏差
   correlation = pearson(output_lengths, judge_scores)
   if abs(correlation) > 0.3:
       flag_length_bias()
       revise_rubric_or_replace_judge()
   ```

6. **门禁判定**
   - κ ≥ 0.60 且关键一致率 ≥ 90%：通过
   - 硬门禁维度任一不一致：失败（不由总体 κ 抵消）
   - 发现偏差：修订 rubric，在新 calibration set 上重新校准

**Fingerprint 与重校准**（文档已要求）：
- 每次 judge model/version、rubric、prompt、采样规则变化 → 新 fingerprint
- Fingerprint 变化 → 重新校准
- Calibration receipt 保存：样本集版本、seed、混淆矩阵、κ、人工清单、适用边界

### 1.3 失败模式驱动优化

**设计文档状态**：§5.2.2 prompt overlay 机制已设计

**行业证据**：
- AI agent 实践：从 30-40% deflection → 70-80% 靠"分析失败模式 → 针对性修复"
- PLAY2PROMPT 论文：用真实 tool play 优化说明可跨模型提升

**建议 Failure Taxonomy**：

```typescript
enum FailureFeature {
  // Completion obligations
  INCOMPLETE_DELIVERABLE = 'needs_explicit_completion',
  MISSING_VERIFICATION = 'needs_verification_reminder',
  PREMATURE_STOP = 'needs_stop_condition_clarity',
  
  // Tool usage
  TOOL_HESITATION = 'needs_tool_encouragement',
  WRONG_TOOL_SELECTION = 'needs_tool_examples',
  PARALLEL_TOOL_CAPABLE = 'supports_parallel_tools',
  SERIAL_TOOL_ONLY = 'requires_sequential_tools',
  
  // Schema adherence
  SCHEMA_DRIFT = 'schema_drift_prone',
  EXTRA_FIELDS = 'adds_undeclared_fields',
  ENUM_GUESS = 'guesses_enum_values',
  
  // Scope control
  SCOPE_CREEP = 'needs_scope_boundary',
  OVER_ABSTRACTION = 'needs_concrete_reminder',
  PREMATURE_OPTIMIZATION = 'needs_yagni_reminder',
  
  // Reasoning
  HIDDEN_REASONING_LEAK = 'leaks_hidden_reasoning',
  REASONING_REQUIRED = 'needs_reasoning_mode',
}

interface FailureCluster {
  feature: FailureFeature;
  case_ids: string[];           // ≥5 个真实 cases
  models_affected: string[];
  overlay_version: string;
  prompt_fingerprint: string;
  held_out_improvement: {
    baseline_fail_rate: number;
    overlay_fail_rate: number;
    confidence_interval: [number, number];
  };
  expiry_condition: string;     // 何时删除此 overlay
}
```

**Overlay 创建门禁**：
- 必须有 ≥5 个真实失败 cases 支撑（不是演示或假设）
- Held-out eval 证明显著改善（CI 不含 0）
- 记录 failure feature、支持 cases、policy fingerprint
- 定期审计（每季度）：无证据支持的 overlay 删除

**Canonical overlay 示例**（文档 §5.2.2 已给出 `needs_explicit_completion`）：

```handlebars
{{! overlays/needs_tool_examples.hbs.md }}
## Tool usage examples

When bash commands or file operations are needed:

**Good**: Use the `bash` tool directly
- `bash`: `git status`
- `read`: `src/main.ts`

**Avoid**: Describing what should be done without calling tools
- ❌ "You should run git status"
- ✅ [calls bash tool with command]

These examples were added based on failure cases: #1234, #1567, #1890
```

**组装规则**（文档 §5.2.2 已要求）：
- 固定顺序：`shared-contract.hbs.md` + 零个或多个 overlay
- Overlay 只追加行为差异，不覆盖共享合同
- Compiler 根据 held-out eval 确认的 failure features 选择
- 未知模型或无支持证据时不选择


## 2. Context 与 Token 成本控制

### 2.1 Artifact-backed 架构

**设计文档状态**：§5.4.2 已设计 artifact-backed working set

**行业证据验证**：
- Anthropic 工程文（2025-09）："避免 telephone game，subagent 直写 artifact"
- Claude Code issue #17591, #32099：raw transcript 重传是主要浪费源
- 行业实践报告：25-50% token 减少可行且不损质量

**核心架构**：

```typescript
interface ArtifactBackedContext {
  // 原始内容 → immutable artifact
  artifacts: {
    plan: { uri: string; hash: string; created_at: string };
    patches: Array<{ uri: string; hash: string; files: string[] }>;
    verification_logs: Array<{ uri: string; hash: string; command: string }>;
    review_findings: Array<{ uri: string; hash: string; severity: string }>;
    subagent_outputs: Array<{ uri: string; hash: string; mission: string }>;
    large_tool_results: Array<{ uri: string; hash: string; tool: string }>;
  };
  
  // Model context → 只保留 digest + ref
  working_set: {
    plan_digest: {
      goal: string;
      constraints: string[];
      affected_files: string[];
      acceptance: string[];
      artifact_ref: string;  // 一跳恢复
    };
    
    patch_digest: {
      files_changed: string[];
      key_changes: string[];  // 关键行，非全文
      artifact_ref: string;
    };
    
    verification_digest: {
      passed: string[];
      failed: Array<{ test: string; error_summary: string }>;
      artifact_ref: string;   // 完整日志
    };
  };
  
  // 恢复机制
  recovery: {
    one_hop: boolean;         // 一跳可恢复
    transform_chain: string[];  // 变换链：original → summary
    original_bytes: number;
    visible_bytes: number;
  };
}
```

**关键原则**（文档已要求）：
- 原始计划、patch、验证日志、review、subagent output → immutable artifacts
- Model context → typed digest + artifact ref + hash + 关键行 + 恢复方式
- Subagent 直写 artifact，主 agent 不转述或重写全文
- Compaction 不得删除 artifact，只更换 provider-visible working set

**收益预估**（基于行业数据）：
- 避免重复传输：20-30% token 节省
- 避免 telephone game：5-10% token 节省 + 质量提升
- 总计：25-40% token 节省，质量不降

### 2.2 优化顺序严格执行

**设计文档状态**：§5.4.4 已设计 7 步优化顺序

**建议严格执行**（按风险递增）：

```
步骤 1：去重重复 attachment/reminder/delta
  风险：零（确定性去重）
  收益：10-20% token（基于 issue #32099 报告）
  门禁：保留首次出现，后续引用首次 hash
  实施：Phase 1 立即

步骤 2：旧 tool result 正文 → artifact ref
  风险：低（可恢复）
  收益：15-25% token
  门禁：原始内容必须持久化，返回 recovery URI + sha256
  实施：Phase 1 立即

步骤 3：阶段边界 role-aware handoff
  风险：中（需验证 recall）
  收益：10-20% token
  门禁：关键信息 recall ≥ 95%（held-out eval）
  实施：Phase 1（文档 §5.4.3 已设计）

步骤 4：惰性 skill/tool schema 呈现（catalog）
  风险：中（可能影响 tool selection）
  收益：5-15% token（取决于 tool surface 大小）
  门禁：Tool selection accuracy 不降（held-out tool eval）
  实施：Phase 2（feature gate 关闭直到 eval 通过）

步骤 5：Cache 稳定前缀
  风险：低（provider 能力依赖）
  收益：20-40% effective input token（高 cache hit 场景）
  门禁：Provider 支持 cache + 报告 cache counters
  实施：Phase 2

步骤 6：Repo-map 和 targeted retrieval
  风险：中高（可能影响 localization）
  收益：5-15% token（若当前 regex map 是瓶颈）
  门禁：Localization accuracy 不降
  实施：Phase 5（仅当证明是瓶颈）

步骤 7：模型摘要（最后）
  风险：高（信息丢失风险）
  收益：10-30% token（但可能损失质量）
  门禁：Recall ≥ 95%，一跳恢复成功率 ≥ 98%
  实施：Phase 5（recall gate 通过后）
```

**关键决策**（文档 §5.4.4 已明确）：
- 先最大化 recall，再优化 precision
- 模型摘要是最后手段，不是首选
- 关键信息召回率和一跳恢复成功率是硬门禁

### 2.3 Token Ledger 与可观测性

**设计文档状态**：§5.4.1 已设计 token ledger + 计量规则

**建议实现**：

```typescript
interface TokenLedgerV1 {
  request_id: string;
  timestamp: string;
  role: string;
  model: string;
  
  // 分桶计量（文档已明确规则）
  buckets: {
    system_static: TokenBucket;
    role_policy: TokenBucket;
    tool_schema: TokenBucket;
    skill_catalog: TokenBucket;
    assignment: TokenBucket;
    repo_map: TokenBucket;
    handoff: TokenBucket;
    history: TokenBucket;
    tool_results: TokenBucket;
    artifacts: TokenBucket;
    output: TokenBucket;
  };
  
  // Cache 事实（文档已明确边界）
  cache: {
    read_tokens?: number;      // provider 报告
    write_tokens?: number;     // provider 报告
    uncached_input?: number;   // provider 报告
    source: 'provider_fact' | 'unknown';  // 不得从 hash 推断
  };
  
  // 优化 receipts
  optimizations: {
    dedupe_saved: number;
    artifact_ref_saved: number;
    handoff_saved: number;
    catalog_saved: number;
  };
}

interface TokenBucket {
  bytes: number;               // Buffer.byteLength(content, 'utf8')
  tokens: number;              // Math.ceil(bytes / 4)
  estimate: 'utf8_bytes_div_4_v1' | 'provider_fact' | 'unknown';
}
```

**计量规则**（文档 §5.4.1 已固定）：
- Provider usage 只能记到 provider 可证明的总量，标 `provider_fact`
- Provider 未返回 cache counter → 标 `unknown`，不得从 prefix hash 推断
- 各输入桶按 UTF-8 字节计算，估算 `tokens = Math.ceil(bytes / 4)`，标 `estimate:utf8_bytes_div_4_v1`
- 该值是统一近似量，不宣称是上界，不替代 provider tokenizer
- Output 仅在缺 provider usage 且保留完整输出时使用相同估算
- 内容缺失或不可逆变换且原文不可恢复 → 标 `unknown`

**可观测性目标**：
- 识别最大 token 消费源（哪个桶）
- 追踪优化收益（每步节省多少）
- 检测异常（token 突增、cache miss 率异常）
- 支持成本归因（按 role / task class / model 分解）

### 2.4 Cache-friendly Assembly

**设计文档状态**：§5.2.4 已设计稳定前缀 + 动态后缀

**固定组装顺序**（文档已要求）：

```
稳定前缀（可缓存）：
  1. system_static          ← 完全静态
  2. role_policy            ← 按 role 固定
  3. essential_tool_schema  ← allowlist 固定
  4. skill_catalog          ← 版本固定

动态后缀（不可缓存）：
  1. assignment             ← 任务特定
  2. repo_map               ← 仓库状态
  3. stage_handoff          ← 阶段传递
  4. selected_history       ← 会话历史
```

**禁止事项**（文档已明确）：
- ❌ 在稳定前缀注入时间戳
- ❌ 在稳定前缀注入 workflow id
- ❌ 在稳定前缀注入动态模型可用性
- ❌ 在稳定前缀注入重复 reminders
- ❌ 在稳定前缀注入当前任务文本

**Cache hit 判定**（文档已明确）：
- Provider 报告 cache counters → 使用 provider 报告
- Provider 未报告 → 保持 `unknown`，不得从 prefix hash 相同推断

**收益预估**（基于行业数据）：
- 高 cache hit 场景（多轮对话、相似任务）：20-40% effective input token
- 低 cache hit 场景（单次任务、完全不同任务）：< 5%
- 需监控实际 cache hit rate 决定优先级

## 3. 工具系统优化

### 3.1 工具表面最小化

**设计文档状态**：§5.3.1 已设计 allowlist + essential set + catalog

**行业证据**：
- Anthropic 工程文："少而清晰的工具" > 大工具表面
- 行业实践：60-80% tool calls 是 redundant 或 harmful
- 研究显示：工具数量 > 20 后 selection accuracy 显著下降

**建议策略**：

```typescript
interface ToolSurfacePolicy {
  // Essential set（完整呈现）
  essential: {
    tools: string[];           // ≤15 个工具
    criteria: [
      'role_contract_required',      // Role contract 必需
      'high_frequency',              // 高频使用（> 20%）
      'no_alternative',              // 无可替代
      'safety_critical',             // 安全关键
    ];
  };
  
  // Catalog（惰性加载）
  catalog: {
    tools: string[];
    one_hop_expansion: boolean;  // 允许模型请求 schema
    selection_eval_required: boolean;  // 需 tool selection eval
  };
  
  // 禁止（不呈现）
  forbidden: {
    tools: string[];
    reason: 'permission' | 'deprecated' | 'redundant';
  };
}
```

**Essential set 选择规则**：

1. **Role contract 必需**
   - Implementer 必需：read, edit, write, bash, grep, lsp
   - Reviewer 必需：read, grep, 专门的 review tools
   - Planner 必需：read, grep, glob（只读）

2. **高频工具**（≥ 20% 使用率）
   - 通过历史数据统计
   - 按 role 分别计算

3. **无可替代**
   - 唯一提供某关键能力的工具
   - 例如：edit（结构化编辑）、lsp（symbol-aware 操作）

4. **安全关键**
   - 权限敏感操作
   - 需显式 schema 和 guard 的工具

**Catalog 模式**（文档已设计）：
- 默认 feature gate 关闭
- 需 held-out tool selection eval 通过
- 模型可一跳请求完整 schema
- 记录 catalog 展开率（多少次实际需要展开）

### 3.2 工具独立 Eval

**设计文档状态**：§5.3.2 已要求每个工具独立版本化 eval

**建议 Eval Suite 结构**：

```typescript
interface ToolEvalSuite {
  tool_name: string;
  version: string;
  
  test_cases: {
    // 1. 正确工具选择
    selection: Array<{
      scenario: string;          // "需要读取文件内容"
      correct_tool: string;      // "read"
      wrong_tools: string[];     // ["bash cat", "grep"]
      models_tested: string[];
    }>;
    
    // 2. 参数结构与边界
    parameters: Array<{
      scenario: string;
      correct_args: object;
      boundary_cases: Array<{ args: object; should_pass: boolean }>;
    }>;
    
    // 3. 错误恢复
    error_recovery: Array<{
      initial_failure: string;   // "file not found"
      correct_recovery: string;  // "use glob to find"
      wrong_recovery: string[];  // ["repeat same args"]
    }>;
    
    // 4. 多工具顺序
    sequencing: Array<{
      task: string;
      correct_sequence: string[];  // ["grep", "read:50-100"]
      wrong_sequences: string[][];
    }>;
    
    // 5. 权限拒绝
    permission: Array<{
      forbidden_operation: string;
      should_block: boolean;
      correct_alternative: string;
    }>;
  };
  
  // 6. 最终任务状态
  end_to_end: Array<{
    task: string;
    required_tools: string[];
    success_criteria: string[];
    verification_command: string;
  }>;
}
```

**PLAY2PROMPT 式优化流程**（基于 ACL 2025 论文）：

1. **收集真实 tool play**
   - 从成功 traces 提取工具使用模式
   - 从失败 traces 提取常见错误

2. **生成 canonical examples**
   - Good: 正确使用模式
   - Avoid: 常见错误模式
   - 人工审查，不直接从 traces 复制

3. **Schema inferability probe**
   - 检测哪些描述可从 JSON Schema 推断
   - 删除候选：参数类型、结构、enum 值（schema 已说明）
   - 保留候选：何时调用、语义、典型场景、常见错误

4. **Scar tissue 审计**（文档已要求）
   ```bash
   # 删除前检查历史
   git blame prompts/tools/bash.md
   git log --all --grep="bash tool" --oneline
   
   # 查找关联 issues
   gh issue list --search "bash tool failure"
   ```
   - 保留因真实失败加入的说明
   - 删除假设性或过时的说明

5. **Held-out eval**
   - 在独立 test set 验证
   - 对比 baseline（无优化）vs candidate（优化后）
   - 门禁：selection/parameter/recovery accuracy 不降

### 3.3 工具结果合同

**设计文档状态**：§5.3.3 已明确输出合同

**建议标准合同**：

```typescript
interface ToolResultContract {
  // 核心原则：最小高信号内容
  default_mode: 'concise';     // 默认精简
  detailed_mode: 'opt_in';     // 按需详细
  
  // 大输出支持
  large_output_support: {
    selector: boolean;         // 支持 :50-100 selector
    range: boolean;            // 支持 offset/limit
    pagination: boolean;       // 支持 page/page_size
    filter: boolean;           // 支持 where/query
  };
  
  // 失败输出
  failure_output: {
    bash: {
      exit_code: number;
      failed_tests?: string[];      // 测试失败名称
      root_cause_block: string;     // 首个根因块
      tail_errors: string;          // 尾部错误（最后 20 行）
      repro_command: string;        // 重现命令
      full_log_ref: string;         // artifact URI
    };
    
    test: {
      passed: number;
      failed: number;
      failed_tests: Array<{
        name: string;
        error_summary: string;      // 摘要（≤200 chars）
        stack_trace_top: string;    // 栈顶（≤10 frames）
      }>;
      full_log_ref: string;
    };
  };
  
  // 截断/摘要
  truncation: {
    original_bytes: number;
    visible_bytes: number;
    sha256: string;
    recovery_uri: string;           // 一跳恢复
    transforms: string[];           // ['truncate:1000', 'summarize:llm']
  };
  
  // 去重引用
  deduplication: {
    seen_hash: string;
    first_occurrence_turn: number;
    ref_only: boolean;              // 仅引用，不重复正文
  };
}
```

**关键禁止**（文档已明确）：
- ❌ `read` 工具返回路径/字节统计替换正文（必须保留正文）
- ❌ 截断/摘要不保存原始内容（必须持久化 + recovery URI）
- ❌ 重复注入相同 tool output 全文（hash 引用）
- ❌ 无界 bash/test 输出（必须截断尾部 + artifact ref）

**收益预估**：
- 去重：10-20% token（issue #32099 报告）
- 失败输出精简：5-15% token
- Artifact ref 替换旧结果：15-25% token

