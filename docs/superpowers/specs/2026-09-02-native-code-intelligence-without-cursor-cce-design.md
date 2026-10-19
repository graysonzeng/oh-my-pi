# Design: 原生 Code Intelligence（取代 Cursor CCE，不再接入 Cursor）

- Date: 2026-09-02
- Status: Revised
- Scope: L

## 1. 设计目标和范围

### 1.1 要解决的问题

omp 今天的项目理解路径是 **确定性搜索拼凑**：`grep` / `glob` / `ast_grep` / `lsp` / scout 散文交接。Cursor Context Engine（CCE）赢在另一件事：自然语言意图 → 最小充分证据集（`path:line | symbol | 关系 | 证据种类` + `gaps` + `confidence`），并自主决定是否沿调用链加深。

用户目标：**把这层能力内化进 omp 内核**。内化完成后：

- 默认产品路径 **不再** 依赖 Cursor 进程、cursor-bridge MCP、`cursor_context_engine`、`cursor_do`。
- 未安装 Cursor 的机器上，未知位置 / 调用链 / 所有权问题仍能给出可验证信封，而不是「去装 Cursor」或「scout 再 grep 一轮」。
- 不在 omp 里重建 Cursor 的闭源 embedding 服务，也不把 Python MCP（Serena）或云向量库（Milvus / OpenAI）做成运行时依赖。

CCE 的产品合同（必须被 omp 自己满足）：

```text
CCE_SEARCH_RESULT
intent: <一句话检索意图>
coverage: <focused|extended> | <为什么当前深度已经足够>
evidence:
- <workspace-relative-path>:<start>-<end> | <symbol> | <关系> | <exact|reference|source-read|semantic>
gaps: <未证实项；没有则 none>
confidence: <high|medium|low>   # 只评检索证据，不评代码正确
```

硬约束（与 CCE 对齐，且不依赖 Cursor）：

- 语义相似 **不得** 标成已证明的调用边。
- 缺证据必须写 `NOT_FOUND`，并列出实际搜过的 scope / 符号 / 索引状态。
- 叙事字段跟用户查询语言；路径、符号、枚举、错误码永不翻译。
- 只读：不改文件、不跑会改工作区状态的命令。实现上不是 OS sandbox，但工具 `approval` 必须是 `"read"`，且不得调用 `lsp` 的 rename / apply 路径。

### 1.2 成功标准

1. 主 agent 与 scout 对「未知位置 / 调用链 / 数据流 / 所有权 / 跨模块关系」的 **第一检索面** 是内建 `code_intel`，不是 Cursor MCP / `cursor_context_engine` / `cursor_do`，也不是「先开一个 Explore 子代理再 grep」。
2. `code_intel` 的模型可见输出与 CCE **wire grammar 兼容**：首行标记 `CCE_SEARCH_RESULT`、字段顺序、`kind`/`coverage`/`confidence` 枚举、`NOT_FOUND` 行形。自由文本（intent / coverage reason / gaps）不要求字节相同。仓库内冻结一份 grammar fixture + consumer parser；没有外部 `server.mjs` 版本时，以该 fixture 为可执行合同。
3. 默认安装 **不把 Cursor IDE / CCE / cursor-bridge 当代码智能后端**，也 **零 Python sidecar、零云向量库、零远程 embedding HTTP**。embedding 只走 `MnemopiEmbedClient` 的 **direct local worker**。worker 失败时降级为图 + LSP + grep，信封 `gaps` 写明语义层不可用，**不** 尝试 Cursor。合法的 Cursor **LLM provider**（模型目录里的 Cursor 模型）不是 CCE 后端，不受本条禁止。首次本地模型缓存缺失时允许从 Hugging Face / GCS 下载 sidecar；这不等于「完全离线」，也不等于云向量推理。
4. **Positive corpus（必须 `found=true`）**：在固定 golden fixture / `oh-my-pi` 锚点上，下列查询不得返回 `NOT_FOUND`，evidence 必须命中预期 `path` + `symbol`（关系字段按 provenance 规则，不得用假 call edge 凑数）。每条意图同时有中文查询与英文查询：
   - 中文「task 子代理 isolation 是在哪创建 worktree 的」/ 英文 `where is isolated task worktree created` → `packages/coding-agent/src/task/worktree.ts` · `ensureIsolation`
   - 中文「hub wait 超时后 job 会不会被标 useless」/ 英文 `does hub wait timeout mark a still-running job useless` → `packages/coding-agent/src/tools/hub/jobs.ts` · `isWaitingPollDetails`
   - 中文「LSP rename 默认 apply 吗」/ 英文 `does LSP rename apply by default` → `packages/coding-agent/src/lsp/tool.ts` · `apply !== false` / `shouldApply`
   **Negative corpus（才允许 `NOT_FOUND`）**：虚构符号 `DefinitelyNotInRepo_XYZ`；注释里写 “calls beta” 但无调用表达式。运行轨迹无 Cursor 进程、无 `cursor_context_engine`/`cursor_do`、无 `mcp__*`。
5. scout 的 structured `output` 改为同一信封；主 agent 只把信封里的锚点当事实，散文不当 call edge。
6. 仓库内不存在把 cursor-bridge / CCE 当作默认发现或执行路径的配置、skill、hook。文档明确：Cursor IDE 是外部编辑器；Cursor LLM provider ≠ Cursor CCE 后端。

**「取代 CCE」宣传闸门（Phase 3，可执行）**：positive corpus 全绿、negative corpus 无假 call edge（`calls`/`called by` 的 false-edge=0）、冷查询读稳定 generation、暖查询不阻塞无界 init、无 Cursor/MCP 轨迹。仅「本阶段测试绿」不够。`NOT_FOUND` 不能让 positive 查询通过。

### 1.3 非目标

