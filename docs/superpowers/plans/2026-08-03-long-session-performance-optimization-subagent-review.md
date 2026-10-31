# Design Review Gate — omp 长会话性能优化

## Gate 元数据（协调者记录，可复查）

- **review_mode**: `host-native`（shared-worker 路径不适用）
- **Reviewed Inputs manifest**（按 normalized repo-relative path 排序，单输入）：
  - `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md` → sha256 `e06d827eec09e1bdaf1dfbe9757410e9ae9c4930ad3310dbad470db43f516cf1`
- **reviewed_revision**: `74aca70c655d5eb29d8d409d52c87d4522915734bafd5d4c8e5f06c4c00e4fbf`
  （= manifest 行 `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md\t<sha256>\n` 的 UTF-8 bytes 的 lowercase SHA-256；输入 sha256 与 revision 均由原始 bytes 计算，未伪造）
- **design_author / design_author_identity**: `gpt-5.6-luna` / `LongSessionDesignAuthor`
- **planned_reviewer**: `gpt-5.6-sol native reviewer agent`
- **实际 reviewer identity / model**: `LongSessionDesignReviewer` / `gateway/gpt-5.6-sol:xhigh`（host 路由 `task.agentModelOverrides.reviewer`，见 `~/.omp/agent/config.yml`）
- **异模型 Gate**: author `gpt-5.6-luna` ≠ reviewer `gpt-5.6-sol`；评审为只读 reviewer agent 执行，非作者自审；未通过 shell 启动模型 CLI；协调者（`gateway/deepseek-v4-flash`）未参与正文撰写或评审，仅负责 handoff 与 artifact 持久化
- **implementation_authorization**: `design-only`
- **authorization_source**: 用户明确要求“输出为评审用设计文档……不要直接改代码”
- **评审日期**: 2026-08-03

## 最终 Verdict

**NEEDS_REVISION**

- 一句话理由（reviewer 原文）：方案 B 的方向、量化纪律和质量守卫成立，但当前 control 配置事实错误，且 feature snapshot/event 与 opt-in tool prompt 缺少能兑现 resume、消费和 default-off 合同的完整 owner/dispatch 设计。
- 按 Gate 规则：NEEDS_REVISION → 回到当前设计文档修订，修订后重新执行完整 Design Review Gate，重新通过前不得实现。
- 本 verdict 不改变 `implementation_authorization=design-only`，不授权实现、发布、提交或扩大授权；协调者已停止在设计阶段。

---

## Reviewer 报告（gpt-5.6-sol，原文完整持久化）

### 元数据

- Reviewer identity/model：`LongSessionDesignReviewer` / `gpt-5.6-sol`（host route：`gateway/gpt-5.6-sol:xhigh`）
- Author identity/model：`LongSessionDesignAuthor` / `gpt-5.6-luna`
- `review_mode=host-native`；shared-worker path 不适用
- Reviewed input：`docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md`
- Input SHA-256：`e06d827eec09e1bdaf1dfbe9757410e9ae9c4930ad3310dbad470db43f516cf1`
- Reviewed Inputs manifest：`docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md\te06d827eec09e1bdaf1dfbe9757410e9ae9c4930ad3310dbad470db43f516cf1\n`
- `reviewed_revision=74aca70c655d5eb29d8d409d52c87d4522915734bafd5d4c8e5f06c4c00e4fbf`
- `implementation_authorization=design-only`
- `authorization_source=用户明确要求“输出为评审用设计文档……不要直接改代码”`

### 1. 整体结论

**NEEDS_REVISION** — 方案 B 的方向、量化纪律和质量守卫成立，但当前 control 配置事实错误，且 feature snapshot/event 与 opt-in tool prompt 缺少能兑现 resume、消费和 default-off 合同的完整 owner/dispatch 设计。

### 2. 各评审域结论与证据

