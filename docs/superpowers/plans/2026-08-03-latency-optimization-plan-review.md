# Review: omp Latency Optimization Plan (claude-opus-5 design)

- Date: 2026-08-03
- Review mode: host-native read-only agent (gpt-5.6-sol xhigh), independent lineage from author
- design_author: claude-opus-5 (xhigh)
- reviewer: gpt-5.6-sol xhigh (sol-xhigh-reviewer agent)
- information_base_author: deepseek-v4-flash:max
- Gate type: full Design Review Gate
- Verdict: **NEEDS_REVISION**
- revision_round: 2
- Status: round 2 final reviewer 修复完成（2026-08-04）
- Round-1 artifact snapshot: `db057745e20a46035965a52c1a68b84c466d0029bf0c4b063cdd8bc5022aa412`

## Gate Continuity Note

**Review-time source baseline**（2026-08-03）：repo 输入可由下述 recovery anchor 复现；仅当时的可变本机配置未留 snapshot，不能事后复现。

- Reviewed at: 2026-08-03
- Repo/source recovery anchor: `f580305e`（不是对 C 创建时刻的精确证明，但该 commit 可逐字恢复 C 实际评审的 A/B 与其 hash）
- Design document A hash at review: `f04123c429f338da8f969accb6635b47d9b3209b3416f1ffc74f315ca759c71b`
- Design document B hash at review: `cc8fbc97e9423224ced820b2b8fb9397f39ec890587dffda2ac70990c2242bb0`
- Recovery: `git show f580305e:docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md` and `git show f580305e:docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md`; re-hashing yields `f04123…` / `cc8fbc…`.
- Round-1 collective review later observed B snapshot `1f00bb283ce580bc54eaa01c3708402a703be0c2efa71db9a62b7f5417fb9f91`；它不是 C 的 review-time input，“current B”不再作为可变指针写入本 manifest。

**Effective settings receipt**（2026-08-03 review-time config）：

- `task.agentModelOverrides`: **[历史事实-当时配置，2026-08-03 不可复现]** 当时评审记录为 config.yml 未含此键。
- `task.eager=preferred`: **[历史事实-当时配置，2026-08-03 不可复现]** 当时评审记录为 config.yml 未含此显式值。
- `compaction.thresholdPercent=70`: **[历史事实-当时配置，2026-08-03 不可复现]** 当时评审记录为 config.yml 未含此显式值。
- `compaction.idleEnabled=true`: **[历史事实-当时配置，2026-08-03 不可复现]** 当时评审记录为 config.yml 未含此显式值。
- Review-time config snapshot/hash: **未捕获**。以上只保留为带日期的 contemporaneous observation，不作为 2026-08-04 current-capability 证据，也不能单独支撑后续 A/B control。

**Current effective baseline**（reviewed_at=2026-08-04）：

- Non-secret config receipt: `/Users/sheng/.omp/agent/config.yml:609-644`; slice SHA-256 `94d5c630662de03327c500be627ac01770b5d63fbce9e44c7e331e2aef9df3f6`
- Explicit: `async.enabled=true`, `task.eager=preferred`, `task.batch=true`
- Explicit: `task.agentModelOverrides` = scout/Flash, designer/Sol, task/Luna, reviewer/Sol
- Explicit: `modelRoles.plan=gateway/gpt-5.6-luna:max`, `modelRoles.default=gateway/deepseek-v4-flash:max`
- Explicit: `compaction.thresholdPercent=70`, `compaction.idleEnabled=true`
- Default-derived: `compaction.idleThresholdTokens=200000`（`settings-schema.ts:2259-2262`）
- Default-derived: `defaultThinkingLevel=high`（`settings-schema.ts:1064-1069`）；classifier 仅 thinking=`auto` 时激活（`modes/components/settings-defs.ts:126-129`）
- Default-derived: `modelOptimization.enabled=false`（`settings-schema.ts:4505-4509`）；ordinary-session profile 仅在该值为 true 时解析（`sdk.ts:2919-2945`）

**Configuration drift impact**：第一条 blocker 是不可复现的历史配置观察，现已部分过时；任何未来 A/B 必须从 2026-08-04 effective baseline 或更新的 dated receipt 重建 control。其余三条 headline blocker（重复 canonical seam / 编排合同不匹配 / 收益标签与算术）不依赖该可变配置，仍可由固定 repo 输入独立复现。

**Cross-document continuity**（2026-08-04）：

