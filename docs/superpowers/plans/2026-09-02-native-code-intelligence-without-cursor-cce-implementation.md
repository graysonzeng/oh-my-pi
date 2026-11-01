# Implementation: 原生 Code Intelligence（取代 Cursor CCE，不再接入 Cursor）

- Date: 2026-09-02
- Design Doc: docs/superpowers/specs/2026-09-02-native-code-intelligence-without-cursor-cce-design.md
- Review Doc: docs/superpowers/plans/2026-09-02-native-code-intelligence-without-cursor-cce-design-review.md
- Status: Completed

## 1. 评审意见处理摘要

- 采纳 HIGH-1：Phase 3「取代 CCE」门禁改为 positive corpus 必须 `found=true` 且命中已知 path/symbol；`NOT_FOUND` 不能让正向查询通过。negative corpus 才允许 `NOT_FOUND`。中英文各三条锚点查询都有测试。
- 采纳 HIGH-2：provenance 做成不可丢失判别联合。`semantic-candidate` 与 identifier tags（`syntactic-name-reference` / `graph-ranked-context`）不得渲染 `calls`/`called by`。只有 `lsp-call` 与已测试的 `call-expression` resolver 可证明调用。
- 采纳 HIGH-3：embedding 走真实 `initialize` + async-iterable `embed(..., role)`。query/passage 前缀按 E5 合同加；默认 English BGE 对中文查询不作为质量证明，查询路径不阻塞无界 init。
- 采纳 HIGH-4：索引是 generation snapshot。查询读 `CURRENT`；warm 写入 `generations/<id>.tmp` 后原子切换；崩溃的 `.tmp` 永远不是 current。project-key 用 `sha256(canonicalProjectDir)` 前 16 hex，明确不复用 broker wyhash。
- 采纳相关 MEDIUM：LSP `CLIENT_CAPABILITIES.callHierarchy`、只读 facade 白名单、scout 显式 `code_intel` 且不列 `lsp`、`READ_ONLY_TOOL_NAMES` 加入 `code_intel`、远程 embedding URL/模型拒绝。
- 未采纳「阶段 3 测试绿即可宣称取代 CCE」：该句从成功标准删除。当前实现满足可执行 corpus gate，但未对 Cursor CCE 做 A/B，changelog/文档不得把「取代 CCE」写成已证实质量结论。
- 未落地：外部文件 watcher / content-hash sweep 全覆盖、证据进入 envelope 前的 live file hash revalidate、跨仓库 A/B。这些记在 §6。

## 2. 根因前提处理结论（按需）

- 适用性：适用
- 处理策略：修订后实现
- 结论：能力缺口（无统一 `code_intel` 入口、无 call hierarchy、无代码向量索引、无 CCE 信封）有代码证据，稳定，作为实现前提。「阶段 3 质量足以取代 CCE」仍是 WEAK_EVIDENCE，不作为发布声明前提。

### 2.1 消费的根因评审结论

- 缺少统一原生入口 / scout 信封 / call hierarchy / 代码向量索引：`SUPPORTED`
- 「这些层正是 CCE 优势的原因」及「Phase 3 足以取代 CCE」：`WEAK_EVIDENCE` / `OVERREACHING`（已从成功标准删除，改为 corpus gate）
- 当前仓库默认无 Cursor CCE 后端：`SUPPORTED`

### 2.2 本次修订的前提边界

- 已确认事实：scout 原先无 `code_intel`；LSP 无 `call_hierarchy`；只读分类不接受完整 `lsp`；本地 embed worker 与 `mmrRerankIndices`/`vectorIndexTopK` 可复用；默认路径无 cursor-bridge。
- 未确认假设：PageRank 对行为查询的边际收益；4000 embedding 文件覆盖；English BGE 对中文意图的召回；相对 Cursor CCE 的质量。
- 对实现的影响：Layer 1/2/3 必须在无 semantic、无 LSP 时仍能命中 positive corpus。semantic 失败只写 gaps。不得用假 call edge 凑 `found=true`。

