# Handoff：Reviewer Shadow Mind 方案评审

创建时间：2026-08-17T15:12:32+08:00
项目根目录：`/Users/sheng/tencent/oh-my-pi`

## 中文短 Prompt

```text
从 docs/handoffs/2026-08-17-1512-reviewer-shadow-mind-方案评审-handoff.md 继续。目标：对 docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md 做独立 Design Review。第一步：spawn sol-xhigh-reviewer（gateway/gpt-5.6-sol @ xhigh，只读），让它读完整 spec 并对照仓库源码核对事实。边界：禁止改产品代码、禁止作者自审、禁止 shell 起模型 CLI、未 PASS 前禁止实现。回传：verdict 必须是 PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN 四选一；把完整报告写入 docs/superpowers/plans/2026-08-17-reviewer-shadow-mind-subagent-review.md，含 Reviewed Inputs 的 path + SHA-256 与 reviewed_revision。
```

## 1. 当前目标

- 用户原始请求：分析 `~/tencent/pi-shadow-mind` 原理，安装到 oh-my-pi；使用 `reviewer` 做 code review 时用该项目做全方位评审。随后确认：只在 code-review 会话跑、Shadow 只提供证据、`sol-xhigh-reviewer` 若是 code review 也要支持。用户现要求：提供短 prompt，在新会话做方案 review。
- 期望结果：异模型只读 Design Review 落盘，verdict 四选一，未通过前不实现。
- 完成标准：review artifact 存在于 `docs/superpowers/plans/2026-08-17-reviewer-shadow-mind-subagent-review.md`；含 Reviewed Inputs manifest 与 `reviewed_revision`；reviewer 与作者 `cursor-grok-4.6` / grok 异模型；未改产品代码。

## 2. 当前状态

- 状态：设计已用户确认并落盘；实现未开始；Design Review Gate 未跑。
- 已完成：原理分析、方案对比、用户确认资格/产出/架构、规格写入。
- 待完成：独立方案评审；通过后写实现计划并实现。
- 最重要的下一步：新会话 spawn 只读 `sol-xhigh-reviewer` 评审该 spec。

## 3. 已确认事实

| 事实 | 证据 | 如何复核 |
| --- | --- | --- |
| 规格路径与元数据：author=grok / cursor-grok-4.6；planned_reviewer=sol-xhigh-reviewer；authorization=authorized | `docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md` 文首 | 读文件头 |
| Pi Shadow Mind 是 turn_end heartbeat 并行认知核，安装不创建 Shadow | `~/tencent/pi-shadow-mind/README.md`、`src/runtime.ts` | 再读 |
| omp `getSystemPrompt()` 返回 `string[]`；turn_end handler 超时 30s | `packages/coding-agent/src/extensibility/extensions/types.ts`、`runner.ts` 中 `EXTENSION_HANDLER_TIMEOUT_MS` | 再读 |
| bundled `reviewer` 有 yield schema；项目级 `sol-xhigh-reviewer` 是设计评审 agent | `packages/coding-agent/src/prompts/agents/reviewer.md`；`.omp/agents/sol-xhigh-reviewer.md` | 再读 |
| 本会话只新增该 spec，未改产品代码，未 git commit | git status 会话开始时无此 spec；本会话 Write 了该文件 | `git status` / `git diff -- docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md` |

## 4. 假设与未知

| 条目 | 类型 | 为什么重要 | 如何解决 |
| --- | --- | --- | --- |
| 完成屏障加 `hasBackgroundWork()` 能接上现有 yield-invalidation | 假设 | 若接不上，提前 yield 仍会丢 Shadow 报告 | 评审对照 `task/executor.ts` `driveSessionToYield` |
| 真模型 4 路并行的延迟/费用可接受 | 未知 | 成功标准含确定性全维度 | 不阻塞方案评审；实现后冒烟，非合并门禁 |

## 5. 相关文件与产物

