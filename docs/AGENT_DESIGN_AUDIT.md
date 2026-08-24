# Agent 决策、效果评测与可观测性：当前实现审计

> 审计范围：`packages/server-node`，日期：2026-08-24。本文描述当前代码，不把建议方案写成已实现事实。

## 1. 结论摘要

当前 Node 实现已经形成以下主链：

```text
GameEngine 串行编排
  → buildAgentContext 投影当前 Agent 私有视图与公共视图
  → buildDescribePrompt / buildVotePrompt 注入 Persona 与身份目标
  → DeepSeekClient 调用、结构校验与 provider retry
  → DescriptionQualityGate 做提交前质量门禁
  → commitDescription 逐条公开
  → Trace / Evaluation 记录可回归证据
```

三个重要边界：

1. 描述是串行生成、逐条提交的，所以后发 Agent 会在构建上下文时看到同轮前面已提交的描述。
2. `AgentContext` 只包含当前 Agent 的 `role/word`；其他玩家只暴露公开姓名、存活状态、公开描述和公开淘汰信息。
3. 描述质量失败会定向重试；预算耗尽后抛错并保持在 `describing`，不会把失败文本提交，也没有“自动编一条降级描述”。

需要明确的现状缺口：

- `descriptionHomogeneity`、延迟、成本等目前是报告指标，不是硬门禁。
- bigram Dice 只能识别近似措辞，不能识别语义改写。
- Runtime trace 的模型调用不记录 Key、完整 Prompt、原始响应或评测固定词；运行生命周期 metadata 也只保留定位与场景字段。
- `PromptProvenanceTraceEvent.role` 会记录当前 Agent 的身份。它不进入玩家公开 DTO，但若要求 Admin trace 也完全不保存身份，仍需进一步收紧。

## 2. 任务线①：Agent 决策与编排

### 2.1 涉及的关键文件与函数

| 文件 | 函数/类型 | 职责 |
| --- | --- | --- |
| `server/core/types.ts` | `AgentContext` | 定义模型可见的数据边界：当前 Agent 私有身份/词 + 公共对局视图。 |
| `server/core/agent-context.ts` | `buildAgentContext()` | 从完整 `GameState` 显式投影隔离上下文，不透传其他 `Player` 的 `role/word`。 |
| `server/core/game-engine.ts` | `generateDescriptions()` | 串行生成四个 AI 描述；每个 Agent 调用前重新构建上下文。 |
| 同上 | `commitDescription()` | 质量通过后立即写入 `game.descriptions/events`，并发出 `description_published`。 |
| 同上 | `pendingDescriptionAgents()` | 恢复时只选择本轮尚未成功提交描述的 AI。 |
| 同上 | `generateVotes()` | 投票阶段用隔离上下文并行生成私有候选票。 |
| `server/core/agent-strategy.ts` | `STRATEGIES` | 谨慎、直觉、逻辑、出其不意四套观察、表达、投票和质量预算。 |
| 同上 | `buildRoleObjective()` | 把“平民/卧底如何赢”与 Persona 风格分开。 |
| 同上 | `getAgentStrategy()` | 通过 allowlist 的 `strategyId` 取策略。 |
| `server/core/prompt.ts` | `buildDescribePrompt()` | 把 role objective、Persona、公开上下文、修复提示组合成描述 Prompt。 |
| 同上 | `buildVotePrompt()` | 把 Persona 投票倾向、公开上下文和合法候选人组合成投票 Prompt。 |
| `server/core/model.ts` | `DeepSeekClient.describe()/vote()` | 调用模型并用 Zod 校验结构化输出。 |
| `server/support/test-utils.ts` | `FakeGameModel.describe()/vote()` | 用确定性输出证明 `strategyId` 已进入实际行为链，而不只是静态字段。 |
| `server/persona/persona-probe.ts` | `runProbe()` 相关流程 | 在相同局面下探测四 Persona 的真实模型表现。 |

### 2.2 取舍一：后发 Agent 看到前序公开描述，但看不到其他秘密

问题：如果四个 AI 用 `Promise.all` 同时生成，它们会拿到同一份旧状态；如果直接把 `GameState` 传给模型，又会暴露所有人的身份和词。

当前做法：

