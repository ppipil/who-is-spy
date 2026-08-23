版本： v1.0
项目类型： Multi-Agent 工程二次开发
技术栈： React + Node.js / TypeScript + DeepSeek
核心定位： Agent 编排 + 评测 + Trace + 故障恢复的可运行 Demo

---
1.1 项目背景
现有项目是一套已经能够完整运行的「AI 谁是卧底」：
- 1 名人类玩家；
- 4 名独立 AI Agent；
- AI 负责描述、投票、复盘；
- 服务端负责隐藏信息、状态流转、合法投票校验、淘汰和平票裁决；
- React 前端负责游戏交互。
官方任务明确要求不是从零搭建，而是在真实基线上做二次开发，把“多个隔离的 LLM 玩家调用”推进成一个有差异化策略、可评测、可观测、可演进的 Multi-Agent 系统。官方重点考察的是问题定位、工程取舍、落地和自证，而不是页面数量或代码量。
本项目最终不定位为通用 LLMOps 平台，而是：
围绕“AI 谁是卧底”这一真实场景，把 Agent 编排、质量控制、效果评测、Trace 和故障恢复串成一个完整工程闭环。

---
2. 产品目标
项目最终需要解决四类核心问题。
2.1 Agent 真正具有不同策略
基线存在的问题是：
- 四个 AI 说话高度雷同；
- Persona 只是字段，没有真正影响模型行为；
- 后发 Agent 看不到同轮前面的 AI 说了什么。
官方任务①要求证明：
- 后发 Agent 上下文包含同轮先发 Agent 的公开描述；
- 四个 Persona 在相同场景下产生可区分行为；
- 雷同或泄题描述会被拦截，而不是直接进入游戏状态。
2.2 系统效果能够被量化
不再依赖：
“我自己玩了一局，看起来好像不错。”
而应该回答：
- 完局率是多少？
- 有没有非法投票？
- 有没有泄题？
- 四个 Agent 是否同质化？
- Persona 是否真的表现出来？
- 后发 Agent 有没有使用 Context？
- 延迟多少？
- Token / Cost 增加多少？
- Final 相比 Baseline 到底改善了什么，又退化了什么？
官方要求一个命令能够运行 N 局，至少覆盖泄题、同质化、有效投票、完局、延迟和成本，并具备固定回归用例及非 0 退出的质量门禁。
2.3 一次模型失败可以被看清楚
需要回答：
哪一局？
第几轮？
哪个 Agent？
做什么任务？
第几次调用？
为什么失败？
有没有 Retry？
最后恢复了吗？
官方任务③同样明确要求能够主动制造 Timeout、Bad JSON、Rate Limit 等故障，并精确定位、回放和安全恢复。
2.4 Demo 必须容易理解
Admin Console 不再做“大而全的平台”。
最终只保留：
Admin Lite
├── Trace
├── Evaluation
├── Agent Lab
└── Fault Lab
核心原则：
入口少、操作简单、结果详细、证据充分。

---
3. 基线不可破坏约束
以下属于 P0 Hard Requirement。
游戏规则
固定：
1 Human + 4 AI
淘汰、平票、胜负和合法投票目标全部由服务端代码决定，模型不能自行决定游戏规则。
信息隔离
终局前：
players[]
不得出现：
role
word
revealedRole
revealedWord
Human 只能看到自己的：
playerId
role
word
终局后才允许完整 Reveal。
模型职责
AI 的：
- Describe
- Vote
- Review
必须来自 Model Interface。
FakeModel 只能用于测试和确定性验证，不能冒充真实模型效果。
Contract
所有新增功能都必须保持：
npm run contract:node
持续通过。

---
4. 非目标
本项目当前明确不做：
- 通用 Langfuse 替代品；
- Dataset 管理平台；
- Case Explorer 平台；
- 通用实验管理系统；
- 多模型竞技平台；
- RBAC；
- 分布式 Trace；
- 数据仓库；
- 1000+ 局并发评测；
- Shadow Traffic；
- A/B 平台；
- 自由组合的 Fault Workflow；
- 为了“架构漂亮”重写 GameEngine；
- 引入与任务无关的重型框架。