- Reviewer independence 采用 B 的后续用户决定：干净上下文的新 subagent review 即可独立，不要求必须异模型族（round-1 collective review recorded B:115；round-2 B §4.0.1「决定 A」）。这取代 C 评审时的 strict-lineage 口径。
- `plan_review` 采用 D 的「单强评审 + 同评审复审 + 分歧仲裁」，不是 N-reviewer any-block 并行投票；C 对 A 的并行 plan-review 批评因此仍成立。

**Current repo revision**（2026-08-04）：`93927e87ab6965a0d1ff60528a311c697f70adce`

## Verdict summary

核心方向仍可保留，但被评审的 A revision 不能进入实现。阻塞原因：

1. **[历史配置漂移，部分过时]** review-time 配置观察没有 snapshot；当前 config 已显式包含四个争议键，future control 必须重建；
2. **[仍然有效]** 方向 1 重复 ordinary-session truncation canonical seam（普通会话已调用共享 `processToolOutputDetailedAsync`，只是 `modelOptimization.enabled` 默认 false）；
3. **[仍然有效]** 方向 4 的主-agent 编排合同与实际 workflow/task/hub 控制流不匹配（`task-batch.ts` 不存在、`await:true` 仅属 hub send、review stage 每次直接一次 `RuntimePort.run`）；
4. **[仍然有效]** §2.1 的 40-60h / 10-18h / 7-10h / 3-6h / 2-3h 是带未测比例的 scenario estimates，不是可复现的 `[算术上限]`。

## Evidence

### Quantitative audit

| Claim | Reproducible evidence | Result |
|---|---|---|
| Historical corpus | `docs/long-session-latency-analysis.md:17-28` | 689 sessions; 306.6h active; gen 174.3h, TTFT 92.0h, hub 21.3h, bash 6.2h, eval 3.7h, web_search 3.7h |
| Sol pool | `docs/long-session-latency-analysis.md:60-75` | 17,205 turns; gen 136.9h; TTFT 75.7h |
| Context buckets | same source | Sol-only: `<100k=15.6s`, `>=200k=29.1s`; full-corpus: `>=350k=51.0s`（作用域分离） |
| Character/byte units | `wc -m -c docs/long-session-latency-analysis.md` | 6,176 characters; 9,981 UTF-8 bytes; neither is a token count |
| TTFT migration identity | `75.7×0.35×(1-4/16)` | 19.87125h → 19.87h |
| Eval average identity | `(3.7×3600)/578` | 23.04498s → 23.04s |
| Sol bucket identity | `(29.1-15.6)×1000/3600` | 3.75h per 1,000 actually affected Sol-bucket turns |
| Current default model | config receipt `:609-644` | `modelRoles.default=gateway/deepseek-v4-flash:max` (explicit) |

### [历史事实] / current source facts

- Ordinary-session tool results already pass through `agent-session.ts:3046-3085` → shared `workflow/tool-output-manager.ts:364-401`; built-in family rules are in `model-optimization/default-profiles.ts:9-27,53-111`. `sdk.ts:2919-2945` and schema default false prove this is an existing, default-off seam—not a missing capability.
- Hub wait is event-driven: `tools/hub/index.ts:386-456` races running job promises, IRC waiter, timeout and abort; smart ladder is `[5s,10s,30s,60s,300s]` at `async/job-manager.ts:10-21`.
- Ordinary read has no provider-context presence dedupe: `tools/read.ts:143-147` caches only deterministic summary parsing after fresh bytes are read; workflow exact-hash context optimization is at `workflow/context-ledger.ts:145-213`.
- Current review stages each invoke the runtime once: `workflow/stages/plan-review.ts:59` and `workflow/stages/code-review.ts:61`. `ReviewArtifactV1` remains one decision/findings/explanation/confidence object (`workflow/types.ts:154-160`, `workflow/schemas.ts:96-115`).
- Actual task batch owner is `task/index.ts:697-718`; bounded concurrency primitive is `task/parallel.ts:100-141`. `task-batch.ts` does not exist. Hub schema at `tools/hub/index.ts:75-83` assigns `await` only to `op="send"`.

### [历史事实] claim contradicts source or traces to upstream error

- A `:43-50` presented task overrides, compaction 70%+idle, task.eager=preferred, auto-thinking-active and workflow-only truncation as one current baseline. The mutable config part is preserved only as **[历史事实-当时配置，2026-08-03 不可复现]**; auto-thinking and truncation activation claims are independently contradicted by the pinned schema/runtime sources above.
- A `:47,50,132,490` said ordinary-session truncation was absent; the shared ordinary path already existed.
- A `:191-199,325` depended on nonexistent `task-batch.ts` and treated `await:true` as a wait parameter; actual owners/contracts contradict both claims.
- Upstream traceability: review-time B (`cc8fbc…`, original B:125,161,166-167) supplied the ordinary-truncation/task-batch premises; `.omp/agents/opus5-designer.md:18` also names `task-batch` as a canonical owner. The agent file is therefore a causal review input, not disposable prompt metadata. Its pinned hash is in the manifest below.
- A `:93,257` assumed Luna/Terra ≈4s; `docs/long-session-latency-analysis.md:73` says Sol/Luna 16-17s, Flash/Grok 4s, and supplies no Terra measurement.

