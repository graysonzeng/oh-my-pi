## 4. 执行形态选择（Single-agent 优先）

### 4.1 Three Execution Shapes

**设计文档状态**：§5.5.1 已设计三种形态

**关键行业证据**：
- arXiv 2601.12307 "Rethinking the Value of Multi-Agent Workflow"：
  - "同模型多角色应先与共享 KV-cache 的单代理分阶段 baseline 比较"
  - Single-agent 有 context 连续性、cache 优势、无协调成本
- Anthropic 工程文：
  - 多 agent 适合 breadth-first 独立探索
  - Coding 并行性通常弱于 research
  - 约 15x chat token 成本（需证明价值）
- 行业实践：80% 场景 single-agent 足够

**建议决策树**：

```
┌─────────────────────────────────────────────┐
│ Task Triage                                  │
└─────────────────────────────────────────────┘
              ↓
     ┌────────┴────────┐
     │  Risk & Scope   │
     └────────┬────────┘
              ↓
    ┌─────────┴─────────┐
    │                   │
LOW/MEDIUM          HIGH RISK
    │                   │
    ↓                   ↓
┌──────────────┐   ┌──────────────────────┐
│single_session│   │independent_review    │
│              │   │（不同 vendor）        │
│- 共享 context │   │                      │
│- KV cache    │   │- 认知去相关           │
│- 分阶段执行   │   │- 权限/安全/DB        │
│- 确定性验证   │   │- 公共 API            │
└──────────────┘   └──────────────────────┘
    │
    │  独立搜索空间？
    ↓
┌──────────────────────┐
│parallel_exploration   │
│                       │
│- 文件 ownership 清晰  │
│- 互不依赖             │
│- 预算充足             │
└──────────────────────┘
```

**Single-session（强 baseline）**：

```typescript
interface SingleSessionShape {
  // 定义
  description: '同一模型在共享会话中分阶段执行';
  
  // 适用场景
  suitable_for: [
    '单文件/局部修复',
    '上下文强耦合',
    '可由确定性验证覆盖',
    'context budget 紧张',
  ];
  
  // 优势
  advantages: {
    kv_cache_continuity: true,    // prompt cache 连续性
    context_sharing: true,         // 共享工作集
    zero_coordination_cost: true,  // 无协调开销
    lower_token_cost: true,        // 通常节省 20-40% token
  };
  
  // 阶段划分（按需）
  phases: [
    { name: 'plan', optional: true },      // 简单任务跳过
    { name: 'implement', required: true },
    { name: 'verify', required: true },
    { name: 'repair', conditional: true }, // 失败时
  ];
  
  // 同模型多角色的 baseline
  multi_role_baseline: {
    same_model: true,
    shared_session: true,
    must_prove_net_benefit: '独立实例必须证明净收益',
  };
}
```

**Independent-review（高风险门禁）**：

```typescript
interface IndependentReviewShape {
  // 定义
  description: '实现与 review 使用不同 vendor 或独立上下文';
  
  // 适用场景（文档 §5.5.1）
  suitable_for: [
    '高风险操作（权限/安全/DB）',
    '多文件变更',
    '公共 API 变更',
    '难以测试完全覆盖',
  ];
  
  // 认知去相关
  cognitive_decorrelation: {
    different_vendor: true,        // 不同 provider
    independent_context: true,     // 不继承实现轨迹
    artifact_only_input: true,     // 只消费 artifacts
  };
  
  // 输入（文档 §5.4.3）
  reviewer_input: [
    'plan artifact ref',
    'patch artifact ref',
    'verification results',
    'handoff digest',
    // ❌ 不包含实现轨迹、tool call 历史
  ];
  
  // 成本
  cost_multiplier: 1.5-2.0,  // 相比 single-session
  
  // 门禁
  gate: {
    risk_tier: 'high',
    quality_floor_required: true,
    fallback_if_unavailable: 'block_or_degrade_with_user_consent',
  };
}
```

**Parallel-exploration（独立搜索）**：

