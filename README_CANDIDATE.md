# AI 谁是卧底 · Node 候选方案

本仓库是在官方基线上的二次开发交付：一名人类玩家与四名独立 AI Agent 进行“谁是卧底”对局，服务端负责信息隔离、合法性校验、状态推进和胜负裁决，模型只负责描述、投票与终局复盘。

本方案选择 **Node.js + TypeScript** 实现，主要开发范围为 `packages/server-node`；`packages/server-go` 保持不变。除完成必做的 Agent 决策与编排外，还实现了批量效果评测、结构化 Trace、故障注入、恢复与 Admin Lite 展示。

官方任务与硬约束：

- [候选人任务书](./CANDIDATE_TASK.md)
- [语言无关行为契约](./contract/CONTRACT.md)
- [关键设计与真实验证记录](./DECISIONS.md)

## 一、技术栈选择

| 层级 | 技术 |
| --- | --- |
| Web | React、TypeScript、Vite |
| Node 服务端 | Node.js、TypeScript、Express |
| 输入与模型输出校验 | Zod |
| 测试 | Vitest、Supertest |
| 模型接口 | DeepSeek / OpenAI-compatible Chat Completions |
| 评测与演示 | TypeScript CLI、确定性 FakeModel |
| Trace | 结构化事件、内存或 JSONL 存储 |

选择 Node/TypeScript 的原因：

- 与现有 React 前端共享类型语境，修改与现场讲解成本较低。
- 基线已有可注入的 `GameModel`、FakeModel、Vitest 和随机源，适合构造确定性 Agent 与评测证据。
- Zod 可以同时约束 HTTP 输入和模型结构化输出。
- 本题重点是 Agent 编排、隔离、评测与恢复，不需要引入额外重型框架。

## 二、完成情况

### 任务线①：Agent 决策与编排

已完成：

- 四个 AI 使用稳定 `strategyId`，分别对应谨慎、直觉、逻辑和出其不意。
- Persona 不再只是展示名称，而是实际进入描述 Prompt、投票 Prompt 和质量重试策略。
- AI 描述改为串行生成并逐条公开，后发 Agent 能看到本轮先发 Agent 已提交的描述。
- 每次模型调用只接收当前 Agent 的私有身份/词和公开信息，不接收完整 `GameState`。
- 描述提交前执行长度、完整密词、题目字和同轮雷同检查。
- 质量失败会携带明确原因定向重试；预算耗尽后安全停在描述阶段，不提交失败文本。
- 支持从第一个缺失 Agent 手动恢复，不重跑已经成功的 Agent。

关键实现：

- `packages/server-node/server/core/agent-context.ts`
- `packages/server-node/server/core/agent-strategy.ts`
- `packages/server-node/server/core/game-engine.ts`
- `packages/server-node/server/core/description-quality.ts`
- `packages/server-node/server/core/prompt.ts`

### 任务线②：效果评测

已完成一个可复现的批量评测入口：

```bash
npm run eval:node -- --games 20 --seed 42 --model fake
```

支持：

- 指定对局数、随机种子和 Fake/Real 模型。
- 用 Mulberry32 将词对、身份分配和破平票随机过程固定下来。
- 输出人类可读指标表和结构化 JSON。
- 按 `strategyId` 聚合胜率与投票准确率。
- 统计完局率、有效投票、描述拒绝、重试、同质化、延迟、Token 和成本。
- Gate 失败时使用非 0 退出码，可接入 CI。

当前确定性硬门禁：

- 完局率必须为 100%。
- 有效投票率必须为 100%。
- 已提交描述中的完整密词泄漏必须为 0。
- 终局前公共 DTO 的身份/词字段泄漏必须为 0。
- 非法或半完成状态必须为 0。

同质化、真实网络延迟和成本暂时作为报告指标，不伪装成已经校准完成的硬阈值。

关键实现：

- `packages/server-node/server/evaluation/evaluation.ts`
- `packages/server-node/server/evaluation/eval-cli.ts`
- `packages/server-node/server/evaluation/usage-metrics.ts`
- [评测口径与基线](./docs/EVALUATION.md)

### 任务线③：可观测性与故障恢复

已完成：