1. `GameEngine.generateDescriptions()` 使用 `for...of` 串行生成。
2. 每次循环开始调用 `buildAgentContext(game, agent)`。
3. 当前描述通过质量门禁后，先调用 `commitDescription()`，再进入下一次循环。
4. `buildAgentContext()` 将当前已提交的 `game.descriptions` 映射为 `publicDescriptions`。
5. 当前 Agent 的 `role/word` 只放在 `identity`；其他玩家只映射 `id/name`。

放弃的方案：

- 放弃四个描述并行生成，因为后发者无法利用逐步公开信息。
- 放弃把完整 `GameState` 或 `Player[]` 交给模型，因为“之后再提醒模型不要看”不构成隔离。
- 放弃从完整对象做宽松序列化，改为字段 allowlist 投影，让类型和构造函数共同守边界。

为什么：串行会增加总描述延迟，但换来了正确的信息时序；显式投影会增加少量维护成本，但泄密风险可由序列化测试直接验证。

对应证据：

- `server/core/agent-context.test.ts`：公开描述存在；序列化上下文不含其他玩家词和卧底身份。
- `server/core/game-engine.test.ts`：四个 AI 上下文中，同轮前序 AI 描述数量依次为 `[0, 1, 2, 3]`。
- `server/app.test.ts`：逐条提交期间 GET/SSE 只暴露公开字段。

### 2.3 取舍二：四个 Persona 在相同局面下产生差异

问题：只在玩家资料里保存“谨慎观察/直觉敏锐/逻辑派/出其不意”名称，不会自动改变模型行为。

当前做法：

- 每个 AI profile 绑定稳定 `strategyId`。
- `STRATEGIES` 集中声明：
  - `personalityAnchor`
  - `riskTolerance`
  - `observationLens`
  - `describe`
  - `vote`
  - `speechStyle`
  - `keyPrinciple`
  - `qualityPolicy`
- `buildRoleObjective()` 只负责阵营目标；Persona 只决定如何观察、说多少、怎么表达、怎么投。
- `buildDescribePrompt()/buildVotePrompt()` 把具体策略字段写入 Prompt，而不是只写 Persona 名称。
- `FakeGameModel` 也按同一 `strategyId` 产生确定性差异，便于回归。

四类当前倾向：

| Persona | 风险预算 | 描述倾向 | 投票倾向 |
| --- | --- | --- | --- |
| 谨慎 | LOW | 宽泛、克制、核对前后矛盾 | 不轻易跟票，重视可核对矛盾 |
| 直觉 | MEDIUM_LOW | 生活画面、感官与自然度 | 关注表达是否自然、是否迎合 |
| 逻辑 | MEDIUM_HIGH | 类别/用途/条件中的一个关系 | 关注逻辑兼容性与证据链 |
| 出其不意 | HIGH | 安全上限内找非主流角度 | 检查机械跟票和热门怀疑是否充分 |

放弃的方案：

- 放弃只拼一个 `style` 字符串，因为无法约束信息预算、投票视角和重试政策。
- 放弃在 `GameEngine` 里按玩家名字写分支，因为策略会与编排耦合，难扩展也难测。
- 放弃让 Persona 覆盖安全策略；安全门禁对四个角色完全一致。

为什么：注册表让 Prompt、FakeModel、质量预算和评测都用同一个稳定 ID，同时保留服务端统一安全上限。

证据与限制：

- `server/core/agent-strategy.test.ts`：策略注册、role objective 与 Persona 分离。
- `server/persona/persona-distinguishability.test.ts`：相同局面下 Prompt 策略与行为字段可区分。
- `npm run persona-probe --workspace packages/server-node`：真实 provider 探针。
- FakeModel 证明接线和确定性差异，不等价于证明真实模型长期稳定可区分。

### 2.4 取舍三：雷同或泄题如何判断，之后如何处理

关键文件：

