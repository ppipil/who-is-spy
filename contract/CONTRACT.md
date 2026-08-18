# 行为契约(CONTRACT)

这份契约定义了**任一后端实现**(`server-node` / `server-go` / 候选人二次开发后的版本)
都必须满足的**基线硬门槛**。它由 `contract/run.mjs` 以**语言无关黑盒**方式对
`http://127.0.0.1:$CONTRACT_PORT` 验证。

契约只冻结「对不对」(硬门槛),**不冻结**「怎么做」(候选人的发挥空间)。

## 运行

```bash
# 从仓库根目录
npm run contract:node    # 启动 Node 后端并验证
npm run contract:go      # 启动 Go 后端并验证
```

运行器会用 `GAME_MODEL=fake` 拉起后端(确定性替身,无需密钥),跑完自动关闭进程。
任一断言失败 → **非 0 退出码**,因此可直接用作 CI / 面试官校验门禁。

## 冻结项(契约保证)

### 1. HTTP 端点与 DTO 形状

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 返回 `{ ok, model, configured }` |
| POST | `/api/games` | 201,创建对局并返回公开状态 |
| GET | `/api/games/:id` | 返回公开状态;不存在 → 404 |
| POST | `/api/games/:id/describe` | body `{ text }`;人类提交描述 |
| POST | `/api/games/:id/vote` | body `{ targetId }`;人类投票 |
| POST | `/api/games/:id/continue` | 人类出局后由 AI 推进到终局 |

公开状态(`PublicGameState`)至少包含:`id / phase / round / ballot / players /
descriptions / votes / events / eligibleTargetIds / winner / review / human / model`。

### 2. 信息隔离不变量(**硬门槛,不可破坏**)

- 终局前(`phase !== "finished"`),`players[]` 中**任何**玩家对象**不得**包含
  `role`、`word`、`revealedRole`、`revealedWord` 字段。
- `human` 对象**只**携带人类自己的 `playerId / role / word`。
- 终局后(`phase === "finished"`),`players[]` 每个玩家**必须**给出
  `revealedRole` 与 `revealedWord`。

> 二次开发(尤其是①差异化上下文与现场需求)**必须**保持该不变量。契约测试会持续校验。

### 3. 确定性裁决不变量

- 玩家构成固定为 **1 人类 + 4 AI**。
- 淘汰、同票加赛、胜负判定由**服务端代码**裁决,不由模型自由决定。
- 非法投票目标 / 空 `targetId` / 格式错误 → **400** 且返回可读 `error`。
- 不存在的对局 → **404**。
- 人类被多数票淘汰后,`/continue` 能把对局推进到 `finished` 并产生 `winner` 与 `review`。

### 4. 描述阶段校验

- 直接包含人类密词的描述 → 4xx 拒绝。
- 过短 / 过长描述 → 4xx 拒绝。
- 合规描述被接受后进入 `voting`,且本轮公开描述含 **5 条**(1 人类 + 4 AI)。

### 5. 模型职责与可替换接口

- AI 的描述 / 投票 / 复盘来自模型接口(`describe / vote / review`),**不是**预设文本或随机模板。
- 存在 `FakeModel` 注入点用于测试;`GAME_MODEL=fake` 时使用确定性替身,`real` 时走真实
  OpenAI-compatible 调用。

> 契约运行器只在 FakeModel 路径验证接口调用和状态流转,**不能证明真实外部模型可用**。
> 真实模型配置、调用结果与行为质量需要另行运行验证,并在现场演示。

## 非冻结项(候选人发挥空间,契约**不**断言其内部形状)

- Agent 上下文的**内部结构**、system prompt、按角色的策略参数(任务线①)。
- 发言**顺序机制**的实现(①只要求「后发能读到本轮已公开描述」这一*可观察结果*,不规定实现)。
- trace / 评测 / 回放的**字段与格式**(任务线②③)。
- 描述质量控制的**判定算法**(任务线①)。
- 现场环节需求的建模方式(任务线④,现场当场揭晓),只要求不破坏
  上面的信息隔离与终局揭示不变量。

## 提交前自检

交付前,请确认你所选栈的契约仍然全绿:

```bash
npm run contract:node    # 若你选 Node
npm run contract:go      # 若你选 Go
```

任一断言失败(非 0 退出)= 基线硬门槛被二次开发破坏,应在提交前修复。
