# Design Review: 原生 Code Intelligence（取代 Cursor CCE，不再接入 Cursor）

- Date: 2026-09-02
- Reviewed Design: `docs/superpowers/specs/2026-09-02-native-code-intelligence-without-cursor-cce-design.md`
- Review Scope: 只读评审能力缺口与根因证据、默认依赖路径、证据来源与 call-edge 升格、scout 只读分类、索引生命周期、分阶段发布门禁、成功标准及替代方向；未修改设计输入、代码或配置。

## 1. 整体结论

- `NEEDS_REVISION`
- 一句话结论：原生单入口、零 Cursor CCE 回退、semantic 不升格调用边、scout 手工只读白名单及“阶段 3 后才可宣称取代 CCE”的方向正确；但阶段 3 验收目前允许所有已知问题都返回 `NOT_FOUND`，tags 关系来源、embedding 实际调用合同和索引快照一致性也未封闭，不能按现稿直接实现或发布“取代 CCE”声明。

## 2. 根因评审结论（按需）

- 适用性：适用。文档 §6-§7 明确给出能力库存、未确认假设及“缺的是融合检索 + 证据信封 + 本地图/向量”的成因判断，方案 D 的范围和阶段顺序依赖该判断。
- 结论：`WEAK_EVIDENCE`。
- 理由：当前工具与 agent 库存足以证明 omp 缺少统一 `code_intel` 入口、call hierarchy、代码向量索引和 CCE 信封；但“这些层正是 CCE 优势的原因”及“Phase 3 质量足以取代 CCE”没有查询语料、真实轨迹、golden anchors 或 A/B 数据支撑。已确认的是能力缺口，不是各层的边际收益与质量结论。

### 2.1 证据检查

- `packages/coding-agent/src/prompts/agents/scout.md:4-33` 证明当前 scout 只有 `read, grep, glob, web_search`，输出为 `summary/files/architecture`，没有统一证据信封。
- `packages/coding-agent/src/lsp/types.ts:8-22` 与 `packages/coding-agent/src/lsp/servers.ts:21-36` 证明现有 action/只读集合没有 `call_hierarchy`；`packages/coding-agent/src/lsp/client.ts:116-190` 还没有声明 `textDocument.callHierarchy` client capability。
- `packages/coding-agent/src/task/read-only-policy.ts:3-26` 证明只读分类是声明工具名对 `READ_ONLY_TOOL_NAMES` 的 fail-safe 子集判断；`ast_grep` 已在集合内，`lsp` 不在。
- `packages/natives/native/index.d.ts:1723,2228` 证明 `mmrRerankIndices` 与 `vectorIndexTopK` 已存在；`packages/coding-agent/src/mnemopi/embed-client.ts:17-49,103-152,281-284` 证明本地 embedding 子进程与单例客户端存在。
- 仓库级精确检索没有发现 `cursor-bridge`、`cursor_context_engine` 或 `CCE_SEARCH_RESULT` 的现有实现/默认配置；除本设计外也没有可执行的 CCE 信封 parser/golden fixture。因此“当前默认无 CCE 后端”成立，“字节级兼容现有解析逻辑”在本仓库内不可验证。
- 文档没有提供 CCE/原生路径的相同查询轨迹、已知答案集、检索质量指标或错误调用边样本。§6 已将“阶段 3 准确率接近 CCE”列为未确认假设，这一点表达诚实，但它直接限制了替代声明。

### 2.2 事实 / 假设边界检查

- 成立事实：没有统一原生入口；scout 当前不是信封输出；LSP 没有 call hierarchy；只读分类不接受完整 `lsp`；本地 worker 与向量 kernel 可复用；当前仓库没有默认 CCE 路径。
- 未确认假设：PageRank 对行为查询有足够边际收益；4000 个 embedding 文件覆盖主要仓库；默认 English BGE 能处理设计中的中文行为查询；本地 semantic + 一到两跳关系检索足以达到产品所需质量。
- 推断过度：从“所需原语存在”直接跳到“阶段 3 测试绿即可取代 CCE”。当前测试合同没有证明 semantic 命中率、跨语言召回、错误关系率或相对 CCE 的可替代性。
- 外部合同缺口：文档引用 cursor-bridge `server.mjs`，但未给出版本、固定 fixture 或可运行 parser。无法从当前材料复核所谓“字节级兼容”的真实边界。

### 2.3 对方案的影响检查

