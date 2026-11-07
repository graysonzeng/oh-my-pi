# Design: Per-Model Optimization P0/P1/P2 Increment

- Date: 2026-07-25
- Status: Draft for review
- Scope: L
- design_author: gpt
- Base Design: `docs/superpowers/specs/2026-07-25-per-model-optimization-design.md`
- Evidence: `docs/research/2026-07-25-per-model-optimization-user-feedback.md`

## 1. 判断与范围

继续采用 `Stabilize & Measure`：复用现有 workflow、artifact、schema validator、`artifact://`、`xd://`、budget ledger 和 agent tool scheduler，不另建第二套 runtime。

已确认：

- `read` summarizer 会把正文替换成路径、行数和字节数。
- bash inline cap 可保存完整输出，但后续 summarizer 可能删除恢复 footer。
- usage/routing artifact 已存在，但缺少 token 分桶、duration、retry/fallback、compression receipt 和 scope 指标。
- context eviction 不是 role-aware handoff。
- schema retry 的 `maxRetries` 当前实际接近总 attempt 数，retry prompt 仍在代码内拼接。
- `xd://` 和 shared/exclusive tool concurrency 已有可复用 seam。

未知 provider TTFT、queue time、cache attribution 时必须记录为 `null`，不得补零。

非目标：完整 CWL、tree-sitter/PageRank、在线学习路由、远程 benchmark 服务、新 UI、外部 RTK proxy、自动修改生产默认路由。

## 2. P0：可恢复的工具输出优化

### 2.1 合同

- `read` 不再执行正文归零摘要，只保留原有 range/offset 和有界截断。
- 任何丢失正文的 transform 必须先保存原文，并在模型可见文本保留 `[raw output: artifact://<id>]`。
- summarizer 必须保留已有 `artifact://` footer。
- bash/test 失败至少保留 exit code、首个失败块、尾部错误、失败测试名和可见重现命令。
- artifact 保存失败时回退到保守截断或原文，不得返回虚假 URI。
- 非 workflow session 行为不变。

### 2.2 数据与 seam

新增版本化 `ToolOptimizationReceiptV1`，记录：tool、transform、original/visible bytes/lines、sha256、omitted ranges、recovery URI、reversible。

将 workflow tool optimization 从纯字符串回调扩展为可异步返回：

```ts
export interface WorkflowToolOptimizationResult {
	text: string;
	receipt?: ToolOptimizationReceiptV1;
}
```

纯 transform 留在 `tool-output-manager.ts`；artifact 写入通过 adapter 注入，避免算法层依赖 session storage。

### 2.3 验收

- 所有有损 fixture 的关键事实可直接看到或一跳恢复。
- 恢复内容 hash 与 receipt 一致。
- 覆盖成功、失败、timeout、UTF-8、超长单行和多段错误。

## 3. P0：固定任务 benchmark 与 metrics

新增 `workflow/benchmark/` 深 module，提供 suite/case/variant/run/report 类型与 runner。CLI 仅做薄 adapter。

每个 case 固定 repo/base commit/request/allowed paths/forbidden paths/verification commands。baseline 与 optimized 使用相同 case、commit、输入和 repetition；每类至少重复 3 次。

报告必须区分：

- provider 事实：input/output/cache tokens、cost（若存在）。
- 精确测量：system/tool schema/history/repo-map/tool-result/context-evicted bytes。
- 推算：明确标注的 estimated tokens。
- unknown：TTFT、queue、cost 等不可观测字段为 `null`。

每个 stage 记录 profile、实际 provider/model、duration、tool time、schema retries、fallbacks、tool calls、compression receipts、scope artifact。runner 只输出 scorecard 和 quality gate，不修改 `default-config.ts`。

验收：至少 10 个固定 case；fake runtime paired smoke 可重复；真实模型未跑时明确标记 live quality unknown。

## 4. P1：stage-boundary role-aware handoff

新增确定性 `StageHandoffV1`，从现有 typed artifacts 提取 preserved items、omitted artifact IDs、recovery URIs、bytes before/after。

- planner→implementer：目标、约束、非目标、决策、受影响文件、验收、风险。
- implementer→reviewer：plan 引用、changed files、patch、commands/tests、unresolved。
- reviewer→repair：所有未关闭 blocking finding、相关文件/行、失败验证和已尝试修复。

只在 stage 成功结束后构造；不在 stage 中途静默压缩；P1 不增加模型摘要调用；持久化原 artifact 不删除。