---
5. 用户角色
5.1 玩家
使用原游戏页面：
创建游戏
→ 查看自己的秘密词
→ 描述
→ 投票
→ 查看淘汰
→ 下一轮
→ 查看终局
5.2 开发者 / 候选人
主要使用 Admin Lite：
Trace
Evaluation
Agent Lab
Fault Lab
5.3 面试官 / Reviewer
需要快速理解：
- 你具体改了什么？
- Agent 为什么不一样？
- Context 是怎么逐步增长的？
- 怎么防止泄题？
- Final 比 Baseline 好在哪里？
- 为什么延迟变高？
- 一次 Timeout 是怎么恢复的？
- Trace 如何证明这一点？

---
6. Agent 决策与编排
6.1 Persona
固定四个 Persona：
暂时无法在飞书文档外展示此内容
当前架构已经采用 registry-backed Strategy，而不是在 GameEngine 里根据玩家名字写条件分支。
Persona 至少影响：
Description Guidance
Vote Guidance
Risk / Information Budget
Quality Policy
Evaluation Grouping

---
7. Sequential Context
同一轮必须按顺序生成 AI 描述。
假设 Human 已经描述：
AI1 Context
= 历史公开信息 + Human

AI2 Context
= 历史公开信息 + Human + AI1

AI3 Context
= 历史公开信息 + Human + AI1 + AI2

AI4 Context
= 历史公开信息 + Human + AI1 + AI2 + AI3
已经接受但尚未整批提交的结果保存在 staged data 中。
AgentContext 仍然通过 Allowlist 构造，不能因为 Sequential Context 而把完整 GameState 交给 Agent。当前架构设计也是通过 staged prefix + allowlisted AgentContext 实现这一点。

---
8. Atomic Commit
描述阶段采用：
Generate
↓
Gate
↓
Stage
↓
Generate Next
↓
...
↓
全部成功
↓
Atomic Commit
如果 AI4 最终失败：
AI1
AI2
AI3
也不能已经写入正式 GameState。
Formal State 应保持上一状态。

---
9. Quality Gate
目标：
阻止明显不合法、泄题或高度重复的描述进入正式游戏。
流程：
Candidate
   ↓
Quality Gate
   ├── PASS → Stage
   │
   └── REJECT
          ↓
       Repair Guidance
          ↓
        Retry
检查项至少包括：
基础合法性
- Empty
- Too short
- Too long
- Schema error
Secret Leakage
直接出现秘密词：
REJECT
Duplicate / Similarity
与本轮已经接受描述过于相似：
REJECT
Retry
有限次数。
最终失败：
Abort current description batch
不能留下半完成状态。

---
10. Admin Lite
页面结构固定为：
/admin

Trace
Evaluation
Agent Lab
Fault Lab
AdminConsole.tsx 只负责：
- Shell
- Navigation
- Page Render
禁止再次把所有业务逻辑塞入单文件。
推荐结构：
admin/
├── AdminConsole.tsx
├── shared/
├── trace/
├── evaluation/
├── agent/
└── fault/

---
11. Trace
Trace 是整个 Admin 中最底层的证据系统。
11.1 页面结构
Trace
├── Run Explorer
├── Timeline
└── Inspector
11.2 Run Explorer
展示：
- Run ID
- Game ID
- Source
- Model
- Created Time
- Status
支持过滤：
- runId
- gameId
- round
- agent
- task
- error
- model
- source

---
12. Trace Timeline
层级：
Game
└── Round
    ├── Human
    ├── AI1
    │   ├── Prompt
    │   ├── Model Call
    │   ├── Quality Gate
    │   ├── Retry
    │   └── Commit
    ├── AI2
    ├── AI3
    ├── AI4
    └── Vote
关键事件：
trace_run
model_call
prompt
quality_gate
retry
commit
vote
error
recovery
resume
review

---
13. Trace Inspector
点击事件以后展示：
Run ID
Game ID
Round
Agent
Persona
Task
Attempt
Model
Timestamp

Prompt Version
Sanitized Prompt

Public Context

Output

Latency
Token

Quality Decision
Retry
Error Type
Recovery
不要求所有事件都有所有字段。
不存在时显示：
—
而不是制造假数据。