| 文件 | 函数 | 职责 |
| --- | --- | --- |
| `server/core/description-quality.ts` | `DescriptionQualityGate.check()` | 按顺序执行空值、长度、泄密、雷同规则，返回首个 violation。 |
| 同上 | `containsSecretLeak()` | 检查完整题目词；默认策略还检查当前 Agent 词中的汉字。 |
| 同上 | `descriptionSimilarity()` | 规范化后计算字符 bigram Dice。 |
| 同上 | `repairGuidance()` | 将 violation 转为下一次模型调用的定向修复提示。 |
| `server/core/game-engine.ts` | `generateDescriptions()` | 执行质量重试预算，耗尽则抛 `DescriptionQualityError`。 |
| `server/core/agent-strategy.ts` | `qualityPolicy` | 谨慎/直觉/逻辑最多 2 次；出其不意最多 3 次；雷同阈值均为 0.72。 |

判定顺序：

1. 规范化后为空：`empty`。
2. 长度不在 2–60 字符：`invalid_length`。
3. 包含完整题目词，或默认策略下包含自己词中的任一汉字：`secret_leak`。
4. 与同轮任一已接受描述的 bigram Dice 相似度 `>= 0.72`：`duplicate_description`。

Dice 公式：

```text
similarity = 2 × |bigrams(A) ∩ bigrams(B)|
             / (|bigrams(A)| + |bigrams(B)|)
```

处理方式：

- 首次失败：记录 typed quality event，并把 violation 和 guidance 放入下一次 Prompt。
- 仍有预算：只重试当前 Agent。
- 预算耗尽：抛错，不调用 `commitDescription()`，对局保持 `describing`。
- 操作员可通过 `resumeDescription()` 从第一个缺失 Agent 继续；已成功提交的 Agent 不重跑。
- 当前没有“自动降级为本地安全描述”的路径。这是主动放弃的方案，因为自动填充内容会伪造 Agent 行为，也可能绕开相同质量政策。

阈值说明：

- `0.72` 是工程启发式，不是从统计显著性或 ROC 曲线推导的最优阈值。
- 当前测试固定了边界行为，用于拦截近似复述并允许不同措辞角度。
- 字符 bigram 对中文近似措辞简单、确定、无外部模型依赖，但抓不到语义相同而字面不同的改写。
- 真实模型或题库变化后，应使用标注样本重新校准，而不是宣称 0.72 普适。

对应测试：`server/core/description-quality.test.ts`、`server/core/prompt-policy.test.ts`、`server/core/game-engine.test.ts`、`server/core/description-resume.test.ts`。

## 3. 任务线②：效果评测

### 3.1 涉及文件与入口

| 文件 | 函数/入口 | 职责 |
| --- | --- | --- |
| `server/evaluation/evaluation.ts` | `runEvaluation()` | 用可注入 seed 跑 N 局、采集指标并计算 Engineering Gate。 |
| 同上 | `InstrumentedModel` | 包装任意 `GameModel`，统计调用、有效投票、错误和逻辑调用延迟。 |
| 同上 | `driveGame()` | 用确定性人类描述/投票推进完整对局。 |
| 同上 | `descriptionPairSimilarities()` | 计算同轮 AI 描述的两两同质化。 |
| 同上 | `countSecretLeaks()/countPublicStateLeaks()` | 检查已提交密词与终局前公共 DTO 泄漏。 |
| 同上 | `mulberry32()` | 将整数 seed 转成可复现随机源。 |
| `server/evaluation/eval-cli.ts` | `main()/parseArguments()/printHumanTable()` | 提供 `--games/--seed/--model` 命令；Gate 失败时非 0 退出。 |
| `server/evaluation/usage-metrics.ts` | `createUsageAccumulator()` | 聚合 provider token usage 和成本。 |
| `server/admin/evaluation-routes.ts` | Admin Evaluation routes | 复用同一 `runEvaluation()`，没有第二套评测引擎。 |
| `server/evaluation/evaluation.test.ts` | 评测回归 | 验证 seed 可复现、硬门禁失败、策略聚合、paired cases、usage/cost。 |
| `docs/EVALUATION.md` | 评测说明 | 记录基线、命令、门禁理由和指标局限。 |

复现命令：

```bash
npm run eval:node -- --games 20 --seed 42 --model fake
```

`fake` 默认不消耗外部额度；`real` 需要本地 provider 配置，结果受模型和网络波动影响。

### 3.2 每个指标如何计算