- “统一入口 + 明确 provenance + 有界加深 + 诚实降级”的主方向直接命中已确认缺口，应保留，不需要推翻重设计。
- Layer 2/4 应由固定查询语料和分层消融决定参数与发布门禁，而不是先把 PageRank、文件上限、dense/lexical 权重写成已确认终态。
- “不依赖 Cursor/云向量库”与“达到 CCE 产品合同”是两个独立门禁：前者可由依赖图与运行轨迹证明，后者必须由已知答案与错误关系率证明。

## 3. 设计方案评审

### 3.1 需求与方向

- 正确：把未知位置、关系和所有权查询收敛为一个只读工具，比继续把工具选择和加深策略推给主模型更接近目标；对外信封同时暴露 evidence、gaps 和 confidence，方向合理。
- 正确：设计明确否决 Cursor MCP 回退、Python sidecar 和云向量库，且允许 graph/LSP/grep 在本地模型不可用时降级；这是可独立验证的产品边界。
- 正确：§4.17 明确只有 Phase 3 后才能宣传“取代 CCE”，Phase 1/2 只可作为分阶段实现。
- 不足：成功标准没有要求已知答案查询必须被找到，也没有跨语言/跨仓库语料；因此阶段 3 的宣传闸门只有文字，没有可执行的质量闸门。
- 更好路径：先冻结一个包含 locate、ownership、implementation、真实 call edge、同名非调用、中文意图/英文源码的 golden corpus；用人工真值衡量分层召回与 false-edge，再据此确定 semantic 模型、PageRank 权重和 Phase 3 门槛。

### 3.2 方案合理性

- 默认路径核对：按现稿指定的直接 `mnemopiEmbedClient` 子进程、无 MCP fallback、无 Milvus/OpenAI key，代码智能后端可以做到零 Cursor CCE、零云向量库。该结论不等于“完全离线”：`defaultLocalModelInitializer` 会在本地缓存缺失/损坏时下载模型或 sidecar（`node_modules/@oh-my-pi/pi-mnemopi/src/core/embeddings.ts:95-167`、`fastembed-model-cache.ts:20-37`）。
- Semantic 核对：§3 第 5 步、§4.4 第 6 条和 §4.8 已正确规定 semantic-only 只能进 `gaps`，被其他层支撑时也必须采用更强 kind；按文字合同，semantic 命中不能冒充 call edge。
- 关系漏洞：§4.4 又允许 tags 图的 def/ref 证明调用边，§5.1 则仅用 `name reference (syntactic)` 和 medium confidence 缓解假边。现有 `CodeIntelTag` 只有 path/name/kind/line，没有 enclosing caller、callee resolution 或 call-expression kind，无法证明“谁调用谁”。
- Scout 核对：在 `READ_ONLY_TOOL_NAMES` 加 `code_intel`，frontmatter 显式列 `code_intel, ast_grep` 且不列 `lsp`，足以维持当前 `isReadOnlyAgent` 分类；受限子代理的工具集不会被 `tools/index.ts:620-666` 自动拓宽。该项设计合理。
- 只读内部边界仍需机械约束：`code_intel` 绕过 `LspTool` 直接调用 client 后，常量 `approval="read"` 不能阻止未来实现误发 `workspace/applyEdit`/rename。内部必须使用只暴露只读方法的 facade 或请求方法白名单测试。

### 3.3 实现可行性

- 本地 embedding API 描述不准确：现有客户端不是 `embed(texts) → number[][]`；它要求先 `initialize(model, cacheDir)`，返回的 model 再以 `AsyncIterable<number[][]>` 提供 `embed`（`embed-client.ts:76-152,224-235`）。初始化还被明确设计为可耗时数分钟且无请求超时（`:87-98`），与工具 30 秒部分返回合同之间缺少 background owner、取消与失败收束。
- 检索编码合同不完整：fastembed 明确区分 `passageEmbed()` 与 `queryEmbed()`，两者分别添加 `passage:`/`query:` 前缀（`node_modules/fastembed/lib/cjs/fastembed.js:287-293`）；现有 worker protocol 只有通用 `embed`（`embed-protocol.ts:15-29`）。Phase 3 必须扩展协议或明确模型特化，否则 E5/BGE 的 query/document 向量合同不成立。
- 默认模型与验收语料冲突：`mnemopi.embeddingVariant` 默认是 English BGE（`settings-schema.ts:3153-3173`），而三条成功查询均为中文意图、英文源码。没有跨语言验证时，不能假定默认路径能命中。
- LSP 文件面遗漏：加入 action 与只读集合之外，还需更新 `lsp/client.ts` 的 `CLIENT_CAPABILITIES`；否则真实 server 可能不协商 call hierarchy。现文件清单漏了该文件。
- project-key 事实错误：设计写“sha256(canonical root) 前 16 hex，与 launch broker 算法一致”，实际 broker 使用 `Bun.hash.wyhash(path.resolve(projectDir))`（`packages/utils/src/dirs.ts:872-875`），canonical helper 与哈希 helper 也分离（`packages/coding-agent/src/launch/paths.ts:11-24,49-54`）。必须复用真实 helper或明确建立不同合同。
- N-API 边界有可避免的数据搬运：`codeIntelExtractTags` 把全库 tags 变成 JS 对象，再由 `codeIntelRank(tags)` 全量传回 Rust；在 20k 文件上会产生大规模字符串/对象分配和序列化。更稳妥的是 native 侧持有/加载 graph snapshot，查询只传 seed 与 limit。

