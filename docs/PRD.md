# AI 谁是卧底 · Admin Lite PRD

版本：v1.1
定位：基于现有「AI 谁是卧底」游戏，做一个可演示的 Multi-Agent 工程闭环：Persona、Evaluation、Trace、Fault Recovery。

原则：

> 运行简单，结果清楚，证据可查；不建设通用平台。

---

## 1. 项目要回答的问题

1. 四个 AI Agent 是否真的有不同策略？
2. 当前版本表现如何，和历史版本相比有什么变化？
3. 一次模型失败能不能被定位、解释和恢复？
4. 面试官能不能快速看懂证据链？

---

## 2. P0 硬约束

### 游戏规则

- 固定 `1 Human + 4 AI`。
- 淘汰、平票、胜负、合法投票目标全部由服务端决定。
- 模型只负责 `Describe` / `Vote` / `Review`。

### 信息隔离

终局前 `players[]` 不能出现：

```text
role
word
revealedRole
revealedWord
```

Human 只能看到自己的：

```text
playerId
role
word
```

### Contract

所有新增功能必须保持：

```text
npm run contract:node
```

通过。

---

## 3. 明确不做

不做：

```text
通用 LLMOps 平台
Dataset / Case / Bad Case 管理平台
Experiment Platform
Report Management Platform
多模型竞技平台
任意 A/B Compare Builder
RBAC
分布式 Trace
数据仓库
自由组合 Fault Workflow
为了架构漂亮重写 GameEngine
```

如果一个功能只是因为“平台看起来应该有”，默认不做。

---

## 4. Admin Lite

入口：`/admin`

页面：

```text
Admin Lite
├── Trace
├── Evaluation
├── Agent Lab
└── Fault Lab
```

前端结构：

```text
packages/web/src/admin/
├── AdminConsole.tsx
├── shared/
├── trace/
├── evaluation/
├── agent/
└── fault/
```

要求：

- `AdminConsole.tsx` 只做 shell / navigation / render page。
- API、types、transform、UI 不混在超长文件里。
- 不引入新 router、状态管理库、design system。
- 不为了行数机械重构。

后端原则：

```text
Core Runtime → Thin Admin API → Admin UI
```

Admin 不重新实现：

```text
GameEngine
Evaluation Harness
Trace Collector
Agent Strategy
Fault Logic
```

---

## 5. Trace MVP

Trace 是底层证据系统。

页面：

```text
Trace
├── Run Explorer
├── Timeline
└── Inspector
```

Run Explorer 支持：

```text
runId / gameId / round / agent / task / error / model / source
```

Timeline 展示：

```text
Round → Human / AI → Prompt / Model Call / Quality / Retry / Recovery / Vote / Public Event
```

Inspector 展示：

```text
Run ID / Game ID / Round / Agent / Task / Attempt
Timestamp / Model / Latency
Prompt Version / Sanitized Prompt / Public Context
Output / Error Type / Retry / Recovery
```

不存在字段显示 `—`，不要制造假数据。

Trace 安全：

- 不保存 API Key / Authorization。
- 不保存其他玩家完整 secret。
- 不保存隐藏 role。
- 不保存完整内部 GameState。
- 不保存未脱敏 prompt。
- 不保存 Chain-of-Thought。

统一定位字段：

```text
runId → gameId → round → agentId → task → attempt
```

---

## 6. Evaluation MVP

### 6.1 目标

Evaluation 只回答：

1. 当前版本的 Agent 和游戏流程表现怎么样？
2. 相比过去版本，效果发生了什么变化？

原则：

> 运行简单，结果清楚。

不建设通用 Evaluation Platform。

---

### 6.2 页面结构

```text
Evaluation
├── Run Evaluation
├── Report Detail
└── Report History
```

不要新增：

```text
Dataset Explorer
Case Explorer
Metrics Explorer
Experiment Platform
Bad Case Platform
Report Management Platform
```

---

### 6.3 固定 Case

第一版只使用 2 个固定 Case。

#### Case 1: Normal Human Input

```text
词对：雨伞 / 雨衣
Human：雨衣
Human 描述：可以防止身体被淋湿。
```

#### Case 2: Nonsense Human Input

和 Case 1 条件相同，只修改 Human 描述：

```text
一一二二，哈哈嘿嘿。
```

用途：观察 AI 是否真正关注 Human 的公开输入。

---

### 6.4 Runner

只保留：

```text
Model
○ Fake
○ DeepSeek

Cases
☑ Normal Human Input
☑ Nonsense Human Input

AI Judge
☑ Enabled

[ Start Evaluation ]
```

默认两个 Case 都运行，允许取消其中一个。

第一版不提供：