```typescript
interface ParallelExplorationShape {
  // 定义
  description: '独立证据域或模块的并行探索';
  
  // 适用场景（文档 §5.5.1）
  suitable_for: [
    '互相独立的搜索方向',
    '文件 ownership 清晰的模块',
    '不共享核心文件',
    '预算充足',
  ];
  
  // 前置条件
  prerequisites: {
    independence: true,             // 任务互相独立
    no_shared_mutations: true,      // 不同时写共享文件
    clear_boundaries: true,          // 边界清晰
    frozen_contracts: true,          // 接口已冻结
  };
  
  // Worker 合同
  worker_contract: {
    mission: string;
    non_goals: string[];
    scope: string[];
    budget: number;
    output_schema: object;
    stop_conditions: string[];
  };
  
  // 协调
  coordination: {
    max_workers: 'min(packages, file_conflicts, provider_limit, budget, verify_capacity)',
    conflict_serialization: ['same_path_write', 'mutating_bash', 'shared_config', 'unfrozen_interface'],
    failure_policy: 'switch_strategy_or_block_after_2_identical_failures',
  };
  
  // 成本
  cost_multiplier: 2.0-4.0,  // 相比 single-session
  
  // 门禁
  gate: {
    proven_independence: true,
    sufficient_budget: true,
    value_exceeds_cost: true,
  };
}
```

### 4.2 Complexity Gate

**设计文档状态**：§5.5.2 已设计信号列表

**建议量化规则**：

```typescript
interface ComplexityGate {
  // 风险评估
  risk_score: number;  // 0-100
  
  risk_factors: {
    write_operations: {
      none: 0,
      read_only: 0,
      single_file_local: 10,
      multi_file: 30,
      interface_change: 50,
      permission_sensitive: 80,
      data_mutation: 80,
      public_api: 90,
    };
    
    scope: {
      single_function: 5,
      single_file: 10,
      single_package: 20,
      multi_package: 40,
      cross_module_deps: 60,
    };
    
    verifiability: {
      full_test_coverage: -20,    // 降低风险
      deterministic_verify: -10,
      partial_coverage: 10,
      no_coverage: 30,
    };
    
    reversibility: {
      easily_reversible: -10,
      rollback_available: 0,
      hard_to_reverse: 30,
      irreversible: 50,
    };
  };
  
  // 决策阈值
  thresholds: {
    low: { max: 20, shape: 'single_session', plan: false },
    medium: { max: 50, shape: 'single_session', plan: true },
    high: { max: 80, shape: 'independent_review', plan: true },
    critical: { min: 80, shape: 'independent_review', plan: true, extra_review: true },
  };
}
```

**推荐流程**（文档 §5.5.2）：

```
LOW (≤20):
  triage → implement → verify → done
  - 无 plan phase
  - single_session
  - 例子：单文件 typo fix、局部样式调整

MEDIUM (21-50):
  triage → plan → implement → verify → done
  - 有 plan phase（澄清需求 + 设计）
  - single_session
  - 例子：单 package 新 feature、重构一个模块

HIGH (51-80):
  triage → plan → implement → verify → independent_review → repair → verify
  - 不同 vendor review
  - 例子：权限系统、DB schema、公共 API

CRITICAL (>80):
  triage → plan → plan_review → implement → verify → independent_review → extra_audit → repair → verify
  - 额外审计
  - 例子：认证逻辑、支付集成、数据删除
```

### 4.3 同模型多角色的正确比较

**关键原则**（基于 arXiv 2601.12307）：

```
❌ 错误比较：
  Baseline: 单次调用（无阶段划分）
  Candidate: 多角色 workflow（planner + implementer + reviewer）
  
  问题：混淆了"多角色"和"分阶段"的收益

✅ 正确比较：
  Baseline: single_session 分阶段（shared context + KV cache）
    - Phase 1: plan（同模型，同会话）
    - Phase 2: implement（继续会话）
    - Phase 3: review（继续会话）
  
  Candidate: 多独立实例（独立 context，无 KV cache）
    - Instance 1: planner（独立）
    - Instance 2: implementer（独立，只读 plan artifact）
    - Instance 3: reviewer（独立，只读 plan + patch artifacts）
  
  比较维度：
    - 任务成功率（主要）
    - 单位成功成本（token + 重试 + fallback）
    - p50/p95 延迟
    - Context pressure（baseline 更高）
    - 协调成本（candidate 更高）
  
  门禁：
    Candidate 必须在至少两个维度显著优于 baseline
    且无维度显著劣于 baseline
```