- 不实现 `cursor_do`、CDP、lifecycle supervisor、Agents Window、hold-Enter。
- 不 vendoring Serena / cased-kit / Zoekt / Aider 源码；只重实现算法合同。
- 不把 Mnemopi 记忆库改成代码索引（记忆 ≠ 代码图）。
- 不在本设计落地 session fencing、模型 fail-closed、`needs_attention`（那是另一份 harness 债）。
- 不承诺 embedding 层在弱 LSP 语言上全面超过 Cursor 专有代码模型。产品承诺是：**无 Cursor CCE 时有一条完整、可验证、可降级的原生路径**。
- 不把 PageRank 权重、20k/4k 上限、dense/lexical 混合系数当成已用 A/B 证实的终态；它们是可调默认，由 corpus 消融再冻结。

### 1.4 规模判定

L：新 natives 模块 + 新一等工具 + LSP 扩展 + scout/schema/settings/文档，跨 `crates/pi-natives`、`packages/natives`、`packages/coding-agent`。

---

## 2. 方案对比

### 方案 A — 继续接 cursor-bridge MCP（CCE 外援）

- 做法：`.mcp.json` stdio 挂 `cursor-bridge`，skill 路由未知位置到 `cursor_context_engine`。
- 优点：立刻拿到 Cursor 索引；改动小。
- 缺点：依赖已登录的 Cursor、CDP、Windows 生命周期；无 Cursor 即无能力。**与本次目标直接冲突。**
- 结论：否决。

### 方案 B — 只改 scout 提示词，继续拼 grep/lsp/ast_grep

- 做法：scout 加上 `lsp`/`ast_grep`，输出改成信封格式。
- 优点：无新索引，几天能做完。
- 缺点：主模型仍要自己选工具、自己决定何时加深；没有 def/ref 图排序，也没有 NL「支付失败怎么重试」这类查询的落点。CCE 的核心（一个 query、引擎选深度）不存在。scout 暴露完整 `lsp` 还会撞上 `READ_ONLY_TOOL_NAMES`：`lsp` 含 rename，scout 会被判成可写。
- 结论：作为 Phase 0 的一部分保留，**不能单独作为终态**。

### 方案 C — 嵌入 Serena MCP 或 claude-context

- Serena：MIT，Python，默认后端就是 LSP。omp 已有 LSP 客户端 + broker（`packages/coding-agent/src/lsp/`）。再养一套 language server 生命周期是重复；Python 运行时不是 omp 的发布面。
- claude-context：MIT，AST chunk + Merkle 增量 + hybrid 检索。默认安装路径是 `OPENAI_API_KEY` + `MILVUS_TOKEN`。与「零云依赖」冲突。可抄的是算法（AST chunk、Merkle、hybrid），不是进程。
- 结论：当依赖否决；算法可吸收进方案 D。

### 方案 D — 原生 `code_intel`（选定）

- 一个只读工具，内部融合四层检索，对外只暴露 CCE 信封。
- 图排序：Aider RepoMap 合同（tree-sitter tags + 个性化 PageRank），在 `pi-natives` 用 Rust 重实现。
- 符号边：现有 LSP（加一等 `call_hierarchy`）；LSP 冷时用本地 tags 图，可选摄入仓库内已有的 `index.scip`。
- NL：AST-aware chunk + 已有本地 embedding worker + 现成 `vectorIndexTopK` / `mmrRerankIndices`；BM25 不另建倒排，复用进程内 `grep`。
- 优点：无 Cursor、无 Python、无云；与 natives/LSP/embed 现有边界对齐；失败可降级且诚实。
- 缺点：工程量大；弱 LSP + 纯行为描述上可能仍弱于 Cursor 专有模型。用信封 `confidence`/`gaps` 表达，不假装打平。

---

## 3. 选定方案

选定 **方案 D**。Phase 0 吸收方案 B 的 scout 信封与只读分类修复，但不把「裸 lsp 交给 scout」当作终态。

终态用户可见面：

| 角色 | 检索入口 | 禁止 |
|---|---|---|
| 主 agent | `code_intel`（未知位置第一面）；已知文件继续 `read`/`grep`/`lsp` | 默认配置中的 Cursor CCE / cursor-bridge MCP |
| scout | `code_intel` + `read` + `grep` + `glob` + `ast_grep` | 不暴露可写 `lsp` action；不 spawn 第二个「探索子代理」来找代码 |
| librarian / reviewer | 保持现有 `lsp`/`ast_grep`；需要 NL 落点时也可调 `code_intel` | 无 |

内部融合顺序（一次 `code_intel` 调用内完成，不把融合推给主模型）：

1. 解析意图：抽标识符、关系信号（调用链 / 数据流 / 实现 / 所有权）、语言线索。
2. 并行：grep 标识符；tags/PageRank 个性化排序；若 LSP 已就绪则 `workspace/symbol` + 对 top 符号 `references`/`implementation`；若 **当前 generation 的 embedding 快照已暖** 则 hybrid 召回。查询 **不得** 等待无界 `initialize`。
3. 关系信号为真时 **最多一跳** 加深：只对已证实 call source（LSP `call_hierarchy`，或另行实现并测试的 call-expression resolver）走 incoming/outgoing。tags 图邻居只作 `source-read` 上下文，**不是** 第二跳 call edge。`extended` 允许第二跳，仍只走已证实 call source。禁止无界全仓游走。
4. 合并去重。每条候选携带不可丢失的 provenance 判别联合（见 4.4）。对外 `kind` 仍只暴露 `exact | reference | source-read | semantic`。
5. 输出信封。没有任何 `exact`/`reference`/`source-read` 时：`NOT_FOUND`。`semantic` 永不单独进 `evidence`；当前 identifier tags 永不渲染 `calls`/`called by`。

---