| 指标 | 当前公式/口径 | 是否硬门禁 |
| --- | --- | --- |
| `completionRate` | 完局数 / 启动局数 | 是，必须等于 1 |
| `descriptionAttempts` | `InstrumentedModel.describe()` 的逻辑调用次数 | 否 |
| `secretLeakRejectRate` | `secret_leak` quality events / 描述逻辑调用次数 | 否 |
| `duplicateRejectRate` | `duplicate_description` events / 描述逻辑调用次数 | 否 |
| `invalidOutputRate` | 无效输出或模型异常数 / 描述+投票+复盘逻辑调用次数 | 否 |
| `validVoteRate` | 目标在 `allowedTargets` 中的票 / 投票逻辑调用次数 | 是，必须等于 1 |
| `retryRate` | `willRetry=true` 的 quality events / 描述逻辑调用次数 | 否 |
| `latencyMs.p50/p95` | 所有被包装逻辑模型调用耗时的 nearest-rank 分位数 | 否 |
| `tokenUsage` | provider usage 的 prompt/output/total/cache hit/cache miss 累加 | 否 |
| `cost.totalUsd` | 各请求缓存命中输入、未命中输入、输出 token 分别按价求和 | 否 |
| `cost.perGameUsd` | 总成本 / 配置局数 | 否 |
| `byStrategyId.winRate` | 该策略获胜 seat 数 / 该策略参与 seat 数 | 否 |
| `byStrategyId.voteAccuracy` | 投中卧底的票 / 该策略全部票 | 否 |
| `descriptionHomogeneity` | 每轮 AI 描述所有无序两两 bigram Dice 的总平均 | 否 |
| `humanInputResponsiveness` | paired Normal/Nonsense case 的人类收票变化与理由关键词命中 | 否 |
| `safety.secretLeakOccurrences` | 已提交描述中包含任一完整题目词的条数 | 是，必须为 0 |
| `safety.publicStateLeakOccurrences` | 终局前 PublicPlayer 出现 role/word/revealedRole/revealedWord 的字段数 | 是，必须为 0 |
| `safety.illegalStateOccurrences` | 未完局、无 winner 或驱动异常的局数 | 是，必须为 0 |

所有 ratio 和 average 保留四位小数；分母为 0 时返回 0。延迟使用 nearest-rank，FakeModel 延迟只用于管线回归，不代表线上延迟。

### 3.3 阈值为什么是这些数

当前硬门禁只覆盖可确定判断的正确性：

- 完局率必须 100%。
- 有效投票率必须 100%。
- 已提交完整密词泄漏必须为 0。
- 终局前公共 DTO 密态字段必须为 0。
- 非法或半完成状态必须为 0。

原因：FakeModel、seed 和引擎随机源都可控制，这些指标不存在必须容忍的随机误差；放宽阈值等于接受确定性回归。

当前没有给同质化、延迟、成本、拒绝率设置硬阈值，原因也写在 `docs/EVALUATION.md`：

- 样本量和真实 provider 行为仍有波动。
- 同质化只是字符代理，不足以单独判定语义质量。
- 延迟受网络和 provider 影响。
- 成本取决于模型、缓存和价格时段。
- 应先积累固定标注样本和真实运行分布，再设门禁。

也就是说，验收要求中的“至少一个非 0 门禁”已经满足，但不是所有质量指标都有阈值。

## 4. 任务线③：可观测性与故障恢复

### 4.1 涉及文件与函数

