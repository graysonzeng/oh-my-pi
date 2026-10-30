# DeepSeek Harness + V4-Pro 是否媲美 Claude Opus 5？

调研日期：2026-08-15。Harness 开源约 2 天（2026-08-13 开发者预览）。

**结论（先说）：传言把三件事叠在一起了，真实能力对不上 Opus 5。「或许还有反转」也不是换更强权重。**

1. 官方自己对标的是 **Opus 4.6**，不是 Opus 5。
2. 榜单上的 Code Agent 分，官方脚注写明是用 **DeepSeek Harness 极简模式**测的。官方测试名就是 `sends the exact RL prompt and schemas`：极简模式发的是**训练时那一套**提示词和两个工具 schema。
3. 真实工程上，V4-Pro-0813 能进「能编译、少量细节问题」档，和 Kimi K3 / Grok 4.6 一档，**低于** Opus 5 / Fable 5 / GPT 5.6 Sol。dsh 标准/PTC **不抬最终完成度**。
4. 2026-08-15 的「反转」帖：不是服务端又切了更强 checkpoint。能复现的是——**首轮工具目录会锁 Pro 的推理轨迹**。在某套像训练接口的自测上，极简/锚定可到 98–99，和该套题上的 Opus 5（97）同分带；换 Unity 皮肤、画鹈鹕、OpenCode 默认工具面，就掉回 91 或直接失败。这是过拟合，不是「藏着的 Opus 5」。

证据分级：`事实` = 原文可核验；`推断` = 由事实推出；`未知` = 本轮读不到一手。

---

## 1. 时间线（必须拆开看）

| 日期 | 事件 | 含义 |
| --- | --- | --- |
| 2026-04-24 | DeepSeek-V4 Preview（Pro 1.6T/49B active + Flash 284B/13B），1M 上下文，MIT 开源 | 官方中文写：内部员工体验优于 Sonnet 4.5，交付接近 **Opus 4.6 非思考**，仍落后 **Opus 4.6 思考** |
| 2026-07-24 | Anthropic 发布 **Claude Opus 5** | 「Opus 档位的台阶式提升」，官方称在 Frontier-Bench / GDPval-AA 等为新 SOTA；定价仍 $5 / $25 per M |
| 2026-07-25 | V2EX 传 DeepSeek 在做对标 Claude Code 的 Agent | 期待先于产品 |
| 2026-08-12 | API 文档出现 `DeepSeek-V4-Pro-0813` | 社区先看到 fingerprint 变了 |
| 2026-08-13 | V4-Pro 正式版波折上线；当晚 Harness（dsh）v0.1 开发者预览 MIT 开源 | 模型与运行时拆开发布。仓库约 9.3 万 star / 8.5k fork（2026-08-15 读取） |
| 2026-08-15 | Linux.do《【推测】V4P 0813或许还有反转？》 | 主楼把灰测能力归因于「提示词过拟合」；转述社区插件：先露极简工具面再放开全工具 |