```text
Games 数量配置
Seed 配置
自定义词对
自定义角色
自定义 Human 输入
Judge Model 配置
Rubric 编辑器
```

---

### 6.5 运行状态

点击 `Start Evaluation` 后立即显示：

```text
RUNNING
Case 1 / 2
Normal Human Input
Current Stage: AI3 · Description
Elapsed: 00:28
```

完成后显示：

```text
Evaluation Completed
[ View Report ]
```

用户必须知道是否开始、当前到哪、是否结束。

---

### 6.6 实现约束

非常重要：

> 不要重新开发第二套 Evaluation Engine。

实现前必须先审计：

```text
packages/server-node/server/evaluation/evaluation.ts
packages/server-node/server/evaluation/eval-cli.ts
```

以及相关 metric / trace 能力。

原则：

```text
已有可靠能力 → 直接复用
已有能力但接口不适合 Admin → 增加薄 Adapter
确实不存在的能力 → 才新增
```

禁止为了 Admin 页面重新实现：

```text
Game runner
Completion 统计
Vote 统计
Homogeneity 算法
Latency 统计
Token / Cost 统计
Retry 统计
Trace
```

新增 Evaluation 后端代码必须说明：

```text
现有实现为什么不能直接复用？
```

---

### 6.7 Report Detail

第一屏：

```text
PASS / WARN / FAIL
Model
Cases
Duration
Judge: Available / Unavailable
```

下面只分四块。

#### Reliability & Safety

展示确定性指标：

```text
Completion Rate
Valid Vote Rate
Invalid Output
Secret Leak
Public State Leak
Retry
```

格式：

```text
真实值 + PASS / WARN / FAIL
```

不强行转成 0–10 分。

#### Agent Behavior

AI Judge 负责代码难以直接判断的行为质量指标。

最终保留 5 个维度，每项 0–10 分：

```text
Persona Adherence          25%
Semantic Diversity         20%
Context Utilization        20%
Human Input Responsiveness 20%
Exposure Control           15%
```

说明：

- `Persona Adherence`：分别给四个 Persona 打分，并汇总一个该维度总分。
- `Semantic Diversity`：评价语义层面的差异；已有 bigram Dice 继续作为代码层面的 lexical homogeneity 指标，不要说成 semantic similarity。
- `Context Utilization`：评价后发 AI 是否真正利用前发 AI 的公开描述。
- `Human Input Responsiveness`：比较 Normal / Nonsense 两个固定 Case，评价 AI 是否真正关注并响应 Human 输入变化。
- `Exposure Control`：评价没有直接泄词时，描述是否仍然过度具体、接近泄题。

两个固定 Case 都跑完后，整个 Evaluation 只调用 AI Judge 一次。

如果只跑一个 Case，`Human Input Responsiveness` 显示：

```text
Not Available
Requires both canonical cases.
```

AI Behavior 总分由代码计算，不由 Judge 直接给总分：

```text
AI Behavior Score =
Persona × 25%
+ Semantic Diversity × 20%
+ Context Utilization × 20%
+ Human Input Responsiveness × 20%
+ Exposure Control × 15%
```

#### Efficiency

展示已有能力能提供的：

```text
P50 Latency
P95 Latency
Tokens
Tokens / Game
Cost
Cost / Game
```

没有数据就显示：

```text
Unavailable
```

不能用 `0` 代表没采集到。

---

### 6.8 AI Judge

Judge 是辅助评价者，不是 Engineering Gate。

两个固定 Case 都跑完后，整个 Evaluation 只调用 AI Judge 一次；失败最多 retry 1 次，仍失败则标记：

```text
AI Judge: Unavailable
```

确定性指标继续有效。

> Judge Failure ≠ Evaluation Failure。

Judge Prompt 由：

```text
Judge Role
Rubric
Judge Good/Bad Examples
Current Evaluation Cases
Agent Outputs
```

组成。

`Judge Good/Bad Examples` 只是人工维护的 few-shot 示例，写进 Judge Prompt；可以放在 `judge-examples.ts`，但不做 Dataset 页面或管理系统。

Judge 只输出：

```text
各维度原始分数
简短 reason / evidence
主要 issues
summary
```

建议输出结构：

```json
{
  "personaAdherence": {
    "score": 8.0,
    "agents": {
      "cautious": 8.6,
      "intuitive": 8.1,
      "analytical": 8.8,
      "contrarian": 6.5
    }
  },
  "semanticDiversity": { "score": 7.8, "reason": "..." },
  "contextUtilization": { "score": 7.2, "reason": "...", "evidence": "..." },
  "humanInputResponsiveness": { "score": 8.5, "reason": "..." },
  "exposureControl": { "score": 9.0, "reason": "..." },
  "issues": [],
  "summary": "..."
}
```

