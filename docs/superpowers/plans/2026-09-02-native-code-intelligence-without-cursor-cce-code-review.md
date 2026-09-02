# Code Review: 原生 Code Intelligence（取代 Cursor CCE，不再接入 Cursor）

- Date: 2026-09-02
- Design Doc: `docs/superpowers/specs/2026-09-02-native-code-intelligence-without-cursor-cce-design.md`
- Review Doc: `docs/superpowers/plans/2026-09-02-native-code-intelligence-without-cursor-cce-design-review.md`
- Implementation Doc: `docs/superpowers/plans/2026-09-02-native-code-intelligence-without-cursor-cce-implementation.md`
- Reviewer: `sol-xhigh-reviewer`（gateway/gpt-5.6-sol xhigh）
- Status: FIXED（审查 HIGH/MEDIUM 已落地，待二次 code-review）

## 1. 整体结论

- **审查时：NEEDS_FIX**（无 CRITICAL。6 HIGH + 2 MEDIUM）
- **修复后：** HIGH-1 闸门锁同一 evidence 行 path+symbol；HIGH-3 查询不 `initialize`；HIGH-4 生产路径调度 `warm()` 且 crash `.tmp` 不是 CURRENT；入站 `workspace/applyEdit` 只读 hold 拒绝写盘。HIGH-2 原已 PASS。

## 2. 设计一致性

| Gate / 合同 | 实现 | 结果 |
|---|---|---|
| HIGH-1 EN+ZH 锚点，`NOT_FOUND` 不能过正向查询 | `code-intel-corpus.test.ts` 六条正向均 `found=true`；14 pass / 0 fail | 行为 PASS；闸门不完整（MEDIUM） |
| HIGH-2 semantic / identifier tags 不得 call edge | `CALL_EDGE_PROVENANCE={lsp-call,call-expression}`；Rust `call.name` 与 tags 分离 | PASS |
| HIGH-3 查询不阻塞无界 init；query/passage；English BGE 不算中文质量证明 | role/前缀/远程拒绝/中文跳过存在；查询仍 `initialize`；passage 无源码 | FAIL |
| HIGH-4 generation snapshot 原子 CURRENT；崩溃 `.tmp` 不是 current | `.tmp→rename→CURRENT` 顺序在；`warm()` 无生产调用者 | FAIL |
| 只读 LSP facade，无 rename/apply | 出站白名单成立；入站 `workspace/applyEdit` 仍写盘 | FAIL |
| scout 含 `code_intel` 不含 `lsp`；`READ_ONLY_TOOL_NAMES` | `scout.md` + `read-only-policy.ts` | PASS |
| 无 Cursor CCE / MCP 轨迹 | scoped search 无 `cursor_context_engine` / `cursor_do` / `cursor-bridge` | PASS |

## 3. Findings

### [HIGH] 索引生命周期: generation warm 从未接入生产调用，失效标记也不会触发重建

**文件**: `packages/coding-agent/src/tools/code-intel.ts:345-374`; `packages/coding-agent/src/tools/code-intel-index.ts:154-174,245-255`

**问题**: 查询路径只调用 `ensureReady()` 和 `rank()`；`warm()` 没有生产调用者。`ensureReady()` 在没有 `CURRENT` 时只把状态设为 `warming`，不调度 `#buildNext()`。`invalidate()` 只写入 `#dirty`，`#dirty` 不参与调度。即使将来调用一次 `warm()`，`#warm` 成功/失败后都不清空，后续重建被 `if (this.#warm) return` 永久拦住。

**影响**: 新项目永远不会生成 `CURRENT`；PageRank / semantic generation 在工具路径上不可达；omp 写入也不会更新已有 generation。HIGH-4 只剩未接线的私有代码。

**建议**: 后台 owner 在缺失/dirty 时调 `warm()`；`finally` 清空 in-flight promise；补冷启动读旧/空 snapshot、后台 warm、原子切换、dirty 后下一代的行为测试。