- 结构化记录对局、轮次、阶段、Agent、任务、Attempt、错误类型、HTTP 状态、延迟、是否重试和最终结果。
- 记录 Prompt 模板版本与哈希，不把 API Key、Authorization、完整未脱敏 Prompt 或原始模型响应写入运行 Trace。
- 支持 timeout、限流、5xx、坏 JSON、Schema 错误和网络错误分类。
- 网络/超时与其他可重试错误使用有界重试，不无限循环。
- 描述失败时保留已公开的合法前缀，并明确停在 `describing`。
- AI 投票先作为私有整批候选生成，任一失败时整批不提交，避免半批票进入状态。
- 终局复盘失败时使用本地 fallback，不让已经结束的对局悬空。
- 支持按事件顺序回放失败、重试、恢复和公开状态推进。

故障演示示例：

```bash
npm run fault-demo -- --scenario describe-timeout
npm run fault-demo -- --scenario describe-bad-json
npm run fault-demo -- --scenario describe-final-failure
npm run fault-demo -- --scenario vote-rate-limit
npm run fault-demo -- --scenario vote-final-failure
npm run fault-demo -- --scenario review-failure
```

关键实现：

- `packages/server-node/server/core/model.ts`
- `packages/server-node/server/trace/trace.ts`
- `packages/server-node/server/trace/replay-cli.ts`
- `packages/server-node/server/fault/fault-injection.ts`
- `packages/server-node/server/fault/fault-demo.ts`

## 三、快速开始

### 环境要求

- Node.js 20.19+、22.12+ 或 24+，推荐 Node 22 LTS。
- npm。
- 真实模型演示需要 DeepSeek 或兼容接口的 API Key。
- FakeModel、单元测试和 Contract 不需要 API Key。

### 安装与配置

```bash
npm install
cp .env.example .env
```

Windows PowerShell 可使用：

```powershell
Copy-Item .env.example .env
```

首次启动建议先使用 FakeModel 验证前后端接线，无需 API Key。在 `.env` 中配置：

```dotenv
GAME_MODEL=fake
PORT=8787
ENABLE_ADMIN_CONSOLE=1
```

需要在网页中调用真实 DeepSeek 时，改为：

```dotenv
GAME_MODEL=real
DEEPSEEK_API_KEY=你的本地密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
PORT=8787
ENABLE_ADMIN_CONSOLE=1
```

不要提交 `.env`、API Key、Authorization header、未脱敏 Prompt 或包含完整密词的 Trace 产物。

### 启动

从仓库根目录打开两个终端，分别启动 Node 后端与 Web。两个进程都需要保持运行。

终端 1——启动 Node 后端：

```bash
npm run dev:node
```

终端 2——启动 Web 前端：

```bash
npm run dev:web
```

默认地址：

- 游戏页面：`http://localhost:5173`
- Admin Lite：`http://localhost:5173/admin`
- Node API：`http://localhost:8787`

健康检查：

```text
GET http://localhost:8787/api/health
```

其中 `configured` 表示真实模型是否已经配置，`model` 表示当前模型名称。

## 四、核心设计

### 1. 服务端权威状态机

```text
Human / React
      │ 只提交描述、投票、继续观战等意图
      ▼
Express API
      ▼
GameEngine
      ├── 校验阶段和合法目标
      ├── 串行编排 AI 描述
      ├── 结算投票、平票、淘汰与胜负
      ├── 管理失败恢复和私有投票批次
      └── 对外投影 PublicGameState
```

模型不能直接修改轮次、淘汰结果、合法目标或胜负。

### 2. Agent 信息隔离

`buildAgentContext(game, agent)` 是发言和投票 Agent 的唯一上下文构造入口。

当前 Agent 能看到：

- 自己的 `playerId/name/strategyId/role/word`。
- 当前对局、轮次、阶段和 ballot。
- 存活玩家的 `id/name`。
- 已经公开的描述与淘汰记录。

当前 Agent 看不到：

- 其他玩家的 `role/word`。
- 完整 `Player[]` 或 `GameState`。
- 尚未公开的投票候选。
- API Key、其他 Agent 的隐藏推理或完整内部 Prompt。

隔离采用字段白名单重新构造，而不是先传完整对象再删除敏感字段。

### 3. 后发 Agent 如何看到同轮前序描述

`GameEngine.generateDescriptions()` 使用串行循环：

```text
为当前 Agent 构造最新 AgentContext
→ 调用模型
→ 服务端质量门禁
→ 通过后 commitDescription
→ 下一位 Agent 再构造上下文
```

因此四个 AI 看到的同轮 AI 描述前缀数量依次为 `0、1、2、3`。如果改成 `Promise.all`，四个 Agent 会拿到同一份旧快照，无法利用逐步公开信息。