- **A. 设计目标/范围/约束 — 通过。** [事实] 问题、质量优先级、canonical-owner 复用和“历史 689 会话不作新增收益分母”见设计 §1.1（`docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md:14-31`）；所有数值门槛明确标为 **[拟议验收目标]**，见 §1.2（`:33-45`）；default-off、start snapshot、no second engine 等约束见 §2.3（`:116-123`）。非目标与范围一致，未把历史上限宣称为已达成。
- **B. 三方案比较与单一推荐 — 通过。** [事实] A/B/C 分别覆盖配置纪律、窄 guardrail、激进编排，见 §4.1–§4.3（`:159-346`）；取舍表与正文一致（§4.4，`:347-358`）；§4.5 明确唯一选择 B，并把 C 推迟到静态路由残余、identity/freshness/isolation 获得新证据之后（`:360-368`）。
- **C. canonical owner 复用 — 需修订。** [事实] 既有 seam 均存在：compaction 纯函数在 `packages/agent/src/compaction/compaction.ts:295-323`，pre/mid/post/idle maintenance 在 `packages/coding-agent/src/session/session-maintenance.ts:923-969,1028-1044,1084-1105,2031-2047`；quality route snapshot 在 `packages/coding-agent/src/workflow/quality-route-snapshot.ts:71-159` 并由 `engine.ts:383-418,638-652,880-908` 持久化/恢复；router、model resolver、role/fallback owner 也与 §2.2 相符。未发现第二 router/hub/compactor/verifier。问题是新 `LongSessionFeatureSnapshot`/`performanceEvent` 的 canonical persistence 和 consumer owner 未落到文件/dispatch seam，详见阻塞项 2。
- **D. 控制流 — 需修订。** [事实] §4.2.2 与 §5.2 给出 snapshot → route → compaction → wait → bash → eval → evidence（设计 `:224-231,381-392`）。Hub 确为事件驱动：`packages/coding-agent/src/tools/hub/index.ts:337-467` 直接 race job promises、IRC waiter、timeout、abort；`packages/coding-agent/src/irc/bus.ts:101-168,203-274` 由 `send` 直接 resolve waiter；`packages/coding-agent/src/async/job-manager.ts:325-367,445-458,687-795` 提供 watch、smart ladder、owner sink 和 auto-delivery。因此 B 只提 cap/advisory，没有虚构新 hub。末端 evidence 仍缺新事件的消费/恢复 dispatch，无法证明 ledger 真正闭环。
- **E. 配置接口 — 需修订。** [事实] §5.3.2 的五个 leaf 均默认 off、可独立启用，参数要求 finite/non-negative 且非法配置启动前拒绝（设计 `:425-458`）；start freeze/resume 不热切换见 `:383-385,513`。但当前设计只把“保存 snapshot”归给 schema，并未定义普通主会话持久化/恢复 owner；同时 tool prompt 的静态资产改动与 off 等价合同冲突。两者会破坏 snapshot-frozen 和 default-off 的可验证性。
- **F. 失败路径 — 通过。** [事实] §5.4（设计 `:492-504`）覆盖 schema、identity、compaction、wait、bash fingerprint、eval budget、prompt load、deterministic gate 和质量停止；每项都有 fallback/stop。Bash 保留结构化错误的现状由 `packages/coding-agent/src/tools/bash.ts:578-692` 与 `packages/coding-agent/test/bash-failure-result.test.ts:31-79` 佐证；eval bridge pause/inline/isolation 现状由 `packages/coding-agent/src/eval/bridge-timeout.ts:18-64`、`agent-bridge.ts:126-205` 佐证。typed failure 没有被改写成成功。
- **G. 量化口径 — 通过（带证据来源 Note）。** [事实] 关键历史数与 `docs/long-session-latency-analysis.md` 一致：689/306.6h、174.3h、92.0h、hub/bash/eval/search 见 `:17-28`；Sol 17,205/136.9h/75.7h、29s/16s、context buckets 见 `:60-72`；hub 见 `:79-81`；E2E/eval/search/compaction/read/cacheRead 见 `:86-106,117-118`。算术也正确：`212.6×60%=127.6`、`266.3×60%=159.8`、`(29.1−15.6)×1000/3600=3.75h`。smart ladder `[5s,10s,30s,60s,300s]` 由 `packages/coding-agent/src/async/job-manager.ts:10-20` 和测试 `packages/coding-agent/test/async-job-manager.test.ts:504-525` 复核。设计中的 `wc -m 6,176` / `wc -c 9,981` 未出现在 evidence doc；因标签定义允许来自 brief，数值不判为冲突，但仓库内来源不可复查，见 Note 1。
- **H. 不双算规则 — 通过。** [事实] interval union、`S_combined` 与单 feature marginal delta 不相加、compaction+route interaction、hub child runtime、eval 内部 LLM 包含关系见设计 §2.1（`:93-101`），审计交付物见 §6.5（`:607-615`）；字符/字节/token 分离见 §6.1（`:564-569`）。
- **I. A/B baseline — 通过。** [事实] 当前配置先做 control、历史 689 只作背景见 §1.1/§6.1（设计 `:31,564-569`）；同任务分层和同 deterministic verification contract 见 §1.2/§6.3（`:36-39,581-591`）；pilot ≥30、promotion ≥100 或预注册 CI 见 `:37-38`。
- **J. 质量停止条件 — 通过。** [事实] 完成率/verifier 的 2pp、lineage/identity/scope/isolation fail-closed、compaction 10%、wait regression、bash hard-block、eval gate、search freshness 和 rollback 证据条件均明确，见 §6.4（设计 `:593-605`）；并明确不能用历史 21.3h 或其他算术上限解释回归。
- **K. 独立回滚 — 需修订。** [事实] 各 leaf 默认 off 且分别恢复 control，见 §4.2.5（设计 `:251-284`）；model route 仍走既有 snapshot。可是 prompt 静态资产按当前文件图会影响 off 会话，违反独立回滚；此外 `:283` 提到“关闭 master namespace”，而拟议 YAML 没有 root `enabled`，需要明确“删除/清空 namespace 即原子关闭全部 leaf”或补充真正的 master kill switch。
- **L. 根因分析章节 — 通过。** [事实] “不重新诊断、只把既有证据转为候选并用新 control 验证残余”见 §3.1（设计 `:127-130`），与 evidence doc 的根因/数值及 live owner spot-check 一致。Hub 已事件驱动；compaction 会重写活动历史（`session-maintenance.ts:325-328,343-346,420-423`）；web search 只有 provider-instance cache，Public Web 仅单次调用内 URL dedup（`packages/coding-agent/src/web/search/provider.ts:143-187`、`providers/public.ts:50-118`）；hard timeout 为 60s（`providers/utils.ts:55-73`）；eval pause、bash fail-open advisory 假设均与现状对齐。未重新发明根因。
- **M. 当前配置事实核对 — 需修订。** [事实] `/Users/sheng/.omp/agent/config.yml:609-625,642-644` 与设计一致地包含 `async.enabled=true`、`task.eager=preferred`、`task.batch=true`、四个 agent override、`compaction.thresholdPercent=70`、`idleEnabled=true`；但 `modelRoles.default` 实际为 `gateway/deepseek-v4-flash:max`（`:626-628`），不是设计 §2.2/§5.3.1 所写的 `gateway/gpt-5.6-sol:xhigh`（设计 `:107,396-423`）。`async.pollWaitDuration` 与 `compaction.thresholdTokens` 未显式写入 config，但其 effective defaults 分别确为 `smart` 和 `-1`（`settings-schema.ts:4150-4153,2179-2182`）。新会话 receipt caveat 能防止把配置冒充 provider attestation，却不能消除“当前配置输入”本身错误，且 §5.6 还要求先冻结 brief 列出的值（设计 `:521-524`）。[推断] Flash control 会改变历史 Sol residual pool、普通主会话质量/TTFT baseline 及“不换模”姿态的实际含义；B 仍可能是正确方向，但必须在修订后的 control 上重评。
- **N. Handoff — 通过。** [事实] §8.1–§8.2（设计 `:631-648`）与本次 host-native、异模型只读 reviewer、单一输入、design-only 授权一致；明确 shared-worker 不适用、verdict 词表、manifest/revision 要求和 substantive change 重审条件。无论 PASS 还是 PASS_WITH_NOTES 都要求停在设计阶段。

