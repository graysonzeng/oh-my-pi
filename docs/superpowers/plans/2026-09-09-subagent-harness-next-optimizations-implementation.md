# Implementation: subagent harness next optimizations

- Date: 2026-09-09
- Design input: `docs/research/2026-09-09-subagent-harness-next-optimizations.md`
- Implementation design: `docs/superpowers/specs/2026-09-09-subagent-harness-next-optimizations-design.md`
- Baseline: `3e1f08414d`
- Review Doc: 无独立设计Gate；独立只读代码审查 HarnessReview 未发现阻断问题。
- Status: Completed (first tranche); live performance UNVERIFIED

## 1. 评审意见处理摘要

用户批准研究推荐方案。保留已有生命周期、预算、权限、结果恢复；不引入第二套调度、memory或逐回合分类模型。

schema 模式不再出现无数据终结指导。随后根据验收提醒纠正 Validation 合同：共享与隔离worker都无条件接收稳定前缀中的验证规则，工作树隔离不豁免验证归属；仅显式分配的全量验证可执行，skip-validation仍优先。已删除 `isolated.not.toContain("# Validation")` 错误断言，改为两类worker的公共前缀均保留完整规则；先观测2项失败，再修复至通过。

报告初稿的问题也已修复：无返回的 task 调用仍计入缺失覆盖率；linked child 的未配对结果不忽略；读取资源只输出父会话范围内 SHA-256 键，避免泄漏路径或带凭据URL；taskCallMs 不再命名为父等待；删除硬编码自证标签。旧记录测试中的非JSONL fixture已修正。

独立 reviewer 对前一版报告/提示实现未发现阻断问题；后续验收指出其未识别的 Validation 合同问题，本次已修正并补回归。原审查不作为该后续修订的独立背书，也不替代实网性能验证。

## 2. 根因前提处理结论

处理策略：修订后实现。已确认源码组装顺序和统计字段，未确认缓存实际损失与新版本慢任务归因。先实现可验证的结构和离线报告，不承诺因果收益。

并发测试发现明确的旧入口失配：测试传入已不被 TaskTool 使用的 model 参数，mock provider 进入次数为0，实际请求走了真实服务并鉴权失败，等待门最终超时。修复为隔离 Settings 中的 task.agentModelOverrides 后，2个并发合同测试约1.2秒通过。只改测试，不改生产路由或本机配置。

## 3. 采纳的设计修订

- 完整fork降为后续实验；本轮复用现有context/artifact，review共享原始材料、不要求采纳作者判断。
- 静态合作、Validation与完成合同置于动态context、plan、工作树、peer roster、schema前；验证归属不随worktree是否存在而变化。动态工作树段只表达路径及编辑范围。
- 并发、effort、hard cap不盲调。最新历史报告与mock benchmark分开，不作为实网A/B。
- 离线报告先给已有数据的分布与覆盖率，不新增生产事件。端到端完成时间、关键路径和父最终验收缺失时均为unknown/null；这是首批诊断能力，不是完整任务验收时间线。

## 4. 实现摘要

- `src/task/subagent-prompt.ts`：实际生产prompt渲染/组装接缝；executor使用它，默认环境最后一块保留；冷恢复继续消费session_init快照。
- `src/prompts/system/subagent-system-prompt.md`：静态/动态顺序及关键证据复用；不改变yield可选、schema覆盖、权限合同。
- `src/prompts/tools/task.md`：交接必要证据/失败尝试/修改范围/验证归属，不复制父完整历史；同文件一个owner，复用已有收益型委派。
- `src/latency/subagent-report.ts` 与 `scripts/session-stats/subagent-report.ts`：本地JSONL分析，已知/未知区分、父子关联、请求计时、usage、完成类型覆盖、重复读取和工具错误。
- `package.json`：`bun run stats:subagents`。
- 新增prompt、报告、CLI合同测试；修复既有parallel-spawn-local-bench的mock路由。
- `scripts/session-stats/README.md`：入口与mtime整组窗口、隐私和统计限制。

未带包名前缀的src/test路径位于 `packages/coding-agent/`。未提交；保留用户原有 `docs/local-build-install.md` 修改。

## 5. 验证结果

### 自动检查

