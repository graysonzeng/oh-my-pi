# Workflow 未 push 提交修复交接

## 范围

- 冻结 diff：`08f6602463c6c03590f741ee9e9ccc0adc888899..693afe8a753e87c71dc9ad4b057abb68552036c6`
- 共 12 个未 push 提交，首个为 `55d9093c0b9f008e9007a2e143d911652425ce81`
- 当前 unstaged/untracked 内容是用户工作；修复时禁止 reset、覆盖或纳入冻结 diff 的结论

## 已验证问题

1. **`/delivery` 丢原始请求**：`packages/coding-agent/src/modes/delivery.ts:140-149` 只保存 round/answers；第二轮把回答当成最终 request。
2. **活动 workflow 恢复错误**：`delivery.ts:122-173` 对非 grilling active workflow 另建新流；`workflow/sqlite-store.ts:173-185` 又按共享数据库全局查询 latest，未按 session 隔离，可跨会话 append/resume。
3. **8 问边界少问一次**：`delivery.ts:153-160` 实际只发送 7 个问题。
4. **sidecar 损坏静默降级**：`workflow/overlay.ts:70-80` 与 `sqlite-store.ts:194-209` 会得到 `pipelineKind:"devflow"` + `overlaySidecar:undefined`，后续可能以空 sidecar 继续。
5. **Gate 漏预算与证据**：`workflow/engine.ts:3777-3844` 收集 usage/identity/toolCalls/completionKind 后丢弃，未走 `#recordUsageAndProfile`。
6. **Gate prompt 未接线**：`engine.ts:3786-3789` 内联 model-facing assignment；`prompts/workflow/gate-review-adapter.md` 无消费者。
7. **reviewer 名称与实际模型不一致**：`workflow/runtime-adapter.ts:421-445` 传 `agent=subagent-sol`，但显式 profile model 优先；默认 reviewer profile 可实际运行 Claude。
8. **75% 检查错误地产生 `budget_stop`**：`task/executor.ts:1311-1322` 调用 `requestBudgetStop`，完整 yield 也不能算 PASS。
9. **Shadow findings 永久丢失**：`task/executor.ts:3577-3594` 调 `acknowledgeDeliveries` 后没有 `resumeDeliveries`；`async/job-manager.ts:385-440` 证明结果被 suppress。
10. **performance class owner 分裂**：`task/review-performance.ts:5-17`、`task/index.ts:56-69` 维护重复名字表，遗漏 `subagent-grok` 与 spawn/frontmatter `shadowReview:"code"`。
11. **scout 与快速 explore 合同冲突**：`prompts/agents/scout.md:5-10,58-60` 为 max/max、禁摘要、必须一直执行到 complete。
12. **规范清理**：selector helper 重复、reviewer 名单重复、TUI width 魔数、测试使用禁用 `ReturnType<>`/`fs.writeFile`、无消费者 scout 常量、Changelog 仍写 20 分钟且漏 `/delivery`。

## 已有证据

- 定向测试：107 pass、0 fail，覆盖 7 个相关测试文件；说明现有测试遗漏上述失败路径。
- `bun check`：passed。
- 运行复现：第二轮 preflight 最终 request 只剩回答；session C 会 append/resume session B workflow；8 轮只输出 7 个问题；损坏 sidecar hydrate 为 `undefined`。

## 修复顺序

1. 先补会在旧代码失败的回归：原 request、8 问、session ownership、active resume、有锁不重复 run、sidecar corruption。
2. 给 workflow 持久化 `owner_session_id`；旧 NULL 行只允许显式 resume；`delivery.ts` 通过 WorkflowTool/Engine 查询，不直接开 Store。
3. sidecar 改版本化严格 schema；devflow 缺失/损坏 fail-closed。
4. Gate 收敛到唯一 runtime/记账链；静态 Handlebars prompt；实际 reviewer agent/model/identity 同源；每次尝试记录 usage/runtime evidence。
5. performance class 在 fresh discovery 后统一解析；75% 仅 steer；Shadow 在 terminal-yield/quiescence 前恢复 exactly-once delivery。
6. 收紧 scout；删除重复 owner；更新 Changelog/docs。
7. 跑定向 tests、`bun check` 和双会话/崩溃恢复/Gate retry/75% reviewer/Shadow 的真实 smoke，再执行 Standards/Spec 双轴评审。存在 P0/P1 时不得 push。

## 新会话短 prompt

```text
继续修复 oh-my-pi `workflow` 分支。先读 `docs/handoffs/2026-08-31-workflow-unpushed-commits-repair-handoff.md` 和其中关联的四份 design；冻结范围 `08f6602463..693afe8a75`，保留所有 unstaged/untracked 用户文件，禁止 reset/覆盖。按测试先行完成：① `/delivery` 保留首轮 request、完整 8 问、以持久化 session owner 查询 active workflow；有锁只报告，无锁 resume，仅无 active 才 run；② DevFlow sidecar 用版本化严格 schema，非法/缺失 fail-closed；③ Gate 复用唯一 runtime/预算/证据链，使用静态 prompt，实际 sol/grok agent、model、identity 同源，每次尝试持久化 usage/runtime evidence；④ 75% 仅 advisory，performance class 在 discovery 后统一解析，Shadow findings 在 quiescence 前 exactly-once 投递；⑤ 删除 selector/reviewer owner 副本并更新 Changelog。每项先写能在旧代码失败的行为回归，再实现；运行相关 `bun test`、`bun check`，并做双会话 `/delivery`、崩溃恢复、Gate retry、75% reviewer、Shadow 投递 smoke。最后执行 Standards/Spec 双轴 review；有 P0/P1 不得声明可 push，不要 commit/push。
```