### 3. 阻塞性问题

1. **按实际默认模型重建 control 输入。** [事实] 设计 `:107,404-423` 把当前 `modelRoles.default` 写为 Sol xhigh，实际 config `:626-628` 为 DeepSeek V4 Flash max；§5.6 又会把错误值固化进 control fingerprint。必须纠正文档，明确该差异对普通主会话质量权限、历史 Sol 残余和 B/C 选择的影响，并从修订后的 effective-settings receipt 建 baseline。
2. **指定 feature snapshot 与事件的持久化/恢复/消费 owner。** [事实] 设计 `:383-385,462-485` 定义跨模块的 `LongSessionFeatureSnapshot`、`performanceEvent` 和 outcome variants，却未给普通 session 的 producer、resume reader 或 offline ledger dispatcher；`settings-schema.ts` 只定义设置，现有 workflow snapshot 只覆盖 workflow。仓库已有一般持久化 seam `SessionManager.appendCustomEntry`（`packages/coding-agent/src/session/session-manager.ts:1975-1978`），而 `CustomEntry` 需要消费方扫描恢复（`session-entries.ts:123-130`）。修订必须指定 canonical entry/artifact kind、start 写入、resume 校验/恢复、`usedCalls` 恢复、事件 dispatch 与 ledger consumer，并定义缺失/损坏时的 fail/fallback。
3. **将 tool prompt 变更置于 `promptPolicy` 开关下。** [事实] §4.2.1/§5.6（设计 `:212-213,531-534`）要求更新四个静态 tool prompt 文件，但 §5.3.2/§6.2 又要求 off 时 system/tool prompt 与 control 完全一致（`:449-450,578`）。当前 Hub 与 WebSearch 分别无条件 render 静态资产（`packages/coding-agent/src/tools/hub/index.ts:234-235`、`web/search/index.ts:314-315,339-340`），B 的文件图也未列 web-search wiring。必须选择一种可复查合同：要么工具资产不变、仅在 system prompt 注入 gated block；要么为每个 tool description 增加 session-scoped gated render，并测试 off 字节等价、on 仅注入一次。