**实验设计**：

```typescript
interface SameModelMultiRoleExperiment {
  // 固定变量
  fixed: {
    model: string;              // 同一模型
    task: string;               // 同一任务
    repo_state: string;         // 同一 commit
    tools: string[];            // 同一工具集
    prompt_core: string;        // 同一核心 prompt
    temperature: number;        // 同一随机性
  };
  
  // 对比组
  baseline: {
    name: 'single_session_phased',
    phases: ['plan', 'implement', 'review'],
    shared_context: true,
    kv_cache: true,
    coordination_cost: 0,
  };
  
  candidate: {
    name: 'independent_instances',
    instances: ['planner', 'implementer', 'reviewer'],
    shared_context: false,
    kv_cache: false,
    coordination_cost: 'handoff + artifact serialization',
  };
  
  // 重复
  runs: 10,  // 至少
  
  // 指标
  metrics: {
    primary: 'verified_success_rate',
    secondary: [
      'unit_success_cost',
      'p50_latency',
      'p95_latency',
      'context_utilization',
      'handoff_information_loss',
    ],
  };
  
  // 门禁
  gate: {
    candidate_must_beat_baseline_on: 2,  // 至少 2 个维度
    no_significant_degradation: true,     // 无维度显著劣化
    confidence_interval: 0.95,
  };
}
```

## 5. 多模型路由与成本优化

### 5.1 Quality-gated Cascading

**设计文档状态**：§5.6 硬约束 + unit_success_cost 优化

**行业证据**：
- RouteLLM：85% 成本节省 + 95% GPT-4 质量
- Conformal cascading：40-85% 成本减少，96-100% 质量保持
- 关键：Quality Estimation (QE) gate，低质量输出路由到更强模型

**建议路由架构**：

```typescript
interface QualityGatedRouter {
  // 硬约束（文档 §5.6 已明确）
  hard_constraints: {
    task_success: true,
    scope_adherence: true,
    verification_integrity: true,
    permission_safety: true,
    artifact_recoverability: true,
    role_quality_floor: true,
  };
  
  // Eligible candidates
  eligible_candidates: Model[];  // 通过所有硬约束
  
  // 目标函数（仅在 eligible 中优化）
  objective: 'minimize unit_success_cost';
  
  // Quality Estimation
  quality_estimation: {
    confidence_score: number;      // 0-1
    quality_indicators: [
      'schema_valid',
      'scope_adherent',
      'verification_passed',
      'no_permission_violation',
      'artifact_recoverable',
    ];
    
    // Cascade trigger
    cascade_threshold: 0.7;        // < 0.7 升级到更强模型
  };
  
  // Fallback chain
  fallback_chain: {
    initial: 'efficient_model',
    cascade_to: 'quality_model',
    final: 'premium_model',
    
    // 记录
    actual_path: string[];         // 实际路由路径
    fallback_reasons: string[];
  };
  
  // Router output（文档已要求）
  output: {
    planned_profile: ModelProfile;
    actual_provider: string;
    actual_model: string;
    facts_provenance: string;
    execution_shape: ExecutionShape;
    fallback_reason?: string;
    degraded_flag: boolean;
    expected_quality_floor: number;
    policy_fingerprint: string;
  };
}
```

### 5.2 Unit Success Cost 分解

**设计文档状态**：§5.6 公式已明确

**建议分解分析**：

```typescript
interface UnitSuccessCostBreakdown {
  // 总公式（文档已明确）
  formula: '(initial + retry + fallback + review + rework + dup_tool) / verified_successes';
  
  // 分项追踪
  breakdown: {
    initial_attempt: {
      prompt_tokens: number;
      completion_tokens: number;
      tool_execution_cost: number;
      latency_ms: number;
    };
    
    retry_cost: {
      count: number;
      reasons: string[];           // ['schema_invalid', 'scope_drift']
      total_tokens: number;
    };
    
    fallback_cost: {
      count: number;
      from_model: string;
      to_model: string;
      reason: string;
      total_tokens: number;
    };
    
    review_cost: {
      reviewer_tokens: number;
      findings_count: number;
      blocking_findings: number;
    };
    
    rework_cost: {
      repair_iterations: number;
      repair_tokens: number;
    };
    
    duplicate_tool_cost: {
      duplicate_reads: number;
      duplicate_greps: number;
      duplicate_tool_calls: number;
      wasted_tokens: number;
    };
  };
  
  // 识别最大浪费源
  top_waste_sources: Array<{
    category: string;
    percentage: number;
    mitigation: string;
  }>;
}
```

