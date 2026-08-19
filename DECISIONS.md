# 过程与决策记录(候选人填写)

> 这份文档用来记录你「怎么用 Coding Agent、做了哪些判断」,是评分的重要依据之一。
> 请边做边写,不要事后补。下面的空模板保留,按你的实际情况填。

## 0. 我选择的技术栈

- [x] Node(`packages/server-node`)
- [ ] Go(`packages/server-go`)

选择理由:Node/TypeScript 与现有 React 客户端共享类型语境,现有 Vitest、FakeModel 和可注入随机源也适合为 AgentContext、策略、顺序编排、质量门禁、评测与故障恢复建立确定性证据。只修改 `packages/server-node`,Go 基线保持原样。

## 1. 我完成了哪些任务线

- [ ] 任务线① Agent 决策与编排(让四个 AI 有各自策略、会利用逐步公开的信息、说话不泄题)—— 必做
- [ ] 任务线② 效果评测(用一个命令批量跑多局,输出可对比的质量指标)
- [ ] 任务线③ 可观测性与故障恢复(出问题时能看清、能复现、能优雅降级)
- [ ] 选做加分:前端体验优化 / 后端工程优化(见任务书第 3 节)

> 任务线④是现场当场揭晓的题目,带回家不用准备,这里也不用写。

未完成的部分及原因:①②③均处于实现阶段,完成和验证前不勾选。当前只完成了源码一致性审计、`baseline-v1`、Windows 契约启动兼容和基线验证;前端加分项暂不投入。

## 2. Coding Agent 使用记录

- 我用的工具(Cursor / Claude Code / TraeCode 等):Codex Desktop(本仓库的主开发 Agent)。
- 哪些改动主要是 Agent 生成的(涉及哪些文件 / 大致范围):截至当前,Codex 创建 `AGENTS.md`、`PLAN.md`、`README_CANDIDATE.md`、`docs/BASELINE_AUDIT.md`,并修改 `contract/run.mjs` 的跨平台启动方式;后续代码范围将在对应里程碑追加。
- 我人工审查和改动了哪些地方:用户明确纠正了初始任务中的目录复制和 README 归属方案;因此正式目录直接初始化,三个官方文档保持受保护,候选人报告单列。所有测试结论均在初始化后重跑,未沿用旧日志。
- **Agent 有一处给错了或给得不够好,我是怎么发现并纠正的**:发现官方 `spawn('npx')` 在 Windows 报 `ENOENT` 后,初步候选方案是把命令替换为 `npx.cmd`;用独立 `child_process.spawn` 探针实际运行后得到 `spawn EINVAL`,证明该建议仍不可靠。最终改为 `process.execPath + 已安装的 tsx CLI`,并用 28/28 契约、6/6 域测试和 build 验证。该修正避免 shell 依赖并能直接管理后端子进程。

## 3. 关键设计取舍

> 每条尽量写清:遇到什么问题 → 我怎么做的 → 放弃了哪个方案 → 为什么。

- ① 怎么让后发言的 AI 看到本轮前面已公开的描述,同时又保证它看不到别人的身份和词:
- ① 怎么让四个角色(谨慎 / 直觉 / 逻辑 / 出其不意)在同样局面下说出不一样的话:
- ① 怎么判断一条描述"太雷同或快泄题了",判定之后怎么处理(重试还是降级):
- ② 每个质量指标是怎么算的,阈值为什么定这个数:
- ③ 一条日志 / trace 里记了哪些字段,怎么保证不把密词和 Key 写进去:

当前基线观察:四个 `style` 值只存在于 `AI_PROFILES`,创建玩家时即被丢弃;`generateDescriptions` 对同一快照使用 `Promise.all`,因此同轮 AI 上下文不会逐步增长。详细证据见 `docs/BASELINE_AUDIT.md`;上述各题在对应实现完成时填写,不预先宣称结果。

② 评测 Harness 使用 seed 驱动引擎随机源,通过正常 `GameEngine` API 自动完成 N 局;同轮 AI 描述做规范化字符 bigram Dice 两两比较,并统计完局、泄漏、公开 DTO、有效票、延迟、Token 可用性和策略分组。Fake 硬门禁只设确定性正确性:完局率和有效投票率必须 100%,泄漏/非法状态必须为 0;理由是固定 seed + FakeModel 下任何放宽都会掩盖回归。真实模型波动指标暂不设拍脑袋阈值。非法投票注入测试证明门禁会失败,CLI 因此非 0 退出。