| 路径或 URL | 用途 | 备注 |
| --- | --- | --- |
| `docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md` | 唯一设计输入 | 必须全文审 |
| `docs/superpowers/plans/2026-08-17-reviewer-shadow-mind-subagent-review.md` | 本轮 review 落盘路径 | 尚不存在，评审后写 |
| `~/tencent/pi-shadow-mind/` | 上游原理对照 | 只读 |
| `packages/coding-agent/src/sdk.ts` | inline 扩展与 createAgentSession | 对照落点 |
| `packages/coding-agent/src/task/executor.ts` | 子 Agent 完成屏障 | 对照后台工作 |
| `packages/coding-agent/src/extensibility/extensions/runner.ts` | handler 超时、ExtensionContext | 对照 30s 约束 |
| `packages/coding-agent/src/prompts/agents/reviewer.md` | bundled reviewer | 对照 prompt 变更 |
| `.omp/agents/sol-xhigh-reviewer.md` | 项目级 reviewer | 对照资格判定 |

## 6. 本会话改动

| 路径 | 改动摘要 | 原因 |
| --- | --- | --- |
| `docs/superpowers/specs/2026-08-17-reviewer-shadow-mind-design.md` | 新增已确认设计 | 用户确认后落盘 |
| `docs/handoffs/2026-08-17-1512-reviewer-shadow-mind-方案评审-handoff.md` | 本交接文档 | 新会话方案评审 |

未改 `packages/` 产品代码。未 commit。

## 7. 命令与验证

| 命令 | 结果 | 证据摘要 |
| --- | --- | --- |
| 产品测试 / lint / 构建 | 未运行 | 本轮只写设计文档 |
| Design Review Gate | 未运行 | 即本交接要启动的工作 |

## 8. 决策与取舍

| 决策 | 考虑过的替代方案 | 原因 |
| --- | --- | --- |
| 只在 code-review 会话跑 | 全会话随机旁路 | 用户选 A |
| Shadow 只提供证据，reviewer 写 findings | Shadow 直接产出 findings / 运行时并集 | 用户按推荐选 A |
| `sol-xhigh-reviewer` 用 spawn prompt 子串判定 code review | 该 agent 总是跑 Shadow | 它默认是设计评审 |
| 内置扩展放 `packages/coding-agent/src/shadow-mind/` | 独立 workspace 包 / plugin-link 上游 | 避免与 `pi-coding-agent` 循环依赖 |
| `turn_end` fire-and-forget + 完成屏障等后台工作 | handler 内 await drain | `EXTENSION_HANDLER_TIMEOUT_MS = 30_000` |

## 9. 风险与安全边界

- 允许：只读读 spec 与仓库源码；把 review 写入指定 plans 路径。
- 禁止：改产品代码；实现；作者自审（grok 评审 grok 草稿）；用 shell 起模型 CLI；伪造 SHA-256 / `reviewed_revision`；commit / push。
- 需要用户确认：删除、force push、部署、生产 DB 写、权限变更、外部消息、支付、密钥轮换；以及任何实现。
- 敏感信息处理：不写入 secret、cookie、token、私钥。

## 10. 下一 Agent 指引

1. 第一步：spawn 只读 `sol-xhigh-reviewer`（`gateway/gpt-5.6-sol` @ xhigh）。主协调者不得自己写评审结论。
2. 然后：reviewer 读完整 spec，按 normalized path 生成 Reviewed Inputs（path + 文件原始 bytes 的 lowercase SHA-256），计算 `reviewed_revision`；对照源码核对 [历史事实]；检查范围、数据流、30s handler、完成屏障、资格判定、错误回退、验证计划是否自洽。
3. 遇到以下情况停止并询问用户：spec 与仓库严重矛盾且无法只读判定；需要改设计才能继续；想改产品代码或开始实现。

## 11. 回传格式

- 结论：PASS / PASS_WITH_NOTES / NEEDS_REVISION / NEEDS_REDESIGN，加可复查证据
- 改动文件：仅 review artifact 路径；不得改 spec 或产品代码
- 验证：Reviewed Inputs 每项 path + SHA-256；`reviewed_revision`；reviewer identity / model
- 剩余风险：仍开放的实现风险
- 下一步：NEEDS_* 则回设计作者修订；PASS* 且授权=authorized 才可进入实现计划