## 4. 详细设计

### 4.1 组件与文件

```text
crates/pi-natives/src/code_intel.rs     新模块：tags 抽取、图 snapshot、PageRank、chunk、generation I/O
crates/pi-natives/src/lib.rs            `pub mod code_intel;`
packages/natives/native/index.d.ts      由 napi 生成：CodeIntel* 类型与函数
packages/coding-agent/src/tools/code-intel.ts          工具类
packages/coding-agent/src/tools/code-intel-merge.ts    四路结果合并、provenance、信封渲染
packages/coding-agent/src/tools/code-intel-index.ts    generation snapshot、外部变更检测、embed warm owner
packages/coding-agent/src/tools/code-intel-lsp.ts      只读 LSP facade（白名单方法）
packages/coding-agent/src/tools/code-intel-envelope.ts CCE wire grammar parser/renderer
packages/coding-agent/src/prompts/tools/code-intel.md  模型可见说明
packages/coding-agent/src/lsp/types.ts  schema 增加 call_hierarchy
packages/coding-agent/src/lsp/tool.ts   实现 call_hierarchy
packages/coding-agent/src/lsp/client.ts CLIENT_CAPABILITIES.callHierarchy
packages/coding-agent/src/lsp/servers.ts LSP_READONLY_ACTIONS 加入 call_hierarchy
packages/coding-agent/src/lsp/diagnostics.ts PROJECT_INDEXED_ACTIONS 加入 call_hierarchy
packages/coding-agent/src/prompts/agents/scout.md      工具集 + output 信封
packages/coding-agent/src/task/read-only-policy.ts     加入 code_intel
packages/coding-agent/src/config/settings-schema.ts    codeIntel.*
packages/coding-agent/src/mnemopi/embed-protocol.ts    queryEmbed / passageEmbed
packages/coding-agent/src/mnemopi/embed-client.ts      对应 worker 方法
packages/coding-agent/src/mnemopi/embed-worker.ts      query/passage 前缀
docs/tools/code_intel.md
docs/natives-text-search-pipeline.md    增补 code_intel 段
packages/coding-agent/test/tools/code-intel-corpus/    golden grammar + positive/negative fixtures
```

不新增 crate。不新增 Python。不新增独立 daemon：索引是 natives 同步/短任务 + 已有 embed subprocess。

### 4.2 模型可见工具合同

工具名：`code_intel`  
`loadMode`：`"discoverable"`（与 `lsp`/`grep` 同类，不进 `ESSENTIAL_BUILTIN_TOOL_NAMES`）  
`approval`：恒为 `"read"`  
`strict`：`true`

```ts
const codeIntelSchema = type({
  query: type.string
    .atLeastLength(1)
    .atMostLength(20000)
    .describe("Describe the behavior, symbol relationship, or ownership boundary. State intent; do not guess a directory."),
  "depth?": type.enumerated("'auto' | 'focused' | 'extended'").describe(
    "auto infers from relationship words. focused = locate and stop. extended = at most two verified hops.",
  ),
  "path?": type.string.describe("Optional workspace-relative clue, not a hard boundary."),
});
```

单参数 `query` 是默认路径，对齐 CCE。`depth`/`path` 可选；省略时 `depth=auto`，搜索根是 session `cwd`（及 `additionalDirectories`，与 grep 同一 `resolveToolSearchScope`）。

返回：单一 text block，正文为信封；`details` 供 TUI/测试：

```ts
interface CodeIntelToolDetails {
  coverage: "focused" | "extended";
  confidence: "high" | "medium" | "low";
  evidenceCount: number;
  found: boolean; // false when marker is NOT_FOUND
  layers: {
    grep: boolean;
    graph: boolean;
    lsp: boolean;
    semantic: boolean;
  };
  index: {
    state: "ready" | "warming" | "disabled" | "unavailable";
    filesIndexed: number;
    embeddingsReady: boolean;
  };
}
```

空结果：`toolResult().useless()` 仅当 `found===false` **且** 四层都没有候选（连 `gaps` 里的 semantic 候选也没有）。有 `gaps` 候选时不算 useless，避免 compaction 丢掉「未证实但可跟」的线索。

超时：沿用 `TOOL_TIMEOUTS` 新键 `code_intel`，默认 30s，范围 5–180。超时返回截至当时已合并的信封，`gaps` 追加 `timed out after Ns; searched <layers>`，不抛成工具失败（与「CCE 可跑数分钟但 omp 必须有界」的产品选择一致）。

### 4.3 注册与自动纳入

`packages/coding-agent/src/tools/builtin-names.ts` 的 `BUILTIN_TOOL_NAMES` 在 `"lsp"` 后插入 `"code_intel"`。  
`BUILTIN_TOOLS` 增加 `code_intel: s => new CodeIntelTool(s)`。  
`createIf` 形态：`session.settings.get("codeIntel.enabled") === false` 则返回 `null`。

`createTools` 在现有 ast 配对块（`tools/index.ts` grep→ast_grep）旁增加：

- 非 `restrictToolNames`
- `codeIntel.enabled !== false`
- 已有 `grep` 或未限制工具集

则把 `code_intel` 纳入 requested 列表。受限子代理的显式 `tools:` 白名单 **不** 被拓宽（与 ast 配对同一 fail-safe）。scout 在 frontmatter 里显式列出 `code_intel`。

`READ_ONLY_TOOL_NAMES` 加入 `"code_intel"`。不把完整 `"lsp"` 加进该集合（rename 是写）。scout 不声明 `lsp`。

### 4.4 信封渲染（唯一对外格式）

渲染函数 `renderCodeIntelEnvelope(result)` 必须输出 **wire grammar**：

