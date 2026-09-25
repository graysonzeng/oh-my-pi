# Handoff：subagent 延迟优化实现与验证

创建时间：2026-08-31T01:07:20+08:00  
项目根目录：`/Users/sheng/tencent/oh-my-pi`

## 中文短 Prompt

```text
从 docs/handoffs/2026-08-31-0107-subagent-延迟优化实现与验证-handoff.md 继续。目标：按已获 PASS_WITH_NOTES 的设计实现 OMP subagent 活跃墙钟优化，并完成代码审查与最小充分验证。第一步：复算 design+facts manifest，确认 reviewed_revision=a28f72762dec7b73d61c6183bb46820ae27d6f09cf5e57759e6ff3308e6e8916，检查 git status，再完整阅读设计 §5–§6 与 Round 5 Gate。边界：仅改设计列出的 coding-agent 源码、测试、Changelog及拟新增资格脚本；保留既有工作区改动，不改 ~/.omp，不提交或发布；未确认凭据与最多 12/42 次外部模型调用成本前不得运行 test:latency:*；若必须改变设计合同则停止并重新执行 Design Gate。回传：按结论、改动文件、测试/typecheck/代码审查结果、live qualification 状态、剩余风险和下一步汇报。
```

## 1. 当前目标

- 用户原始请求：`提供短 prompt，我要在新会话中完成实现和验证方案的完成`。
- 期望结果：依据已通过 Gate 的设计完成产品代码、测试、资格脚本和 Changelog，并以新鲜测试、`bun check`、独立代码审查证明实现符合设计。
- 完成标准：
  - 实现设计 §5 的 performance class、runtime precedence、75% advisory、scout 合同、质量门和 latency qualification。
  - 覆盖设计 §6.1 列出的可观察合同；不添加源码字符串扫描、静态回声或占位测试。
  - 运行受影响的 focused tests 与 `bun check`，记录真实结果。
  - 独立只读审查最终 diff，并修复阻断问题后重跑相应验证。
  - live `test:latency:*` 仅在用户确认外部调用成本后运行；否则明确标记 `UNVERIFIED`，不能宣称延迟目标已达标。

## 2. 当前状态

- 状态：设计 Gate 已通过，产品实现尚未开始。
- 已完成：
  - 设计与事实输入已冻结并经历五轮独立 Gate。
  - 两轮后按用户要求反转，由 GPT-5.6-sol 修订，Claude Opus 5 独立复审。
  - Round 5 verdict 为 `PASS_WITH_NOTES`，无 CRITICAL/HIGH/MEDIUM，只有两个实现前可澄清的 LOW。
  - 当前 design+facts `reviewed_revision` 为 `a28f72762dec7b73d61c6183bb46820ae27d6f09cf5e57759e6ff3308e6e8916`。
- 待完成：产品实现、测试、typecheck、独立代码审查；经确认后可运行 live latency qualification。
- 最重要的下一步：先验证输入 revision 与工作区状态，再按设计 §5–§6 制定最小实施顺序，禁止凭记忆实现。

## 3. 已确认事实

| 事实 | 证据 | 如何复核 |
| --- | --- | --- |
| 最终 Gate 为 `PASS_WITH_NOTES` | review artifact Round 5，约 L2070 起 | 搜索 Round 5 标题、`verdict: PASS_WITH_NOTES` |
| 当前 Gate 输入未漂移 | design SHA `30a71be3…dc19`；facts SHA `bd6693c1…6b3e45`；聚合 revision `a28f7276…e8916` | 按 `<path>\t<sha>\n` 重算 SHA-256 |
| 作者与 reviewer 已分离 | GPT-5.6-sol 为修订作者；Claude Opus 5 agent id `7fe4f367-f3ac-4a2f-bc59-5603c6cc9b8c` 为 Round 5 reviewer | 设计元数据与 Round 5 Gate metadata |
| runtime precedence 已冻结 | 显式 request cap 权威直通；eval+omitted 继承 fresh setting；task+omitted 才套 class ceiling | 设计 §5.1–§5.2 |
| `sonic` 内部调用面已纳入范围 | cleanse 分片 worker 与 commit-agentic `AnalyzeFile*` 均接受 explore 10 min/40 req 合同 | 设计 §1.3、§5.2 调用面矩阵 |
| 质量门使用四个真实 review cases | `permission-readonly-review` 加三个 `code_review` case，仅 live 路径逐 run 检查 `firstPassed` | 设计 §6.2 |
| live latency 是人工 qualification，不是普通 release/CI 硬门 | 最多 12 次 smoke、42 次 release 调用；失败或跳过为 `UNVERIFIED` | 设计 §6.3 |
| 产品实现测试尚未运行 | 本会话只修改设计、评审与 handoff 文档 | 当前会话命令记录 |