**行业典型分布**（用于对比）：

```
成功 case 典型成本分布：
  initial: 60-70%
  review: 15-25%
  retry: 5-10%
  dup_tool: 5-10%
  fallback: <5%
  rework: <5%

失败后成功 case：
  initial: 30-40%
  retry: 20-30%
  rework: 20-30%
  review: 10-15%
  dup_tool: 5-10%

高浪费信号：
  dup_tool > 20%    → 去重系统问题
  retry > 30%       → prompt/schema 问题
  rework > 30%      → verification 或 review 问题
  review > 40%      → complexity gate 问题
```

### 5.3 Fail Closed 原则

**设计文档状态**：§5.6 已要求

**建议实现**：

```typescript
interface FailClosedPolicy {
  // Critical roles（关键角色）
  critical_roles: [
    'permission_sensitive',
    'data_mutation',
    'public_api',
    'security_review',
    'db_migration',
  ];
  
  // 无 eligible candidate 时
  no_eligible_candidate: {
    action: 'block',
    user_notification: 'No model meets quality floor for this critical role',
    degraded_mode: 'opt_in_only',  // 仅用户显式同意
    degraded_warning: 'Using lower-quality model may compromise safety',
  };
  
  // Availability vs quality
  availability_check: {
    preflight_only: true,           // 只是时间点诊断
    actual_failure_fallback: true,  // 正式调用失败仍走 fallback
    record_deviation: true,         // 记录与 preflight 偏差
  };
  
  // Degraded mode 合同
  degraded_mode: {
    requires: 'explicit_user_consent',
    warnings: [
      'Lower quality floor',
      'May miss edge cases',
      'Increased verification burden',
    ],
    extra_verification: true,       // 额外验证步骤
    cannot_degrade: ['permission', 'data_deletion', 'public_key_change'],
  };
}
```

## 6. 实施路径建议

### Phase 0：探测与 Baseline（立即）

**目标**：建立可信工作基线

**任务**（文档 §6.5 已设计）：
1. 探测 unresolved paths
2. 区分 staged 改动 vs 冲突
3. 运行受影响 package 测试 + bun check + 构建
4. 记录 baseline 结果

### Phase 1：可观测性与去重（立即，零风险）

**目标**：ContextLedger + 去重 + artifact ref

**任务**：
1. 实现 ContextLedgerV1（§5.4.1 设计）
2. 去重 attachment/reminder/delta
3. 旧 tool result → artifact ref
4. 扩充 live suite 到 ≥30 cases（§6.1）

**预期收益**：
- Token 节省：15-30%
- 可观测性：完整 token 分桶
- 风险：零（确定性操作 + 可恢复）

### Phase 2：Compiler 单 Lever 激活（按证据）

**目标**：逐项激活 compiler levers

**顺序**（文档 §6.5）：
1. Tool concurrency ceiling（权限不扩大）
2. Descriptor placement（权限不扩大）
3. Cache-friendly assembly（provider 确认后）
4. Prompt overlay（≥5 failure cases 后）
5. Tool catalog（tool selection eval 通过后）

**每个 lever A/B**：
- Shadow receipts
- Paired live A/B（held-out suite）
- 门禁：所有硬指标不降
- Opt-in 5% → Canary 25% → Default

### Phase 3：Prompt/Tool 优化（持续）

**目标**：工具独立 eval + failure-feature overlay

**任务**：
1. 对高失败率工具做 tool-play 收集
2. Schema inferability probe
3. Scar tissue 审计（git blame + issues）
4. Held-out eval
5. 删除无证据 vendor 特例

**季度审计**：
- 每个 overlay 有效性
- 失败模式分布变化
- 新失败模式识别