1. 首行恰好 `CCE_SEARCH_RESULT`。
2. `intent:` / `coverage:` / `evidence:` / `gaps:` / `confidence:` 各占字段行，顺序固定。
3. evidence 行：`- path:start-end | symbol | relationship | kind`，path 为 workspace-relative，POSIX 斜杠。
4. 无证据时 `evidence:` 下列 `NOT_FOUND`，不得编造框架惯例位置。
5. 对外 `kind` 枚举只允许：`exact` | `reference` | `source-read` | `semantic`。
6. 内部每条候选必须携带不可丢失的 provenance 判别联合（渲染前不可丢）：

| provenance | 可进 evidence? | 关系字段允许 | 对外 kind |
|---|---|---|---|
| `grep-exact` | 是 | `name matches query token` | `exact` |
| `graph-ranked-context` | 是 | `ranked by def/ref graph` | `source-read` |
| `syntactic-name-reference` | 是 | `name reference (syntactic)` | `source-read` |
| `lsp-reference` | 是 | `referenced` / `implemented`（非 calls） | `reference` |
| `lsp-call` | 是 | `calls` / `called by` | `reference` |
| `call-expression` | 是（仅当 resolver 已实现并测试） | `calls` / `called by` | `reference` |
| `semantic-candidate` | **否**（除非同一 path:line 已被更强 provenance 支撑；支撑后 kind 取更强层，不保留 semantic） | `similar` / `possibly related` | `semantic` 仅出现在 gaps |

**Call-edge 规则**：只有 `lsp-call` 或已验证的 `call-expression` resolver 可以渲染 `calls` / `called by`。当前 identifier tags（`@reference.identifier`）最高是 `syntactic-name-reference`。semantic 永不单独进 evidence，也永不生成 call edge。属性访问、类型引用、导入别名、注释伪调用必须有负向测试。

进入 evidence 前必须用 **当前工作区文件** 的 content hash + 行范围 revalidate；失败则降为 gaps 或丢弃。

与 CCE 的差异（故意、文档化）：

| CCE | omp `code_intel` |
|---|---|
| Cursor 专有 embedding + Explore | 本地 worker + tags 图 + LSP |
| 可跑数分钟 | 硬超时，读稳定 generation |
| `semantic` 可与 source-read 混排 | semantic 不得冒充 call edge；无证实边则 NOT_FOUND |
| 自由文本也可宣称字节相同 | 只保证 wire grammar；自由文本不保证字节相同 |

### 4.5 Layer 1 — 精确文本（已有）

复用 natives `grep()`，不走工具递归。

从 `query` 抽候选 token：

- 连续 `CamelCase` / `snake_case` / `kebab-case` / `` `code` `` 片段
- 关系词剥离后的剩余名词（中英停用词表写死在 `code-intel-merge.ts`，≤80 项）

每个 token 一次字面 grep（正则元字符转义）。`path` 线索只作加权，不是过滤器：0 命中时自动扩到全仓。文件上限与 grep 一致的多样性逻辑：跨文件 cap，避免单文件挤爆信封。

命中 provenance：`grep-exact`。

### 4.6 Layer 2 — Tags 图 + PageRank（natives 新能力）

合同来自 Aider RepoMap，**禁止复制 aider 源码或 `-tags.scm` 原文**。用 `pi-ast` 已支持的 grammar，在 `code_intel.rs` 内写自有 query：

捕获：

- `@definition.function` / `@definition.class` / `@definition.method` / `@definition.module`
- `@reference.identifier`（对未单独建模的语言：把非 def 的 identifier 当 ref）

第一批语言（必须有 round-trip 测试）：TypeScript / TSX / JavaScript / Python / Rust / Go / Java / C / C++。  
`pi-ast` 能 parse 但没有 tags query 的语言：该文件只参与 grep/LSP/chunk，不进图，不报错。

图：有向、加权。边 `ref_symbol → def_symbol`（谁提到谁）。节点键：`path#symbol`。这是 **名字共现图**，不是 call graph。

个性化向量：

- query token 命中的符号 / 文件
- 可选 `path` 线索
- 当前 session 里最近写入/读取的相对路径（由 JS 传入 `seedPaths: string[]`，最多 32 个；从 `ToolSession.fileSnapshotStore` / 最近工具参数收集，缺则空）

PageRank：阻尼 0.85，最多 20 轮或 L1 变化 < 1e-4。稀疏 CSR + 幂迭代，单线程。输出 top N 文件与 top M 符号（默认 N=8、M=16）。这些参数是可调默认，不是已证实终态。

这些命中 provenance 为 `graph-ranked-context` 或 `syntactic-name-reference`。**不得** 升为 `lsp-call` / `call-expression`。

N-API：**禁止** 把全库 tags 数组往返 JS。native 侧持有/加载 generation snapshot；JS 只传 seed、limit、generation id。

```ts
export interface CodeIntelTag {
  path: string;
  name: string;
  kind: "def" | "ref";
  grammar: string;
  startLine: number; // 1-indexed
  endLine: number;
}

export interface CodeIntelRankedNode {
  path: string;
  symbol: string;
  score: number;
  startLine: number;
  endLine: number;
}

export declare function codeIntelBuildGeneration(options: {
  root: string;
  destDir: string;
  hidden?: boolean;
  gitignore?: boolean;
  maxFiles?: number;
  signal?: AbortSignal;
}): Promise<{ filesScanned: number; tagCount: number; parseErrors: string[] }>;

export declare function codeIntelRankGeneration(options: {
  generationDir: string;
  seedPaths?: string[];
  seedSymbols?: string[];
  topFiles?: number;
  topSymbols?: number;
}): CodeIntelRankedNode[];

export declare function codeIntelChunkFile(options: {
  path: string;
  content: string;
}): Array<{ startLine: number; endLine: number; symbol: string; kind: string; text: string }>;
```