### 3.4 文档质量

- 优点：目标、非目标、层级、错误矩阵、阶段顺序、测试和事实/假设分区完整；四个重点约束都有明确文字答案。
- 关键歧义：“零 Cursor”应限定为“不启动 Cursor IDE/CCE/cursor-bridge 作为代码智能后端”，不能误伤仓库中合法的 Cursor 模型 provider；功能验证里的“无 `cursor_`”也应改为无 Cursor 进程、无 `cursor_context_engine`/`cursor_do`/相关 MCP 调用。
- 合同歧义：“字节级兼容”没有版本化 grammar/golden fixture；intent、coverage reason、gaps 本来就是自由文本，更准确的目标是 marker、字段顺序、枚举和 `NOT_FOUND` grammar 兼容。
- 设置矛盾：§4.8 提到 `codeIntel.embeddingSource = "mnemopi"`，§4.12 又没有该设置；同时“跟随 variant 避免两套权重”没有处理 `mnemopi.embeddingModel`/环境覆盖。应删除伪设置并定义只允许本地模型的单一 resolver 及 precedence。
- 生命周期缺口：`tags.jsonl`、`chunks.jsonl`、`embeddings.f32`、`graph.csr` 没有 generation/manifest 原子提交；仅靠 omp 写工具 invalidation 与 git HEAD 变化也发现不了同一 HEAD 下的 IDE、bash、generator 等外部写入。

## 4. 主要发现

### CRITICAL

- 无。

### HIGH

#### [HIGH] 发布门禁: Phase 3 可以在所有已知答案查询均未命中时通过

**位置**: §1.2.4、§4.15、§4.17、§5.2。

**问题**: 三条功能查询的接受条件是“至少一条 exact/reference，或诚实 `NOT_FOUND`”；因此一个永远返回 `NOT_FOUND + searched scope` 的实现也满足成功标准。阶段 3 只以“本阶段测试绿”作为 Confirmed/宣传条件，没有 golden anchors、最低召回、false-edge 上限或跨语言要求。

**影响**: Phase 3 可机械通过但仍没有代码理解能力；“阶段 3 后才宣称取代 CCE”的文字限制无法阻止错误发布声明。

**建议**: 把已知答案查询分成两组：positive corpus 必须 `found=true` 且命中预期 path/symbol/relationship；negative corpus 才允许 `NOT_FOUND`。加入中文意图/英文源码、同名非调用、弱 LSP、冷/暖索引语料，并把 Phase 3 的版本/文档/changelog gate 绑定到固定质量阈值和无 Cursor/MCP 运行轨迹。

#### [HIGH] 证据来源: 当前 tags 数据模型不能证明 call edge

**位置**: §3 第 3-5 步、§4.4.6、§4.6、§5.1。

**问题**: semantic-only 的禁令正确，但 `CodeIntelTag` 没有 enclosing symbol、call-expression 类型或消歧后的 target；`@reference.identifier` 只能证明名字出现。§4.4 却允许 tags 图 def/ref 产生已证实关系，§5.1 又允许 syntactic reference 升为 `reference`，留下把属性访问、类型引用、导入别名或同名符号写成调用关系的路径。

**影响**: 即使 semantic 从不直接升格，最终信封仍可由 tags 层生成假的 `calls/called by`；用户要求的“不能冒充 call edge”在系统层面仍不成立。