---
14. Trace 安全
Trace 禁止保存：
- API Key；
- Authorization；
- 完整其他玩家 Secret；
- 隐藏 Role；
- 完整内部 GameState；
- 未脱敏 Prompt；
- 模型隐藏 Chain-of-Thought。
官方要求 trace / replay 中同样不得包含明文 Key 或完整密词。

---
15. Evaluation
Evaluation 产品原则：
Runner 简单，Report 详细。
不再建设复杂 Evaluation Platform。

---
16. Evaluation Runner
配置只保留：
Model
Fake
DeepSeek
Fake 默认。
Real 必须用户主动触发。
Games
建议：
1
3
5
允许小范围自定义。
Seed
默认：
42
AI Judge
ON / OFF

---
17. Evaluation 运行反馈
点击：
Start Evaluation
必须立即显示：
RUNNING

Run ID
eval-xxxx

Game
1 / 3

Stage
Description

Elapsed
00:18
禁止按钮点击以后无反馈。

---
18. Evaluation Report
最终页面结构：
Evaluation Report

1. Summary
2. Reliability
3. Safety
4. Agent Behavior
5. Efficiency
6. AI Judge
7. Problems & Evidence
8. Trace

---
19. Reliability Metrics
Completion Rate
completedGames / startedGames
Fake：
100% required
Valid Vote Rate
legal AI votes / total AI votes
Fake：
100% required
Invalid Output Rate
统计：
- JSON Parse
- Schema
- Invalid target
- Invalid model response
Retry
展示：
- Retry Count
- Retry Rate
- Provider Retry
- Quality Repair
已有 Evaluation Harness 已经能够固定 seed 运行，并统计完局、有效票、同质化、延迟等指标。

---
20. Safety Metrics
Exact Secret Leak
任何正式提交描述直接包含 secret：
FAIL
Public State Leak
任何终局前公开状态出现隐藏字段：
FAIL
Illegal State
例如：
- Half Commit
- Illegal Phase
- Invalid target
- Broken finale
出现：
FAIL

---
21. Agent Behavior Metrics
这里主要由 LLM Judge 判断。
每个维度：
0–10
同时必须输出：
Score
Reason
Evidence

---
21.1 Persona Adherence
判断：
输出是否符合对应 Persona？
例如谨慎观察是否明显表现为低暴露和谨慎判断。

---
21.2 Strategy Distinctiveness
判断：
四个 Agent 是真正采用了不同策略，还是只做了表面措辞变化？
重点关注：
- 信息选择；
- 风险偏好；
- 推理角度；
- 投票证据。

---
21.3 Context Utilization
判断：
后发 Agent 是否实际利用了同轮先发 Agent 的公开信息？
同时展示 deterministic evidence：
AI1 prefix = 0
AI2 prefix = 1
AI3 prefix = 2
AI4 prefix = 3

---
21.4 Description Diversity
两类指标同时保留。
Lexical
代码计算：
Normalized char-bigram Dice
这是 lexical proxy，不能写成 Semantic Similarity。现有 Harness 使用的也是该定义。
Semantic / Behavioral
由 Judge 判断：
- 是否只是同义改写；
- 是否真正提供不同角度。

---
21.5 Exposure Control
Judge 判断：
虽然没有直接出现秘密词，但描述是不是已经具体到近乎泄题？

---
22. Efficiency Metrics
至少展示：
Latency
P50
P95
并解释：
- P50：一半请求低于该值；
- P95：长尾请求表现。
Token Usage
Input Tokens
Output Tokens
Total Tokens
Tokens / Game
有条件时按：
Describe
Vote
Review
拆分。
Cost
Total Cost
Cost / Game
无法计算：
Unavailable
禁止用 0 冒充不可用。

---
23. Evaluation 打分体系
结果同时保留：
真实指标
+
PASS / WARN / FAIL
+
Category Score
不能所有东西只显示一个百分制分数。

---
23.1 Hard Gate
下面任何一项出现：
Secret Leak
Public State Leak
Illegal State
Fake Completion < 100%
Fake Valid Vote < 100%
则：
OVERALL = FAIL
不能靠其他高分平均掉。

---
24. Category Score
建议：
暂时无法在飞书文档外展示此内容
计算：
Overall Score =
Reliability × 30%
+ Safety × 25%
+ Behavior × 30%
+ Efficiency × 15%
但：
Hard Gate 永远优先于 Overall Score。
该分数用于 Demo 可读性，不宣称统计学显著性。