诊断/单测可用小规模 `codeIntelExtractTags` 对单文件或 fixture 目录抽取；生产查询路径不把全库 tags 送回 JS。

### 4.7 Layer 3 — LSP 只读导航 + call hierarchy

`code_intel` **内部**只通过 `code-intel-lsp.ts` 只读 facade 调 LSP（白名单：`workspace/symbol`、`textDocument/references`、`textDocument/implementation`、`textDocument/definition`、`textDocument/prepareCallHierarchy`、`callHierarchy/incomingCalls`、`callHierarchy/outgoingCalls`）。不得发 `workspace/applyEdit`、`textDocument/rename`、`workspace/executeCommand`、`reload`。常量 `approval="read"` 不够；facade + 请求方法白名单测试是机械约束。

新增一等 action，避免模型手写 `textDocument/prepareCallHierarchy`：

`lspSchema.action` 增加 `'call_hierarchy'`。

参数：与 `definition` 相同（`file` + `line` + `symbol`），另用 `query` 取 `'incoming' | 'outgoing' | 'both'`，默认 `'both'`。

实现：

1. `textDocument/prepareCallHierarchy`
2. 对每个 item：`callHierarchy/incomingCalls` 与/或 `outgoingCalls`
3. 渲染为 `path:line | symbol | called by / calls | reference`，provenance=`lsp-call`

必须更新：

- `LSP_READONLY_ACTIONS`
- `PROJECT_INDEXED_ACTIONS`
- `CLIENT_CAPABILITIES.textDocument.callHierarchy`（`dynamicRegistration: false`）
- `docs/tools/lsp.md` 与 `prompts/tools/lsp.md`

`code_intel` 使用 LSP 的规则：

- `lsp.enabled === false` 或无已启动 server：跳过本层，`layers.lsp=false`，`gaps` 记 `lsp unavailable`。
- 不在本次调用里 **冷启动** 所有 language server。若 `lsp.lazy` 且尚无 client：只对 PageRank top 文件的后缀尝试 `getOrCreateClient`，单个 server 启动预算 3s（`initTimeoutMs=3000`），失败则跳过。
- workspace/symbol 用 query 中的 identifier；命中后再 `references`（limit 20）和 `implementation`（provenance=`lsp-reference`）。
- 关系词命中时才打 `call_hierarchy`，且只对评分最高的 3 个符号。

### 4.8 Layer 4 — 本地 semantic（可选增强，默认开）

**不** 引入 Milvus / sqlite-vec / 新 ONNX 绑定。不调用通用 `embed()` / 远程 OpenAI-compatible provider。

切分：natives `codeIntelChunkFile`。规则：优先按 tags 的 def 体（函数/类）；超 200 行再按 80 行窗口、40 行重叠切。无 tags 的文件：80/40 行窗口。文本送 embed 前剥 SPDX 头与纯 import 块（第一批语言写死）。

**真实 worker 合同**（替换原稿的同步 `embed(texts)→number[][]`）：

1. `MnemopiEmbedClient.initialize(model, cacheDir)` 返回 `{ embed(texts, batchSize?): AsyncIterable<number[][]> }`。init **无请求超时**，可耗时数分钟（首次下载 sidecar）。
2. 工具查询 **不得 await 无界 init**。background owner（`code-intel-index` 单例）负责 warm：init + passage embed 写入下一 generation。查询只读 **已提交的稳定 generation**；若 embeddings 未就绪：`layers.semantic=false`，`index.state="warming"|"unavailable"`，`gaps` 写 `semantic index warming` 或 `semantic unavailable`，其余三层照常，30s 超时仍返回部分信封。
3. worker 协议扩展：
   - `{ type: "embed", …, texts, role?: "query" | "passage" }`
   - worker 对 E5 系（`fast-multilingual-e5-*`）在 query 文本前加 `query: `、passage 前加 `passage: `；BGE 系不加指令前缀。
   - 未指定 `role` 时保持现有 `embed` 行为（记忆后端兼容）。
4. **模型 resolver（单一、只允许本地）**：
   - 删除伪设置 `codeIntel.embeddingSource`。
   - 默认：`mnemopi.embeddingVariant === "multilingual"` → `fast-multilingual-e5-large`，否则 `fast-bge-base-en-v1.5`。
   - `mnemopi.embeddingModel` / `MNEMOPI_EMBEDDING_MODEL` 仅当能映射到 `fast-*` StandardEmbeddingModel 时才覆盖；OpenAI / OpenRouter / `text-embedding-*` / 自定义 API URL **一律拒绝**，semantic 层关闭。
   - 设置了 `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `mnemopi.embeddingApiUrl` 也不得发 embedding HTTP。
5. **双语决策**：positive corpus 含中文意图 + 英文源码。默认 English BGE **不能**单独作为 Phase 3 中文查询的质量证明。实现路径：
   - `codeIntel.semantic` 开且本地 multilingual 模型缓存可用 → 用 e5-large 做代码索引（可与记忆 variant 不同；generation manifest 记录实际 `embeddingModel` + dim）。
   - 否则保留 English BGE，中文 query 仍走 Layer 1/2/3；semantic 对中文 query 记 gaps `semantic model is English-only; identifier/graph/LSP used`。Phase 3 中文 positive 查询必须由 Layer 1/2/3 命中锚点，不得依赖 English BGE。
6. 检索：稳定 generation 的 `embeddings.f32`（row-major f32）+ `vectorIndexTopK`。取 top 24 后 `mmrRerankIndices`，留 8 条。hybrid `0.7 * dense + 0.3 * lexical` 是可调默认。

Windows：embed 继续在 `__omp_worker_mnemopi_embed` 子进程。主进程禁止加载 onnxruntime。

`semantic-candidate` 默认进 `gaps`。仅当同一 `path:line` 已被 Layer 1/2/3 支撑时，evidence kind 取更强层。

### 4.9 索引存储与失效

根目录：`dirs.rootSubdir("code-intel", "state")/<project-key>/`（即 `~/.omp/code-intel/<project-key>/`，尊重 XDG）。

**project-key 合同（独立于 daemon broker）**：`sha256(canonicalProjectDir(root))` 的前 16 hex。`canonicalProjectDir` 复用 `packages/coding-agent/src/launch/paths.ts`（resolve + realpath，ENOENT 回退 resolve）。**不** 复用 `Bun.hash.wyhash(path.resolve(projectDir))`：broker 的 wyhash 不是 sha256，也不做 realpath，symlink/Windows 会分叉。code-intel 需要跨平台稳定、可文档化的目录键，因此显式使用独立 sha256 合同，并测试 symlink 归一化。

**Generation snapshot（HIGH-4）**：

```text
<project-key>/
  CURRENT                     # 单行 generation id；rename 原子切换
  generations/<id>/
    manifest.json              # version, root, gitHead, embeddingModel, dim, fileCount,
                               # tagsHash, chunksHash, embeddingsRows, embeddingsDim, graphHash
    files.jsonl
    tags.bin / graph.csr       # native 持有；JS 不拉全量 tags
    chunks.jsonl               # 元数据 + textHash + contentHash + start/end line；不存正文
    embeddings.f32             # n×dim；n 必须等于 chunks 行数