### [未验证假设]

- A §2.1 ranges use unmeasured conversion, overlap and affected-turn proportions. They must not be ordered as established benefit. Direction 1 also substitutes “30% turns” for “30% TTFT hours” and applies a Sol-only bucket ratio to all 92h.
- Direction 4's 30-50% eliminable share has no corpus classification; direction 3's 3-6h consumes 48.4%-96.8% of the full bash pool; direction 5's 2-3h consumes 54.1%-81.1% of the full eval pool. Backgrounding shortens critical path only when independent work actually overlaps.
- N-reviewer parallelism is not semantically equal to the single-reviewer control: it changes workload, any-block probability and artifact requirements. Plan review must retain D's single-reviewer/re-review/arbitration form; any separate code-review experiment needs a versioned multi-review envelope.

## Findings

### [BLOCKING-1][current baseline drift, partially obsolete]

- **Exact claim**: A §1.2 (`:43-50`) treats mutable config, schema defaults and capability activation as one current fact set.
- **Why wrong/risky**: review-time config was not snapshotted; current config has drifted; auto-thinking and ordinary truncation activation are separately gated. A/B using a blended baseline is not comparable.
- **Required fix in A**: dated effective-settings receipt; explicit vs default-derived vs capability/activation separation; current control rebuilt from a fresh receipt. Preserve the 2026-08-03 observation only with the exact historical/non-reproducible label above.

### [BLOCKING-2][no second engine / direction 1]

- **Exact claim**: A `:138-146,172-174` proposes `session/tool-output-processor.ts`, `performance.contextVolume.truncation.*` and a new extraction path.
- **Why wrong/risky**: ordinary sessions already use the shared manager and family profiles; a new processor/namespace creates competing ownership and rollback behavior.
- **Required fix in A**: activate/extend existing `modelOptimization` + `workflow/tool-output-manager.ts`; preserve recovery receipts and fail-closed behavior. Read dedupe key must include normalized path, selector/range, display mode, immutable content hash and branch/provider-view; reset/reconcile on compaction/rewind/model switch; uncertainty fails open; do not invent a `fresh` read parameter (`tools/read.ts:720-724`).

### [BLOCKING-3][main-agent concurrency contract]

- **Exact claim**: A `:184-201` routes main-agent group/max/dependency/isolation/rendezvous declarations through task-batch/hub and parallel plan reviewers.
- **Why wrong/risky**: no `task-batch.ts`; workflow review uses direct `RuntimePort.run`; `await:true` is send-only; no typed declaration owner, durable state, cancellation/resume, backpressure, dependency validation or rendezvous failure semantics.
- **Required fix in A**: define a versioned declaration in WorkflowRequest / PlanArtifact / stage policy and map it to real `RuntimePort` or `task/index.ts` + `task/parallel.ts`. Keep `plan_review` as one strong reviewer + same-reviewer re-review + disagreement arbitration; parallelism is limited to deterministic evidence collection or separately specified code-review experiments.

### [BLOCKING-4][benefit labels and ordering]

- **Exact claim**: A `:91-101` labels and orders 40-60h > 10-18h > 7-10h > 3-6h > 2-3h as arithmetic upper bounds.
- **Why wrong/risky**: formulas depend on unmeasured proportions, wrong target latency and overlapping opportunities. The reproducible identities are 19.87h for the stated 35% 16s→4s migration, 23.04s eval average, 3.75h per 1,000 actually affected Sol-bucket turns, and `21.3h×r` for measured eliminable hub share `r`.
- **Required fix in A**: label ranges `[未验证假设]`; do not rank before Phase-0 residual-pool evidence; target Flash; keep Sol-only and full-corpus bucket scopes separate.

### [MAJOR-1][upstream error traceability]

- **Original C gap**: original C treated the author prompt as removable input and did not trace the repeated owner/capability error upstream.
- **Closure in C round 2**: B and `.omp/agents/opus5-designer.md:18` are now named as causal sources; A and the agent prompt are both in the fixed manifest. Future remediation must remove `task-batch` from the agent prompt and keep B on `task/index.ts` + `task/parallel.ts` / RuntimePort.

### [MAJOR-2][durable performanceEvent contract degradation]