验收：blocking finding、失败 verification 和 patch 引用不可因预算被裁掉；相同输入产生确定性字节输出；所有 recovery URI 可读。

## 5. P1：结构化输出分层修复

统一流程：保存原始输出 → 去 BOM/Markdown fence/提取单个完整 JSON object → canonical validator → 预算允许时模型 retry → 耗尽后返回含全部 attempt receipt 的 schema error。

确定性修复不得补造缺失字段、猜枚举或宽松类型转换。

- `maxRetries` 表示初次调用后的额外模型调用数，总上限为 `1 + maxRetries`。
- 每次 retry 前检查 request/cost/time budget。
- embedded、Codex CLI、Claude CLI 使用同一 validator/repair seam。
- retry prompt 移到静态 `schema-retry.hbs.md`，只注入 violation、schema 摘要、上一输出的有界片段或 artifact URI。

验收：fenced JSON/BOM/外围说明零模型调用修复；语义错误不被伪修复；`maxRetries=0/1/2` 最多调用 `1/2/3` 次。

## 6. P1：scope adherence

新增 `ScopeMetricsV1`：planned/changed/unplanned/forbidden/deleted files、diff lines、touched packages、scope-creep findings、user corrections/rollbacks、status。

- planned files 来自 plan 与 benchmark allowlist。
- actual changes 来自隔离 worktree git diff，不相信模型自报。
- forbidden path 或 readonly write 为 hard violation。
- unplanned file 默认为 warning，由 reviewer 判断必要派生文件。
- 无交互 benchmark 的 corrections/rollbacks 为 `null`。

scope artifact 进入 benchmark quality gate，使“测试同样通过但无关改动更多”的 variant 可被区分。

## 7. P2：lazy tool/schema/skill presentation

复用 `xd://`，不创建第二套 discovery 协议。`WorkflowPresentationPolicy` 定义 direct/catalog tools、autoload skills 和 skill catalog。

- 高频关键工具直接暴露完整 schema；低频工具只给稳定短描述，可一跳读取 `xd://<tool>`。
- restricted workflow child 只能发现 role allowlist 已预过滤的工具；catalog 不提升权限。
- skill 初始只注入名称/短描述；autoload 或显式读取时加载全文。
- presentation 顺序稳定。
- feature flag 默认关闭；只有 benchmark 质量不退且净 token/延迟改善才考虑默认开启。

## 8. P2：cache-friendly stable prefix

新增 `PromptAssemblyReceiptV1`，记录 stable/dynamic SHA、bytes、section order、provider cache read/write tokens。

固定顺序：静态 system prompt → role/profile policy → 稳定排序的 tool presentation → skill catalog → 动态 assignment/repo-map/handoff/history。

workflow ID、attempt ID、时间戳、随机 artifact ID、实时 budget 不进入 stable prefix。hash 相同不等于 provider cache 命中，真实收益仅由重复 benchmark 判定。

## 9. P2：依赖与预算感知并发

复用 agent loop 的 shared/exclusive scheduler，新增 `ToolSchedulingPolicy`：max concurrency、remaining tool calls、remaining stage time、resource conflict mode。

- exclusive 保持现有屏障语义。
- shared 仅在 cap 内且无资源写冲突时并发。
- 同路径 write/edit/patch 和可能修改工作区的 bash 不并发。
- 只读相同资源可并发，但结果按原 tool-call 顺序写回。
- 启动 batch 前预留 tool-call budget；abort/skip 必须释放 reservation。
- 不构建通用 DAG，不跨 turn 推断隐式依赖。

验收覆盖 cap=1/2/N、shared→exclusive→shared、同文件写串行、budget 只剩一次调用、abort reservation 释放。

## 10. 实施与验证顺序

1. P0 tool recovery 与 receipt。
2. P0 benchmark/metrics。
3. P1 handoff、schema repair、scope metrics。
4. P2 presentation、stable prefix、scheduler。

每批运行：相关 contract tests、`bun test packages/coding-agent/test/workflow/`、涉及 agent loop 时的 concurrency tests、`bun check`、workflow fake runtime smoke、benchmark paired smoke。真实 provider smoke 仅在已有凭据和预算下执行；未执行必须明确标记。

任一单变量 paired benchmark 的 pass rate 或质量分下降超过 3pp，结论为 rollback；runner 不自动修改生产配置。

完成定义：所有有损操作有 durable receipt/recovery；事实、精确 bytes、估算 token、unknown 分开；scope/retry/fallback/cache/duration/concurrency 可审计；未擅自启用完整 CWL、tree-sitter 或在线路由。