```

提交协议：

1. 写入 `generations/<id>.tmp/` 全部文件。
2. 校验：`embeddings` 行数 = chunks 行数；dim 与 manifest 一致；每个 chunk 的 contentHash 对应当前文件；未知 `manifest.version` 拒绝。
3. `fsync` 后把目录 rename 为 `generations/<id>/`，再原子 rename `CURRENT` 指向 `<id>`。
4. 查询持有打开时读到的 generation id；warm 写下一份，互不混用。崩溃中断留下 `.tmp` 的 generation 永不成为 CURRENT。

外部变更检测（同一 HEAD 下 IDE/bash/generator 写入）：

- omp 写工具 hooks 仍调用 `codeIntelIndex.invalidate(path)`。
- 每次查询前做有界 metadata sweep：对 CURRENT 的 `files.jsonl` 抽查 mtime/size；不一致则对该 path 标 dirty。可选 `fs.watch` 加速，但不能替代 sweep。
- dirty 文件在进入 evidence 前必须用当前 content hash + 行范围 revalidate。

SCIP：若存在 `index.scip`，def/ref 记为 `lsp-reference` 强度的名字引用，**仍不是** call edge。失败则忽略，gaps 不提 SCIP。

体积上限：`codeIntel.maxIndexFiles` 默认 20000；`codeIntel.maxEmbedFiles` 默认 4000（按 PageRank 文件优先）。超出记 gaps 截断。这些上限是可调默认。

索引目录不可写：内存一次性 tags/rank，不持久化。

### 4.10 SCIP 摄入（可选，非默认依赖）

若工作区存在 `index.scip` 或 `.omp/index.scip`，启动时尝试解析 SCIP protobuf（优先自写最小 decode，只读 `documents[].occurrences` 的 def/ref）。成功：SCIP def/ref 作为 `lsp-reference` 强度的名字引用，**不得** 渲染 `calls`/`called by`。失败：忽略文件，`gaps` 不提 SCIP。

**不** 捆绑 `scip-typescript` / rust-analyzer `--print scip`。无 SCIP 时默认路径必须完整可用。

### 4.11 scout 与主 agent 路由

`packages/coding-agent/src/prompts/agents/scout.md`：

```yaml
tools: read, grep, glob, ast_grep, code_intel, web_search
```

`output` 改为：

```yaml
output:
  properties:
    envelope:
      type: string
      metadata:
        description: Exact CCE_SEARCH_RESULT block, unmodified
    summary:
      type: string
      metadata:
        description: One-paragraph explanation in the user language; do not restate evidence lines
  optionalProperties:
    follow_up:
      type: string