## 3. 采纳的设计修订

1. HIGH-1：`packages/coding-agent/test/tools/code-intel-corpus.test.ts` 冻结三条中英锚点 + 虚构符号 `NOT_FOUND` + 注释伪调用负向。positive 断言同一 evidence 行同时含 path+symbol，禁止 `NOT_FOUND`。另有「符号名不在文件名」正向。
2. HIGH-2：`code-intel-envelope.ts` 的 `CALL_EDGE_PROVENANCE = {lsp-call, call-expression}`。`toEvidenceLine` 对 semantic 返回 null；tags/graph 关系字段不是 `calls`/`called by`。Rust `call.name` 捕获与 identifier tags 分离。
3. HIGH-3：`mnemopi/embed-protocol.ts` 增加 `role?: "query"|"passage"`；`applyEmbedInstructionPrefix` 只给 multilingual-e5 加前缀。`code-intel-embed.ts` 拒绝 remote URL/非 fastembed id。查询路径只消费已附着 handle；`semanticHits` 不 `initialize`；query embed 尊重 AbortSignal。
4. HIGH-4：`code-intel-index.ts` 持有 CURRENT generation。`ensureReady()` / `invalidate()` / `graphLayer` 调度 `warm()`；`.tmp` rename 后写 CURRENT；崩溃 `.tmp` 永不成为 current。dirty 后链式 rebuild。project-key 独立 sha256。
5. 检索层：glob 只作排序提示；每个 identifier 对 cwd 与 `additionalDirectories` 做有界字面 grep。passage 按 chunk 行范围切源码正文，独立 embeddings ledger。只读 LSP 期间 `holdLspApplyEdits` 拒绝入站 `workspace/applyEdit`。

## 4. 实现摘要

核心模块：

- `crates/pi-natives/src/code_intel.rs` — tags、call-expression、PageRank、generation I/O、N-API
- `packages/natives/native/index.{js,d.ts}` — `codeIntelExtractTags` / `BuildGeneration` / `RankGeneration` / `ExtractCalls` / `ChunkFile`
- `packages/coding-agent/src/tools/code-intel.ts` — 工具类：grep → tags/PageRank → 只读 LSP → 可选 semantic
- `packages/coding-agent/src/tools/code-intel-envelope.ts` — `CCE_SEARCH_RESULT` wire grammar
- `packages/coding-agent/src/tools/code-intel-merge.ts` — token、provenance merge、lexical ranking、`capEvidence`
- `packages/coding-agent/src/tools/code-intel-index.ts` — generation snapshot owner
- `packages/coding-agent/src/tools/code-intel-embed.ts` — 本地-only resolver
- `packages/coding-agent/src/tools/code-intel-lsp.ts` — 只读方法白名单 + 3s init budget
- `packages/coding-agent/src/tools/code-intel-natives.ts` — 旧二进制缺符号时跳过 graph，不抛
- `packages/coding-agent/src/lsp/{types,tool,client,servers}.ts` — `call_hierarchy` action / capability / readonly set
- `packages/coding-agent/src/prompts/agents/scout.md` — tools 含 `code_intel`，不含 `lsp`
- `packages/coding-agent/src/task/read-only-policy.ts` — `code_intel`
- `packages/coding-agent/src/config/settings-schema.ts` — `codeIntel.*`
- `docs/tools/code_intel.md`、`packages/coding-agent/src/prompts/tools/code-intel.md`

合同：

- 工具名 `code_intel`，`approval: "read"`，`loadMode: "discoverable"`
- 输出首行 `CCE_SEARCH_RESULT`，字段顺序 `intent/coverage/evidence/gaps/confidence`
- 无 verified evidence → `evidence: NOT_FOUND`
- 查询超时（默认 30s）返回部分信封 + timeout gap，不抛成工具失败
- 查询不阻塞无界 `initialize`；semantic 冷索引只写 `semantic index warming`
- 只读导航期间入站 `workspace/applyEdit` 回复 `{applied:false}`