- **Exact claim**: A `:415-417` reduces the ledger record to `{type, feature, timestamp, metadata}`.
- **Why wrong/risky**: prior Plan B `:479-510,527-531,603` requires `eventId`, `invocationId`, `phase`, `startedAt`, `endedAt`, `outcome`, a pre-invocation awaited durable barrier, active-branch rehydrate, outer-invocation 1:1 reconcile and fail-closed handling. A drops the contract needed for crash/resume accounting and trustworthy non-overlap attribution.
- **Required fix in A**: restore the complete durable schema/lifecycle or explicitly drop durable rollback/accounting claims and re-review that scope reduction.

### [MAJOR-3][independent rollback incomplete]

- **Exact claim**: A says every feature is independently switchable, but direction 2 `role_subdivision` (A `:392`) and direction 5 `eval_migration` (A `:396`) specify arm dimensions without an independent enabled leaf, frozen snapshot or concrete rollback owner.
- **Why wrong/risky**: those treatments cannot be isolated, attributed or rolled back independently as promised.
- **Required fix in A**: add independent default-off leaf + session-frozen snapshot + owner + rollback test for directions 2 and 5; do not rely on prose-only “revert route/path.”

### [NOTE][feature ordering severity]

- Original C's Phase-2a/2b ordering objection is downgraded from Major to Note. A still places discretionary directions 3/5 before must-do orchestration 4.a/4.b, but this is a scheduling preference because 4.a/4.b remain present in Phase 2b; it does not independently block design approval.

## Round-2 artifact closure

| Round-1 collective finding on C | Status after this repair | Evidence in C |
|---|---|---|
| Mutable config made headline blocker non-reproducible | **Closed** | dated historical/non-reproducible label, current explicit/default-derived receipt, config slice hash |
| Missing B/agent upstream traceability | **Closed** | upstream section + agent line 18 + pinned agent hash |
| Missing durable-event degradation finding | **Closed** | MAJOR-2 with old A and prior Plan B line ranges |
| Incomplete direction 2/5 rollback check | **Closed** | MAJOR-3 |
| RuntimePort citation pointed at construction rather than call | **Closed** | `stages/plan-review.ts:59`, `code-review.ts:61` |
| Sol/full-corpus bucket scopes mixed | **Closed** | quantitative table labels Sol-only 15.6/29.1 vs full-corpus 51.0 |
| Manifest omitted identity/revision and had unresolved fields | **Closed** | fixed five-input manifest, config receipt hash, repo revision, computed reviewed_revision |
| Feature ordering severity too high | **Closed** | downgraded to Note |

## Reviewed Inputs

The following five rows are serialized exactly in the shown order. Each UTF-8 row is: repo-relative path, one literal TAB, lowercase SHA-256, then LF. Their concatenation is hashed as `reviewed_revision`.

```text
docs/superpowers/specs/2026-08-03-latency-optimization-plan-design.md	f04123c429f338da8f969accb6635b47d9b3209b3416f1ffc74f315ca759c71b
docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md	cc8fbc97e9423224ced820b2b8fb9397f39ec890587dffda2ac70990c2242bb0
docs/long-session-latency-analysis.md	0fd71c4dc5ad665b65118f0d80381ee5800360c31b72ca0800715218e3048089
docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md	42f8e15a22ae2c22f62be233200b2b2dcafd373b67f348303c60e56f39c269b9
.omp/agents/opus5-designer.md	cfd6eccacd6a6e95d4730d6eb6b98e74f9e4ec3a42895906bdbc7fef0430de9f
```

- B old hash `cc8fbc97e9423224ced820b2b8fb9397f39ec890587dffda2ac70990c2242bb0` is intentionally retained: `git show f580305e:docs/superpowers/specs/2026-08-03-latency-defaults-gaps-design.md` reproduces it and proves C reviewed the pre-revision B.
- A old hash is likewise recoverable from the same commit and path.
- `reviewed_revision`: `97258e1a9ba7b40fabacf6b735c1806d075d162481c39f70e5ab03c73bf28f8f`
- Repo/source recovery anchor: `f580305e`; current repo revision at final repair: `93927e87ab6965a0d1ff60528a311c697f70adce`
- Review-time config hash remains unavailable by construction; current non-secret config slice identity is pinned in the Gate Continuity Note.

## Next step

NEEDS_REVISION → return A to claude-opus-5 for revision against the BLOCKING/MAJOR findings: fresh effective baseline receipt; existing `modelOptimization` seam; real task/parallel + RuntimePort orchestration; D-compatible plan-review form; scenario-estimate labels; durable event contract; independent direction 2/5 rollback; upstream B/agent owner correction. Re-run the full Design Review Gate after revision; do not implement before it passes.