---
25. Evaluation Summary
第一屏应该直接回答：
8.2 / 10
PASS

可靠性和安全性稳定，
Persona 区分度较明显，
当前主要问题是 Context Utilization 和 P95 延迟。
旁边：
Games       5 / 5
Model       DeepSeek
Seed        42
Gate        PASS
Duration    3m18s
Cost/Game   $0.021

---
26. 单指标展示规范
每个 Metric Card 至少包含：
Name

Value

Score / Status

一句人话解释

Calculation

Why it matters
例如：
Description Homogeneity

0.011

GOOD

四个 AI 在同轮里的字面重复程度较低。

Calculation:
mean pairwise normalized char-bigram Dice

Lower is better.

它只能表示 lexical similarity，
不能证明完整 semantic diversity。

---
27. AI Judge
Input
Judge 接收：
Scenario
Persona Definitions
Public Context
Four Agent Outputs
Rubric
Good Examples
Bad Examples
不传无关秘密信息。
Output
结构化：
{
  "personaAdherence": {
    "score": 8.4,
    "reason": "...",
    "evidence": []
  },
  "distinctiveness": {},
  "contextUtilization": {},
  "diversity": {},
  "exposureControl": {},
  "summary": "",
  "problems": []
}

---
28. Good / Bad Cases
Good/Bad Case 的用途：
给 Judge 提供 Few-shot calibration。
当前版本不建设 Dataset Platform。
只需要在 Judge Rubric 中维护少量典型例子：
Persona
Diversity
Context
Exposure

---
29. Baseline vs Final
Evaluation 提供一个独立对比区域：
Baseline
vs
Final
展示：
- Completion
- Valid Vote
- Invalid Output
- Secret Leak
- Homogeneity
- P50
- P95
- Tokens/Game
- Cost/Game
- Retry
- Repair
重点：
必须同时展示改善和退化。
不能为了显得 Final 更好而隐藏 latency / cost / completion 等坏结果。

---
30. Agent Lab
Agent Lab 的目标不是做实验平台。
而是：
用最简单的方法证明 Task①。
页面三部分。

---
30.1 Persona Evaluation
点击：
Generate & Evaluate
流程：
相同 Scenario
↓
四 Persona 分别生成
↓
收集结果
↓
LLM Judge
↓
Score + Reason + Evidence
展示：
谨慎观察
Description
Vote
Reason

直觉敏锐
...

逻辑派
...

出其不意
...
下面显示：
- Persona Adherence
- Distinctiveness
- Diversity
- Exposure Control
不需要 Trace。

---
31. Sequential Verification
固定场景：
AI1 sees Human
AI2 sees Human + AI1
AI3 sees Human + AI1 + AI2
AI4 sees Human + AI1 + AI2 + AI3
结果：
PASS
允许查看 sanitized context evidence。

---
32. Quality Gate Verification
固定 Bad Case：
Candidate
↓
REJECT
↓
Reason
↓
Repair
↓
PASS
展示：
- Candidate
- Violation
- Similarity
- Threshold
- Retry
- Commit Result
不用建设 Case 管理系统。

---
33. Fault Lab
Fault Lab 当前追求：
稳定、可解释，而不是自由配置。
优先固定场景：
1. Description Timeout
2. Bad JSON
3. Review Failure
如果时间不足：
只保证第一个稳定，也比七种不稳定 Fault 更好。

---
34. Fault Flow
点击：
Start Fault Demo
马上显示：
RUNNING

Target
AI-4

Task
Describe

Expected Fault
Timeout
执行：
Normal Game
↓
AI4 Describe
↓
Inject Timeout
↓
Retry
↓
Recover / Abort

---
35. Fault Result
结果页：
FAULT TRIGGERED

Game
xxx

Round
1

Agent
AI-4

Task
Describe

Attempt
1

Error
Timeout
Recovery：
Retry attempt 2
→ Success
最终：
RECOVERED
或：
FAILED SAFELY
并提供：
View Trace

---
36. Fault 特殊规则
假如指定：
AI4 Timeout
但系统在 AI1 就发生其他失败：
不能显示：
AI4 Timeout
而必须显示：
TARGET FAULT NOT REACHED