**建议**: 定义不可丢失 provenance 的判别联合，分开 `semantic-candidate`、`graph-ranked-context`、`syntactic-name-reference`、`lsp-reference`、`lsp-call`。只有 LSP call hierarchy 或另行实现并测试的语法 call-expression resolver 可渲染 `calls/called by`；当前 identifier tags 最高只能是 `source-read` 或明确的 `name reference (syntactic)`，不得作为 call edge。补 semantic+同 path、同名跨文件、属性/类型引用和注释伪调用的负向测试。

#### [HIGH] Semantic 核心合同: 现有 worker API、query/passage 编码和默认语言不支持阶段 3 承诺

**位置**: §4.8、§4.12、§4.13、§4.17；现状见 `mnemopi/embed-client.ts:76-152`、`embed-protocol.ts:15-29`、`settings-schema.ts:3153-3173`。

**问题**: 设计把现有客户端写成同步矩阵式 `embed`，但真实 API 是无界 `initialize` + async iterable；worker 也没有 query/passage 操作。默认 English BGE 与中文行为查询不匹配，E5 所需前缀在当前通道中也无法表达。

**影响**: 首次 semantic warm 可能越过 30 秒工具预算，中文查询可能无法落到英文代码，或 query/chunk 使用错误编码；Phase 3 即使完成所有文件也不能证明 semantic 层有效。

**建议**: 先定义本地模型 resolver、`queryEmbed`/`passageEmbed` worker 协议、模型维度/归一化/前缀合同及 background warm owner；工具查询不得等待无界 init，超时只读稳定快照并报告 warming。用双语 corpus 决定默认模型；若保留 English 默认，则必须降低中文成功标准或提供不依赖云服务的跨语言路径。

#### [HIGH] 索引一致性: 失效与多文件提交会让旧行号进入 evidence

**位置**: §4.9、§4.13、§5.1。

**问题**: dirty 路径只覆盖 omp 已知写工具和 git HEAD 变化，无法发现同一 HEAD 下由 IDE、bash、生成器或外部进程产生的修改；tags/chunks/embeddings/graph 又分别落盘，没有一个 generation manifest 原子绑定 row→chunk→path/line 映射。

**影响**: 查询可把旧 snapshot 的行号/符号与新工作区内容混合，甚至在向量行数变化时读错 chunk；这破坏“锚点才是事实”的核心合同。

**建议**: 定义 generation 目录 + 单一 manifest 指针，所有文件写完、校验维度/行数/hash 后一次原子切换；查询持有同一 generation。增加外部变更检测（watcher 或有界 metadata/content-hash sweep），并在候选进入 evidence 前重新验证当前文件 hash/行范围；覆盖 bash/IDE 修改、chunk 数增减、崩溃中断与并发 warming 测试。

### MEDIUM

#### [MEDIUM] 默认依赖: “零云向量库”成立，但需把本地子进程与首次联网写成可验证边界

**位置**: §1.2.3、§4.8、§4.13、§5.2。

**问题**: 直接使用 `mnemopiEmbedClient` 可保持本地推理，但通用 Mnemopi `embed()` 能按设置/环境走 OpenAI-compatible API，fastembed 缓存缺失时也会从 GCS/Hugging Face 下载。文档没有明确禁止 code-intel 调通用远程 provider，也没有区分“无云向量库/无云推理”和“完全离线”。

**影响**: 实现者可能为复用便利改调通用 `embed()`，使默认路径在存在 API key 时静默出网；用户也可能把首次模型下载误解成违反“零云”。

**建议**: code-intel 只依赖 direct local worker facade，类型上不暴露 remote provider；增加设置了 OpenAI/OpenRouter 环境仍不得发 embedding HTTP 的集成测试。文档明确首次模型下载、缓存位置、离线降级和“Cursor 模型 provider 不等于 Cursor CCE 后端”。

#### [MEDIUM] 合同验证: “字节级兼容 CCE”没有可执行来源

**位置**: §1.2.2、§4.4、§6。

**问题**: 仓库没有现有 CCE parser、固定 `server.mjs` 版本或 golden envelope；自由文本字段也不可能整体字节相同。

**影响**: 实现和测试只能互相证明自定义格式一致，无法证明旧路由消费者真的可消费。

**建议**: 固定一份脱敏 CCE grammar/golden fixtures 与 consumer parser，测试 marker、字段顺序、枚举、换行和 `NOT_FOUND`；把目标改称“wire grammar compatible”，不声称自由文本字节相同。

#### [MEDIUM] LSP/路径合同: 文件清单遗漏协商能力，project-key 复用陈述与代码不符

**位置**: §4.1、§4.7、§4.9。