## 5. 验证结果

- 测试：
  - `bun test packages/coding-agent/test/tools/code-intel-envelope.test.ts packages/coding-agent/test/tools/code-intel-index.test.ts packages/coding-agent/test/tools/code-intel-corpus.test.ts`
  - 结果：19 pass / 0 fail / 77 expect
  - 覆盖：wire grammar、NOT_FOUND、semantic/tags 不得 call edge、incoming `called by`、E5 query/passage 前缀、远程 embedding 拒绝、中英 isolation/hub-wait/LSP-rename 同证据行 path+symbol、符号不在文件名、虚构符号 NOT_FOUND、注释 `// calls beta` 不进 evidence 关系字段、CURRENT 原子发布、crash `.tmp` 忽略、invalidate 重建、query-time `semanticHits` 不 `initialize`、warm 才 `initialize`
  - `bun test packages/coding-agent/test/tools/lsp-regressions.test.ts -t "refuses inbound workspace/applyEdit"`
  - 结果：1 pass / 0 fail
  - `cargo test -p pi-natives --profile local --lib code_intel`：本轮 PATH 无 cargo；先前会话 2 passed（`rust_tags_cover_def_and_skip_comment_call`、`pagerank_seeds_alpha_ranks_beta_above_unrelated`）。本轮改动未改 `crates/pi-natives/src/code_intel.rs`。
- lint/typecheck：`cd packages/coding-agent && bun check` → biome 无诊断，`tsgo --noEmit` 通过
- 功能验证：corpus 即 HIGH-1 门禁。未跑 Cursor CCE A/B；未跑全仓 `bun test` / 全 workspace `bun check`。

## 6. 已知限制与后续建议

- 「取代 CCE」仍不可宣传：没有与 Cursor 的同查询轨迹或召回/false-edge A/B。当前 gate 只证明原生路径能命中本仓库三条锚点，且不造假 call edge。
- 默认 English BGE：中文查询成功不依赖 semantic。若开启 semantic 且模型 English-only，中文查询跳过该层并写 gap。
- 无界 `initialize`：查询不 wait warm。首次本地模型下载/缓存仍可能出网（Hugging Face / GCS）；这不等于云向量推理，但不是完全离线。
- HIGH-4 的外部变更检测不完整：CURRENT 原子切换已落地；同一 HEAD 下 IDE/bash/生成器写入没有 watcher 或 content-hash sweep；证据进入 envelope 前未做 live file hash revalidate。
- PageRank / 20k/4k / glob 配额是可调默认，不是 A/B 冻结终态。
- natives 旧二进制缺符号时 graph 层跳过；需 `bun run build:bindings` 或升级 omp。

## 7. Handoff

### 7.1 同会话继续

`直接执行 $code-review 或 /code-review`

### 7.2 新会话恢复 prompt

```text
请阅读设计文档 docs/superpowers/specs/2026-09-02-native-code-intelligence-without-cursor-cce-design.md、
评审文档 docs/superpowers/plans/2026-09-02-native-code-intelligence-without-cursor-cce-design-review.md、
实现文档 docs/superpowers/plans/2026-09-02-native-code-intelligence-without-cursor-cce-implementation.md，
以及本次提交的代码变更。
重点核对根因前提（如有）、设计修订、实现结果与验证证据是否一致，
使用 $code-review（或 /code-review）进行方案重审及代码审查。
重点关注：HIGH-1 positive corpus 必须命中已知锚点且覆盖中英文，NOT_FOUND 不能通过正向查询；HIGH-2 semantic 与 identifier tags 不得生成 call edge；HIGH-3 本地 embedding initialize/async-iterable 与 query/passage，查询不阻塞无界 init；HIGH-4 generation snapshot 原子切换。
```