### [HIGH] 超时/Embedding: 查询仍会等待无界 initialize，30 秒部分信封不成立

**文件**: `packages/coding-agent/src/tools/code-intel.ts:430-551`; `packages/coding-agent/src/tools/code-intel-index.ts:199-228`

**问题**: `semanticHits()` 在查询路径 `await tryInitializeLocalEmbed()` → 无超时的 `MnemopiEmbedClient.initialize()`。`signal` 声明未使用。外层 30s timeout 不能打断 initialize。

**影响**: 已有 snapshot 但 worker 未附着时，查询可越过 `codeIntel.timeoutSec`，落到无界 init / 120s embed timeout，拿不到部分信封。

**建议**: 查询只消费后台已附着的 handle；不要在 query path 初始化模型。

### [HIGH] Semantic 数据面: passage 没有源码正文，且截断后矩阵与 chunk 行号账本不一致

**文件**: `packages/coding-agent/src/tools/code-intel-index.ts:209-245,321-365`

**问题**: passage 文本只有 ``${chunk.kind} ${chunk.symbol}\n${chunk.path}``。`maxEmbedFiles` 截断后查询仍读完整 `chunks.jsonl`，要求 `floats.length === chunks.length * dim`，超限必然空命中。

**影响**: Layer 4 没有代码语义；大仓库 semantic 被长度检查整体关闭。

**建议**: 按 path+行范围切源码正文；独立、顺序稳定的 embeddings ledger；发布前校验 rows/dim。

### [HIGH] 检索正确性: exact grep 被文件名 glob 前置过滤，存在的符号可被错误报为 NOT_FOUND

**文件**: `packages/coding-agent/src/tools/code-intel.ts:175-240`

**问题**: `grepLayer()` 先按 token 做文件名/目录 glob，只在这些文件内 grep；glob 为空则完全跳过。符号名不出现在路径里时 Layer 1 读不到。`additionalDirectories` 未进入搜索范围。现有三条 corpus 都带路径词，过拟合。

**影响**: 核心 exact 层可对真实存在的符号输出 `NOT_FOUND`。

**建议**: glob 只作排序提示；每个 identifier 至少对 cwd（及 additionalDirectories）做有界字面 grep。增加「符号名不在文件名里」的正向测试。

### [HIGH] 只读边界: facade 禁止出站 apply/rename，但底层 client 仍承诺并自动执行服务端 workspace/applyEdit

**文件**: `packages/coding-agent/src/lsp/client.ts:190-204,499-519`

**问题**: `code-intel-lsp.ts` 出站白名单不含 rename/apply，但共享 client 声明 `workspace.applyEdit: true`，入站 `workspace/applyEdit` 直接 `applyWorkspaceEditWithLsp()`。

**影响**: `approval: "read"` 的 `code_intel` 期间，异常/恶意 LSP server 可改工作区。

**建议**: 只读导航期间 fail-closed 回复 `{applied:false}`；用 fake server 在 symbol/callHierarchy 期间发 applyEdit，断言文件不变。

### [HIGH] Generation 提交: `.tmp` 顺序正确但缺少发布前校验与 crash-durability

**文件**: `packages/coding-agent/src/tools/code-intel-index.ts:282-311`

**问题**: 写入顺序正确且拒绝 `.tmp` id，但没有 embeddings/chunks row、dim、contentHash 校验，也没有 fsync。Windows `replaceFileAtomically` 中间存在无 `CURRENT` 窗口。

**影响**: 内部不一致的 final generation 仍可能成为 current。

**建议**: 发布前验证不变量；fsync 关键文件；加载时拒绝 hash/row/dim 不一致的 embeddings（graph 仍可用）。Windows CURRENT 窗口沿用现有原子原语，记为已知限制。

### [MEDIUM] 测试合同: 两条中文 positive 没有同时锁定 path + symbol

**文件**: `packages/coding-agent/test/tools/code-intel-corpus.test.ts:53-74`

**问题**: 中文 hub-wait 只锁 symbol；中文 LSP rename 只锁 path。可用两行拼出字符串过闸门。

