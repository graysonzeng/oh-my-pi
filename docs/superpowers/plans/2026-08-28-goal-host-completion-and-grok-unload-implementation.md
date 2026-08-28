# Implementation: Goal 主机验收闸门与 Grok overlay 减负

- Date: 2026-08-28
- Design Doc: docs/superpowers/specs/2026-08-27-goal-host-completion-and-grok-unload-design.md
- Review Doc: docs/superpowers/plans/2026-08-28-goal-host-completion-and-grok-unload-design-review.md
- Status: Completed

## 1. 评审意见处理摘要

- 采纳 HIGH-1：v1 不允许同模型 evaluator 授予 complete。确定性 host gate 拒绝后 goal 保持 active；gate 通过后 evaluator 只写 `next_step` / `blocker`；终态由用户 `/goal complete` 关闭。`goal.hostGate.enabled=false` 才恢复工具直接结案。
- 采纳 HIGH-2：保留 D3，但输入改为 `GoalCompletionSettleSnapshot`（turnId、generation、assistant text、tool id/name/args/result/isError/unpaired、nomination outcome、todo snapshot）。纯函数不再只看 tool 名。
- 采纳 HIGH-3：提名带 `{goalId, goalRevision, nominationId, turnId, generation}`；同 turn 单飞共享；drop/replace/pause/abort 取消 in-flight；陈旧结果 `stale` 丢弃；恢复 pending 清为 continue。
- 采纳 MEDIUM 调度（部分）：D3 走现有 `#queueHiddenNextTurnMessage`，不平行启动 InteractiveMode timer，也不在 D3 再调 evaluator。
- 采纳 MEDIUM 预算：evaluator 用模型 tokenizer 总预算裁剪 transcript；objective 单独超预算返回 `blocked` + `objective_over_budget`。
- 采纳 MEDIUM overlay 回滚：`goal.grokOverlayUnload` 独立于 host gate；`false` 恢复 numbered overlay。
- 未采纳「v1 删除 D3」：评审允许保留，只要先定义结构化 snapshot 并统一 hidden-next-turn。实现走这条，而不是删 D3。
- 未落地 v1.1 只读 verifier / 反 ratchet：仍按设计留到下一里程碑。因此 v1 的独立完成权是用户确认，不是自动 verifier。

## 2. 根因前提处理结论（按需）

- 适用性：适用
- 处理策略：修订后实现
- 结论：主根因「完成权在干活模型手里」有代码证据，稳定，作为实现前提。overlay numbered 是 WEAK_EVIDENCE 放大器，只做可独立回滚的减负，不把它当成结案闸门成立的条件。

### 2.1 消费的根因评审结论

- 主因（complete 直接结案、toolCall settle 跳过 ordinary-obligation）：`SUPPORTED`
- overlay numbered 放大假完成：`WEAK_EVIDENCE`
- 同模型 evaluator 足以替代主机验收：`OVERREACHING`（已从成功标准中删除）

### 2.2 本次修订的前提边界

- 已确认事实：`goal({op:"complete"})` 原先直接 `completeGoalFromTool()`；`agent_end` 有 toolCall 时跳过 ordinary continuation；Grok overlay 第三条是 numbered steps。
- 未确认假设：advisory evaluator 的 `next_step` 质量；完成动词启发式召回；numbered overlay 对假完成的因果强度。
- 对实现的影响：完成权不能依赖 evaluator。host gate 是硬拒绝，用户确认是硬授予。D3 误报只续跑。overlay 用独立 settings 回滚。

## 3. 采纳的设计修订

1. HIGH-1：`executeGoalComplete` 在 host gate `continue` 时立即返回；host `pass` 后 evaluator `candidate_complete` 映射为 advisory，**禁止** `completeGoalFromTool()`。缺 assistant 时 fail-closed 为空 snapshot，host gate 拒绝。
2. HIGH-2：新增 `src/goals/host-gate.ts`。`looksLikeFalseCompletion` / `evaluateGoalHostGate` 只消费 snapshot。失败测试、unpaired tool、open todo 都不能当验证。
3. HIGH-3：`nominateComplete` 同 turn 共享；`applyNominationResult` compare-and-set；`trackInFlightNomination` + abort；`recoverPendingVerification` 不结案。`#withAccounting` 内改走 locked recover，避免自锁。
4. D3 经 hidden-next-turn 注入 `goal-false-completion`；先 `await recordHostAdvice` 再渲染 prompt。
5. Grok overlay 默认卸载 numbered；`explicit-grok-numbered.md` 作为 `goal.grokOverlayUnload=false` 回滚模板。
6. `/goal complete` 成为用户确认；settings、slash command、goal menu、renderer warning 色一并更新。