### Phase 4：Workflow Complexity Gate（门禁成熟后）

**目标**：按复杂度裁剪阶段

**任务**：
1. 量化 complexity gate（§4.2 建议）
2. Single-session vs independent-review 选择器
3. 同模型多角色 baseline 对比（§4.3）

**门禁**：
- Baseline 完整建立
- 至少 30 cases × 10 runs
- 置信区间计算

### Phase 5：深层优化（按瓶颈触发）

**触发条件**（文档 §6.5）：
- Tree-sitter repo-map：**仅当** localization 是证明瓶颈
- Episode graph：**仅当** handoff 导致长会话丢失
- Adaptive routing：**仅当** model cards 稳定

## 7. 关键风险缓解

### 7.1 Judge 偏差（HIGH）

**风险**：LLM judge 倾向更长/特定风格输出

**缓解**（文档 §5.9 + 补充）：
1. Programmatic verifier 决定性判定
2. 双 judge agreement
3. 人工盲审 ≥10% 分层抽样
4. **补充**：监控 output_length vs judge_score 相关性
5. |r| > 0.3 触发重新校准

### 7.2 Optimization 过拟合（MEDIUM）

**风险**：在固定 eval set 上优化导致过拟合

**缓解**（文档 + 补充）：
1. 开发/调参/验收集分离
2. **补充**：定期从生产失败补充新样本
3. 每季度刷新 held-out set

### 7.3 Provider 波动（MEDIUM）

**风险**：模型版本更新使 model card 失效

**缓解**（文档 §5.8 + 补充）：
1. Facts/fingerprint 变化回到 shadow
2. **补充**：监控 provider API version header
3. 版本变化触发自动 re-eval

## 8. 与外部方案对比总结

| 维度 | 文档方案 | 行业最佳实践 | 评估 |
|------|---------|-------------|------|
| 质量门禁 | 硬约束 eligible candidates | Quality-gated cascading | ✅ 完全对齐 |
| Context 优化 | Artifact-backed + handoff | 25-50% proven reduction | ✅ 完全对齐 |
| 工具优化 | Essential set + catalog | Tool minimization | ✅ 完全对齐 |
| 执行形态 | 3 shapes + complexity gate | Single-agent baseline emphasis | ✅ 对齐，需强化 baseline |
| 路由策略 | Unit success cost | RouteLLM 85% saving | ✅ 完全对齐 |
| Judge 校准 | κ ≥ 0.60 + 盲审 | 行业标准 | ✅ 完全对齐 |
| 实施路径 | 5 phases | Shadow → A/B → canary | ✅ 完全对齐 |

**结论**：文档设计方案与 2025-2026 行业最佳实践高度一致，核心决策正确。

## 9. 立即行动建议

### 优先级 P0（立即，零风险）

1. **ContextLedger 实现**
   - 按文档 §5.4.1 实现完整 token 分桶
   - UTF-8 bytes / 4 估算
   - Provider facts vs estimates 标记

2. **去重系统**
   - Attachment/reminder/delta 按 hash 去重
   - 记录节省 token
   - 证明收益（预期 10-20%）

3. **Artifact ref 替换**
   - 旧 tool result → artifact + recovery URI
   - 保留 sha256 + transforms
   - 可恢复验证

### 优先级 P1（短期，低风险）

1. **Live suite 扩充**
   - 目标 ≥30 cases
   - 覆盖 9 类任务（§6.1）
   - 固定 verification commands

2. **Failure taxonomy 建立**
   - 分析现有失败 traces
   - 建立 failure features
   - ≥5 cases 支撑每个 overlay

3. **Tool concurrency ceiling**
   - 权限不扩大
   - Shadow receipts
   - Paired A/B

### 优先级 P2（中期，按证据）

1. **Prompt overlay 激活**
2. **Tool catalog eval**
3. **Complexity gate 量化**

### 优先级 P3（长期，按瓶颈）

1. **Tree-sitter repo-map**（证明瓶颈后）
2. **Episode graph**（handoff 丢失后）
3. **Adaptive routing**（cards 稳定后）

---

**最终建议**：文档设计方向正确，按 Phase 0-5 顺序执行，Phase 1 立即实施。