### 4. 非阻塞性 Notes

1. [未验证] `wc -m 6,176` / `wc -c 9,981` 在 `docs/long-session-latency-analysis.md:1-131` 无对应记录；若来自 brief，应在设计 §2.1/§6.1 标出可复查来源或命令证据。
2. [事实] `async.pollWaitDuration=smart` 与 `compaction.thresholdTokens=-1` 是 schema default，不是当前 config 文件中的显式键；baseline receipt 应区分 explicit value 与 default-derived effective value。
3. [事实] §4.2.5 的“关闭 master namespace”没有对应 root boolean。删除/清空整个 namespace因 leaf 默认 off 可以达到目标，但应把该原子操作写清；若要运行时 master switch，则把字段及优先级纳入严格 schema 和 rollback tests。
4. [事实] 所列 11 个测试文件均存在，但“入口存在”不等于当前已覆盖新合同：例如 `bash-execution-clamp.test.ts:9-90` 当前主要测 TUI 字符宽度，`core/eval-workflow-helpers.integration.test.ts:12-20` 受 `PI_PYTHON_INTEGRATION=1` gate。实施时必须按 §6.2 补充 observable contract tests，不能把文件存在当作 budget/advisory 证据。

### 5. 最终 Verdict

**NEEDS_REVISION**

实现前必须满足：
1. 纠正 live config/default-model 事实，并用修订后的 effective control 重评残余池与普通主会话 stance；
2. 补齐 `LongSessionFeatureSnapshot`/`performanceEvent` 的 canonical persistence、resume、dispatch、ledger consumer 与损坏失败语义；
3. 补齐 tool prompt 的 session-gated wiring，使每个 leaf（尤其 `promptPolicy`）关闭时可证明恢复 control；
4. 明确 master namespace 的原子关闭语义，并补充文档单位的可复查来源；
5. 因上述涉及配置事实、接口/数据流和回滚义务，修订后重新执行完整 Design Review Gate；
6. `implementation_authorization` 仍为 `design-only`，本 verdict 不授权实现。

---

## 结构化 Findings（reviewer 输出原文）

1. **按实际默认模型重建 control 输入** (priority 1, confidence 0.99) — `docs/superpowers/specs/2026-08-03-long-session-performance-optimization-design.md:107`：[事实] 这里把当前 `modelRoles.default` 记为 `gateway/gpt-5.6-sol:xhigh`，但实际 `/Users/sheng/.omp/agent/config.yml:626-628` 是 `gateway/deepseek-v4-flash:max`；§5.6 还要求把 brief 列出的值冻结为 control fingerprint。新会话 receipt 的 caveat 只能区分配置与 provider attestation，不能修正错误的配置输入。该差异会改变普通主会话的 control 模型、历史 Sol 残余池和“不换模”姿态的实际含义；应先纠正文档并在 Flash effective-control 上重评 B/C 结论与质量基线。
2. **指定 feature snapshot 与事件的持久化消费 owner** (priority 1, confidence 0.98) — `:383-385`：[事实] §5.2 在此要求普通 session start 写入 `LongSessionFeatureSnapshot` 并在 resume 保持冻结，但文件图只把保存职责归给 `settings-schema.ts`；该文件只定义设置，现有 `QualityRouteSnapshot` 的持久化/恢复又仅位于 workflow engine。仓库的一般 session seam 是 `SessionManager.appendCustomEntry`（`session-manager.ts:1975-1978`），而 `CustomEntry` 必须由消费方扫描恢复（`session-entries.ts:123-130`）。设计还没有为 `performanceEvent` outcome、`evalBudget.usedCalls` 或离线 ledger 指定 producer、resume reader/dispatcher 和 consumer，因此 resume 可重置计数或读到新 settings，事件也可能无人消费。请补齐 canonical entry/artifact kind、恢复校验、dispatch 和损坏时 fallback。
3. **将 tool prompt 变更置于 promptPolicy 开关下** (priority 1, confidence 0.97) — `:212-213`：[事实] 此处要求更新四个静态 tool prompt 文件，而 §5.3.2/§6.2 同时要求 `promptPolicy.enabled=false` 时 system/tool prompt 与 control 完全一致。当前 Hub 和 WebSearch 分别无条件 render 这些资产（`tools/hub/index.ts:234-235`、`web/search/index.ts:314-315,339-340`），且 B 的文件图没有列出 web-search 的 session-gated wiring；直接编辑 markdown 会让所有 control 会话也变化，破坏 default-off、独立回滚和 A/B 归因。请改为只注入 gated system block，或明确修改每个 tool constructor/description 以按 session snapshot 条件渲染，并验证 off 字节等价、on 仅注入一次。
