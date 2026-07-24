# Per-Model Optimization Design for oh-my-pi

> **Goal:** 让不同模型在 oh-my-pi 上的表现超越原厂 CLI，通过 per-model 的 prompt、工具调用、上下文管理优化，在保障任务质量的同时大幅降低 token 消耗。

**文档版本**: v1.0  
**创建日期**: 2026-07-25  
**作者**: based on community research and competitive analysis  
**目标读者**: Grok Build Goal 模式实现者

---

## 0. 执行摘要

### 0.1 核心目标

1. **Token 效率提升 40-70%**：通过工具输出截断、上下文驱逐、repo-map 等技术
2. **任务完成质量提升 10-20%**：通过 per-model prompt 优化、结构化输出增强
3. **成本降低 30-60%**：通过智能模型路由和上下文窗口利用率优化
4. **超越原厂 CLI**：在相同模型下，oh-my-pi 的 harness 表现优于 Claude Code / Codex CLI / Grok Build

### 0.2 关键发现（来自社区调研）

| 发现 | 数据来源 | 影响 |
|------|---------|------|
| 工具输出膨胀是最大 token 浪费源 | Reddit, GitHub | 可节省 60-89% token |
| Aider 比 Claude Code 节省 4.2x token | Morph 评测 | repo-map 策略有效 |
| Claude Sonnet 5 性能达 Opus 98%，成本 1/5 | SWE-bench | 智能路由价值高 |
| Grok 4.5 有 200 万 token 窗口，成本仅 Claude 1/4 | xAI 官方 | 大窗口模型适合特定场景 |
| 上下文驱逐可支持 8000 万 token 会话无质量下降 | 学术论文 | 结构化驱逐优于摘要压缩 |

### 0.3 架构概览

```
ModelProfile (增强)
    ├── promptStrategy: PromptStrategy      [新增] 针对模型特性优化 prompt
    ├── toolStrategy: ToolStrategy          [新增] 工具输出截断和摘要
    ├── contextStrategy: ContextStrategy    [新增] 上下文窗口管理和驱逐
    ├── outputStrategy: OutputStrategy      [新增] 结构化输出优化
    └── runtime: WorkflowRuntimeConfig      [已有] 执行后端选择

↓ 编译到

RuntimeAdapter
    ├── preparePrompt(profile, context) → optimizedPrompt
    ├── transformTools(profile, tools) → renamedTools + truncatedOutput
    ├── manageContext(profile, history) → prunedContext
    └── run(request) → result
```

---

## 1. 背景与动机

### 1.1 当前 oh-my-pi workflow 能力

**已实现**：
- ✅ 混合 runtime 调度（embedded/Codex CLI/Claude CLI）
- ✅ 确定性状态机（planning → review → implement → verify）
- ✅ 隔离执行和 vendor-diversity 强制
- ✅ 预算控制和恢复机制
- ✅ 结构化输出验证

**限制**：
- ⚠️ 所有模型使用相同的 system prompt 和工具策略
- ⚠️ 工具输出完整累积到上下文（无截断）
- ⚠️ 无 per-model 的上下文窗口管理
- ⚠️ ModelProfile 的 toolAliases/argumentAliases 已定义但未实现

### 1.2 竞品对比

| 工具 | Token 效率 | 任务质量 | 关键优势 |
|------|-----------|---------|---------|
| **Claude Code** | 基线 (33K) | 78% 准确率 | 100 万 token 窗口，单次推理整个代码库 |
| **Cursor** | -82% (188K) | 类似 | IDE 原生集成，Router 功能节省 60% 成本 |
| **Aider** | +76% (7.8K) | 71% 准确率 | repo-map + PageRank，token 效率最高 |
| **Grok Build** | +88% (?) | 86.6% SWE-bench | 200 万 token 窗口，但安全问题待解决 |
| **oh-my-pi (当前)** | ? | ? | 混合 runtime，但未 per-model 优化 |
| **oh-my-pi (目标)** | +50-70% | +10-15% | **质量优先，综合各家优势** |

**目标定位**：
- **质量第一**：任务完成质量超越 Claude Code（>80% 准确率）
- **Token 效率第二**：接近 Aider 的效率（repo-map），但不牺牲质量
- **成本可控**：通过智能路由，总成本降至 Cursor 水平（-60% vs 全 Opus）
- **允许 trade-off**：在质量差距 <3% 时，接受成本节省 >50% 的方案

### 1.3 模型特性差异（基于真实用户反馈）

| 模型 | 上下文 | 成本 | 代码质量 | 推理能力 | 关键反馈 |
|------|-------|------|---------|---------|---------|
| **Claude Fable 5** | 20万 | 高 | **9/10** | **9.5/10** | SWE-bench Pro 80.3%，长周期任务最强，"能一次性解决 Opus 需要3-4轮的问题" |
| **GPT-5.6-sol** | 128K | 高 | **8.5/10** | **9/10** | Terminal-Bench 91.9% **第一**，"最佳全能 agent，跟进更好" |
| **GLM-5.2** | 128K | 中低 | **8/10** | **8.5/10** | "与 Opus 4.8 不相上下"，Code Arena 第一，MIT 开源 |
| **Claude Opus 4.8** | 100万 | 高 | **8/10** | **8.5/10** | SWE-bench Pro 69.2%，但"bug 率高于 4.7"，token 消耗大 |
| **GPT-5.6-terra** | 100万+ | 中高 | **8/10** | **8/10** | "匹配 GPT-5.5 质量但价格减半"，日常生产工作合理默认 |
| **Grok 4.5** | 200万 | 中低 | **7.5/10** | **8/10** | 性价比极高，"速度领导者"，但"幻觉率更高" |
| **Claude Sonnet 5** | 20万 | 中 | **7.5/10** | **8/10** | "不遵守命令"投诉多，"没有打动任何人" |
| **DeepSeek V4 Pro** | 128K | 极低 | **7.5/10** | **8/10** | 价格便宜 28.7 倍，但"API 7月后异常，幻觉增多" |

**质量分层（2026年7月真实反馈）**：
- **T0 顶级质量**：Fable 5（最强），GPT-5.6-sol（agent 最佳）
- **T1 高质量**：GLM-5.2（性价比王），Opus 4.8（长上下文），Terra（平衡）
- **T2 高性价比**：Grok 4.5（速度快但幻觉多），Sonnet 5（价格降后有竞争力）
- **T3 极致性价比**：DeepSeek V4 Pro（便宜但 API 不稳定）

**关键发现**：
1. **Fable 5** 确实是最强，但**价格是 Opus 两倍**（$10/$50 vs $5/$25）
2. **GPT-5.6-sol** 在 Terminal-Bench 领先所有模型（91.9%），agent 工作流最佳
3. **GLM-5.2** 惊艳，用户评价"无限接近 Fable 5"，价格仅 Opus 零头
4. **Opus 4.8** 存在质量问题，"bug 率高于 4.7"，用户投诉"忽略明确指令"
5. **Sonnet 5** 用户体验差，"不遵守命令"，"陷入无休止的反驳循环"
6. **Grok 4.5** 性价比最高，但幻觉率需要注意
7. **DeepSeek V4 Pro** 价格极低，但 7 月后 API 不稳定

**质量优先原则（更新）**：
- **关键阶段（planning, code_review）优先 Fable 5 或 GPT-5.6-sol**
- **Opus 4.8 降级为备选**（质量问题 + token 消耗大）
- **GLM-5.2 提升为高质量选择**（质量接近顶级，价格友好）
- **Grok 4.5 适合实现阶段**（速度快 + 性价比高，容忍幻觉）
- **DeepSeek V4 Pro 仅用于非关键批量任务**（API 稳定性问题）

---

## 2. 社区调研核心发现

### 2.1 Token 浪费的根本原因

#### 问题 1: 工具输出膨胀

**案例**：
- 读取 500 行文件 → 消耗 ~5000 token，即便 Claude 只需要 10 行
- 运行测试 → 完整日志（通过的测试、进度条、冗余格式）累积到上下文
- `ls -la` → 完整输出包含权限、时间戳，实际只需要文件名