1. `bun test packages/coding-agent/test/task/subagent-prompt.test.ts packages/coding-agent/test/prompt-templates.test.ts packages/coding-agent/test/system-prompt-worker.test.ts packages/coding-agent/test/task/executor-wall-clock.test.ts packages/coding-agent/test/task/executor-soft-budget.test.ts packages/coding-agent/test/task/persisted-revive.test.ts packages/coding-agent/test/task/review-metrics-contract.test.ts packages/coding-agent/test/task/review-performance.test.ts packages/coding-agent/test/task/parallel-spawn-local-bench.test.ts`：131 pass，0 fail。
2. `bun test packages/coding-agent/test/latency/subagent-report.test.ts scripts/session-stats/subagent-report.test.ts`：16 pass，0 fail。
3. `bun test packages/coding-agent/test/latency/bash-attempt-ledger.test.ts packages/coding-agent/test/latency/arms.test.ts packages/coding-agent/test/task/structured-subagent.test.ts`：47 pass，0 fail。
4. 变更TS文件 `bunx biome check --write ...`；`bun --cwd packages/coding-agent check`：Biome检查3090文件无错误，`check:types`通过。
5. `bun run gen:bundle`：成功，CLI bundle 21.03 MB；`bun packages/coding-agent/dist/cli.js --version`：omp/18.0.5。
6. `bun run stats:subagents --help` 和 `git diff --check`：通过。

Validation合同后续修订：重新运行subagent-prompt、prompt-templates、system-prompt-worker、persisted-revive四个文件，90 pass / 0 fail；包 `bun check`、bundle构建再次通过（21.04MB）。其他未受影响测试沿用前述证据。

### 提示前缀实验（本地渲染，不是token/缓存实测）

用同一角色 `Worker`，两份不同context与worktree，分别渲染基线commit模板与最终生产helper，比较逐字公共前缀：27 bytes → 2948 bytes。对应单份子代理块：2663 bytes → 3243 bytes。总块增大，包含隔离worker同样必须遵守的验证合同；收益来自公共前缀长度，不宣称prompt更短；未包含默认系统块和provider序列化。

### 本地并发基准（mock，仅调度机制）

```sh
PARALLEL_SPAWN_BENCH=1 BENCH_CAPS=1,2,4 BENCH_TASKS=4 BENCH_REPEATS=3 BENCH_QUIET=1 bun run packages/coding-agent/test/task/parallel-spawn-local-bench.test.ts
```

每轮4个任务，每档3轮，共36个子任务，全部成功交付，每任务1次mock请求。受控provider负载120ms。

| 并发 | 3轮耗时ms | 请求并发峰值 | 平均spawn排队ms |
|---|---|---|---|
| 1 | 828 / 742 / 710 | 1 / 1 / 1 | 300 |
| 2 | 402 / 412 / 401 | 2 / 2 / 2 | 104 |
| 4 | 238 / 234 / 245 | 4 / 4 / 4 | 0 |

这是不同并发下的本地调度验证，不是改动前后性能对照，不能据此提高真实provider默认并发。

### 新鲜会话诊断样本

```sh
bun run stats:subagents --sessions /Users/sheng/.omp/agent/sessions --folder=-tencent-oh-my-pi --since 3d --format json --json /tmp/omp-subagent-baseline-2026-09-09.json
```

首次采样：12个父会话、16个子会话、9次task调用；父子全部关联、坏行0。919个请求中848个有TTFT/生成时间，71个缺失；12个派发子项的完成类型/排队信息及12个父最终验收均缺失，未补零/未当成功。请求TTFT p50约3.25s、p90约11.22s；生成p50约5.57s、p90约23.78s。混合模型、父子请求、mtime整组筛选，且可能含活跃会话，仅用于检验报告能工作，不作为优化前后结论。

### 实网资格尝试

`bun run test:latency:smoke`：运行12个子调用后返回 `UNVERIFIED`，约25.36s，原因 `scout identity/provenance missing or mixed`。退出1。未绕过身份校验，不用mock伪装通过；该入口也不是本次prompt改动的成对A/B。本轮没有取得真实缓存收益或质量非退化证据。

## 6. 已知限制与后续建议

1. 首批代码的结构与本地合同已验证，真实端到端速度提升未验证。没有凭此修改并发、模型/effort或cap；没有新增反循环守护。
2. `--since`以父子整组最大mtime选样，不是按事件时间切片；固定输入快照才能严格复算。当前报告不输出对话正文/工具参数；模型和工具名属于元数据，不是完全匿名化数据。
3. repeatedReads把同资源不同selector归组，没有文件版本/内容hash，因此只能提示候选，不能断言重读都是浪费。
4. 父最终验收不是一般工具成功；现有解析尚不能提供真实E2E/关键路径。下一步按本次覆盖率缺口复用已有receipt补关联，而不是新建遥测平台。
5. 完整fork需另外验证新鲜度、权限、provider缓存作用域和review独立性。减少协调和分配推理档位需同任务实网对照；本轮保留默认值。

## 7. Handoff

### 同会话继续

```text
直接执行 $code-review 或 /code-review
```

### 新会话恢复

```text
请阅读设计输入 docs/research/2026-09-09-subagent-harness-next-optimizations.md、
实现文档 docs/superpowers/plans/2026-09-09-subagent-harness-next-optimizations-implementation.md，
以及本次未提交的代码变更，
重点核对根因前提、实现结果与验证证据是否一致，
使用 $code-review（或 /code-review）进行方案重审及代码审查。
```