## 4. 实现摘要

核心模块：

- `packages/coding-agent/src/goals/host-gate.ts` — settle snapshot 与确定性 gate
- `packages/coding-agent/src/goals/complete.ts` — 提名 / host gate / advisory evaluator
- `packages/coding-agent/src/goals/evaluator.ts` — JSON 合同、tokenizer 预算、fail-open continue
- `packages/coding-agent/src/goals/runtime.ts` — nomination CAS、取消、恢复、`recordHostAdvice`
- `packages/coding-agent/src/goals/state.ts` — `hostGate` 持久字段
- `packages/coding-agent/src/goals/hash.ts` — `lastNextStep` 重置 prompt hash
- `packages/coding-agent/src/session/agent-session.ts` — D3 hidden-next-turn、generation host
- `packages/coding-agent/src/modes/interactive-mode.ts` — hostGate 反序列化、pending 恢复、`/goal complete`
- `packages/coding-agent/src/config/settings-schema.ts` — `goal.hostGate.*`、`goal.grokOverlayUnload`
- prompt：`evaluator-system.md`、`evaluator-user.md`、`goal-false-completion.md`、goal 激活/续跑/工具描述、unloaded grok overlay

合同：

- 工作模型调用 `goal({op:"complete"})` 只能得到 `gate: continue | candidate_complete | blocked`
- 只有 `/goal complete` 或 `goal.hostGate.enabled=false` 会把 status 写成 `complete`
- 假完成续跑消费 tool args/results/todos，不看 tool 名集合

## 5. 验证结果

- 测试：
  - `cd packages/coding-agent && bun test test/goals/host-gate.test.ts test/goals/goal-evaluator.test.ts test/goals/goal-nomination.test.ts test/goals/goal-tool.test.ts test/goals/goal-hash-shadow.test.ts test/goals/goal-runtime.test.ts test/goals/goal-mode-integration.test.ts test/model-policy/adapters.test.ts`
  - 结果：85 pass / 0 fail / 344 expect
  - 覆盖：host gate 缺验证/open todo/失败测试/成功验证；false-completion snapshot；evaluator unknown field 与 blocker_key；同 turn 共享提名与 stale discard；drop 取消 in-flight；recover 不清成 complete；工具 complete 保持 active；用户 `/goal complete` 退出 goal mode；hash `next_step` 重置；Grok overlay 默认无 numbered、可独立回滚
- lint/typecheck：`cd packages/coding-agent && bun check` → biome 无诊断，`tsgo --noEmit` 通过
- 构建：未跑包级 `bun run build`（本次是运行时/测试合同，不改编译入口）
- 功能验证：焦点测试即合同验证。未跑 grok-4.6 手工长任务；未跑全仓 test / cargo。

## 6. 已知限制与后续建议

- v1 没有独立只读 verifier。host gate 只能拒绝明显未完成，不能证明 objective 满足。用户确认仍可能误结案。
- 同模型 evaluator 仍是 WEAK_EVIDENCE 的 `next_step` 来源；它不能完成，但可能给出差的续跑建议。
- D3 启发式会漏报/误报。漏报靠用户或再次提名；误报只续跑。
- overlay numbered 因果仍弱；若非 goal Grok 会话指令遵循下降，用 `goal.grokOverlayUnload=false` 回滚，不必关 host gate。
- Interactive 800ms continuation 仍存在；D3 只保证自己走 hidden-next-turn，没有把所有 goal continuation 收成单一 scheduler。
- `onTaskAborted` 曾因 `#withAccounting` 嵌套自锁超时；已拆 locked recover。后续改 runtime 会计路径时不要再从 lock 内调 public recover。

## 7. Handoff

### 7.1 同会话继续

直接执行 $code-review 或 /code-review

### 7.2 新会话恢复 prompt

```text
请阅读设计文档 docs/superpowers/specs/2026-08-27-goal-host-completion-and-grok-unload-design.md、
评审文档 docs/superpowers/plans/2026-08-28-goal-host-completion-and-grok-unload-design-review.md、
实现文档 docs/superpowers/plans/2026-08-28-goal-host-completion-and-grok-unload-implementation.md，
以及本次提交的代码变更。
重点核对根因前提(如有)、设计修订、实现结果与验证证据是否一致，
使用 $code-review(或 /code-review)进行方案重审及代码审查。
重点关注: HIGH-1 同模型 evaluator 不得授予 complete、HIGH-2 GoalCompletionSettleSnapshot 合同、HIGH-3 提名单飞/取消/陈旧结果/恢复。
```