**建议**: 六条正向都解析同一 evidence 行同时匹配 path 与 symbol。

### [MEDIUM] 发布说明: changelog 把不可达的图与 semantic 层写成已交付能力

**文件**: `packages/coding-agent/CHANGELOG.md:3-8`

**问题**: 在 warm 未接线时声称四层融合。

**建议**: 先修再保留描述；否则收窄措辞。

## 4. HIGH-1..4 gate

- **HIGH-1: PASS（当前 corpus 行为），闸门不完整。**
- **HIGH-2: PASS。**
- **HIGH-3: FAIL。**
- **HIGH-4: FAIL。**

## 5. 已核实（非推测）

- 工具注册、renderer、builtin 名、settings、discoverable/read approval 已接线。
- scout frontmatter 含 `code_intel`/`ast_grep` 不含 `lsp`；工具均在 `READ_ONLY_TOOL_NAMES`。
- 无 Cursor CCE/MCP 调用轨迹。
- 远程 embedding URL/非本地 model 关闭 semantic。
- 核心 TS 无 `any` / `ReturnType<>` / 动态 import / `console.*` / 手写 `new Promise`。
- 测试不 source-grep 实现。
- natives changelog 对 native API 描述基本准确。

## 6. Residual risks

### 已文档化

- 未做 Cursor CCE 同查询 A/B，不能宣传相对质量可替代。
- 同一 HEAD 下 IDE/bash/generator 外部修改缺 watcher/metadata sweep。
- English BGE 不能证明中文质量；首次模型缓存可能联网。
- PageRank 权重、20k/4k、hybrid 系数未 A/B 冻结。
- `18.1.0` natives sentinel 由 release 流程处理，本次不改。
- Windows `CURRENT` replace 的 backup 窗口沿用 `replaceFileAtomically`。

### 静默风险（修复前）

- generation owner 无生产 warm、dirty 无效、in-flight 永不重置。
- semantic passage 无源码、截断后 row mapping 失配。
- exact 搜索受文件名门控。
- read-only facade 仍暴露服务端 applyEdit。

## 7. Verification（审查时）

- `bun test packages/coding-agent/test/tools/code-intel-envelope.test.ts packages/coding-agent/test/tools/code-intel-corpus.test.ts` → **14 pass, 0 fail, 60 expect**。
- Sol 环境未能复跑 `cargo test -p pi-natives`（PATH 无 cargo / nightly 未装）。主会话此前该套件 2 passed。

## 7.1 Verification（修复后）

- `bun test packages/coding-agent/test/tools/code-intel-envelope.test.ts packages/coding-agent/test/tools/code-intel-index.test.ts packages/coding-agent/test/tools/code-intel-corpus.test.ts` → **19 pass, 0 fail, 77 expect**。
- `bun test packages/coding-agent/test/tools/lsp-regressions.test.ts -t "refuses inbound workspace/applyEdit"` → **1 pass, 0 fail**。
- `cd packages/coding-agent && bun check` → biome 无诊断，`tsgo --noEmit` 通过。
- 本轮未改 `crates/pi-natives/src/code_intel.rs`；PATH 无 cargo，未复跑 native 套件。

## 8. Handoff

### 8.1 同会话继续

直接执行 $fix-implement 或 /fix-implement

### 8.2 新会话恢复 prompt

```text
请阅读实现文档 docs/superpowers/plans/2026-09-02-native-code-intelligence-without-cursor-cce-implementation.md、
审查文档 docs/superpowers/plans/2026-09-02-native-code-intelligence-without-cursor-cce-code-review.md，
以及本次代码变更，
使用 $fix-implement（或 /fix-implement）进行方案修复及代码实现。
重点修复 HIGH：generation warm 从未接入生产调用；查询路径无界 initialize；passage 无源码且矩阵/chunk 账本不一致；exact grep 被文件名 glob 门控；只读 LSP 入站 applyEdit 仍写盘。
```