## 4. 假设与未知

| 条目 | 类型 | 为什么重要 | 如何解决 |
| --- | --- | --- | --- |
| 10 min/40 req、medium thinking、摘要和提示收口的真实延迟收益 | 未知 | treatment 尚无 live 对照，不能宣称达到 p50/p90 | 获得成本确认后运行 qualification |
| cleanse/commit-agentic 在新 sonic 合同下的完成率 | 未知 | 大分片或大文件可能 timeout/压缩证据 | focused 功能测试；必要时在授权后做 bounded live 验证 |
| 当前源码是否在新会话开始前发生漂移 | 未知 | 可能使设计锚点或测试 owner 过时 | 第一步检查 `git status`、相关 diff 与当前源码 |
| live provider 凭据、额度与调用成本是否获授权 | 未知 | 资格命令会产生外部调用和费用 | 运行前向用户确认；未确认则保持 `UNVERIFIED` |

## 5. 相关文件与产物

| 路径 | 用途 | 备注 |
| --- | --- | --- |
| `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` | 权威实现设计 | 实现合同见 §5，验证见 §6 |
| `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-facts-brief.md` | 根因与历史证据 | 不把弱证据升级为事实 |
| `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md` | 五轮 Gate artifact | 以 Round 5 verdict 为当前 Gate |
| `packages/coding-agent/src/task/review-performance.ts` | performance class、ceiling、soft-runtime owner | 合并重复名字逻辑 |
| `packages/coding-agent/src/task/structured-subagent.ts` | fresh discovery 后的权威 policy 解析 | 保持显式 caller cap、eval、task 三路 precedence |
| `packages/coding-agent/src/task/index.ts` | TaskTool preflight/run | 删除预 discovery 的 runtime 名单计算 |
| `packages/coding-agent/src/task/executor.ts` | request budget、75% steer、completion lifecycle | 禁止新增第二 completion engine |
| `packages/coding-agent/src/prompts/agents/scout.md` | bundled scout profile | medium、摘要默认、去冲突 keep-going |
| `packages/coding-agent/src/prompts/system/subagent-system-prompt.md` | class-aware completion prompt | 必须保留 yield 协议 |
| `packages/coding-agent/src/workflow/benchmark/runner.ts` | absolute live quality gate | 仅 `liveQualityUnknown === false` 生效 |
| `packages/coding-agent/src/latency/active-wall.ts` | 拟新增纯 active-wall helper | 加入 latency 星号 barrel |
| `packages/coding-agent/test/task/product-latency-fixture.ts` | 拟新增父/子 qualification 脚本 | bundled-only、调用数硬上限 |
| `package.json` | 拟新增 `test:latency:smoke/release` | 不自动接入普通 CI/release |
| `packages/coding-agent/CHANGELOG.md` | 用户可见变更 | 只改 `[Unreleased]` |

## 6. 本会话改动

| 路径 | 改动摘要 | 原因 |
| --- | --- | --- |
| `docs/superpowers/specs/2026-08-30-subagent-latency-optimization-design.md` | 经 GPT-5.6-sol 多轮修订，冻结最终实现合同 | 关闭 Round 2–4 阻断项 |
| `docs/superpowers/plans/2026-08-30-subagent-latency-optimization-subagent-review.md` | 追加完整 Round 1–5 Gate artifacts | 持久化独立评审证据 |
| `docs/handoffs/2026-08-31-0107-subagent-延迟优化实现与验证-handoff.md` | 新增本实现交接 | 供新会话恢复 |
| 产品代码与测试 | 未修改 | 前序授权为 design-only |

## 7. 命令与验证

| 命令 | 结果 | 证据摘要 |
| --- | --- | --- |
| 对 design、facts 执行 `shasum -a 256` 并对 manifest 聚合再哈希 | 通过 | 当前 revision 为 `a28f72762dec7b73d61c6183bb46820ae27d6f09cf5e57759e6ff3308e6e8916` |
| `git status --short -- <design> <facts> <review>` | 通过 | 三份设计/Gate 文档当前均为未跟踪文件 |
| Round 5 Claude Opus 5 独立静态 Design Review | 通过并带 notes | `PASS_WITH_NOTES`；0 CRITICAL/HIGH/MEDIUM，2 LOW |
| 产品 focused tests | 未运行 | 尚未实现 |
| `bun check` | 未运行 | 尚未实现 |
| `test:latency:smoke` / `test:latency:release` | 未运行 | 脚本尚未实现，且需先确认外部调用成本 |
| build / commit / publish | 未运行 | 用户未要求提交或发布 |