Actual Stop Reason:
AI1 Quality Gate Exhausted

---
37. Admin API 边界
原则：
Core Runtime
      ↓
Thin Admin API
      ↓
Admin UI
Admin 不重新实现：
- GameEngine；
- Evaluation Harness；
- Trace Collector；
- Agent Strategy；
- Fault Logic。

---
38. Trace 标识
统一定位方式：
runId
 ↓
gameId
 ↓
round
 ↓
agentId
 ↓
task
 ↓
attempt
这是 Evaluation、Trace、Fault 之间主要的关联方式。

---
39. 测试策略
Contract
npm run contract:node
必须全绿。
Fake
用于：
- State transition；
- Context；
- Persona pipeline；
- Atomicity；
- Gate；
- Trace；
- Fault；
- Evaluation Gate。
FakeModel 能证明工程正确性，但不能证明真实 Agent 质量。现有 Candidate 文档也明确区分 Fake 验证与 Real Model Acceptance。
Real
最终人工运行：
1 real game
Persona sample
small Evaluation
one controlled fault/retry
Trace inspection
不在开发过程中自动大量消耗 DeepSeek Token。

---
40. 可维护性要求
前端：
AdminConsole = thin shell
业务按：
trace/
evaluation/
agent/
fault/
拆分。
建议：
- 普通 React Component 尽量 < 300 行；
- 超过 400 行且承担多个职责时必须考虑拆分；
- 普通业务函数建议 40–60 行以内；
- API、Types、Transform、UI 不混在一个超长文件；
- 不按行数机械重构。
后端：
- 不为了“看起来漂亮”重写 GameEngine；
- Admin instrumentation 尽量 minimal；
- 核心状态机稳定优先。

---
41. 最终 Demo 流程
推荐现场按这个顺序讲。
① Game
真实模型跑一局。
说明：
Persona
Sequential Context
Quality Gate
Server Authority
② Agent Lab
展示：
四 Persona
↓
Judge
↓
人格差异评分
再快速展示：
Sequential PASS
Quality Gate Reject → Repair
③ Evaluation
跑 1–3 局。
展示：
Reliability
Safety
Agent Behavior
Efficiency
Judge
Gate
Evidence
然后打开：
Baseline vs Final
④ Fault
触发：
AI Timeout
展示：
Fault
↓
Retry
↓
Recovery
⑤ Trace
直接根据 Fault 的 runId 进入 Trace：
Game
→ Round
→ AI
→ Model Call
→ Timeout
→ Retry
→ Recovery
这时候四个模块形成闭环。

---
42. 当前实施阶段
建议从现在开始固定路线：
Phase 1
Trace Lite
→ 完成、验收、冻结

Phase 2
Evaluation
→ 指标设计
→ Runner
→ Detailed Report
→ Judge

Phase 3
Agent Lab
→ Persona MVP
→ Sequential
→ Gate

Phase 4
Fault Lab
→ Fixed Fault Demo

Phase 5
Final Integration
→ Real Smoke
→ README
→ DECISIONS
→ PPT / Demo
旧 admin-console-demo 和历史 stash 从这一步以后只作为归档。
默认不再回头研读旧 Admin UI。
只有发现某个具体底层能力缺失时，才定点参考。

---
43. 最终验收标准
暂时无法在飞书文档外展示此内容

---
44. 产品核心原则
后续所有功能取舍都可以用下面五条判断：
① 能不能帮助证明任务要求？
② 能不能帮助定位真实问题？
③ 面试官能不能一眼看懂？
④ 维护成本是否值得？
⑤ 如果删掉它，会不会影响核心证据？
如果答案是：
“只是因为一个评测平台看起来应该有。”
那就不做。

---
一句话产品定义
AI 谁是卧底是一个以真实多人推理游戏为载体，通过 Persona 策略、顺序上下文、质量门禁、自动评测、Trace 和故障恢复，证明 Multi-Agent 系统能够被设计、验证、观察和可靠运行的工程 Demo。
我建议后面就把这份内容放成仓库里的 docs/PRD.md。从下一轮开始，我们所有 Codex Prompt 都可以直接规定：“以 docs/PRD.md 为产品范围，禁止自行扩需求。” 这样会明显减少再次做复杂的概率。