### 4. Persona 与安全规则分离

`AgentStrategy` 将两类责任分开：

- Role Objective：作为平民或卧底怎样赢。
- Persona Policy：优先观察什么、愿意提供多少信息、怎么表达、怎么投票。

四个 Persona 共享同一套泄密和合法性上限。风险偏好只影响安全区间内的信息预算，不能绕过服务端质量门禁。

### 5. 描述质量门禁

规则顺序：

1. 非空。
2. 长度为 2–60 个字符。
3. 不包含禁止公开的完整题目词或组成字。
4. 与同轮已接受描述的字符 bigram Dice 相似度低于 0.72。

`0.72` 是由固定回归样本约束的工程启发式，不是统计学上的普适最优值。字符 bigram 适合稳定拦截近似复述，但无法完全识别字面不同的语义改写。

## 五、Admin Lite

Admin Lite 用于现场展示工程证据，不重新实现核心引擎：

- Trace：查看运行列表、时间线、模型调用、质量拒绝、重试与恢复。
- Evaluation：配置固定 Case，运行 Fake/Real 评测并查看指标、Gate 与历史报告。
- Fault：触发确定性故障，查看暂停状态并执行恢复。

架构原则：

```text
Core Runtime → Thin Admin API → Admin UI
```

Admin 页面只消费核心 Runtime、Evaluation、Trace 和 Fault 服务的结果。

## 六、Contract 与验证

`contract/` 是语言无关的黑盒硬门槛，冻结：

- HTTP 端点与最低 DTO 形状。
- 终局前信息隔离。
- 一名人类和四名 AI。
- 服务端确定性淘汰、平票和胜负。
- 描述长度与直接密词校验。
- 模型接口与 FakeModel 注入点。

运行 Node Contract：

```bash
npm run contract:node
```

Contract 使用 FakeModel，只能证明接口、隔离和状态流转没有回归，不能证明真实模型质量或外部网络可用。

常用验证命令：

```bash
npm run build
npm run test:node
npm run contract:node
npm run eval:node -- --games 20 --seed 42 --model fake
```

真实运行命令与证据只以 [DECISIONS.md](./DECISIONS.md) 中记录的实际结果为准。

## 七、项目结构

```text
packages/
  web/
    src/
      App.tsx
      admin/                    # Trace / Evaluation / Fault UI
  server-node/
    server/
      core/
        types.ts
        agent-context.ts        # 最小权限 Agent 上下文
        agent-strategy.ts       # 四 Persona 策略注册表
        game-engine.ts          # 服务端权威状态机与编排
        description-quality.ts  # 描述提交前门禁
        prompt.ts               # 描述、投票、复盘 Prompt
        model.ts                # Provider、结构校验与重试
      evaluation/               # 批量评测、指标和成本
      trace/                    # Trace、JSONL 与回放
      fault/                    # 故障注入与演示
      admin/                    # Admin Lite 薄 API
      app.ts                    # HTTP 路由与错误映射
  server-go/                    # 官方 Go 基线，本方案未修改
contract/
  run.mjs
  CONTRACT.md
docs/
  PRD.md
  BASELINE_AUDIT.md
  EVALUATION.md
  AGENT_DESIGN_AUDIT.md
```

## 八、文档导航

- [PRD](./docs/PRD.md)：Admin Lite、Trace、Evaluation、Agent Lab 与 Fault Lab 的需求和验收标准。
- [基线审计](./docs/BASELINE_AUDIT.md)：改造前代码、环境和能力缺口证据。
- [评测说明](./docs/EVALUATION.md)：可复现命令、基线指标、成本和门禁口径。
- [当前实现与面试讲解](./docs/AGENT_DESIGN_AUDIT.md)：关键文件、函数、设计取舍、指标公式和故障恢复。
- [决策记录](./DECISIONS.md)：Coding Agent 使用、人工修正、实际命令和里程碑证据。

## 九、已知限制

- FakeModel 只能证明接线、状态机和确定性回归，不能替代真实模型验收。
- Persona 的真实可区分性仍需要现场或批量 Real 模型样本验证。
- 字符 bigram 同质化是代理指标，不等于完整语义评价。
- 对局状态仍以内存为主，服务重启后的对局恢复不属于本次核心任务。
- 真实模型延迟、成本和输出质量受 provider、网络、模型版本与时段影响。
- `prompt_provenance` 中的角色字段属于管理员私有诊断数据，不进入玩家公开 DTO。