## 8. 决策与取舍

| 决策 | 考虑过的替代方案 | 原因 |
| --- | --- | --- |
| 选择现有 runtime owner 上的方案 A | 新 completion engine/模仿 Cursor final-message 协议 | 更浅，且没有必须采用第二引擎的证据 |
| performance class 与 shadow eligibility 分离 | 直接复用 shadow eligibility 作为角色系统 | 避免 spawn `off` 等 shadow precedence 污染性能合同 |
| 显式 request runtime 权威直通 | 所有 task invocation 无条件套 class ceiling | 保持 workflow retry/profile caller cap |
| eval omitted 继续继承 fresh setting | 给 eval 新增 10/30 min ceiling | 保持 `agent-bridge.ts` 已记录的兼容合同 |
| cleanse/commit sonic 接受 explore treatment | 对两个内部调用方加例外 | 两者均为 bounded 分片/逐文件分析；风险需验证而非隐藏 |
| live qualification 人工触发 | 自动塞进 CI 或 `bun run release` | 避免隐性 12/42 次外部调用与费用 |
| Round 5 两个 LOW 留给实现处理 | 再改设计并重跑 Gate | 不影响设计决策；实现时应清除失去消费者的旧 budget 数值，并保留 workflow retry 每 attempt 收窄 cap |

## 9. 风险与安全边界

- 允许：用户本消息已授权在新会话按通过设计修改范围内产品代码、测试、Changelog和资格脚本，并运行本地 focused tests、`bun check` 与只读代码审查。
- 禁止：改 `~/.omp`、改无关工作区文件、删除已有用户改动、提交、推送、发布、部署、GitHub 发言；禁止用 `tsc`，使用 `bun check`。
- 需要用户确认：运行产生外部模型调用的 `test:latency:smoke`（最多 12 次）或 `test:latency:release`（最多 42 次）、新增生产依赖、删除文件、提交/推送/发布及其他高风险外部操作。
- 敏感信息处理：只使用既有 provider 认证链；不得读取、回显或写入 secret、cookie、token、私钥；qualification 报告不得包含凭据。

## 10. 下一 Agent 指引

1. 复算 Reviewed Inputs revision，检查完整 `git status`，完整阅读设计 §5–§6 与 Round 5 Gate；确认没有输入漂移。
2. 检查相关源码当前形状与既有测试 owner，列出小步实施顺序；不得覆盖工作区现存无关改动。
3. 先完成 central policy/class/runtime precedence，再完成 executor advisory、prompt/frontmatter、quality gate、active-wall 与 qualification；每组改动后运行对应 focused tests。
4. Round 5 LOW-1：class 化后删除或重构无消费者的 `SOFT_REQUEST_BUDGET.scout/sonic=100`，确保 explore 预算只有一个 40 的权威来源。
5. Round 5 LOW-2：workflow schema retry 每 attempt 会收窄 `profile.maxRuntimeMs`；显式 caller cap必须按每次实际值直通，不得缓存成静态 cap。
6. 按设计 §6.1/§6.4 运行受影响测试，最后运行 `bun check`；只报告真实新鲜输出。
7. 完成后委派独立只读代码审查，对照设计与 Round 5 notes 检查 diff；修复阻断 finding 并重跑相关验证。
8. 未获外部调用确认时不要运行 `test:latency:*`，最终报告 `UNVERIFIED`；获确认后才按 smoke→release 顺序运行。
9. 遇到以下情况停止并询问用户：
   - 实现必须改变已通过的设计语义、范围或安全边界，需要重新执行 Design Gate。
   - 需要运行 live qualification 但尚未确认凭据、额度和最多 12/42 次调用成本。
   - 相关文件存在无法安全合并的用户改动，或需删除/重写无关内容。
   - 出现确定的认证、权限、额度或外部服务拒绝。

## 11. 回传格式

- 结论：实现是否完成，是否符合 Gate revision。
- 改动文件：逐项列出路径和用户可见行为。
- 验证：focused tests、`bun check`、独立代码审查及 live qualification 的命令与结果。
- 剩余风险：明确区分已验证、未验证与因外部调用未获授权而 `UNVERIFIED` 的部分。
- 下一步：是否需要用户授权 live qualification、提交、PR 或发布。