**问题**: call hierarchy 还需更新 `lsp/client.ts` capabilities；project-key 则错误描述了 broker 当前的 wyhash/path.resolve 算法为 sha256/canonical root。

**影响**: 部分 server 不暴露 call hierarchy；不同入口、symlink 或平台可能产生两套索引目录，无法兑现“同一算法”。

**建议**: 把 `lsp/client.ts` 与 capability negotiation 测试加入清单；抽取并复用一个明确命名的 canonical project key helper，或承认 code-intel 使用独立、更稳定的 sha256 key并测试 symlink/Windows 归一化。

#### [MEDIUM] 性能边界: 全量 tags 的 Rust→JS→Rust 往返不可接受地放大索引成本

**位置**: §4.6 N-API 与 §4.9 存储。

**问题**: `codeIntelExtractTags()` 返回全库对象数组，`codeIntelRank({ tags })` 每次又把全部对象传回 native；同时用 JSONL 保存高重复 path/symbol 字符串。

**影响**: 20k 文件上分配、复制、GC 和 N-API 转换可能吞掉 30 秒预算，compiled PageRank 的收益被边界开销抵消。

**建议**: native 侧构建并持有/加载压缩 graph snapshot，JS 只传 seed、limit 和 generation id；若必须跨边界，使用批量二进制/typed arrays 与字典编码，并先以最大规模 fixture 量化内存和冷/暖延迟。

### LOW

- 无。

## 5. 修订建议

1. 将 Phase 3 宣传闸门改成可执行 gate：positive/negative golden corpus、预期 anchors、双语查询、false call-edge=0、冷/暖延迟与无 Cursor/MCP 轨迹；`NOT_FOUND` 只属于 negative corpus。
2. 引入 provenance 判别联合并收紧 renderer：semantic 永不单独进 evidence；当前 identifier tags 永不渲染 call edge；只有验证过的 call source 可以输出 `calls/called by`。
3. 按真实 Mnemopi API 重写 Layer 4：direct-local resolver、query/passage worker 方法、无界初始化的 background 生命周期、稳定快照读取、离线/失败降级和双语模型决策。
4. 把索引持久化改成 generation snapshot + manifest 原子切换，补外部变更检测和 evidence 前 hash/line revalidation。
5. 补 `CLIENT_CAPABILITIES.callHierarchy`、只读 request facade/白名单、symlink/平台 project-key 真源，并修正文档文件清单和 hash 陈述。
6. 以 CCE grammar fixture/parser 替代不可验证的“字节级兼容”，并把合法 Cursor LLM provider 与禁止的 Cursor CCE 后端分开命名。
7. 避免全量 tags 跨 N-API 往返；在最大文件数/embedding 行数 fixture 上先取得冷启动、warm query、峰值内存数据，再冻结 20k/4k/30s 参数。

## 6. 下一步建议

- 进入 `design-implement`，先按四个 HIGH 项修订设计，再实施修订后的 Phase 1-3；在 Phase 3 可执行 gate 通过前，任何发布物都不得宣称取代 CCE。
- 理由：原生、只读、无 Cursor 回退的主方向正确，scout 分类与 semantic-only 禁令也可沿现有机制实现；问题集中在可修订的 provenance、semantic API、索引一致性和验收合同，无需推翻方案 D。

## 7. Handoff

### 7.1 同会话继续

`直接执行 $design-implement 或 /design-implement`

### 7.2 新会话恢复 prompt

```text
请阅读设计输入 docs/superpowers/specs/2026-09-02-native-code-intelligence-without-cursor-cce-design.md
以及评审文档 docs/superpowers/plans/2026-09-02-native-code-intelligence-without-cursor-cce-design-review.md，
重点核对根因分析（如有）、事实/假设边界、以及方案修订点，
使用 $design-implement（或 /design-implement）进行方案修订及实现。
重点关注：HIGH-1 把阶段 3 的“取代 CCE”门禁改为 positive corpus 必须命中已知正确锚点且覆盖中英文查询，NOT_FOUND 不能通过；HIGH-2 用不可丢失 provenance 的判别联合约束关系升格，semantic 与当前 identifier tags 均不得生成 call edge，只有 LSP call hierarchy 或另行验证的 call-expression resolver 可证明调用；HIGH-3 修正本地 embedding 的真实 initialize/async-iterable 与 query/passage 合同，并处理默认 English 模型、无界初始化和 30 秒超时；HIGH-4 为 tags/chunks/embeddings 定义可检测外部变更且跨文件原子切换的 generation snapshot。
```