```

scout 指令改为：未知位置 **先** `code_intel` 一次；`NOT_FOUND` 后才允许一轮 grep/glob 回退；禁止把 `semantic` 或 tags 名字引用写成 calls。`web_search` 仅当任务明确是外部库/文档。

主 agent 工具说明写明：已知精确路径/符号用 `read`/`lsp`；测试/日志/构建/git/外部文档不用 `code_intel`。

不添加 PreToolUse hook 去拦截 `grep`。

### 4.12 Settings

插在 `settings-schema.ts` 的 LSP 块之后、`bash.enabled` 之前；`TAB_GROUPS.files` 增加 `"Code Intel"`：

| Key | Type | Default | 含义 |
|---|---|---|---|
| `codeIntel.enabled` | boolean | `true` | 关闭则工具不注册 |
| `codeIntel.semantic` | boolean | `true` | 关闭则永不唤起 embed worker |
| `codeIntel.depthDefault` | enum `auto\|focused\|extended` | `auto` | 省略 `depth` 时的值 |
| `codeIntel.maxIndexFiles` | number | `20000` | tags 扫描文件上限（可调默认） |
| `codeIntel.maxEmbedFiles` | number | `4000` | 进入 embedding 矩阵的文件上限（可调默认） |
| `codeIntel.timeoutSec` | number | `30` | 文档值；真正 clamp 走 `TOOL_TIMEOUTS.code_intel`（5–180） |

不新增 `codeIntel.model` / `codeIntel.embeddingSource`。本地模型由 4.8 的单一 resolver 决定。

### 4.13 错误与降级矩阵

| 情况 | 行为 |
|---|---|
| 空 query / 超长 | 普通工具文本错误，不写信封 |
| cwd 不可读 | 与 grep 相同的 path 错误 |
| natives addon 缺 `codeIntelBuildGeneration` / `codeIntelRankGeneration` | 跳过图与 chunk，仅 grep+LSP；`gaps`: `native code_intel symbol missing; restart omp after upgrade` |
| LSP 全失败 | 跳过 Layer 3 |
| embed worker 失败 / `mnemopi.noEmbeddings` / 远程模型被拒绝 | 跳过 Layer 4 |
| 四层全空 | `NOT_FOUND`，`confidence: low`，`gaps` 列已尝试层 |
| 超时 | 部分信封 + timeout gap；读已提交 generation |
| 索引目录不可写 | 内存一次性 tags，不持久化 |
| init 仍在跑 | 不阻塞查询；`index.state=warming` |

任何一层失败都 **不得** 打开 MCP、不得提示「请安装 Cursor」、不得调用远程 embedding HTTP。

### 4.14 TUI / compaction

渲染器仿 `grepToolRenderer`：折叠态一行 `code_intel · focused · 4 evidence · high`；展开显示信封原文。路径走 `fileHyperlink`。

Compaction：`found===false` 且无 gaps 候选 → `useless`。有 evidence 的结果按普通工具输出走 token prune，不特判。

### 4.15 测试合同（必须能指出失败时用户看见什么）

禁止源码字符串扫描（AGENTS.md）。

**Wire grammar**：`packages/coding-agent/test/tools/code-intel-corpus/grammar/` 冻结 golden envelope；consumer parser 断言 marker、字段顺序、枚举、换行、`NOT_FOUND`。

**Positive corpus（不得 `NOT_FOUND`）**，中英各一条，命中预期 path/symbol：

- isolation worktree → `packages/coding-agent/src/task/worktree.ts` · `ensureIsolation`
- hub wait timeout useless → `packages/coding-agent/src/tools/hub/jobs.ts` · `isWaitingPollDetails`
- LSP rename default apply → `packages/coding-agent/src/lsp/tool.ts` · `shouldApply` / `apply !== false`

**Negative corpus（才允许 `NOT_FOUND` / 禁止 call edge）**：

- 虚构符号 `DefinitelyNotInRepo_XYZ` → `NOT_FOUND`，`gaps` 非空
- 注释 “calls beta” 无调用表达式 → 不得出现 `calls`/`called by`
- 同名跨文件非调用、属性/类型引用 → 不得升格为 call edge
- 仅 semantic 命中 → evidence 为 `NOT_FOUND`，semantic 在 gaps

Natives：

- `fn alpha() { beta(); }` / `fn beta() {}`：seed=`alpha` 时 `beta` PageRank 高于无关符号
- tags 行号 1-indexed 且覆盖 `beta` 定义行
- 注释伪调用不得产生 call edge

Tool：

- `codeIntel.semantic=false` 时 `layers.semantic===false` 且标识符 query 仍能 exact
- 超时：AbortSignal 触发后仍返回以 `CCE_SEARCH_RESULT` 开头的文本，且不 await 无界 init
- generation：bash/IDE 风格外部改文件后 evidence 行号与当前文件一致；chunk 数增减后 embeddings 行数匹配；崩溃 `.tmp` 不被 CURRENT 指向；并发 warm 时查询只读旧 generation
- 设置 OpenAI/OpenRouter env 仍不得发 embedding HTTP

LSP：`call_hierarchy` 在 fake server 上 incoming/outgoing 各至少一条；只读 session 允许该 action、拒绝 `rename`；capability negotiation 测试覆盖 `CLIENT_CAPABILITIES.callHierarchy`；只读 facade 拒绝 applyEdit/rename。

Scout：frontmatter `tools` 含 `code_intel`、`ast_grep`，不含 `lsp`；`isReadOnlyAgent(scout)===true`。

注册：`BUILTIN_TOOL_NAMES` 与 `BUILTIN_TOOLS` 键一致的现有 drift 测试自动覆盖新名。

### 4.16 发布与 addon 版本

新 napi 导出要求 addon 与 JS 同步。`packages/natives/package.json` 当前 `18.0.5`，本功能按 **minor**：`18.1.0`，sentinel `__piNativesV18_1_0`。旧 addon 缺符号时走 4.13 降级（探测 `codeIntelBuildGeneration` / `codeIntelRankGeneration`）。

不改 Python 3.12 约束。Rust 新依赖尽量为零：PageRank / CSR / tags 用 std + 已有 `pi-ast` / `pi-walker` / `xxhash-rust` / `napi`。禁止 rusqlite、usearch、fastembed-rs。

### 4.17 分阶段落地（实现顺序，不是可选范围）

终态仍是「无 Cursor CCE 的完整 `code_intel`」。阶段只约束合并顺序，不授权砍掉 Layer 4。

1. **信封 + Layer 1/3 + scout + call_hierarchy + 只读 facade + wire grammar parser**  
   已能回答标识符/符号级问题；无图、无 embed。positive corpus 中带标识符的查询应开始命中。
2. **Layer 2 tags/PageRank + generation snapshot**  
   行为描述开始有相关文件排序；外部变更 + 原子切换测试必须绿。
3. **Layer 4 本地 semantic + query/passage + 升格规则**  
   **「取代 CCE」宣传闸门**：1.2 的可执行 gate 全绿。仅「本阶段测试绿」不够；positive corpus 的 `NOT_FOUND` 不能通过。

每个阶段独立可发布。阶段 1/2 changelog / 文档 **不得** 宣称取代 CCE。

---

## 5. 风险与验证

### 5.1 风险

| 风险 | 缓解 |
|---|---|
| 本地 embedding 弱于 Cursor 代码模型 | 成功标准不要求打平 NL 质量；semantic 不升格为 call edge；中文 positive 不依赖 English BGE |
| rust-analyzer 冷启动拖死第一次查询 | 3s 启动预算；不在 code_intel 里 warmup 全语言 |
| tags 假边 | identifier tags 不得渲染 calls；confidence 封顶 medium |
| 无界 init 吃掉 30s | background warm owner；查询只读稳定 generation |
| 索引把源码写到 `~/.omp` | chunks 默认只存 hash；embed 时读工作区 |
| 外部写入混用旧行号 | generation + evidence 前 revalidate |
| addon 体积 | 不加新 ML/DB crate |
| scout 只读分类被 lsp 破坏 | scout 不声明 lsp |
| 实现者去接 cursor-bridge「过渡」 | 本设计否决过渡 MCP；PR 若新增默认 cursor MCP 视为回归 |
| 实现者复用通用 `embed()` 出网 | 类型上只暴露 local worker；env key 集成测试 |

### 5.2 验证

- 单元：4.15。
- natives：`bun --cwd packages/natives test` 中与 code-intel 相关文件。
- coding-agent：聚焦 `code-intel` / `lsp` / scout parse 测试，不默认全量。
- 功能：positive/negative corpus；轨迹无 Cursor 进程、无 `cursor_context_engine`/`cursor_do`、无 `mcp__*`。
- 回归：现有 grep/lsp/ast_grep 测试全绿；`essential-tools` drift 测试仍过。

---

## 6. 已确认事实 / 未确认假设

### 已确认事实

- omp 无统一 `code_intel` 入口；无代码库向量索引；Mnemopi embeddings 仅用于记忆。
- LSP action 集合无 `call_hierarchy`；`CLIENT_CAPABILITIES` 无 `callHierarchy`；`LSP_READONLY_ACTIONS` 见 `lsp/servers.ts`。
- scout 工具集为 `read, grep, glob, web_search`，无 lsp/ast_grep。
- `READ_ONLY_TOOL_NAMES` 不含 `lsp`。
- natives 已有 `ast`/`grep`/`pi-walker`/`vectorIndexTopK`/`mmrRerankIndices`/`invalidate_fs_scan_cache`。xxhash 仅内部用于 file-lock，无 napi 导出。
- `MnemopiEmbedClient.initialize` 无界；`embed` 返回 `AsyncIterable<number[][]>`；worker 协议只有通用 `embed`，无 query/passage role。
- `mnemopi.embeddingVariant` 默认 `en`（BGE English）。
- daemon project-key 是 `Bun.hash.wyhash(path.resolve(projectDir))` 16 hex，**不是** sha256(canonical root)。
- 仓库默认路径没有 cursor-bridge / CCE 实现或 parser。
- 用户已否决「内化后仍接 CCE」：本设计无 Cursor CCE 回退路径。

### 未确认假设

- PageRank 对行为查询的边际收益；20k/4k 上限对巨型 monorepo 的覆盖。
- 默认 English BGE 对中文意图的召回（因此中文 positive 不依赖它）。
- 本地 semantic + 一到两跳关系检索相对 CCE 的质量。**未做 A/B；不得从「原语存在」推断「足以取代 CCE」。**
- 保留 `CCE_SEARCH_RESULT` 标记名不会与真实 Cursor 输出冲突（默认不再接入 CCE）。

### 对实现的影响

- 主路径（统一入口、provenance、只读、无 Cursor CCE 回退、generation 原子切换）可实现。
- Phase 3「取代 CCE」是独立质量门禁，绑定 positive/negative corpus，而不是测试文件存在。

---

## 7. 根因分析

本设计不依赖线上故障根因。能力缺口已由库存证实：缺的是 **融合检索 + 证据信封 + 本地图/向量**，不是某个 grep bug。

评审结论：该缺口判断为 `WEAK_EVIDENCE` 中的「能力缺口 SUPPORTED、质量结论 OVERREACHING」。修订后：方案 D 只承诺可内化的信封合同与开源可重现层；「取代 CCE」改为 corpus gate，不再从原语存在直接推出。

---

## 8. Handoff

### 8.1 同会话继续

直接执行 $design-implement 或 /design-implement

### 8.2 新会话恢复 prompt

```text
请阅读设计输入 docs/superpowers/specs/2026-09-02-native-code-intelligence-without-cursor-cce-design.md
以及评审文档 docs/superpowers/plans/2026-09-02-native-code-intelligence-without-cursor-cce-design-review.md，
重点核对根因分析（如有）、事实/假设边界、以及方案修订点，
使用 $design-implement（或 /design-implement）进行方案修订及实现。
重点关注：HIGH-1 把阶段 3 的“取代 CCE”门禁改为 positive corpus 必须命中已知正确锚点且覆盖中英文查询，NOT_FOUND 不能通过；HIGH-2 用不可丢失 provenance 的判别联合约束关系升格，semantic 与当前 identifier tags 均不得生成 call edge，只有 LSP call hierarchy 或另行验证的 call-expression resolver 可证明调用；HIGH-3 修正本地 embedding 的真实 initialize/async-iterable 与 query/passage 合同，并处理默认 English 模型、无界初始化和 30 秒超时；HIGH-4 为 tags/chunks/embeddings 定义可检测外部变更且跨文件原子切换的 generation snapshot。
```

---

## 9. 修订记录

- 2026-09-02：按 design-review `NEEDS_REVISION` 采纳 HIGH-1..4 与相关 MEDIUM。根因策略：修订后实现。能力缺口沿用；「阶段 3 测试绿即可取代 CCE」从成功标准删除，改为 positive/negative corpus gate。semantic/tags 不得生成 call edge。embedding 按真实 initialize/async-iterable + query/passage + background warm 重写。索引改为 generation snapshot + 独立 sha256 project-key。文件清单补 `lsp/client.ts`、只读 facade、embed protocol。合同目标改为 wire grammar compatible。