① 策略差异:新增注册表式 `AgentStrategy`,集中 description guidance、vote guidance 和 quality policy;四个 profile 只保存稳定 `strategyId`,不在 `GameEngine` 按名字分支。ID 经 allowlist 进入 AgentContext,DeepSeek 的描述/投票都解析策略指导,FakeModel 也按同一 ID 产生实际差异。同角色、同词、同公开局面的测试得到四种描述、四种理由和多个目标倾向;20 局 Fake 评测从单一 `baseline-unassigned` 分裂为四个策略聚合,同质化代理值由 0.7692 降到 0。放弃“只把 style 字符串拼 Prompt”的方案,因为它没有行为参数/质量政策边界,也无法可靠评测或现场扩展。Real 行为差异仍待真实模型验收,不以 Fake 结果冒充。

① 顺序与隔离:Human 固定先发后，`generateDescriptions` 按稳定 `players[]` / profile 顺序循环；每位 AI 成功即通过 `commitDescription` 写入正式 descriptions 与 public event，下一位的原 allowlist builder 因而直接读取已公开的正式前缀，不传完整状态后删字段。全部存活 AI 成功后才以 `enterVoting` 切换 phase。测试观察同轮 AI 前缀 `0→1→2→3`、每次成功在下一调用前已可查询，并继续断言其他人的词不在序列化 Context。第四位故障时，Human 与前三位公开描述保留、phase 停在 `describing`，失败者及后续无描述；重试/恢复留给 M5。前端在一次 `/describe` 正常请求等待期间轮询既有 public GET 接口，逐条展示公开描述、事件和下一位思考进度；不引入 SSE/WebSocket，也不发送任何私有模型数据。投票仍保留同一公开快照上的 `Promise.all`，避免当前票型互相可见。已知限制:这不是真实 seat scheduler，Human 固定先发、AI 顺序来自固定 profile 数组。

① M3 真实验收:`8ce7f23` 的固定 seed DeepSeek 3 局 smoke 为 3/3 完局、合法投票 100%、描述同质化 0.0211。为把“Context 存在”与“看似利用前文”分开，评测 Trace 升为 schema v4，仅增加 describe 调用的同轮 AI 前缀计数及 human 是否存在，不记录 Context 文本；三局首轮均为 `0/1/2/3`。红线指标仍显示 vote/review/alias 暴露 `10/5/6`，精确描述泄题及 public-state 泄露为 0；保留给 M4，不把 M3 当作质量门禁完成。与 M2 同条件小样本相比，整体时长从 147980.38ms 至 168740.53ms，符合串行调用方向；单次响应 P50/P95、Token 与成本受模型随机性影响，不作因果或显著性结论。证据见 `docs/evidence/m3-sequential/`。

## 4. 验证证据

> 贴命令 + 关键输出(注意别带上密钥或完整密词)。

- 契约(所选栈):`npm run contract:node` 基线首次因 Windows `spawn npx ENOENT` 在断言前失败;提交最小跨平台启动修复后真实结果为 28 通过 / 0 失败。
- 域测试 / 构建结果:`npm run test:node` 为 3 个测试文件、6 个测试通过;`npm run build` 的 Web Vite build(1,797 modules)和 Node `tsc --noEmit` 均通过。Node `v22.22.0`,npm `10.9.4`。`npm install` 因 lockfile 的 `bnpm.byted.org` URL 两次 `ECONNRESET`,但 `npm ls --all --depth=0` 退出 0,现有依赖树完整。
- 批量评测脚本的输出(指标表):`npm run eval:node -- --games 20 --seed 42 --model fake` 退出 0:20/20 完局,完局率 100%,描述逻辑调用 174 次,有效投票 100%,非法输出/泄漏/重试 0,同质化代理指标 0.7692;全部 Agent 归入 `baseline-unassigned`。详见 `docs/EVALUATION.md`。
- 故障注入 + 定位到具体一局 / 某一轮 / 某个 AI / 第几次尝试的示例:
- 用真实模型完整跑一局的记录:

策略里程碑验证:`npm run test:node` 为 5 文件/10 测试通过;`npm run contract:node` 为 28/28;`npm run build` 通过;相同 seed 的 Fake eval 为 20/20 完局、四策略独立聚合、同质化 0。真实模型记录保持空白,直到实际调用成功。

顺序编排验证(原 staged 版本):`npm run test:node` 为 5 文件/11 测试通过(含 `0→1→2→3` 与第四 Agent 故障原子性);契约 28/28、Fake eval 20/20、build 通过。增量公开扩展验证(2026-08-19):`npm run test:node` 为 5 文件/15 测试通过；`npm run contract:node` 为 28/28；`npm run build` 通过 Web TypeScript/Vite 与 Node TypeScript；`npm run eval:node -- --games 20 --seed 42 --model fake` 为 20/20、有效投票 100%、非法输出 0、同质化 0、Gate PASS，并继续记录 describe 前缀 `0→1→2→3`。新增 paused-model 域测试和 HTTP 测试分别证明逐条正式 commit 与中间 public DTO；未进行新的 DeepSeek 调用。