来源：[V4 Preview 中文公告](https://api-docs.deepseek.com/zh-cn/news/news260424/)、[V4-Pro GA 中文](https://api-docs.deepseek.com/zh-cn/news/news260813/)、[V4-Pro GA 英文](https://api-docs.deepseek.com/news/news260813/)、[Opus 5 公告](https://www.anthropic.com/news/claude-opus-5)、[dsh README](https://github.com/deepseek-ai/deepseek-harness)、[21 财经 2026-08-14](https://m.21jingji.com/article/20260814/herald/634250531c1b2e66ffa4a17cf8efc120.html)、[V2EX t/1229696](https://www.v2ex.com/t/1229696)、[V2EX t/1233959](https://www.v2ex.com/t/1233959)。

---

## 2. 官方到底说了什么

### 2.1 预览版（2026-04-24）——对标 Opus 4.6，且自承有差距

中文原文（`事实`）：

> 目前 DeepSeek-V4 已成为公司内部员工使用的 Agentic Coding 模型，据评测反馈使用体验优于 Sonnet 4.5，交付质量接近 Opus 4.6 非思考模式，但仍与 Opus 4.6 思考模式存在一定差距。

同一篇还写：针对 **Claude Code、OpenClaw、OpenCode、CodeBuddy** 做了适配。

[https://api-docs.deepseek.com/zh-cn/news/news260424/](https://api-docs.deepseek.com/zh-cn/news/news260424/)

HN 用户 `madagang` 当天就把这段翻译给英文区，没有二次加工。  
[https://news.ycombinator.com/item?id=47885263](https://news.ycombinator.com/item?id=47885263)

### 2.2 正式版 0813 ——「生产环境 Agent 提升」，对照表仍是 Opus 4.6

中文公告（`事实`）：

> 今天，我们发布 DeepSeek V4 Pro 正式版。  
> 正式版 DeepSeek V4 Pro 增强了 Agent 能力，在生产环境中的性能表现提升尤为显著。

脚注（关键，`事实`）：

> 对于公开基准测试集中的 Code Agent 任务，DeepSeek-V4-Pro-0813 使用 DeepSeek Harness 极简模式作为框架进行测试（使用 max 档位，topp=0.95，temperature=1.0），其他框架下结果可能略有不同。

[https://api-docs.deepseek.com/zh-cn/news/news260813/](https://api-docs.deepseek.com/zh-cn/news/news260813/)

英文对应：「Major Agent upgrades with strong production gains」，并强调 reasoning effort：low / high / max。  
[https://api-docs.deepseek.com/news/news260813/](https://api-docs.deepseek.com/news/news260813/)

官方**没有**写「媲美 / 达到 Claude Opus 5」。

### 2.3 Hugging Face 对照表：打的是 Opus-4.6 Max

[DeepSeek-V4-Pro model card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro) 表头是 `Opus-4.6 Max` vs `DS-V4-Pro Max`（`事实`）：

| 任务 | Opus-4.6 Max | DS-V4-Pro Max | 读法 |
| --- | ---: | ---: | --- |
| LiveCodeBench Pass@1 | 88.8 | **93.5** | 算法/竞赛向，DS 领先 |
| SWE Verified | **80.8** | 80.6 | 几乎打平 |
| SWE Pro | **57.3** | 55.4 | 仓库级，DS 落后 |
| SWE Multilingual | **77.5** | 76.2 | 略落后 |
| Terminal Bench 2.0 | 65.4 | **67.9** | DS 略领先 |
| HLE w/ tools | **53.1** | 48.2 | 工具推理，DS 落后 |
| MRCR 1M | **92.9** | 83.5 | 超长上下文，DS 落后一截 |
| GDPval-AA Elo | **1619** | 1554 | 知识工作，DS 落后 |


官方 [Updates 2026-08-13](https://api-docs.deepseek.com/updates/) 另给了一张**公司自评**的生产向表（与 HF 的 Opus-4.6 对照表不是同一套题，`事实`）：

| 自评集 | V4-Pro-0813 | V4-Flash-0731 |
| --- | ---: | ---: |
| Terminal Bench 2.1 | 87.9 | 82.7 |
| Toolathlon-Verified | 74.1 | 70.3 |
| DeepSWE | 62.7 | 54.4 |
| DSBench-FullStack（内部） | 71.1 | 68.7 |
| DSBench-Hard（内部） | 67.2 | 59.6 |
| HLE wo/w tools | 42.7 / 60.0 | （0731 条目未并列此项） |

0731 条目脚注同样写：公开 Code Agent 题用 **Harness 极简模式 + max**；DSBench 两套是**内部题**。这张表不能直接拿去对 Opus 5。
HF 文案是「显著缩小与顶尖闭源在推理和 agent 任务上的差距」「开源最强」，不是「已是 Opus 5」。

### 2.4 Harness 官方定位

- 「Everything is a plugin」；Cordis 驱动。
- **开发者预览**，README 全大写警告破坏性变更。作者 `tianyicui` 在 HN 亲口说：early preview，lots of rough edges，欢迎反馈。[HN 49285244](https://news.ycombinator.com/item?id=49285244)
- 极简模式只留 shell + 文件编辑，专门给评测复现。0731/0813 changelog 都把公开 Code Agent 分绑在这个模式上。
- 模型本身也是插件，可换。HN `mring33621` 用本地 9B Qwen + llama.cpp 跑 dsh，「small python projects… works GREAT」「比试过的其他 harness 快」。测的是脚手架速度，不是 V4-Pro≈Opus 5。
- `skc`：「Played around with it. Does what it says on the tin.」无对照。
- `flaburgan` 当场问：有没有「同一模型、同一提示、不同 harness」的对比？回帖认为配置太多，现在几乎做不成可迁移的对比。

来源：[README](https://github.com/deepseek-ai/deepseek-harness)、[产品页](https://www.deepseek.com/harness/en/)、[21 财经](https://m.21jingji.com/article/20260814/herald/634250531c1b2e66ffa4a17cf8efc120.html)、[HN dsh 帖](https://news.ycombinator.com/item?id=49285244)、[Updates](https://api-docs.deepseek.com/updates/)。

### 2.5 Opus 5 官方把自己放在哪

[Introducing Claude Opus 5](https://www.anthropic.com/news/claude-opus-5)（2026-07-24，`事实`）：

- 「Opus tier 的台阶式提升」，接近更高档 **Fable 5**，价格大约一半。
- Frontier-Bench v0.1 超过其他模型，且相对 Opus 4.8 成本更低、分数更高。
- CursorBench 3.2 max effort 距 Fable 5 峰值 0.5% 以内。
- 强调长程 agent、自检、少 token 完成同样工作。

把「接近 Opus 4.6 非思考」直接说成「媲美 Opus 5」，跨了两代官方叙事（4.6 → 4.8 → 5）。`推断`

---

## 3. 社区真实使用（按渠道）

样本窗口：Harness 只公开约 48 小时。下面把 **模型单独塞进 Claude Code / Codex / OpenCode** 和 **官方 dsh + V4-Pro** 分开。

### 3.1 官方 dsh + V4-Pro（2026-08-13 之后）

**正面 / 期待**

- GitHub Discussions #18「观望」、# 若干「终于等到你」：情绪帖，不是对照实验。[discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)
- V2EX `tianyi`（像内部或近内部）：「现在的 0.1 版本还很不完善，恳请大家多提提意见。」[t/1234203](https://www.v2ex.com/t/1234203)
- `cobiao`：一切皆插件「明显就是为了以后 agent 自我进化在铺路。」同帖。

**产品形态，不是能力打平**

- `SiWXie`（V2EX，实测）：「测试了下，目前有些简陋，和 OpenCode、Coedx、Claude Code 还有 ZCode 比，**优势是很快**，但你说的模型应该和 Harness 一起训练想法挺好的。」[t/1234203](https://www.v2ex.com/t/1234203)
- `bluescorpio` 速查帖：对标 Claude Code / Codex，但重点是文档真空、必须选 workspace、别上生产。**零条能力对比回复。** [t/1234341](https://www.v2ex.com/t/1234341)
- Discussions #14：有人问怎么把 Codex / Claude Code 的 memory 迁过来（24 条评论）。迁移需求 ≠ 能力已超越。
- Discussions #1415（2026-08-14）：session resume 因 Cordis 进程级单例撞车，会话打不开。预览期工程债。
- HN dsh 专帖（710 分 / 292 评）几乎全在聊插件架构、Cordis、和 Pi 像不像。几乎没有「用 dsh+V4-Pro 做完一个仓库、打平 Opus 5」的报告。作者自己先降预期。

**媒体观察（二手，但引用了上线当天波动）**

21 财经（2026-08-14）记录（`事实`：记者转述社区；细节未逐条复现）：

- 上线数小时：本该长推理的 V4-Pro，思考经常不足十秒，长流程提前收尾，部分场景弱于 V4-Flash。
- 同一任务隔几小时重测，结果悬殊，怀疑服务端切配置/切版本。
- 白天首页公告撤回，晚间再官宣；官方未解释。
- 调价 8 月 17 日 0 点：高峰输出约 27 元/百万 tokens（约现行 4.5 倍），缓存命中约 12 倍。
- 分析：Flash 铺量、Pro 啃难题；AA 智能指数 Pro-0813 只比 Flash-0731 高约 1 分。

[https://m.21jingji.com/article/20260814/herald/634250531c1b2e66ffa4a17cf8efc120.html](https://m.21jingji.com/article/20260814/herald/634250531c1b2e66ffa4a17cf8efc120.html)

**Linux.do 一手横评（2026-08-14，用户贴出全文后补录）**

`SmallMain`，《记一次对 DeepSeek Harness 全模式、DeepSeek V4 Pro 0813、Grok 4.6、Qwen 3.8 Max 的真实项目需求的横向评测（专武？）》。同一 Unity C# 皮肤系统、同一预制体、模型只写代码；系列内环境与前两轮一致。思考档 Max，参数按官方评测。晚 19:50 后开跑，排除白天部署抖动。非专武对照走 Copilot。[linux.do/t/topic/2752669](https://linux.do/t/topic/2752669)

| 配置 | 耗时 | tokens / 花费 | 完成度（作者审查） |
| --- | ---: | --- | --- |
| Qwen 3.8 Max（官方 API） | 52 min | 25.1M / ¥49.51 | 一般，多个问题 → **Tier 2** |
| Grok 4.6 xhigh（Grok Build Super） | 16 min | 未给 | 较高，有常犯枚举转换错 → **Tier 1**（与 4.5 同档，因新模型+外榜更高而略前置） |
| DeepSeek V4 Pro（旧/非 0813，Copilot） | 21 min | 23M / ¥1.73 | 非常高、少量细节 → 总表里旧 Pro 仍标 **Tier 2 #25** |
| **V4-Pro-0813**（Copilot，非 dsh） | 25 min | （未单列，作者称完成度非常高） | 少量细节；**超过 Grok 4.6，与 Kimi K3 相当、更快** → **Tier 1 #4** |
| dsh **标准** + V4-Pro max | 24 min | 17M / ¥1.40 | 与非 dsh 0813 **相同**；快 4%、token −26%、成本 −20% |
| dsh **PTC** + V4-Pro max | 30 min | 37M / ¥2.34 | 完成度仍相同；慢 20%、token 翻倍；十余次生成代码异常（`stdout.slice is not a function`） |
| dsh **极简** + V4-Pro max（官方刷分模式） | 64 min **未完成** | 185M / ¥7.93 | 编译错误 + 核心功能问题；无压缩、只 bash+replace_str、狂猜路径 |
| Claude Opus 5 | 55 min | — | **Tier 0 #1**（与 Fable 5、GPT 5.6 Sol 并列「与线上基线高度一致」） |
| Kimi K3 | 93 min | — | **Tier 1 #4**（与 0813 同档） |
| Claude Opus 4.6 Max | 26 min | — | **Tier 1 #13**（低于 0813） |

作者原话（节选，`事实`）：

- 「在这个场景下，效果超过了 Grok 4.6 是毫无疑问的，与 Kimi K3 相当，但比它快多了。」
- 「当超过 10 倍的涨价幅度生效后，DeepSeek V4 Pro 0813 可能无法再成为 Kimi K3 / GPT 5.6 中低端版本的快速平替。」
- 极简模式：「这绝对不会是能让模型发挥最佳性能的模式。」「无法完成任务。」
- 专武总结：「意料之中的是它无法提升模型的最终效果，但它确实更适合 DeepSeek 模型。就如同 Codex 之于 GPT 5.6，Claude Code 之于 Opus 5。」
- 「DeepSeek Harness 现在并没有提供任何类似（Computer Use 扩边界）的优势。」
- 「好的模型它就是纯粹的好，差的模型你给它所谓的千里马专武，也无济于事。」

读法：`事实` 是作者这一次 Unity 任务的分层；`推断` 是「专武不改变智力上限」。与 V2EX `alanying`「Qwen3.8 > … > DSV4 Pro」**打架**——同一周、不同题、不同工具链。Linux.do 这篇把 Qwen 3.8 Max 判成「高分低能」Tier 2，把 0813 抬到和 K3 一档。单任务仍是 n=1，但题面固定、系列可对照，权重大于论坛口号。

知乎《DeepSeek Harness 安装，初体验，没有惊喜》搜索摘要称 dsh 比 Pi+Flash 多吃约 45 万 tokens。专栏 403，**未核原文**。`未知`  
[https://zhuanlan.zhihu.com/p/2071375794388186083](https://zhuanlan.zhihu.com/p/2071375794388186083)

**Linux.do「或许还有反转」（2026-08-15）+ 插件作者自己的冻结题**

主楼 `RanceX2023`（[topic/2756925](https://linux.do/t/topic/2756925)）的推测（`事实`：他这么写了；`推断`：对不对）：

> V4P 0813 是拥有灰度测试 API 的能力的，但是因为对提示词过拟合所以无法发挥出来。  
> 在 deepseek harness 极简模式能够触发真实性能，达到与官方跑分相近的效果。

主楼后半「以下非本人观点」整段抄的是社区插件作者口径，不是第二套独立实验。

插件 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（非官方，README 自陈）：

- 第一次请求：Minimal 对齐的完整 system prompt + 只有 shell/`read`（Win 上是 `pwsh/read`）。
- 会话出现首次持久 `tool/call` 后：放开 Standard 全部约 25 个工具。
- 自称动机：Pro「强烈依赖 API 中可见的工具目录选择执行轨迹」。

同一作者冻结套件 [xiaobright/modeltest](https://github.com/xiaobright/modeltest)（Project2 V4.1b，2026-07-23 冻结，**个人工程维护题：多模块 Python + ESP32，作者写明不是公开榜**）2026-08-14 报告数字（`事实`，单项目）：

| 配置 | 分数 |
| --- | ---: |
| DSH **minimal** + max（WSL，两跑） | 99 / 96 |
| **anchored-standard**（Windows，两跑） | 98 / 99 |
| DSH standard / PTC（同一 WSL） | 91 / 92 |
| 正式版 OpenCode 四跑 | 91 / 96 / 91 / 93（均 92.75） |
| V4 Flash → minimal | 风格大变，分仍是 **92** |
| 该套题上的 Opus 5 / Fable 5 / GPT-5.6 Sol | 97 / 98 / 99·98 |

作者自己划的边界（不要比主楼传得更满）：

- 「第一次看见什么工具」锁轨迹，**不是**全程只能用两个工具。
- 思维链里的 `We need` / `let me` 是轨迹指纹，**不是**能力证明，也不是「后端其实是 Claude」。
- **不支持**声称 98/99 会在其他仓库、任务长度或 provider 上稳定复现。
- 现有结果分不清：同一 checkpoint 的条件化行为 / 后训练策略分支 / 服务端内容路由。

官方源码对得上「训练接口对齐」（本地 checkout 已核）：

- `apps/web/tests/minimal-preset.snapshot.ts`：`sends the exact RL prompt and schemas`
- `apps/cli/tests/web-agent-presets.e2e.ts`：`composes the exact RL prompt and two tools from minimal`

同帖回复（2026-08-15，浏览器抽出）：

- `LIFE001400`：「对特定 prompt 过拟合我绷不住了」
- `listening`：「换下 prompt 就能流口水，这也太不稳定了吧」
- `refalogy`：「后训练难道不换 agent 的吗？这过拟合太严重了」
- `user1703`：不然 Pro 直接删了用 Flash
- `AndyYan123`：用了 Anchored Standard 测半天，OpenCode Go 和官方都一直是 `let me`，「画个鹈鹕都画不好，不知道是不是我脸黑」

和 SmallMain Unity 横评的冲突要保留，不要抹平：

| | Project2（像 RL：bash + editor + 一句 software engineer） | Unity 皮肤（预制体 + C# + 编译） |
| --- | --- | --- |
| dsh 极简 | 99/96 | **64 分钟失败** |
| dsh 标准 | 91 | 完成度与不用 dsh 相同 |
| 读法 | 训练接口附近能顶满 | 换题面极简反而最差 |

这不是「还有一个更强 0813 没放出来」。这是 **Pro 对第一眼看到的工具 schema 过拟合**：题长得像训练环境就接近该套题上的 Opus 5 分；题不像，专武也救不了，甚至极简会把任务做崩。

### 3.2 把 V4-Pro 塞进别人的 harness（4 月–8 月）——样本更多，结论更泼冷水

**明确不够打 Claude**

- V2EX `lyhiving`，2026-04-24，工具是 **Claude Code**，同一项目同一提示词：HTML→RN 迁移。  
  「Deepseek V4 pro 出品空白，gpt5.4 都比较正常，claude sonnet 4.5 都是最强展现。……前期问问题的时候就已经明显感觉 DS V4 PRO 走偏了……**不用开 OPUS，真的不够打。**」花了 29.49 元。  
  [https://www.v2ex.com/t/1208383](https://www.v2ex.com/t/1208383)

**0813 当天中文盲测：排在国产旗舰后面**

- V2EX `alanying`，2026-08-13：「我们部门内部盲测不如 GLM5.2」。楼主补充真实排序是 **Qwen3.8 > GLM5.2 > K3 > DSV4 Pro**，标题不敢写 Qwen 怕被喷。自己承认主观。  
  `isbase`：「据说模型上错了 再用目前的版本试试。」  
  `martinm`：「自用 K3 > GLM5.2 > DSV4 Pro。」  
  `Auston` 质疑测试能力。  
  [https://www.v2ex.com/t/1234188](https://www.v2ex.com/t/1234188)

**HN 0813（模型，多数走 OpenRouter + Codex，不是 dsh）**

- `simjnd`：Flash 0731 已经够用，对 Pro 正式版失望，不打算换。  
- `freakynit`：同一仓库任务（扫 repo 出 docker-compose + Caddy + 端口占用 + 外置 wildcard 证书 + 内置 postgres）。V4-Pro 有问题，`gpt-5.6-terra-high` 没有。「They are good till the project is simple... not anymore.」  
- `jklmnopqrstuvw`（Codex CLI，同一新功能）：DeepSeek 4 pro 12m02s / $0.12 / **有 bug**；Grok 4.6 3m18s / $1.41 / 无 bug。  
- `bigmadshoe` 正确提醒：n=1 是 vibes，不是科学。  
- `Gecko4072`：官方 API 烧钱快；Flash 0731 仍是近几个月最出色的。  

[https://news.ycombinator.com/item?id=49274600](https://news.ycombinator.com/item?id=49274600)

**Harness 错配会直接打崩分数**

- HN `gertlabs`（2026-04-26）：他们自定义 harness 里 Pro 的 agent 任务反而弱于 Flash，外加供应商不稳。「Failed requests are not counted against the model」。  
  [https://news.ycombinator.com/item?id=47915128](https://news.ycombinator.com/item?id=47915128)
- HN `sandGorgon`（2026-04-24）：「actually this is not the reason - **the harness is significantly better**. There is no comparable harness to Claude Code with skills, etc.」  
  [https://news.ycombinator.com/item?id=47885263](https://news.ycombinator.com/item?id=47885263)
- HN `bokkies`：换过 GLM / Qwen 一周，两天就回到 Claude Max。「The model is only half the story.」同帖。

**第三方客户端协议坑（不是模型变笨，是接不上）**

- Cherry Studio #14714：V4-pro + web search 打出原始 `<|DSML|>` token，单轮对话不可用。  
  [https://github.com/CherryHQ/cherry-studio/issues/14714](https://github.com/CherryHQ/cherry-studio/issues/14714)
- Reddit / GitHub 检索还出现 Copilot BYOK→OpenRouter 工具调用不稳定、Cline 仍用旧 endpoint 名。部分页面 403，只作线索。`未知/部分`

### 3.3 Twitter / X

`@deepseek_ai` 启动推文 ID 见检索（`2087887408440164663`）。本环境 X 拦截机器人，Nitter/xcancel 证书失败，**推文正文未读到**。`未知`

检索转述一条中文推（`@MinLiBuilds`）：「Model + Harness = Agent……模型如果达到 9 分，没有合适的 harness，Agent 得分可能少于 5 分。」未打开原推，不当作引文。`未知`

### 3.4 本轮仍读不到的源

| 源 | 原因 | 为何重要 |
| --- | --- | --- |
| 知乎初体验专栏 | 403 | 搜索摘要称 dsh token 更肥 |
| Reddit r/opencodeCLI、r/LocalLLaMA | 403 | 英文日常 coding 体感 |
| Artificial Analysis 对比页 | 404 / 超时 | 搜索摘要称 Opus 5 Adaptive Max 63 vs V4-Pro High 44，**未核页面** |
| Discord / 企微 / X 原文 | 未加入 / 机器人被挡 | dsh 官方反馈主场 |

---

## 4. 为什么传言听起来很真

1. **官方自己先把「接近 Opus」写进公告**  
   但宾语是 4.6 非思考，不是 5。口头传播时代数被丢掉。`事实` + `推断`

2. **分数是在自家极简 harness 上跑的；极简是 RL 对齐接口，不是「更短的标准模式」**  
   官方脚注 + 官方测试名 `exact RL prompt and schemas`。Linux.do Unity 题上这个模式失败；xiaobright 的 Project2 上这个模式 99/96。两种结果同时为真，说明极简分测的是「像不像训练接口」，不是「随便一个仓库的上限」。`事实`

3. **「专武会抬上限」在通用工程上被打脸，在 RL 题面上被插件钻空子**  
   SmallMain：标准/PTC 不改变 Unity 完成度。xiaobright：先露两工具再放开 25 工具，Project2 从 91 拉到 98/99。后者作者自己说不要外推。社区当场骂过拟合。`事实`

4. **「或许还有反转」把过拟合听成了「还藏着一个 Opus 5」**  
   主楼推测灰测能力被 prompt 锁住；能核验的只有「首轮工具目录锁轨迹」。没有证据显示 8 月 15 日服务端又切了更强权重。`推断`

5. **Flash 0731 的光环被借到 Pro + dsh 上**  
   多个 HN / 中文用户觉得 Flash 才是「这几个月最惊人的」；Pro 正式版相对失望。Flash 换极简只变文风、不变分（仍 92），Pro 换工具面就大变——特异性本身也说明 Pro 更脆。`事实` + `推断`

6. **两天 9 万 star + 「开源 Claude Code」标题**  
   V2EX / 视频 / 二次媒体用替代品叙事。Star 测的是好奇心和民族情感，不是 SWE Pro。`推断`

7. **价格叙事**（正在过期）  
   4 月 HN 有人算 Pro 比 Opus 4.7 输入便宜约 17×、输出约 50×。0813 同步宣布分时涨价（高峰输出约 4.5×、缓存命中约 12×）。便宜 ≠ 更聪明，而且马上没那么便宜。`事实`

8. **上线当天服务不稳被当成「模型很强但没调好」**  
   「模型上错了 / 思考不到十秒 / 隔几小时完全两样」让人觉得正式权重还没使出来。8 月 15 日的「反转」帖是同一心理的升级版：把条件化行为说成还没解锁的真身。运维事故 vs 后训练过拟合 vs 内容路由，未分开。`未知`

9. **选择偏差**  
   发帖的是试用党和榜单党。Project2 高分和 Unity 失败可以同时被转成「还有反转」或「就是不行」。`推断`

---

## 5. 裁决

| 说法 | 裁决 | 依据 |
| --- | --- | --- |
| V4-Pro 在部分算法/终端榜上超过或打平 Opus **4.6** | **属实（分数）** | HF 表；官方自测 |
| 0813 真实工程能到「能编译、少量细节」且超过旧 Pro / 部分同期国模 | **这篇 Unity 横评支持** | Linux.do：0813 与 K3 / Grok 4.6 同属 Tier 1；旧 Pro 在总表仍是 Tier 2 |
| 官方内部体感接近 Opus **4.6 非思考**、仍落后思考档 | **外部部分印证、部分打架** | 4 月公告；Linux.do 里 0813 排在 Opus 4.6 Max 之上、仍远低于 Opus 5 |
| dsh + V4-Pro 让真实工程能力 **媲美 Claude Opus 5** | **不成立** | Unity：Opus 5 = Tier 0，0813 = Tier 1，dsh 不提分；极简失败 |
| 在**某一套像 RL 接口的自测**上，极简/锚定可摸到该套题的 Opus 5 分带 | **作者自测成立，禁止外推** | Project2：minimal 99/96、anchored 98/99、Opus 5 = 97；作者写明不是公开榜、不保证换仓库 |
| 「0813 还会反转 / 灰测真身还没放出来」 | **未证实；更像过拟合** | 无新 checkpoint 证据；有首轮 schema 锁轨迹 + 官方 `exact RL prompt` 测试；同帖复现失败（鹈鹕 / `let me`） |
| 换对 harness 会比乱接工具更接近官方分 | **接近官方分 ≠ 更强的通用工程** | 官方分绑 RL 接口；Unity 上极简最差；Project2 上极简最好 |
| 这是「真能力」而不只是刷分 | **0813 有真提升，高分绑定训练接口** | Unity 上 0813 > 旧 Pro；顶分出现在 `exact RL prompt and schemas` 附近 |

**一句话给选型：**

- 要「日常写代码、能接受少量细节返工、涨价前图便宜」：SmallMain 把 **V4-Pro-0813** 和 Grok 4.6 并列首选；涨价后他改倾向 Grok，非 GPT/Claude 主力仍选 Kimi K3。
- 要「和线上基线高度一致、少返工」：Unity 题里是 **Opus 5 / Fable 5 / GPT 5.6 Sol**，0813 没进去。
- 不要把 Project2 的 98/99 当成「专武一开就是 Opus 5」。那是**长得像训练环境的题**。换题、换第一眼工具目录，分会掉，社区已经在骂过拟合。
- dsh 标准模式能省约两成钱、会按指令中途问人。极简模式是刷分/RL 对齐环境。`anchored-standard` 是社区钻空子，官方不背书；有人复现失败。

证伪「达不到 Opus 5」：需要在**结构不同的新仓库**上（不是 Project2，也最好不是又一道 Unity 皮肤）看到默认工具面的 0813+dsh 稳定进入「与线上基线高度一致」档。作者自己也说，下一发有价值的实验应是换仓库，不是再给 Project2 烧钱。