**社区反馈**：
- Reddit 用户通过 CLI 代理剥离无用输出，**节省了 89% token**（10M → 1.1M）
- GitHub 讨论：[Kilo-Org/kilocode#5848](https://github.com/Kilo-Org/kilocode/discussions/5848)

**根因**：
- 当前实现：每次工具调用将**完整输出**附加到上下文
- 未做任何过滤、截断或摘要

#### 问题 2: 上下文窗口填满

**案例**：
- Monorepo 或企业级应用，上下文窗口意外填满导致任务失败
- Claude Code 用户报告：未知大输出导致窗口耗尽
- 参考：[Medium 文章](https://medium.com/@cartseoservice/claude-code-context-window-full-fix-token-errors-2026-e65328c94321)

**根因**：
- 工具结果速度超预期累积
- 无结构化驱逐策略（保留什么、丢弃什么）

#### 问题 3: 重复或无效 prompt

**案例**：
- 所有模型使用相同冗长的 system prompt（~2000 token）
- Few-shot examples 静态加载，任务完成后仍占用空间
- Grok 需要更明确的指令，Claude 不需要

**根因**：
- 未根据模型能力调整 prompt 策略

### 2.2 Aider 的 Token 效率秘诀

**核心机制**：git-first + repo-map

#### Repo-Map 技术

1. **符号提取**：使用 ctags / tree-sitter 提取函数签名、类结构、导入关系
2. **调用图构建**：解析符号依赖，构建文件间调用图
3. **PageRank 排序**：对文件重要性评分
4. **选择性上下文**：
   - 正在编辑的文件 → 完整内容
   - 相关文件 → 符号签名（压缩 repo-map）
   - 其余文件 → 不发送

**效果**：
- 在 token 预算内保持代码库理解
- 但需要更多轮次完成复杂重构（trade-off）

**参考**：
- [Aider PageRank 原理](https://anishgandhi.com/aider-pagerank-codebase-ranking)
- [Aider ctags 文档](https://aider.chat/docs/ctags.html)

### 2.3 学术研究的三大优化方向

#### A. 上下文修剪（Context Pruning）

**SWE-Pruner 论文**（[arXiv:2601.16746](https://arxiv.org/abs/2601.16746)）：
- **问题**：LLM 代码代理将大部分 token 预算花在读取仓库文件上，其中大量代码无关
- **方案**：任务感知自适应修剪，模拟人类程序员"选择性浏览"源码
- **批评现有方法**：单目标序列标注器将代码相关性压缩为一个分数（丢失多维信息）

**多标准潜在推理**（[arXiv:2605.15315](https://arxiv.org/abs/2605.15315)）：
- 提出多维度评估代码相关性（语义、结构、依赖、历史）

#### B. 结构化上下文驱逐（Structured Context Eviction）

**长期代理论文**（[arXiv:2606.11213](https://arxiv.org/abs/2606.11213)）：

**核心概念**：Context Working Limit (CWL)
- **保留**：用户回合、活跃探索上下文
- **丢弃**：效果已持久化到环境的动作片段（文件已写入、测试已通过）

**关键优势**：
- 避免摘要压缩的不可预测损失
- 避免因果结构破坏
- 避免模型成本和压缩诱发的幻觉

**实验结果**：
- 单个代理会话完成 **89 个连续任务**
- 跨越 **8000 万 token**
- 任务准确性**无可测量下降**

#### C. 工具调用优化

**研究共识**（[JustoBorn 文章](https://justoborn.com/tool-calling/)）：
- 工具调用已演变为专门的提示工程学科
- 需要严格 JSON schema、"心智理论"提示、健壮错误处理
- **关键发现**：修剪到最后 5 次工具调用可提升完成率同时减少 token 使用
- 添加摘要可实现 91.6% 完整条目化，使用 553,374 token

### 2.4 Cursor 的 Per-Model 优化策略

**Router 功能**（2026 年 7 月推出）：
- 自动选择最优模型，**节省 60% 成本**
- 简单任务 → 便宜模型（Sonnet, GPT-mini）
- 复杂任务 → 强推理模型（Opus, GPT-5.5）

**最佳实践**：
- 为每个前沿模型定制指令和工具
- 基于内部评估和外部基准
- **共识**：提示质量是 2026 年的主要优化杠杆，影响大于原始模型能力或上下文窗口大小

**参考**：
- [Cursor 最佳实践](https://cursor.com/blog/agent-best-practices)
- [Cursor Router 报道](https://startupfortune.com/cursor-router-picks-your-ai-model-for-you-and-cuts-coding-costs-by-60/)

---

## 3. 技术方案设计

### 3.1 Per-Model Prompt 策略（promptStrategy）

#### 3.1.1 设计目标

不同模型对 prompt 的理解能力差异显著：
- **Claude Opus/Sonnet**：强推理，理解复杂指令，少需 few-shot
- **GPT-5 系列**：结构化输出强，对明确步骤响应好
- **Grok 4.5**：代码生成快，但指令遵循弱于 Claude/GPT

#### 3.1.2 数据结构

```typescript
interface PromptStrategy {
  kind: "verbose" | "concise" | "structured" | "custom";
  
  // System prompt 模板选择
  systemPromptTemplate?: string; 
  // 可选值: "default" | "concise-claude" | "structured-gpt" | "explicit-grok"
  
  // Few-shot examples 策略
  fewShotPolicy: {
    enabled: boolean;
    maxExamples: number; // Claude: 1-2, GPT: 2-3, Grok: 3-5
    dynamicSelection: boolean; // 根据任务类型动态选择
  };
  
  // Thinking/CoT 提示
  thinkingPrompt?: {
    enabled: boolean;
    style: "step-by-step" | "scratchpad" | "none";
  };
  
  // 角色强化（Grok 需要 heavy，Claude 可 light）
  roleEmphasis: "light" | "medium" | "heavy";
  
  // 指令格式
  instructionFormat: "natural" | "numbered" | "xml-tagged";
}
```

#### 3.1.3 Prompt 模板示例

**concise-claude.md**（利用 Claude 强推理，减少冗余）：

```markdown
You are an expert {{role}}. Complete the task using available tools.

{{#if task.plan}}
Plan (approved):
{{task.plan}}
{{/if}}

Requirements:
{{task.requirements}}

Execute efficiently. No preamble.
```

**Token 节省**：从 ~2000 降到 ~1600（20% 减少）

**structured-gpt.md**（匹配 GPT 的结构化偏好）：

```markdown
# Role: {{role}}

## Input
1. Plan: {{task.plan}}
2. Requirements: {{task.requirements}}
3. Constraints: {{task.constraints}}

## Steps
1. Read relevant files using `read` tool
2. Implement changes
3. Verify with `bash` tool
4. Return structured output

## Output Schema
{{outputSchema}}

Execute step-by-step.
```

**效果**：提升结构化输出成功率 10%

**explicit-grok.md**（Grok 需要更明确指令）：

```markdown
ROLE: You are a {{role}}. Your ONLY job is to {{roleDescription}}.

CONTEXT:
{{context}}

INSTRUCTIONS (follow exactly):
1. {{step1}}
2. {{step2}}
3. {{step3}}

TOOLS AVAILABLE:
{{tools}}

IMPORTANT:
- Use tools, do not guess
- Return valid JSON matching schema
- Do NOT add features not requested

OUTPUT FORMAT:
{{outputSchema}}

BEGIN NOW.
```

**效果**：提升指令遵循度 15-20%

#### 3.1.4 实现位置

- `packages/coding-agent/src/prompts/workflow/concise-claude.md`（新建）
- `packages/coding-agent/src/prompts/workflow/structured-gpt.md`（新建）
- `packages/coding-agent/src/prompts/workflow/explicit-grok.md`（新建）
- 修改 `packages/coding-agent/src/workflow/context-builder.ts` 根据 profile 选择模板
- 修改 `packages/coding-agent/src/workflow/runtime-adapter.ts` 在 prepareWorkflowInvocation 中应用

#### 3.1.5 预期收益

| 模型 | Token 节省 | 质量提升 |
|------|-----------|---------|
| Claude Opus | 15-20% system prompt | 保持 |
| GPT-5 系列 | 5-10% | +10% 结构化输出成功率 |
| Grok | 0%（需要详细指令） | +15-20% 指令遵循度 |

### 3.2 Per-Model 工具策略（toolStrategy）

#### 3.2.1 核心问题

**社区反馈的最大 token 浪费源**：
- 每次工具调用将**完整输出**附加到上下文
- 读取 500 行文件消耗 ~5000 token，即使只需要 10 行
- CLI 输出包含大量噪音：通过的测试、进度条、冗余格式
- 有开发者通过 CLI 代理剥离无用输出，**节省了 89% token**（10M → 1.1M）

#### 3.2.2 数据结构

```typescript
interface ToolStrategy {
  // 工具重命名（利用已有 customWireName）
  toolAliases?: Record<string, string>; 
  // 例: { "bash": "run_command" } for Grok
  
  // 参数别名（适配不同模型的参数习惯）
  argumentAliases?: Record<string, Record<string, string>>; 
  // 例: { "read": { "path": "file_path" } }
  
  // 输出截断策略（核心优化）
  outputTruncation: {
    enabled: boolean;
    rules: Array<{
      toolName: string | string[]; // "bash" | "read" | "*"
      strategy: "head" | "tail" | "smart" | "none";
      maxBytes?: number; // 默认 4000
      maxLines?: number; // 默认 50
      preservePatterns?: string[]; // 保留匹配的行（如 "ERROR", "FAIL"）
    }>;
  };
  
  // 工具结果摘要
  resultSummarization: {
    enabled: boolean;
    summarizers: Record<string, SummarizerFn>; // bash → extract exitCode + errors
  };
  
  // 并发工具调用限制
  maxConcurrentTools?: number; // Claude: 5-8, Grok: 10-15
}

type SummarizerFn = (output: string, tool: string, args: unknown) => string;
```

#### 3.2.3 内置 Summarizers

```typescript
const DEFAULT_SUMMARIZERS: Record<string, SummarizerFn> = {
  bash: (output, tool, args) => {
    const lines = output.split('\n');
    const errors = lines.filter(l => /error|fail|exception/i.test(l));
    if (errors.length > 0) {
      return `Exit code: ${exitCode}\nErrors (${errors.length}):\n${errors.slice(0, 10).join('\n')}`;
    }
    return `Exit code: 0, ${lines.length} lines output (truncated)`;
  },
  
  read: (output, tool, args) => {
    const lines = output.split('\n');
    return `Read ${args.file_path}: ${lines.length} lines, ${output.length} bytes (use 'grep' to search)`;
  },
  
  grep: (output, tool, args) => {
    const matches = output.split('\n').filter(Boolean);
    if (matches.length === 0) return "No matches";
    if (matches.length <= 10) return output;
    return `${matches.length} matches (showing first 10):\n${matches.slice(0, 10).join('\n')}`;
  },
  
  test: (output, tool, args) => {
    const passed = (output.match(/\bpass/gi) || []).length;
    const failed = (output.match(/\bfail/gi) || []).length;
    const errors = output.split('\n').filter(l => /error|fail/i.test(l));
    return `Tests: ${passed} passed, ${failed} failed\n${errors.slice(0, 5).join('\n')}`;
  },
  
  ls: (output, tool, args) => {
    const lines = output.split('\n').filter(Boolean);
    return `${lines.length} items:\n${lines.map(l => l.split(/\s+/).pop()).join('\n')}`;
  },
};
```

#### 3.2.4 Smart 截断策略

**算法**：
1. 检查输出是否包含错误模式（ERROR, FAIL, Exception, Traceback）
2. 如果有错误：保留错误上下文（前后 3 行）
3. 如果无错误：保留头部 + 尾部，中间省略

```typescript
function smartTruncate(output: string, maxBytes: number): string {
  if (output.length <= maxBytes) return output;
  
  const lines = output.split('\n');
  const errorLines: number[] = [];
  
  // 查找错误行
  lines.forEach((line, idx) => {
    if (/error|fail|exception|traceback/i.test(line)) {
      errorLines.push(idx);
    }
  });
  
  if (errorLines.length > 0) {
    // 保留错误上下文
    const preserved = new Set<number>();
    errorLines.forEach(idx => {
      for (let i = Math.max(0, idx - 3); i <= Math.min(lines.length - 1, idx + 3); i++) {
        preserved.add(i);
      }
    });
    const result = lines.filter((_, idx) => preserved.has(idx)).join('\n');
    if (result.length <= maxBytes) return result;
  }
  
  // 否则保留头尾
  const headLines = lines.slice(0, 20).join('\n');
  const tailLines = lines.slice(-20).join('\n');
  return `${headLines}\n\n... [${lines.length - 40} lines omitted] ...\n\n${tailLines}`;
}
```

#### 3.2.5 工具别名实现

当前 `ModelProfile` 已定义但标记为 UNSUPPORTED：
- `toolAliases: Record<string, string>` 
- `argumentAliases: Record<string, Record<string, string>>`

**实现**：

```typescript
// packages/coding-agent/src/workflow/runtime-adapter.ts

function transformToolsForProfile(tools: AgentTool[], profile: ModelProfile): AgentTool[] {
  return tools.map(tool => {
    const alias = profile.toolAliases?.[tool.name];
    const argAliases = profile.argumentAliases?.[tool.name];
    
    return {
      ...tool,
      customWireName: alias || tool.customWireName, // 利用已有机制
      schema: argAliases ? remapSchemaProperties(tool.schema, argAliases) : tool.schema,
    };
  });
}

function remapSchemaProperties(
  schema: JSONSchema, 
  aliases: Record<string, string>
): JSONSchema {
  if (schema.type !== "object" || !schema.properties) return schema;
  
  const remapped: Record<string, any> = {};
  for (const [oldKey, prop] of Object.entries(schema.properties)) {
    const newKey = aliases[oldKey] || oldKey;
    remapped[newKey] = prop;
  }
  
  return { ...schema, properties: remapped };
}
```

#### 3.2.6 实现位置

- `packages/coding-agent/src/workflow/tool-output-manager.ts`（新建）
- `packages/coding-agent/src/workflow/runtime-adapter.ts`（修改）
- `packages/coding-agent/src/task/executor.ts`（集成）
- `packages/coding-agent/src/workflow/model-profile-registry.ts`（移除 UNSUPPORTED 限制）

#### 3.2.7 预期收益

| 优化点 | Token 节省 | 数据来源 |
|--------|-----------|---------|
| 工具输出截断 | 60-89% | 社区案例 |
| Bash 输出摘要 | 70-80% | 典型测试日志 |
| Read 文件摘要 | 50-70% | 500 行文件场景 |
| 并发限制 | 避免窗口爆满 | 小模型保护 |
| 工具别名 | +5-10% 成功率 | 减少参数错误 |

**综合效果**：在典型 workflow 中节省 **40-60% 工具相关 token**

### 3.3 Per-Model 上下文策略（contextStrategy）

#### 3.3.1 设计目标

不同模型的上下文窗口差异巨大：
- **Sonnet 4.6**: 20 万 token → 需要激进管理
- **Opus 4.8 / GPT-5.5**: 100 万 token → 宽松策略
- **Grok 4.5**: 200 万 token → 几乎不限制

#### 3.3.2 数据结构

```typescript
interface ContextStrategy {
  // 窗口利用率目标
  targetUtilization: number; // 0.7 = 70% 利用率，留 30% buffer
  
  // Repo-map 策略（借鉴 Aider）
  repoMap: {
    enabled: boolean;
    maxFiles: number; // 小模型: 5-8, 大模型: 15-20
    strategy: "full-content" | "symbols-only" | "hybrid";
  };
  
  // 上下文驱逐策略（借鉴 CWL 论文）
  eviction: {
    enabled: boolean;
    preserveUserTurns: boolean; // 始终保留用户直接指令
    evictPersisted: boolean; // 驱逐已持久化的动作（文件已写入）
    keepRecentN: number; // 保留最近 N 轮
  };
  
  // Artifact 包含策略
  artifactInclusion: {
    includePlan: boolean; // 小模型可能跳过完整 plan，只用摘要
    includeReviewFindings: boolean;
    includeVerification: boolean;
    maxArtifactBytes: number; // 单个 artifact 最大字节数
  };
  
  // 工具历史保留
  toolHistory: {
    maxToolCalls: number; // 小模型: 5, 大模型: 10-15
    summarizeOld: boolean; // 旧工具调用用摘要替代
  };
}
```

#### 3.3.3 Repo-Map 实现（借鉴 Aider）

**原理**：
1. 用 tree-sitter 或 ctags 提取符号（函数、类、导入）
2. 构建调用图（哪些文件调用哪些）
3. 用 PageRank 对文件重要性评分
4. 只发送 top-k 相关文件的完整内容，其余用符号签名代替

**数据结构**：

```typescript
// packages/coding-agent/src/workflow/repo-map-builder.ts (新建)

interface RepoMapEntry {
  path: string;
  symbols: Array<{ 
    name: string; 
    type: "function" | "class" | "interface" | "variable"; 
    line: number;
    signature?: string; // 函数签名
  }>;
  importance: number; // PageRank 分数 (0-1)
}

interface RepoMapOptions {
  cwd: string;
  relevantFiles: string[]; // 用户明确提到的文件
  maxFiles: number;
  strategy: "full-content" | "symbols-only" | "hybrid";
}

async function buildRepoMap(opts: RepoMapOptions): Promise<string> {
  // 1. 提取符号
  const symbolGraph = await extractSymbols(opts.cwd);
  
  // 2. 构建调用图
  const callGraph = buildCallGraph(symbolGraph);
  
  // 3. PageRank 排序
  const ranked = pageRankFiles(callGraph, opts.relevantFiles);
  
  // 4. 选择 top-k
  const selected = ranked.slice(0, opts.maxFiles);
  
  // 5. 渲染
  return renderRepoMap(selected, opts.strategy);
}

function renderRepoMap(entries: RepoMapEntry[], strategy: string): string {
  if (strategy === "symbols-only") {
    return entries.map(e => 
      `${e.path}:\n${e.symbols.map(s => 
        `  ${s.type} ${s.name}${s.signature || ''} (L${s.line})`
      ).join('\n')}`
    ).join('\n\n');
  }
  
  if (strategy === "hybrid") {
    // Top 3 文件完整内容，其余符号签名
    const topFiles = entries.slice(0, 3).map(e => 
      `${e.path}:\n[FULL CONTENT - use 'read' tool to access]`
    );
    const restSymbols = entries.slice(3).map(e => 
      `${e.path}:\n${e.symbols.map(s => `  ${s.type} ${s.name}`).join('\n')}`
    );
    return [...topFiles, ...restSymbols].join('\n\n');
  }
  
  // full-content: 只列出文件路径，让模型用 read 工具
  return entries.map(e => e.path).join('\n');
}
```

**集成 tree-sitter**：

```typescript
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import Python from "tree-sitter-python";

async function extractSymbols(cwd: string): Promise<SymbolGraph> {
  const parser = new Parser();
  const files = await findSourceFiles(cwd); // *.ts, *.py, *.js
  
  const symbols: SymbolGraph = new Map();
  
  for (const file of files) {
    const content = await Bun.file(file).text();
    const ext = path.extname(file);
    
    if (ext === ".ts" || ext === ".tsx") {
      parser.setLanguage(TypeScript.typescript);
    } else if (ext === ".py") {
      parser.setLanguage(Python);
    } else {
      continue; // 不支持的语言
    }
    
    const tree = parser.parse(content);
    const extracted = extractFromTree(tree, content);
    symbols.set(file, extracted);
  }
  
  return symbols;
}

function extractFromTree(tree: Parser.Tree, content: string): Symbol[] {
  const symbols: Symbol[] = [];
  
  const cursor = tree.walk();
  
  function visit(node: Parser.SyntaxNode) {
    if (node.type === "function_declaration" || node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text;
      const params = node.childForFieldName("parameters")?.text;
      if (name) {
        symbols.push({
          name,
          type: "function",
          line: node.startPosition.row + 1,
          signature: params ? `${name}${params}` : undefined,
        });
      }
    } else if (node.type === "class_declaration" || node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        symbols.push({ name, type: "class", line: node.startPosition.row + 1 });
      }
    }
    
    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i)!);
    }
  }
  
  visit(cursor.currentNode());
  return symbols;
}
```

#### 3.3.4 上下文驱逐实现（借鉴 CWL 论文）

**核心思想**：
- **保留**：用户回合、活跃探索上下文（当前任务相关）
- **驱逐**：已持久化的动作片段（文件已写入、测试已通过）

```typescript
// packages/coding-agent/src/workflow/context-evictor.ts (新建)

interface ContextSegment {
  id: string;
  type: "user" | "tool" | "assistant" | "artifact";
  persisted: boolean; // 效果已持久化（文件写入、测试通过）
  turnIndex: number;
  tokens: number;
  content: string;
}

function evictContext(
  segments: ContextSegment[],
  strategy: ContextStrategy,
  currentTokens: number,
  maxTokens: number,
): ContextSegment[] {
  const targetTokens = maxTokens * strategy.targetUtilization;
  
  if (currentTokens < targetTokens) {
    return segments; // 未超限
  }
  
  const toKeep: ContextSegment[] = [];
  const toEvict: ContextSegment[] = [];
  
  for (const seg of segments) {
    // 始终保留用户回合
    if (seg.type === "user" && strategy.eviction.preserveUserTurns) {
      toKeep.push(seg);
      continue;
    }
    
    // 保留最近 N 轮
    const recentCutoff = segments.length - strategy.eviction.keepRecentN;
    if (seg.turnIndex >= recentCutoff) {
      toKeep.push(seg);
      continue;
    }
    
    // 驱逐已持久化的工具调用
    if (seg.type === "tool" && seg.persisted && strategy.eviction.evictPersisted) {
      toEvict.push(seg);
      continue;
    }
    
    toKeep.push(seg);
  }
  
  // 如果还是超限，进一步驱逐旧的 assistant 回合
  let keptTokens = toKeep.reduce((sum, s) => sum + s.tokens, 0);
  if (keptTokens > targetTokens) {
    const sorted = [...toKeep].sort((a, b) => a.turnIndex - b.turnIndex);
    const finalKeep: ContextSegment[] = [];
    
    for (const seg of sorted.reverse()) {
      if (keptTokens <= targetTokens) break;
      if (seg.type === "assistant" && seg.turnIndex < recentCutoff) {
        keptTokens -= seg.tokens;
        continue; // 跳过这个 segment
      }
      finalKeep.push(seg);
    }
    
    return finalKeep.reverse();
  }
  
  return toKeep;
}

function markPersistedSegments(segments: ContextSegment[]): ContextSegment[] {
  return segments.map(seg => {
    if (seg.type !== "tool") return seg;
    
    // 检查工具调用是否持久化
    const isPersisted = 
      seg.content.includes("write") || // 文件写入
      seg.content.includes("edit") ||  // 文件编辑
      (seg.content.includes("bash") && seg.content.includes("exit code: 0")); // 成功执行
    
    return { ...seg, persisted: isPersisted };
  });
}
```

#### 3.3.5 实现位置

- `packages/coding-agent/src/workflow/repo-map-builder.ts`（新建）
- `packages/coding-agent/src/workflow/context-evictor.ts`（新建）
- `packages/coding-agent/src/workflow/context-builder.ts`（修改，集成 repo-map）
- `packages/coding-agent/src/workflow/runtime-adapter.ts`（修改，调用驱逐逻辑）
- `package.json`（添加 tree-sitter 依赖）

#### 3.3.6 预期收益

| 模型 | 策略 | Token 节省 | 窗口利用率 |
|------|------|-----------|-----------|
| Sonnet 4.6 (20万) | repo-map + 激进驱逐 | 30-40% | 70% |
| Opus 4.8 (100万) | 宽松驱逐 | 15-20% | 60-70% |
| Grok 4.5 (200万) | 几乎不驱逐 | 5-10% | 50% |

**综合效果**：
- 小模型可以处理更复杂任务（原本会爆窗口）
- 大模型减少无关上下文干扰，提升响应质量
- 避免"上下文窗口已满"导致的任务失败

### 3.4 Per-Model 输出策略（outputStrategy）

#### 3.4.1 设计目标

不同模型的结构化输出能力差异：
- **GPT**：原生支持 strict mode，schema 遵循强
- **Claude**：需要更多 schema 描述和示例
- **Grok**：需要明确的输出格式提示

#### 3.4.2 数据结构

```typescript
interface OutputStrategy {
  // Schema 增强
  schemaEnhancement: {
    addDescriptions: boolean; // Claude/Grok 需要详细描述
    addExamples: boolean; // Grok 需要示例
    strictMode: boolean; // GPT 启用 strict mode
  };
  
  // 输出前缀提示
  outputPrefixPrompt?: string; // "Output valid JSON:" for Grok
  
  // 重试策略
  retryOnSchemaViolation: {
    enabled: boolean;
    maxRetries: number; // GPT: 1, Claude: 2, Grok: 3
    includeErrorInRetry: boolean; // 将 schema 错误反馈给模型
  };
}
```

#### 3.4.3 Schema 增强实现

```typescript
// packages/coding-agent/src/workflow/schema-enhancer.ts (新建)

function enhanceSchemaForProfile(
  schema: JSONSchema,
  profile: ModelProfile,
): JSONSchema {
  if (!profile.outputStrategy?.schemaEnhancement) return schema;
  
  const { addDescriptions, addExamples, strictMode } = profile.outputStrategy.schemaEnhancement;
  
  let enhanced = { ...schema };
  
  if (addDescriptions) {
    enhanced = addDetailedDescriptions(enhanced);
  }
  
  if (addExamples) {
    enhanced = addInlineExamples(enhanced);
  }
  
  if (strictMode) {
    enhanced = { ...enhanced, additionalProperties: false, strict: true };
  }
  
  return enhanced;
}

function addDetailedDescriptions(schema: JSONSchema): JSONSchema {
  if (schema.type === "object" && schema.properties) {
    return {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(schema.properties).map(([key, prop]) => {
          const enhanced = {
            ...prop,
            description: prop.description || generateDescription(key, prop),
          };
          
          // 递归处理嵌套对象
          if (prop.type === "object") {
            return [key, addDetailedDescriptions(enhanced)];
          }
          
          return [key, enhanced];
        }),
      ),
    };
  }
  return schema;
}

function generateDescription(key: string, prop: any): string {
  const typeDesc = Array.isArray(prop.type) ? prop.type.join(" or ") : prop.type;
  return `The ${key} field (${typeDesc})`;
}

function addInlineExamples(schema: JSONSchema): JSONSchema {
  if (schema.type === "object" && schema.properties) {
    const examples: Record<string, any> = {};
    
    for (const [key, prop] of Object.entries(schema.properties)) {
      examples[key] = generateExample(prop);
    }
    
    return {
      ...schema,
      examples: [examples],
    };
  }
  return schema;
}

function generateExample(prop: any): any {
  switch (prop.type) {
    case "string": return prop.enum ? prop.enum[0] : "example";
    case "number": return 42;
    case "integer": return 1;
    case "boolean": return true;
    case "array": return [generateExample(prop.items || {})];
    case "object": return {};
    default: return null;
  }
}
```

#### 3.4.4 重试逻辑

```typescript
// packages/coding-agent/src/workflow/runtime-adapter.ts

async function runWithSchemaRetry<T>(
  profile: ModelProfile,
  request: WorkflowAgentRequest,
  runFn: () => Promise<T>,
): Promise<T> {
  const { retryOnSchemaViolation } = profile.outputStrategy || {};
  
  if (!retryOnSchemaViolation?.enabled) {
    return await runFn();
  }
  
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < retryOnSchemaViolation.maxRetries; attempt++) {
    try {
      return await runFn();
    } catch (error) {
      if (!(error instanceof SchemaViolationError)) {
        throw error; // 非 schema 错误直接抛出
      }
      
      lastError = error;
      
      if (retryOnSchemaViolation.includeErrorInRetry && attempt < retryOnSchemaViolation.maxRetries - 1) {
        // 将错误反馈给模型
        request.context += `\n\n[RETRY ${attempt + 1}] Previous output violated schema: ${error.message}\nPlease fix and output valid JSON.`;
      }
    }
  }
  
  throw lastError;
}
```

#### 3.4.5 实现位置

- `packages/coding-agent/src/workflow/schema-enhancer.ts`（新建）
- `packages/coding-agent/src/workflow/runtime-adapter.ts`（修改，集成重试）
- `packages/coding-agent/src/workflow/types.ts`（添加 OutputStrategy）

#### 3.4.6 预期收益

| 模型 | 优化点 | 效果 |
|------|-------|------|
| GPT | strict mode | -30-50% schema violation |
| Claude | 详细描述 | +15-20% 首次正确率 |
| Grok | 示例 + 明确提示 | +25-35% 成功率 |

---

## 4. 默认 Profile 配置

### 设计原则

**质量优先，平衡成本**：
1. **规划和审查阶段**：使用最高质量模型（**Fable 5 首选**，Opus 4.8, GPT-5.6-sol）
2. **实现阶段**：在质量差距 <5% 时，优先成本效益（Sonnet 5, Grok 4.5）
3. **快速迭代**：简单任务根据质量要求选择（Sonnet 5 或 DeepSeek V4）
4. **允许降级**：质量降低 <3% 且成本节省 >50% 时可接受

**Fallback 策略**：
- Fable 5 失败 → Opus 4.8（同级顶级质量）→ Sonnet 5
- 质量关键阶段禁止自动降级到低质量模型

---

### 4.1 Claude Fable 5 - Claude 历代最强（首选规划/审查）

```typescript
const claude_fable_planner: ModelProfile = {
  id: "claude_fable_planner",
  vendor: "anthropic",
  modelPattern: "claude-fable-5",
  roles: ["planner", "plan_reviewer", "code_reviewer"], // 最关键阶段
  
  promptStrategy: {
    kind: "concise",
    systemPromptTemplate: "concise-claude",
    fewShotPolicy: { enabled: true, maxExamples: 1, dynamicSelection: true },
    thinkingPrompt: { enabled: true, style: "scratchpad" },
    roleEmphasis: "light", // Fable 5 推理极强，无需过度强调
    instructionFormat: "natural",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 4000 },
        { toolName: "read", strategy: "smart", maxLines: 100 },
        { toolName: "test", strategy: "smart", maxBytes: 3000, preservePatterns: ["FAIL", "ERROR"] },
        { toolName: "*", strategy: "head", maxBytes: 2000 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 8,
  },
  
  contextStrategy: {
    targetUtilization: 0.75, // 20 万窗口，需要管理
    repoMap: { 
      enabled: true, // 启用 repo-map 节省 token
      maxFiles: 12, 
      strategy: "hybrid" 
    },
    eviction: { 
      enabled: true, 
      preserveUserTurns: true, 
      evictPersisted: true, 
      keepRecentN: 10 
    },
    artifactInclusion: { 
      includePlan: true, 
      includeReviewFindings: true, 
      includeVerification: true,
      maxArtifactBytes: 50000 
    },
    toolHistory: { maxToolCalls: 10, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { addDescriptions: true, addExamples: false, strictMode: false },
    retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
  },
  
  runtime: { kind: "claude_cli" },
  thinkingLevel: "high",
  promptTemplate: "workflow/planner",
  promptVersion: "v1",
  toolPolicyId: "readonly-planning",
  maxRequests: 20,
  maxRuntimeMs: 600000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient", "timeout"],
    fallbackProfileIds: ["claude_opus_planner", "gpt_sol_planner"], // Opus 4.8 作为同级备选
  },
  contextPolicy: {
    includePlan: true,
    includeReviewFindings: true,
    includeVerification: true,
    includeFullTranscript: false,
    maxArtifactBytes: 50000,
  },
};
```

**使用场景**：
- **首选**：Planning, Plan Review, Code Review（质量关键阶段）
- **优势**：Claude 历代最强推理，复杂架构设计、多步骤推理
- **Trade-off**：20 万窗口需要 repo-map + 上下文驱逐，但推理质量值得

---

### 4.2 Claude Opus 4.8 - 长上下文顶级质量（复杂场景备选）

```typescript
const claude_opus_planner: ModelProfile = {
  id: "claude_opus_planner",
  vendor: "anthropic",
  modelPattern: "claude-opus-4-8",
  roles: ["planner", "plan_reviewer", "code_reviewer"],
  
  promptStrategy: {
    kind: "concise",
    systemPromptTemplate: "concise-claude",
    fewShotPolicy: { enabled: true, maxExamples: 1, dynamicSelection: true },
    thinkingPrompt: { enabled: true, style: "scratchpad" },
    roleEmphasis: "light",
    instructionFormat: "natural",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 4000 },
        { toolName: "read", strategy: "smart", maxLines: 120 },
        { toolName: "test", strategy: "smart", maxBytes: 3000, preservePatterns: ["FAIL", "ERROR"] },
        { toolName: "*", strategy: "head", maxBytes: 2000 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 10,
  },
  
  contextStrategy: {
    targetUtilization: 0.65, // 100 万窗口，宽松利用
    repoMap: { enabled: false, maxFiles: 20, strategy: "full-content" }, // 大窗口不需要 repo-map
    eviction: { 
      enabled: true, 
      preserveUserTurns: true, 
      evictPersisted: true, 
      keepRecentN: 15 
    },
    artifactInclusion: { 
      includePlan: true, 
      includeReviewFindings: true, 
      includeVerification: true,
      maxArtifactBytes: 60000 
    },
    toolHistory: { maxToolCalls: 12, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { addDescriptions: true, addExamples: false, strictMode: false },
    retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
  },
  
  runtime: { kind: "claude_cli" },
  thinkingLevel: "high",
  promptTemplate: "workflow/planner",
  promptVersion: "v1",
  toolPolicyId: "readonly-planning",
  maxRequests: 20,
  maxRuntimeMs: 600000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient", "timeout"],
    fallbackProfileIds: ["claude_fable_planner", "claude_sonnet_planner"], // Fable 5 作为首选备选
  },
  contextPolicy: {
    includePlan: true,
    includeReviewFindings: true,
    includeVerification: true,
    includeFullTranscript: false,
    maxArtifactBytes: 60000,
  },
};
```

**使用场景**：
- **备选**：当 Fable 5 窗口不够或需要完整代码库上下文时
- **优势**：100 万窗口，可加载更多文件完整内容
- **Trade-off**：推理质量与 Fable 5 同级，但成本可能略高

---

### 4.3 Claude Sonnet 5 - 性价比之王（通用实现/审查）

```typescript
const claude_opus_planner: ModelProfile = {
  id: "claude_opus_planner",
  vendor: "anthropic",
  modelPattern: "claude-opus-4-8",
  roles: ["planner", "plan_reviewer", "code_reviewer"],
  
  promptStrategy: {
    kind: "concise",
    systemPromptTemplate: "concise-claude",
    fewShotPolicy: { enabled: true, maxExamples: 1, dynamicSelection: true },
    thinkingPrompt: { enabled: true, style: "scratchpad" },
    roleEmphasis: "light",
    instructionFormat: "natural",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 4000 },
        { toolName: "read", strategy: "smart", maxLines: 100 },
        { toolName: "test", strategy: "smart", maxBytes: 3000, preservePatterns: ["FAIL", "ERROR"] },
        { toolName: "*", strategy: "head", maxBytes: 2000 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 8,
  },
  
  contextStrategy: {
    targetUtilization: 0.7, // 100 万窗口，宽松利用
    repoMap: { enabled: false, maxFiles: 15, strategy: "full-content" },
    eviction: { 
      enabled: true, 
      preserveUserTurns: true, 
      evictPersisted: true, 
      keepRecentN: 10 
    },
    artifactInclusion: { 
      includePlan: true, 
      includeReviewFindings: true, 
      includeVerification: true,
      maxArtifactBytes: 50000 
    },
    toolHistory: { maxToolCalls: 10, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { addDescriptions: true, addExamples: false, strictMode: false },
    retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
  },
  
  runtime: { kind: "claude_cli" },
  thinkingLevel: "high",
  promptTemplate: "workflow/planner",
  promptVersion: "v1",
  toolPolicyId: "readonly-planning",
  maxRequests: 20,
  maxRuntimeMs: 600000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient", "timeout"],
    fallbackProfileIds: ["claude_sonnet_planner"], // 同厂商次优
  },
  contextPolicy: {
    includePlan: true,
    includeReviewFindings: true,
    includeVerification: true,
    includeFullTranscript: false,
    maxArtifactBytes: 50000,
  },
};
```

---

### 4.2 Claude Sonnet 5 - 性价比之王（通用审查）

```typescript
const claude_sonnet_reviewer: ModelProfile = {
  id: "claude_sonnet_reviewer",
  vendor: "anthropic",
  modelPattern: "claude-sonnet-5",
  roles: ["plan_reviewer", "code_reviewer", "repair"],
  
  promptStrategy: {
    kind: "concise",
    systemPromptTemplate: "concise-claude",
    fewShotPolicy: { enabled: true, maxExamples: 2, dynamicSelection: true },
    roleEmphasis: "medium",
    instructionFormat: "natural",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 3000 },
        { toolName: "read", strategy: "smart", maxLines: 50 },
        { toolName: "*", strategy: "head", maxBytes: 1500 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 5, // 20 万窗口，限制并发
  },
  
  contextStrategy: {
    targetUtilization: 0.75, // 小窗口需激进管理
    repoMap: { 
      enabled: true, // 启用 repo-map 节省 token
      maxFiles: 8, 
      strategy: "hybrid" 
    },
    eviction: { 
      enabled: true, 
      preserveUserTurns: true, 
      evictPersisted: true, 
      keepRecentN: 8 
    },
    artifactInclusion: { 
      includePlan: true, 
      includeReviewFindings: true, 
      includeVerification: true,
      maxArtifactBytes: 30000 
    },
    toolHistory: { maxToolCalls: 8, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { addDescriptions: true, addExamples: false, strictMode: false },
    retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
  },
  
  runtime: { kind: "claude_cli" },
  thinkingLevel: "medium",
  promptTemplate: "workflow/reviewer",
  promptVersion: "v1",
  toolPolicyId: "readonly-review",
  maxRequests: 30,
  maxRuntimeMs: 300000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient"],
    fallbackProfileIds: ["gpt_sol_reviewer", "claude_fable_reviewer"],
  },
  contextPolicy: {
    includePlan: true,
    includeReviewFindings: true,
    includeVerification: true,
    includeFullTranscript: false,
    maxArtifactBytes: 30000,
  },
};
```

---

### 4.3 Claude Fable 5 - 快速原型（简单任务）

```typescript
const claude_fable_quick: ModelProfile = {
  id: "claude_fable_quick",
  vendor: "anthropic",
  modelPattern: "claude-fable-5",
  roles: ["repair"], // 仅用于简单修复
  
  promptStrategy: {
    kind: "concise",
    systemPromptTemplate: "concise-claude",
    fewShotPolicy: { enabled: true, maxExamples: 3, dynamicSelection: true }, // 更多示例补偿推理
    roleEmphasis: "heavy", // 需要强调
    instructionFormat: "numbered",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "*", strategy: "head", maxBytes: 1000 }, // 激进截断
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 3,
  },
  
  contextStrategy: {
    targetUtilization: 0.8, // 小窗口高利用
    repoMap: { enabled: true, maxFiles: 5, strategy: "symbols-only" },
    eviction: { enabled: true, preserveUserTurns: true, evictPersisted: true, keepRecentN: 5 },
    artifactInclusion: { includePlan: false, includeReviewFindings: true, maxArtifactBytes: 10000 },
    toolHistory: { maxToolCalls: 5, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { addDescriptions: true, addExamples: true, strictMode: false },
    retryOnSchemaViolation: { enabled: true, maxRetries: 3, includeErrorInRetry: true },
  },
  
  runtime: { kind: "claude_cli" },
  thinkingLevel: "low",
  promptTemplate: "workflow/repair",
  promptVersion: "v1",
  toolPolicyId: "scoped-repair",
  maxRequests: 50,
  maxRuntimeMs: 180000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient", "schema_violation"],
    fallbackProfileIds: ["claude_sonnet_repair"],
  },
};
```

---

### 4.4 GPT-5.6-sol - 精确结构化（规划）

```typescript
const gpt_sol_planner: ModelProfile = {
  id: "gpt_sol_planner",
  vendor: "openai",
  modelPattern: "gpt-5.6-sol",
  roles: ["planner", "plan_reviewer"],
  
  promptStrategy: {
    kind: "structured",
    systemPromptTemplate: "structured-gpt",
    fewShotPolicy: { enabled: true, maxExamples: 2, dynamicSelection: true },
    roleEmphasis: "medium",
    instructionFormat: "numbered",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 3000 },
        { toolName: "read", strategy: "smart", maxLines: 60 },
        { toolName: "*", strategy: "head", maxBytes: 1500 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 6,
  },
  
  contextStrategy: {
    targetUtilization: 0.75, // 128K 窗口需管理
    repoMap: { enabled: true, maxFiles: 10, strategy: "hybrid" },
    eviction: { enabled: true, preserveUserTurns: true, evictPersisted: true, keepRecentN: 8 },
    artifactInclusion: { includePlan: true, includeReviewFindings: true, maxArtifactBytes: 25000 },
    toolHistory: { maxToolCalls: 8, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { 
      addDescriptions: false, 
      addExamples: false, 
      strictMode: true // GPT strict mode
    },
    retryOnSchemaViolation: { 
      enabled: true, 
      maxRetries: 1, 
      includeErrorInRetry: false 
    },
  },
  
  runtime: { kind: "codex_cli", profile: "cli" },
  thinkingLevel: "high",
  promptTemplate: "workflow/planner",
  promptVersion: "v1",
  toolPolicyId: "readonly-planning",
  maxRequests: 20,
  maxRuntimeMs: 400000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient", "timeout"],
    fallbackProfileIds: ["gpt_terra_planner", "claude_opus_planner"],
  },
};
```

---

### 4.5 GPT-5.6-terra - 长上下文（复杂分析）

```typescript
const gpt_terra_analyzer: ModelProfile = {
  id: "gpt_terra_analyzer",
  vendor: "openai",
  modelPattern: "gpt-5.6-terra",
  roles: ["planner", "code_reviewer"],
  
  promptStrategy: {
    kind: "structured",
    systemPromptTemplate: "structured-gpt",
    fewShotPolicy: { enabled: true, maxExamples: 2, dynamicSelection: true },
    roleEmphasis: "medium",
    instructionFormat: "numbered",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 5000 },
        { toolName: "read", strategy: "smart", maxLines: 120 },
        { toolName: "*", strategy: "head", maxBytes: 3000 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 10,
  },
  
  contextStrategy: {
    targetUtilization: 0.65, // 100 万+窗口，宽松
    repoMap: { enabled: false, maxFiles: 20, strategy: "full-content" },
    eviction: { enabled: true, preserveUserTurns: true, evictPersisted: true, keepRecentN: 12 },
    artifactInclusion: { includePlan: true, includeReviewFindings: true, maxArtifactBytes: 60000 },
    toolHistory: { maxToolCalls: 12, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { addDescriptions: false, addExamples: false, strictMode: true },
    retryOnSchemaViolation: { enabled: true, maxRetries: 1, includeErrorInRetry: false },
  },
  
  runtime: { kind: "codex_cli", profile: "cli" },
  thinkingLevel: "medium",
  promptTemplate: "workflow/reviewer",
  promptVersion: "v1",
  toolPolicyId: "readonly-review",
  maxRequests: 25,
  maxRuntimeMs: 500000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient"],
    fallbackProfileIds: ["claude_opus_reviewer"],
  },
};
```

---

### 4.6 Grok 4.5 - 高性价比实现

```typescript
const grok_implementer: ModelProfile = {
  id: "grok_implementer",
  vendor: "xai",
  modelPattern: "grok-4.5",
  roles: ["implementer", "repair"],
  
  promptStrategy: {
    kind: "verbose",
    systemPromptTemplate: "explicit-grok",
    fewShotPolicy: { enabled: true, maxExamples: 3, dynamicSelection: true },
    thinkingPrompt: { enabled: true, style: "step-by-step" },
    roleEmphasis: "heavy", // Grok 需要强调
    instructionFormat: "numbered",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 5000 },
        { toolName: "read", strategy: "smart", maxLines: 150 },
        { toolName: "*", strategy: "head", maxBytes: 3000 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 15, // 200 万窗口可并发
  },
  
  contextStrategy: {
    targetUtilization: 0.5, // 200 万窗口，宽松
    repoMap: { enabled: false, maxFiles: 20, strategy: "full-content" },
    eviction: { enabled: false, preserveUserTurns: true, evictPersisted: false, keepRecentN: 20 },
    artifactInclusion: { includePlan: true, includeReviewFindings: true, maxArtifactBytes: 100000 },
    toolHistory: { maxToolCalls: 15, summarizeOld: false },
  },
  
  outputStrategy: {
    schemaEnhancement: { 
      addDescriptions: true, 
      addExamples: true, // Grok 需要示例
      strictMode: false 
    },
    outputPrefixPrompt: "Output valid JSON matching the schema:",
    retryOnSchemaViolation: { enabled: true, maxRetries: 3, includeErrorInRetry: true },
  },
  
  runtime: { kind: "codex_cli", profile: "grok" },
  thinkingLevel: "medium",
  promptTemplate: "workflow/implementer",
  promptVersion: "v1",
  toolPolicyId: "scoped-implementation",
  maxRequests: 40,
  maxRuntimeMs: 800000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient", "schema_violation"],
    fallbackProfileIds: ["deepseek_implementer", "claude_sonnet_implementer"],
  },
};
```

---

### 4.7 GLM-5.2 - 中文优化（本地化）

```typescript
const glm_implementer: ModelProfile = {
  id: "glm_implementer",
  vendor: "zhipu",
  modelPattern: "glm-5.2",
  roles: ["implementer", "repair"],
  
  promptStrategy: {
    kind: "structured",
    systemPromptTemplate: "structured-gpt", // 复用 GPT 模板
    fewShotPolicy: { enabled: true, maxExamples: 3, dynamicSelection: true },
    roleEmphasis: "medium",
    instructionFormat: "numbered",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 3000 },
        { toolName: "read", strategy: "smart", maxLines: 80 },
        { toolName: "*", strategy: "head", maxBytes: 2000 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 6,
  },
  
  contextStrategy: {
    targetUtilization: 0.75, // 128K 窗口
    repoMap: { enabled: true, maxFiles: 10, strategy: "hybrid" },
    eviction: { enabled: true, preserveUserTurns: true, evictPersisted: true, keepRecentN: 8 },
    artifactInclusion: { includePlan: true, includeReviewFindings: true, maxArtifactBytes: 30000 },
    toolHistory: { maxToolCalls: 8, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { addDescriptions: true, addExamples: true, strictMode: false },
    retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
  },
  
  runtime: { kind: "embedded" },
  thinkingLevel: "medium",
  promptTemplate: "workflow/implementer",
  promptVersion: "v1",
  toolPolicyId: "scoped-implementation",
  maxRequests: 35,
  maxRuntimeMs: 600000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient", "schema_violation"],
    fallbackProfileIds: ["grok_implementer"],
  },
};
```

---

### 4.8 DeepSeek V4 Pro - 极致性价比（批量任务）

```typescript
const deepseek_implementer: ModelProfile = {
  id: "deepseek_implementer",
  vendor: "deepseek",
  modelPattern: "deepseek-v4-pro",
  roles: ["implementer", "repair"],
  
  promptStrategy: {
    kind: "structured",
    systemPromptTemplate: "structured-gpt",
    fewShotPolicy: { enabled: true, maxExamples: 4, dynamicSelection: true }, // 更多示例
    thinkingPrompt: { enabled: true, style: "step-by-step" },
    roleEmphasis: "heavy", // 需要强调
    instructionFormat: "numbered",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 3000 },
        { toolName: "read", strategy: "smart", maxLines: 70 },
        { toolName: "*", strategy: "head", maxBytes: 1500 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 6,
  },
  
  contextStrategy: {
    targetUtilization: 0.8, // 128K 窗口需高利用
    repoMap: { enabled: true, maxFiles: 8, strategy: "symbols-only" },
    eviction: { enabled: true, preserveUserTurns: true, evictPersisted: true, keepRecentN: 6 },
    artifactInclusion: { includePlan: true, includeReviewFindings: true, maxArtifactBytes: 20000 },
    toolHistory: { maxToolCalls: 6, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { addDescriptions: true, addExamples: true, strictMode: false },
    retryOnSchemaViolation: { enabled: true, maxRetries: 3, includeErrorInRetry: true },
  },
  
  runtime: { kind: "embedded" },
  thinkingLevel: "medium",
  promptTemplate: "workflow/implementer",
  promptVersion: "v1",
  toolPolicyId: "scoped-implementation",
  maxRequests: 50,
  maxRuntimeMs: 600000,
  retryPolicy: {
    maxAttempts: 3,
    retryableErrorKinds: ["provider_transient", "schema_violation"],
    fallbackProfileIds: ["grok_implementer", "glm_implementer"],
  },
};
```

---

### 4.9 模型选择矩阵（基于真实用户反馈）

| 阶段 | 首选模型 | Fallback 1 | Fallback 2 | 原因 |
|------|---------|-----------|-----------|------|
| **Planning** | **Fable 5** | **GPT-5.6-sol** | GLM-5.2 | Fable 最强长周期任务，Sol agent 能力第一 |
| **Plan Review** | **GPT-5.6-sol** | **Fable 5** | GLM-5.2 | Sol 结构化验证强（91.9% Terminal-Bench） |
| **Implementation** | **GLM-5.2** | Grok 4.5 | Terra | GLM "接近 Opus 质量但零头价格" |
| **Code Review** | **Fable 5** | **GPT-5.6-sol** | GLM-5.2 | **质量最关键，Fable 最强** |
| **Simple Repair** | Grok 4.5 | GLM-5.2 | Terra | 速度 + 成本优先 |
| **Complex Repair** | **GPT-5.6-sol** | **Fable 5** | GLM-5.2 | Sol "跟进更好，处理混乱仓库" |
| **Long Context** | Terra | Opus 4.8 | Grok 4.5 | Terra 100 万+窗口，价格仅 Opus 一半 |

**Opus 4.8 和 Sonnet 5 为什么降级？**
- **Opus 4.8**：用户反馈"bug 率高于 4.7"，"忽略明确指令"，"token 消耗量大单任务超 $28"
- **Sonnet 5**：大量投诉"不遵守命令"，"陷入无休止的反驳循环"，"没有打动任何人"
- **DeepSeek V4 Pro**：7 月后"API 异常，幻觉增多"，"频繁返回 400 错误"

**成本估算**（相对于全 Opus baseline = 100%）：
- **全 Fable 5 配置**：**~190%**（最强质量，但比 Opus 贵 2 倍）
- **Fable 5 + Sol 混合**：**~140%**（顶级质量组合）
- **推荐混合路由**：**35-45%**（Fable/Sol plan/review + GLM/Grok implement）
- 极致性价比：20-30%（Sol plan + GLM implement + Grok review）

**推荐配置（2026年7月最新）**：

**1. 质量第一场景（不计成本）**：
```
Planning: Fable 5
Plan Review: GPT-5.6-sol
Implementation: Fable 5 或 GLM-5.2
Code Review: Fable 5
成本：~140-190%（但质量最优）
```

**2. 平衡场景（推荐，你的定位）**：
```
Planning: Fable 5（最强推理）
Plan Review: GPT-5.6-sol（结构化验证第一）
Implementation: GLM-5.2（接近 Opus 质量，零头价格）
Code Review: Fable 5（质量关键）
Simple Repair: Grok 4.5（速度 + 性价比）
成本：~35-45%，质量接近顶级
```

**3. 高性价比场景**：
```
Planning: GPT-5.6-sol（agent 最佳）
Plan Review: GLM-5.2（质量接近顶级）
Implementation: Grok 4.5（速度领导者）
Code Review: GLM-5.2 或 Terra
成本：~20-30%
```

**4. 长上下文场景**：
```
优先：GPT-5.6-terra（100 万+窗口，价格仅 Opus 一半）
备选：Opus 4.8（但注意质量问题）
避免：Grok 4.5（虽然 200 万窗口，但幻觉率高）
```

**不推荐配置**：
- ❌ 全 Opus 4.8：质量问题 + token 消耗大
- ❌ Sonnet 5 作为主力：用户体验差，不遵守指令
- ❌ DeepSeek V4 Pro 关键任务：API 不稳定

```typescript
const claude_opus_planner: ModelProfile = {
  id: "claude_opus_planner",
  vendor: "anthropic",
  modelPattern: "claude-opus-4-8",
  roles: ["planner", "plan_reviewer", "code_reviewer"],
  
  promptStrategy: {
    kind: "concise",
    systemPromptTemplate: "concise-claude",
    fewShotPolicy: { enabled: true, maxExamples: 1, dynamicSelection: true },
    roleEmphasis: "light",
    instructionFormat: "natural",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 4000 },
        { toolName: "read", strategy: "smart", maxLines: 100 },
        { toolName: "test", strategy: "smart", maxBytes: 3000, preservePatterns: ["FAIL", "ERROR"] },
        { toolName: "*", strategy: "head", maxBytes: 2000 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 8,
  },
  
  contextStrategy: {
    targetUtilization: 0.7,
    repoMap: { enabled: false, maxFiles: 15, strategy: "full-content" },
    eviction: { 
      enabled: true, 
      preserveUserTurns: true, 
      evictPersisted: true, 
      keepRecentN: 10 
    },
    artifactInclusion: { 
      includePlan: true, 
      includeReviewFindings: true, 
      includeVerification: true,
      maxArtifactBytes: 50000 
    },
    toolHistory: { maxToolCalls: 10, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { addDescriptions: true, addExamples: false, strictMode: false },
    retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
  },
  
  runtime: { kind: "embedded" }, // 或 claude_cli
  thinkingLevel: "medium",
  promptTemplate: "workflow/planner",
  promptVersion: "v1",
  toolPolicyId: "readonly-planning",
  maxRequests: 20,
  maxRuntimeMs: 600000,
  retryPolicy: {
    maxAttempts: 3,
    retryableErrorKinds: ["provider_transient", "timeout"],
    fallbackProfileIds: ["gpt_planner"],
  },
  contextPolicy: {
    includePlan: true,
    includeReviewFindings: true,
    includeVerification: true,
    includeFullTranscript: false,
    maxArtifactBytes: 50000,
  },
};
```

### 4.2 Claude Sonnet 5 - 性价比之王

```typescript
const claude_sonnet_reviewer: ModelProfile = {
  id: "claude_sonnet_reviewer",
  vendor: "anthropic",
  modelPattern: "claude-sonnet-5",
  roles: ["plan_reviewer", "code_reviewer"],
  
  promptStrategy: {
    kind: "concise",
    systemPromptTemplate: "concise-claude",
    fewShotPolicy: { enabled: true, maxExamples: 2, dynamicSelection: true },
    roleEmphasis: "medium",
    instructionFormat: "natural",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 3000 },
        { toolName: "read", strategy: "smart", maxLines: 50 },
        { toolName: "*", strategy: "head", maxBytes: 1500 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 5, // 20 万窗口，限制并发
  },
  
  contextStrategy: {
    targetUtilization: 0.7,
    repoMap: { 
      enabled: true, // 启用 repo-map 节省 token
      maxFiles: 8, 
      strategy: "hybrid" 
    },
    eviction: { 
      enabled: true, 
      preserveUserTurns: true, 
      evictPersisted: true, 
      keepRecentN: 8 
    },
    artifactInclusion: { 
      includePlan: true, 
      includeReviewFindings: true, 
      includeVerification: true,
      maxArtifactBytes: 30000 
    },
    toolHistory: { maxToolCalls: 8, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { addDescriptions: true, addExamples: false, strictMode: false },
    retryOnSchemaViolation: { enabled: true, maxRetries: 2, includeErrorInRetry: true },
  },
  
  runtime: { kind: "claude_cli" },
  thinkingLevel: "low",
  promptTemplate: "workflow/reviewer",
  promptVersion: "v1",
  toolPolicyId: "readonly-review",
  maxRequests: 30,
  maxRuntimeMs: 300000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient"],
    fallbackProfileIds: ["gpt_reviewer"],
  },
  contextPolicy: {
    includePlan: true,
    includeReviewFindings: true,
    includeVerification: true,
    includeFullTranscript: false,
    maxArtifactBytes: 30000,
  },
};
```

### 4.3 GPT-5.5 - 结构化输出强

```typescript
const gpt_planner: ModelProfile = {
  id: "gpt_planner",
  vendor: "openai",
  modelPattern: "gpt-5.5",
  roles: ["planner", "plan_reviewer"],
  
  promptStrategy: {
    kind: "structured",
    systemPromptTemplate: "structured-gpt",
    fewShotPolicy: { enabled: true, maxExamples: 2, dynamicSelection: true },
    roleEmphasis: "medium",
    instructionFormat: "numbered",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 4000 },
        { toolName: "read", strategy: "smart", maxLines: 80 },
        { toolName: "*", strategy: "head", maxBytes: 2000 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 8,
  },
  
  contextStrategy: {
    targetUtilization: 0.65,
    repoMap: { enabled: false, maxFiles: 12, strategy: "full-content" },
    eviction: { 
      enabled: true, 
      preserveUserTurns: true, 
      evictPersisted: true, 
      keepRecentN: 10 
    },
    artifactInclusion: { 
      includePlan: true, 
      includeReviewFindings: true, 
      includeVerification: true,
      maxArtifactBytes: 40000 
    },
    toolHistory: { maxToolCalls: 10, summarizeOld: true },
  },
  
  outputStrategy: {
    schemaEnhancement: { 
      addDescriptions: false, 
      addExamples: false, 
      strictMode: true // GPT strict mode
    },
    retryOnSchemaViolation: { 
      enabled: true, 
      maxRetries: 1, 
      includeErrorInRetry: false // GPT 通常首次正确
    },
  },
  
  runtime: { kind: "codex_cli", profile: "cli" },
  thinkingLevel: "medium",
  promptTemplate: "workflow/planner",
  promptVersion: "v1",
  toolPolicyId: "readonly-planning",
  maxRequests: 25,
  maxRuntimeMs: 400000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient", "timeout"],
    fallbackProfileIds: ["claude_planner"],
  },
  contextPolicy: {
    includePlan: true,
    includeReviewFindings: true,
    includeVerification: true,
    includeFullTranscript: false,
    maxArtifactBytes: 40000,
  },
};
```

### 4.4 Grok 4.5 - 实现首选

```typescript
const grok_implementer: ModelProfile = {
  id: "grok_implementer",
  vendor: "xai",
  modelPattern: "grok-4.5",
  roles: ["implementer", "repair"],
  
  promptStrategy: {
    kind: "verbose",
    systemPromptTemplate: "explicit-grok",
    fewShotPolicy: { enabled: true, maxExamples: 3, dynamicSelection: true },
    thinkingPrompt: { enabled: true, style: "step-by-step" },
    roleEmphasis: "heavy", // Grok 需要强调角色
    instructionFormat: "numbered",
  },
  
  toolStrategy: {
    outputTruncation: {
      enabled: true,
      rules: [
        { toolName: "bash", strategy: "smart", maxBytes: 5000 },
        { toolName: "read", strategy: "smart", maxLines: 150 },
        { toolName: "*", strategy: "head", maxBytes: 3000 },
      ],
    },
    resultSummarization: { enabled: true, summarizers: DEFAULT_SUMMARIZERS },
    maxConcurrentTools: 15, // 200 万窗口，可并发多
  },
  
  contextStrategy: {
    targetUtilization: 0.5, // 200 万窗口，宽松利用
    repoMap: { enabled: false, maxFiles: 20, strategy: "full-content" },
    eviction: { 
      enabled: false, // 大窗口几乎不驱逐
      preserveUserTurns: true, 
      evictPersisted: false, 
      keepRecentN: 20 
    },
    artifactInclusion: { 
      includePlan: true, 
      includeReviewFindings: true, 
      includeVerification: true,
      maxArtifactBytes: 100000 
    },
    toolHistory: { maxToolCalls: 15, summarizeOld: false },
  },
  
  outputStrategy: {
    schemaEnhancement: { 
      addDescriptions: true, 
      addExamples: true, // Grok 需要示例
      strictMode: false 
    },
    outputPrefixPrompt: "Output valid JSON matching the schema:",
    retryOnSchemaViolation: { 
      enabled: true, 
      maxRetries: 3, 
      includeErrorInRetry: true 
    },
  },
  
  runtime: { kind: "codex_cli", profile: "grok" }, // 或 grok_cli（待实现）
  thinkingLevel: "medium",
  promptTemplate: "workflow/implementer",
  promptVersion: "v1",
  toolPolicyId: "scoped-implementation",
  maxRequests: 40,
  maxRuntimeMs: 800000,
  retryPolicy: {
    maxAttempts: 2,
    retryableErrorKinds: ["provider_transient", "schema_violation"],
    fallbackProfileIds: ["claude_implementer"],
  },
  contextPolicy: {
    includePlan: true,
    includeReviewFindings: true,
    includeVerification: true,
    includeFullTranscript: false,
    maxArtifactBytes: 100000,
  },
};
```

---

## 5. 实施计划

### 5.1 Phase 1: 基础设施（2 周）

**目标**：实现工具输出管理和 schema 增强

#### 新建文件

- `packages/coding-agent/src/workflow/tool-output-manager.ts`
- `packages/coding-agent/src/workflow/schema-enhancer.ts`

#### 修改文件

- `packages/coding-agent/src/workflow/types.ts`
  - 添加 `PromptStrategy`, `ToolStrategy`, `ContextStrategy`, `OutputStrategy`
  - 更新 `ModelProfile` 接口

- `packages/coding-agent/src/workflow/model-profile-registry.ts`
  - 移除 `UNSUPPORTED_RUNTIME_FIELDS` 中的 `toolAliases` 和 `argumentAliases`
  - 添加新字段的验证逻辑

#### 任务清单

- [ ] **Task 1.1**: 实现工具输出截断逻辑
  - 实现 `truncateOutput(output, strategy, maxBytes)` 函数
  - 支持 head/tail/smart 三种策略
  - smart 策略识别错误模式并保留上下文

- [ ] **Task 1.2**: 实现工具结果摘要器
  - 实现 `DEFAULT_SUMMARIZERS` (bash, read, grep, test, ls)
  - 提供扩展点供自定义 summarizer

- [ ] **Task 1.3**: 实现 schema 增强
  - `addDetailedDescriptions()` - 为每个字段添加描述
  - `addInlineExamples()` - 为 Grok 生成示例
  - `enableStrictMode()` - 为 GPT 启用 strict

- [ ] **Task 1.4**: 启用工具别名
  - 实现 `transformToolsForProfile()` 函数
  - 利用已有的 `customWireName` 机制
  - 实现 `remapSchemaProperties()` 处理参数别名

- [ ] **Task 1.5**: 单元测试
  - 测试各种截断策略（head/tail/smart）
  - 测试 summarizer 输出格式
  - 测试 schema 增强效果
  - 使用 fake tools，不调用真实模型

#### 验收标准

```bash
bun test packages/coding-agent/test/workflow/tool-output-manager.test.ts
bun test packages/coding-agent/test/workflow/schema-enhancer.test.ts
# 全部通过，覆盖率 > 80%
```

---

### 5.2 Phase 2: Prompt 和 Context 优化（3 周）

**目标**：实现 per-model prompt 模板和上下文管理

#### 新建文件

- `packages/coding-agent/src/prompts/workflow/concise-claude.md`
- `packages/coding-agent/src/prompts/workflow/structured-gpt.md`
- `packages/coding-agent/src/prompts/workflow/explicit-grok.md`
- `packages/coding-agent/src/workflow/context-evictor.ts`
- `packages/coding-agent/src/workflow/repo-map-builder.ts`

#### 修改文件

- `packages/coding-agent/src/workflow/context-builder.ts`
  - 根据 `profile.promptStrategy.systemPromptTemplate` 选择模板
  - 集成 repo-map 构建
  - 集成上下文驱逐逻辑

- `packages/coding-agent/src/workflow/runtime-adapter.ts`
  - 在 `prepareWorkflowInvocation` 中应用 prompt 策略
  - 调用 context evictor

- `package.json`
  - 添加 `tree-sitter` 依赖
  - 添加 `tree-sitter-typescript` 和 `tree-sitter-python`

#### 任务清单

- [ ] **Task 2.1**: 创建 per-model prompt 模板
  - concise-claude.md（简洁，利用强推理）
  - structured-gpt.md（结构化，明确步骤）
  - explicit-grok.md（详细，强调角色）

- [ ] **Task 2.2**: 实现 prompt 模板选择逻辑
  - 在 context-builder 中根据 profile 加载对应模板
  - 支持动态 few-shot examples 选择

- [ ] **Task 2.3**: 实现上下文驱逐（CWL 策略）
  - 实现 `evictContext()` 函数
  - 实现 `markPersistedSegments()` 标记已持久化片段
  - 保留用户回合和最近 N 轮
  - 驱逐已持久化的工具调用

- [ ] **Task 2.4**: 实现 repo-map builder
  - 集成 tree-sitter 解析 TypeScript/Python
  - 实现 `extractSymbols()` 提取函数、类、接口
  - 实现 `buildCallGraph()` 构建依赖图
  - 实现 `pageRankFiles()` 对文件排序
  - 实现 `renderRepoMap()` 生成压缩表示

- [ ] **Task 2.5**: 集成到 workflow runtime
  - 修改 runtime-adapter 调用 context-builder
  - 在构建 context 时应用 repo-map（如果启用）
  - 在超出 targetUtilization 时触发驱逐

- [ ] **Task 2.6**: 单元测试
  - 测试 prompt 模板渲染
  - 测试上下文驱逐逻辑（保留什么、驱逐什么）
  - 测试 repo-map 生成（使用 fixture 代码库）
  - 使用 fake session history

#### 验收标准

```bash
bun test packages/coding-agent/test/workflow/context-evictor.test.ts
bun test packages/coding-agent/test/workflow/repo-map-builder.test.ts
bun test packages/coding-agent/test/workflow/context-builder.test.ts
# 全部通过，覆盖率 > 75%
```

---

### 5.3 Phase 3: Runtime 集成和默认配置（2 周）

**目标**：集成所有优化到 runtime，配置默认 profiles

#### 修改文件

- `packages/coding-agent/src/workflow/runtime-adapter.ts`
  - 在 `prepareWorkflowInvocation` 中应用全部策略
  - prompt 策略 → 选择模板
  - tool 策略 → 截断输出、应用别名
  - context 策略 → repo-map + 驱逐
  - output 策略 → schema 增强 + 重试

- `packages/coding-agent/src/workflow/default-config.ts`
  - 定义 4 个默认 profiles（见第 4 节）
  - Claude Opus, Claude Sonnet, GPT-5.5, Grok 4.5

- `packages/coding-agent/src/workflow/model-router.ts`
  - 确保 router 正确选择带优化策略的 profile

#### 任务清单

- [ ] **Task 3.1**: 集成 prompt 策略
  - context-builder 根据 promptStrategy 选择模板
  - 应用 fewShotPolicy（动态选择 examples）
  - 应用 roleEmphasis 和 instructionFormat

- [ ] **Task 3.2**: 集成 tool 策略
  - 在工具执行后拦截输出
  - 应用 outputTruncation 规则
  - 应用 resultSummarization
  - 应用 toolAliases 和 argumentAliases

- [ ] **Task 3.3**: 集成 context 策略
  - 在构建 context 时检查 targetUtilization
  - 如果超限，调用 evictContext
  - 如果启用 repoMap，生成并插入

- [ ] **Task 3.4**: 集成 output 策略
  - 在调用模型前增强 schema
  - 实现 schema violation 重试逻辑
  - 应用 outputPrefixPrompt（for Grok）

- [ ] **Task 3.5**: 配置默认 profiles
  - claude_opus_planner (见 4.1)
  - claude_sonnet_reviewer (见 4.2)
  - gpt_planner (见 4.3)
  - grok_implementer (见 4.4)

- [ ] **Task 3.6**: 集成测试
  - 端到端测试：planning → review → implement
  - 使用 fake provider，验证策略生效
  - 验证 token 消耗符合预期（与 baseline 对比）

#### 验收标准

```bash
bun test packages/coding-agent/test/workflow/runtime-adapter.test.ts
bun test packages/coding-agent/test/workflow/model-router.test.ts
bun test packages/coding-agent/test/workflow/engine-optimized.test.ts
# 全部通过

# Token 消耗对比（使用 fake provider 统计）
# Baseline: 100K tokens
# Optimized: 40-60K tokens (40-60% 节省)
```

---

### 5.4 Phase 4: 真实模型验证（1 周）

**目标**：在真实模型上验证优化效果

#### 任务清单

- [ ] **Task 4.1**: 准备测试任务集
  - 选择 10 个典型任务（简单、中等、复杂各 3-4 个）
  - 任务覆盖：单文件修改、多文件重构、API 实现、bug 修复

- [ ] **Task 4.2**: Baseline 测量（未优化）
  - 使用当前 oh-my-pi（无 per-model 优化）
  - 记录每个任务的：
    - Token 消耗（input/output）
    - 任务完成质量（能否通过验证）
    - 耗时

- [ ] **Task 4.3**: Optimized 测量（已优化）
  - 使用 per-model 优化后的 oh-my-pi
  - 记录相同指标

- [ ] **Task 4.4**: 对比分析
  - Token 节省百分比
  - 质量提升（通过率、reviewer findings）
  - 成本节省（按 pricing 计算）

- [ ] **Task 4.5**: 与原厂 CLI 对比
  - 选择 3-5 个任务
  - 分别用 Claude Code, Codex CLI, Grok Build 执行
  - 对比 oh-my-pi optimized 的表现

#### 验收标准

**Token 效率**：
- Claude Opus: 节省 15-25%
- Claude Sonnet: 节省 30-40%（repo-map 生效）
- GPT-5.5: 节省 10-20%
- Grok: 节省 5-15%（大窗口优势）

**任务质量**：
- 通过率不低于 baseline（理想情况提升 5-10%）
- Schema violation 减少 20-40%

**与原厂 CLI 对比**：
- Token 效率优于或接近 Aider（repo-map 策略）
- 任务质量优于或接近 Claude Code
- 综合成本低于 Cursor（智能路由）

---

## 6. 风险与缓解

### 6.1 技术风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| tree-sitter 解析失败 | repo-map 不可用 | 中 | 降级到完整文件内容 |
| 工具输出截断丢失关键信息 | 任务失败 | 低 | smart 策略保留错误上下文 |
| 上下文驱逐过于激进 | 模型失去必要上下文 | 中 | 保留用户回合和最近 N 轮 |
| Schema 增强不兼容某些模型 | 输出失败 | 低 | per-profile 可配置 |
| Grok 指令遵循仍然弱 | 实现质量低 | 中 | 增加 few-shot examples，fallback 到 Claude |

### 6.2 性能风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| repo-map 构建耗时长 | workflow 启动慢 | 中 | 缓存符号图谱，增量更新 |
| tree-sitter 内存占用高 | OOM | 低 | 限制并发解析文件数 |
| 上下文驱逐计算开销 | 每轮延迟 | 低 | 只在接近限制时触发 |

### 6.3 兼容性风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| 破坏现有 workflow | 用户任务失败 | 低 | 默认关闭优化，通过 profile 选择启用 |
| 与 CLI runtime 冲突 | Codex/Claude CLI 行为异常 | 低 | 只在 embedded runtime 启用完整优化 |
| ModelProfile 格式变更 | 配置迁移 | 中 | 向后兼容，旧配置使用默认值 |

---

## 7. 成功指标

### 7.1 定量指标

| 指标 | Baseline | 目标 | 优先级 | 测量方式 |
|------|---------|------|--------|---------|
| **任务通过率** | 75% | **85-90%** | P0 | 验证通过/总任务 |
| **任务质量评分** | 7.5/10 | **8.5/10** | P0 | 人工评审 + 自动化测试 |
| Token 消耗（平均） | 100K | 50-70K | P1 | workflow 完成后统计 |
| 工具输出 token | 40K | 15-25K | P1 | 工具调用计数 |
| Context token | 50K | 30-40K | P1 | 每轮 context size |
| Schema violation 率 | 15% | 5-10% | P1 | violation count/总尝试 |
| 成本（$/任务） | $0.50 | $0.20-0.35 | P2 | 按 pricing 计算 |

**质量优先原则体现**：
- 通过率和质量评分为 P0（最高优先级）
- Token 和成本为 P1/P2，在保证质量前提下优化
- 如果优化导致质量下降 >3%，回退到质量优先配置

### 7.2 定性指标

- [ ] **用户反馈**: 90%+ 用户认为质量有提升
- [ ] **代码审查通过率**: 提升 10-15%
- [ ] **重试次数**: 减少 20-30%（首次成功率提升）
- [ ] **社区认可**: GitHub stars/discussions 中提到质量改进为亮点

### 7.3 对比基准

**与原厂 CLI 对比**（相同模型、相同任务）：

| CLI | Token 消耗 | 任务质量 | 成本 | oh-my-pi 目标 |
|-----|-----------|---------|------|--------------|
| Claude Code | 33K | 78% | $0.40 | 25-30K, **85%**, $0.30 |
| Codex CLI | 45K | 75% | $0.35 | 30-35K, **82%**, $0.25 |
| Aider | 7.8K | 71% | $0.12 | 15-20K, **85%**, $0.25 |

**综合评价**：
- **质量第一**：超越 Claude Code 和 Aider（85% vs 78%/71%）
- **Token 效率第二**：介于 Aider 和 Claude Code 之间（可接受）
- **成本可控**：低于主流工具，但高于 Aider（质量换取）
- **Trade-off 合理**：质量提升 7-14%，成本仅增加 2x（相对 Aider）

---

## 8. 参考资料

### 8.1 社区反馈

1. [Aider Uses 4.2x Fewer Tokens Than Claude Code](https://www.morphllm.com/comparisons/morph-vs-aider-diff)
2. [I saved 10M tokens (89%) with CLI proxy](https://github.com/Kilo-Org/kilocode/discussions/5848)
3. [Claude Code Context Window Full Fix](https://medium.com/@cartseoservice/claude-code-context-window-full-fix-token-errors-2026-e65328c94321)
4. [5 Pain Patterns from r/ClaudeAI](https://gist.github.com/yurukusa/b1fa1fb7f900d1f278c0dcad23e23fd9)

### 8.2 竞品分析

5. [Claude Code vs Cursor vs Aider for .NET 11](https://startdebugging.net/2026/06/claude-code-vs-cursor-vs-aider-for-a-dotnet-11-repo/)
6. [Cursor Router Cuts Costs by 60%](https://startupfortune.com/cursor-router-picks-your-ai-model-for-you-and-cuts-coding-costs-by-60/)
7. [Cursor Agent Best Practices](https://cursor.com/blog/agent-best-practices)
8. [Grok Build CLI vs Claude Code](https://composio.dev/content/grok-build-cli-vs-claude-code)
9. [Deep Dive: Grok Build CLI](https://medium.com/codetodeploy/deep-dive-grok-build-cli-xais-2-million-token-answer-to-ai-coding-agents-c565fd003331)

### 8.3 学术研究

10. [SWE-Pruner: Context Pruning](https://arxiv.org/abs/2601.16746)
11. [Multi-Rubric Latent Reasoning](https://arxiv.org/abs/2605.15315)
12. [Structured Context Eviction for Long-Horizon Agents](https://arxiv.org/abs/2606.11213)
13. [Efficient Context Engineering for Tool-Using Agents](https://arxiv.org/abs/2606.10209)

### 8.4 技术文档

14. [How Aider's Repomap Uses PageRank](https://anishgandhi.com/aider-pagerank-codebase-ranking)
15. [Aider ctags Documentation](https://aider.chat/docs/ctags.html)
16. [AI Agent Memory Compaction Strategies](https://fast.io/resources/ai-agent-memory-compaction-strategies/)
17. [Tool Calling Best Practices](https://justoborn.com/tool-calling/)

---

## 9. 附录

### 9.1 术语表

- **Repo-map**: 代码库的压缩表示，用符号签名替代完整内容
- **CWL (Context Working Limit)**: 上下文工作限制，保留活跃上下文、驱逐已持久化片段
- **Schema violation**: 模型输出不符合预定义 JSON Schema
- **Tool output truncation**: 工具输出截断，减少无关内容进入上下文
- **PageRank**: 网页排名算法，用于对文件重要性评分

### 9.2 配置示例

**启用 per-model 优化的 workflow 配置**：

```yaml
# .omp/settings.json
{
  "workflow": {
    "profiles": {
      "claude_opus_planner": {
        "promptStrategy": {
          "kind": "concise",
          "systemPromptTemplate": "concise-claude"
        },
        "toolStrategy": {
          "outputTruncation": {
            "enabled": true,
            "rules": [
              { "toolName": "bash", "strategy": "smart", "maxBytes": 4000 }
            ]
          }
        },
        "contextStrategy": {
          "targetUtilization": 0.7,
          "eviction": { "enabled": true, "keepRecentN": 10 }
        }
      }
    }
  }
}
```

### 9.3 FAQ

**Q1: 会不会因为截断丢失关键信息？**  
A: smart 策略会识别错误模式并保留上下文。如果仍有遗漏，summarizer 会提取关键字段（如 exitCode）。

**Q2: repo-map 支持哪些语言？**  
A: Phase 1 支持 TypeScript 和 Python（tree-sitter），后续可扩展到 Go/Rust/Java。

**Q3: 如何禁用优化？**  
A: 使用不带优化策略的 profile，或设置 `promptStrategy: null`。

**Q4: 与 Claude Code / Codex CLI 兼容吗？**  
A: 完全兼容。优化主要在 embedded runtime，CLI runtime 保持原样。

**Q5: 如何迁移现有 ModelProfile 配置？**  
A: 新字段可选，旧配置使用默认值（无优化）。

---

**文档结束**
