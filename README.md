# AI 谁是卧底 · Agent 全栈二次开发题(基线)

一名人类玩家和四名独立 DeepSeek Agent 同桌进行「谁是卧底」。它不是预设台词 Demo:AI 的
描述、投票理由和终局复盘均由**真实模型**生成,服务端负责隐藏信息、规则校验和胜负裁决。

这是一个**二次开发基线**。你的任务、验收信号与交付约定见 **[`CANDIDATE_TASK.md`](./CANDIDATE_TASK.md)**;
过程记录模板见 [`DECISIONS.md`](./DECISIONS.md)。**请先读任务书再动手。**

## 仓库结构

这是一个 monorepo,**前端一份,后端两份等价实现**(Node 与 Go),对外暴露完全相同的
HTTP 契约。你只需**二选一**完成后端二次开发;前端是可选加分层。

```text
packages/
  web/           React 前端(所有后端共用)
  server-node/   Node / TypeScript 后端
  server-go/     Go 后端(与 Node 行为等价)
contract/        语言无关的黑盒契约测试(冻结基线硬门槛)
```

## 快速启动

要求 Node.js 20.19+ / 22.12+ / 24+(推荐 Node 22 LTS;依赖不支持 Node 21/23);若选 Go,
需 Go 1.22+(在 1.26 验证)。

```bash
npm install
cp .env.example .env      # 填入可用的 DeepSeek / OpenAI-compatible Key
```

编辑 `.env`:

```dotenv
DEEPSEEK_API_KEY=sk-your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

选 **Node** 后端:

```bash
npm run dev:node          # 后端 http://localhost:8787
npm run dev:web           # 前端 http://localhost:5173(代理 /api 到 8787)
npm run test:node         # 基线域测试
npm run contract:node     # 语言无关契约(应全绿)
```

选 **Go** 后端:

```bash
npm run dev:go            # 后端 http://localhost:8787
npm run dev:web           # 前端 http://localhost:5173
npm run contract:go       # 语言无关契约(应全绿)
```

> 不配 Key 也能跑契约:契约测试用 `GAME_MODEL=fake` 拉起确定性替身,无需密钥。真实模型
> 由 `.env` 与 `GET /api/health` 的 `configured/model` 状态驱动。

## 行为契约(基线硬门槛)

`contract/` 是一份**语言无关的黑盒契约测试**,它冻结了所有实现都必须满足的硬门槛
(HTTP 形状、信息隔离、确定性裁决、模型调用接口),但**不**规定你二次开发的内部做法。
无论你选哪个栈、怎么改,契约必须**持续全绿**。契约使用 FakeModel,不等于真实模型验收;
真实路径需要单独运行并在现场演示。冻结了什么、留了哪些发挥空间,见
[`contract/CONTRACT.md`](./contract/CONTRACT.md)。

## 可玩流程

1. 抽取身份:1 名人类 + 4 名 AI,随机 1 名卧底。
2. 私密看词:每人只知道自己的阵营与密词。
3. 描述:人类先提交一句描述,四位 Agent 读取自己的私有信息和公开历史后独立生成描述。
4. 投票:人类和每位存活 Agent 独立投票;同票时只在最高票玩家间加票。
5. 淘汰与判胜:卧底全部出局 → 平民胜;存活卧底数 ≥ 存活平民数 → 卧底胜。
6. 人类提前出局后可观战,由 AI 自动完成剩余牌局。
7. 终局揭晓全部身份、密词、票型,并由模型生成赛后复盘。

## 核心设计

### 服务端权威状态

游戏状态只保存在后端的 `GameEngine` 中。前端只发出 `描述 / 投票 / 继续观战` 意图,不能
自行修改轮次、身份、淘汰结果或胜负。

```text
React UI ──(human action)──► HTTP API ──► GameEngine(规则、状态、判胜)
                                              ├─► Agent 阿序 ──► DeepSeek
                                              ├─► Agent 弥生 ──► DeepSeek
                                              ├─► Agent 老墨 ──► DeepSeek
                                              └─► Agent 小满 ──► DeepSeek
                                                    每次请求独立构造最小上下文
```

### 信息隔离

这是项目最重要的边界。每个 Agent 的上下文通过**显式 allowlist 重建**(而不是从完整对象
里删字段),因此新增服务端字段也不会被意外透传。

- Agent 能看到:自己的 `playerId / name / role / word`、当前轮次、存活玩家的 `id / name`、
  所有已公开的描述、已公开的淘汰事件。
- Agent 看不到:其他玩家的 `role / word`、未公开的投票、完整 `GameState`、其他 Agent 的
  隐藏推理。
- 客户端在终局前只收到公开席位、存活状态和人类自己的秘密;其他玩家的
  `revealedRole / revealedWord` 只在 `phase === "finished"` 后返回。

Node 的隔离实现在 `packages/server-node/server/agent-context.ts`,Go 在
`packages/server-go/agent_context.go`。

## 阅读顺序建议

以 Node 为例(Go 同名文件一一对应):

```text
types → agent-context(信息隔离)→ game-engine(权威状态机)
      → model(模型客户端与结构化校验)→ app(HTTP 与错误映射)
```

测试替身:Node `server/test-utils.ts` 的 `FakeGameModel`,Go `fake_model.go`。

## 约束速记

- 保持所选栈的契约(`contract:node` 或 `contract:go`)持续全绿。
- 不要提交密钥:`.env` 已被忽略;trace / 回放产物中不得含明文 Key 或完整密词。
- 请分多次有意义地提交(基线尚无 commit,你的第一提交可作为 "baseline import");现场需能投屏展示你的 git log。

## 项目结构

```text
packages/
  web/
    src/App.tsx            # 完整产品流程
    src/api.ts             # 类型化 API 调用
    src/styles.css         # 视觉系统
  server-node/
    server/agent-context.ts  # Agent 最小上下文 / 信息隔离
    server/game-engine.ts    # 权威状态机、淘汰与胜负
    server/model.ts          # DeepSeek 客户端、重试与输出校验
    server/app.ts            # HTTP API 与错误映射
    server/test-utils.ts     # FakeGameModel
    server/*.test.ts         # 状态机、隔离与 HTTP 测试
  server-go/
    agent_context.go / game_engine.go / model.go / app.go / fake_model.go / ...
contract/
  run.mjs                  # 语言无关黑盒契约运行器
  CONTRACT.md              # 契约说明(冻结项 / 发挥空间)
```