Judge 不输出最终综合总分；AI Behavior Score 由代码按权重计算。

---

### 6.9 Problems

Report 最多展示 3–5 个主要问题。

示例：

```text
1. 出其不意 Persona 表现较弱
2. Nonsense Case 中只有 1/4 AI 意识到 Human 输入异常
3. P95 Latency 较高
```

有 Evidence 显示一小段 Evidence。

能关联 Trace 的问题提供 `View Trace`。

不做 Bad Case Explorer。

---

### 6.10 Report History

简单历史列表：

```text
Baseline
M1
M2
M3
M4
M5
M6
Latest Run
```

每条只显示摘要：

```text
Model
Completion
Homogeneity
P95
Commit
[ View Report ] [ GitHub ]
```

历史 Report 使用已有证据，不重新运行 Baseline 到 M6。

历史版本没有的新指标显示：

```text
Not measured
```

不要补算，不要伪造。

如需对比，第一版只保留固定：

```text
Baseline → M6
```

不做任意 A/B Compare Builder。

---

### 6.11 Hard Gate

保持确定性工程门禁：

```text
Secret Leak > 0        → FAIL
Public State Leak > 0  → FAIL
Illegal State > 0      → FAIL
Fake Completion < 100% → FAIL
Fake Valid Vote < 100% → FAIL
```

Report 顶部只显示：

```text
PASS / WARN / FAIL
```

不要设计人为综合 `8.2 / 10` 总分。

---

### 6.12 Evaluation 验收标准

第一版只需证明：

```text
① 可以选择 Fake / DeepSeek
② 可以运行两个固定 Case
③ 可以看到明确运行进度
④ 可以生成一份 Report
⑤ Report 包含 Reliability / Safety / Agent Behavior / Human Input Responsiveness / Efficiency / Top Problems / Trace Link
⑥ Judge 使用少量人工 Judge Good/Bad Examples
⑦ Reports 页面可以看到 Baseline → M6 + 新运行结果
⑧ 历史 Report 可以关联 GitHub Evidence
⑨ 最大程度复用现有 evaluation harness，不重复实现已有指标和 Runner 逻辑
```

---

## 7. Agent Lab MVP

目标：证明 Agent 差异，不做实验平台。

页面三块：

```text
Persona Evaluation
Sequential Verification
Quality Gate Verification
```

### Persona Evaluation

固定场景下四个 Persona 分别生成：

```text
Description / Vote / Reason
```

展示 Persona Adherence、Distinctiveness、Diversity、Exposure Control。

### Sequential Verification

直接展示 deterministic evidence：

```text
AI1 sees 0 previous AI descriptions
AI2 sees 1
AI3 sees 2
AI4 sees 3
PASS
```

### Quality Gate Verification

固定 Bad Case：

```text
Candidate → REJECT → Reason → Repair → PASS → Commit Result
```

不做 Case 管理系统。

---

## 8. Fault Lab MVP

目标：稳定、可解释，不做自由配置 fault workflow。

第一版优先固定一个场景：

```text
Description Timeout
Target: AI-4
Task: Describe
Attempt: 1
Expected: Retry → Success / Failed Safely
```

结果页展示：

```text
FAULT TRIGGERED / TARGET FAULT NOT REACHED
Game ID / Run ID / Round / Agent / Task / Attempt
Error / Recovery / View Trace
```

如果目标 fault 没走到，必须显示真实停止原因，不能假装 fault 已发生。

---

## 9. 测试策略

每个阶段保持：

```text
npm run contract:node
```

通过。

Fake Model 用于证明工程正确性：

```text
State transition
Context
Persona pipeline
Atomicity
Quality Gate
Trace
Fault
Evaluation Gate
```

Real Model 只做人工小样本验收：

```text
1 real game
Persona sample
small Evaluation
one controlled fault/retry
Trace inspection
```

开发过程中不自动大量消耗 DeepSeek Token。

---

## 10. 实施路线

```text
Phase 1: Trace Lite
Phase 2: Evaluation MVP
Phase 3: Agent Lab MVP
Phase 4: Fault Lab MVP
Phase 5: Final Integration / Demo
```

旧 `admin-console-demo` 和历史 stash 只作为归档。

默认不再回头研读旧 Admin UI；只有发现具体底层能力缺失时，才定点参考。

---

## 11. 核心取舍原则

后续所有功能用五个问题判断：

1. 能不能帮助证明任务要求？
2. 能不能帮助定位真实问题？
3. 面试官能不能一眼看懂？
4. 维护成本是否值得？
5. 如果删掉它，会不会影响核心证据？

如果答案只是：

> 一个平台看起来应该有。

那就不做。