| 文件 | 函数/类型 | 职责 |
| --- | --- | --- |
| `server/core/model.ts` | `withRetry()` | 将错误归一化并执行有界自动重试。 |
| 同上 | `normalizeModelDiagnostic()` | 分类 timeout、429、5xx、非重试 HTTP、坏 JSON、schema、network 等。 |
| 同上 | `traceModelCall()` | 记录局、轮、阶段、Agent、任务、attempt、错误类型、HTTP、延迟、是否重试、结果。 |
| 同上 | `traceProvenance()` | 记录 Prompt 版本、hash、公开描述计数和策略元数据，不记录完整 Prompt。 |
| `server/core/prompt.ts` | `sanitizePromptForDebug()` | 对显式 Prompt debug 副本做密词脱敏。 |
| `server/trace/trace.ts` | Trace event interfaces | 定义 model/public/recovery/prompt/quality/vote/run 七类结构化事件。 |
| 同上 | `InMemoryTraceSink/JsonlTraceSink/PersistentJsonlTraceSink` | 内存、JSONL 和可回读持久化 sink。 |
| 同上 | `stampTraceOrigin()` | 给事件统一补 source/entrypoint/modelKind/runId。 |
| 同上 | `replayTrace()` | 按 sequence 回放关键决策和失败/恢复路径。 |
| `server/trace/replay-cli.ts` | CLI | 从 trace 文件回放指定对局。 |
| `server/core/game-engine.ts` | `resumeDescription()` | 从缺失 Agent 继续，保留已提交描述并限制手动恢复预算。 |
| 同上 | `generateVotes()/consumePendingAiVotes()` | AI votes 先私有整批生成；任一个失败则整批不提交。 |
| 同上 | `createReview()` | provider 复盘失败后生成本地终局复盘。 |
| `server/fault/fault-injection.ts` | `FaultInjectingModel/scenarioFaults()` | 按任务、Agent、轮次和 attempt 注入指定故障。 |
| `server/fault/fault-demo.ts` | `FaultDemoService` 相关流程 | 驱动确定性故障演示与恢复。 |
| `server/fault/fault-demo-cli.ts` | CLI | 命令行演示 fault 场景。 |
| `server/admin/fault-routes.ts` | Admin routes | 暴露故障启动、查看和恢复接口。 |
| `server/admin/trace-routes.ts` | Admin routes | 提供运行列表、事件、Prompt debug 与 replay 查询。 |

### 4.2 模型重试与状态保护

真实 provider 路径：

- network/timeout：最多 4 次。
- 其他 retryable 错误（429、5xx、坏 JSON、schema）：最多 2 次。
- 401/403 等非重试 HTTP：立即失败。
- 每次失败记录 `attempt/errorType/httpStatus/willRetry/latencyMs`。

描述失败：

- 已通过的描述已经逐条提交并保留。
- 失败 Agent 的文本没有提交。
- phase 保持 `describing`，不能错误进入 voting。
- `resumeDescription()` 从第一个缺失 Agent 继续，手动预算为 2。
- 同一局只允许一个 active generation/resume，冲突返回 409。

投票失败：

- 四个 AI vote 用 `Promise.all` 生成私有候选。
- 在整批成功前不写 `game.votes`。
- 任一失败时整批 promise 失败并丢弃，避免半批票进入结算。
- ballot/round/eligibleTargetIds 不匹配时不消费过期预取结果。

复盘失败：

- 对局已经结束，`createReview()` 捕获 provider 失败并返回本地 fallback。
- trace 记录 outcome=`fallback`。

### 4.3 Trace 记录哪些字段

公共公共字段：`timestamp`、`sequence`、`gameId`、`round`，以及可选的 `sourceType/entrypoint/modelKind/runId`。

事件族：

- `model_call`：phase、ballot、task、agentId/name、strategyId、attempt、errorType、httpStatus、latencyMs、willRetry、outcome、注入故障元数据。
- `public_event`：phase、ballot、publicEventType、agentId/name、outcome。
- `recovery_action`：missing Agent、manualResumeIndex、remaining、recovered/exhausted。
- `prompt_provenance`：task、agentId、role、strategyId、Prompt version/hash、model、temperature、公开描述总数/同轮数、策略 guidance、repair violation。
- `quality_violation`：Agent、strategy、attempt、violationType、similarity、willRetry。
- `vote`：voter、target、经过密词替换的公开 reason。
- `trace_run`：run source/status/model/scenario/target/fault/outcome/entrypoint；不保存密词或完整 Prompt。

### 4.4 如何避免 Key、Prompt 和密词进入日志

已经实现的保护：

1. API Key 只在 `chatJson()` 内组装到 Authorization header。
2. `modelDebug()` 只输出 scope/task/attempt/errorType/httpStatus/willRetry/causeCode，不输出异常对象、请求头或 response body。
3. `traceModelCall()` 不接收或保存 context、headers、完整 Prompt、原始 provider response。
4. `traceProvenance()` 保存 Prompt hash 和版本，不保存完整 Prompt。
5. vote reason 在 `recordVoteTrace()` 前经过 `redactSecretWords()`。
6. Prompt debug 默认不开启；开启时 `sanitizePromptForDebug()` 会递归替换 secretWords，并强制将 `identity.word` 设为 `<REDACTED>`。
7. replay 忽略 Prompt provenance，不回显完整 Prompt。

当前不能宣称完全保证的地方：

- `PromptProvenanceTraceEvent.role` 保存当前 Agent 身份；这不是 API Key 或密词，但仍属于仅限管理员访问的私有诊断数据。
- Trace sink 本身不做最终统一 sanitizer；安全依赖事件 schema 与各 producer 的字段白名单。新增事件生产者时必须专项审查并做 secret scan。
- `sanitizePromptForDebug()` 当前会在所有字符串字段中做密词子串替换，并强制覆盖 `identity.word`；但未来新增非字符串载荷或新的秘密类型时仍需同步审查。

因此，若要求 Admin trace 也完全不保存身份，下一步应移除或哈希 `role`，并考虑在 sink 边界增加统一 schema/secret sanitizer；这属于后续语义改动，不在本次注释任务中冒充已完成。

### 4.5 故障演示与回放命令

```bash
npm run fault-demo -- --scenario describe-timeout
npm run fault-demo -- --scenario describe-bad-json
npm run fault-demo -- --scenario describe-final-failure
npm run fault-demo -- --scenario vote-rate-limit
npm run fault-demo -- --scenario vote-final-failure
npm run fault-demo -- --scenario review-failure

npm run replay -- --file <trace.jsonl> --game <game-id>
```

场景定义以 `scenarioFaults()` 的当前 allowlist 为准。

对应测试：

- `server/core/model.test.ts`：错误分类、自动重试、usage。
- `server/fault/fault-injection.test.ts`：timeout/bad JSON/限流/单 Agent 最终失败和半状态保护。
- `server/core/description-resume.test.ts`：恢复点、预算和并发冲突。
- `server/fault/fault-demo.test.ts`：Admin Fault Demo 两阶段行为。
- `server/trace/trace-lite.test.ts`：trace/replay 脱敏与结构。
- `server/app.test.ts`：公开 API/SSE 不泄漏私有字段。

## 5. 中文注释落点

本次按面试讲解深度，为以下关键文件补充函数级中文 TSDoc 和必要的行内注释：

- `server/core/agent-context.ts`：隔离边界与逐步公开来源。
- `server/core/types.ts`：私有/公开视图的类型边界。
- `server/core/game-engine.ts`：串行原因、质量重试、提交顺序。
- `server/core/agent-strategy.ts`：策略注册表与 0.72 的启发式属性。
- `server/core/description-quality.ts`：规则短路顺序与 bigram Dice 局限。
- `server/core/prompt.ts`：隔离上下文序列化与 Prompt debug 脱敏。
- `server/core/model.ts`：Prompt provenance、Key 使用和 model trace 字段边界。
- `server/evaluation/evaluation.ts`：比率、同质化样本范围和分位数口径。
- `server/evaluation/usage-metrics.ts`：成本公式。

- `server/trace/trace.ts`：来源盖章、生命周期、Admin 持久化、回放和容错读取。
- `server/fault/fault-injection.ts`：精确故障匹配、两次尝试、模拟 trace 与场景 allowlist。
- `server/fault/fault-demo.ts`：故障启动、第二阶段恢复和事件驱动时间线。

## 6. 验证清单

由于注释触及 `AgentContext`、`GameEngine` 和模型调用附近，按仓库规则应执行：

```bash
npm test --workspace packages/server-node -- --run \
  server/core/agent-context.test.ts \
  server/core/game-engine.test.ts \
  server/core/agent-strategy.test.ts \
  server/persona/persona-distinguishability.test.ts \
  server/core/description-quality.test.ts \
  server/core/prompt-policy.test.ts \
  server/core/model.test.ts \
  server/fault/fault-injection.test.ts \
  server/core/description-resume.test.ts \
  server/evaluation/evaluation.test.ts \
  server/evaluation/usage-metrics.test.ts

npm run test:node
npm run contract:node
git diff --check
```

最终结果应以 `DECISIONS.md` 本次里程碑追加的真实命令和输出为准。
